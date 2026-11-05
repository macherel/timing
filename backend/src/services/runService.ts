import fs from 'fs';
import path from 'path';
import type { RunResult, RunState, RunStatus } from '../types/messages.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';
import { disciplineDir, loadDisciplineSettings, parseCsv, RESULTS_FILE, type Participant } from './eventService.js';

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
    const dir = await disciplineDir(event, discipline);
    if (!dir) return 'Unknown event or discipline.';

    const { attempts } = (await loadDisciplineSettings(dir)).settings;
    if (attempts !== null) {
        const used = ((await loadResults(event, discipline)) ?? []).filter(
            (result) => result.bib === participant.bib && countsAsAttempt(result)
        ).length;
        if (used >= attempts) return `${participant.bib} ${participant.name} has used all ${attempts} attempt(s).`;
    }

    setState({ status: 'ready', event, discipline, participant });
    log.info(`${participant.bib} ${participant.name} is ready (${event} / ${discipline}).`);
    return null;
}

/** Invalid runs are not the participant's fault, so they do not use up an attempt. */
export function countsAsAttempt(result: RunResult): boolean {
    return result.status !== 'invalid';
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
        const start = Temporal.Instant.from(state.startedAt);
        const timeMs = Math.round(instant.since(start).total('millisecond'));
        log.info(`Finish of ${state.participant.bib} ${state.participant.name} on "${deviceName}": ${formatSeconds(timeMs)} s`);
        endRun({ finish: instant.toString(), timeMs, status: 'ok' });
    }
}

/**
 * Ends the run now, without waiting for the finish, and saves it as invalid or DQ (no finish, no time).
 * Returns a problem when no run is in progress.
 */
export function voidRun(status: 'invalid' | 'dq'): string | null {
    if (state.status !== 'running') return 'No run in progress.';
    log.info(`Run of ${state.participant.bib} ${state.participant.name} ${status === 'dq' ? 'disqualified' : 'invalidated'}.`);
    endRun({ finish: null, timeMs: null, status });
    return null;
}

function endRun(outcome: Pick<RunResult, 'finish' | 'timeMs' | 'status'>): void {
    if (state.status !== 'running') return;
    const { event, discipline, participant, startedAt } = state;
    const result: RunResult = { bib: participant.bib, name: participant.name, start: startedAt, ...outcome };
    setState({ status: 'idle' });
    broadcastToUI({ type: 'RUN_RESULT', event, discipline, result });
    saveResult(event, discipline, result);
}

/** Seconds with millisecond precision, e.g. "12.345". */
function formatSeconds(timeMs: number): string {
    return (timeMs / 1000).toFixed(3);
}

// Columns of results.csv. The time is not stored: it is finish - start. `status` is OK, INVALID or DQ.
// Columns are found by their header name, so files with older layouts (with a time column, without status) are
// read too, and are rewritten in this layout on their next write.
const COLUMNS = ['bib', 'name', 'start', 'finish', 'status'] as const;
type Row = Record<(typeof COLUMNS)[number], string>;
const RESULTS_HEADER = COLUMNS.join(';');

const STATUS_TEXT: Record<RunStatus, string> = { ok: 'OK', invalid: 'INVALID', dq: 'DQ' };
export const RUN_STATUSES = Object.keys(STATUS_TEXT) as RunStatus[];

// Writes go one after the other, so two changes never interleave in the file
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
    const next = writeQueue.then(write);
    writeQueue = next.catch(() => undefined);
    return next;
}

/** Milliseconds from start to finish (rounded), or null when the finish is missing or a date cannot be read. */
function runTimeMs(start: string, finish: string | null): number | null {
    if (!finish) return null;
    try {
        return Math.round(Temporal.Instant.from(finish).since(Temporal.Instant.from(start)).total('millisecond'));
    } catch {
        return null;
    }
}

/** Rows of results.csv, by column name. Missing columns are empty, a missing status means OK. */
function parseRows(text: string): Row[] {
    const [header = [], ...rows] = parseCsv(text);
    const columnIndex = header.map((name) => name.trim().toLowerCase());
    return rows
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => {
            const cell = (column: (typeof COLUMNS)[number]) => row[columnIndex.indexOf(column)] ?? '';
            return { bib: cell('bib').trim(), name: cell('name'), start: cell('start').trim(), finish: cell('finish').trim(), status: cell('status').trim() || 'OK' };
        });
}

async function writeRows(file: string, rows: Row[]): Promise<void> {
    const csvCell = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(';'));
    await fs.promises.writeFile(file, `${[RESULTS_HEADER, ...lines].join('\n')}\n`, 'utf8');
}

function toRow(result: RunResult): Row {
    return { bib: result.bib, name: result.name, start: result.start, finish: result.finish ?? '', status: STATUS_TEXT[result.status] };
}

/** A results.csv row as a result. null for a valid run without a time (finish missing or unreadable). */
function toResult(row: Row): RunResult | null {
    const status = RUN_STATUSES.find((s) => STATUS_TEXT[s] === row.status.toUpperCase()) ?? 'ok';
    const finish = row.finish || null;
    const timeMs = runTimeMs(row.start, finish);
    if (status === 'ok' && timeMs === null) return null;
    return { bib: row.bib, name: row.name, start: row.start, finish, timeMs, status };
}

/** Rows of results.csv, empty when it does not exist yet. */
async function readRows(file: string): Promise<Row[]> {
    try {
        return parseRows(await fs.promises.readFile(file, 'utf8'));
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function saveResult(event: string, discipline: string, result: RunResult): void {
    enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) {
            log.error(`Cannot save the result of ${result.bib}: ${event} / ${discipline} no longer exists.`);
            return;
        }
        const file = path.join(dir, RESULTS_FILE);
        await writeRows(file, [...(await readRows(file)), toRow(result)]);
        log.info(`Result saved to ${file}`);
    }).catch((error) => log.error(`Cannot save the result of ${result.bib}:`, error));
}

/**
 * Changes the status of a saved run (OK, invalid or DQ). The run is identified by its bib and start instant
 * together, as several participants can share a start (e.g. started at once).
 * A run ended before the finish has no time, so it cannot become OK. Other rows are kept as they are.
 */
export async function setResultStatus(
    event: string,
    discipline: string,
    bib: string,
    start: string,
    status: RunStatus
): Promise<{ result: RunResult } | { status: 404 | 409; problem: string }> {
    return enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) return { status: 404 as const, problem: 'Unknown event or discipline.' };

        const file = path.join(dir, RESULTS_FILE);
        const rows = await readRows(file);
        const row = rows.find((r) => r.bib === bib && r.start === start);
        const current = row && toResult(row);
        if (!row || !current) return { status: 404 as const, problem: 'This result is not in results.csv any more.' };
        if (status === 'ok' && current.timeMs === null) {
            return { status: 409 as const, problem: 'This run was ended before the finish: it has no time.' };
        }

        row.status = STATUS_TEXT[status];
        await writeRows(file, rows);
        const result = { ...current, status };
        log.info(`Run of ${result.bib} ${result.name} started at ${start} set to ${STATUS_TEXT[status]}.`);
        broadcastToUI({ type: 'RESULT_UPDATE', event, discipline, result });
        return { result };
    });
}

/** Every result of a discipline, oldest first. Empty when there is no results file yet. */
export async function loadResults(event: string, discipline: string): Promise<RunResult[] | null> {
    const dir = await disciplineDir(event, discipline);
    if (!dir) return null;
    return (await readRows(path.join(dir, RESULTS_FILE))).map(toResult).filter((result) => result !== null);
}
