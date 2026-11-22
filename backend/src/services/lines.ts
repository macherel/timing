/**
 * The timing lines of this computer: the enabled lines of config.yaml, set by the hardware service when it loads
 * the file.
 *
 * With simulated gates (TIMING_SIMULATE_GATES=1, for the end-to-end tests and for training without hardware) and no
 * line in config.yaml, two simulated lines are used, so the app can be tried without configuring anything.
 */

// Gate crossings sent over HTTP instead of by the USB gates. Off unless the server is started with
// TIMING_SIMULATE_GATES=1, so it cannot fire during a real race.
export const SIMULATE_GATES = process.env.TIMING_SIMULATE_GATES === '1';
export const SIMULATED_LINES = ['Line 1', 'Line 2'];

let configured: string[] = [];
const listeners: (() => void)[] = [];

/** The names of the lines, in the order of config.yaml. */
export function getLines(): string[] {
    return SIMULATE_GATES && configured.length === 0 ? SIMULATED_LINES : configured;
}

export function isLine(name: unknown): name is string {
    return typeof name === 'string' && getLines().includes(name);
}

/** Sets the enabled lines of config.yaml. The listeners are told when the list changes. */
export function setConfiguredLines(names: string[]): void {
    if (names.join('\n') === configured.join('\n')) return;
    configured = [...names];
    listeners.forEach((listener) => listener());
}

export function onLinesChange(listener: () => void): void {
    listeners.push(listener);
}
