import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('WorkDir');

/**
 * Directory holding the runtime files (config.yaml), chosen in this order:
 *   1. the --work-dir <dir> command line argument
 *   2. the TIMING_WORK_DIR environment variable
 *   3. the directory the process was started from
 * A relative path is resolved against the directory the process was started from.
 */
export const WORK_DIR = path.resolve(argValue('--work-dir') ?? process.env.TIMING_WORK_DIR ?? process.cwd());

/** Absolute path of a file in the working directory. */
export function workDirPath(fileName: string): string {
    return path.join(WORK_DIR, fileName);
}

/**
 * Logs the working directory in use, and an error when it is not a directory.
 * A missing directory is fine: saving from the config page creates it, and the files are picked up then.
 */
export function checkWorkDir(): void {
    log.info(`Using ${WORK_DIR}`);
    if (!fs.existsSync(WORK_DIR)) {
        log.info(`${WORK_DIR} does not exist yet. It will be created when the configuration is saved.`);
    } else if (!fs.statSync(WORK_DIR).isDirectory()) {
        log.error(`${WORK_DIR} is not a directory.`);
    }
}

/** The value following a command line option, e.g. argValue('--port') for "--port 8080". */
export function argValue(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}
