/**
 * The timing lines of this computer: the lines of config.yaml, set by the hardware service when it loads the file.
 * A line is ready when it is enabled and the app listens to the devices of its start and its finish, so that both
 * crossings can be recorded. A disabled line is still listed, so the race page can show it, but it is never ready.
 *
 * With simulated gates (TIMING_SIMULATE_GATES=1, for the end-to-end tests and for training without hardware) and no
 * line in config.yaml, two simulated lines are used, so the app can be tried without configuring anything.
 */

// Gate crossings sent over HTTP instead of by the USB gates. Off unless the server is started with
// TIMING_SIMULATE_GATES=1, so it cannot fire during a real race.
export const SIMULATE_GATES = process.env.TIMING_SIMULATE_GATES === '1';
export const SIMULATED_LINES = ['Line 1', 'Line 2'];

/** A line and the devices of its start and finish. */
export interface LineDevices {
    name: string;
    enabled: boolean;
    start: string;
    finish: string;
}

let configured: LineDevices[] = [];
// Names of the devices the app listens to
let listening = new Set<string>();
let readyLines = new Set<string>();
const listeners: (() => void)[] = [];

/** The names of the lines, in the order of config.yaml. */
export function getLines(): string[] {
    return SIMULATE_GATES && configured.length === 0 ? SIMULATED_LINES : configured.map((line) => line.name);
}

export function isLine(name: unknown): name is string {
    return typeof name === 'string' && getLines().includes(name);
}

/** Whether a line is enabled in config.yaml (the simulated lines are). */
export function isLineEnabled(name: string): boolean {
    return isLine(name) && (configured.find((line) => line.name === name)?.enabled ?? true);
}

/** Whether both crossings of a line can be recorded. Simulated gates can always be crossed, on an enabled line. */
export function isLineReady(name: string): boolean {
    return SIMULATE_GATES ? isLineEnabled(name) : readyLines.has(name);
}

/** Sets the lines of config.yaml. The listeners are told when the lines or their readiness change. */
export function setConfiguredLines(lines: LineDevices[]): void {
    if (JSON.stringify(lines) === JSON.stringify(configured)) return;
    configured = lines.map((line) => ({ ...line }));
    update(true);
}

/** Sets the devices the app listens to (see setConfiguredLines). */
export function setListeningDevices(names: Iterable<string>): void {
    const next = new Set(names);
    if (next.size === listening.size && [...next].every((name) => listening.has(name))) return;
    listening = next;
    update(false);
}

function update(linesChanged: boolean): void {
    const ready = new Set(
        configured.filter((line) => line.enabled && listening.has(line.start) && listening.has(line.finish)).map((line) => line.name)
    );
    const readyChanged = ready.size !== readyLines.size || [...ready].some((name) => !readyLines.has(name));
    readyLines = ready;
    if (linesChanged || readyChanged) listeners.forEach((listener) => listener());
}

export function onLinesChange(listener: () => void): void {
    listeners.push(listener);
}
