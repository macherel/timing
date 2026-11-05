import HID from 'node-hid';
import { handleRaceEvent } from './raceService.js';
import {
    CONFIG_PATH,
    loadDevicesConfig,
    watchDevicesConfig,
    unwatchDevicesConfig,
    type DevicesConfig,
    type DeviceRule,
} from './hardware/deviceConfig.js';
import {
    assignDevices,
    describeAssignment,
    explainUnmatchedRules,
    getUsbPort,
    groupByPath,
    isActive,
    type DeviceAssignment,
    type HidDevice,
} from './hardware/deviceMatching.js';
import { evaluateReport, mergeTriggers, type ActiveTrigger } from './hardware/triggers.js';
import {
    changedBits,
    describeBitChange,
    describeUsage,
    hexId,
    isOsOwned,
    openFailureHint,
    toHex,
} from './hardware/hidDiagnostics.js';
import { createLogger, errorMessage } from '../utils/logger.js';

const log = createLogger('Hardware');

// node-hid has no plug-in event, so devices are rescanned on a timer. Works the same on Windows and Linux.
const POLL_INTERVAL_MS = 1000;
// A device that keeps failing is retried on every poll, but its error is only re-logged this often
const REPEAT_FAILURE_LOG_EVERY = 60;
// Changed reports kept per connection for the diagnostics page, which polls slower than reports arrive
const RECENT_REPORTS_KEPT = 50;

interface Connection {
    deviceName: string;
    device: HID.HID;
    triggers: ActiveTrigger[];
    logReports: boolean;
    // Several collections share this path, so byte 0 of every report is a report ID
    numberedReports: boolean;
    // Last report per report ID (always key 0 for unnumbered reports), to keep only what changed
    lastReportById: Map<number, Buffer>;
    recentReports: RecentReport[];
    openedAt: Temporal.Instant;
    reportCount: number;
    lastReport?: Buffer;
    lastReportAt?: Temporal.Instant;
}

/** A report that differs from the previous one with the same report ID. */
interface RecentReport {
    at: string;
    reportId: number | null;
    hex: string;
    // e.g. "byte 1 bit 0 ↑ (mask 0x01)"; empty for the first report with this ID
    changes: string[];
}

interface Failure {
    deviceName: string;
    message: string;
    hint: string | null;
    since: Temporal.Instant;
    attempts: number;
}

/**
 * Snapshot of the hardware state, served by GET /api/hardware/status.
 */
export interface HardwareStatus {
    platform: string;
    configPath: string;
    configValid: boolean;
    devices: Array<{
        deviceName: string;
        path: string;
        state: 'listening' | 'failing';
        since: string;
        reportCount?: number;
        numberedReports?: boolean;
        lastReportAt?: string;
        lastReportHex?: string;
        recentReports?: RecentReport[];
        triggers?: Array<ActiveTrigger>;
        error?: string;
        hint?: string;
        attempts?: number;
    }>;
    // Every HID interface seen by the last scan, one entry per path
    interfaces: Array<{
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
    }>;
    lastScanAt: string | null;
    unmatchedRules: string[];
}

// Open interfaces and interfaces that failed to open or read, keyed by OS device path
const connections = new Map<string, Connection>();
const failures = new Map<string, Failure>();

// The config is only reloaded when config.yaml changes, not on every poll
let config: DevicesConfig | null = null;
let configValid = false;
let configDirty = true;

// Last logged device list and unmatched-rule explanations, so they are only logged when they change
let lastLoggedState = '';
let unmatchedRules: string[] = [];

// Result of the last scan, for the status endpoint
let lastSystemDevices: HID.Device[] = [];
let lastAssignments: DeviceAssignment[] = [];
let lastScanAt: Temporal.Instant | null = null;

// Syncs are async, so they are serialized: a request during a running sync queues exactly one follow-up
let serviceRunning = false;
let syncRunning = false;
let syncQueued = false;
let pollTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initHardwareService(): void {
    log.info(`Starting hardware monitor (platform: ${process.platform}, polling every ${POLL_INTERVAL_MS}ms)...`);
    serviceRunning = true;

    requestSync();
    watchDevicesConfig(onConfigChange);
    pollTimer = setInterval(requestSync, POLL_INTERVAL_MS);
}

export function stopHardwareService(): void {
    serviceRunning = false;

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    unwatchDevicesConfig();

    connections.forEach((conn, devicePath) => closeQuietly(conn.device, devicePath));
    connections.clear();
    failures.clear();
    lastSystemDevices = [];
    lastAssignments = [];
    log.info('Stopped.');
}

export function getHardwareStatus(): HardwareStatus {
    const listening = [...connections].map(([path, conn]) => ({
        deviceName: conn.deviceName,
        path,
        state: 'listening' as const,
        since: conn.openedAt.toString(),
        reportCount: conn.reportCount,
        numberedReports: conn.numberedReports,
        lastReportAt: conn.lastReportAt?.toString(),
        lastReportHex: conn.lastReport && toHex(conn.lastReport),
        recentReports: conn.recentReports,
        triggers: conn.triggers,
    }));
    const failing = [...failures].map(([path, failure]) => ({
        deviceName: failure.deviceName,
        path,
        state: 'failing' as const,
        since: failure.since.toString(),
        error: failure.message,
        hint: failure.hint ?? undefined,
        attempts: failure.attempts,
    }));

    return {
        platform: process.platform,
        configPath: CONFIG_PATH,
        configValid,
        devices: [...listening, ...failing],
        interfaces: describeInterfaces(),
        lastScanAt: lastScanAt?.toString() ?? null,
        unmatchedRules,
    };
}

function describeInterfaces(): HardwareStatus['interfaces'] {
    return [...groupByPath(lastSystemDevices)].map(([path, collections]) => {
        const first = collections[0];
        return {
            path,
            vendorId: hexId(first.vendorId),
            productId: hexId(first.productId),
            manufacturer: first.manufacturer ?? '',
            product: first.product ?? '',
            serialNumber: first.serialNumber ?? '',
            usbPort: getUsbPort(path),
            interfaceNumber: first.interface,
            usages: collections.map((c) => describeUsage(c.usagePage, c.usage)),
            osOwned: collections.some(isOsOwned),
            rules: lastAssignments
                .filter((a) => a.device.path === path && a.rule)
                .map(({ rule, conflict }) => ({ name: rule!.name, enabled: rule!.enabled, conflict })),
        };
    });
}

function onConfigChange(): void {
    configDirty = true;
    lastLoggedState = '';
    requestSync();
}

// ---------------------------------------------------------------------------
// Sync scheduling
// ---------------------------------------------------------------------------

/**
 * Starts a sync now, or queues one if a sync is already running.
 */
function requestSync(): void {
    if (!serviceRunning) return;
    if (syncRunning) {
        syncQueued = true;
        return;
    }

    syncRunning = true;
    syncConnectedDevices()
        .catch((error) => log.error('Device sync failed:', error))
        .finally(() => {
            syncRunning = false;
            if (syncQueued) {
                syncQueued = false;
                requestSync();
            }
        });
}

// ---------------------------------------------------------------------------
// Sync: open, update and close connections to match the system and config
// ---------------------------------------------------------------------------

async function syncConnectedDevices(): Promise<void> {
    if (configDirty) {
        configDirty = false;
        const loaded = await loadDevicesConfig();
        configValid = loaded !== null;
        // An invalid file keeps the previous config, so a half-saved edit doesn't drop the devices
        if (loaded) config = loaded;
    }
    if (!config) return;

    let systemDevices: HID.Device[];
    try {
        // Async enumeration keeps the event loop free, so crossings are not delayed
        systemDevices = await HID.devicesAsync();
    } catch (error) {
        log.error('Failed to enumerate HID devices:', errorMessage(error));
        return;
    }
    if (!serviceRunning) return;

    const assignments = assignDevices(config, systemDevices);
    lastSystemDevices = systemDevices;
    lastAssignments = assignments;
    lastScanAt = Temporal.Now.instant();
    const stateChanged = logAssignmentsIfChanged(assignments);
    logUnmatchedRulesIfChanged(explainUnmatchedRules(config, systemDevices, assignments));

    const collectionsByPath = groupByPath(systemDevices);
    const activeAssignments = assignments.filter(isActive);
    for (const { device, rule } of activeAssignments) {
        const conn = connections.get(device.path);
        if (conn) {
            updateConnection(conn, rule, stateChanged);
        } else {
            const numberedReports = (collectionsByPath.get(device.path)?.length ?? 1) > 1;
            openConnection(rule, device, numberedReports);
        }
    }

    const activePaths = new Set(activeAssignments.map((a) => a.device.path));
    closeStaleConnections(activePaths);
    // Unplugged or disabled interfaces start with a clean slate when they come back
    failures.forEach((_, devicePath) => {
        if (!activePaths.has(devicePath)) failures.delete(devicePath);
    });
}

/**
 * Logs the device list when it differs from the last logged one. Returns whether it changed.
 */
function logAssignmentsIfChanged(assignments: DeviceAssignment[]): boolean {
    // Includes triggers so that changes to masks/actions count as a change
    const state = JSON.stringify(
        assignments.map(({ device, usbPort, rule, conflict }) => ({
            path: device.path,
            serial: device.serialNumber,
            usbPort,
            rule,
            conflict,
        }))
    );
    if (state === lastLoggedState) return false;
    lastLoggedState = state;

    log.info(
        `Found ${assignments.length} relevant HID interface(s) on system:\n` +
        (assignments.length > 0 ? assignments.map(describeAssignment).join('\n') : '  (none)')
    );
    return true;
}

function logUnmatchedRulesIfChanged(explanations: string[]): void {
    if (explanations.join('\n') === unmatchedRules.join('\n')) return;
    unmatchedRules = explanations;
    explanations.forEach((explanation) => log.warn(explanation));
}

/**
 * Applies the latest rule to an open connection (config hot-reload).
 */
function updateConnection(conn: Connection, rule: DeviceRule, logIt: boolean): void {
    conn.deviceName = rule.name;
    conn.triggers = mergeTriggers(conn.triggers, rule.triggers ?? []);
    conn.logReports = rule.logReports ?? false;
    if (logIt) log.info(`Updated triggers for "${rule.name}"`);
}

function closeStaleConnections(activePaths: Set<string>): void {
    connections.forEach((conn, devicePath) => {
        if (activePaths.has(devicePath)) return;

        log.info(`Closing disabled/unplugged device "${conn.deviceName}" (${devicePath})`);
        closeQuietly(conn.device, devicePath);
        connections.delete(devicePath);
    });
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * Opens an interface and starts listening to its reports. A failure is recorded and retried on the next poll.
 */
function openConnection(rule: DeviceRule, hidDevice: HidDevice, numberedReports: boolean): void {
    let device: HID.HID;
    try {
        device = new HID.HID(hidDevice.path);
    } catch (error) {
        recordFailure(hidDevice.path, rule.name, errorMessage(error), hidDevice);
        return;
    }

    if (failures.delete(hidDevice.path)) {
        log.info(`"${rule.name}" recovered.`);
    }
    log.info(`Listening to "${rule.name}" at ${hidDevice.path}${rule.logReports ? ' (logging raw reports)' : ''}`);

    const conn: Connection = {
        deviceName: rule.name,
        device,
        triggers: mergeTriggers([], rule.triggers ?? []),
        logReports: rule.logReports ?? false,
        numberedReports,
        lastReportById: new Map(),
        recentReports: [],
        openedAt: Temporal.Now.instant(),
        reportCount: 0,
    };
    connections.set(hidDevice.path, conn);

    device.on('data', (report: Buffer) => onReport(conn, report));
    device.on('error', (error: unknown) => onReadError(conn, hidDevice, error));
}

function onReport(conn: Connection, report: Buffer): void {
    // Taken first, before any logging or race handling, so it is as close as possible to the hardware event
    const instant = Temporal.Now.instant();

    trackReportChanges(conn, report, instant);
    conn.reportCount++;
    conn.lastReport = report;
    conn.lastReportAt = instant;

    for (const { kind, action } of evaluateReport(conn.triggers, report)) {
        log.info(`${kind === 'press' ? 'Pressed' : 'Released'}: ${conn.deviceName} | Action: ${action}`);
        handleRaceEvent(conn.deviceName, conn.deviceName, action, instant);
    }
}

/**
 * Keeps the reports that changed for the diagnostics page, and logs them when `logReports: true`.
 */
function trackReportChanges(conn: Connection, report: Buffer, instant: Temporal.Instant): void {
    const reportId = conn.numberedReports ? report[0] : 0;
    const previous = conn.lastReportById.get(reportId);
    conn.lastReportById.set(reportId, report);

    const changes = changedBits(previous, report);
    if (previous && changes.length === 0) return;

    conn.recentReports.push({
        at: instant.toString(),
        reportId: conn.numberedReports ? reportId : null,
        hex: toHex(report),
        changes: previous ? changes.map(describeBitChange) : [],
    });
    if (conn.recentReports.length > RECENT_REPORTS_KEPT) conn.recentReports.shift();

    if (!conn.logReports) return;
    log.info(
        `[raw] ${conn.deviceName}` +
        (conn.numberedReports ? ` | report ID ${reportId}` : '') +
        ` | ${report.length} bytes | ${toHex(report)}` +
        (previous ? ` | changed: ${changes.map(describeBitChange).join(', ')}` : ' | first report with this ID')
    );
}

function onReadError(conn: Connection, hidDevice: HidDevice, error: unknown): void {
    // A late error from an old handle must not close a newer connection on the same path
    if (connections.get(hidDevice.path) !== conn) return;

    closeQuietly(conn.device, hidDevice.path);
    connections.delete(hidDevice.path);
    // A real unplug makes the device vanish from the next poll; otherwise it is reopened
    recordFailure(hidDevice.path, conn.deviceName, `Read error: ${errorMessage(error)}`, hidDevice);
}

/**
 * Remembers why an interface failed. Logs the first failure, a changed error, and then only periodically.
 */
function recordFailure(devicePath: string, deviceName: string, message: string, hidDevice: HidDevice): void {
    const previous = failures.get(devicePath);
    const attempts = (previous?.attempts ?? 0) + 1;
    const isNew = !previous || previous.message !== message;
    const hint = openFailureHint(hidDevice, message);

    failures.set(devicePath, {
        deviceName,
        message,
        hint,
        since: isNew ? Temporal.Now.instant() : previous.since,
        attempts,
    });

    if (isNew) {
        log.error(`"${deviceName}" failed at ${devicePath}: ${message}` + (hint ? `\n      Hint: ${hint}` : ''));
        log.info(`Will keep retrying every ${POLL_INTERVAL_MS}ms.`);
    } else if (attempts % REPEAT_FAILURE_LOG_EVERY === 0) {
        log.warn(`"${deviceName}" still failing at ${devicePath} after ${attempts} attempts: ${message}`);
    }
}

function closeQuietly(device: HID.HID, devicePath: string): void {
    try {
        device.close();
    } catch (error) {
        // Expected when the device was already unplugged
        log.debug(`Close failed for ${devicePath}:`, errorMessage(error));
    }
}
