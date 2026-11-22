import fs from 'fs';
import path from 'path';
import type { Gate, LastResult, LineRun, RunResult, RunState, RunStatus } from '../types/messages.js';
import { getLines, isLine, onLinesChange } from './lines.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';
import { isUsbScanInProgress, waitForUsbScan } from './hardware/usbHid.js';
import { notifyActivityChange, notifyLocalChange } from '../utils/localChanges.js';
import {
    closedReason,
    DEFAULT_SETTINGS,
    disciplineDir,
    loadDisciplineSettings,
    parseCsv,
    readParticipants,
    resultsFile,
    udaResultsFile,
    type DisciplineSettings,
    type Participant,
    type Precision,
} from './eventService.js';

const log = createLogger('Run');

/**
 * Timed runs, one at a time on each line (see lines.ts):
 *   idle → ready (a participant is announced) → running (first start crossing of the line) → idle (first finish
 *   crossing of the line, the result is appended to <event>/<discipline>/<event>-<discipline>-results.csv) or idle
 *   (cancelled, nothing saved).
 * Each write of the results file also rewrites <event>-<discipline>-uda-results.csv beside it, the results in the
 * import format of the UDA.
 */

interface LineState {
    run: RunState;
    // The last run ended on the line, shown on the live pages until the next participant is ready on it
    lastResult: LastResult | null;
    // How the time of the run in progress is measured, from the settings of its discipline when the participant got ready
    timeRule: TimeRule;
}

const lineStates = new Map<string, LineState>();

function stateOf(line: string): LineState {
    let state = lineStates.get(line);
    if (!state) {
        state = { run: { status: 'idle' }, lastResult: null, timeRule: DEFAULT_SETTINGS };
        lineStates.set(line, state);
    }
    return state;
}

// A line removed from config.yaml loses its run: no crossing can reach it any more
onLinesChange(() => {
    const lines = getLines();
    for (const [line, state] of lineStates) {
        if (lines.includes(line)) continue;
        if (state.run.status !== 'idle') {
            log.warn(`Line "${line}" is no longer in config.yaml: the run of ${state.run.participant.bib} ${state.run.participant.name} is dropped.`);
        }
        lineStates.delete(line);
    }
    broadcastToUI({ type: 'LINES_UPDATE', lines: getLineRuns() });
    notifyActivityChange();
});

/** Every line with its run and last result, in the order of config.yaml. */
export function getLineRuns(): LineRun[] {
    return getLines().map((line) => {
        const { run, lastResult } = stateOf(line);
        return { line, run, lastResult };
    });
}

/** The run of a line, null for an unknown line. */
export function getRunState(line: string): RunState | null {
    return isLine(line) ? stateOf(line).run : null;
}

/** Whether a participant is ready or running on a line: a crossing can come at any time. */
export function isAnyRunActive(): boolean {
    return [...lineStates.values()].some((state) => state.run.status !== 'idle');
}

function setRun(line: string, next: RunState): void {
    const state = stateOf(line);
    state.run = next;
    if (next.status === 'ready') state.lastResult = null;
    broadcastToUI({ type: 'RUN_UPDATE', line, run: next });
    notifyActivityChange();
}

const unknownLine = (line: string) => `Unknown line "${line}".`;

/** Announces that a participant is ready on a line: its next start crossing starts their run. */
export async function prepareRun(line: string, event: string, discipline: string, participant: Participant): Promise<string | null> {
    if (!isLine(line)) return unknownLine(line);
    if (stateOf(line).run.status === 'running') return `A run is in progress on ${line}. Cancel it first.`;
    const dir = await disciplineDir(event, discipline);
    if (!dir) return 'Unknown event or discipline.';

    const { settings } = await loadDisciplineSettings(dir);
    const closed = closedReason(settings);
    if (closed) return `${event} / ${discipline} is closed: ${closed}.`;
    const { attempts } = settings;
    if (attempts !== null) {
        const used = ((await loadResults(event, discipline)) ?? []).filter(
            (result) => result.bib === participant.bib && countsAsAttempt(result)
        ).length;
        if (used >= attempts) return `${participant.bib} ${participant.name} has used all ${attempts} attempt(s).`;
    }

    // Once ready, a start crossing can come at any time, and a USB scan would delay its timestamp (it blocks the event
    // loop on Windows). No scan starts during a run (see hardwareService), so wait for the one running, if any. The
    // checks and the change of state happen in the same tick, so no scan can start in between.
    while (isUsbScanInProgress()) await waitForUsbScan();
    if (!isLine(line)) return unknownLine(line);
    // A crossing may have started another participant's run meanwhile
    if (stateOf(line).run.status === 'running') return `A run is in progress on ${line}. Cancel it first.`;
    const elsewhere = getLineRuns().find(
        (other) =>
            other.line !== line &&
            other.run.status !== 'idle' &&
            other.run.event === event &&
            other.run.discipline === discipline &&
            other.run.participant.bib === participant.bib
    );
    if (elsewhere) return `${participant.bib} ${participant.name} is already ${elsewhere.run.status} on ${elsewhere.line}.`;

    stateOf(line).timeRule = settings;
    setRun(line, { status: 'ready', event, discipline, participant });
    log.info(`${participant.bib} ${participant.name} is ready on ${line} (${event} / ${discipline}).`);
    return null;
}

/** Invalid runs are not the participant's fault, so they do not use up an attempt. */
export function countsAsAttempt(result: RunResult): boolean {
    return result.status !== 'invalid';
}

/** Forgets the runs in progress and the last results, as when the app starts (simulated gates only, see api.ts). */
export function resetRuns(): void {
    for (const line of getLines()) {
        stateOf(line).lastResult = null;
        setRun(line, { status: 'idle' });
    }
}

/** Abandons the run of a line, nothing is saved. Returns a problem for an unknown line. */
export function cancelRun(line: string): string | null {
    if (!isLine(line)) return unknownLine(line);
    const { run } = stateOf(line);
    if (run.status === 'idle') return null;
    log.info(`Run of ${run.participant.bib} ${run.participant.name} on ${line} cancelled.`);
    setRun(line, { status: 'idle' });
    return null;
}

/**
 * Called for every crossing of a gate of a line. `instant` is when the HID report was received.
 */
export function onCrossing(line: string, gate: Gate, deviceName: string, instant: Temporal.Instant): void {
    if (!isLine(line)) return;
    const { run, timeRule } = stateOf(line);
    if (run.status === 'ready' && gate === 'start') {
        log.info(`Start of ${run.participant.bib} ${run.participant.name} on ${line} ("${deviceName}").`);
        setRun(line, { ...run, status: 'running', startedAt: instant.toString() });
    } else if (run.status === 'running' && gate === 'finish') {
        const finish = instant.toString();
        const timeMs = runTimeMs(run.startedAt, finish, timeRule)!;
        log.info(`Finish of ${run.participant.bib} ${run.participant.name} on ${line} ("${deviceName}"): ${formatSeconds(timeMs)} s`);
        endRun(line, { finish, timeMs, status: 'ok' });
    }
}

/**
 * Ends the run of a line now, without waiting for the finish, and saves it as invalid or DQ (no finish, no time).
 * Returns a problem when no run is in progress on the line.
 */
export function voidRun(line: string, status: 'invalid' | 'dq'): string | null {
    if (!isLine(line)) return unknownLine(line);
    const { run } = stateOf(line);
    if (run.status !== 'running') return `No run in progress on ${line}.`;
    log.info(`Run of ${run.participant.bib} ${run.participant.name} on ${line} ${status === 'dq' ? 'disqualified' : 'invalidated'}.`);
    endRun(line, { finish: null, timeMs: null, status });
    return null;
}

function endRun(line: string, outcome: Pick<RunResult, 'finish' | 'timeMs' | 'status'>): void {
    const state = stateOf(line);
    if (state.run.status !== 'running') return;
    const { event, discipline, participant, startedAt } = state.run;
    const result: RunResult = { bib: participant.bib, name: participant.name, start: startedAt, ...outcome };
    state.lastResult = { event, discipline, result, endedAt: new Date().toISOString() };
    setRun(line, { status: 'idle' });
    // Announced once saved: the pages that reload the results on this message (the live page) then get it
    saveResult(event, discipline, result).finally(() => broadcastToUI({ type: 'RUN_RESULT', line, event, discipline, result }));
}

/** Seconds with millisecond precision, e.g. "12.345". */
function formatSeconds(timeMs: number): string {
    return (timeMs / 1000).toFixed(3);
}

// Columns of the results file. The time is not stored: it is finish - start. `status` is OK, INVALID or DQ. `updated` is
// when the line was last changed (UTC), so the sync keeps the latest change of a line edited on two computers.
// Columns are found by their header name, so files with older layouts (with a time column, without status or
// updated) are read too, and are rewritten in this layout on their next write.
const COLUMNS = ['bib', 'name', 'start', 'finish', 'status', 'updated'] as const;
export type ResultRow = Record<(typeof COLUMNS)[number], string>;
type Row = ResultRow;
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

/** How a run's time is measured: its unit, and how the exact time is brought to it (see DisciplineSettings). */
export type TimeRule = Pick<DisciplineSettings, 'precision' | 'rounding'>;

const NANOSECONDS: Record<Precision, bigint> = {
    second: 1_000_000_000n,
    tenth: 100_000_000n,
    hundredth: 10_000_000n,
    thousandth: 1_000_000n,
};

/**
 * Time from start to finish in milliseconds, brought to the unit of the rule from the exact time (nanoseconds): e.g.
 * 12.3401 s is 12.34 truncated, 12.34 to the nearest and 12.35 up, in hundredths. null when the finish is missing or a
 * date cannot be read.
 */
export function runTimeMs(start: string, finish: string | null, rule: TimeRule): number | null {
    if (!finish) return null;
    let exact: bigint;
    try {
        exact = Temporal.Instant.from(finish).epochNanoseconds - Temporal.Instant.from(start).epochNanoseconds;
    } catch {
        return null;
    }
    const unit = NANOSECONDS[rule.precision];
    // Rounded on the absolute value, so a time is never negative because of the rounding
    const sign = exact < 0n ? -1n : 1n;
    const size = exact * sign;
    let units = size / unit;
    const rest = size % unit;
    if ((rule.rounding === 'up' && rest > 0n) || (rule.rounding === 'nearest' && 2n * rest >= unit)) units++;
    return Number((sign * units * unit) / 1_000_000n);
}

/** Rows of the results file, by column name. Missing columns are empty, a missing status means OK. */
function parseRows(text: string): Row[] {
    const [header = [], ...rows] = parseCsv(text);
    const columnIndex = header.map((name) => name.trim().toLowerCase());
    return rows
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => {
            const cell = (column: (typeof COLUMNS)[number]) => row[columnIndex.indexOf(column)] ?? '';
            return {
                bib: cell('bib').trim(),
                name: cell('name'),
                start: cell('start').trim(),
                finish: cell('finish').trim(),
                status: cell('status').trim() || 'OK',
                updated: cell('updated').trim(),
            };
        });
}

/**
 * Writes the results file, then the UDA export beside it. Each goes through a temporary file, so a peer or the page never
 * reads a half-written file.
 */
async function writeRows(file: string, rows: Row[]): Promise<void> {
    const csvCell = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(';'));
    await writeAtomically(file, `${[RESULTS_HEADER, ...lines].join('\n')}\n`);
    await writeUdaFile(path.dirname(file), rows);
}

async function writeUdaFile(dir: string, rows: Row[]): Promise<void> {
    const { participants, settings } = await readParticipants(dir);
    await writeAtomically(udaResultsFile(dir), udaResults(rows, participants.map((p) => p.bib), settings));
}

/**
 * Writes the UDA export again from the results file, e.g. when the discipline settings changed which time is the best.
 * Nothing is written when the discipline has no results file yet.
 */
export async function writeUdaResults(event: string, discipline: string): Promise<void> {
    await enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) return;
        const file = resultsFile(dir);
        if (!fs.existsSync(file)) return;
        await writeUdaFile(dir, await readRows(file));
    });
}

async function writeAtomically(file: string, content: string): Promise<void> {
    const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
    await fs.promises.writeFile(tempFile, content, 'utf8');
    await fs.promises.rename(tempFile, file);
}

/**
 * Results in the import format of the UDA (Unicycling Data Application): one line per participant (of the list, and
 * any other bib with runs), sorted by bib, without header, comma separated, CRLF line ends:
 *   bib,,minutes,seconds,hundredths   best OK run (shortest time, or longest for a slow race), e.g. "98,,1,13,23"
 *                                     for 1:13.23
 *   bib,DQ,0,0,0                      no OK run, at least one DQ
 *   bib,DNF,0,0,0                     no valid run: only INVALID runs, or none
 * The time is measured with the precision and rounding of the discipline; the UDA has no thousandths, so a time in
 * thousandths is brought to the hundredth with the same rounding, from the exact time.
 */
export function udaResults(
    rows: Row[],
    bibs: string[],
    settings: Pick<DisciplineSettings, 'best' | 'precision' | 'rounding'> = DEFAULT_SETTINGS
): string {
    const { best, rounding } = settings;
    const precision = settings.precision === 'thousandth' ? 'hundredth' : settings.precision;
    const bestOf = new Map<string, RunResult | null>(bibs.map((bib) => [bib, null]));
    for (const result of rows.map((row) => toResult(row, { precision, rounding }))) {
        if (!result || result.status === 'invalid') {
            if (result && !bestOf.has(result.bib)) bestOf.set(result.bib, null);
            continue;
        }
        const current = bestOf.get(result.bib);
        if (!current || isBetter(result, current, best)) bestOf.set(result.bib, result);
    }
    return [...bestOf]
        .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
        .map(([bib, result]) => {
            if (!result) return `${bib},DNF,0,0,0\r\n`;
            if (result.status === 'dq' || result.timeMs === null) return `${bib},DQ,0,0,0\r\n`;
            const hundredths = Math.round(result.timeMs / 10);
            const minutes = Math.floor(hundredths / 6000);
            const seconds = Math.floor(hundredths / 100) % 60;
            return `${bib},,${minutes},${seconds},${hundredths % 100}\r\n`;
        })
        .join('');
}

/** An OK run beats a DQ; between OK runs, the shorter time wins (the longer one for a slow race). */
function isBetter(result: RunResult, than: RunResult, best: DisciplineSettings['best']): boolean {
    if (result.status !== than.status) return result.status === 'ok';
    if (result.status !== 'ok') return false;
    return best === 'longest' ? result.timeMs! > than.timeMs! : result.timeMs! < than.timeMs!;
}

const nowText = () => Temporal.Now.instant().toString({ smallestUnit: 'millisecond' });

function toRow(result: RunResult): Row {
    return {
        bib: result.bib,
        name: result.name,
        start: result.start,
        finish: result.finish ?? '',
        status: STATUS_TEXT[result.status],
        updated: nowText(),
    };
}

/** When a line was last changed. Lines written before the updated column count as changed at their start. */
function updatedAt(row: Row): Temporal.Instant {
    for (const value of [row.updated, row.start]) {
        try {
            return Temporal.Instant.from(value);
        } catch {
            // Try the next value
        }
    }
    return Temporal.Instant.fromEpochMilliseconds(0);
}

/**
 * A row of the results file as a result, its time measured with the rule. null for a valid run without a time (finish missing
 * or unreadable).
 */
function toResult(row: Row, rule: TimeRule): RunResult | null {
    const status = RUN_STATUSES.find((s) => STATUS_TEXT[s] === row.status.toUpperCase()) ?? 'ok';
    const finish = row.finish || null;
    const timeMs = runTimeMs(row.start, finish, rule);
    if (status === 'ok' && timeMs === null) return null;
    return { bib: row.bib, name: row.name, start: row.start, finish, timeMs, status };
}

/** Rows of the results file, empty when it does not exist yet. */
async function readRows(file: string): Promise<Row[]> {
    try {
        return parseRows(await fs.promises.readFile(file, 'utf8'));
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function saveResult(event: string, discipline: string, result: RunResult): Promise<void> {
    return enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) {
            log.error(`Cannot save the result of ${result.bib}: ${event} / ${discipline} no longer exists.`);
            return;
        }
        const file = resultsFile(dir);
        await writeRows(file, [...(await readRows(file)), toRow(result)]);
        log.info(`Result saved to ${file}`);
        notifyLocalChange(event, discipline);
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

        const { settings } = await loadDisciplineSettings(dir);
        const closed = closedReason(settings);
        if (closed) return { status: 409 as const, problem: `${event} / ${discipline} is closed: ${closed}.` };

        const file = resultsFile(dir);
        const rows = await readRows(file);
        const row = rows.find((r) => r.bib === bib && r.start === start);
        const current = row && toResult(row, settings);
        if (!row || !current) return { status: 404 as const, problem: 'This result is not in the results file any more.' };
        if (status === 'ok' && current.timeMs === null) {
            return { status: 409 as const, problem: 'This run was ended before the finish: it has no time.' };
        }

        row.status = STATUS_TEXT[status];
        row.updated = nowText();
        await writeRows(file, rows);
        notifyLocalChange(event, discipline);
        // The live pages show the last run ended on each line: keep its status right
        for (const state of lineStates.values()) {
            const last = state.lastResult;
            if (last?.event === event && last.discipline === discipline && last.result.bib === bib && last.result.start === start) {
                state.lastResult = { ...last, result: { ...last.result, status } };
                notifyActivityChange();
            }
        }
        const result = { ...current, status };
        log.info(`Run of ${result.bib} ${result.name} started at ${start} set to ${STATUS_TEXT[status]}.`);
        broadcastToUI({ type: 'RESULT_UPDATE', event, discipline, result });
        return { result };
    });
}

/**
 * Every result of a discipline, oldest first, with times measured by its settings. Empty when there is no results file
 * yet.
 */
export async function loadResults(event: string, discipline: string): Promise<RunResult[] | null> {
    const dir = await disciplineDir(event, discipline);
    if (!dir) return null;
    const { settings } = await loadDisciplineSettings(dir);
    return (await readRows(resultsFile(dir))).map((row) => toResult(row, settings)).filter((result) => result !== null);
}

// ---------------------------------------------------------------------------
// Sync with other computers (see syncService.ts)
// ---------------------------------------------------------------------------

/** Every line of a discipline's results file, as written. null when the discipline does not exist. */
export async function readResultRows(event: string, discipline: string): Promise<ResultRow[] | null> {
    const dir = await disciplineDir(event, discipline);
    return dir ? readRows(resultsFile(dir)) : null;
}

/**
 * Merges lines from another computer into a discipline's results file: a line it does not have is added, a line it
 * has (same bib and start) is replaced when the other one was changed later. Returns whether the file changed.
 * The discipline folder must exist.
 */
export async function mergeResultRows(event: string, discipline: string, remoteRows: ResultRow[]): Promise<boolean> {
    return enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) return false;
        const file = resultsFile(dir);
        const rows = await readRows(file);
        const byKey = new Map(rows.map((row, index) => [`${row.bib}\n${row.start}`, index]));

        let changed = false;
        for (const remote of remoteRows) {
            const index = byKey.get(`${remote.bib}\n${remote.start}`);
            if (index === undefined) {
                byKey.set(`${remote.bib}\n${remote.start}`, rows.length);
                rows.push({ ...remote });
                changed = true;
            } else if (Temporal.Instant.compare(updatedAt(remote), updatedAt(rows[index])) > 0) {
                rows[index] = { ...remote };
                changed = true;
            }
        }
        if (!changed) return false;

        // Oldest run first, as when they are timed on one computer
        rows.sort((a, b) => {
            try {
                return Temporal.Instant.compare(Temporal.Instant.from(a.start), Temporal.Instant.from(b.start));
            } catch {
                return a.start.localeCompare(b.start);
            }
        });
        await writeRows(file, rows);
        return true;
    });
}
