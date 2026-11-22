import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, resetWorkDir, workDir, writeFiles } from './helpers.js';

/**
 * The HTTP API, called over HTTP on a random port, with simulated gates for the crossings.
 */
let server: Server;
let base: string;

beforeAll(async () => {
    // Read when the routes are imported
    process.env.TIMING_SIMULATE_GATES = '1';
    const { default: apiRouter } = await import('../src/routes/api.js');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
    server.close();
    delete process.env.TIMING_SIMULATE_GATES;
});

beforeEach(async () => {
    resetWorkDir();
    writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\n12;Léa Martin\n' });
    // Reads config.yaml again: none, so the simulated lines
    await call('POST', '/simulate/reset');
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

const cross = (gate: string, line?: string) => call('POST', '/simulate/crossing', { gate, line });

describe('events and participants', () => {
    it('lists the events with the working directory', async () => {
        expect(await call('GET', '/events')).toEqual({
            status: 200,
            body: { workDir: workDir(), events: [{ name: 'CFM26', disciplines: ['100m'] }] },
        });
    });

    it('gives the participants with the settings, and 404 for an unknown discipline', async () => {
        const { status, body } = await call('GET', '/events/CFM26/100m/participants');
        expect(status).toBe(200);
        expect(body.participants.map((p: any) => p.bib)).toEqual(['7', '12']);
        expect(body.settings).toEqual({ attempts: null, start: null, end: null, access: 'auto', best: 'shortest', precision: 'hundredth', rounding: 'up', recentRuns: 3 });
        expect((await call('GET', '/events/CFM26/nope/participants')).status).toBe(404);
    });
});

describe('discipline settings', () => {
    it('saves valid settings and returns them as read back from config.yaml', async () => {
        const settings = { attempts: 3, start: '2026-11-05T08:00+01:00', end: null, access: 'open' };
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings });
        expect(status).toBe(200);
        // Stored in UTC
        expect(body.settings).toEqual({
            attempts: 3,
            start: '2026-11-05T07:00Z',
            end: null,
            access: 'open',
            best: 'shortest',
            precision: 'hundredth',
            rounding: 'up',
            recentRuns: 3,
        });
        expect(readFile('CFM26/100m/config.yaml')).toContain('start: 2026-11-05T07:00Z');
        expect((await call('GET', '/events/CFM26/100m/settings')).body.settings).toEqual(body.settings);
    });

    it('rewrites the UDA export when the best time becomes the longest', async () => {
        writeFiles({
            'CFM26/100m/CFM26-100m-results.csv': [
                'bib;name;start;finish;status;updated',
                '7;Hugo;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;',
                '7;Hugo;2026-11-05T10:01:00Z;2026-11-05T10:01:20Z;OK;',
            ].join('\n'),
        });
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings: { best: 'longest' } });
        expect(status).toBe(200);
        expect(body.settings.best).toBe('longest');
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('7,,0,20,0\r\n12,DNF,0,0,0\r\n');
    });

    it('rewrites the UDA export and gives the results with the new precision and rounding', async () => {
        writeFiles({
            'CFM26/100m/CFM26-100m-results.csv': ['bib;name;start;finish;status;updated', '7;Hugo;2026-11-05T10:00:00Z;2026-11-05T10:00:10.341Z;OK;'].join('\n'),
        });
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings: { precision: 'tenth', rounding: 'truncate' } });
        expect(status).toBe(200);
        expect(body.settings).toMatchObject({ precision: 'tenth', rounding: 'truncate' });
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('7,,0,10,30\r\n12,DNF,0,0,0\r\n');
        expect((await call('GET', '/events/CFM26/100m/results')).body.results[0].timeMs).toBe(10300);
    });

    it('refuses invalid settings with 422', async () => {
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings: { attempts: 0 } });
        expect(status).toBe(422);
        expect(body.problems).toHaveLength(1);
    });
});

describe('a run with simulated gates', () => {
    const LINE = '/lines/Line%201';

    it('is timed from the start to the finish crossing and saved', async () => {
        expect((await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' })).body.status).toBe('ready');
        expect((await cross('start')).body.status).toBe('running');
        expect((await cross('finish')).body).toEqual({ status: 'idle' });

        const results = await waitForResults(1);
        expect(results[0]).toMatchObject({ bib: '7', name: 'Hugo Guérin', status: 'ok' });
        expect(results[0].timeMs).toBeGreaterThanOrEqual(0);
    });

    it('lists the simulated lines when config.yaml has none, with their runs', async () => {
        await call('POST', '/lines/Line%202/ready', { event: 'CFM26', discipline: '100m', bib: '12' });
        expect((await call('GET', '/lines')).body.lines).toEqual([
            { line: 'Line 1', enabled: true, ready: true, run: { status: 'idle' }, lastResult: null },
            { line: 'Line 2', enabled: true, ready: true, run: expect.objectContaining({ status: 'ready', participant: expect.objectContaining({ bib: '12' }) }), lastResult: null },
        ]);
        // The gates of another line do not start it
        expect((await cross('start', 'Line 1')).body).toEqual({ status: 'idle' });
        expect((await cross('start', 'Line 2')).body.status).toBe('running');
    });

    it('uses the lines of config.yaml once it has some (read again on reset)', async () => {
        writeFiles({
            'config.yaml': [
                'lines:',
                '  - { name: "North", enabled: true, start: { device: "G", byteIndex: 0, mask: 1, value: 1 }, finish: { device: "G", byteIndex: 0, mask: 2, value: 2 } }',
                '  - { name: "Off", enabled: false, start: { device: "G", byteIndex: 0, mask: 1, value: 1 }, finish: { device: "G", byteIndex: 0, mask: 2, value: 2 } }',
                'devices: [{ name: "G", vendorId: 1, productId: 1 }]',
            ].join('\n'),
        });
        // The disabled line is listed, but cannot be used
        expect((await call('POST', '/simulate/reset')).body.lines.map(({ line, enabled, ready }: any) => ({ line, enabled, ready }))).toEqual([
            { line: 'North', enabled: true, ready: true },
            { line: 'Off', enabled: false, ready: false },
        ]);
        expect((await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' })).status).toBe(404);
        expect((await call('POST', '/lines/Off/ready', { event: 'CFM26', discipline: '100m', bib: '7' })).status).toBe(409);
        expect((await call('POST', '/lines/North/ready', { event: 'CFM26', discipline: '100m', bib: '7' })).body.status).toBe('ready');
    });

    it('can be disqualified while running, then its status edited', async () => {
        await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '12' });
        await cross('start');
        expect((await call('POST', `${LINE}/disqualify`)).body).toEqual({ status: 'idle' });
        const [result] = await waitForResults(1);
        expect(result).toMatchObject({ bib: '12', status: 'dq', timeMs: null });

        const edited = await call('PATCH', '/events/CFM26/100m/results', { bib: '12', start: result.start, status: 'invalid' });
        expect(edited).toMatchObject({ status: 200, body: { status: 'invalid' } });
        // A run ended before the finish has no time: it cannot become valid
        expect((await call('PATCH', '/events/CFM26/100m/results', { bib: '12', start: result.start, status: 'ok' })).status).toBe(409);
    });

    it('answers 409 to invalidate when no run is in progress, and 404 for an unknown participant or line', async () => {
        expect((await call('POST', `${LINE}/invalidate`)).status).toBe(409);
        expect((await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '99' })).status).toBe(404);
        expect((await call('POST', '/lines/Nope/cancel')).status).toBe(404);
    });

    it('refuses a participant without attempts left with 409', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 1\n' });
        await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' });
        await cross('start');
        await cross('finish');
        await waitForResults(1);
        const { status, body } = await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' });
        expect(status).toBe(409);
        expect(body.problems[0]).toMatch(/used all 1 attempt/);
    });

    it('only accepts the start and finish gates of a line', async () => {
        expect((await cross('explode')).status).toBe(400);
        expect((await cross('start', 'Nope')).status).toBe(404);
    });

    it('starts over on reset: no run and no last result on the live page', async () => {
        await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' });
        await cross('start');
        await cross('finish');
        expect((await call('GET', '/live')).body.instances[0].lines[0].lastResult).not.toBeNull();
        await call('POST', `${LINE}/ready`, { event: 'CFM26', discipline: '100m', bib: '12' });

        expect((await call('POST', '/simulate/reset')).body.lines[0]).toEqual({ line: 'Line 1', enabled: true, ready: true, run: { status: 'idle' }, lastResult: null });
        expect((await call('GET', '/live')).body.instances[0].lines[0]).toMatchObject({ run: { status: 'idle' }, lastResult: null });
    });
});

describe('device configuration', () => {
    it('validates a config without saving it', async () => {
        expect((await call('POST', '/config/validate', { config: { devices: [] } })).body).toEqual({ problems: [] });
        expect((await call('POST', '/config/validate', { config: { port: 0, devices: [] } })).body.problems).toHaveLength(1);
    });

    it('saves a new config.yaml, then refuses a save based on an outdated version', async () => {
        const created = await call('PUT', '/config', { config: { port: 8080, devices: [] }, modifiedAt: null });
        expect(created.status).toBe(200);
        expect(readFile('config.yaml')).toContain('port: 8080');
        expect((await call('GET', '/config')).body.config).toEqual({ port: 8080, lines: [], devices: [] });
        expect((await call('PUT', '/config', { config: { devices: [] }, modifiedAt: null })).status).toBe(409);
    });
});

describe('administration lock', () => {
    it('is unlocked without password', async () => {
        expect((await call('GET', '/admin/lock')).body).toEqual({ protected: false, unlocked: true });
        expect((await call('POST', '/admin/unlock', { password: 'x' })).status).toBe(401);
    });

    it('unlocks with the token of the right password, until the password changes', async () => {
        writeFiles({ 'config.yaml': 'adminPassword: secret\ndevices: []\n' });
        expect((await call('GET', '/admin/lock')).body).toEqual({ protected: true, unlocked: false });
        expect((await call('POST', '/admin/unlock', { password: 'wrong' })).status).toBe(401);

        const { status, body } = await call('POST', '/admin/unlock', { password: 'secret' });
        expect(status).toBe(200);
        expect((await call('GET', `/admin/lock?token=${body.token}`)).body).toEqual({ protected: true, unlocked: true });
        expect((await call('GET', '/admin/lock?token=other')).body.unlocked).toBe(false);

        writeFiles({ 'config.yaml': 'adminPassword: changed\ndevices: []\n' });
        expect((await call('GET', `/admin/lock?token=${body.token}`)).body.unlocked).toBe(false);
    });

    it('saves the password in config.yaml', async () => {
        await call('PUT', '/config', { config: { adminPassword: 'p@ss "x"', devices: [] }, modifiedAt: null });
        expect((await call('GET', '/config')).body.config.adminPassword).toBe('p@ss "x"');
        expect((await call('POST', '/config/validate', { config: { adminPassword: '', devices: [] } })).body.problems).toHaveLength(1);
    });
});

describe('sync routes', () => {
    it('refuses requests without the sync key', async () => {
        expect((await call('GET', '/sync/manifest')).status).toBe(403);
    });
});

async function waitForResults(count: number): Promise<any[]> {
    for (let i = 0; i < 50; i++) {
        const { body } = await call('GET', '/events/CFM26/100m/results');
        if (body.results.length >= count) return body.results;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Expected ${count} result(s) in the results file`);
}
