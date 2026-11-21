import { describe, expect, it } from 'vitest';
import { formatDuration, formatTime, hexByte, parseInstant } from '../src/format';
import { fromLocalInput, showDateTime, toLocalInput } from '../src/race/dateTime';
import { normalize, searchParticipants } from '../src/race/participantSearch';
import { countsAsAttempt, sameRun } from '../src/race/results';
import type { Participant, RunResult } from '../src/types';

describe('format', () => {
  it('shows race times with milliseconds, and minutes from one minute', () => {
    expect(formatDuration(12345)).toBe('12.345');
    expect(formatDuration(62345)).toBe('1:02.345');
    expect(formatDuration(600000)).toBe('10:00.000');
  });

  it('cuts (does not round) a running clock to its decimals', () => {
    expect(formatDuration(12399, 1)).toBe('12.3');
    expect(formatDuration(59999, 1)).toBe('59.9');
  });

  it('shows 0 for a negative duration (clocks slightly apart)', () => {
    expect(formatDuration(-5)).toBe('0.000');
  });

  it('formats a time without decimals, in whole seconds', () => {
    expect(formatDuration(12000, 0)).toBe('12');
    expect(formatDuration(62000, 0)).toBe('1:02');
  });

  it('reads backend instants with nanoseconds', () => {
    expect(parseInstant('2026-11-05T10:00:12.345678901Z')).toBe(Date.parse('2026-11-05T10:00:12.345Z'));
    const local = new Date('2026-11-05T10:00:12.345Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(formatTime('2026-11-05T10:00:12.345678901Z')).toBe(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.345`,
    );
  });

  it('shows a byte in hex', () => {
    expect(hexByte(1)).toBe('0x01');
    expect(hexByte(255)).toBe('0xff');
  });
});

describe('discipline period date-times', () => {
  it('converts UTC to the browser time for the inputs, and back', () => {
    const local = toLocalInput('2026-11-05T07:00Z');
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe('2026-11-05T07:00Z');
  });

  it('keeps empty values empty', () => {
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput('not a date')).toBe('');
    expect(fromLocalInput('')).toBeNull();
  });

  it('shows a date-time with its offset', () => {
    expect(showDateTime('2026-11-05T07:00Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  });
});

describe('searchParticipants', () => {
  const people: Participant[] = [
    { bib: '1', name: 'Hugo Guérin', file: 'men' },
    { bib: '12', name: 'Éloïse Dupont', file: 'women' },
    { bib: '21', name: 'Jean-Luc Martin', file: 'men' },
    { bib: '120', name: 'Léa Dupuis', file: 'women' },
  ];
  const bibs = (query: string, limit = 10) => searchParticipants(people, query, limit).map((p) => p.bib);

  it('ignores case and accents', () => {
    expect(normalize('Éloïse')).toBe('eloise');
    expect(bibs('ELOISE')).toEqual(['12']);
  });

  it('puts the exact bib first, then bibs starting with the number, then bibs containing it', () => {
    expect(bibs('12')).toEqual(['12', '120']);
    expect(bibs('1')).toEqual(['1', '12', '120', '21']);
  });

  it('matches the start of each part of the name, then anywhere in it', () => {
    expect(bibs('luc')).toEqual(['21']);
    expect(bibs('dup')).toEqual(['12', '120']);
    expect(bibs('tin')).toEqual(['21']);
  });

  it('needs every word to match, bib and name together', () => {
    expect(bibs('12 dup')).toEqual(['12', '120']);
    expect(bibs('12 lea')).toEqual(['120']);
    expect(bibs('hugo martin')).toEqual([]);
  });

  it('lists everyone for an empty search, and limits a search', () => {
    expect(bibs('  ')).toEqual(['1', '12', '21', '120']);
    expect(bibs('1', 2)).toEqual(['1', '12']);
  });
});

describe('results', () => {
  const run = (extra: Partial<RunResult>): RunResult => ({
    bib: '7',
    name: 'Hugo',
    start: '2026-11-05T10:00:00Z',
    finish: null,
    timeMs: null,
    status: 'ok',
    ...extra,
  });

  it('identifies a run by bib and start together', () => {
    expect(sameRun(run({}), run({ status: 'dq' }))).toBe(true);
    expect(sameRun(run({}), run({ bib: '8' }))).toBe(false);
    expect(sameRun(run({}), run({ start: '2026-11-05T10:01:00Z' }))).toBe(false);
  });

  it('does not count invalid runs as attempts', () => {
    expect(countsAsAttempt(run({ status: 'ok' }))).toBe(true);
    expect(countsAsAttempt(run({ status: 'dq' }))).toBe(true);
    expect(countsAsAttempt(run({ status: 'invalid' }))).toBe(false);
  });
});
