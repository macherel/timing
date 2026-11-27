import fs from 'fs';
import path from 'path';
import type { Gate, LastResult, LineRun, RunResult, RunState, RunStatus } from '../types/messages.js';
import { getLines, isLine, isLineEnabled, isLineReady, isManualLine, MANUAL_LINE, onLinesChange } from './lines.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';
import { isUsbScanInProgress, waitForUsbScan } from './hardware/usbHid.js';
import { notifyActivityChange, notifyLocalChange } from '../utils/localChanges.js';
import { computerName } from '../utils/computerName.js';
import { listDisciplineFiles } from './disciplineFiles.js';
import {
    closedReason,
    DEFAULT_SETTINGS,
    disciplineDir,
    loadDisciplineSettings,
    parseCsv,
    BACKUP_DIR,
    backupFileName,
    withDisciplinePrefix,
    readParticipants,
    resultsFile,
    resultsResetAt,
    udaResultsFile,
    writeResultsReset,
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
 * In a discipline that measures a distance, there is no crossing, and its runs are on the manual line:
 *   idle → ready (a participant is announced with the distance typed by the operator) → idle (the operator says
 *   whether the distance is valid, invalid or disqualified: the result is saved) or idle (cancelled, nothing saved).
 * Each write of the results file also rewrites <event>-<discipline>-uda-results.csv beside it, the results in the
 * import format of the UDA.
 * When the participants of a discipline change, its results are reset (see resetResults): runs started before are
 * dropped, after a backup of them (see backupResults); the results files are removed when no run is left.
 */

interface LineState {
    run: RunState;
    // The last run ended on the line, shown on the live pages until the next participant is ready on it
    lastResult: LastResult | null;
    // How the run in progress is measured, from the settings of its discipline when the participant got ready
    timeRule: MeasureRule;
    // When the participant got ready: the start of a distance run, as there is no start crossing
    readyAt: string | null;
}

const lineStates = new Map<string, LineState>();

function stateOf(line: string): LineState {
    let state = lineStates.get(line);
    if (!state) {
        state = { run: { status: 'idle' }, lastResult: null, timeRule: DEFAULT_SETTINGS, readyAt: null };
        lineStates.set(line, state);
    }
    return state;
}

// A line removed from config.yaml loses its run: no crossing can reach it any more. The pages are told about the
// lines and whether they are ready
onLinesChange(() => {
    const lines = getLines();
    for (const [line, state] of lineStates) {
        if (lines.includes(line) || isManualLine(line)) continue;
        if (state.run.status !== 'idle') {
            log.warn(`Line "${line}" is no longer in config.yaml: the run of ${state.run.participant.bib} ${state.run.participant.name} is dropped.`);
        }
        lineStates.delete(line);
    }
    broadcastToUI({ type: 'LINES_UPDATE', lines: getLineRuns() });
    notifyActivityChange();
});

/**
 * The lines listed: those of config.yaml, then the manual lines, "Manuel" and the others that have a run or a last
 * result (a tab of the race page uses a manual line before it is listed).
 */
function listedLines(): string[] {
    const used = [...lineStates]
        .filter(([line, state]) => line !== MANUAL_LINE && isManualLine(line) && (state.run.status !== 'idle' || state.lastResult !== null))
        .map(([line]) => line)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return [...getLines(), ...used];
}

/** Every line with its run and last result, in the order of config.yaml, then the manual lines. */
export function getLineRuns(): LineRun[] {
    return listedLines().map((line) => {
        const { run, lastResult } = stateOf(line);
        return { line, enabled: isLineEnabled(line), ready: isLineReady(line), manual: isManualLine(line), run, lastResult };
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
    const listed = listedLines().includes(line);
    const state = stateOf(line);
    state.run = next;
    if (next.status === 'ready') state.lastResult = null;
    // A manual line used, or left without run nor last result: the pages get the list of the lines
    if (listed !== listedLines().includes(line)) broadcastToUI({ type: 'LINES_UPDATE', lines: getLineRuns() });
    broadcastToUI({ type: 'RUN_UPDATE', line, run: next });
    notifyActivityChange();
}

const unknownLine = (line: string) => `Unknown line "${line}".`;

/**
 * Announces that a participant is ready on a line: its next start crossing starts their run. In a discipline that
 * measures a distance, `distance` is the distance typed by the operator, in centimetres: the run then waits for the
 * operator to say whether it is valid (see validateRun and voidRun). `unlock` lets the participant change distance,
 * exceptionally, without validating the one they started.
 */
export async function prepareRun(
    line: string,
    event: string,
    discipline: string,
    participant: Participant,
    distance?: unknown,
    unlock = false
): Promise<string | null> {
    if (!isLine(line)) return unknownLine(line);
    if (stateOf(line).run.status === 'running') return `A run is in progress on ${line}. Cancel it first.`;
    const dir = await disciplineDir(event, discipline);
    if (!dir) return 'Unknown event or discipline.';

    const { settings } = await loadDisciplineSettings(dir);
    const closed = closedReason(settings);
    if (closed) return `${event} / ${discipline} is closed: ${closed}.`;
    // The disciplines timed by hand, and those measuring a distance, run on the manual line, and only them
    if (settings.measure === 'distance' && !isManualLine(line)) {
        return `${event} / ${discipline} measures a distance: its runs are on a manual line ("${MANUAL_LINE}").`;
    }
    if (settings.measure === 'time' && settings.trigger === 'keyboard' && !isManualLine(line)) {
        return `${event} / ${discipline} is timed by hand: its runs are on a manual line ("${MANUAL_LINE}").`;
    }
    if (settings.measure === 'time' && settings.trigger === 'gates' && isManualLine(line)) {
        return `${event} / ${discipline} is timed by the gates: the manual lines ("${MANUAL_LINE}") are for the disciplines timed by hand and the distances.`;
    }
    let distanceCm: number | undefined;
    if (settings.measure === 'distance') {
        const typed = toDistanceCm(distance);
        if (typeof typed === 'string') return typed;
        if (settings.minDistance !== null && typed < settings.minDistance) {
            return `The distance must be at least ${settings.minDistance} cm.`;
        }
        distanceCm = typed;
    }
    const { attempts } = settings;
    const perDistance = settings.measure === 'distance' ? settings.attemptsPerDistance : null;
    if (attempts !== null || settings.measure === 'distance') {
        const used = ((await loadResults(event, discipline)) ?? []).filter(
            (result) => result.bib === participant.bib && countsAsAttempt(result)
        );
        if (attempts !== null && used.length >= attempts) return `${participant.bib} ${participant.name} has used all ${attempts} attempt(s).`;
        const at = perDistance === null ? null : eliminatedAt(used, perDistance);
        if (at !== null) return `${participant.bib} ${participant.name} is eliminated: ${perDistance} attempt(s) at ${at} cm.`;
        const open = openDistance(used);
        if (settings.measure === 'distance' && !settings.allowDistanceChange && !unlock && open !== null && distanceCm !== open) {
            return `${participant.bib} ${participant.name} must validate ${open} cm before changing distance.`;
        }
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

    const state = stateOf(line);
    state.timeRule = settings;
    state.readyAt = Temporal.Now.instant().toString();
    if (distanceCm === undefined) {
        setRun(line, { status: 'ready', event, discipline, participant });
        log.info(`${participant.bib} ${participant.name} is ready on ${line} (${event} / ${discipline}).`);
    } else {
        setRun(line, { status: 'ready', event, discipline, participant, distanceCm });
        log.info(`${participant.bib} ${participant.name} is ready on ${line} (${event} / ${discipline}) with ${distanceCm} cm.`);
    }
    return null;
}

// Longest distance accepted, in centimetres (1000 m)
const MAX_DISTANCE_CM = 100_000;

/**
 * A distance typed by the operator, in centimetres; or why it cannot be one: it must be a whole number above 0 and
 * below 1000 m (e.g. 345 for 3.45 m).
 */
export function toDistanceCm(centimetres: unknown): number | string {
    if (typeof centimetres !== 'number' || !Number.isFinite(centimetres)) return 'The distance (in centimetres) is missing.';
    if (!Number.isInteger(centimetres)) return 'The distance must be a whole number of centimetres.';
    if (centimetres <= 0 || centimetres >= MAX_DISTANCE_CM) return 'The distance must be above 0 and below 100000 cm.';
    return centimetres;
}

/** The distance of the results file, in centimetres. null when it is missing or not a whole number. */
function distanceCmOf(text: string): number | null {
    const value = text.trim();
    return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The distance (in centimetres) at which a participant failed all the attempts allowed at one distance, so is
 * eliminated, or null. A validation resets the count at its distance: a participant who validates a distance, even at
 * the last attempt, goes on, but one who then fails it again `perDistance` times is eliminated. `results` are their runs
 * that count as attempts, oldest first.
 */
export function eliminatedAt(results: RunResult[], perDistance: number): number | null {
    const failed = new Map<number, number>();
    for (const { distanceCm, status } of results) {
        if (distanceCm === null) continue;
        if (status === 'ok') {
            failed.delete(distanceCm);
            continue;
        }
        const count = (failed.get(distanceCm) ?? 0) + 1;
        if (count >= perDistance) return distanceCm;
        failed.set(distanceCm, count);
    }
    return null;
}

/**
 * The distance (in centimetres) a participant started and did not validate yet, so their next run must be at it, or
 * null. `results` are their runs that count as attempts, oldest first: the distance of the last one, unless it is valid.
 */
export function openDistance(results: RunResult[]): number | null {
    const last = results.at(-1);
    return last === undefined || last.status === 'ok' ? null : last.distanceCm;
}

/**
 * The results without the runs beyond the attempts allowed: for each participant, the runs that count as attempts after
 * the first `attempts` ones, by start (e.g. an invalid run made valid afterwards, once the participant had their other
 * attempts). Their best result is among the others. Unlimited attempts (null): every result.
 */
export function withinAttempts<T extends Pick<RunResult, 'bib' | 'start' | 'status'>>(results: T[], attempts: number | null): T[] {
    if (attempts === null) return results;
    const instant = (result: T) => {
        try {
            return Temporal.Instant.from(result.start).epochNanoseconds;
        } catch {
            return 0n;
        }
    };
    const used = new Map<string, number>();
    const beyond = new Set<T>();
    for (const result of [...results].sort((a, b) => (instant(a) < instant(b) ? -1 : instant(a) > instant(b) ? 1 : 0))) {
        if (!countsAsAttempt(result)) continue;
        const count = (used.get(result.bib) ?? 0) + 1;
        used.set(result.bib, count);
        if (count > attempts) beyond.add(result);
    }
    return results.filter((result) => !beyond.has(result));
}

/** Invalid runs are not the participant's fault, so they do not use up an attempt. */
export function countsAsAttempt(result: Pick<RunResult, 'status'>): boolean {
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
    // A distance is typed by the operator: no crossing starts or ends its run
    if (run.status !== 'idle' && timeRule.measure === 'distance') return;
    if (run.status === 'ready' && gate === 'start') {
        log.info(`Start of ${run.participant.bib} ${run.participant.name} on ${line} ("${deviceName}").`);
        setRun(line, { ...run, status: 'running', startedAt: instant.toString() });
    } else if (run.status === 'running' && gate === 'finish') {
        const finish = instant.toString();
        const timeMs = runTimeMs(run.startedAt, finish, timeRule)!;
        log.info(`Finish of ${run.participant.bib} ${run.participant.name} on ${line} ("${deviceName}"): ${formatSeconds(timeMs)} s`);
        endRun(line, { finish, timeMs, distanceCm: null, status: 'ok' });
    }
}

/** The distance a participant is ready with on a line, waiting for the operator to say whether it is valid. */
function distanceToValidate(run: RunState): number | null {
    return run.status === 'ready' && run.distanceCm !== undefined ? run.distanceCm : null;
}

/**
 * Saves the distance a participant is ready with as valid (a discipline that measures a distance). Returns a problem
 * when no distance waits on the line.
 */
export function validateRun(line: string): string | null {
    if (!isLine(line)) return unknownLine(line);
    const { run } = stateOf(line);
    const distanceCm = distanceToValidate(run);
    if (run.status !== 'ready' || distanceCm === null) return `No distance to validate on ${line}.`;
    log.info(`Distance of ${run.participant.bib} ${run.participant.name} on ${line} validated: ${distanceCm} cm`);
    endRun(line, { finish: Temporal.Now.instant().toString(), timeMs: null, distanceCm, status: 'ok' });
    return null;
}

/**
 * Ends the run of a line now, without waiting for the finish, and saves it as invalid or DQ (no finish, no time). For a
 * distance, the distance waiting on the line is saved with this status (it can be made valid later).
 * Returns a problem when no run is in progress on the line.
 */
export function voidRun(line: string, status: 'invalid' | 'dq'): string | null {
    if (!isLine(line)) return unknownLine(line);
    const { run } = stateOf(line);
    const distanceCm = distanceToValidate(run);
    if (run.status !== 'running' && distanceCm === null) return `No run in progress on ${line}.`;
    if (run.status === 'idle') return null;
    log.info(`Run of ${run.participant.bib} ${run.participant.name} on ${line} ${status === 'dq' ? 'disqualified' : 'invalidated'}.`);
    if (distanceCm === null) endRun(line, { finish: null, timeMs: null, distanceCm: null, status });
    else endRun(line, { finish: Temporal.Now.instant().toString(), timeMs: null, distanceCm, status });
    return null;
}

function endRun(line: string, outcome: Pick<RunResult, 'finish' | 'timeMs' | 'distanceCm' | 'status'>): void {
    const state = stateOf(line);
    const { run } = state;
    // A run starts at its start crossing, a distance when the participant got ready with it
    if (run.status === 'idle' || (run.status === 'ready' && distanceToValidate(run) === null)) return;
    const start = run.status === 'running' ? run.startedAt : (state.readyAt ?? Temporal.Now.instant().toString());
    const { event, discipline, participant } = run;
    const result: RunResult = {
        bib: participant.bib,
        name: participant.name,
        start,
        ...outcome,
        computer: computerName(),
        line,
    };
    state.lastResult = { event, discipline, result, endedAt: new Date().toISOString() };
    setRun(line, { status: 'idle' });
    // Announced once saved: the pages that reload the results on this message (the live page) then get it
    saveResult(event, discipline, result).finally(() => broadcastToUI({ type: 'RUN_RESULT', line, event, discipline, result }));
}

/** Seconds with millisecond precision, e.g. "12.345". */
function formatSeconds(timeMs: number): string {
    return (timeMs / 1000).toFixed(3);
}

// Columns of the results file. The time is not stored: it is finish - start. `distance` is the distance typed by the
// operator in centimetres, in a discipline that measures a distance (empty otherwise). `status` is OK, INVALID or DQ. `computer`
// and `line` are the computer and the timing line of the run (empty for runs saved before these columns). `updated` is
// when the line was last changed (UTC), so the sync keeps the latest change of a line edited on two computers.
// Columns are found by their header name, so files with older layouts (with a time column, without distance, status,
// computer, line or updated) are read too, and are rewritten in this layout on their next write.
const COLUMNS = ['bib', 'name', 'start', 'finish', 'distance', 'status', 'computer', 'line', 'updated'] as const;
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

/** How a run is measured: a time (see TimeRule), or a distance in centimetres. */
export type MeasureRule = TimeRule & Pick<DisciplineSettings, 'measure'>;

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
                distance: cell('distance').trim(),
                status: cell('status').trim() || 'OK',
                computer: cell('computer').trim(),
                line: cell('line').trim(),
                updated: cell('updated').trim(),
            };
        });
}

/**
 * Writes the results file, then the UDA export beside it. Each goes through a temporary file, so a peer or the page never
 * reads a half-written file.
 */
async function writeRows(file: string, rows: Row[]): Promise<void> {
    const reset = await resultsResetAt(path.dirname(file));
    if (reset) {
        // Runs from before the reset are saved before they leave the file, with those not written yet (e.g. a run in
        // progress when the results were reset)
        const written = await readAllRows(file);
        const inFile = new Set(written.map(rowText));
        const all = [...written, ...rows.filter((row) => !inFile.has(rowText(row)))];
        if (all.some((row) => startedBefore(row, reset))) await backupResults(file, all, reset);
        rows = rows.filter((row) => !startedBefore(row, reset));
        if (rows.length === 0) {
            // Nothing left once saved: the results files go, until the next run
            await fs.promises.rm(file, { force: true });
            await fs.promises.rm(udaResultsFile(path.dirname(file)), { force: true });
            return;
        }
    }
    await writeAtomically(file, resultsText(rows));
    await writeUdaFile(path.dirname(file), rows);
}

/** Rows in the layout of the results file. */
function resultsText(rows: Row[]): string {
    const csvCell = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(';'));
    return `${[RESULTS_HEADER, ...lines].join('\n')}\n`;
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
 * any other bib with runs), sorted by bib, without header, comma separated, CRLF line ends. For a time:
 *   bib,,minutes,seconds,fraction   best OK run (shortest time, or longest for a slow race), e.g. "98,,1,13,23"
 *                                   for 1:13.23
 *   bib,DQ,0,0,0                    no OK run, at least one DQ
 *   bib,DNF,0,0,0                   no valid run: only INVALID runs, or none
 * The time is measured with the precision and rounding of the discipline, and the fraction of a second is in its unit:
 * tenths, hundredths or thousandths (0 in seconds), e.g. "98,,1,13,2" for 1:13.2 in tenths, "98,,1,13,234" for
 * 1:13.234 in thousandths.
 * For a distance (the longest OK run is the best):
 *   bib,,centimetres                e.g. "98,,345" for 3.45 m
 *   bib,DQ,0  and  bib,DNF,0        no OK run, as for a time
 * With a limit of attempts, only the first ones of each participant count (see withinAttempts).
 */
export function udaResults(
    rows: Row[],
    bibs: string[],
    settings: Pick<DisciplineSettings, 'measure' | 'best' | 'precision' | 'rounding'> & Partial<Pick<DisciplineSettings, 'attempts'>> = DEFAULT_SETTINGS
): string {
    const { measure, precision, rounding } = settings;
    const best = measure === 'distance' ? 'longest' : settings.best;
    const bestOf = new Map<string, RunResult | null>(bibs.map((bib) => [bib, null]));
    const results = rows.map((row) => toResult(row, { measure, precision, rounding }));
    // A result of null (valid without a time) is kept as it is: it gives no time
    const counted = new Set(withinAttempts(results.filter((result) => result !== null), settings.attempts ?? null));
    for (const result of results.filter((result) => result === null || counted.has(result))) {
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
            if (measure === 'distance') {
                if (!result) return `${bib},DNF,0\r\n`;
                if (result.status === 'dq' || result.distanceCm === null) return `${bib},DQ,0\r\n`;
                return `${bib},,${result.distanceCm}\r\n`;
            }
            if (!result) return `${bib},DNF,0,0,0\r\n`;
            if (result.status === 'dq' || result.timeMs === null) return `${bib},DQ,0,0,0\r\n`;
            const perSecond = UNITS_PER_SECOND[precision];
            const units = Math.round((result.timeMs * perSecond) / 1000);
            const minutes = Math.floor(units / (60 * perSecond));
            const seconds = Math.floor(units / perSecond) % 60;
            return `${bib},,${minutes},${seconds},${units % perSecond}\r\n`;
        })
        .join('');
}

// Units of a precision in a second: the fraction of the UDA export is in this unit
const UNITS_PER_SECOND: Record<Precision, number> = { second: 1, tenth: 10, hundredth: 100, thousandth: 1000 };

/**
 * An OK run beats a DQ; between OK runs, the shorter time wins (the longer one for a slow race), the longer distance for
 * a distance.
 */
function isBetter(result: RunResult, than: RunResult, best: DisciplineSettings['best']): boolean {
    if (result.status !== than.status) return result.status === 'ok';
    if (result.status !== 'ok') return false;
    const value = result.distanceCm ?? result.timeMs!;
    const other = than.distanceCm ?? than.timeMs!;
    return best === 'longest' ? value > other : value < other;
}

const nowText = () => Temporal.Now.instant().toString({ smallestUnit: 'millisecond' });

function toRow(result: RunResult): Row {
    return {
        bib: result.bib,
        name: result.name,
        start: result.start,
        finish: result.finish ?? '',
        distance: result.distanceCm === null ? '' : String(result.distanceCm),
        status: STATUS_TEXT[result.status],
        computer: result.computer ?? '',
        line: result.line ?? '',
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
 * A row of the results file as a result, measured with the rule: its time, or its distance in centimetres.
 * null for a valid run without a time (finish missing or unreadable), or without a distance.
 */
function toResult(row: Row, rule: MeasureRule): RunResult | null {
    const status = RUN_STATUSES.find((s) => STATUS_TEXT[s] === row.status.toUpperCase()) ?? 'ok';
    const finish = row.finish || null;
    const distance = rule.measure === 'distance';
    const timeMs = distance ? null : runTimeMs(row.start, finish, rule);
    const distanceCm = distance ? distanceCmOf(row.distance) : null;
    if (status === 'ok' && (distance ? distanceCm : timeMs) === null) return null;
    return { bib: row.bib, name: row.name, start: row.start, finish, timeMs, distanceCm, status, computer: row.computer || null, line: row.line || null };
}

/** Rows of the results file, empty when it does not exist yet. Runs started before the last reset are left out. */
async function readRows(file: string): Promise<Row[]> {
    const reset = await resultsResetAt(path.dirname(file));
    const rows = await readAllRows(file);
    return reset ? rows.filter((row) => !startedBefore(row, reset)) : rows;
}

/** Every row of the results file, as written, empty when it does not exist yet. */
async function readAllRows(file: string): Promise<Row[]> {
    try {
        return parseRows(await fs.promises.readFile(file, 'utf8'));
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

/** Whether a run started before an instant (a start that cannot be read counts as its last change). */
function startedBefore(row: Row, instant: Temporal.Instant): boolean {
    let start: Temporal.Instant;
    try {
        start = Temporal.Instant.from(row.start);
    } catch {
        start = updatedAt(row);
    }
    return Temporal.Instant.compare(start, instant) < 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as local YYYY-MM-DD_HH-MM-SS, valid in a file name on every system. */
function fileDate(date: Date): string {
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${day}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

const rowText = (row: Row) => COLUMNS.map((column) => row[column]).join('\t');

/**
 * Saves the rows of the results file, their UDA export and the participant files of the moment, to a folder of the backup folder named
 * by the date of the last change of the results (local YYYY-MM-DD_HH-MM-SS), before the runs started before the reset
 * leave it, unless every one of these is in a backup already (e.g. the one copied from the computer that reset the
 * results). A backup of that name is kept: the new one gets a -2, -3... suffix. Each file is suffixed by the name of
 * the backup, and the participant files prefixed by <event>-<discipline>- as the results files, e.g.
 * CFM26-100m-men-2026-11-05_08-03-09.csv. Returns the path of the backup, or null.
 */
async function backupResults(file: string, rows: Row[], reset: Temporal.Instant): Promise<string | null> {
    const dir = path.dirname(file);
    const dropped = rows.filter((row) => startedBefore(row, reset));
    const backupDir = path.join(dir, BACKUP_DIR);
    const saved = new Set<string>();
    for (const entry of await fs.promises.readdir(backupDir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        for (const row of await readAllRows(path.join(backupDir, entry.name, backupFileName(path.basename(file), entry.name)))) {
            saved.add(rowText(row));
        }
    }
    if (dropped.every((row) => saved.has(rowText(row)))) return null;

    await fs.promises.mkdir(backupDir, { recursive: true });
    const modified = (await fs.promises.stat(file).catch(() => null))?.mtime ?? new Date();
    let backup = '';
    for (let n = 1; !backup; n++) {
        const candidate = path.join(backupDir, n === 1 ? fileDate(modified) : `${fileDate(modified)}-${n}`);
        try {
            await fs.promises.mkdir(candidate);
            backup = candidate;
        } catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    // Each file is suffixed by the name of the backup, its date
    const suffixed = (fileName: string) => backupFileName(fileName, path.basename(backup));
    for (const participants of (await listDisciplineFiles(dir)).filter((f) => f.kind === 'participants')) {
        // Prefixed as the results files, e.g. CFM26-100m-men-2026-11-05_08-03-09.csv
        const name = withDisciplinePrefix(path.basename(path.dirname(dir)), path.basename(dir), participants.name);
        await fs.promises.copyFile(path.join(dir, participants.name), path.join(backup, suffixed(name)));
    }
    await fs.promises.writeFile(path.join(backup, suffixed(path.basename(file))), resultsText(rows));
    // The UDA export of these results, for these participants
    const { participants, settings } = await readParticipants(dir);
    await fs.promises.writeFile(path.join(backup, suffixed(path.basename(udaResultsFile(dir)))), udaResults(rows, participants.map((p) => p.bib), settings));
    log.info(`Results, their UDA export and participants saved to ${backup}`);
    return backup;
}

/**
 * Resets the results of a discipline, when its participants changed: runs started before now are dropped, on every
 * synced computer (see RESULTS_RESET_FILE), after a backup of them. The results file and its UDA export are removed
 * when no run is left (they come back with the next run).
 */
export function resetResults(event: string, discipline: string): Promise<void> {
    return enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) return;
        await writeResultsReset(dir, Temporal.Now.instant());
        const file = resultsFile(dir);
        if (fs.existsSync(file)) await writeRows(file, await readRows(file));
        log.info(`Results of ${event} / ${discipline} reset.`);
    });
}

/**
 * Drops from the results file the runs started before its last reset, after a copy in its backup folder (when the
 * reset comes from another computer). Returns whether the file changed.
 */
export function applyResultsReset(event: string, discipline: string): Promise<boolean> {
    return enqueueWrite(async () => {
        const dir = await disciplineDir(event, discipline);
        if (!dir) return false;
        const file = resultsFile(dir);
        const all = await readAllRows(file);
        const rows = await readRows(file);
        if (rows.length === all.length) return false;
        await writeRows(file, rows);
        return true;
    });
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
        if (status === 'ok' && settings.measure === 'distance' && current.distanceCm === null) {
            return { status: 409 as const, problem: 'This run has no distance.' };
        }
        if (status === 'ok' && settings.measure === 'time' && current.timeMs === null) {
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
        // Runs from before the reset, from a computer that did not get it yet, are not taken back
        const reset = await resultsResetAt(dir);

        let changed = false;
        for (const sent of remoteRows) {
            // A computer of an older version leaves out the columns it does not know
            const remote = Object.fromEntries(COLUMNS.map((column) => [column, String(sent[column] ?? '')])) as Row;
            if (reset && startedBefore(remote, reset)) continue;
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
