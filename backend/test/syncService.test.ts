import { beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, isFolderName, syncedFilePath } from '../src/services/syncService.js';
import { resetWorkDir, workDir, writeFiles } from './helpers.js';

describe('names received from peers', () => {
    it('only allows event files: <event>/<discipline>/<file> with a synced extension', () => {
        expect(syncedFilePath('CFM26/100m/men.csv')).toBe(`${workDir()}/CFM26/100m/men.csv`);
        expect(syncedFilePath('CFM26/100m/config.yaml')).toBe(`${workDir()}/CFM26/100m/config.yaml`);
        for (const path of [
            'config.yaml',
            'CFM26/men.csv',
            'CFM26/100m/results.csv',
            'CFM26/100m/notes.txt',
            'CFM26/100m/.hidden.csv',
            '../100m/men.csv',
            'CFM26/../men.csv',
            'CFM26/100m/sub/men.csv',
            'CFM26/100m\\x/men.csv',
            42,
        ]) {
            expect(syncedFilePath(path), String(path)).toBeNull();
        }
    });

    it('only allows plain folder names', () => {
        expect(isFolderName('CFM26')).toBe(true);
        for (const name of ['', '.', '..', '.git', 'a/b', 'a\\b', 'C:', null]) expect(isFolderName(name), String(name)).toBe(false);
    });
});

describe('buildManifest', () => {
    beforeEach(resetWorkDir);

    it('lists the event files with their hash, and a digest of each results.csv', async () => {
        writeFiles({
            'config.yaml': 'devices: []',
            'CFM26/100m/men.csv': '1;Hugo',
            'CFM26/100m/notes.txt': 'not synced',
            'CFM26/100m/results.csv': 'bib;name;start;finish;status;updated\n',
        });
        const manifest = await buildManifest();
        expect(manifest.files.map((f) => f.path)).toEqual(['CFM26/100m/men.csv']);
        expect(manifest.files[0].hash).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.results).toEqual([{ event: 'CFM26', discipline: '100m', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    });

    it('gives the same results digest whatever the order of the lines', async () => {
        const lines = ['7;A;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;x', '8;B;2026-11-05T10:01:00Z;2026-11-05T10:01:10Z;OK;y'];
        writeFiles({ 'E/D1/results.csv': `bib;name;start;finish;status;updated\n${lines.join('\n')}\n` });
        writeFiles({ 'E/D2/results.csv': `bib;name;start;finish;status;updated\n${[...lines].reverse().join('\n')}\n` });
        const [first, second] = (await buildManifest()).results;
        expect(first.digest).toBe(second.digest);
    });
});
