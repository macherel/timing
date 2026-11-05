import type { CrossingEvent } from '../types/messages.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Race');

// Only actions containing one of these words are recorded as crossings
const RECORDED_ACTION_KEYWORDS = ['start', 'finish', 'click'];

export interface LaneRecord {
    deviceId: string;
    deviceName: string;
    crossings: CrossingEvent[];
}

// Crossing history per lane, kept in memory until resetRace()
const raceLanes = new Map<string, LaneRecord>();

/**
 * Handles an action fired by a hardware trigger.
 * `instant` is when the HID report was received, not when this function runs.
 */
export function handleRaceEvent(laneId: string, laneName: string, action: string, instant: Temporal.Instant): void {
    if (RECORDED_ACTION_KEYWORDS.some((keyword) => action.includes(keyword))) {
        recordCrossing(laneId, laneName, action, instant);
    }
}

/**
 * Returns the full timing results for all lanes.
 */
export function getRaceResults(): LaneRecord[] {
    return Array.from(raceLanes.values());
}

/**
 * Resets all recorded race times.
 */
export function resetRace(): void {
    raceLanes.clear();
    log.info('Race results reset.');
}

function recordCrossing(laneId: string, laneName: string, action: string, instant: Temporal.Instant): void {
    let lane = raceLanes.get(laneId);
    if (!lane) {
        lane = { deviceId: laneId, deviceName: laneName, crossings: [] };
        raceLanes.set(laneId, lane);
    }

    const timestamp = instant.toString(); // e.g. "2026-11-04T12:15:30.123456789Z"
    lane.crossings.push({ action, timestamp });
    log.info(`Lane "${laneName}" recorded [${action}] at ${timestamp}`);

    broadcastToUI({
        type: 'RACE_UPDATE',
        deviceId: laneId,
        deviceName: laneName,
        action,
        timestamp,
        allCrossings: lane.crossings,
    });
}
