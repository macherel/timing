import type { DisciplineSettings, Measure, RunResult } from '../types';
import { parseInstant } from '../format';

/**
 * Whether two results are the same run. Bib and start together identify a run, as several participants can share
 * a start (same as the backend).
 */
export function sameRun(a: RunResult, b: RunResult): boolean {
  return a.bib === b.bib && a.start === b.start;
}

/** Invalid runs are not the participant's fault, so they do not use up an attempt (same rule as the backend). */
export function countsAsAttempt(result: RunResult): boolean {
  return result.status !== 'invalid';
}

/** Whether a time beats another one: shorter, or longer for a slow race (same rule as the backend). */
export function isBetterTime(timeMs: number, than: number, best: DisciplineSettings['best']): boolean {
  return best === 'longest' ? timeMs > than : timeMs < than;
}

/** The value a result is measured by: its distance, or its time. null when it has none (e.g. ended before the finish). */
export function valueOf(result: RunResult, measure: Measure): number | null {
  return measure === 'distance' ? (result.distanceCm ?? null) : result.timeMs;
}

/** Which value is the best: the longest distance, or the time the settings say (same rule as the backend). */
export function bestRule(settings: Pick<DisciplineSettings, 'measure' | 'best'>): DisciplineSettings['best'] {
  return settings.measure === 'distance' ? 'longest' : settings.best;
}

/**
 * The last `count` runs timed on a line of a computer, the latest start first. Runs saved before the computer and line
 * were recorded belong to no line.
 */
export function recentRunsOf(results: RunResult[], computer: string, line: string, count: number): RunResult[] {
  return results
    .filter((result) => result.computer === computer && result.line === line)
    .sort((a, b) => parseInstant(b.start) - parseInstant(a.start))
    .slice(0, count);
}

/**
 * The attempts a participant failed at a distance since they last validated it (same rule as the backend). `results`
 * are their runs, oldest first; invalid runs do not count.
 */
export function failedAt(results: RunResult[], distanceCm: number): number {
  let failed = 0;
  for (const result of results) {
    if (!countsAsAttempt(result) || result.distanceCm !== distanceCm) continue;
    failed = result.status === 'ok' ? 0 : failed + 1;
  }
  return failed;
}

/**
 * The distance (in centimetres) at which a participant failed all the attempts allowed at one distance, so is
 * eliminated, or null (same rule as the backend). A validation resets the count at its distance: a participant who
 * validates a distance goes on, but one who then fails it again `perDistance` times is eliminated. `results` are their
 * runs, oldest first; invalid runs do not count.
 */
export function eliminatedAt(results: RunResult[], perDistance: number | null | undefined): number | null {
  if (!perDistance) return null;
  const failed = new Map<number, number>();
  for (const result of results) {
    if (!countsAsAttempt(result) || result.distanceCm == null) continue;
    if (result.status === 'ok') {
      failed.delete(result.distanceCm);
      continue;
    }
    const count = (failed.get(result.distanceCm) ?? 0) + 1;
    if (count >= perDistance) return result.distanceCm;
    failed.set(result.distanceCm, count);
  }
  return null;
}

/**
 * The distance (in centimetres) a participant started and did not validate yet, so their next run must be at it, or
 * null (same rule as the backend). `results` are their runs, oldest first; invalid runs do not start a distance. The
 * distance of the last attempt, unless it is valid.
 */
export function openDistance(results: RunResult[]): number | null {
  const last = results.filter(countsAsAttempt).at(-1);
  return last === undefined || last.status === 'ok' ? null : (last.distanceCm ?? null);
}

/**
 * The results without the runs beyond the attempts allowed (same rule as the backend): for each participant, the runs
 * that count as attempts after the first `attempts` ones, by start (e.g. an invalid run made valid afterwards). Their
 * best result is among the others. Unlimited attempts (null): every result.
 */
export function withinAttempts(results: RunResult[], attempts: number | null): RunResult[] {
  if (attempts === null) return results;
  const used = new Map<string, number>();
  const beyond = new Set<RunResult>();
  for (const result of [...results].sort((a, b) => parseInstant(a.start) - parseInstant(b.start))) {
    if (!countsAsAttempt(result)) continue;
    const count = (used.get(result.bib) ?? 0) + 1;
    used.set(result.bib, count);
    if (count > attempts) beyond.add(result);
  }
  return results.filter((result) => !beyond.has(result));
}
