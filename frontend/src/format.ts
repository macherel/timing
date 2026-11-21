import type { Precision } from './types';

/**
 * Local time with milliseconds, e.g. "14:03:27.512".
 * Backend timestamps have nanoseconds, which Date does not parse everywhere, so they are cut to milliseconds.
 */
export function formatTime(iso: string): string {
  const date = new Date(iso.replace(/(\.\d{3})\d+/, '$1'));
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/** e.g. 0x01 */
export function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

/** Milliseconds since the epoch of a backend timestamp (nanoseconds are cut, see formatTime). */
export function parseInstant(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
}

/** Decimals of a time with the precision of a discipline: 12 s, 12.3, 12.34 or 12.345. */
export const DECIMALS: Record<Precision, number> = { second: 0, tenth: 1, hundredth: 2, thousandth: 3 };

/**
 * A race time, e.g. "12.345" or "1:02.345" from one minute, truncated to `decimals` (see DECIMALS). The times of the
 * results are already at the precision of their discipline, so nothing is lost.
 */
export function formatDuration(ms: number, decimals = 3): string {
  const factor = 10 ** decimals;
  const rounded = Math.floor(Math.max(0, ms) / (1000 / factor)) / factor;
  const minutes = Math.floor(rounded / 60);
  const seconds = (rounded - minutes * 60).toFixed(decimals);
  return minutes > 0 ? `${minutes}:${seconds.padStart(decimals > 0 ? decimals + 3 : 2, '0')}` : seconds;
}
