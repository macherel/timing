/**
 * Messages and API payloads from the backend.
 * Keep in sync with backend/src/types/messages.ts and HardwareStatus in backend/src/services/hardwareService.ts.
 */

export type Gate = 'start' | 'finish';

/** A gate of a line was crossed (whether or not a run uses it) */
export interface RaceUpdateMessage {
  type: 'RACE_UPDATE';
  line: string;
  gate: Gate;
  // The device whose button fired, "Simulator" for the simulated gates
  deviceName: string;
  timestamp: string; // ISO 8601, nanosecond precision
}

/** The timed run of a line: idle, ready (waiting for a start crossing) or running (waiting for a finish crossing). */
export type RunState =
  | { status: 'idle' }
  | { status: 'ready'; event: string; discipline: string; participant: Participant }
  | { status: 'running'; event: string; discipline: string; participant: Participant; startedAt: string };

/** Only ok runs count. invalid: not the participant's fault (e.g. timing problem); dq: disqualified */
export type RunStatus = 'ok' | 'invalid' | 'dq';

/** A finished or disqualified run, as saved in <event>/<discipline>/<event>-<discipline>-results.csv */
export interface RunResult {
  bib: string;
  name: string;
  start: string;
  // null when the run was ended before the finish (invalidated or disqualified)
  finish: string | null;
  timeMs: number | null;
  status: RunStatus;
  // The computer and its line that timed the run, null for a run saved before they were recorded
  computer: string | null;
  line: string | null;
}

/** The last run a line ended, until the next participant is ready on it */
export interface LastResult {
  event: string;
  discipline: string;
  result: RunResult;
  endedAt: string;
}

/** GET /api/lines: the name of this computer and its lines */
export interface LinesResponse {
  // As written in the computer column of the results file
  computer: string;
  lines: LineRun[];
}

/** A line of a computer and its run (GET /api/lines) */
export interface LineRun {
  line: string;
  // Whether the line is enabled in config.yaml: a disabled line is listed, but never ready
  enabled: boolean;
  // Whether the line is enabled and the app listens to the devices of its start and finish
  ready: boolean;
  run: RunState;
  lastResult: LastResult | null;
}

export interface RunUpdateMessage {
  type: 'RUN_UPDATE';
  line: string;
  run: RunState;
}

/** The lines of this computer changed (config.yaml) */
export interface LinesUpdateMessage {
  type: 'LINES_UPDATE';
  lines: LineRun[];
}

export interface RunResultMessage {
  type: 'RUN_RESULT';
  line: string;
  event: string;
  discipline: string;
  result: RunResult;
}

export interface ResultUpdateMessage {
  type: 'RESULT_UPDATE';
  event: string;
  discipline: string;
  result: RunResult;
}

export interface SettingsUpdateMessage {
  type: 'SETTINGS_UPDATE';
  event: string;
  discipline: string;
  settings: DisciplineSettings;
}

/** Files of a discipline were changed by the sync with another computer */
export interface SyncUpdateMessage {
  type: 'SYNC_UPDATE';
  event: string;
  discipline: string;
}

/** GET /api/sync */
export interface SyncStatus {
  enabled: boolean;
  name: string | null;
  peers: {
    name: string;
    address: string;
    port: number;
    lastSeen: string;
    lastSyncAt: string | null;
    error: string | null;
    // Peer clock minus this computer's clock, in ms
    clockOffsetMs: number | null;
  }[];
}

/** What an instance is doing (keep in sync with backend/src/types/messages.ts) */
export interface Activity {
  // What its race pages show: event, discipline, the line they time on and the participant selected there (null: none)
  viewing: { event: string; discipline: string; line: string | null; participant: { bib: string; name: string } | null }[];
  // Its lines, each with its run and the last run it ended
  lines: LineRun[];
}

/** GET /api/live: this computer and the synced ones */
export interface LiveInstance extends Activity {
  id: string;
  name: string;
  self: boolean;
  // Its clock minus this computer's clock, in ms
  clockOffsetMs: number;
}

export interface LiveUpdateMessage {
  type: 'LIVE_UPDATE';
  instances: LiveInstance[];
}

export type ServerMessage =
  | LiveUpdateMessage
  | SyncUpdateMessage
  | RaceUpdateMessage
  | RunUpdateMessage
  | LinesUpdateMessage
  | RunResultMessage
  | ResultUpdateMessage
  | SettingsUpdateMessage;

/** A gate of a line on an open device */
export interface TriggerState extends ReportPattern {
  line: string;
  gate: Gate;
  edge: 'press' | 'release';
  isMatched: boolean;
}

export interface RecentReport {
  at: string;
  reportId: number | null;
  hex: string;
  changes: string[];
  // The same changes; empty for the first report with this report ID
  bits: { byteIndex: number; bit: number; isSet: boolean }[];
}

export interface DeviceStatus {
  deviceName: string;
  path: string;
  state: 'listening' | 'failing';
  since: string;
  reportCount?: number;
  numberedReports?: boolean;
  lastReportAt?: string;
  lastReportHex?: string;
  recentReports?: RecentReport[];
  triggers?: TriggerState[];
  error?: string;
  hint?: string;
  attempts?: number;
}

/** Reports of an interface opened only for the diagnostics page (its device is not in the configuration) */
export interface MonitorStatus {
  state: 'listening' | 'failing';
  since: string;
  reportCount?: number;
  numberedReports?: boolean;
  lastReportAt?: string;
  lastReportHex?: string;
  recentReports?: RecentReport[];
  error?: string;
  hint?: string;
  attempts?: number;
}

export interface HidInterface {
  path: string;
  vendorId: string;
  productId: string;
  manufacturer: string;
  product: string;
  serialNumber: string;
  usbPort: string | null;
  interfaceNumber: number;
  usages: string[];
  osOwned: boolean;
  // usb: read over USB with libusb, because the OS HID driver does not handle it (e.g. WinUSB installed with Zadig)
  transport: 'hid' | 'usb';
  // used: an enabled line uses the device
  rules: Array<{ name: string; used: boolean; conflict: boolean }>;
  // Set while the diagnostics page asks for this device (GET /api/hardware/status?monitor=vid:pid)
  monitor?: MonitorStatus;
}

export interface HardwareStatus {
  platform: string;
  configPath: string;
  configValid: boolean;
  devices: DeviceStatus[];
  interfaces: HidInterface[];
  lastScanAt: string | null;
  unmatchedRules: string[];
}

/** config.yaml content. Keep in sync with backend/src/services/hardware/deviceConfig.ts. */
/** A button: pressed while (report[byteIndex] & mask) == value */
export interface ReportPattern {
  reportId?: number;
  byteIndex: number;
  mask: number;
  value: number;
}

/** The device button that starts or finishes a line */
export interface GateRule extends ReportPattern {
  device: string;
  // When the crossing is recorded: when the button is pressed (default) or released
  edge?: 'press' | 'release';
}

export interface LineRule {
  name: string;
  enabled: boolean;
  start: GateRule;
  finish: GateRule;
}

export interface DeviceRule {
  name: string;
  vendorId: number;
  productId: number;
  usagePage?: number;
  usage?: number;
  serialNumber?: string;
  usbPort?: string;
  logReports?: boolean;
}

export interface DevicesConfig {
  // Port of the app, used when it starts
  port?: number;
  // Sync with the computers on the local network that have the same key
  sync?: { key: string | number; name?: string };
  // Hides the administration pages and the discipline settings until it is typed
  adminPassword?: string;
  discoveryFilter?: { usagePage: number; usage: number };
  // Missing in a file without lines
  lines?: LineRule[];
  devices: DeviceRule[];
}

/** GET /api/config */
export interface ConfigFileResponse {
  path: string;
  modifiedAt: number | null;
  // null when the file is missing or invalid
  config: DevicesConfig | null;
  problems: string[];
  // Raw text, only sent when the file exists but is invalid
  content?: string | null;
}

/** GET /api/events. Keep in sync with backend/src/services/eventService.ts. */
export interface EventSummary {
  name: string;
  disciplines: string[];
}

export interface EventsResponse {
  workDir: string;
  events: EventSummary[];
}

export interface Participant {
  bib: string;
  name: string;
  // CSV file name without extension, e.g. the category
  file: string;
}

/** GET /api/events/:event/:discipline/participants */
/** Settings of a discipline, from its config.yaml (in the discipline folder) */
export interface DisciplineSettings {
  // Runs allowed per participant (invalid runs do not count). null: unlimited
  attempts: number | null;
  // Period when runs can be timed and results changed, from start (included) to end (excluded), as ISO 8601
  // date-times in UTC, e.g. 2026-11-05T07:00Z. null: no limit on that side
  start: string | null;
  end: string | null;
  // auto: follow the start - end period; open: always (ignores the period); locked: never (results are final)
  access: 'auto' | 'open' | 'locked';
  // Which time is the best: the shortest (a race) or the longest (a slow race, the slowest participant wins)
  best: 'shortest' | 'longest';
  // Unit of the times, and how the exact time is brought to it: truncated, to the nearest (a half goes up) or up.
  // The times of the results already have them
  precision: Precision;
  rounding: 'truncate' | 'nearest' | 'up';
  // How many of the last runs of a line the race page shows (0: none)
  recentRuns: number;
}

export type Precision = 'second' | 'tenth' | 'hundredth' | 'thousandth';

export interface ParticipantsResponse {
  participants: Participant[];
  settings: DisciplineSettings;
  // Ignored settings and skipped CSV rows, and why
  problems: string[];
}

/** GET /api/events/:event/:discipline/results */
export interface ResultsResponse {
  results: RunResult[];
}
