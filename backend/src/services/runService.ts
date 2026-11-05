import fs from 'fs';
import path from 'path';
import type { RunResult, RunState } from '../types/messages.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';
import { disciplineDir, parseCsv, RESULTS_FILE, type Participant } from './eventService.js';

const log = createLogger('Run');

/**
 * Timed runs, one at a time:
 *   idle → ready (a participant is announced) → running (first "start" crossing) → idle (first "finish" crossing,
 *   the result is appended to <event>/<discipline>/results.csv) or idle (cancelled, nothing saved).
 */

let state: RunState = { status: 'idle' };

export function getRunState(): RunState {
    return state;
}

function setState(next: RunState): void {
    state = next;
    broadcastToUI({ type: 'RUN_UPDATE', run: state });
}

/** Announces that a participant is ready: the next start crossing starts their run. */
export async function prepareRun(event: string, discipline: string, participant: Participant): Promise<string | null> {
    if (state.status === 'running') return 'A run is in progress. Cancel it first.';
    if (!(await disciplineDir(event, discipline))) return 'Unknown event or discipline.';
    setState({ status: 'ready', event, discipline, participant });
    log.info(`${participant.bib} ${participant.name} is ready (${event} / ${discipline}).`);
    return null;
}

export function cancelRun(): void {
    if (state.status === 'idle') return;
    log.info(`Run of ${state.participant.bib} ${state.participant.name} cancelled.`);
    setState({ status: 'idle' });
}

/**
 * Called for every recorded crossing. `instant` is when the HID report was received.
 */
export function onCrossing(action: string, deviceName: string, instant: Temporal.Instant): void {
    if (state.status === 'ready' && action.includes('start')) {
        log.info(`Start of ${state.participant.bib} ${state.participant.name} on "${deviceName}".`);
        setState({ ...state, status: 'running', startedAt: instant.toString() });
    } else if (state.status === 'running' && action.includes('finish')) {
        const { event, discipline, participant, startedAt } = state;
        const start = Temporal.Instant.from(startedAt);
        const result: RunResult = {
            bib: participant.bib,
            name: participant.name,
            start: startedAt,
            finish: instant.toString(),
            timeMs: Math.round(instant.since(start).total('millisecond')),
        };
        log.info(`Finish of ${participant.bib} ${participant.name} on "${deviceName}": ${formatSeconds(result.timeMs)} s`);
        setState({ status: 'idle' });
        broadcastToUI({ type: 'RUN_RESULT', event, discipline, result });
        saveResult(event, discipline, result);
    }
}

/** Seconds with millisecond precision, e.g. "12.345". */
function formatSeconds(timeMs: number): string {
    return (timeMs / 1000).toFixed(3);
}

// Writes go one after the other, so two results never interleave in the file
let writeQueue: Promise<void> = Promise.resolve();

function saveResult(event: string, discipline: string, result: RunResult): void {
    writeQueue = writeQueue.then(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) {
            log.error(`Cannot save the result of ${result.bib}: ${event} / ${discipline} no longer exists.`);
            return;
        }
        const file = path.join(dir, RESULTS_FILE);
        const exists = fs.existsSync(file);
        const cell = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
        const line = [result.bib, result.name, result.start, result.finish, formatSeconds(result.timeMs)].map(cell).join(';');
        await fs.promises.appendFile(file, `${exists ? '' : 'bib;name;start;finish;time\n'}${line}\n`, 'utf8');
        log.info(`Result saved to ${file}`);
    }).catch((error) => log.error(`Cannot save the result of ${result.bib}:`, error));
}

/** Every result of a discipline, oldest first. Empty when there is no results file yet. */
export async function loadResults(event: string, discipline: string): Promise<RunResult[] | null> {
    const dir = await disciplineDir(event, discipline);
    if (!dir) return null;

    let text: string;
    try {
        text = await fs.promises.readFile(path.join(dir, RESULTS_FILE), 'utf8');
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    return parseCsv(text)
        .slice(1)
        .filter((row) => row.length >= 5 && row[0] !== '')
        .map(([bib, name, start, finish, time]) => ({ bib, name, start, finish, timeMs: Math.round(Number(time) * 1000) }))
        .filter((result) => Number.isFinite(result.timeMs));
}
