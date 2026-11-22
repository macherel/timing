import { beforeEach, describe, expect, it } from 'vitest';
import {
    closedReason,
    disciplineDir,
    listEvents,
    loadDisciplineSettings,
    loadParticipants,
    parseCsv,
    titleCase,
    saveDisciplineSettings,
    toDateTime,
    validateDisciplineSettings,
    type DisciplineSettings,
} from '../src/services/eventService.js';
import { minutesFromNow, readFile, resetWorkDir, workDir, writeFiles } from './helpers.js';

const SETTINGS: DisciplineSettings = {
    attempts: null,
    start: null,
    end: null,
    access: 'auto',
    best: 'shortest',
    precision: 'hundredth',
    rounding: 'up',
    recentRuns: 3,
};

beforeEach(resetWorkDir);

describe('parseCsv', () => {
    it('detects the separator from the first line', () => {
        expect(parseCsv('bib;name\n1;Hugo')).toEqual([['bib', 'name'], ['1', 'Hugo']]);
        expect(parseCsv('bib,name\n1,Hugo')).toEqual([['bib', 'name'], ['1', 'Hugo']]);
        expect(parseCsv('bib\tname\n1\tHugo')).toEqual([['bib', 'name'], ['1', 'Hugo']]);
    });

    it('reads quoted cells with separators, doubled quotes and line breaks', () => {
        expect(parseCsv('1;"Dupont; Jean"\n2;"Le ""Grand""";x\n3;"two\nlines"')).toEqual([
            ['1', 'Dupont; Jean'],
            ['2', 'Le "Grand"', 'x'],
            ['3', 'two\nlines'],
        ]);
    });

    it('accepts Windows line ends and a missing final line end', () => {
        expect(parseCsv('1;A\r\n2;B\r\n')).toEqual([['1', 'A'], ['2', 'B']]);
        expect(parseCsv('1;A\n2;B')).toEqual([['1', 'A'], ['2', 'B']]);
    });

    it('returns no row for an empty text', () => {
        expect(parseCsv('')).toEqual([]);
    });
});

describe('events and disciplines', () => {
    it('lists the event folders with their disciplines, hidden folders and files left out', async () => {
        writeFiles({
            'CFM26/100m/men.csv': '',
            'CFM26/10km/men.csv': '',
            'CFM26/notes.txt': '',
            'UNICON22/Slalom/a.csv': '',
            '.hidden/x/a.csv': '',
            'config.yaml': 'devices: []',
        });
        expect(await listEvents()).toEqual([
            // Numbers are compared by value: 10km comes before 100m
            { name: 'CFM26', disciplines: ['10km', '100m'] },
            { name: 'UNICON22', disciplines: ['Slalom'] },
        ]);
    });

    it('lists no event when the working directory is empty', async () => {
        expect(await listEvents()).toEqual([]);
    });

    it('finds a discipline folder only by the names in the listing', async () => {
        writeFiles({ 'CFM26/100m/men.csv': '' });
        expect(await disciplineDir('CFM26', '100m')).toBe(`${workDir()}/CFM26/100m`);
        expect(await disciplineDir('CFM26', 'unknown')).toBeNull();
        expect(await disciplineDir('..', '..')).toBeNull();
        expect(await disciplineDir('CFM26', '../CFM26')).toBeNull();
    });

    it('renames the results.csv of an earlier version with the event and discipline, and drops its UDA export', async () => {
        writeFiles({ 'CFM26/100m/results.csv': 'bib;name;start;finish;status;updated\n', 'CFM26/100m/uda-results.csv': '' });
        await disciplineDir('CFM26', '100m');
        expect(readFile('CFM26/100m/results.csv')).toBeNull();
        expect(readFile('CFM26/100m/uda-results.csv')).toBeNull();
        expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBe('bib;name;start;finish;status;updated\n');
    });

    it('keeps the results.csv of an earlier version when the prefixed results file exists already', async () => {
        writeFiles({ 'CFM26/100m/results.csv': 'old\n', 'CFM26/100m/CFM26-100m-results.csv': 'new\n' });
        await disciplineDir('CFM26', '100m');
        expect(readFile('CFM26/100m/results.csv')).toBe('old\n');
        expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBe('new\n');
    });
});

describe('loadParticipants', () => {
    it('merges the CSV files of a discipline, sorted by bib, with the file name as category', async () => {
        writeFiles({
            'CFM26/100m/women.csv': 'bib;name\n12;Léa Martin\n3;Emma Petit\n',
            'CFM26/100m/men.csv': 'Dossard;Nom\n7;Hugo Guérin\n',
            'CFM26/100m/CFM26-100m-results.csv': 'bib;name;start;finish;status;updated\n7;Hugo;x;y;OK;z\n',
        });
        const list = await loadParticipants('CFM26', '100m');
        expect(list?.participants).toEqual([
            { bib: '3', name: 'Emma Petit', file: 'women' },
            { bib: '7', name: 'Hugo Guérin', file: 'men' },
            { bib: '12', name: 'Léa Martin', file: 'women' },
        ]);
        expect(list?.problems).toEqual([]);
    });

    it('reads files without a header row and with extra columns', async () => {
        writeFiles({ 'E/D/list.csv': '1,Ann,F,2001\n2,Bob,M,1999' });
        const list = await loadParticipants('E', 'D');
        expect(list?.participants.map((p) => `${p.bib} ${p.name}`)).toEqual(['1 Ann', '2 Bob']);
    });

    it('finds the columns by their header name, as in the UDA competitors export', async () => {
        writeFiles({
            'E/D/competitors.csv':
                'ID,LastName,FirstName,Country,Gender,Age Group\n1,vasseur,ninon,France,Male,Super Vétéran M\n187,TESSIER,Ophélie,France,Female,\n',
            'E/D/other.csv': 'Name;Dossard\nRosalie;5\n',
        });
        const list = await loadParticipants('E', 'D');
        expect(list?.participants).toEqual([
            { bib: '1', name: 'Ninon Vasseur', file: 'Super Vétéran M' },
            { bib: '5', name: 'Rosalie', file: 'other' },
            { bib: '187', name: 'Ophélie Tessier', file: 'competitors' },
        ]);
        expect(list?.problems).toEqual([]);
    });

    it('writes first and last names with a capital at the start of each word', () => {
        expect(titleCase('DUVAL-ARNOUX')).toBe('Duval-Arnoux');
        expect(titleCase('jean-baptiste')).toBe('Jean-Baptiste');
        expect(titleCase("o'NEIL")).toBe("O'Neil");
        expect(titleCase('éLOÏSE de la tour')).toBe('Éloïse De La Tour');
    });

    it('does not read files in the UDA results format as participants, whatever their name', async () => {
        writeFiles({
            'E/D/a.csv': '1;Ann\n',
            'E/D/E-D-uda-results.csv': '1,,0,29,92\r\n',
            'E/D/Résultats UDA.csv': '1,,0,29,92\r\n7,DNF,0,0,0\r\n23,DQ,0,0,0\r\n',
        });
        const list = await loadParticipants('E', 'D');
        expect(list?.participants.map((p) => p.bib)).toEqual(['1']);
        expect(list?.problems).toEqual([]);
    });

    it('reads files saved by Excel on Windows (Windows-1252) and with a BOM', async () => {
        writeFiles({
            'E/D/ansi.csv': Buffer.from('1;Éloïse Vernier\n', 'latin1'),
            'E/D/bom.csv': '﻿bib;name\n2;Sidonie\n',
        });
        const list = await loadParticipants('E', 'D');
        expect(list?.participants.map((p) => p.name)).toEqual(['Éloïse Vernier', 'Sidonie']);
    });

    it('skips wrong rows and says why', async () => {
        writeFiles({
            'E/D/a.csv': 'bib;name\n1;Ann\nx;Bad bib\n2;\n\n1;Ann again',
            'E/D/b.csv': '1;Duplicate in another file',
        });
        const list = await loadParticipants('E', 'D');
        expect(list?.participants).toEqual([{ bib: '1', name: 'Ann', file: 'a' }]);
        expect(list?.problems).toEqual([
            'a.csv, line 3: bib "x" is not a number',
            'a.csv, line 4: bib 2 has no name',
            'a.csv, line 6: bib 1 is already used in a.csv',
            'b.csv, line 1: bib 1 is already used in a.csv',
        ]);
    });

    it('returns null for an unknown discipline', async () => {
        expect(await loadParticipants('nope', 'nope')).toBeNull();
    });
});

describe('toDateTime', () => {
    it('keeps a UTC date-time to the minute', () => {
        expect(toDateTime('2026-11-05T07:00Z', 'start')).toBe('2026-11-05T07:00Z');
        expect(toDateTime('2026-11-05T07:00:59.123Z', 'start')).toBe('2026-11-05T07:00Z');
    });

    it('converts an offset to UTC', () => {
        expect(toDateTime('2026-11-05T08:00+01:00', 'start')).toBe('2026-11-05T07:00Z');
    });

    it('reads a date-time without offset in the server time zone', () => {
        const expected = Temporal.PlainDateTime.from('2026-07-01T09:30')
            .toZonedDateTime(Temporal.Now.timeZoneId())
            .toInstant()
            .toString({ smallestUnit: 'minute' });
        expect(toDateTime('2026-07-01T09:30', 'start')).toBe(expected);
        expect(toDateTime('2026-07-01 09:30', 'start')).toBe(expected);
    });

    it('reads a date alone as the start of the day, or the next midnight for an end', () => {
        const midnight = (date: string) =>
            Temporal.PlainDate.from(date).toZonedDateTime(Temporal.Now.timeZoneId()).toInstant().toString({ smallestUnit: 'minute' });
        expect(toDateTime('2026-07-01', 'start')).toBe(midnight('2026-07-01'));
        expect(toDateTime('2026-07-01', 'end')).toBe(midnight('2026-07-02'));
    });

    it('rejects what is not a real date-time', () => {
        for (const value of ['2026-02-30T08:00Z', '2026-13-01', 'tomorrow', '', 42, null, undefined]) {
            expect(toDateTime(value, 'start')).toBeNull();
        }
    });
});

describe('closedReason', () => {
    it('is open without limits, and always open when access is open', () => {
        expect(closedReason(SETTINGS)).toBeNull();
        expect(closedReason({ ...SETTINGS, access: 'open', end: minutesFromNow(-60) })).toBeNull();
    });

    it('is closed when locked, before the start and from the end', () => {
        expect(closedReason({ ...SETTINGS, access: 'locked' })).toBe('its results are locked');
        expect(closedReason({ ...SETTINGS, start: minutesFromNow(60) })).toMatch(/^it opens on /);
        expect(closedReason({ ...SETTINGS, end: minutesFromNow(-1) })).toMatch(/^it closed on /);
    });

    it('is open within the period', () => {
        expect(closedReason({ ...SETTINGS, start: minutesFromNow(-60), end: minutesFromNow(60) })).toBeNull();
    });
});

describe('discipline settings', () => {
    const dir = () => `${workDir()}/E/D`;

    beforeEach(() => writeFiles({ 'E/D/list.csv': '1;Ann' }));

    it('uses the defaults without config.yaml', async () => {
        expect(await loadDisciplineSettings(dir())).toEqual({ settings: SETTINGS, problems: [] });
    });

    it('reads every setting', async () => {
        writeFiles({
            'E/D/config.yaml':
                'attempts: 3\nstart: 2026-11-05T07:00Z\nend: 2026-11-05T17:00Z\naccess: open\nbest: longest\nprecision: thousandth\nrounding: nearest\nrecentRuns: 5\n',
        });
        expect(await loadDisciplineSettings(dir())).toEqual({
            settings: {
                attempts: 3,
                start: '2026-11-05T07:00Z',
                end: '2026-11-05T17:00Z',
                access: 'open',
                best: 'longest',
                precision: 'thousandth',
                rounding: 'nearest',
                recentRuns: 5,
            },
            problems: [],
        });
    });

    it('reads the older locked: true as access: locked', async () => {
        writeFiles({ 'E/D/config.yaml': 'locked: true\n' });
        expect((await loadDisciplineSettings(dir())).settings.access).toBe('locked');
    });

    it('ignores wrong settings and lists them', async () => {
        writeFiles({ 'E/D/config.yaml': 'attempts: 0\naccess: maybe\nstart: someday\nbest: fastest\nprecision: minute\nrounding: down\nrecentRuns: -1\ncolour: red\n' });
        const { settings, problems } = await loadDisciplineSettings(dir());
        expect(settings).toEqual(SETTINGS);
        expect(problems).toHaveLength(8);
        expect(problems.join('\n')).toMatch(/attempts.*access.*start.*best.*precision.*rounding.*recentRuns.*unknown setting "colour"/s);
    });

    it('ignores a period whose start is not before its end', async () => {
        writeFiles({ 'E/D/config.yaml': 'start: 2026-11-05T17:00Z\nend: 2026-11-05T07:00Z\n' });
        const { settings, problems } = await loadDisciplineSettings(dir());
        expect([settings.start, settings.end]).toEqual([null, null]);
        expect(problems[0]).toMatch(/is not before end/);
    });

    it('validates settings sent by the page', () => {
        expect(validateDisciplineSettings({ attempts: 2, start: '2026-11-05T07:00Z', end: null, access: 'auto' })).toEqual([]);
        expect(validateDisciplineSettings({})).toEqual([]);
        expect(validateDisciplineSettings(null)).toEqual(['settings are missing']);
        expect(validateDisciplineSettings({ attempts: 1.5, start: 'x', access: 'never', best: 'fastest', precision: 'minute', rounding: 'down', recentRuns: 1.5 })).toHaveLength(7);
        expect(validateDisciplineSettings({ start: '2026-11-05T17:00Z', end: '2026-11-05T07:00Z' })).toEqual(['start must be before end']);
    });

    it('saves the settings so they read back the same, keeping other settings', async () => {
        writeFiles({ 'E/D/config.yaml': 'attempts: 5\nlocked: true\nnote: keep me\n' });
        const saved: DisciplineSettings = {
            attempts: 2,
            start: '2026-11-05T07:00Z',
            end: null,
            access: 'locked',
            best: 'longest',
            precision: 'tenth',
            rounding: 'truncate',
            recentRuns: 0,
        };
        await saveDisciplineSettings(dir(), saved);

        const text = readFile('E/D/config.yaml')!;
        expect(text).toContain('attempts: 2');
        expect(text).toContain('#end:');
        expect(text).not.toContain('locked: true');
        expect(text).toContain('note: keep me');
        const { settings, problems } = await loadDisciplineSettings(dir());
        expect(settings).toEqual(saved);
        expect(problems).toEqual(['config.yaml: unknown setting "note" is ignored']);
    });
});
