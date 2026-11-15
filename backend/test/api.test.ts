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
    await call('POST', '/simulate/reset');
    resetWorkDir();
    writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\n12;Léa Martin\n' });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

const cross = (action: string) => call('POST', '/simulate/crossing', { action });

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
        expect(body.settings).toEqual({ attempts: null, start: null, end: null, access: 'auto' });
        expect((await call('GET', '/events/CFM26/nope/participants')).status).toBe(404);
    });
});

describe('discipline settings', () => {
    it('saves valid settings and returns them as read back from config.yaml', async () => {
        const settings = { attempts: 3, start: '2026-11-05T08:00+01:00', end: null, access: 'open' };
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings });
        expect(status).toBe(200);
        // Stored in UTC
        expect(body.settings).toEqual({ attempts: 3, start: '2026-11-05T07:00Z', end: null, access: 'open' });
        expect(readFile('CFM26/100m/config.yaml')).toContain('start: 2026-11-05T07:00Z');
        expect((await call('GET', '/events/CFM26/100m/settings')).body.settings).toEqual(body.settings);
    });

    it('refuses invalid settings with 422', async () => {
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings: { attempts: 0 } });
        expect(status).toBe(422);
        expect(body.problems).toHaveLength(1);
    });
});

describe('a run with simulated gates', () => {
    it('is timed from the start to the finish crossing and saved', async () => {
        expect((await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '7' })).body.status).toBe('ready');
        expect((await cross('start_crossed')).body.status).toBe('running');
        expect((await cross('finish_crossed')).body).toEqual({ status: 'idle' });

        const results = await waitForResults(1);
        expect(results[0]).toMatchObject({ bib: '7', name: 'Hugo Guérin', status: 'ok' });
        expect(results[0].timeMs).toBeGreaterThanOrEqual(0);
    });

    it('can be disqualified while running, then its status edited', async () => {
        await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '12' });
        await cross('start_crossed');
        expect((await call('POST', '/run/disqualify')).body).toEqual({ status: 'idle' });
        const [result] = await waitForResults(1);
        expect(result).toMatchObject({ bib: '12', status: 'dq', timeMs: null });

        const edited = await call('PATCH', '/events/CFM26/100m/results', { bib: '12', start: result.start, status: 'invalid' });
        expect(edited).toMatchObject({ status: 200, body: { status: 'invalid' } });
        // A run ended before the finish has no time: it cannot become valid
        expect((await call('PATCH', '/events/CFM26/100m/results', { bib: '12', start: result.start, status: 'ok' })).status).toBe(409);
    });

    it('answers 409 to invalidate when no run is in progress, and 404 for an unknown participant', async () => {
        expect((await call('POST', '/run/invalidate')).status).toBe(409);
        expect((await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '99' })).status).toBe(404);
    });

    it('refuses a participant without attempts left with 409', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 1\n' });
        await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '7' });
        await cross('start_crossed');
        await cross('finish_crossed');
        await waitForResults(1);
        const { status, body } = await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '7' });
        expect(status).toBe(409);
        expect(body.problems[0]).toMatch(/used all 1 attempt/);
    });

    it('only accepts gate actions', async () => {
        expect((await cross('explode')).status).toBe(400);
    });

    it('starts over on reset: no run and no last result on the live page', async () => {
        await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '7' });
        await cross('start_crossed');
        await cross('finish_crossed');
        expect((await call('GET', '/live')).body.instances[0].lastResult).not.toBeNull();
        await call('POST', '/run/ready', { event: 'CFM26', discipline: '100m', bib: '12' });

        expect((await call('POST', '/simulate/reset')).body).toEqual({ status: 'idle' });
        expect((await call('GET', '/live')).body.instances[0]).toMatchObject({ run: { status: 'idle' }, lastResult: null });
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
        expect((await call('GET', '/config')).body.config).toEqual({ port: 8080, devices: [] });
        expect((await call('PUT', '/config', { config: { devices: [] }, modifiedAt: null })).status).toBe(409);
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
    throw new Error(`Expected ${count} result(s) in results.csv`);
}
