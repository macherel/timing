import type { RunResult } from '../types';

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
