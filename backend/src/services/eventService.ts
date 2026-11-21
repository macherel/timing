import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { errorMessage } from '../utils/logger.js';
import { WORK_DIR } from '../utils/workDir.js';

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
 * results.csv in a discipline folder holds the timed runs, and uda-results.csv their export for the UDA (see
 * runService.ts): they are not participant files, nor is any file in the UDA results format, whatever its name
 * (e.g. a results file downloaded from the UDA).
 * config.yaml, optional, holds the discipline settings (see DisciplineSettings).
 */

export const RESULTS_FILE = 'results.csv';
export const UDA_RESULTS_FILE = 'uda-results.csv';
export const SETTINGS_FILE = 'config.yaml';

/** Settings of a discipline, from its config.yaml. Every setting is optional. */
export interface DisciplineSettings {
    attempts: number | null; // Runs allowed per participant (invalid runs do not count). null: unlimited
    // Period when runs can be timed and results changed, from start (included) to end (excluded), as ISO 8601
    // date-times in UTC, e.g. 2026-11-05T07:00Z. null: no limit on that side
    start: string | null;
    end: string | null;
    // Whether runs can be timed and results changed: follow the start - end period (auto), always (open, e.g. to
    // correct a result after the period) or never (locked, results are final)
    access: Access;
    // Which time is the best: the shortest (a race), or the longest (a slow race, where the slowest wins)
    best: Best;
}

export type Best = 'shortest' | 'longest';
export const BEST_VALUES: Best[] = ['shortest', 'longest'];

export type Access = 'auto' | 'open' | 'locked';
export const ACCESS_VALUES: Access[] = ['auto', 'open', 'locked'];

const DEFAULT_SETTINGS: DisciplineSettings = { attempts: null, start: null, end: null, access: 'auto', best: 'shortest' };

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
    file: string; // Category: the Age Group column when the file has one, else the CSV file name without extension
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

/**
 * Folder of a discipline, or null when the event or discipline does not exist. The names are checked against the
 * directory listing, so a request cannot reach files outside the working directory.
 */
export async function disciplineDir(event: string, discipline: string): Promise<string | null> {
    if (!(await subdirectories(WORK_DIR)).includes(event)) return null;
    if (!(await subdirectories(path.join(WORK_DIR, event))).includes(discipline)) return null;
    return path.join(WORK_DIR, event, discipline);
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
    const files = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.csv')
        .filter((entry) => ![RESULTS_FILE, UDA_RESULTS_FILE].includes(entry.name.toLowerCase()))
        .map((entry) => entry.name)
        .sort(byName);

    const participants: Participant[] = [];
    const { settings, problems } = await loadDisciplineSettings(dir);
    const fileOfBib = new Map<string, string>();

    for (const fileName of files) {
        let rows: string[][];
        try {
            rows = parseCsv(decode(await fs.promises.readFile(path.join(dir, fileName))));
        } catch (error) {
            problems.push(`${fileName}: cannot be read (${errorMessage(error)})`);
            continue;
        }

        if (isUdaResults(rows)) continue;
        const columns = participantColumns(rows[0] ?? []);
        rows.forEach((row, index) => {
            const cells = row.map((cell) => cell.trim());
            const cell = (column: number | null) => (column === null ? '' : (cells[column] ?? ''));
            const bib = cell(columns.bib);
            const name = [titleCase(cell(columns.firstName)), titleCase(cell(columns.lastName)), cell(columns.name)]
                .filter((part) => part !== '')
                .join(' ');
            const where = `${fileName}, line ${index + 1}`;
            if (bib === '' && name === '') return;
            // Header row: first line whose bib is not a number
            if (index === 0 && !/^\d+$/.test(bib)) return;

            if (!/^\d+$/.test(bib)) {
                problems.push(`${where}: bib "${bib}" is not a number`);
            } else if (name === '') {
                problems.push(`${where}: bib ${bib} has no name`);
            } else if (fileOfBib.has(bib)) {
                problems.push(`${where}: bib ${bib} is already used in ${fileOfBib.get(bib)}`);
            } else {
                fileOfBib.set(bib, fileName);
                participants.push({ bib, name, file: cell(columns.category) || path.parse(fileName).name });
            }
        });
    }

    participants.sort((a, b) => Number(a.bib) - Number(b.bib));
    return { participants, settings, problems };
}

/**
 * Whether CSV rows are results in the UDA import format (bib,status,minutes,seconds,hundredths, no header, see
 * udaResults in runService.ts), not participants.
 */
function isUdaResults(rows: string[][]): boolean {
    const lines = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
    return (
        lines.length > 0 &&
        lines.every((row) => {
            const [bib, status, ...time] = row.map((cell) => cell.trim());
            return row.length === 5 && /^\d+$/.test(bib) && /^(|DQ|DNF)$/i.test(status) && time.every((cell) => /^\d+$/.test(cell));
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
type ParticipantColumns = Record<keyof typeof HEADER_ALIASES, number | null>;

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
 * The name is "first name last name" (see titleCase), or the name column as it is.
 */
function participantColumns(firstRow: string[]): ParticipantColumns {
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
    if (found.bib !== null && hasName) return found;
    return { bib: 0, name: 1, firstName: null, lastName: null, category: null };
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
        if (key === 'attempts') {
            if (Number.isInteger(value) && (value as number) >= 1) settings.attempts = value as number;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: attempts must be a whole number from 1 (attempts are unlimited)`);
        } else if (key === 'access') {
            if (ACCESS_VALUES.includes(value as Access)) settings.access = value as Access;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: access must be auto, open or locked (it is ignored)`);
        } else if (key === 'best') {
            if (BEST_VALUES.includes(value as Best)) settings.best = value as Best;
            else if (value !== null) problems.push(`${SETTINGS_FILE}: best must be shortest or longest (the shortest time is the best)`);
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
function decode(buffer: Buffer): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        return new TextDecoder('windows-1252').decode(buffer);
    }
}

/**
 * Splits CSV text into rows of cells. The separator (semicolon, comma or tab) is the most frequent one on the
 * first line. Quoted cells may contain separators, line breaks and doubled quotes.
 */
export function parseCsv(text: string): string[][] {
    const firstLine = text.split(/\r?\n/, 1)[0];
    const count = (separator: string) => firstLine.split(separator).length;
    const separator = [';', ',', '\t'].reduce((best, candidate) => (count(candidate) > count(best) ? candidate : best));

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
    const { attempts = null, start = null, end = null, access = 'auto', best = 'shortest' } = settings;
    const problems: string[] = [];
    if (attempts !== null && !(Number.isInteger(attempts) && attempts >= 1)) {
        problems.push('attempts must be a whole number from 1, or null for unlimited attempts');
    }
    for (const [name, value] of [['start', start], ['end', end]] as const) {
        if (value !== null && !toDateTime(value, name)) problems.push(`${name} must be an ISO 8601 date-time such as 2026-11-05T07:00Z, or null`);
    }
    const startAt = toDateTime(start, 'start');
    const endAt = toDateTime(end, 'end');
    if (startAt && endAt && !isBefore(startAt, endAt)) problems.push('start must be before end');
    if (!ACCESS_VALUES.includes(access)) problems.push('access must be auto, open or locked');
    if (!BEST_VALUES.includes(best)) problems.push('best must be shortest or longest');
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
            const { attempts: _attempts, start: _start, end: _end, locked: _locked, access: _access, best: _best, ...rest } = parsed;
            others = rest;
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT' && !(error instanceof yaml.YAMLParseError)) throw error;
    }

    const lines = [
        '# Settings of this discipline, also edited from the race page (saving from the page does not keep comments)',
        '',
        '# Runs allowed per participant (invalid runs do not count). Unlimited when not set.',
        settings.attempts === null ? '#attempts: 3' : `attempts: ${settings.attempts}`,
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
        '# Which time is the best: shortest (a race) or longest (a slow race, the slowest participant wins)',
        `best: ${settings.best}`,
    ];
    if (Object.keys(others).length > 0) lines.push('', '# Other settings', yaml.stringify(others).trimEnd());
    await fs.promises.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}
