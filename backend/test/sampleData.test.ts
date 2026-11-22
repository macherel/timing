import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDevicesConfig } from '../src/services/hardware/deviceConfig.js';
import { listEvents, loadParticipants } from '../src/services/eventService.js';
import { workDir } from './helpers.js';

/**
 * sample-data/ is copied into the data folder of the release packages: the app must read it without a problem.
 */
const SAMPLE_DATA = path.resolve(import.meta.dirname, '../../sample-data');

beforeAll(() => fs.cpSync(SAMPLE_DATA, workDir(), { recursive: true }));

describe('sample data of the release packages', () => {
    it('has a valid config.yaml, without a sync key', () => {
        const { config, problems } = parseDevicesConfig(fs.readFileSync(path.join(SAMPLE_DATA, 'config.yaml'), 'utf8'));
        expect(problems).toEqual([]);
        expect(config?.devices.length).toBeGreaterThan(0);
        // Several lines, to show how they are configured
        expect(config?.lines?.length).toBeGreaterThan(1);
        // A shared key would sync unrelated computers that installed the same release
        expect(config?.sync).toBeUndefined();
    });

    it('has events whose participant files and settings have no problem', async () => {
        const events = await listEvents();
        expect(events.length).toBeGreaterThan(0);
        for (const { name, disciplines } of events) {
            expect(disciplines.length, name).toBeGreaterThan(0);
            for (const discipline of disciplines) {
                const list = await loadParticipants(name, discipline);
                expect(list?.problems, `${name} / ${discipline}`).toEqual([]);
                expect(list?.participants.length, `${name} / ${discipline}`).toBeGreaterThan(0);
            }
        }
    });
});
