import fs from 'fs';
import path from 'path';
import { folderNameProblem, resultsFileName, SETTINGS_FILE, udaResultsFileName, isResultsFileName } from './eventService.js';

/**
 * The files of a discipline folder, for its settings page: the participant lists (any other CSV file), which can be
 * uploaded or replaced, and the files the app writes (results, UDA export, settings), which can be downloaded.
 */

export type FileKind = 'participants' | 'results' | 'uda' | 'settings';

export interface DisciplineFile {
    name: string;
    kind: FileKind;
    size: number;
    // Last change, ISO 8601
    modified: string;
}

// Upload size limit of a participant file
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function kindOf(event: string, discipline: string, name: string): FileKind | null {
    if (same(name, resultsFileName(event, discipline))) return 'results';
    if (same(name, udaResultsFileName(event, discipline))) return 'uda';
    if (same(name, SETTINGS_FILE)) return 'settings';
    // Results files of earlier versions, renamed when the discipline is read
    if (isResultsFileName(event, discipline, name)) return null;
    return path.extname(name).toLowerCase() === '.csv' ? 'participants' : null;
}

/** The files of a discipline folder (<work dir>/<event>/<discipline>), sorted by name; other files are left out. */
export async function listDisciplineFiles(dir: string): Promise<DisciplineFile[]> {
    const event = path.basename(path.dirname(dir));
    const discipline = path.basename(dir);
    const files: DisciplineFile[] = [];
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const kind = entry.isFile() && !entry.name.startsWith('.') ? kindOf(event, discipline, entry.name) : null;
        if (!kind) continue;
        const stats = await fs.promises.stat(path.join(dir, entry.name));
        files.push({ name: entry.name, kind, size: stats.size, modified: stats.mtime.toISOString() });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Path of a file of the discipline folder, or null when it is not one of its listed files. The name is checked
 * against the listing, so a request cannot reach other files.
 */
export async function disciplineFile(dir: string, name: string): Promise<string | null> {
    const files = await listDisciplineFiles(dir);
    return files.some((file) => file.name === name) ? path.join(dir, name) : null;
}

/** Why a name cannot be a participant file of the discipline, or null when it can. */
export function participantFileProblem(event: string, discipline: string, name: string): string | null {
    const problem = folderNameProblem(name, 'file');
    if (problem) return problem;
    if (path.extname(name).toLowerCase() !== '.csv') return 'A participant file must be a .csv file.';
    if (kindOf(event, discipline, name) !== 'participants') return `${name} is written by the app, not a participant file.`;
    return null;
}

// Name of the participant file sent to a discipline that has none
export const PARTICIPANTS_FILE = 'participants.csv';

/** A participant file that cannot be written: the HTTP status and why. */
export class UploadError extends Error {
    constructor(readonly status: 409 | 422, message: string) {
        super(message);
    }
}

/**
 * Writes a participant file, as uploaded (its encoding is detected when it is read). A discipline gets one participant
 * file this way: the first one is saved as participants.csv, whatever its name, then it can be replaced. A discipline
 * that already has several files keeps them, each can be replaced, but none is added. A name that differs only in case
 * from a file replaces it under its own name (a file removed here would come back from the synced computers). Returns
 * the name written, and whether the file is new. Throws an UploadError when it cannot be written.
 */
export async function writeParticipantFile(dir: string, name: string, content: Buffer): Promise<{ name: string; created: boolean }> {
    const event = path.basename(path.dirname(dir));
    const discipline = path.basename(dir);
    const problem = participantFileProblem(event, discipline, name);
    if (problem) throw new UploadError(422, problem);
    const participantFiles = (await listDisciplineFiles(dir)).filter((file) => file.kind === 'participants');
    const existing = participantFiles.find((file) => same(file.name, name));
    if (!existing && participantFiles.length > 0) {
        throw new UploadError(409, 'The discipline has its participant files already: replace one of them.');
    }
    const written = existing?.name ?? PARTICIPANTS_FILE;
    const file = path.join(dir, written);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, content);
    await fs.promises.rename(temporary, file);
    return { name: written, created: !existing };
}
