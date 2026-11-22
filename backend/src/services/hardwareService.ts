import type { EventEmitter } from 'events';
import HID from 'node-hid';
import { handleCrossing } from './raceService.js';
import { isAnyRunActive } from './runService.js';
import { setConfiguredLines } from './lines.js';
import {
    CONFIG_PATH,
    enabledLines,
    loadDevicesConfig,
    parseDevicesConfig,
    readDevicesConfigFile,
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
import { evaluateReport, gateTriggers, mergeTriggers, type ActiveTrigger, type GateTrigger } from './hardware/triggers.js';
import {
    type BitChange,
    changedBits,
    describeBitChange,
    describeUsage,
    hexId,
    isOsOwned,
    openFailureHint,
    toHex,
} from './hardware/hidDiagnostics.js';
import { isUsbPath, scanUsbHidInterfaces, UsbHidReader, type UsbHidInterface } from './hardware/usbHid.js';
import { createLogger, errorMessage } from '../utils/logger.js';

const log = createLogger('Hardware');

// node-hid has no plug-in event, so devices are rescanned on a timer. Works the same on Windows and Linux.
const POLL_INTERVAL_MS = 1000;
// A device that keeps failing is retried on every poll, but its error is only re-logged this often
const REPEAT_FAILURE_LOG_EVERY = 60;
// Changed reports kept per connection for the diagnostics page, which polls slower than reports arrive
const RECENT_REPORTS_KEPT = 50;
// A device that is not in the configuration is only opened while the diagnostics page shows it: each status
// request asking for it keeps it open this long
const MONITOR_LEASE_MS = 5000;
// Listing USB devices blocks the event loop for a moment on Windows, which would delay crossing timestamps. So the
// interfaces read with libusb are only looked for this often, only when something may be missing (an enabled rule
// without its device, a failing libusb interface, or an open diagnostics page), and never during a run.
const USB_SCAN_INTERVAL_MS = 3000;

/** An open interface: node-hid, or libusb for the interfaces the OS HID driver does not handle (WinUSB). */
type ReportSource = EventEmitter & { close(): void };

interface Connection {
    deviceName: string;
    device: ReportSource;
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
    // The same changes, to find which button was pressed (configuration page)
    bits: BitChange[];
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
    // Every HID interface seen by the last scan, one entry per path. `monitor` is set on the interfaces opened
    // only for the diagnostics page (see the `monitor` parameter of getHardwareStatus)
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
        // usb: read with libusb, because the OS HID driver does not handle it (e.g. WinUSB installed with Zadig)
        transport: 'hid' | 'usb';
        // used: an enabled line uses the rule
        rules: Array<{ name: string; used: boolean; conflict: boolean }>;
        monitor?: MonitorStatus;
    }>;
    lastScanAt: string | null;
    unmatchedRules: string[];
}

/** Reports of an interface opened for the diagnostics page only (no rule, so no trigger). */
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

// Open interfaces and interfaces that failed to open or read, keyed by OS device path
const connections = new Map<string, Connection>();
const failures = new Map<string, Failure>();
// Same for the interfaces opened only for the diagnostics page: they never fire race events
const monitors = new Map<string, Connection>();
const monitorFailures = new Map<string, Failure>();
// Device models (e.g. "0x046d:0xc548") the diagnostics page asked to monitor -> end of the lease, in ms
const monitorLeases = new Map<string, number>();

// USB HID interfaces read with libusb, from the last USB scan
let usbInterfaces: UsbHidInterface[] = [];
let lastUsbScanAt = 0;
let usbScanRequested = true;
let lastStatusRequestAt = 0;

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
    monitors.forEach((conn, devicePath) => closeQuietly(conn.device, devicePath));
    monitors.clear();
    monitorFailures.clear();
    monitorLeases.clear();
    usbInterfaces = [];
    usbScanRequested = true;
    lastSystemDevices = [];
    lastAssignments = [];
    log.info('Stopped.');
}

/**
 * @param monitor Device models ("0x046d:0xc548") to open even though no rule uses them, so that the diagnostics
 *   page can show their reports. They stay open while the page keeps asking, and close MONITOR_LEASE_MS after.
 */
export function getHardwareStatus(monitor: string[] = []): HardwareStatus {
    lastStatusRequestAt = Date.now();
    renewMonitorLeases(monitor);

    const listening = [...connections].map(([path, conn]) => ({
        deviceName: conn.deviceName,
        path,
        ...describeListening(conn),
        triggers: conn.triggers,
    }));
    const failing = [...failures].map(([path, failure]) => ({
        deviceName: failure.deviceName,
        path,
        ...describeFailure(failure),
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

function describeListening(conn: Connection) {
    return {
        state: 'listening' as const,
        since: conn.openedAt.toString(),
        reportCount: conn.reportCount,
        numberedReports: conn.numberedReports,
        lastReportAt: conn.lastReportAt?.toString(),
        lastReportHex: conn.lastReport && toHex(conn.lastReport),
        recentReports: conn.recentReports,
    };
}

function describeFailure(failure: Failure) {
    return {
        state: 'failing' as const,
        since: failure.since.toString(),
        error: failure.message,
        hint: failure.hint ?? undefined,
        attempts: failure.attempts,
    };
}

function describeMonitor(path: string): MonitorStatus | undefined {
    const conn = monitors.get(path);
    if (conn) return describeListening(conn);
    const failure = monitorFailures.get(path);
    return failure && describeFailure(failure);
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
            transport: isUsbPath(path) ? ('usb' as const) : ('hid' as const),
            interfaceNumber: first.interface,
            usages: collections.map((c) => describeUsage(c.usagePage, c.usage)),
            // The OS no longer owns a mouse whose interface is read with libusb
            osOwned: !isUsbPath(path) && collections.some(isOsOwned),
            rules: lastAssignments
                .filter((a) => a.device.path === path && a.rule)
                .map(({ rule, used, conflict }) => ({ name: rule!.name, used, conflict })),
            monitor: describeMonitor(path),
        };
    });
}

/** Same format as HardwareStatus['interfaces'][number].vendorId/productId. */
function modelKey(device: Pick<HID.Device, 'vendorId' | 'productId'>): string {
    return `${hexId(device.vendorId)}:${hexId(device.productId)}`;
}

function renewMonitorLeases(models: string[]): void {
    const until = Date.now() + MONITOR_LEASE_MS;
    let isNew = false;
    for (const model of models) {
        const key = model.trim().toLowerCase();
        if (!/^0x[0-9a-f]{4}:0x[0-9a-f]{4}$/.test(key)) continue;
        if (!monitorLeases.has(key)) isNew = true;
        monitorLeases.set(key, until);
    }
    // Opens a newly asked device now rather than on the next poll
    if (isNew) requestSync();
}

/**
 * Reads config.yaml now, a missing file meaning no line and no device (simulated gates only, see api.ts: the
 * end-to-end tests start each test from the config.yaml of its working directory).
 */
export async function reloadDevicesConfig(): Promise<void> {
    const { content } = await readDevicesConfigFile();
    const loaded = content === null ? { devices: [] } : parseDevicesConfig(content).config;
    configValid = loaded !== null;
    // Unchanged: nothing to reopen, and no USB scan (it can block the event loop for a while)
    if (!loaded || JSON.stringify(loaded) === JSON.stringify(config)) return;
    applyConfig(loaded);
    lastLoggedState = '';
    usbScanRequested = true;
    requestSync();
}

function applyConfig(loaded: DevicesConfig): void {
    config = loaded;
    setConfiguredLines(enabledLines(loaded).map((line) => line.name));
}

function onConfigChange(): void {
    configDirty = true;
    usbScanRequested = true;
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
        if (loaded) applyConfig(loaded);
    }
    if (!config) return;

    let hidDevices: HID.Device[];
    try {
        // Async enumeration keeps the event loop free, so crossings are not delayed
        hidDevices = await HID.devicesAsync();
    } catch (error) {
        log.error('Failed to enumerate HID devices:', errorMessage(error));
        return;
    }
    if (!serviceRunning) return;

    if (isUsbScanDue()) {
        usbScanRequested = false;
        lastUsbScanAt = Date.now();
        usbInterfaces = await scanUsbHidInterfaces(hidDevices);
        if (!serviceRunning) return;
    }
    // The interfaces read with libusb are matched to rules like the others
    const systemDevices = [...hidDevices, ...usbInterfaces.flatMap((u) => u.entries)];

    const assignments = assignDevices(config, systemDevices);
    lastSystemDevices = systemDevices;
    lastAssignments = assignments;
    lastScanAt = Temporal.Now.instant();
    const stateChanged = logAssignmentsIfChanged(assignments, config.lines);
    logUnmatchedRulesIfChanged(explainUnmatchedRules(config, systemDevices, assignments));

    const collectionsByPath = groupByPath(systemDevices);
    const activeAssignments = assignments.filter(isActive);
    const activePaths = new Set(activeAssignments.map((a) => a.device.path));
    // Before opening the configured interfaces, so that one is never open twice (exclusive on some systems)
    syncMonitors(collectionsByPath, activePaths);

    for (const { device, rule } of activeAssignments) {
        const conn = connections.get(device.path);
        if (conn) {
            updateConnection(conn, rule, gateTriggers(config, rule.name), stateChanged);
        } else {
            openConnection(rule, gateTriggers(config, rule.name), device, hasNumberedReports(device.path, collectionsByPath));
        }
    }

    closeStaleConnections(activePaths);
    // Unplugged or disabled interfaces start with a clean slate when they come back
    failures.forEach((_, devicePath) => {
        if (!activePaths.has(devicePath)) failures.delete(devicePath);
    });
}

/**
 * Opens the interfaces of the device models the diagnostics page asked for, except those a rule already uses,
 * and closes the monitors that are no longer asked for, unplugged, or now used by a rule.
 */
function syncMonitors(collectionsByPath: Map<string, HID.Device[]>, activePaths: Set<string>): void {
    const now = Date.now();
    monitorLeases.forEach((until, model) => {
        if (until <= now) monitorLeases.delete(model);
    });

    const wanted = new Map<string, HID.Device[]>();
    collectionsByPath.forEach((collections, devicePath) => {
        if (!activePaths.has(devicePath) && monitorLeases.has(modelKey(collections[0]))) {
            wanted.set(devicePath, collections);
        }
    });

    monitors.forEach((conn, devicePath) => {
        if (wanted.has(devicePath)) return;
        log.debug(`Stopped monitoring "${conn.deviceName}" (${devicePath})`);
        closeQuietly(conn.device, devicePath);
        monitors.delete(devicePath);
    });
    monitorFailures.forEach((_, devicePath) => {
        if (!wanted.has(devicePath)) monitorFailures.delete(devicePath);
    });

    wanted.forEach((collections, devicePath) => {
        if (!monitors.has(devicePath)) {
            openMonitor({ ...collections[0], path: devicePath }, hasNumberedReports(devicePath, collectionsByPath));
        }
    });
}

function isUsbScanDue(): boolean {
    // A participant is ready or running: a crossing can come at any time. The interfaces already found keep working.
    if (isAnyRunActive()) return false;
    const now = Date.now();
    if (now - lastUsbScanAt < USB_SCAN_INTERVAL_MS) return false;
    return (
        usbScanRequested ||
        unmatchedRules.length > 0 ||
        now - lastStatusRequestAt < MONITOR_LEASE_MS ||
        [...failures.keys()].some(isUsbPath)
    );
}

/**
 * Whether byte 0 of the reports is a report ID: several collections share the path, or (libusb) the report
 * descriptor declares report IDs.
 */
function hasNumberedReports(devicePath: string, collectionsByPath: Map<string, HID.Device[]>): boolean {
    if ((collectionsByPath.get(devicePath)?.length ?? 1) > 1) return true;
    return usbInterfaces.some((u) => u.path === devicePath && u.numberedReports);
}

function openReportSource(devicePath: string): ReportSource {
    if (!isUsbPath(devicePath)) return new HID.HID(devicePath);
    const target = usbInterfaces.find((u) => u.path === devicePath);
    if (!target) throw new Error('USB interface not found');
    return new UsbHidReader(target);
}

/**
 * Logs the device list when it differs from the last logged one. Returns whether it changed.
 */
function logAssignmentsIfChanged(assignments: DeviceAssignment[], lines: DevicesConfig['lines']): boolean {
    // Includes the lines so that changes to their gates count as a change
    const state = JSON.stringify({
        lines,
        assignments: assignments.map(({ device, usbPort, rule, used, conflict }) => ({
            path: device.path,
            serial: device.serialNumber,
            usbPort,
            rule,
            used,
            conflict,
        })),
    });
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
function updateConnection(conn: Connection, rule: DeviceRule, triggers: GateTrigger[], logIt: boolean): void {
    conn.deviceName = rule.name;
    conn.triggers = mergeTriggers(conn.triggers, triggers);
    conn.logReports = rule.logReports ?? false;
    if (logIt) log.info(`Updated the line gates of "${rule.name}"`);
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
function openConnection(rule: DeviceRule, triggers: GateTrigger[], hidDevice: HidDevice, numberedReports: boolean): void {
    let device: ReportSource;
    try {
        device = openReportSource(hidDevice.path);
    } catch (error) {
        recordFailure(hidDevice.path, rule.name, errorMessage(error), hidDevice);
        return;
    }

    if (failures.delete(hidDevice.path)) {
        log.info(`"${rule.name}" recovered.`);
    }
    log.info(`Listening to "${rule.name}" at ${hidDevice.path}${rule.logReports ? ' (logging raw reports)' : ''}`);

    const conn = newConnection(rule.name, device, numberedReports, mergeTriggers([], triggers));
    conn.logReports = rule.logReports ?? false;
    connections.set(hidDevice.path, conn);

    device.on('data', (report: Buffer) => onReport(conn, report));
    device.on('error', (error: unknown) => onReadError(conn, hidDevice, error));
}

/**
 * Opens an interface for the diagnostics page only: its reports are kept, but nothing fires a race event.
 * Failures are shown on the page and retried on the next poll, without logging them as errors.
 */
function openMonitor(hidDevice: HidDevice, numberedReports: boolean): void {
    const name = hidDevice.product || modelKey(hidDevice);
    let device: ReportSource;
    try {
        device = openReportSource(hidDevice.path);
    } catch (error) {
        recordMonitorFailure(hidDevice, name, errorMessage(error));
        return;
    }

    monitorFailures.delete(hidDevice.path);
    log.debug(`Monitoring "${name}" at ${hidDevice.path} for the diagnostics page`);

    const conn = newConnection(name, device, numberedReports, []);
    monitors.set(hidDevice.path, conn);

    device.on('data', (report: Buffer) => trackReport(conn, report, Temporal.Now.instant()));
    device.on('error', (error: unknown) => {
        if (monitors.get(hidDevice.path) !== conn) return;
        closeQuietly(conn.device, hidDevice.path);
        monitors.delete(hidDevice.path);
        recordMonitorFailure(hidDevice, name, `Read error: ${errorMessage(error)}`);
    });
}

function recordMonitorFailure(hidDevice: HidDevice, deviceName: string, message: string): void {
    if (isUsbPath(hidDevice.path)) usbScanRequested = true;
    const previous = monitorFailures.get(hidDevice.path);
    const isNew = !previous || previous.message !== message;
    monitorFailures.set(hidDevice.path, {
        deviceName,
        message,
        hint: openFailureHint(hidDevice, message),
        since: isNew ? Temporal.Now.instant() : previous.since,
        attempts: (previous?.attempts ?? 0) + 1,
    });
    if (isNew) log.debug(`Cannot monitor "${deviceName}" at ${hidDevice.path}: ${message}`);
}

function newConnection(deviceName: string, device: ReportSource, numberedReports: boolean, triggers: ActiveTrigger[]): Connection {
    return {
        deviceName,
        device,
        triggers,
        logReports: false,
        numberedReports,
        lastReportById: new Map(),
        recentReports: [],
        openedAt: Temporal.Now.instant(),
        reportCount: 0,
    };
}

function onReport(conn: Connection, report: Buffer): void {
    // Taken first, before any logging or race handling, so it is as close as possible to the hardware event
    const instant = Temporal.Now.instant();

    trackReport(conn, report, instant);

    for (const { line, gate, edge } of evaluateReport(conn.triggers, report)) {
        log.info(`${edge === 'press' ? 'Pressed' : 'Released'}: ${conn.deviceName} | ${line} ${gate}`);
        handleCrossing(line, gate, conn.deviceName, instant);
    }
}

function trackReport(conn: Connection, report: Buffer, instant: Temporal.Instant): void {
    trackReportChanges(conn, report, instant);
    conn.reportCount++;
    conn.lastReport = report;
    conn.lastReportAt = instant;
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
        bits: previous ? changes : [],
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
    // An unplugged or replugged libusb interface is only seen again by a USB scan
    if (isUsbPath(devicePath)) usbScanRequested = true;
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

function closeQuietly(device: ReportSource, devicePath: string): void {
    try {
        device.close();
    } catch (error) {
        // Expected when the device was already unplugged
        log.debug(`Close failed for ${devicePath}:`, errorMessage(error));
    }
}
