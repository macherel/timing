/**
 * Messages and API payloads from the backend.
 * Keep in sync with backend/src/types/messages.ts and HardwareStatus in backend/src/services/hardwareService.ts.
 */

export interface CrossingEvent {
  action: string;
  timestamp: string; // ISO 8601, nanosecond precision
}

export interface RaceUpdateMessage {
  type: 'RACE_UPDATE';
  deviceId: string;
  deviceName: string;
  action: string;
  timestamp: string;
  allCrossings: CrossingEvent[];
}

/** The timed run: idle, ready (waiting for a start crossing) or running (waiting for a finish crossing). */
export type RunState =
  | { status: 'idle' }
  | { status: 'ready'; event: string; discipline: string; participant: Participant }
  | { status: 'running'; event: string; discipline: string; participant: Participant; startedAt: string };

/** Only ok runs count. invalid: not the participant's fault (e.g. timing problem); dq: disqualified */
export type RunStatus = 'ok' | 'invalid' | 'dq';

/** A finished or disqualified run, as saved in <event>/<discipline>/results.csv */
export interface RunResult {
  bib: string;
  name: string;
  start: string;
  // null when the run was ended before the finish (invalidated or disqualified)
  finish: string | null;
  timeMs: number | null;
  status: RunStatus;
}

export interface RunUpdateMessage {
  type: 'RUN_UPDATE';
  run: RunState;
}

export interface RunResultMessage {
  type: 'RUN_RESULT';
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
  // Event and discipline open on its race pages
  // What its race pages show, with the participant selected there (null or missing: none)
  viewing: { event: string; discipline: string; participant?: { bib: string; name: string } | null }[];
  run: RunState;
  // The last run it ended, until the next participant is ready
  lastResult: { event: string; discipline: string; result: RunResult; endedAt: string } | null;
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
  | RunResultMessage
  | ResultUpdateMessage
  | SettingsUpdateMessage;

export interface TriggerState {
  reportId?: number;
  byteIndex: number;
  mask: number;
  value: number;
  action?: string;
  releaseAction?: string;
  isMatched: boolean;
}

export interface RecentReport {
  at: string;
  reportId: number | null;
  hex: string;
  changes: string[];
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
  rules: Array<{ name: string; enabled: boolean; conflict: boolean }>;
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
export interface TriggerRule {
  reportId?: number;
  byteIndex: number;
  mask: number;
  value: number;
  action?: string;
  releaseAction?: string;
}

export interface DeviceRule {
  name: string;
  vendorId: number;
  productId: number;
  usagePage?: number;
  usage?: number;
  serialNumber?: string;
  usbPort?: string;
  enabled: boolean;
  logReports?: boolean;
  triggers?: TriggerRule[];
}

export interface DevicesConfig {
  // Port of the app, used when it starts
  port?: number;
  // Sync with the computers on the local network that have the same key
  sync?: { key: string | number; name?: string };
  discoveryFilter?: { usagePage: number; usage: number };
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
}

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
