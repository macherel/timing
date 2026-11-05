/**
 * One recorded line crossing for a lane.
 */
export interface CrossingEvent {
    action: string;     // e.g. 'start_crossed' or 'finish_crossed'
    timestamp: string;  // Temporal.Instant as ISO 8601, nanosecond precision
}

/**
 * Sent to every frontend client each time a crossing is recorded.
 */
export interface RaceUpdateMessage {
    type: 'RACE_UPDATE';
    deviceId: string;   // Lane ID (the device rule name in config.yaml)
    deviceName: string;
    action: string;
    timestamp: string;
    allCrossings: CrossingEvent[];
}

/**
 * Every message the backend pushes over the WebSocket.
 */
export type ServerMessage = RaceUpdateMessage;
