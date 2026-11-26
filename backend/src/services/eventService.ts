import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { createLogger, errorMessage } from '../utils/logger.js';
import { WORK_DIR } from '../utils/workDir.js';
import { MANUAL_LINE } from './lines.js';

/**
 * Events, disciplines and participants, read from the working directory:
 *
 *   <work dir>/<event>/<discipline>/<any name>.csv
 *
 * Each CSV file lists participants (comma, semicolon or tab separated). With a header row, columns are found by their
 * name (see HEADER_ALIASES), e.g. the competitors export of the UDA (Unicycling Data Application):
 *   ID,LastName,FirstName,Country,Gender,Age Group
 * Without a recognised header, the columns are "bib;name" (extra columns ignored). A discipline can have several
 * files, e.g. one per category: they are merged. Files are read on every request, so edits are picked up without
 * restarting.
 * <event>-<discipline>-results.csv in a discipline folder holds the timed runs, and <event>-<discipline>-uda-results.csv
 * their export for the UDA (see runService.ts): they are not participant files, nor is any file in the UDA results
 * format, whatever its name (e.g. a results file downloaded from the UDA). Files named results.csv and uda-results.csv
 * by earlier versions are renamed (see disciplineDir).
 * config.yaml, optional, holds the discipline settings (see DisciplineSettings).
 */

export const SETTINGS_FILE = 'config.yaml';

const log = createLogger('Events');

// Names of the results files written by earlier versions, without the event and discipline prefix
const LEGACY_RESULTS_FILE = 'results.csv';
const LEGACY_UDA_RESULTS_FILE = 'uda-results.csv';

/** Name of the timed runs file of a discipline: <event>-<discipline>-results.csv */
export function resultsFileName(event: string, discipline: string): string {
    return `${event}-${discipline}-results.csv`;
}

/** Name of the participant file the app gives a discipline (its first one): <event>-<discipline>-competitors.csv */
export function competitorsFileName(event: string, discipline: string): string {
    return `${event}-${discipline}-competitors.csv`;
}

/** A file name prefixed by <event>-<discipline>-, as the files the app writes, unless it is already (case ignored). */
export function withDisciplinePrefix(event: string, discipline: string, name: string): string {
    const prefix = `${event}-${discipline}-`;
    return name.toLowerCase().startsWith(prefix.toLowerCase()) ? name : `${prefix}${name}`;
}

/** Name of the UDA export of a discipline: <event>-<discipline>-uda-results.csv */
export function udaResultsFileName(event: string, discipline: string): string {
    return `${event}-${discipline}-uda-results.csv`;
}

/** Path of the timed runs file in a discipline folder (<work dir>/<event>/<discipline>). */
export function resultsFile(dir: string): string {
    return path.join(dir, resultsFileName(path.basename(path.dirname(dir)), path.basename(dir)));
}

/** Path of the UDA export in a discipline folder (<work dir>/<event>/<discipline>). */
export function udaResultsFile(dir: string): string {
    return path.join(dir, udaResultsFileName(path.basename(path.dirname(dir)), path.basename(dir)));
}

// When the results of a discipline were last reset (its participants changed): runs started before are dropped. Synced
// like config.yaml, so every computer drops them, and none sends them back
export const RESULTS_RESET_FILE = 'results-reset.yaml';

// Subfolder of a discipline holding its results saved before a reset (synced, not listed)
export const BACKUP_DIR = 'backup';

/** Name of a file in a backup folder: suffixed by the name of the backup (its date), e.g. men-2026-11-05_08-03-09.csv. */
export function backupFileName(name: string, backup: string): string {
    const extension = path.extname(name);
    return `${path.basename(name, extension)}-${backup}${extension}`;
}

/** When the results of a discipline folder were last reset, or null when never (or the file cannot be read). */
export async function resultsResetAt(dir: string): Promise<Temporal.Instant | null> {
    let parsed: any;
    try {
        parsed = yaml.parse(await fs.promises.readFile(path.join(dir, RESULTS_RESET_FILE), 'utf8'));
    } catch (error: any) {
        if (error.code !== 'ENOENT') log.error(`${path.join(dir, RESULTS_RESET_FILE)} cannot be read: ${errorMessage(error)}`);
        return null;
    }
    try {
        return Temporal.Instant.from(String(parsed?.at));
    } catch {
        log.error(`${path.join(dir, RESULTS_RESET_FILE)}: "at" must be an ISO 8601 instant, the reset is ignored.`);
        return null;
    }
}

/** Records a reset of the results of a discipline folder, unless a later one is recorded already. */
export async function writeResultsReset(dir: string, at: Temporal.Instant): Promise<void> {
    const current = await resultsResetAt(dir);
    if (current && Temporal.Instant.compare(current, at) >= 0) return;
    const file = path.join(dir, RESULTS_RESET_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, `# Runs started before are dropped (written when the participants changed)\nat: ${at.toString()}\n`);
    await fs.promises.rename(temporary, file);
}

/** Whether a file of a discipline folder is written by the app (its results or their UDA export), case ignored. */
export function isResultsFileName(event: string, discipline: string, name: string): boolean {
    return [
        resultsFileName(event, discipline),
        udaResultsFileName(event, discipline),
        LEGACY_RESULTS_FILE,
        LEGACY_UDA_RESULTS_FILE,
    ].some((fileName) => fileName.toLowerCase() === name.toLowerCase());
}

/**
 * Renames the results.csv of earlier versions to <event>-<discipline>-results.csv, unless that one exists already, and
 * removes their uda-results.csv (it is written again with the results).
 */
function renameLegacyResults(dir: string): void {
    const legacy = path.join(dir, LEGACY_RESULTS_FILE);
    const file = resultsFile(dir);
    try {
        if (fs.existsSync(legacy) && !fs.existsSync(file)) {
            fs.renameSync(legacy, file);
            fs.rmSync(path.join(dir, LEGACY_UDA_RESULTS_FILE), { force: true });
            log.info(`${legacy} renamed to ${path.basename(file)}.`);
        }
    } catch (error) {
        log.error(`Cannot rename ${legacy} to ${file}: ${errorMessage(error)}`);
    }
}

/** Settings of a discipline, from its config.yaml. Every setting is optional. */
export interface DisciplineSettings {
    // What a run measures: a time, between the start and finish crossings, or a distance, typed by the operator on the
    // race page (on the manual line of each computer, the longest distance is the best)
    measure: Measure;
    attempts: number | null; // Runs allowed per participant (invalid runs do not count); the best result is among the first ones only. null: unlimited
    // For a distance: runs allowed at one same distance (invalid runs do not count). A participant who used them all at
    // a distance without validating it is eliminated: no more runs. null: unlimited. Ignored for a time
    attemptsPerDistance: number | null;
    // For a distance: whether a participant can change distance before validating the last one they tried (false: they
    // try it again until it is validated). Ignored for a time
    allowDistanceChange: boolean;
    // Period when runs can be timed and results changed, from start (included) to end (excluded), as ISO 8601
    // date-times in UTC, e.g. 2026-11-05T07:00Z. null: no limit on that side
    start: string | null;
    end: string | null;
    // Whether runs can be timed and results changed: follow the start - end period (auto), always (open, e.g. to
    // correct a result after the period) or never (locked, results are final)
    access: Access;
    // Which time is the best: the shortest (a race), or the longest (a slow race, where the slowest wins). Ignored for a
    // distance: the longest is always the best
    best: Best;
    // Unit of the measured times, and how a time is brought to it: truncated, rounded to the nearest (a half goes up)
    // or rounded up. The time shown, ranked and written for the UDA is this one. Both are ignored for a distance: it is
    // typed in centimetres
    precision: Precision;
    rounding: Rounding;
    // How many of the last runs of a line the race page shows (0: none)
    recentRuns: number;
    // What starts and finishes the runs: the gates of the lines of config.yaml, or the space bar of the race page
    // (keyboard: timed by hand, on the manual line of each computer)
    trigger: Trigger;
    // The key that starts and finishes the runs of a discipline timed by hand, as the KeyboardEvent.code of the
    // browser (the key at that place on the keyboard, whatever its layout), e.g. Space, Enter or KeyA
    triggerKey: string;
}

export type Measure = 'time' | 'distance';
export const MEASURE_VALUES: Measure[] = ['time', 'distance'];

export type Precision = 'second' | 'tenth' | 'hundredth' | 'thousandth';
export const PRECISION_VALUES: Precision[] = ['second', 'tenth', 'hundredth', 'thousandth'];

export type Rounding = 'truncate' | 'nearest' | 'up';
export const ROUNDING_VALUES: Rounding[] = ['truncate', 'nearest', 'up'];

export type Best = 'shortest' | 'longest';
export const BEST_VALUES: Best[] = ['shortest', 'longest'];

export type Trigger = 'gates' | 'keyboard';
export const TRIGGER_VALUES: Trigger[] = ['gates', 'keyboard'];

export type Access = 'auto' | 'open' | 'locked';
export const ACCESS_VALUES: Access[] = ['auto', 'open', 'locked'];

export const DEFAULT_SETTINGS: DisciplineSettings = {
    measure: 'time',
    attempts: null,
    attemptsPerDistance: null,
    allowDistanceChange: false,
    start: null,
    end: null,
    access: 'auto',
    best: 'shortest',
    precision: 'hundredth',
    rounding: 'up',
    recentRuns: 3,
    trigger: 'gates',
    triggerKey: 'Space',
};

/** Whether a value can be a KeyboardEvent.code (letters and digits, e.g. Space, KeyA, Digit1, NumpadEnter). */
export const isKeyCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value);

/**
 * A start or end of the period as an ISO 8601 date-time in UTC (YYYY-MM-DDTHH:MMZ), or null when it is not a real
 * date-time. Accepted: any ISO 8601 date-time with an offset (Z or ±HH:MM), converted to UTC. Seconds are dropped.
 * Without an offset ("2026-11-05T09:00", or with a space) it is read in the server's time zone; a date alone means
 * the start of that day for `start` and the end of that day (the next midnight) for `end`.
 */
export function toDateTime(value: unknown, side: 'start' | 'end'): string | null {
    const match =
        typeof value === 'string' &&
        /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
    if (!match) return null;
    const [, date, time, offset] = match;
    try {
        let instant: Temporal.Instant;
        if (offset) {
            // The date must exist (2026-02-30T08:00Z does not)
            Temporal.PlainDate.from(date, { overflow: 'reject' });
            instant = Temporal.Instant.from(`${date}T${time}${offset}`);
        } else {
            let dateTime = Temporal.PlainDateTime.from(`${date}T${time ?? '00:00'}`, { overflow: 'reject' });
            if (!time && side === 'end') dateTime = dateTime.add({ days: 1 });
            instant = dateTime.toZonedDateTime(Temporal.Now.timeZoneId()).toInstant();
        }
        return instant.toString({ smallestUnit: 'minute' });
    } catch {
        return null;
    }
}

/** A UTC date-time in the server's local time, e.g. "2026-11-05 08:00 +01:00", for messages. */
const showDateTime = (dateTime: string) =>
    Temporal.Instant.from(dateTime)
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toString({ smallestUnit: 'minute', timeZoneName: 'never' })
        .replace('T', ' ')
        .replace(/([+-]\d{2}:\d{2})$/, ' $1');

/**
 * Why the discipline cannot be changed now (locked, or outside its start - end period unless access is open), or null
 * when it can.
 */
export function closedReason(settings: DisciplineSettings): string | null {
    if (settings.access === 'locked') return 'its results are locked';
    if (settings.access === 'open') return null;
    const now = Temporal.Now.instant();
    if (settings.start && Temporal.Instant.compare(now, Temporal.Instant.from(settings.start)) < 0) {
        return `it opens on ${showDateTime(settings.start)}`;
    }
    if (settings.end && Temporal.Instant.compare(now, Temporal.Instant.from(settings.end)) >= 0) {
        return `it closed on ${showDateTime(settings.end)}`;
    }
    return null;
}

/** Whether a start comes before an end (both from toDateTime). */
const isBefore = (start: string, end: string) => Temporal.Instant.compare(Temporal.Instant.from(start), Temporal.Instant.from(end)) < 0;

export interface EventSummary {
    name: string;
    disciplines: string[];
}

export interface Participant {
    bib: string;
    name: string;
    category: string; // The Age Group column, empty when the file has none or the cell is empty
}

export interface ParticipantList {
    participants: Participant[];
    settings: DisciplineSettings;
    problems: string[]; // Settings that were ignored and rows that were skipped, and why
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Visible subdirectory names of a directory, sorted. Empty when it does not exist. */
async function subdirectories(dir: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(byName);
}

/** Every event of the working directory, with its disciplines. */
export async function listEvents(): Promise<EventSummary[]> {
    const events = await subdirectories(WORK_DIR);
    return Promise.all(
        events.map(async (name) => ({ name, disciplines: await subdirectories(path.join(WORK_DIR, name)) }))
    );
}

// Names that Windows refuses for a file or folder, with or without an extension
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Event names that would clash with the URLs of the app (/<event>/<discipline>/race)
const RESERVED_EVENTS = ['api'];
const MAX_NAME_LENGTH = 64;

/**
 * Why a name cannot be the folder of an event or discipline, or a file of a discipline, or null when it can. The rules
 * are those of every system the app runs on (Windows is the strictest), so what is synced to another computer can be
 * created there too.
 */
export function folderNameProblem(name: string, kind: 'event' | 'discipline' | 'file'): string | null {
    if (name === '') return 'The name is missing.';
    if (name.length > MAX_NAME_LENGTH) return `The name is too long (${MAX_NAME_LENGTH} characters at most).`;
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'The name cannot contain / \\ : * ? " < > |.';
    if (name.startsWith('.') || name.endsWith('.')) return 'The name cannot start or end with a dot.';
    if (WINDOWS_RESERVED.test(name)) return `${name} is a name reserved by Windows.`;
    if (kind === 'event' && RESERVED_EVENTS.includes(name.toLowerCase())) return `${name} is a name reserved by the app.`;
    return null;
}

/** An event or discipline that cannot be created: the HTTP status and why. */
export class CreateError extends Error {
    constructor(readonly status: 404 | 409 | 422, message: string) {
        super(message);
    }
}

/** Creates a folder in a parent folder, after checking its name and that no folder has it (case ignored). */
async function createFolder(parent: string, name: string, kind: 'event' | 'discipline'): Promise<string> {
    const problem = folderNameProblem(name, kind);
    if (problem) throw new CreateError(422, problem);
    // Case is ignored: Windows and macOS see CFM26 and cfm26 as the same folder
    const existing = (await subdirectories(parent)).find((other) => other.toLowerCase() === name.toLowerCase());
    if (existing) throw new CreateError(409, `The ${kind} ${existing} already exists.`);
    const dir = path.join(parent, name);
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
}

/** Creates the folder of an event (the name is trimmed). Throws a CreateError when it cannot be created. */
export async function createEvent(name: string): Promise<string> {
    const event = name.trim();
    await createFolder(WORK_DIR, event, 'event');
    log.info(`Event ${event} created.`);
    return event;
}

/**
 * Creates the folder of a discipline in an event (the name is trimmed), with its settings file: the sync copies files
 * only, so the discipline appears on the synced computers too. Throws a CreateError when it cannot be created.
 */
export async function createDiscipline(event: string, name: string): Promise<string> {
    if (!(await subdirectories(WORK_DIR)).includes(event)) throw new CreateError(404, 'Unknown event.');
    const discipline = name.trim();
    const dir = await createFolder(path.join(WORK_DIR, event), discipline, 'discipline');
    await saveDisciplineSettings(dir, DEFAULT_SETTINGS);
    log.info(`Discipline ${event}/${discipline} created.`);
    return discipline;
}

/**
 * Folder of a discipline, or null when the event or discipline does not exist. The names are checked against the
 * directory listing, so a request cannot reach files outside the working directory.
 */
export async function disciplineDir(event: string, discipline: string): Promise<string | null> {
    if (!(await subdirectories(WORK_DIR)).includes(event)) return null;
    if (!(await subdirectories(path.join(WORK_DIR, event))).includes(discipline)) return null;
    const dir = path.join(WORK_DIR, event, discipline);
    renameLegacyResults(dir);
    return dir;
}

/**
 * Participants of a discipline, from all its CSV files, sorted by bib. Null when the discipline does not exist.
 */
export async function loadParticipants(event: string, discipline: string): Promise<ParticipantList | null> {
    const dir = await disciplineDir(event, discipline);
    return dir ? readParticipants(dir) : null;
}

/** Participants from the CSV files of a discipline folder, sorted by bib (see loadParticipants). */
export async function readParticipants(dir: string): Promise<ParticipantList> {
    const { settings, problems } = await loadDisciplineSettings(dir);
    const read = await readParticipantFiles(dir);
    const participants = read.entries.map(({ bib, name, category }) => ({ bib, name, category }));
    return { participants, settings, problems: [...problems, ...read.problems] };
}

/** A participant CSV file of a discipline folder, as read (see readParticipantFiles). */
export interface ParticipantFile {
    name: string;
    // The text was valid UTF-8 (else Windows-1252), and started with a BOM
    utf8: boolean;
    bom: boolean;
    text: string;
    rows: string[][];
    columns: ParticipantColumns;
    // The columns were found by their name in the first row; else they are bib;name
    recognized: boolean;
    // The first row is a header: its bib is not a number
    header: boolean;
}

/** A participant, with the file and the row (index in its rows) it comes from. */
export interface ParticipantEntry extends Participant {
    file: string;
    row: number;
}

/**
 * The participant files of a discipline folder by name (UDA results files left out), with the participants they
 * list sorted by bib, and the rows skipped and why. A bib is the participant of its first valid row.
 */
export async function readParticipantFiles(dir: string): Promise<{ files: ParticipantFile[]; entries: ParticipantEntry[]; problems: string[] }> {
    const names = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.csv')
        .filter((entry) => !isResultsFileName(path.basename(path.dirname(dir)), path.basename(dir), entry.name))
        .map((entry) => entry.name)
        .sort(byName);

    const files: ParticipantFile[] = [];
    const entries: ParticipantEntry[] = [];
    const problems: string[] = [];
    const fileOfBib = new Map<string, string>();

    for (const fileName of names) {
        let file: ParticipantFile;
        try {
            const buffer = await fs.promises.readFile(path.join(dir, fileName));
            const { text, utf8 } = decode(buffer);
            const rows = parseCsv(text);
            const { columns, recognized } = participantColumns(rows[0] ?? []);
            const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
            file = { name: fileName, utf8, bom, text, rows, columns, recognized, header: false };
        } catch (error) {
            problems.push(`${fileName}: cannot be read (${errorMessage(error)})`);
            continue;
        }

        if (isUdaResults(file.rows)) continue;
        files.push(file);
        file.rows.forEach((row, index) => {
            const { bib, name, category } = participantCells(row, file.columns);
            const where = `${fileName}, line ${index + 1}`;
            if (bib === '' && name === '') return;
            // Header row: first line whose bib is not a number
            if (index === 0 && !/^\d+$/.test(bib)) {
                file.header = true;
                return;
            }

            if (!/^\d+$/.test(bib)) {
                problems.push(`${where}: bib "${bib}" is not a number`);
            } else if (name === '') {
                problems.push(`${where}: bib ${bib} has no name`);
            } else if (fileOfBib.has(bib)) {
                problems.push(`${where}: bib ${bib} is already used in ${fileOfBib.get(bib)}`);
            } else {
                fileOfBib.set(bib, fileName);
                entries.push({ bib, name, category, file: fileName, row: index });
            }
        });
    }

    entries.sort((a, b) => Number(a.bib) - Number(b.bib));
    return { files, entries, problems };
}

/**
 * The bib, name and category of a row, trimmed. The name is "first name last name" (see titleCase), or the name
 * column as it is.
 */
export function participantCells(row: string[], columns: ParticipantColumns): Participant {
    const cells = row.map((cell) => cell.trim());
    const cell = (column: number | null) => (column === null ? '' : (cells[column] ?? ''));
    const name = [titleCase(cell(columns.firstName)), titleCase(cell(columns.lastName)), cell(columns.name)]
        .filter((part) => part !== '')
        .join(' ');
    return { bib: cell(columns.bib), name, category: cell(columns.category) };
}

/**
 * Whether CSV rows are results in the UDA import format (bib,status,minutes,seconds,fraction for a time,
 * bib,status,centimetres for a distance, no header, see udaResults in runService.ts), not participants.
 */
function isUdaResults(rows: string[][]): boolean {
    const lines = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
    return (
        lines.length > 0 &&
        lines.every((row) => {
            const [bib, status, ...time] = row.map((cell) => cell.trim());
            return (row.length === 5 || row.length === 3) && /^\d+$/.test(bib) && /^(|DQ|DNF)$/i.test(status) && time.every((cell) => /^\d+$/.test(cell));
        })
    );
}

/** Header names of the participant columns, compared without case, accents, spaces, dashes and underscores. */
const HEADER_ALIASES = {
    bib: ['bib', 'id', 'dossard', 'number', 'numero'],
    name: ['name', 'nom', 'fullname'],
    firstName: ['firstname', 'prenom'],
    lastName: ['lastname', 'surname', 'nomdefamille'],
    category: ['agegroup', 'category', 'categorie'],
};
export type ParticipantColumns = Record<keyof typeof HEADER_ALIASES, number | null>;

const headerKey = (cell: string) =>
    cell.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_-]/g, '').toLowerCase();

/**
 * A first or last name with the first letter of each word in uppercase and the others in lowercase, words being
 * separated by spaces, dashes and apostrophes: "DUVAL-ARNOUX" → "Duval-Arnoux", "o'neil" → "O'Neil".
 */
export function titleCase(text: string): string {
    return text.toLocaleLowerCase('fr').replace(/(^|[\s\-'’])(\p{L})/gu, (_, before, letter) => before + letter.toLocaleUpperCase('fr'));
}

/**
 * Where the participant columns are, from the first row of a file. Without a bib column and a name (name, or first
 * and/or last name) in that row, it is not a recognised header: bib in the first column, name in the second.
 */
function participantColumns(firstRow: string[]): { columns: ParticipantColumns; recognized: boolean } {
    const keys = firstRow.map(headerKey);
    const find = (aliases: string[]) => {
        const index = keys.findIndex((key) => aliases.includes(key));
        return index === -1 ? null : index;
    };
    const found = Object.fromEntries(
        Object.entries(HEADER_ALIASES).map(([column, aliases]) => [column, find(aliases)])
    ) as ParticipantColumns;
    if (found.firstName !== null || found.lastName !== null) found.name = null;
    const hasName = found.name !== null || found.firstName !== null || found.lastName !== null;
    if (found.bib !== null && hasName) return { columns: found, recognized: true };
    return { columns: { bib: 0, name: 1, firstName: null, lastName: null, category: null }, recognized: false };
}

/**
 * Reads config.yaml in a discipline folder. Missing file: default settings. A wrong setting is ignored (its
 * default is used) and listed in `problems`.
 */
export async function loadDisciplineSettings(dir: string): Promise<{ settings: DisciplineSettings; problems: string[] }> {
    const settings: DisciplineSettings = { ...DEFAULT_SETTINGS };
    const problems: string[] = [];

    let parsed: any;
    try {
        parsed = yaml.parse(await fs.promises.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    } catch (error: any) {
        if (error.code !== 'ENOENT') problems.push(`${SETTINGS_FILE}: cannot be read (${errorMessage(error)})`);
        return { settings, problems };
    }
    if (parsed === null || parsed === undefined) return { settings, problems };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push(`${SETTINGS_FILE}: settings must be written as "name: value" lines`);
        return { settings, problems };
    }

    for (const [key, value] of Object.entries(parsed)) {
        if (key === 'measure') {
            if (MEASURE_VALUES.includes(value as Measure)) settings.measure = value as Measure;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: measure must be time or distance (the runs are timed)`);
        } else if (key === 'attempts') {
            if (Number.isInteger(value) && (value as number) >= 1) settings.attempts = value as number;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: attempts must be a whole number from 1 (attempts are unlimited)`);
        } else if (key === 'attemptsPerDistance') {
            if (Number.isInteger(value) && (value as number) >= 1) settings.attemptsPerDistance = value as number;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: attemptsPerDistance must be a whole number from 1 (attempts per distance are unlimited)`);
        } else if (key === 'allowDistanceChange') {
            if (typeof value === 'boolean') settings.allowDistanceChange = value;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: allowDistanceChange must be true or false (a distance started must be validated first)`);
        } else if (key === 'access') {
            if (ACCESS_VALUES.includes(value as Access)) settings.access = value as Access;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: access must be auto, open or locked (it is ignored)`);
        } else if (key === 'best') {
            if (BEST_VALUES.includes(value as Best)) settings.best = value as Best;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: best must be shortest or longest (the shortest time is the best)`);
        } else if (key === 'precision') {
            if (PRECISION_VALUES.includes(value as Precision)) settings.precision = value as Precision;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: precision must be second, tenth, hundredth or thousandth (times are in hundredths)`);
        } else if (key === 'rounding') {
            if (ROUNDING_VALUES.includes(value as Rounding)) settings.rounding = value as Rounding;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: rounding must be truncate, nearest or up (times are rounded up)`);
        } else if (key === 'trigger') {
            if (TRIGGER_VALUES.includes(value as Trigger)) settings.trigger = value as Trigger;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: trigger must be gates or keyboard (the runs are timed by the gates)`);
        } else if (key === 'triggerKey') {
            if (isKeyCode(value)) settings.triggerKey = value;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: triggerKey must be the code of a key, such as Space or Enter (the space bar is used)`);
        } else if (key === 'recentRuns') {
            if (Number.isInteger(value) && (value as number) >= 0) settings.recentRuns = value as number;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: recentRuns must be a whole number from 0 (the last 3 runs are shown)`);
        } else if (key === 'locked') {
            // Older setting, replaced by access: locked
            if (value === true && parsed.access === undefined) settings.access = 'locked';
            else if (typeof value !== 'boolean' && value !== null) problems.push(`${SETTINGS_FILE}: locked must be true or false (it is ignored)`);
        } else if (key === 'start' || key === 'end') {
            const dateTime = toDateTime(value, key);
            if (dateTime) settings[key] = dateTime;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: ${key} must be an ISO 8601 date-time such as 2026-11-05T07:00Z (it is ignored)`);
        } else {
            problems.push(`${SETTINGS_FILE}: unknown setting "${key}" is ignored`);
        }
    }
    if (settings.start && settings.end && !isBefore(settings.start, settings.end)) {
        problems.push(`${SETTINGS_FILE}: start (${showDateTime(settings.start)}) is not before end (${showDateTime(settings.end)}), both are ignored`);
        settings.start = null;
        settings.end = null;
    }
    return { settings, problems };
}

/** UTF-8 (with or without BOM), or Windows-1252 as saved by Excel on Windows when the file is not valid UTF-8. */
function decode(buffer: Buffer): { text: string; utf8: boolean } {
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), utf8: true };
    } catch {
        return { text: new TextDecoder('windows-1252').decode(buffer), utf8: false };
    }
}

/** The separator of CSV text: the most frequent one on its first line, among semicolon, comma and tab. */
export function csvSeparator(text: string): string {
    const firstLine = text.split(/\r?\n/, 1)[0];
    const count = (separator: string) => firstLine.split(separator).length;
    return [';', ',', '\t'].reduce((best, candidate) => (count(candidate) > count(best) ? candidate : best));
}

/**
 * Splits CSV text into rows of cells. The separator (semicolon, comma or tab) is the most frequent one on the
 * first line. Quoted cells may contain separators, line breaks and doubled quotes.
 */
export function parseCsv(text: string): string[][] {
    const separator = csvSeparator(text);

    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"' && cell === '') {
            quoted = true;
        } else if (char === separator) {
            row.push(cell);
            cell = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }
    if (cell !== '' || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

/** Problems of settings sent by the race page. Empty when they are valid. */
export function validateDisciplineSettings(settings: any): string[] {
    if (!settings || typeof settings !== 'object') return ['settings are missing'];
    const {
        measure = DEFAULT_SETTINGS.measure,
        attempts = null,
        attemptsPerDistance = null,
        allowDistanceChange = DEFAULT_SETTINGS.allowDistanceChange,
        start = null,
        end = null,
        access = DEFAULT_SETTINGS.access,
        best = DEFAULT_SETTINGS.best,
        precision = DEFAULT_SETTINGS.precision,
        rounding = DEFAULT_SETTINGS.rounding,
        recentRuns = DEFAULT_SETTINGS.recentRuns,
        trigger = DEFAULT_SETTINGS.trigger,
        triggerKey = DEFAULT_SETTINGS.triggerKey,
    } = settings;
    const problems: string[] = [];
    if (!MEASURE_VALUES.includes(measure)) problems.push('measure must be time or distance');
    if (attempts !== null && !(Number.isInteger(attempts) && attempts >= 1)) {
        problems.push('attempts must be a whole number from 1, or null for unlimited attempts');
    }
    if (attemptsPerDistance !== null && !(Number.isInteger(attemptsPerDistance) && attemptsPerDistance >= 1)) {
        problems.push('attemptsPerDistance must be a whole number from 1, or null for unlimited attempts per distance');
    }
    if (typeof allowDistanceChange !== 'boolean') problems.push('allowDistanceChange must be true or false');
    for (const [name, value] of [['start', start], ['end', end]] as const) {
        if (value !== null && !toDateTime(value, name)) problems.push(`${name} must be an ISO 8601 date-time such as 2026-11-05T07:00Z, or null`);
    }
    const startAt = toDateTime(start, 'start');
    const endAt = toDateTime(end, 'end');
    if (startAt && endAt && !isBefore(startAt, endAt)) problems.push('start must be before end');
    if (!ACCESS_VALUES.includes(access)) problems.push('access must be auto, open or locked');
    if (!BEST_VALUES.includes(best)) problems.push('best must be shortest or longest');
    if (!PRECISION_VALUES.includes(precision)) problems.push('precision must be second, tenth, hundredth or thousandth');
    if (!ROUNDING_VALUES.includes(rounding)) problems.push('rounding must be truncate, nearest or up');
    if (!(Number.isInteger(recentRuns) && recentRuns >= 0)) problems.push('recentRuns must be a whole number from 0');
    if (!TRIGGER_VALUES.includes(trigger)) problems.push('trigger must be gates or keyboard');
    if (!isKeyCode(triggerKey)) problems.push('triggerKey must be the code of a key, such as Space or Enter');
    return problems;
}

/**
 * Writes the settings to config.yaml in a discipline folder, creating it if needed. The file is rewritten in a
 * standard layout (comments are not kept, as for the device config.yaml); other settings it holds are kept.
 */
export async function saveDisciplineSettings(dir: string, settings: DisciplineSettings): Promise<void> {
    const file = path.join(dir, SETTINGS_FILE);
    let others: Record<string, unknown> = {};
    try {
        const parsed = yaml.parse(await fs.promises.readFile(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const { measure: _measure, attempts: _attempts, attemptsPerDistance: _attemptsPerDistance, allowDistanceChange: _allowDistanceChange, start: _start, end: _end, locked: _locked, access: _access, best: _best, precision: _precision, rounding: _rounding, recentRuns: _recentRuns, trigger: _trigger, triggerKey: _triggerKey, ...rest } = parsed;
            others = rest;
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT' && !(error instanceof yaml.YAMLParseError)) throw error;
    }

    const lines = [
        '# Settings of this discipline, also edited from the race page (saving from the page does not keep comments)',
        '',
        '# What a run measures: time (between the start and finish) or distance (typed on the race page, on the line',
        `# "${MANUAL_LINE}" of each computer, the longest is the best)`,
        `measure: ${settings.measure}`,
        '',
        '# Runs allowed per participant (invalid runs do not count). The best result is among the first ones only (a run',
        '# made valid afterwards beyond them does not count). Unlimited when not set.',
        settings.attempts === null ? '#attempts: 3' : `attempts: ${settings.attempts}`,
        '# For a distance: runs allowed at one same distance (invalid runs do not count). A participant who used them all',
        '# at a distance without validating it is eliminated. Unlimited when not set.',
        settings.attemptsPerDistance === null ? '#attemptsPerDistance: 3' : `attemptsPerDistance: ${settings.attemptsPerDistance}`,
        '# For a distance: whether a participant can change distance before validating the last one they tried',
        `allowDistanceChange: ${settings.allowDistanceChange}`,
        '',
        '# Period when runs can be timed and results changed, from start (included) to end (excluded).',
        '# ISO 8601 date-times in UTC. No limit when not set.',
        settings.start === null ? '#start: 2026-01-31T07:00Z' : `start: ${settings.start}`,
        settings.end === null ? '#end: 2026-01-31T17:00Z' : `end: ${settings.end}`,
        '',
        '# When runs can be timed and results changed: auto (during the period above), open (always, ignores the',
        '# period, e.g. to correct a result) or locked (never, results are final)',
        `access: ${settings.access}`,
        '',
        '# Which time is the best: shortest (a race) or longest (a slow race, the slowest participant wins). Ignored for a',
        '# distance: the longest is the best',
        `best: ${settings.best}`,
        '',
        '# Unit of the times: second, tenth, hundredth or thousandth (not for a distance: it is in centimetres)',
        `precision: ${settings.precision}`,
        '# How a time is brought to that unit: truncate, nearest (a half goes up) or up (not for a distance)',
        `rounding: ${settings.rounding}`,
        '',
        '# How many of the last runs of a line the race page shows (0: none). 3 when not set.',
        `recentRuns: ${settings.recentRuns}`,
        '',
        '# What starts and finishes the runs: gates (the start and finish gates of a line) or keyboard (timed by hand,',
        `# with the space bar of the race page, on the line "${MANUAL_LINE}" of each computer)`,
        `trigger: ${settings.trigger}`,
        '# The key that starts and finishes the runs timed by hand: the code of a key of the browser (Space, Enter, KeyA…)',
        `triggerKey: ${settings.triggerKey}`,
    ];
    if (Object.keys(others).length > 0) lines.push('', '# Other settings', yaml.stringify(others).trimEnd());
    await fs.promises.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}
