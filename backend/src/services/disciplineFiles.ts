import fs from 'fs';
import path from 'path';
import { BACKUP_DIR, backupFileName, competitorsFileName, folderNameProblem, resultsFileName, SETTINGS_FILE, udaResultsFileName, isResultsFileName } from './eventService.js';

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

/** A backup of the results of a discipline (see resetResults): a folder of its backup folder. */
export interface Backup {
    // Name of the folder: the date of the last change of the results saved, local YYYY-MM-DD_HH-MM-SS (a -2, -3...
    // suffix when two backups have the same)
    name: string;
    // That date, ISO 8601, or null when the name is not one
    date: string | null;
    // The results saved, their UDA export, and the participant files of that moment, each suffixed by the name of the
    // backup, the participant files prefixed by <event>-<discipline>- (e.g. CFM26-100m-men-2026-11-05_08-03-09.csv)
    files: DisciplineFile[];
}

/** The backups of a discipline folder, newest first. */
export async function listBackups(dir: string): Promise<Backup[]> {
    const event = path.basename(path.dirname(dir));
    const discipline = path.basename(dir);
    const backupDir = path.join(dir, BACKUP_DIR);
    const backups: Backup[] = [];
    for (const entry of await fs.promises.readdir(backupDir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const files: DisciplineFile[] = [];
        for (const file of await fs.promises.readdir(path.join(backupDir, entry.name), { withFileTypes: true })) {
            if (!file.isFile() || file.name.startsWith('.') || path.extname(file.name).toLowerCase() !== '.csv') continue;
            const stats = await fs.promises.stat(path.join(backupDir, entry.name, file.name));
            const kind = same(file.name, backupFileName(resultsFileName(event, discipline), entry.name))
                ? 'results'
                : same(file.name, backupFileName(udaResultsFileName(event, discipline), entry.name))
                  ? 'uda'
                  : 'participants';
            files.push({ name: file.name, kind, size: stats.size, modified: stats.mtime.toISOString() });
        }
        // The results first, their UDA export, then the participant files by name
        const rank = { results: 0, uda: 1, participants: 2, settings: 3 };
        files.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        backups.push({ name: entry.name, date: backupDate(entry.name), files });
    }
    return backups.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}

/** The date of a backup folder name (local time), as ISO 8601, or null when the name is not one. */
function backupDate(name: string): string | null {
    const match = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-\d+)?$/.exec(name);
    if (!match) return null;
    const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number);
    const date = new Date(year, month - 1, day, hours, minutes, seconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Path of a file of a backup of the discipline folder, or null when it is not one (checked against the listing). */
export async function backupFile(dir: string, backup: string, name: string): Promise<string | null> {
    const found = (await listBackups(dir)).find((b) => b.name === backup)?.files.some((file) => file.name === name);
    return found ? path.join(dir, BACKUP_DIR, backup, name) : null;
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

/** A participant file that cannot be written: the HTTP status and why. */
export class UploadError extends Error {
    constructor(readonly status: 409 | 422, message: string) {
        super(message);
    }
}

/**
 * Writes a participant file, as uploaded (its encoding is detected when it is read). A discipline gets one participant
 * file this way: the first one is saved as <event>-<discipline>-competitors.csv, whatever its name, then it can be replaced. A discipline
 * that already has several files keeps them, each can be replaced, but none is added. A name that differs only in case
 * from a file replaces it under its own name (a file removed here would come back from the synced computers). Returns
 * the name written, and whether the file is new. Throws an UploadError when it cannot be written.
 */
export async function writeParticipantFile(
    dir: string,
    name: string,
    content: Buffer,
    // Called once the file can be written, before it is (e.g. to save the results with the participants they belong to)
    beforeWrite: () => Promise<void> = async () => {},
): Promise<{ name: string; created: boolean }> {
    const event = path.basename(path.dirname(dir));
    const discipline = path.basename(dir);
    const problem = participantFileProblem(event, discipline, name);
    if (problem) throw new UploadError(422, problem);
    const participantFiles = (await listDisciplineFiles(dir)).filter((file) => file.kind === 'participants');
    const existing = participantFiles.find((file) => same(file.name, name));
    if (!existing && participantFiles.length > 0) {
        throw new UploadError(409, 'The discipline has its participant files already: replace one of them.');
    }
    const written = existing?.name ?? competitorsFileName(event, discipline);
    await beforeWrite();
    const file = path.join(dir, written);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, content);
    await fs.promises.rename(temporary, file);
    return { name: written, created: !existing };
}
