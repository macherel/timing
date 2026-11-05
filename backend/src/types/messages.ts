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

/** Participant of a run, as listed in the discipline's CSV files. */
export interface RunParticipant {
    bib: string;
    name: string;
    file: string;
}

/**
 * The timed run: idle, ready (waiting for a start crossing) or running (waiting for a finish crossing).
 */
export type RunState =
    | { status: 'idle' }
    | { status: 'ready'; event: string; discipline: string; participant: RunParticipant }
    | { status: 'running'; event: string; discipline: string; participant: RunParticipant; startedAt: string };

/** A finished run, as saved in results.csv. */
export interface RunResult {
    bib: string;
    name: string;
    start: string;   // Temporal.Instant as ISO 8601
    finish: string;
    timeMs: number;  // Finish - start, rounded to the millisecond
}

/** Sent to every frontend client each time the run state changes. */
export interface RunUpdateMessage {
    type: 'RUN_UPDATE';
    run: RunState;
}

/** Sent to every frontend client when a run finishes. */
export interface RunResultMessage {
    type: 'RUN_RESULT';
    event: string;
    discipline: string;
    result: RunResult;
}

/**
 * Every message the backend pushes over the WebSocket.
 */
export type ServerMessage = RaceUpdateMessage | RunUpdateMessage | RunResultMessage;
