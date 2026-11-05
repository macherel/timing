import type { TriggerRule } from './deviceConfig.js';

/**
 * A trigger rule plus whether its pattern matched in the previous report.
 */
export interface ActiveTrigger extends TriggerRule {
    isMatched: boolean;
}

export interface FiredAction {
    kind: 'press' | 'release';
    action: string;
}

/**
 * Builds the runtime triggers from config rules.
 * Triggers that did not change keep their matched state, so a hot-reload mid-press does not fire twice.
 */
export function mergeTriggers(previous: ActiveTrigger[], rules: TriggerRule[]): ActiveTrigger[] {
    return rules.map((rule) => ({
        ...rule,
        isMatched: previous.find((t) => sameTrigger(t, rule))?.isMatched ?? false,
    }));
}

/**
 * Updates the triggers' matched state from one HID report and returns the actions fired by edges:
 * unmatched -> matched fires `action`, matched -> unmatched fires `releaseAction`.
 */
export function evaluateReport(triggers: ActiveTrigger[], report: Buffer): FiredAction[] {
    const fired: FiredAction[] = [];

    for (const trigger of triggers) {
        // Reports of other collections (other report ID) say nothing about this trigger's state
        if (trigger.reportId !== undefined && report[0] !== trigger.reportId) continue;
        if (trigger.byteIndex >= report.length) continue;

        const isMatched = (report[trigger.byteIndex] & trigger.mask) === trigger.value;
        if (isMatched === trigger.isMatched) continue;

        trigger.isMatched = isMatched;
        if (isMatched && trigger.action) {
            fired.push({ kind: 'press', action: trigger.action });
        } else if (!isMatched && trigger.releaseAction) {
            fired.push({ kind: 'release', action: trigger.releaseAction });
        }
    }
    return fired;
}

function sameTrigger(a: TriggerRule, b: TriggerRule): boolean {
    return (
        a.reportId === b.reportId &&
        a.byteIndex === b.byteIndex &&
        a.mask === b.mask &&
        a.value === b.value &&
        a.action === b.action &&
        a.releaseAction === b.releaseAction
    );
}
