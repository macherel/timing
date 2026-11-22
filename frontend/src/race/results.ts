import type { DisciplineSettings, RunResult } from '../types';
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
