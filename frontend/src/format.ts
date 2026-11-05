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

/**
 * A race time, e.g. "12.345" or "1:02.345" from one minute. `decimals` shortens it for a running clock.
 */
export function formatDuration(ms: number, decimals = 3): string {
  const factor = 10 ** decimals;
  const rounded = Math.floor(Math.max(0, ms) / (1000 / factor)) / factor;
  const minutes = Math.floor(rounded / 60);
  const seconds = (rounded - minutes * 60).toFixed(decimals);
  return minutes > 0 ? `${minutes}:${seconds.padStart(decimals + 3, '0')}` : seconds;
}
