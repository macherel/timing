import fs from 'node:fs';
import path from 'node:path';

/** The working directory of the current test file (see setup.ts). */
export function workDir(): string {
    return process.env.TIMING_WORK_DIR!;
}

/** Empties the working directory, so each test starts from nothing. */
export function resetWorkDir(): void {
    for (const entry of fs.readdirSync(workDir())) {
        fs.rmSync(path.join(workDir(), entry), { recursive: true, force: true });
    }
}

/** Writes files in the working directory, e.g. { 'CFM26/100m/men.csv': 'bib;name\n1;Hugo' }, creating folders. */
export function writeFiles(files: Record<string, string | Buffer>): void {
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(workDir(), relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

/** A file of the working directory as text, or null when it does not exist. */
export function readFile(relative: string): string | null {
    try {
        return fs.readFileSync(path.join(workDir(), relative), 'utf8');
    } catch {
        return null;
    }
}

/** An instant relative to now, as ISO 8601 in UTC to the minute (as the discipline settings store them). */
export function minutesFromNow(minutes: number): string {
    return Temporal.Now.instant().add({ minutes }).toString({ smallestUnit: 'minute' });
}
