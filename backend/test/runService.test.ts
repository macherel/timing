import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultRow } from '../src/services/runService.js';
import { minutesFromNow, readFile, resetWorkDir, writeFiles } from './helpers.js';

type RunService = typeof import('../src/services/runService.js');

const HUGO = { bib: '7', name: 'Hugo Guérin', file: 'men' };
const LEA = { bib: '12', name: 'Léa Martin', file: 'women' };
const RESULTS = 'CFM26/100m/results.csv';
const HEADER = 'bib;name;start;finish;status;updated';

let runs: RunService;

// The run state lives in the module: each test imports a fresh one
beforeEach(async () => {
    resetWorkDir();
    writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\n', 'CFM26/100m/women.csv': '12;Léa Martin\n' });
    vi.resetModules();
    runs = await import('../src/services/runService.js');
});

const at = (iso: string) => Temporal.Instant.from(iso);

/** Runs a participant from ready to finish, then waits until the result is in results.csv. */
async function timeRun(participant = HUGO, start = '2026-11-05T10:00:00Z', finish = '2026-11-05T10:00:12.345Z') {
    expect(await runs.prepareRun('CFM26', '100m', participant)).toBeNull();
    const before = (await runs.loadResults('CFM26', '100m'))!.length;
    runs.onCrossing('start_crossed', 'Start gate', at(start));
    runs.onCrossing('finish_crossed', 'Finish gate', at(finish));
    await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!.length).toBe(before + 1));
}

describe('a timed run', () => {
    it('goes from idle to ready, running, and back to idle with the result saved', async () => {
        expect(runs.getRunState()).toEqual({ status: 'idle' });

        await runs.prepareRun('CFM26', '100m', HUGO);
        expect(runs.getRunState()).toMatchObject({ status: 'ready', event: 'CFM26', discipline: '100m', participant: HUGO });

        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.getRunState()).toMatchObject({ status: 'running', startedAt: '2026-11-05T10:00:00Z' });

        runs.onCrossing('finish_crossed', 'Finish gate', at('2026-11-05T10:00:12.345Z'));
        expect(runs.getRunState()).toEqual({ status: 'idle' });
        expect(runs.getLastResult()?.result).toMatchObject({ bib: '7', timeMs: 12345, status: 'ok' });

        await vi.waitFor(async () =>
            expect(await runs.loadResults('CFM26', '100m')).toEqual([
                {
                    bib: '7',
                    name: 'Hugo Guérin',
                    start: '2026-11-05T10:00:00Z',
                    finish: '2026-11-05T10:00:12.345Z',
                    timeMs: 12345,
                    status: 'ok',
                },
            ]),
        );
        const [header, line] = readFile(RESULTS)!.trim().split('\n');
        expect(header).toBe(HEADER);
        // The time is not stored: it is finish - start
        expect(line).toMatch(/^7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:12.345Z;OK;\d{4}-.+Z$/);
    });

    it('ignores a finish before the start, and a start when nobody is ready', async () => {
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.getRunState()).toEqual({ status: 'idle' });

        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('finish_crossed', 'Finish gate', at('2026-11-05T10:00:01Z'));
        expect(runs.getRunState().status).toBe('ready');
    });

    it('keeps the first start: a second start crossing does not restart the clock', async () => {
        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:05Z'));
        expect(runs.getRunState()).toMatchObject({ startedAt: '2026-11-05T10:00:00Z' });
    });

    it('can be cancelled, saving nothing', async () => {
        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        runs.cancelRun();
        expect(runs.getRunState()).toEqual({ status: 'idle' });
        expect(readFile(RESULTS)).toBeNull();
    });

    it('can be ended as invalid or disqualified, without a time', async () => {
        expect(runs.voidRun('dq')).toBe('No run in progress.');

        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(runs.voidRun('dq')).toBeNull();

        await runs.prepareRun('CFM26', '100m', LEA);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:01:00Z'));
        expect(runs.voidRun('invalid')).toBeNull();

        await vi.waitFor(async () =>
            expect((await runs.loadResults('CFM26', '100m'))!.map((r) => [r.bib, r.status, r.timeMs, r.finish])).toEqual([
                ['7', 'dq', null, null],
                ['12', 'invalid', null, null],
            ]),
        );
    });

    it('cannot get another participant ready while a run is in progress', async () => {
        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:00:00Z'));
        expect(await runs.prepareRun('CFM26', '100m', LEA)).toBe('A run is in progress. Cancel it first.');
    });

    it('cannot start in an unknown discipline', async () => {
        expect(await runs.prepareRun('CFM26', 'nope', HUGO)).toBe('Unknown event or discipline.');
    });
});

describe('attempts and access', () => {
    it('refuses a participant who used all their attempts, invalid runs not counted', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 2\n' });
        await timeRun(HUGO, '2026-11-05T10:00:00Z');

        // An invalid run is not the participant's fault: it does not use an attempt
        await runs.prepareRun('CFM26', '100m', HUGO);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:01:00Z'));
        runs.voidRun('invalid');
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!).toHaveLength(2));

        await timeRun(HUGO, '2026-11-05T10:02:00Z', '2026-11-05T10:02:10Z');
        expect(await runs.prepareRun('CFM26', '100m', HUGO)).toBe('7 Hugo Guérin has used all 2 attempt(s).');
        // Other participants still have theirs
        expect(await runs.prepareRun('CFM26', '100m', LEA)).toBeNull();
    });

    it('refuses runs when the discipline is locked or outside its period', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'access: locked\n' });
        expect(await runs.prepareRun('CFM26', '100m', HUGO)).toBe('CFM26 / 100m is closed: its results are locked.');

        writeFiles({ 'CFM26/100m/config.yaml': `end: ${minutesFromNow(-5)}\n` });
        expect(await runs.prepareRun('CFM26', '100m', HUGO)).toMatch(/^CFM26 \/ 100m is closed: it closed on /);

        writeFiles({ 'CFM26/100m/config.yaml': `end: ${minutesFromNow(-5)}\naccess: open\n` });
        expect(await runs.prepareRun('CFM26', '100m', HUGO)).toBeNull();
    });
});

describe('setResultStatus', () => {
    beforeEach(() => timeRun(HUGO, '2026-11-05T10:00:00Z', '2026-11-05T10:00:12.345Z'));

    it('changes the status of the run with this bib and start, and keeps the others', async () => {
        await timeRun(LEA, '2026-11-05T10:00:00Z', '2026-11-05T10:00:15Z');

        const outcome = await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'dq');
        expect(outcome).toEqual({ result: expect.objectContaining({ bib: '7', status: 'dq', timeMs: 12345 }) });
        expect((await runs.loadResults('CFM26', '100m'))!.map((r) => `${r.bib} ${r.status}`)).toEqual(['7 dq', '12 ok']);
        // The live pages show the last run with its new status
        expect(runs.getLastResult()?.result.bib).toBe('12');

        await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'ok');
        expect((await runs.loadResults('CFM26', '100m'))![0].status).toBe('ok');
    });

    it('updates the last result shown on the live page', async () => {
        await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'invalid');
        expect(runs.getLastResult()?.result.status).toBe('invalid');
    });

    it('answers 404 for an unknown run, and 409 for a run without time set to OK', async () => {
        expect(await runs.setResultStatus('CFM26', '100m', '7', '2026-01-01T00:00:00Z', 'dq')).toEqual({
            status: 404,
            problem: 'This result is not in results.csv any more.',
        });

        await runs.prepareRun('CFM26', '100m', LEA);
        runs.onCrossing('start_crossed', 'Start gate', at('2026-11-05T10:05:00Z'));
        runs.voidRun('dq');
        await vi.waitFor(async () => expect((await runs.loadResults('CFM26', '100m'))!).toHaveLength(2));
        expect(await runs.setResultStatus('CFM26', '100m', '12', '2026-11-05T10:05:00Z', 'ok')).toMatchObject({ status: 409 });
    });

    it('answers 409 when the discipline is closed', async () => {
        writeFiles({ 'CFM26/100m/config.yaml': 'access: locked\n' });
        expect(await runs.setResultStatus('CFM26', '100m', '7', '2026-11-05T10:00:00Z', 'dq')).toMatchObject({ status: 409 });
    });
});

describe('results.csv', () => {
    it('reads older layouts by column name: a time column, no status, no updated', async () => {
        writeFiles({ [RESULTS]: 'bib;name;start;finish;time\n7;Hugo;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;10.000\n' });
        expect(await runs.loadResults('CFM26', '100m')).toEqual([
            { bib: '7', name: 'Hugo', start: '2026-11-05T10:00:00Z', finish: '2026-11-05T10:00:10Z', timeMs: 10000, status: 'ok' },
        ]);
    });

    it('leaves out valid lines without a readable time', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Hugo;2026-11-05T10:00:00Z;;OK;\n12;Léa;2026-11-05T10:01:00Z;;DQ;\n` });
        expect((await runs.loadResults('CFM26', '100m'))!.map((r) => r.bib)).toEqual(['12']);
    });

    it('quotes names that contain the separator', async () => {
        writeFiles({ 'CFM26/100m/men.csv': '7;"Dupont; Jean"\n' });
        await timeRun({ bib: '7', name: 'Dupont; Jean', file: 'men' });
        expect(readFile(RESULTS)).toContain('7;"Dupont; Jean";');
        expect((await runs.loadResults('CFM26', '100m'))![0].name).toBe('Dupont; Jean');
    });
});

describe('mergeResultRows (sync)', () => {
    const row = (bib: string, start: string, status: string, updated: string): ResultRow => ({
        bib,
        name: `Runner ${bib}`,
        start,
        finish: start.replace(':00Z', ':10Z'),
        status,
        updated,
    });

    it('adds the lines it does not have, oldest run first', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Runner 7;2026-11-05T10:05:00Z;2026-11-05T10:05:10Z;OK;2026-11-05T10:05:10Z\n` });
        const changed = await runs.mergeResultRows('CFM26', '100m', [row('12', '2026-11-05T10:00:00Z', 'OK', '2026-11-05T10:00:10Z')]);
        expect(changed).toBe(true);
        expect((await runs.readResultRows('CFM26', '100m'))!.map((r) => r.bib)).toEqual(['12', '7']);
    });

    it('keeps the most recently changed version of a line', async () => {
        writeFiles({ [RESULTS]: `${HEADER}\n7;Runner 7;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:30:00Z\n` });

        const older = row('7', '2026-11-05T10:00:00Z', 'DQ', '2026-11-05T10:20:00Z');
        expect(await runs.mergeResultRows('CFM26', '100m', [older])).toBe(false);
        expect((await runs.readResultRows('CFM26', '100m'))![0].status).toBe('OK');

        const newer = row('7', '2026-11-05T10:00:00Z', 'DQ', '2026-11-05T10:40:00Z');
        expect(await runs.mergeResultRows('CFM26', '100m', [newer])).toBe(true);
        expect((await runs.readResultRows('CFM26', '100m'))![0].status).toBe('DQ');
    });

    it('does nothing for an unknown discipline', async () => {
        expect(await runs.mergeResultRows('nope', 'nope', [row('7', '2026-11-05T10:00:00Z', 'OK', '')])).toBe(false);
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
            const ready = runs.prepareRun('CFM26', '100m', HUGO);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(runs.getRunState().status).toBe('idle');

            endScan();
            expect(await ready).toBeNull();
            expect(runs.getRunState().status).toBe('ready');
        } finally {
            vi.doUnmock('../src/services/hardware/usbHid.js');
        }
    });
});
