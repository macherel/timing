import { enabledLines, GATES, type DevicesConfig, type Gate, type ReportPattern } from './deviceConfig.js';

/**
 * The gate of a line on a device: its button pattern, and the edge of the pattern that records a crossing.
 */
export interface GateTrigger extends ReportPattern {
    line: string;
    gate: Gate;
    edge: 'press' | 'release';
}

/**
 * A gate trigger plus whether its pattern matched in the previous report.
 */
export interface ActiveTrigger extends GateTrigger {
    isMatched: boolean;
}

/** The gates of the enabled lines that use a device, in the order of the lines. */
export function gateTriggers(config: DevicesConfig, deviceName: string): GateTrigger[] {
    return enabledLines(config).flatMap((line) =>
        GATES.filter((gate) => line[gate].device === deviceName).map((gate) => {
            const { reportId, byteIndex, mask, value, edge } = line[gate];
            return { line: line.name, gate, edge: edge ?? 'press', byteIndex, mask, value, ...(reportId !== undefined && { reportId }) };
        })
    );
}

/**
 * Builds the runtime triggers from the gates of the lines.
 * A pattern that was already watched keeps its matched state (the button is pressed or not, whatever line it is
 * for), so a config reload while a button is held does not fire it again.
 */
export function mergeTriggers(previous: ActiveTrigger[], triggers: GateTrigger[]): ActiveTrigger[] {
    return triggers.map((trigger) => ({
        ...trigger,
        isMatched: previous.find((t) => samePattern(t, trigger))?.isMatched ?? false,
    }));
}

/**
 * Updates the triggers' matched state from one HID report and returns the triggers fired by an edge: unmatched ->
 * matched fires the press triggers, matched -> unmatched the release ones.
 */
export function evaluateReport(triggers: ActiveTrigger[], report: Buffer): ActiveTrigger[] {
    const fired: ActiveTrigger[] = [];

    for (const trigger of triggers) {
        // Reports of other collections (other report ID) say nothing about this trigger's state
        if (trigger.reportId !== undefined && report[0] !== trigger.reportId) continue;
        if (trigger.byteIndex >= report.length) continue;

        const isMatched = (report[trigger.byteIndex] & trigger.mask) === trigger.value;
        if (isMatched === trigger.isMatched) continue;

        trigger.isMatched = isMatched;
        if (isMatched === (trigger.edge === 'press')) fired.push(trigger);
    }
    return fired;
}

function samePattern(a: ReportPattern, b: ReportPattern): boolean {
    return a.reportId === b.reportId && a.byteIndex === b.byteIndex && a.mask === b.mask && a.value === b.value;
}
