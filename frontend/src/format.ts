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
