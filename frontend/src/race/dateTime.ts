/**
 * The discipline period is stored as ISO 8601 date-times in UTC, and shown and edited in the browser's local time.
 */

/** An ISO 8601 date-time as the browser's local YYYY-MM-DDTHH:MM, for a datetime-local input. Empty for null. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local input value (browser's local time) as ISO 8601 in UTC, as stored in config.yaml. */
export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 16) + 'Z';
}

/** A UTC date-time in the browser's local time with its offset, e.g. "2026-11-05 08:00 +01:00", for messages. */
export function showDateTime(iso: string): string {
  const date = new Date(iso);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  return `${toLocalInput(iso).replace('T', ' ')} ${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}
