import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Precision, type Rounding } from '../src/services/eventService.js';
import type { ResultRow } from '../src/services/runService.js';
import { minutesFromNow, readFile, resetWorkDir, workDir, writeFiles } from './helpers.js';

type RunService = typeof import('../src/services/runService.js');

const HUGO = { bib: '7', name: 'Hugo Guérin', category: '' };
const LEA = { bib: '12', name: 'Léa Martin', category: '' };
const RESULTS = 'CFM26/100m/CFM26-100m-results.csv';
const HEADER = 'bib;name;start;finish;distance;status;computer;line;updated';

let runs: RunService;

// The run state lives in the module: each test imports a fresh one
beforeEach(async () => {
    resetWorkDir();
    writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\n', 'CFM26/100m/women.csv': '12;Léa Martin\n' });
    vi.resetModules();
    runs = await import('../src/services/runService.js');
    (await import('../src/services/lines.js')).setConfiguredLines([LINE, OTHER_LINE].map(asLine));
});

const LINE = 'Line 1';
const OTHER_LINE = 'Line 2';
// A line whose start and finish are on the same device
const asLine = (name: string) => ({ name, enabled: true, start: 'Receiver', finish: 'Receiver' });
const lastResult = (line = LINE) => runs.getLineRuns().find((l) => l.line === line)?.lastResult;

const at = (iso: string) => Temporal.Instant.from(iso);

/** Runs a participant from ready to finish, then waits until the result is in the results file. */
async function timeRun(participant = HUGO, start = '2026-11-05T10:00:00Z', finish = '2026-11-05T10:00:12.345Z') {
    expect(await runs.prepareRun(LINE, 'CFM26', '100m', participant)).toBeNull();
    const before = (await runs.loadResults('CFM26', '100m'))!.length;
    runs.onCrossing(LINE, 'start', 'Start gate', at(start));
    runs.onCrossing(LINE, 'finish', 'Finish gate', at(finish));
    await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!.length).toBe(before + 1));
}

describe('a timed run', () => {
    it('goes from idle to ready, running, and back to idle with the result saved', async () => {
        expect(runs.getRunState(LINE)!).toEqual({ status: 'idle' });

        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        expect(runs.getRunState(LINE)!).toMatchObject({ status: 'ready', event: 'CFM26', discipline: '100m', participant: HUGO });

        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.getRunState(LINE)!).toMatchObject({ status: 'running', startedAt: '2026-11-05T10:00:00Z' });

        runs.onCrossing(LINE, 'finish', 'Finish gate', at('2026-11-05T10:00:12.345Z'));
        expect(runs.getRunState(LINE)!).toEqual({ status: 'idle' });
        // Rounded up to the hundredth by default
        expect(lastResult()?.result).toMatchObject({ bib: '7', timeMs: 12350, status: 'ok' });

        await vi.waitFor(async () =>
            expect(await runs.loadResults('CFM26', '100m')).toEqual([
                {
                    bib: '7',
                    name: 'Hugo Guérin',
                    start: '2026-11-05T10:00:00Z',
                    finish: '2026-11-05T10:00:12.345Z',
                    timeMs: 12350,
                    distanceCm: null,
                    status: 'ok',
                    computer: os.hostname(),
                    line: LINE,
                },
            ]),
        );
        const [header, line] = readFile(RESULTS)!.trim().split('\n');
        expect(header).toBe(HEADER);
        // The time is not stored: it is finish - start
        expect(line).toBe(`7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:12.345Z;;OK;${os.hostname()};${LINE};${line.split(';').at(-1)}`);
        expect(line.split(';').at(-1)).toMatch(/^\d{4}-.+Z$/);
    });

    it('records the sync name of config.yaml as the computer of the run when sync is on', async () => {
        (await import('../src/utils/computerName.js')).setSyncName('Finish PC');
        await timeRun();
        expect((await runs.loadResults('CFM26', '100m'))![0]).toMatchObject({ computer: 'Finish PC', line: LINE });
    });

    it('ignores a finish before the start, and a start when nobody is ready', async () => {
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.getRunState(LINE)!).toEqual({ status: 'idle' });

        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'finish', 'Finish gate', at('2026-11-05T10:00:01Z'));
        expect(runs.getRunState(LINE)!.status).toBe('ready');
    });

    it('keeps the first start: a second start crossing does not restart the clock', async () => {
        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:05Z'));
        expect(runs.getRunState(LINE)!).toMatchObject({ startedAt: '2026-11-05T10:00:00Z' });
    });

    it('can be cancelled, saving nothing', async () => {
        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        runs.cancelRun(LINE);
        expect(runs.getRunState(LINE)!).toEqual({ status: 'idle' });
        expect(readFile(RESULTS)).toBeNull();
    });

    it('can be ended as invalid or disqualified, without a time', async () => {
        expect(runs.voidRun(LINE, 'dq')).toBe('No run in progress on Line 1.');

        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.voidRun(LINE, 'dq')).toBeNull();

        await runs.prepareRun(LINE, 'CFM26', '100m', LEA);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:01:00Z'));
        expect(runs.voidRun(LINE, 'invalid')).toBeNull();

        await vi.waitFor(async () =>
            expect((await runs.loadResults('CFM26', '100m'))!.map((r) => [r.bib, r.status, r.timeMs, r.finish])).toEqual([
                ['7', 'dq', null, null],
                ['12', 'invalid', null, null],
            ]),
        );
    });

    it('cannot get another participant ready while a run is in progress', async () => {
        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', LEA)).toBe('A run is in progress on Line 1. Cancel it first.');
    });

    it('cannot start in an unknown discipline', async () => {
        expect(await runs.prepareRun(LINE, 'CFM26', 'nope', HUGO)).toBe('Unknown event or discipline.');
    });
});

describe('several lines', () => {
    it('time their runs independently: each line only follows its own gates', async () => {
        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        await runs.prepareRun(OTHER_LINE, 'CFM26', '100m', LEA);
        runs.onCrossing(LINE, 'start', 'Start 1', at('2026-11-05T10:00:00Z'));
        expect(runs.getRunState(LINE)!.status).toBe('running');
        expect(runs.getRunState(OTHER_LINE)!.status).toBe('ready');

        runs.onCrossing(OTHER_LINE, 'start', 'Start 2', at('2026-11-05T10:00:01Z'));
        runs.onCrossing(OTHER_LINE, 'finish', 'Finish 2', at('2026-11-05T10:00:11Z'));
        expect(runs.getRunState(LINE)!.status).toBe('running');
        expect(lastResult(OTHER_LINE)?.result).toMatchObject({ bib: '12', timeMs: 10000 });
        expect(lastResult(LINE)).toBeNull();

        runs.onCrossing(LINE, 'finish', 'Finish 1', at('2026-11-05T10:00:12Z'));
        expect(lastResult(LINE)?.result).toMatchObject({ bib: '7', timeMs: 12000 });
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!.map((r) => r.bib).sort()).toEqual(['12', '7']));
    });

    it('do not let a participant be ready on two lines at once', async () => {
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toBeNull();
        expect(await runs.prepareRun(OTHER_LINE, 'CFM26', '100m', HUGO)).toBe('7 Hugo Guérin is already ready on Line 1.');
    });

    it('refuse an unknown line', async () => {
        expect(await runs.prepareRun('Line 9', 'CFM26', '100m', HUGO)).toBe('Unknown line "Line 9".');
        expect(runs.getRunState('Line 9')).toBeNull();
        expect(runs.cancelRun('Line 9')).toBe('Unknown line "Line 9".');
    });

    it('drop the run of a line removed from the configuration', async () => {
        await runs.prepareRun(OTHER_LINE, 'CFM26', '100m', LEA);
        (await import('../src/services/lines.js')).setConfiguredLines([LINE].map(asLine));
        expect(runs.getLineRuns()[0]).toEqual({ line: LINE, enabled: true, ready: false, manual: false, run: { status: 'idle' }, lastResult: null });
        expect(runs.getLineRuns().map((l) => l.line)).toEqual([LINE, 'Manuel']);
        expect(runs.isAnyRunActive()).toBe(false);
    });
});

describe('attempts and access', () => {
    it('refuses a participant who used all their attempts, invalid runs not counted', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 2\n' });
        await timeRun(HUGO, '2026-11-05T10:00:00Z');

        // An invalid run is not the participant's fault: it does not use an attempt
        await runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:01:00Z'));
        runs.voidRun(LINE, 'invalid');
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!).toHaveLength(2));

        await timeRun(HUGO, '2026-11-05T10:02:00Z', '2026-11-05T10:02:10Z');
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toBe('7 Hugo Guérin has used all 2 attempt(s).');
        // Other participants still have theirs
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', LEA)).toBeNull();
    });

    it('refuses runs when the discipline is locked or outside its period', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'access: locked\n' });
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toBe('CFM26 / 100m is closed: its results are locked.');

        writeFiles({ 'CFM26/100m/config.yaml': `end: ${minutesFromNow(-5)}\n` });
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toMatch(/^CFM26 \/ 100m is closed: it closed on /);

        writeFiles({ 'CFM26/100m/config.yaml': `end: ${minutesFromNow(-5)}\naccess: open\n` });
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toBeNull();
    });
});

describe('runTimeMs', () => {
    const time = (finish: string, precision: Precision, rounding: Rounding) =>
        runs.runTimeMs('2026-11-05T10:00:00Z', finish, { precision, rounding });

    it('brings the exact time to the unit of the precision', () => {
        const finish = '2026-11-05T10:00:12.3456789Z';
        expect(time(finish, 'second', 'truncate')).toBe(12000);
        expect(time(finish, 'tenth', 'truncate')).toBe(12300);
        expect(time(finish, 'hundredth', 'truncate')).toBe(12340);
        expect(time(finish, 'thousandth', 'truncate')).toBe(12345);
        expect(time(finish, 'thousandth', 'nearest')).toBe(12346);
        expect(time(finish, 'hundredth', 'nearest')).toBe(12350);
        expect(time(finish, 'tenth', 'nearest')).toBe(12300);
        expect(time(finish, 'second', 'nearest')).toBe(12000);
    });

    it('rounds up any part of the unit, and a half to the nearest goes up', () => {
        expect(time('2026-11-05T10:00:12.340000001Z', 'hundredth', 'up')).toBe(12350);
        expect(time('2026-11-05T10:00:12.34Z', 'hundredth', 'up')).toBe(12340);
        expect(time('2026-11-05T10:00:12.5Z', 'second', 'nearest')).toBe(13000);
        expect(time('2026-11-05T10:00:12.4999Z', 'second', 'nearest')).toBe(12000);
    });

    it('is null without a readable finish', () => {
        expect(time('', 'hundredth', 'up')).toBeNull();
        expect(time('soon', 'hundredth', 'up')).toBeNull();
    });

    it('gives the time of a run with the settings of its discipline', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'precision: tenth\nrounding: truncate\n' });
        await timeRun(HUGO, '2026-11-05T10:00:00Z', '2026-11-05T10:00:12.399Z');
        expect(lastResult()?.result.timeMs).toBe(12300);
        expect((await runs.loadResults('CFM26', '100m'))![0].timeMs).toBe(12300);
        // The saved run keeps its exact finish: another precision gives another time
        writeFiles({ 'CFM26/100m/config.yaml': 'precision: thousandth\n' });
        expect((await runs.loadResults('CFM26', '100m'))![0].timeMs).toBe(12399);
    });
});

describe('setResultStatus', () => {
    beforeEach(() => timeRun(HUGO, '2026-11-05T10:00:00Z', '2026-11-05T10:00:12.345Z'));

    it('changes the status of the run with this bib and start, and keeps the others', async () => {
        await timeRun(LEA, '2026-11-05T10:00:00Z', '2026-11-05T10:00:15Z');

        const outcome = await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'dq');
        expect(outcome).toEqual({ result: expect.objectContaining({ bib: '7', status: 'dq', timeMs: 12350 }) });
        expect((await runs.loadResults('CFM26', '100m'))!.map((r) => `${r.bib} ${r.status}`)).toEqual(['7 dq', '12 ok']);
        // The live pages show the last run with its new status
        expect(lastResult()?.result.bib).toBe('12');

        await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'ok');
        expect((await runs.loadResults('CFM26', '100m'))![0].status).toBe('ok');
    });

    it('updates the last result shown on the live page', async () => {
        await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'invalid');
        expect(lastResult()?.result.status).toBe('invalid');
    });

    it('answers 404 for an unknown run, and 409 for a run without time set to OK', async () => {
        expect(await runs.setResultStatus('CFM26', '100m', '7', '2026-01-01T00:00:00Z', 'dq')).toEqual({
            status: 404,
            problem: 'This result is not in the results file any more.',
        });

        await runs.prepareRun(LINE, 'CFM26', '100m', LEA);
        runs.onCrossing(LINE, 'start', 'Start gate', at('2026-11-05T10:05:00Z'));
        runs.voidRun(LINE, 'dq');
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!).toHaveLength(2));
        expect(await runs.setResultStatus('CFM26', '100m', '12', '2026-11-05T10:05:00Z', 'ok')).toMatchObject({ status: 409 });
    });

    it('answers 409 when the discipline is closed', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'access: locked\n' });
        expect(await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'dq')).toMatchObject({ status: 409 });
    });
});

describe('results file', () => {
    it('reads older layouts by column name: a time column, no status, computer, line or updated', async () => {
        writeFiles({ [RESULTS]: 'bib;name;start;finish;time\n7;Hugo;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;10.000\n' });
        expect(await runs.loadResults('CFM26', '100m')).toEqual([
            { bib: '7', name: 'Hugo', start: '2026-11-05T10:00:00Z', finish: '2026-11-05T10:00:10Z', timeMs: 10000, distanceCm: null, status: 'ok', computer: null, line: null },
        ]);
    });

    it('leaves out valid lines without a readable time', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Hugo;2026-11-05T10:00:00Z;;;OK;;;\n12;Léa;2026-11-05T10:01:00Z;;;DQ;;;\n` });
        expect((await runs.loadResults('CFM26', '100m'))!.map((r) => r.bib)).toEqual(['12']);
    });

    it('quotes names that contain the separator', async () => {
        writeFiles({ 'CFM26/100m/men.csv': '7;"Dupont; Jean"\n' });
        await timeRun({ bib: '7', name: 'Dupont; Jean', category: '' });
        expect(readFile(RESULTS)).toContain('7;"Dupont; Jean";');
        expect((await runs.loadResults('CFM26', '100m'))![0].name).toBe('Dupont; Jean');
    });
});

describe('UDA export', () => {
    const line = (bib: string, start: string, seconds: number | null, status: string) => {
        const finish = seconds === null ? '' : Temporal.Instant.from(start).add({ milliseconds: Math.round(seconds * 1000) }).toString();
        return `${bib};Runner ${bib};${start};${finish};;${status};`;
    };

    it('holds the best run of each participant in the UDA import format, DNF without a valid run', async () => {
        writeFiles({
            [RESULTS]: [
                HEADER,
                line('98', '2026-11-05T10:00:00Z', 73.239, 'OK'),
                line('7', '2026-11-05T10:01:00Z', 29.928, 'OK'),
                line('7', '2026-11-05T10:02:00Z', 25.5, 'INVALID'),
                line('7', '2026-11-05T10:03:00Z', 31, 'OK'),
                line('23', '2026-11-05T10:04:00Z', null, 'DQ'),
                line('12', '2026-11-05T10:05:00Z', 20, 'DQ'),
                line('12', '2026-11-05T10:06:00Z', 24.11, 'OK'),
                line('40', '2026-11-05T10:07:00Z', null, 'INVALID'),
            ].join('\n'),
        });
        const rows = (await runs.readResultRows('CFM26', '100m'))!;
        expect(runs.udaResults(rows, ['7', '12', '23', '40', '41', '98'])).toBe(
            '7,,0,29,93\r\n12,,0,24,11\r\n23,DQ,0,0,0\r\n40,DNF,0,0,0\r\n41,DNF,0,0,0\r\n98,,1,13,24\r\n'
        );
    });

    it('keeps the longest time for a slow race', () => {
        const rows = [
            { bib: '7', name: 'X', start: '2026-11-05T10:00:00Z', finish: '2026-11-05T10:00:30Z', distance: '', status: 'OK', computer: '', line: '', updated: '' },
            { bib: '7', name: 'X', start: '2026-11-05T10:01:00Z', finish: '2026-11-05T10:01:45.5Z', distance: '', status: 'OK', computer: '', line: '', updated: '' },
            { bib: '7', name: 'X', start: '2026-11-05T10:02:00Z', finish: '2026-11-05T10:03:50Z', distance: '', status: 'DQ', computer: '', line: '', updated: '' },
        ];
        expect(runs.udaResults(rows, ['7'], { ...DEFAULT_SETTINGS, best: 'longest' })).toBe('7,,0,45,50\r\n');
        expect(runs.udaResults(rows, ['7'])).toBe('7,,0,30,0\r\n');
    });

    it('keeps the best run among the first attempts allowed only, invalid runs not counted', () => {
        const run = (start: string, seconds: string, status: string): ResultRow => ({
            bib: '7', name: 'X', start, finish: start.replace(':00Z', `:${seconds}Z`), distance: '', status, computer: '', line: '', updated: '',
        });
        // The run at 10:01 was invalid when the participant ran the other two, then made valid: it is the third attempt
        const rows = [run('2026-11-05T10:00:00Z', '30', 'OK'), run('2026-11-05T10:01:00Z', '20', 'OK'), run('2026-11-05T10:02:00Z', '25', 'DQ'), run('2026-11-05T10:03:00Z', '28', 'OK')];
        expect(runs.udaResults(rows, ['7'], { ...DEFAULT_SETTINGS, attempts: 2 })).toBe('7,,0,20,0\r\n');
        expect(runs.udaResults(rows, ['7'], { ...DEFAULT_SETTINGS, attempts: 1 })).toBe('7,,0,30,0\r\n');
        expect(runs.udaResults(rows, ['7'])).toBe('7,,0,20,0\r\n');
        const later = [run('2026-11-05T10:00:00Z', '30', 'OK'), run('2026-11-05T10:01:00Z', '25', 'DQ'), run('2026-11-05T10:02:00Z', '20', 'INVALID'), run('2026-11-05T10:03:00Z', '28', 'OK')];
        expect(runs.udaResults(later, ['7'], { ...DEFAULT_SETTINGS, attempts: 2 })).toBe('7,,0,30,0\r\n');
    });

    it('lists bibs with runs that are not in the participant list', async () => {
        const rows = [{ bib: '5', name: 'X', start: '2026-11-05T10:00:00Z', finish: '', distance: '', status: 'INVALID', computer: '', line: '', updated: '' }];
        expect(runs.udaResults(rows, ['7'])).toBe('5,DNF,0,0,0\r\n7,DNF,0,0,0\r\n');
    });

    it('is written with the results file', async () => {
        await timeRun(HUGO);
        await vi.waitFor(() => expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('7,,0,12,35\r\n12,DNF,0,0,0\r\n'));
    });

    it('uses the precision and rounding of the discipline, the fraction of a second in its unit', () => {
        const rows = [{ bib: '7', name: 'X', start: '2026-11-05T10:00:00Z', finish: '2026-11-05T10:00:12.3449Z', distance: '', status: 'OK', computer: '', line: '', updated: '' }];
        const uda = (precision: Precision, rounding: Rounding) => runs.udaResults(rows, ['7'], { measure: 'time', best: 'shortest', precision, rounding });
        expect(uda('second', 'up')).toBe('7,,0,13,0\r\n');
        expect(uda('tenth', 'nearest')).toBe('7,,0,12,3\r\n');
        expect(uda('hundredth', 'truncate')).toBe('7,,0,12,34\r\n');
        expect(uda('thousandth', 'truncate')).toBe('7,,0,12,344\r\n');
        expect(uda('thousandth', 'nearest')).toBe('7,,0,12,345\r\n');
        expect(uda('thousandth', 'up')).toBe('7,,0,12,345\r\n');
    });

    it('numbers the runs of a participant: all, OK, attempts, and the run of the best result', () => {
        const row = (bib: string, minute: number, seconds: number | null, status: string): ResultRow => ({
            bib, name: 'X', start: `2026-11-05T10:0${minute}:00Z`, finish: seconds === null ? '' : `2026-11-05T10:0${minute}:${seconds}Z`,
            distance: '', status, computer: '', line: '', updated: '',
        });
        // Written out of order: numbered by start
        const rows = [row('7', 4, 19, 'OK'), row('7', 1, null, 'INVALID'), row('7', 2, 23, 'OK'), row('7', 3, 30, 'DQ'), row('12', 1, 40, 'DQ')];
        const settings = { ...DEFAULT_SETTINGS, udaColumns: ['bib', 'runs', 'okRuns', 'attempts', 'bestRun', 'bestAttempt'].map((name) => ({ title: '', value: `{${name}}` })) };
        expect(runs.udaResults(rows, ['7', '12', '21'], settings)).toBe('7,4,2,3,4,3\r\n12,1,0,1,,\r\n21,0,0,0,,\r\n');
    });

    it('writes the lines with the templates of the discipline: statuses, ranks, order, header and separator', () => {
        const row = (bib: string, seconds: number | null, status: string): ResultRow => ({
            bib, name: 'X', start: '2026-11-05T10:00:00Z', finish: seconds === null ? '' : `2026-11-05T10:00:${String(seconds).padStart(2, '0')}Z`,
            distance: '', status, computer: '', line: '', updated: '',
        });
        const rows = [row('1', 20, 'OK'), row('2', 15, 'OK'), row('3', 20, 'OK'), row('4', 30, 'DQ'), row('5', null, 'INVALID'), row('6', 25, 'OK')];
        const person = (bib: string, category: string, lastName = '') => ({ bib, name: `P${bib}`, category, firstName: '', lastName, columns: { Country: `C${bib}` } });
        const participants = [person('1', 'A', 'Roy'), person('2', 'B'), person('3', 'A'), person('4', 'A'), person('5', 'B'), person('6', 'B'), person('7', 'A')];
        const settings = {
            ...DEFAULT_SETTINGS,
            udaHeader: true,
            udaColumns: [
                { title: '{event}', value: '{bib}' },
                { title: '{discipline}', value: '{status}' },
                { title: '{count}', value: '{rank}' },
                { title: '', value: '{categoryRank}' },
                { title: '', value: '{category}' },
                { title: '', value: '{lower(col("country"))}' },
                { title: '', value: '{lastName}' },
            ],
            udaSeparator: ';',
            udaSort: 'category, rank',
        };
        const problems: string[] = [];
        expect(runs.udaResults(rows, participants, settings, { event: 'E', discipline: 'D' }, problems)).toBe(
            ['E;D;7;;;;', '1;OK;2;1;A;c1;Roy', '3;OK;2;1;A;c3;', '4;DQ;;;A;c4;', '7;DNS;;;A;c7;', '2;OK;1;1;B;c2;', '6;OK;4;2;B;c6;', '5;DNF;;;B;c5;', ''].join('\r\n')
        );
        expect(problems).toEqual([]);
        // Without header line, the titles are not written
        expect(runs.udaResults(rows, participants, { ...settings, udaHeader: false }, { event: 'E', discipline: 'D' }).split('\r\n')[0]).toBe('1;OK;2;1;A;c1;Roy');
        // The UDA format writes DNS as DNF
        expect(runs.udaResults([], ['7'])).toBe('7,DNF,0,0,0\r\n');
        // A value holding the separator is quoted
        expect(runs.udaResults([], [{ ...person('7', 'A'), name: 'Roy, "Al"' }], { ...DEFAULT_SETTINGS, udaColumns: [{ title: '', value: '{bib}' }, { title: '', value: '{name}' }] })).toBe('7,"Roy, ""Al"""\r\n');
    });
});

describe('a distance', () => {
    const MANUAL = 'Manuel';
    const JUMP = 'CFM26/jump';
    const JUMP_RESULTS = `${JUMP}/CFM26-jump-results.csv`;

    beforeEach(() => writeFiles({ [`${JUMP}/men.csv`]: 'bib;name\n7;Hugo Guérin\n12;Léa Martin\n', [`${JUMP}/config.yaml`]: 'measure: distance\n' }));

    /** Gets a participant ready with a distance, then ends the run with a status and waits for its result. */
    async function measure(participant: typeof HUGO, distance: number, end: (line: string) => string | null) {
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', participant, distance)).toBeNull();
        const before = (await runs.loadResults('CFM26', 'jump'))!.length;
        expect(end(MANUAL)).toBeNull();
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', 'jump'))!.length).toBe(before + 1));
    }

    it('is typed when the participant gets ready, then validated, and saved with its distance', async () => {
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 345)).toBeNull();
        expect(runs.getRunState(MANUAL)).toMatchObject({ status: 'ready', participant: HUGO, distanceCm: 345 });
        // No crossing starts it: the operator says whether it is valid
        runs.onCrossing(MANUAL, 'start', 'Keyboard', Temporal.Now.instant());
        expect(runs.getRunState(MANUAL)).toMatchObject({ status: 'ready', distanceCm: 345 });

        expect(runs.validateRun(MANUAL)).toBeNull();
        expect(runs.getRunState(MANUAL)).toEqual({ status: 'idle' });
        expect(lastResult(MANUAL)?.result).toMatchObject({ bib: '7', distanceCm: 345, timeMs: null, status: 'ok' });
        await vi.waitFor(async () =>
            expect(await runs.loadResults('CFM26', 'jump')).toEqual([
                expect.objectContaining({ bib: '7', distanceCm: 345, timeMs: null, status: 'ok', computer: os.hostname(), line: MANUAL }),
            ]),
        );
        const [header, line] = readFile(JUMP_RESULTS)!.trim().split('\n');
        expect(header).toBe(HEADER);
        expect(line.split(';')[4]).toBe('345');
    });

    it('keeps its distance when invalidated or disqualified, so it can be made valid later', async () => {
        await measure(HUGO, 410, (line) => runs.voidRun(line, 'dq'));
        const [result] = (await runs.loadResults('CFM26', 'jump'))!;
        expect(result).toMatchObject({ distanceCm: 410, status: 'dq' });
        expect(await runs.setResultStatus('CFM26', 'jump', '7', result.start, 'ok')).toMatchObject({ result: { distanceCm: 410, status: 'ok' } });
    });

    it('refuses a missing distance, one out of range or more precise than the unit, and a line other than the manual one', async () => {
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO)).toMatch(/distance/);
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 0)).toMatch(/above 0/);
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 34.5)).toMatch(/whole number of centimetres/);
        expect(await runs.prepareRun(LINE, 'CFM26', 'jump', HUGO, 345)).toMatch(/measures a distance/);
        expect(runs.getRunState(MANUAL)).toEqual({ status: 'idle' });
        expect(runs.validateRun(MANUAL)).toMatch(/No distance/);
    });

    it('refuses a distance below the minimum distance', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nminDistance: 300\n' });
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 299)).toBe('The distance must be at least 300 cm.');
        expect(runs.getRunState(MANUAL)).toEqual({ status: 'idle' });
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 300)).toBeNull();
    });

    it('eliminates a participant who used all the attempts allowed at one distance without validating it', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nattemptsPerDistance: 2\n' });
        // Validated at the last attempt: goes on to another distance
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'dq'));
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'invalid'));
        await measure(HUGO, 345, runs.validateRun);
        await measure(HUGO, 360, (line) => runs.voidRun(line, 'dq'));
        await measure(HUGO, 360, (line) => runs.voidRun(line, 'dq'));
        // Two failed attempts at 360 cm (invalid runs not counted): no more run, at any distance
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 400)).toBe('7 Hugo Guérin is eliminated: 2 attempt(s) at 360 cm.');
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', LEA, 345)).toBeNull();
    });

    it('eliminates a participant who fails again a distance they validated, without a total of attempts', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nattemptsPerDistance: 3\n' });
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'dq'));
        await measure(HUGO, 345, runs.validateRun);
        // The validation resets the count: three failures at 345 cm since
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'dq'));
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'invalid'));
        // Held at 345 cm, failed again after its validation
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360)).toBe('7 Hugo Guérin must validate 345 cm before changing distance.');
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'dq'));
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'dq'));
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 345)).toBe('7 Hugo Guérin is eliminated: 3 attempt(s) at 345 cm.');
    });

    it('keeps a participant at the distance they started until it is validated, invalid runs not starting one', async () => {
        await measure(HUGO, 345, (line) => runs.voidRun(line, 'invalid'));
        await measure(HUGO, 350, (line) => runs.voidRun(line, 'dq'));
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360)).toBe('7 Hugo Guérin must validate 350 cm before changing distance.');
        // Others are not held
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', LEA, 360)).toBeNull();
        expect(runs.cancelRun(MANUAL)).toBeNull();
        await measure(HUGO, 350, runs.validateRun);
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360)).toBeNull();
    });

    it('lets the operator unlock the distance started, exceptionally, but not the elimination', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nattemptsPerDistance: 2\n' });
        await measure(HUGO, 350, (line) => runs.voidRun(line, 'dq'));
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360)).toMatch(/must validate 350 cm/);
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360, true)).toBeNull();
        expect(runs.voidRun(MANUAL, 'dq')).toBeNull();
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', 'jump'))!.length).toBe(2));
        // Held at 360 cm now
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 350)).toMatch(/must validate 360 cm/);
        await measure(HUGO, 360, (line) => runs.voidRun(line, 'dq'));
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 400, true)).toMatch(/eliminated/);
    });

    it('lets a participant change distance before validating when the settings allow it', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nallowDistanceChange: true\n' });
        await measure(HUGO, 350, (line) => runs.voidRun(line, 'dq'));
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 360)).toBeNull();
    });

    it('applies the total of attempts too', async () => {
        writeFiles({ [`${JUMP}/config.yaml`]: 'measure: distance\nattempts: 2\nattemptsPerDistance: 3\n' });
        await measure(HUGO, 345, runs.validateRun);
        await measure(HUGO, 360, runs.validateRun);
        expect(await runs.prepareRun(MANUAL, 'CFM26', 'jump', HUGO, 380)).toMatch(/used all 2 attempt/);
    });

    it('ranks the longest valid distance first in the UDA export, in centimetres', async () => {
        await measure(HUGO, 345, runs.validateRun);
        await measure(HUGO, 520, (line) => runs.voidRun(line, 'invalid'));
        await measure(HUGO, 390, runs.validateRun);
        await measure(LEA, 250, (line) => runs.voidRun(line, 'dq'));
        await vi.waitFor(() => expect(readFile(`${JUMP}/CFM26-jump-uda-results.csv`)).toBe('7,,390\r\n12,DQ,0\r\n'));

        // Whatever the precision of the times
        const rows = (await runs.readResultRows('CFM26', 'jump'))!;
        const uda = runs.udaResults(rows, ['7', '40'], { ...DEFAULT_SETTINGS, measure: 'distance', precision: 'second' });
        expect(uda).toBe('7,,390\r\n12,DQ,0\r\n40,DNF,0\r\n');
    });
});

describe('mergeResultRows (sync)', () => {
    const row = (bib: string, start: string, status: string, updated: string): ResultRow => ({
        bib,
        name: `Runner ${bib}`,
        start,
        finish: start.replace(':00Z', ':10Z'),
        distance: '',
        status,
        computer: 'PC',
        line: 'Line 1',
        updated,
    });

    it('adds the lines it does not have, oldest run first', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Runner 7;2026-11-05T10:05:00Z;2026-11-05T10:05:10Z;;OK;PC;Line 1;2026-11-05T10:05:10Z\n` });
        const changed = await runs.mergeResultRows('CFM26', '100m', [row('12', '2026-11-05T10:00:00Z', 'OK', '2026-11-05T10:00:10Z')]);
        expect(changed).toBe(true);
        expect((await runs.readResultRows('CFM26', '100m'))!.map((r) => r.bib)).toEqual(['12', '7']);
    });

    it('keeps the most recently changed version of a line', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Runner 7;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;;OK;PC;Line 1;2026-11-05T10:30:00Z\n` });

        const older = row('7', '2026-11-05T10:00:00Z', 'DQ', '2026-11-05T10:20:00Z');
        expect(await runs.mergeResultRows('CFM26', '100m', [older])).toBe(false);
        expect((await runs.readResultRows('CFM26', '100m'))![0].status).toBe('OK');

        const newer = row('7', '2026-11-05T10:00:00Z', 'DQ', '2026-11-05T10:40:00Z');
        expect(await runs.mergeResultRows('CFM26', '100m', [newer])).toBe(true);
        expect((await runs.readResultRows('CFM26', '100m'))![0].status).toBe('DQ');
    });

    it('takes the lines of a computer of an older version, without the distance column', async () => {
        const { distance: _distance, ...older } = row('12', '2026-11-05T10:00:00Z', 'OK', '2026-11-05T10:00:10Z');
        expect(await runs.mergeResultRows('CFM26', '100m', [older as ResultRow])).toBe(true);
        expect(readFile(RESULTS)).toContain('12;Runner 12;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;;OK;');
    });

    it('does nothing for an unknown discipline', async () => {
        expect(await runs.mergeResultRows('nope', 'nope', [row('7', '2026-11-05T10:00:00Z', 'OK', '')])).toBe(false);
    });
});

describe('results reset', () => {
    const OLD = '7;Runner 7;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;;OK;PC;Line 1;2026-11-05T10:00:10Z';
    const BACKUP = 'CFM26/100m/backup/2026-11-05_08-03-09';
    const backups = () => fs.readdirSync(path.join(workDir(), 'CFM26/100m/backup')).sort();

    /** The results file with these lines, last changed on 2026-11-05 at 08:03:09 local time. */
    function writeResults(...lines: string[]) {
        writeFiles({ [RESULTS]: `${HEADER}\n${lines.map((line) => `${line}\n`).join('')}` });
        const modified = new Date(2026, 10, 5, 8, 3, 9);
        fs.utimesSync(path.join(workDir(), RESULTS), modified, modified);
    }

    it('saves the results, their UDA export and participants, dated by the last change of the results, then removes them', async () => {
        writeResults(OLD);
        await runs.resetResults('CFM26', '100m');
        // Each file suffixed by the date of the backup, the participant files prefixed as the results files
        expect(fs.readdirSync(path.join(workDir(), BACKUP)).sort()).toEqual([
            'CFM26-100m-men-2026-11-05_08-03-09.csv',
            'CFM26-100m-results-2026-11-05_08-03-09.csv',
            'CFM26-100m-uda-results-2026-11-05_08-03-09.csv',
            'CFM26-100m-women-2026-11-05_08-03-09.csv',
        ]);
        expect(readFile(`${BACKUP}/CFM26-100m-results-2026-11-05_08-03-09.csv`)).toBe(`${HEADER}\n${OLD}\n`);
        expect(readFile(`${BACKUP}/CFM26-100m-uda-results-2026-11-05_08-03-09.csv`)).toBe('7,,0,10,0\r\n12,DNF,0,0,0\r\n');
        expect(readFile(`${BACKUP}/CFM26-100m-men-2026-11-05_08-03-09.csv`)).toBe('bib;name\n7;Hugo Guérin\n');
        // A participant file prefixed already is not prefixed again
        writeFiles({ 'CFM26/100m/CFM26-100m-kids.csv': 'bib;name\n30;Zoé Petit\n' });
        writeResults(OLD.replace('7;Runner 7', '8;Runner 8').replace(/2026-11-05T10/g, '2026-11-05T20'));
        writeFiles({ 'CFM26/100m/results-reset.yaml': 'at: 2026-11-05T21:00:00Z\n' });
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(true);
        expect(fs.readdirSync(path.join(workDir(), `${BACKUP}-2`))).toContain('CFM26-100m-kids-2026-11-05_08-03-09-2.csv');
        // The results files are removed
        expect(readFile(RESULTS)).toBeNull();
        expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBeNull();
        expect(await runs.loadResults('CFM26', '100m')).toEqual([]);
        expect(readFile('CFM26/100m/results-reset.yaml')).toMatch(/^at: \d{4}-\d\d-\d\dT/m);

        // Nothing more to save the next time
        await runs.resetResults('CFM26', '100m');
        expect(backups()).toEqual(['2026-11-05_08-03-09', '2026-11-05_08-03-09-2']);
    });

    it('saves nothing without results', async () => {
        await runs.resetResults('CFM26', '100m');
        expect(fs.existsSync(path.join(workDir(), 'CFM26/100m/backup'))).toBe(false);
        expect(readFile('CFM26/100m/results-reset.yaml')).not.toBeNull();
    });

    it('takes no run started before the reset from another computer, and keeps the later ones', async () => {
        writeFiles({ 'CFM26/100m/results-reset.yaml': 'at: 2026-11-05T11:00:00Z\n' });
        const row = (bib: string, start: string): ResultRow => ({
            bib,
            name: `Runner ${bib}`,
            start,
            finish: start.replace(':00Z', ':10Z'),
            distance: '',
            status: 'OK',
            computer: 'PC',
            line: 'Line 1',
            updated: '2026-11-05T12:00:00Z',
        });
        expect(await runs.mergeResultRows('CFM26', '100m', [row('7', '2026-11-05T10:00:00Z')])).toBe(false);
        expect(readFile(RESULTS)).toBeNull();
        expect(await runs.mergeResultRows('CFM26', '100m', [row('12', '2026-11-05T11:30:00Z')])).toBe(true);
        expect((await runs.readResultRows('CFM26', '100m'))!.map((r) => r.bib)).toEqual(['12']);
    });

    it('applies a reset copied from another computer, saving the runs its backup does not have', async () => {
        const later = '12;Runner 12;2026-11-05T11:30:00Z;2026-11-05T11:30:10Z;;OK;PC;Line 1;2026-11-05T11:30:10Z';
        writeResults(OLD, later);
        writeFiles({ 'CFM26/100m/results-reset.yaml': 'at: 2026-11-05T11:00:00Z\n', 'CFM26/100m/backup/from-peer/CFM26-100m-results-from-peer.csv': `${HEADER}\n${OLD}\n` });
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(true);
        expect(readFile(RESULTS)).toBe(`${HEADER}\n${later}\n`);
        // The peer's backup has the run dropped
        expect(backups()).toEqual(['from-peer']);
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(false);

        // A run the peer did not have is saved here
        const other = '8;Runner 8;2026-11-05T10:30:00Z;2026-11-05T10:30:10Z;;OK;PC;Line 1;2026-11-05T10:30:10Z';
        writeResults(other, later);
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(true);
        expect(backups()).toEqual(['2026-11-05_08-03-09', 'from-peer']);
        expect(readFile(`${BACKUP}/CFM26-100m-results-2026-11-05_08-03-09.csv`)).toBe(`${HEADER}\n${other}\n${later}\n`);

        // Another backup of the same date gets a suffix
        writeResults(other.replace('8;Runner 8', '9;Runner 9'), later);
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(true);
        expect(backups()).toEqual(['2026-11-05_08-03-09', '2026-11-05_08-03-09-2', 'from-peer']);
        expect(fs.readdirSync(path.join(workDir(), `${BACKUP}-2`))).toContain('CFM26-100m-results-2026-11-05_08-03-09-2.csv');

        // Only runs from before: the results files are removed
        writeResults(OLD.replace('7;Runner 7', '10;Runner 10'));
        expect(await runs.applyResultsReset('CFM26', '100m')).toBe(true);
        expect(readFile(RESULTS)).toBeNull();
    });

    it('saves a run in progress when the results were reset, rather than keeping it', async () => {
        expect(await runs.prepareRun(LINE, 'CFM26', '100m', HUGO)).toBeNull();
        runs.onCrossing(LINE, 'start', 'Start gate', Temporal.Now.instant().subtract({ seconds: 5 }));
        writeFiles({ 'CFM26/100m/results-reset.yaml': `at: ${Temporal.Now.instant().toString()}\n` });
        runs.onCrossing(LINE, 'finish', 'Finish gate', Temporal.Now.instant());
        await vi.waitFor(() => expect(readFile(RESULTS)).toBeNull());
        await vi.waitFor(() => expect(readFile(`CFM26/100m/backup/${backups()[0]}/CFM26-100m-results-${backups()[0]}.csv`)).toContain('7;Hugo Guérin;'));
        expect(await runs.loadResults('CFM26', '100m')).toEqual([]);
    });
});

describe('USB scans', () => {
    it('waits for a running USB scan to end before a participant is ready', async () => {
        let scanning = true;
        let endScan!: () => void;
        const scan = new Promise<void>((resolve) => {
            endScan = () => {
                scanning = false;
                resolve();
            };
        });
        vi.resetModules();
        vi.doMock('../src/services/hardware/usbHid.js', () => ({
            isUsbScanInProgress: () => scanning,
            waitForUsbScan: () => scan,
        }));
        try {
            runs = await import('../src/services/runService.js');
            (await import('../src/services/lines.js')).setConfiguredLines([LINE].map(asLine));
            const ready = runs.prepareRun(LINE, 'CFM26', '100m', HUGO);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(runs.getRunState(LINE)!.status).toBe('idle');

            endScan();
            expect(await ready).toBeNull();
            expect(runs.getRunState(LINE)!.status).toBe('ready');
        } finally {
            vi.doUnmock('../src/services/hardware/usbHid.js');
        }
    });
});

describe('line readiness', () => {
    it('is ready once the app listens to the devices of its start and finish', async () => {
        const lines = await import('../src/services/lines.js');
        lines.setConfiguredLines([{ name: LINE, enabled: true, start: 'Start cell', finish: 'Finish cell' }]);
        const ready = () => runs.getLineRuns().filter((l) => !l.manual).map((l) => l.ready);
        expect(ready()).toEqual([false]);
        lines.setListeningDevices(['Start cell']);
        expect(ready()).toEqual([false]);
        lines.setListeningDevices(['Start cell', 'Finish cell']);
        expect(ready()).toEqual([true]);
        lines.setListeningDevices(['Finish cell']);
        expect(ready()).toEqual([false]);
    });

    it('lists a disabled line, never ready', async () => {
        const lines = await import('../src/services/lines.js');
        lines.setConfiguredLines([asLine(LINE), { ...asLine(OTHER_LINE), enabled: false }]);
        lines.setListeningDevices(['Receiver']);
        expect(runs.getLineRuns().map(({ line, enabled, ready }) => ({ line, enabled, ready }))).toEqual([
            { line: LINE, enabled: true, ready: true },
            { line: OTHER_LINE, enabled: false, ready: false },
            // The manual line has no device: always ready
            { line: 'Manuel', enabled: true, ready: true },
        ]);
    });
});
