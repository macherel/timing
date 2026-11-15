import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Runs before each test file, before it imports the app: the app reads TIMING_WORK_DIR once, when it is imported
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timing-test-'));
process.env.TIMING_WORK_DIR = workDir;

afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));
