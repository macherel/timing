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

/**
 * Status of a saved run. Only `ok` runs count:
 *   invalid: the run does not count, without the participant being at fault (e.g. timing problem)
 *   dq: the participant is disqualified for this run
 */
export type RunStatus = 'ok' | 'invalid' | 'dq';

/** A finished or disqualified run, as saved in results.csv. */
export interface RunResult {
    bib: string;
    name: string;
    start: string;          // Temporal.Instant as ISO 8601
    finish: string | null;  // null when the run was ended before the finish (invalidated or disqualified)
    timeMs: number | null;  // Finish - start, rounded to the millisecond. null when the run was ended before the finish (invalidated or disqualified)
    status: RunStatus;
}

/** Sent to every frontend client each time the run state changes. */
export interface RunUpdateMessage {
    type: 'RUN_UPDATE';
    run: RunState;
}

/** Sent to every frontend client when a run finishes or the participant is disqualified. */
export interface RunResultMessage {
    type: 'RUN_RESULT';
    event: string;
    discipline: string;
    result: RunResult;
}

/** Sent to every frontend client when the status of a saved result changes. */
export interface ResultUpdateMessage {
    type: 'RESULT_UPDATE';
    event: string;
    discipline: string;
    result: RunResult;
}

/**
 * Every message the backend pushes over the WebSocket.
 */
/** Sent to every frontend client when the settings of a discipline are saved from the race page. */
export interface SettingsUpdateMessage {
    type: 'SETTINGS_UPDATE';
    event: string;
    discipline: string;
    settings: { attempts: number | null; start: string | null; end: string | null; access: 'auto' | 'open' | 'locked' };
}

/** Sent to every frontend client when files of a discipline were changed by the sync with another computer. */
export interface SyncUpdateMessage {
    type: 'SYNC_UPDATE';
    event: string;
    discipline: string;
}

/** What an instance is doing, shown on the live pages of every synced computer. */
export interface Activity {
    // Event and discipline open on its race pages (several browsers may show different ones)
    viewing: { event: string; discipline: string }[];
    run: RunState;
    // The last run it ended, shown until the next participant is ready
    lastResult: { event: string; discipline: string; result: RunResult; endedAt: string } | null;
}

/** An instance on the live page: this computer or a synced one. */
export interface LiveInstance extends Activity {
    id: string;
    name: string;
    self: boolean;
    // Its clock minus this computer's clock, in ms, to show its running clock right
    clockOffsetMs: number;
}

/** Sent to every frontend client when the activity of this computer or of a synced one changes. */
export interface LiveUpdateMessage {
    type: 'LIVE_UPDATE';
    instances: LiveInstance[];
}

/** Messages a page sends to its backend. VIEWING: the event and discipline its race page shows (null: none). */
export type ClientMessage = { type: 'VIEWING'; event: string | null; discipline: string | null };

export type ServerMessage =
    | LiveUpdateMessage
    | SyncUpdateMessage
    | RaceUpdateMessage
    | RunUpdateMessage
    | RunResultMessage
    | ResultUpdateMessage
    | SettingsUpdateMessage;
