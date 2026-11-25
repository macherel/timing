import fs from 'fs';
import path from 'path';
import {
    competitorsFileName,
    csvSeparator,
    disciplineDir,
    participantCells,
    readParticipantFiles,
    type ParticipantColumns,
    type ParticipantFile,
} from './eventService.js';
import { getLineRuns, loadResults } from './runService.js';

/**
 * Participants changed by hand on the settings page of a discipline: added, changed or removed in their CSV file.
 * Each change rewrites the row in its own file, keeping the file's other columns, separator, line endings and
 * encoding. The results are kept: a participant with runs keeps their bib and cannot be removed.
 */

/** Name fields of a participant file: one name column, or first and/or last name columns. */
export type NameField = 'name' | 'firstName' | 'lastName';

/** A participant file, for the editor. */
export interface EditableFile {
    name: string;
    // The fields of its name, in this order
    nameFields: NameField[];
}

/** A participant as written in its file, for the editor. */
export interface EditableParticipant {
    bib: string;
    // As shown on the race page
    name: string;
    category: string;
    file: string;
    // The cells of the name fields of the file (the others are empty)
    fields: Record<NameField, string>;
    // The participant has runs, or is ready or running on a line: the bib cannot change, nor the participant be removed
    timed: boolean;
}

/** The new values of a participant: its bib, the name fields of its file, and its category. */
export interface ParticipantInput {
    bib: string;
    fields: Partial<Record<NameField, string>>;
    category: string;
}

/** A change that cannot be made: the HTTP status and why. */
export class ParticipantEditError extends Error {
    constructor(readonly status: 404 | 409 | 422, message: string) {
        super(message);
    }
}

const NAME_FIELDS: NameField[] = ['firstName', 'lastName', 'name'];
// Header names of the columns the app adds
const HEADERS = { bib: 'Bib', name: 'Name', category: 'Category' };

const nameFieldsOf = (columns: ParticipantColumns): NameField[] => NAME_FIELDS.filter((field) => columns[field] !== null);

/** The participant files of a discipline and their participants, for the editor. Null when the discipline does not exist. */
export async function loadEditableParticipants(
    event: string,
    discipline: string,
): Promise<{ files: EditableFile[]; participants: EditableParticipant[] } | null> {
    const dir = await disciplineDir(event, discipline);
    if (!dir) return null;
    const { files, entries } = await readParticipantFiles(dir);
    const timed = await timedBibs(event, discipline);
    const fileByName = new Map(files.map((file) => [file.name, file]));
    return {
        files: files.map((file) => ({ name: file.name, nameFields: nameFieldsOf(file.columns) })),
        participants: entries.map(({ bib, name, category, file, row }) => {
            const { columns, rows } = fileByName.get(file)!;
            const cell = (column: number | null) => (column === null ? '' : (rows[row][column] ?? '').trim());
            return {
                bib,
                name,
                category,
                file,
                fields: { name: cell(columns.name), firstName: cell(columns.firstName), lastName: cell(columns.lastName) },
                timed: timed.has(bib),
            };
        }),
    };
}

/** Bibs of the discipline with runs, or ready or running on a line of this computer. */
async function timedBibs(event: string, discipline: string): Promise<Set<string>> {
    const bibs = new Set((await loadResults(event, discipline))?.map((result) => result.bib));
    for (const { run } of getLineRuns()) {
        if (run.status !== 'idle' && run.event === event && run.discipline === discipline) bibs.add(run.participant.bib);
    }
    return bibs;
}

// Changes are made one at a time: each reads the files, then writes one
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(change: () => Promise<T>): Promise<T> {
    const next = queue.then(change);
    queue = next.catch(() => undefined);
    return next;
}

/**
 * Adds a participant to a participant file of the discipline (its first one when none is named). A discipline
 * without participant file gets <event>-<discipline>-competitors.csv, with a Bib;Name;Category header.
 */
export function addParticipant(event: string, discipline: string, input: ParticipantInput, fileName?: string): Promise<void> {
    return enqueue(async () => {
        const dir = await requireDir(event, discipline);
        const { files, entries } = await readParticipantFiles(dir);
        checkInput(input, entries.map((entry) => entry.bib));
        let file: ParticipantFile | undefined = fileName === undefined ? files[0] : files.find((candidate) => candidate.name === fileName);
        if (!file && fileName !== undefined) throw new ParticipantEditError(404, `${fileName} is not a participant file of the discipline.`);
        file ??= newFile(competitorsFileName(event, discipline));
        const row: string[] = [];
        file.rows.push(row);
        writeCells(file, row, input);
        await writeFile(dir, file);
    });
}

/** Changes the bib, name or category of a participant, in its file. A participant with runs keeps their bib. */
export function updateParticipant(event: string, discipline: string, bib: string, input: ParticipantInput): Promise<void> {
    return enqueue(async () => {
        const dir = await requireDir(event, discipline);
        const { files, entries } = await readParticipantFiles(dir);
        const entry = entries.find((candidate) => candidate.bib === bib);
        if (!entry) throw new ParticipantEditError(404, `No participant has bib ${bib}.`);
        checkInput(input, entries.filter((other) => other !== entry).map((other) => other.bib));
        if (input.bib !== bib && (await timedBibs(event, discipline)).has(bib)) {
            throw new ParticipantEditError(409, `Bib ${bib} has runs: it cannot change.`);
        }
        const file = files.find((candidate) => candidate.name === entry.file)!;
        writeCells(file, file.rows[entry.row], input);
        await writeFile(dir, file);
    });
}

/** Removes a participant from its file. A participant with runs cannot be removed. */
export function removeParticipant(event: string, discipline: string, bib: string): Promise<void> {
    return enqueue(async () => {
        const dir = await requireDir(event, discipline);
        const { files, entries } = await readParticipantFiles(dir);
        const entry = entries.find((candidate) => candidate.bib === bib);
        if (!entry) throw new ParticipantEditError(404, `No participant has bib ${bib}.`);
        if ((await timedBibs(event, discipline)).has(bib)) throw new ParticipantEditError(409, `Bib ${bib} has runs: it cannot be removed.`);
        const file = files.find((candidate) => candidate.name === entry.file)!;
        file.rows.splice(entry.row, 1);
        await writeFile(dir, file);
    });
}

async function requireDir(event: string, discipline: string): Promise<string> {
    const dir = await disciplineDir(event, discipline);
    if (!dir) throw new ParticipantEditError(404, 'Unknown event or discipline.');
    return dir;
}

function checkInput(input: ParticipantInput, otherBibs: string[]): void {
    if (!/^\d+$/.test(input.bib)) throw new ParticipantEditError(422, `The bib "${input.bib}" is not a number.`);
    if (otherBibs.includes(input.bib)) throw new ParticipantEditError(409, `Bib ${input.bib} is already used.`);
}

/** An empty participant file, with a Bib;Name;Category header. */
function newFile(name: string): ParticipantFile {
    const columns = { bib: 0, name: 1, firstName: null, lastName: null, category: 2 };
    const rows = [[HEADERS.bib, HEADERS.name, HEADERS.category]];
    return { name, utf8: true, bom: false, text: '', rows, columns, recognized: true, header: true };
}

/**
 * Writes the bib, name fields and category of a participant in their row. A file without category column gets one
 * for a category, named in its header: a file without recognised header gets one first (Bib, Name).
 */
function writeCells(file: ParticipantFile, row: string[], input: ParticipantInput): void {
    const { columns } = file;
    const set = (target: string[], column: number, value: string) => {
        while (target.length <= column) target.push('');
        target[column] = value;
    };
    const category = input.category.trim();
    if (columns.category === null && category !== '') {
        if (!file.recognized) {
            if (!file.header) {
                file.rows.unshift([]);
                file.header = true;
            }
            set(file.rows[0], columns.bib!, HEADERS.bib);
            set(file.rows[0], columns.name!, HEADERS.name);
            file.recognized = true;
        }
        columns.category = Math.max(...file.rows.map((cells) => cells.length));
        set(file.rows[0], columns.category, HEADERS.category);
    }
    set(row, columns.bib!, input.bib);
    for (const field of nameFieldsOf(columns)) set(row, columns[field]!, (input.fields[field] ?? '').trim());
    if (columns.category !== null) set(row, columns.category, category);
    if (participantCells(row, columns).name === '') throw new ParticipantEditError(422, 'The participant has no name.');
}

/**
 * Writes a participant file with its separator, line endings and encoding: Windows-1252 stays so when it can hold
 * every character, else the file becomes UTF-8 with a BOM (which Excel reads).
 */
async function writeFile(dir: string, file: ParticipantFile): Promise<void> {
    const separator = file.text === '' ? ';' : csvSeparator(file.text);
    const eol = file.text === '' || file.text.includes('\r\n') ? '\r\n' : '\n';
    const quote = (cell: string) => (cell.includes(separator) || /["\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
    const text = file.rows.map((row) => row.map(quote).join(separator)).join(eol) + eol;
    const legacy = file.utf8 ? null : encodeWindows1252(text);
    const content = legacy ?? Buffer.concat([file.bom || !file.utf8 ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
    const target = path.join(dir, file.name);
    const temporary = path.join(dir, `.${file.name}.tmp`);
    await fs.promises.writeFile(temporary, content);
    await fs.promises.rename(temporary, target);
}

// Characters of bytes 0x80-0x9F in Windows-1252 (the others are the same as their code)
const WINDOWS_1252 = new Map(
    [...new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index))].map((char, index) => [char, 0x80 + index]),
);

/** Text in Windows-1252, or null when a character has no byte there. */
function encodeWindows1252(text: string): Buffer | null {
    const bytes: number[] = [];
    for (const char of text) {
        const code = char.codePointAt(0)!;
        const byte = WINDOWS_1252.get(char) ?? (code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : null);
        if (byte === null) return null;
        bytes.push(byte);
    }
    return Buffer.from(bytes);
}
