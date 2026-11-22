import type { Gate } from '../types/messages.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import { createLogger } from '../utils/logger.js';
import { onCrossing } from './runService.js';

const log = createLogger('Race');

/**
 * Handles a crossing of the start or finish gate of a line, fired by a device button (or a simulated gate).
 * `instant` is when the HID report was received, not when this function runs.
 */
export function handleCrossing(line: string, gate: Gate, deviceName: string, instant: Temporal.Instant): void {
    const timestamp = instant.toString(); // e.g. "2026-11-04T12:15:30.123456789Z"
    log.info(`${line}: ${gate} crossed at ${timestamp} ("${deviceName}")`);
    onCrossing(line, gate, deviceName, instant);
    broadcastToUI({ type: 'RACE_UPDATE', line, gate, deviceName, timestamp });
}
