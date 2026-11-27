export type Gate = 'start' | 'finish';

/**
 * Sent to every frontend client each time a gate of a line is crossed (whether or not a run uses it).
 */
export interface RaceUpdateMessage {
    type: 'RACE_UPDATE';
    line: string;
    gate: Gate;
    deviceName: string; // The device whose button fired, "Simulator" for the simulated gates, "Keyboard" for the space bar
    timestamp: string;  // Temporal.Instant as ISO 8601, nanosecond precision
}

/** Participant of a run, as listed in the discipline's CSV files. */
export interface RunParticipant {
    bib: string;
    name: string;
    category: string;
}

/**
 * The timed run of a line: idle, ready (waiting for a start crossing) or running (waiting for a finish crossing).
 * In a discipline that measures a distance, the participant is ready with the distance typed by the operator
 * (`distanceCm`, in centimetres), until the operator says whether it is valid: there is no running state.
 */
export type RunState =
    | { status: 'idle' }
    | { status: 'ready'; event: string; discipline: string; participant: RunParticipant; distanceCm?: number }
    | { status: 'running'; event: string; discipline: string; participant: RunParticipant; startedAt: string };

/**
 * Status of a saved run. Only `ok` runs count:
 *   invalid: the run does not count, without the participant being at fault (e.g. timing problem)
 *   dq: the participant is disqualified for this run
 */
export type RunStatus = 'ok' | 'invalid' | 'dq';

/** A finished or disqualified run, as saved in the results file. */
export interface RunResult {
    bib: string;
    name: string;
    start: string;          // Temporal.Instant as ISO 8601
    finish: string | null;  // null when the run was ended before the finish (invalidated or disqualified)
    timeMs: number | null;  // Finish - start in milliseconds, with the precision and rounding of the discipline settings. null when the run was ended before the finish (invalidated or disqualified), and in a discipline that measures a distance
    distanceCm: number | null; // The distance typed by the operator in centimetres. null in a discipline that measures a time
    status: RunStatus;
    computer: string | null; // The computer that timed the run, null for a run saved before this was recorded
    line: string | null;     // The line of that computer that timed the run, null for a run saved before this was recorded
}

/** The last run a line ended, shown on the live pages until the next participant is ready on it. */
export interface LastResult {
    event: string;
    discipline: string;
    result: RunResult;
    endedAt: string;
}

/** A line of this computer and its run. */
export interface LineRun {
    line: string;
    // Whether the line is enabled in config.yaml: a disabled line is listed, but never ready
    enabled: boolean;
    // Whether the line is enabled and the app listens to the devices of its start and finish (always for an enabled
    // line with simulated gates, and for the manual line)
    ready: boolean;
    // Whether it is the manual line, that times the disciplines timed by hand, with the space bar of the race page
    manual: boolean;
    run: RunState;
    lastResult: LastResult | null;
}

/** Sent to every frontend client each time the run state of a line changes. */
export interface RunUpdateMessage {
    type: 'RUN_UPDATE';
    line: string;
    run: RunState;
}

/** Sent to every frontend client when the lines of this computer change (config.yaml). */
export interface LinesUpdateMessage {
    type: 'LINES_UPDATE';
    lines: LineRun[];
}

/** Sent to every frontend client when a run finishes or the participant is disqualified. */
export interface RunResultMessage {
    type: 'RUN_RESULT';
    line: string;
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
    settings: { measure: 'time' | 'distance'; attempts: number | null; attemptsPerDistance: number | null; minDistance: number | null; allowDistanceChange: boolean; start: string | null; end: string | null; access: 'auto' | 'open' | 'locked'; best: 'shortest' | 'longest';
        precision: 'second' | 'tenth' | 'hundredth' | 'thousandth'; rounding: 'truncate' | 'nearest' | 'up'; recentRuns: number; resultRows: number;
        trigger: 'gates' | 'keyboard'; triggerKey: string };
}

/** Sent to every frontend client when files of a discipline were changed by the sync with another computer, or uploaded. */
export interface SyncUpdateMessage {
    type: 'SYNC_UPDATE';
    event: string;
    discipline: string;
}

/** Sent to every frontend client when an event or discipline is created from a page. */
export interface EventsUpdateMessage {
    type: 'EVENTS_UPDATE';
}

/** What an instance is doing, shown on the live pages of every synced computer. */
export interface Viewing {
    event: string;
    discipline: string;
    // The line the race page times on (null: none)
    line: string | null;
    participant: { bib: string; name: string } | null;
}

export interface Activity {
    // Event, discipline and line open on its race pages (several browsers may show different ones), with the
    // participant selected there, before they are ready (null: none)
    viewing: Viewing[];
    // Its lines, each with its run and the last run it ended
    lines: LineRun[];
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

/**
 * Messages a page sends to its backend. VIEWING: the event and discipline its race page shows (null: none), the line
 * it times on and the participant selected there (null: none).
 */
export type ClientMessage = {
    type: 'VIEWING';
    event: string | null;
    discipline: string | null;
    line: string | null;
    participant: { bib: string; name: string } | null;
};

export type ServerMessage =
    | LiveUpdateMessage
    | SyncUpdateMessage
    | EventsUpdateMessage
    | RaceUpdateMessage
    | RunUpdateMessage
    | LinesUpdateMessage
    | RunResultMessage
    | ResultUpdateMessage
    | SettingsUpdateMessage;
