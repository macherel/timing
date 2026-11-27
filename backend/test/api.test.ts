import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
        expect(body.settings).toEqual({ measure: 'time', attempts: null, attemptsPerDistance: null, minDistance: null, allowDistanceChange: false, start: null, end: null, access: 'auto', best: 'shortest', precision: 'hundredth', rounding: 'up', recentRuns: 3, resultRows: 5, trigger: 'gates', triggerKey: 'Space', udaHeader: false, udaColumns: null, udaSeparator: ',', udaSort: 'bib' });
        expect((await call('GET', '/events/CFM26/nope/participants')).status).toBe(404);
    });
});

describe('creating events and disciplines', () => {
    it('creates an event, then a discipline in it with its settings file', async () => {
        expect(await call('POST', '/events', { name: ' UNICON22 ' })).toEqual({ status: 201, body: { event: 'UNICON22' } });
        expect((await call('GET', '/events')).body.events).toContainEqual({ name: 'UNICON22', disciplines: [] });

        expect(await call('POST', '/events/UNICON22/disciplines', { name: 'Slalom' })).toEqual({
            status: 201,
            body: { event: 'UNICON22', discipline: 'Slalom' },
        });
        expect((await call('GET', '/events')).body.events).toContainEqual({ name: 'UNICON22', disciplines: ['Slalom'] });
        expect(readFile('UNICON22/Slalom/config.yaml')).toContain('access: auto');
        expect((await call('GET', '/events/UNICON22/Slalom/participants')).body.participants).toEqual([]);
    });

    it('refuses a name that exists already, case ignored', async () => {
        expect(await call('POST', '/events', { name: 'cfm26' })).toEqual({ status: 409, body: { problems: ['The event CFM26 already exists.'] } });
        expect(await call('POST', '/events/CFM26/disciplines', { name: '100M' })).toEqual({
            status: 409,
            body: { problems: ['The discipline 100m already exists.'] },
        });
    });

    it('refuses names that are not valid folder names everywhere', async () => {
        for (const name of ['', '  ', 'a/b', '..', '.hidden', 'end.', 'what?', 'CON', 'nul.txt', 'x'.repeat(65)]) {
            expect((await call('POST', '/events', { name })).status, name).toBe(422);
        }
        // /api/<discipline>/race would be an API URL
        expect((await call('POST', '/events', { name: 'API' })).status).toBe(422);
        expect((await call('POST', '/events/CFM26/disciplines', { name: 'api' })).status).toBe(201);
        expect((await call('POST', '/events', {})).status).toBe(400);
    });

    it('gives a new discipline the UDA export format of the last discipline saved that measures a time', async () => {
        const columns = (value: string) => `udaColumns:\n  - title: T\n    value: "${value}"\n`;
        writeFiles({
            'CFM26/old/config.yaml': `udaHeader: true\n${columns('{bib}')}`,
            'CFM26/jump/config.yaml': `measure: distance\n${columns('{distance}')}`,
            'CFM26/last/config.yaml': `udaSeparator: ";"\nudaSort: "-rank"\n${columns('{rank}')}`,
        });
        const at = (relative: string, minutes: number) => {
            const time = new Date(Date.UTC(2026, 10, 5, 10, minutes));
            fs.utimesSync(path.join(workDir(), relative), time, time);
        };
        at('CFM26/old/config.yaml', 1);
        at('CFM26/last/config.yaml', 2);
        at('CFM26/jump/config.yaml', 3);

        const { formats } = (await call('GET', '/uda-formats')).body;
        expect(formats.map((format: any) => `${format.event}/${format.discipline}`).slice(0, 3)).toEqual(['CFM26/jump', 'CFM26/last', 'CFM26/old']);
        expect(formats[1]).toEqual({
            event: 'CFM26',
            discipline: 'last',
            measure: 'time',
            udaHeader: false,
            udaColumns: [{ title: 'T', value: '{rank}' }],
            udaSeparator: ';',
            udaSort: '-rank',
            updated: '2026-11-05T10:02:00.000Z',
        });

        expect((await call('POST', '/events/CFM26/disciplines', { name: 'new' })).status).toBe(201);
        expect((await call('GET', '/events/CFM26/new/settings')).body.settings).toMatchObject({
            measure: 'time',
            udaHeader: false,
            udaColumns: [{ title: 'T', value: '{rank}' }],
            udaSeparator: ';',
            udaSort: '-rank',
        });
    });

    it('needs an existing event for a discipline', async () => {
        expect(await call('POST', '/events/NOPE/disciplines', { name: 'Slalom' })).toEqual({ status: 404, body: { problems: ['Unknown event.'] } });
        expect(await call('POST', '/events/..%2F..%2Ftmp/disciplines', { name: 'x' })).toMatchObject({ status: 404 });
    });
});

describe('files of a discipline', () => {
    async function upload(file: string, content: string): Promise<{ status: number; body: any }> {
        const response = await fetch(`${base}/events/CFM26/100m/files/${encodeURIComponent(file)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/csv' },
            body: content,
        });
        return { status: response.status, body: await response.json() };
    }

    it('lists the participant files and the files the app writes', async () => {
        writeFiles({ 'CFM26/100m/CFM26-100m-results.csv': 'bib;name;start;finish;status;updated\n', 'CFM26/100m/notes.txt': 'x' });
        const { status, body } = await call('GET', '/events/CFM26/100m/files');
        expect(status).toBe(200);
        expect(body.files.map((file: any) => [file.name, file.kind])).toEqual([
            ['CFM26-100m-results.csv', 'results'],
            ['men.csv', 'participants'],
        ]);
        expect(body.files[1]).toMatchObject({ size: Buffer.byteLength('bib;name\n7;Hugo Guérin\n12;Léa Martin\n'), modified: expect.stringMatching(/^\d{4}-/) });
        expect((await call('GET', '/events/CFM26/nope/files')).status).toBe(404);
    });

    it('saves the first participant file as <event>-<discipline>-competitors.csv, then only replaces it', async () => {
        writeFiles({ 'CFM26/200m/config.yaml': 'access: auto\n' });
        const upload200 = (file: string, content: string) =>
            fetch(`${base}/events/CFM26/200m/files/${file}`, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: content }).then(
                async (response) => ({ status: response.status, body: await response.json() }),
            );
        expect(await upload200('export.csv', 'bib;name\n21;Ann Martin\n')).toEqual({ status: 201, body: { name: 'CFM26-200m-competitors.csv', created: true } });
        expect(readFile('CFM26/200m/CFM26-200m-competitors.csv')).toBe('bib;name\n21;Ann Martin\n');

        // Another file is refused, the file itself replaced
        expect(await upload200('other.csv', 'bib;name\n22;Bea Martin\n')).toEqual({
            status: 409,
            body: { problems: ['The discipline has its participant files already: replace one of them.'] },
        });
        expect(await upload200('CFM26-200m-competitors.csv', 'bib;name\n22;Bea Martin\n')).toEqual({
            status: 200,
            body: { name: 'CFM26-200m-competitors.csv', created: false },
        });
        expect((await call('GET', '/events/CFM26/200m/participants')).body.participants.map((p: any) => p.bib)).toEqual(['22']);
    });

    it('replaces one of several participant files, but adds none', async () => {
        writeFiles({ 'CFM26/100m/women.csv': 'bib;name\n21;Ann Martin\n' });
        expect((await upload('kids.csv', 'bib;name\n30;Zoé Petit\n')).status).toBe(409);

        // Another case: the file keeps its name
        expect(await upload('WOMEN.csv', 'bib;name\n22;Bea Martin\n')).toEqual({ status: 200, body: { name: 'women.csv', created: false } });
        expect(readFile('CFM26/100m/women.csv')).toBe('bib;name\n22;Bea Martin\n');
        expect((await call('GET', '/events/CFM26/100m/participants')).body.participants.map((p: any) => p.bib)).toEqual(['7', '12', '22']);
    });

    it('saves the results, then resets them, when the participants change', async () => {
        const run = '7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;PC;Line 1;2026-11-05T10:00:10Z';
        writeFiles({ 'CFM26/100m/CFM26-100m-results.csv': `bib;name;start;finish;status;computer;line;updated\n${run}\n` });

        expect((await upload('men.csv', 'bib;name\n8;Max Petit\n')).status).toBe(200);
        expect((await call('GET', '/events/CFM26/100m/results')).body.results).toEqual([]);
        expect((await call('GET', '/events/CFM26/100m/participants')).body.participants.map((p: any) => p.bib)).toEqual(['8']);
        expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBeNull();
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBeNull();

        // The backup, with the participants of before, is listed apart, the reset not at all
        const { files, backups } = (await call('GET', '/events/CFM26/100m/files')).body;
        expect(files.map((file: any) => file.name)).toEqual(['men.csv']);
        expect(backups).toEqual([
            {
                name: expect.stringMatching(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/),
                date: expect.stringMatching(/^\d{4}-/),
                files: expect.any(Array),
            },
        ]);
        // Each file suffixed by the date of the backup
        const date = backups[0].name;
        expect(backups[0].files.map((file: any) => [file.name, file.kind])).toEqual([
            [`CFM26-100m-results-${date}.csv`, 'results'],
            [`CFM26-100m-uda-results-${date}.csv`, 'uda'],
            [`CFM26-100m-men-${date}.csv`, 'participants'],
        ]);
        const backup = `${base}/events/CFM26/100m/backups/${date}`;
        expect(await (await fetch(`${backup}/CFM26-100m-results-${date}.csv`)).text()).toContain(run.replace(';OK;', ';;OK;'));
        expect(await (await fetch(`${backup}/CFM26-100m-men-${date}.csv`)).text()).toBe('bib;name\n7;Hugo Guérin\n12;Léa Martin\n');
        expect((await fetch(`${backup}/..%2F..%2Fconfig.yaml`)).status).toBe(404);
        expect((await fetch(`${base}/events/CFM26/100m/backups/nope/men.csv`)).status).toBe(404);
    });

    it('refuses what is not a participant file', async () => {
        expect(await upload('list.txt', 'x')).toEqual({ status: 422, body: { problems: ['A participant file must be a .csv file.'] } });
        expect((await upload('CFM26-100m-results.csv', 'x')).status).toBe(422);
        expect((await upload('config.yaml', 'x')).status).toBe(422);
        expect((await upload('a?.csv', 'x')).status).toBe(422);
        expect(await upload('empty.csv', '')).toEqual({ status: 400, body: { problems: ['The file is empty.'] } });
    });

    it('downloads a file of the discipline, and only those', async () => {
        const response = await fetch(`${base}/events/CFM26/100m/files/men.csv`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toContain('attachment; filename=men.csv');
        expect(await response.text()).toBe('bib;name\n7;Hugo Guérin\n12;Léa Martin\n');
        expect((await fetch(`${base}/events/CFM26/100m/files/..%2F..%2Fconfig.yaml`)).status).toBe(404);
        expect((await fetch(`${base}/events/CFM26/100m/files/nope.csv`)).status).toBe(404);
    });
});

describe('participants changed by hand', () => {
    const P = '/events/CFM26/100m/participants';
    const RESULTS = 'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:12Z;OK;2026-11-05T10:00:12Z\n';

    it('lists the participants as written in their files, with the name columns of each file', async () => {
        writeFiles({
            'CFM26/100m/uda.csv': 'ID,LastName,FirstName,Age Group\r\n21,MARTIN,jean-luc,Sénior M\r\n',
            'CFM26/100m/CFM26-100m-results.csv': RESULTS,
        });
        const { status, body } = await call('GET', `${P}/editable`);
        expect(status).toBe(200);
        expect(body.files).toEqual([
            { name: 'men.csv', nameFields: ['name'] },
            { name: 'uda.csv', nameFields: ['firstName', 'lastName'] },
        ]);
        expect(body.participants).toEqual([
            { bib: '7', name: 'Hugo Guérin', category: '', file: 'men.csv', fields: { name: 'Hugo Guérin', firstName: '', lastName: '' }, timed: true },
            { bib: '12', name: 'Léa Martin', category: '', file: 'men.csv', fields: { name: 'Léa Martin', firstName: '', lastName: '' }, timed: false },
            { bib: '21', name: 'Jean-Luc Martin', category: 'Sénior M', file: 'uda.csv', fields: { name: '', firstName: 'jean-luc', lastName: 'MARTIN' }, timed: false },
        ]);
        expect((await call('GET', '/events/CFM26/nope/participants/editable')).status).toBe(404);
    });

    it('adds, changes and removes a participant in its file, keeping the results', async () => {
        writeFiles({ 'CFM26/100m/CFM26-100m-results.csv': RESULTS });
        const added = await call('POST', P, { bib: '3', fields: { name: 'Emma; "Mimi" Petit' }, category: '' });
        expect(added.status).toBe(201);
        expect(added.body.participants.map((p: any) => p.bib)).toEqual(['3', '7', '12']);
        expect(readFile('CFM26/100m/men.csv')).toBe('bib;name\n7;Hugo Guérin\n12;Léa Martin\n3;"Emma; ""Mimi"" Petit"\n');

        expect((await call('PUT', `${P}/12`, { bib: '13', fields: { name: 'Léa Martin-Dupont' } })).status).toBe(200);
        expect((await call('DELETE', `${P}/3`)).status).toBe(200);
        expect(readFile('CFM26/100m/men.csv')).toBe('bib;name\n7;Hugo Guérin\n13;Léa Martin-Dupont\n');
        expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBe(RESULTS);
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toContain('7,');
    });

    it('keeps the bib of a participant with runs, who cannot be removed, but changes their name', async () => {
        writeFiles({ 'CFM26/100m/CFM26-100m-results.csv': RESULTS });
        expect(await call('PUT', `${P}/7`, { bib: '8', fields: { name: 'Hugo' } })).toEqual({ status: 409, body: { problems: ['Bib 7 has runs: it cannot change.'] } });
        expect(await call('DELETE', `${P}/7`)).toEqual({ status: 409, body: { problems: ['Bib 7 has runs: it cannot be removed.'] } });
        expect((await call('PUT', `${P}/7`, { bib: '7', fields: { name: 'Hugo Guérin-Roy' }, category: '' })).status).toBe(200);
        expect(readFile('CFM26/100m/men.csv')).toBe('bib;name\n7;Hugo Guérin-Roy\n12;Léa Martin\n');
    });

    it('keeps the bib of a participant ready on a line', async () => {
        expect((await call('POST', '/lines/Line%201/ready', { event: 'CFM26', discipline: '100m', bib: '12' })).status).toBe(200);
        expect((await call('DELETE', `${P}/12`)).status).toBe(409);
    });

    it('refuses a bib already used or not a number, a participant without name, and unknown ones', async () => {
        expect(await call('POST', P, { bib: '12', fields: { name: 'X' } })).toEqual({ status: 409, body: { problems: ['Bib 12 is already used.'] } });
        expect((await call('PUT', `${P}/7`, { bib: '12', fields: { name: 'X' } })).status).toBe(409);
        expect((await call('POST', P, { bib: 'A1', fields: { name: 'X' } })).status).toBe(422);
        expect(await call('POST', P, { bib: '30', fields: { name: ' ' } })).toEqual({ status: 422, body: { problems: ['The participant has no name.'] } });
        expect((await call('POST', P, { bib: '30', fields: { name: 'X' }, file: 'nope.csv' })).status).toBe(404);
        expect((await call('PUT', `${P}/99`, { bib: '99', fields: { name: 'X' } })).status).toBe(404);
        expect((await call('DELETE', `${P}/99`)).status).toBe(404);
        expect((await call('POST', P, { bib: '30', fields: 'X' })).status).toBe(400);
        expect(readFile('CFM26/100m/men.csv')).toBe('bib;name\n7;Hugo Guérin\n12;Léa Martin\n');
    });

    it('writes the first and last names of a UDA export, with its separator and line endings', async () => {
        writeFiles({ 'CFM26/100m/uda.csv': 'ID,LastName,FirstName,Country,Age Group\r\n21,MARTIN,jean-luc,France,Sénior M\r\n' });
        await call('POST', P, { bib: '22', fields: { firstName: 'Ann', lastName: 'Roy' }, category: 'Junior F', file: 'uda.csv' });
        await call('PUT', `${P}/21`, { bib: '21', fields: { firstName: 'Jean-Luc', lastName: 'MARTIN' }, category: 'Expert M' });
        expect(readFile('CFM26/100m/uda.csv')).toBe('ID,LastName,FirstName,Country,Age Group\r\n21,MARTIN,Jean-Luc,France,Expert M\r\n22,Roy,Ann,,Junior F\r\n');
    });

    it('adds a category column, and a header to a file without one', async () => {
        writeFiles({ 'CFM26/100m/men.csv': '7;Hugo Guérin;x\n' });
        await call('POST', P, { bib: '12', fields: { name: 'Léa Martin' }, category: 'Sénior F' });
        expect(readFile('CFM26/100m/men.csv')).toBe('Bib;Name;;Category\n7;Hugo Guérin;x\n12;Léa Martin;;Sénior F\n');
        expect((await call('GET', '/events/CFM26/100m/participants')).body.participants).toEqual([
            { bib: '7', name: 'Hugo Guérin', category: '' },
            { bib: '12', name: 'Léa Martin', category: 'Sénior F' },
        ]);
    });

    it('keeps a Windows-1252 file so, and makes it UTF-8 with a BOM for a character it cannot hold', async () => {
        writeFiles({ 'CFM26/100m/men.csv': Buffer.from('bib;name\r\n7;Éloïse Vernier\r\n', 'latin1') });
        await call('POST', P, { bib: '8', fields: { name: 'Zoé Œuvray' } });
        expect(fs.readFileSync(path.join(workDir(), 'CFM26/100m/men.csv'))).toEqual(Buffer.from('bib;name\r\n7;Éloïse Vernier\r\n8;Zoé \x8Cuvray\r\n', 'latin1'));
        await call('POST', P, { bib: '9', fields: { name: 'Ōta' } });
        expect(readFile('CFM26/100m/men.csv')).toBe('\uFEFFbib;name\r\n7;Éloïse Vernier\r\n8;Zoé Œuvray\r\n9;Ōta\r\n');
    });

    it('creates the competitors file of a discipline without participants', async () => {
        writeFiles({ 'CFM26/200m/config.yaml': 'access: auto\n' });
        expect((await call('POST', '/events/CFM26/200m/participants', { bib: '1', fields: { name: 'Ann' }, category: 'Open' })).status).toBe(201);
        expect(readFile('CFM26/200m/CFM26-200m-competitors.csv')).toBe('Bib;Name;Category\r\n1;Ann;Open\r\n');
    });
});

describe('discipline settings', () => {
    it('saves valid settings and returns them as read back from config.yaml', async () => {
        const settings = { attempts: 3, start: '2026-11-05T08:00+01:00', end: null, access: 'open' };
        const { status, body } = await call('PUT', '/events/CFM26/100m/settings', { settings });
        expect(status).toBe(200);
        // Stored in UTC
        expect(body.settings).toEqual({
            measure: 'time',
            attempts: 3,
            attemptsPerDistance: null,
            minDistance: null,
            allowDistanceChange: false,
            start: '2026-11-05T07:00Z',
            end: null,
            access: 'open',
            best: 'shortest',
            precision: 'hundredth',
            rounding: 'up',
            recentRuns: 3,
            resultRows: 5,
            trigger: 'gates',
            triggerKey: 'Space',
            udaHeader: false,
            udaColumns: null,
            udaSeparator: ',',
            udaSort: 'bib',
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
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('7,,0,10,3\r\n12,DNF,0,0,0\r\n');
        expect((await call('GET', '/events/CFM26/100m/results')).body.results[0].timeMs).toBe(10300);
    });

    it('rewrites the UDA export with its templates, and previews it with settings not saved', async () => {
        writeFiles({
            'CFM26/100m/CFM26-100m-results.csv': ['bib;name;start;finish;status;updated', '7;Hugo;2026-11-05T10:00:00Z;2026-11-05T10:01:10.25Z;OK;'].join('\n'),
        });
        const uda = {
            udaHeader: true,
            udaColumns: [
                { title: 'Bib', value: '{bib}', extra: 'dropped' },
                { title: 'Time', value: '{if status == "OK"}{minutes * 60 + seconds}.{pad(fraction, 2)}{else}{status}{end}' },
            ],
            udaSeparator: ';',
            udaSort: '-bib',
        };
        const preview = await call('POST', '/events/CFM26/100m/uda-preview', { settings: uda });
        expect(preview.status).toBe(200);
        expect(preview.body).toEqual({ text: 'Bib;Time\r\n12;DNS\r\n7;70.25\r\n', problems: [] });
        // Not saved by the preview
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBeNull();

        expect((await call('POST', '/events/CFM26/100m/uda-preview', { settings: { udaColumns: [{ title: '', value: '{bib}' }, { title: '', value: '{bib / 0}' }] } })).body).toEqual({
            text: '7,#ERROR\r\n12,#ERROR\r\n',
            problems: ['column 2, bib 7: division by 0 (character 6)', 'column 2, bib 12: division by 0 (character 6)'],
        });
        expect((await call('POST', '/events/CFM26/100m/uda-preview', { settings: { udaColumns: [{ title: '', value: '{nope}' }] } })).body).toEqual({
            text: '',
            problems: ['udaColumns column 1 value: unknown variable "nope" (character 2)'],
        });

        expect((await call('PUT', '/events/CFM26/100m/settings', { settings: uda })).status).toBe(200);
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('Bib;Time\r\n12;DNS\r\n7;70.25\r\n');
        expect(readFile('CFM26/100m/config.yaml')).not.toContain('extra');
        expect((await call('POST', '/events/CFM26/nope/uda-preview', { settings: {} })).status).toBe(404);
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
            { line: 'Line 1', enabled: true, ready: true, manual: false, run: { status: 'idle' }, lastResult: null },
            { line: 'Line 2', enabled: true, ready: true, manual: false, run: expect.objectContaining({ status: 'ready', participant: expect.objectContaining({ bib: '12' }) }), lastResult: null },
            // The line of the disciplines timed by hand
            { line: 'Manuel', enabled: true, ready: true, manual: true, run: { status: 'idle' }, lastResult: null },
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
            { line: 'Manuel', enabled: true, ready: true },
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

        expect((await call('POST', '/simulate/reset')).body.lines[0]).toEqual({ line: 'Line 1', enabled: true, ready: true, manual: false, run: { status: 'idle' }, lastResult: null });
        expect((await call('GET', '/live')).body.instances[0].lines[0]).toMatchObject({ run: { status: 'idle' }, lastResult: null });
    });
});

describe('a run timed by hand', () => {
    const press = (line = 'Manuel') => call('POST', `/lines/${encodeURIComponent(line)}/key`);
    const ready = (line: string) => call('POST', `/lines/${encodeURIComponent(line)}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' });

    beforeEach(() => writeFiles({ 'CFM26/100m/config.yaml': 'trigger: keyboard\n' }));

    it('is started by a key press on the manual line, and finished by the next one', async () => {
        // Nobody ready: nothing happens
        expect((await press()).body).toEqual({ status: 'idle' });
        expect((await ready('Manuel')).body.status).toBe('ready');
        expect((await press()).body.status).toBe('running');
        expect((await press()).body).toEqual({ status: 'idle' });

        const [result] = await waitForResults(1);
        expect(result).toMatchObject({ bib: '7', status: 'ok', line: 'Manuel' });
        expect(result.timeMs).toBeGreaterThanOrEqual(0);
    });

    it('only runs on the manual line, which only runs the disciplines timed by hand', async () => {
        const onGates = await ready('Line 1');
        expect(onGates.status).toBe(409);
        expect(onGates.body.problems[0]).toMatch(/timed by hand: its runs are on a manual line \("Manuel"\)/);

        writeFiles({ 'CFM26/100m/config.yaml': 'trigger: gates\n' });
        expect((await ready('Manuel')).status).toBe(409);
    });

    it('refuses a key press on another line, or an unknown one', async () => {
        expect((await press('Line 1')).status).toBe(409);
        expect((await press('Nope')).status).toBe(404);
        expect((await press('Manuel 1')).status).toBe(404);
        expect((await press('Manuel 10')).status).toBe(404);
    });

    it('runs several participants at once on the manual lines of the tabs, listed once used', async () => {
        const lineNames = async () => ((await call('GET', '/lines')).body.lines as { line: string }[]).map((line) => line.line);
        expect(await lineNames()).not.toContain('Manuel 2');
        expect((await ready('Manuel')).body.status).toBe('ready');
        const other = await call('POST', `/lines/${encodeURIComponent('Manuel 2')}/ready`, { event: 'CFM26', discipline: '100m', bib: '12' });
        expect(other.body.status).toBe('ready');
        expect((await lineNames()).slice(-2)).toEqual(['Manuel', 'Manuel 2']);
        // The same participant cannot be on two lines
        expect((await call('POST', `/lines/${encodeURIComponent('Manuel 3')}/ready`, { event: 'CFM26', discipline: '100m', bib: '7' })).status).toBe(409);

        expect((await press('Manuel')).body.status).toBe('running');
        expect((await press('Manuel 2')).body.status).toBe('running');
        expect((await press('Manuel 2')).body).toEqual({ status: 'idle' });
        expect((await press('Manuel')).body).toEqual({ status: 'idle' });
        const results = await waitForResults(2);
        expect(results.map((result) => [result.bib, result.line])).toEqual(expect.arrayContaining([['12', 'Manuel 2'], ['7', 'Manuel']]));
        // Still listed with its last result
        expect(await lineNames()).toContain('Manuel 2');
    });
});

describe('a distance', () => {
    const ready = (body: object) => call('POST', '/lines/Manuel/ready', { event: 'CFM26', discipline: '100m', bib: '7', ...body });

    beforeEach(() => writeFiles({ 'CFM26/100m/config.yaml': 'measure: distance\n' }));

    it('is typed when the participant gets ready on the manual line, then validated', async () => {
        expect((await ready({})).status).toBe(409);
        expect((await ready({ distance: '345' })).status).toBe(409);
        expect((await ready({ distance: 345 })).body).toMatchObject({ status: 'ready', distanceCm: 345 });
        // The key does not start it
        expect((await call('POST', '/lines/Manuel/key')).body).toMatchObject({ status: 'ready' });
        expect((await call('POST', '/lines/Manuel/validate')).body).toEqual({ status: 'idle' });
        expect((await call('POST', '/lines/Manuel/validate')).status).toBe(409);

        const [result] = await waitForResults(1);
        expect(result).toMatchObject({ bib: '7', status: 'ok', line: 'Manuel', distanceCm: 345, timeMs: null });
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
