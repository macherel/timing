import fs from 'fs';
import path from 'path';
import { errorMessage } from '../utils/logger.js';
import { WORK_DIR } from '../utils/workDir.js';

/**
 * Events, disciplines and participants, read from the working directory:
 *
 *   <work dir>/<event>/<discipline>/<any name>.csv
 *
 * Each CSV file lists participants as "bib;name" (comma, semicolon or tab separated, optional header row,
 * extra columns ignored). A discipline can have several files, e.g. one per category: they are merged.
 * Files are read on every request, so edits are picked up without restarting.
 * results.csv in a discipline folder holds the timed runs (see runService.ts), it is not a participant file.
 */

export const RESULTS_FILE = 'results.csv';

export interface EventSummary {
    name: string;
    disciplines: string[];
}

export interface Participant {
    bib: string;
    name: string;
    file: string; // CSV file name without extension, e.g. the category
}

export interface ParticipantList {
    participants: Participant[];
    problems: string[]; // Rows that were skipped, and why
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
    if (!dir) return null;

    const files = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.csv')
        .filter((entry) => entry.name.toLowerCase() !== RESULTS_FILE)
        .map((entry) => entry.name)
        .sort(byName);

    const participants: Participant[] = [];
    const problems: string[] = [];
    const fileOfBib = new Map<string, string>();

    for (const fileName of files) {
        let rows: string[][];
        try {
            rows = parseCsv(decode(await fs.promises.readFile(path.join(dir, fileName))));
        } catch (error) {
            problems.push(`${fileName}: cannot be read (${errorMessage(error)})`);
            continue;
        }

        rows.forEach((row, index) => {
            const [bib = '', name = ''] = row.map((cell) => cell.trim());
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
                participants.push({ bib, name, file: path.parse(fileName).name });
            }
        });
    }

    participants.sort((a, b) => Number(a.bib) - Number(b.bib));
    return { participants, problems };
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
