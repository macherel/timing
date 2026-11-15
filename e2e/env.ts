import os from 'node:os';
import path from 'node:path';

/** Port and working directory of the server the end-to-end tests run against (started by playwright.config.ts). */
export const PORT = 3990;
export const WORK_DIR = path.join(os.tmpdir(), 'timing-e2e');
