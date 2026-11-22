import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { createLogger, errorMessage } from '../../utils/logger.js';
import { workDirPath } from '../../utils/workDir.js';

const log = createLogger('Config');

export const CONFIG_PATH = workDirPath('config.yaml');

/** Bits of a HID report that a button sets: it is pressed while (report[byteIndex] & mask) === value. */
export interface ReportPattern {
    reportId?: number;       // Optional: only look at reports whose byte 0 (report ID) has this value
    byteIndex: number;       // Byte to inspect (index 0 is the report ID for numbered reports)
    mask: number;            // Bits of that byte to compare
    value: number;           // Matches when (byte & mask) === value
}

export type Gate = 'start' | 'finish';
export const GATES: Gate[] = ['start', 'finish'];

/** The button of a device that marks the start or the finish of a line. */
export interface GateRule extends ReportPattern {
    device: string;               // Name of a device of the devices list
    edge?: 'press' | 'release';   // When the crossing is recorded: when the pattern starts matching (default) or stops
}

/**
 * A timing line: one participant at a time is timed on it, from a crossing of its start gate to one of its finish gate.
 */
export interface LineRule {
    name: string;            // Shown on the race and live pages, so it must be unique
    enabled: boolean;
    start: GateRule;
    finish: GateRule;
}

/**
 * A device to listen to: which HID interface it is. The lines say which of its buttons start or finish them.
 */
export interface DeviceRule {
    name: string;           // Referred to by the lines, so it must be unique
    vendorId: number;
    productId: number;
    usagePage?: number;     // Optional: HID interface to use, overrides discoveryFilter for this rule
    usage?: number;
    serialNumber?: string;  // Optional: bind the rule to one specific unit
    usbPort?: string;       // Optional: bind the rule to a physical USB port, e.g. "3-5" (Linux, and Windows over WinUSB)
    logReports?: boolean;   // Optional: log every changed raw report, to work out the button bits
}

export interface SyncSettings {
    key: string | number;   // Only instances with the same key sync together
    name?: string;          // Shown to the other instances (the computer name by default)
}

export interface DevicesConfig {
    // Optional HTTP port of the app, read at startup (--port and the PORT environment variable take precedence)
    port?: number;
    // Optional: sync with the instances on the local network that have the same key
    sync?: SyncSettings;
    // Optional: hides the administration pages and the discipline settings until it is typed (see adminLock.ts)
    adminPassword?: string;
    // Optional default HID interface for all rules (usagePage 1 / usage 2 = mouse)
    discoveryFilter?: {
        usagePage: number;
        usage: number;
    };
    // Missing in a file without lines: nothing is timed
    lines?: LineRule[];
    devices: DeviceRule[];
}

/** The enabled lines, in the order of the file. */
export function enabledLines(config: DevicesConfig | null): LineRule[] {
    return (config?.lines ?? []).filter((line) => line.enabled);
}

/** Names of the devices an enabled line uses: only those are opened. */
export function usedDeviceNames(config: DevicesConfig): Set<string> {
    return new Set(enabledLines(config).flatMap((line) => GATES.map((gate) => line[gate].device)));
}

/**
 * Reads, parses and validates config.yaml.
 * Returns null when the file is missing or invalid, so callers keep their current state.
 */
export async function loadDevicesConfig(): Promise<DevicesConfig | null> {
    let fileContent: string;
    try {
        fileContent = await fs.promises.readFile(CONFIG_PATH, 'utf8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            log.info(`${CONFIG_PATH} not found. No device will be opened until it is created from the config page.`);
        } else {
            log.error(`Failed to read ${CONFIG_PATH}:`, errorMessage(error));
        }
        return null;
    }

    const { config, problems } = parseDevicesConfig(fileContent);
    if (!config) {
        log.error(`config.yaml is invalid, keeping current connections:\n  - ${problems.join('\n  - ')}`);
    }
    return config;
}

/**
 * Parses and validates the text of a config.yaml file. `config` is null when there are problems.
 */
export function parseDevicesConfig(content: string): { config: DevicesConfig | null; problems: string[] } {
    let parsed: unknown;
    try {
        parsed = yaml.parse(content);
    } catch (error) {
        return { config: null, problems: [`YAML syntax error: ${errorMessage(error)}`] };
    }

    const problems = validateDevicesConfig(parsed);
    return { config: problems.length === 0 ? (parsed as DevicesConfig) : null, problems };
}

/**
 * config.yaml as text, for the config page. `modifiedAt` (mtimeMs) is null when the file does not exist.
 */
export async function readDevicesConfigFile(): Promise<{ content: string | null; modifiedAt: number | null }> {
    try {
        const [content, stats] = await Promise.all([
            fs.promises.readFile(CONFIG_PATH, 'utf8'),
            fs.promises.stat(CONFIG_PATH),
        ]);
        return { content, modifiedAt: stats.mtimeMs };
    } catch (error: any) {
        if (error.code === 'ENOENT') return { content: null, modifiedAt: null };
        throw error;
    }
}

/**
 * Formats a valid config as config.yaml, with USB IDs and masks in hex like the diagnose tool prints them.
 * Only known fields are written, in a fixed order.
 */
export function stringifyDevicesConfig(config: DevicesConfig): string {
    const hex = (value: number, digits: number) => `0x${value.toString(16).padStart(digits, '0')}`;
    // JSON strings are valid YAML double-quoted strings
    const text = (value: string) => JSON.stringify(value);
    const lines = ['# Saved from the configuration page. Field reference: backend/README.md', ''];

    if (config.port !== undefined) {
        lines.push('# Port of the app, used when the app starts (--port or PORT override it)', `port: ${config.port}`, '');
    }

    if (config.sync) {
        lines.push('# Sync with the computers on the local network that have the same key', 'sync:', `  key: ${text(String(config.sync.key))}`);
        if (config.sync.name !== undefined) lines.push(`  name: ${text(config.sync.name)}`);
        lines.push('');
    }

    if (config.adminPassword !== undefined) {
        lines.push(
            '# Password that unlocks the administration pages and the discipline settings',
            `adminPassword: ${text(config.adminPassword)}`,
            ''
        );
    }

    if (config.discoveryFilter) {
        lines.push(
            '# Default HID interface for rules without usagePage/usage (1/2 = mouse)',
            'discoveryFilter:',
            `  usagePage: ${config.discoveryFilter.usagePage}`,
            `  usage: ${config.discoveryFilter.usage}`,
            ''
        );
    }

    const pattern = (rule: ReportPattern, indent: string) =>
        [
            rule.reportId !== undefined ? `reportId: ${rule.reportId}` : null,
            `byteIndex: ${rule.byteIndex}`,
            `mask: ${hex(rule.mask, 2)}`,
            `value: ${hex(rule.value, 2)}`,
        ]
            .filter((field) => field !== null)
            .map((field) => `${indent}${field}`);

    const lineRules = config.lines ?? [];
    if (lineRules.length === 0) {
        lines.push('lines: []', '');
    } else {
        lines.push('# Timing lines: the device button that starts each one, and the one that finishes it', 'lines:');
        lineRules.forEach((line, i) => {
            if (i > 0) lines.push('');
            lines.push(`  - name: ${text(line.name)}`, `    enabled: ${line.enabled}`);
            for (const gate of GATES) {
                const rule = line[gate];
                lines.push(`    ${gate}:`, `      device: ${text(rule.device)}`, ...pattern(rule, '      '));
                if (rule.edge !== undefined) lines.push(`      edge: ${rule.edge}`);
            }
        });
        lines.push('');
    }

    if (config.devices.length === 0) {
        lines.push('devices: []');
        return `${lines.join('\n')}\n`;
    }

    lines.push('# USB HID devices used by the lines', 'devices:');
    config.devices.forEach((rule, i) => {
        if (i > 0) lines.push('');
        lines.push(`  - name: ${text(rule.name)}`);
        lines.push(`    vendorId: ${hex(rule.vendorId, 4)}`);
        lines.push(`    productId: ${hex(rule.productId, 4)}`);
        if (rule.usagePage !== undefined && rule.usage !== undefined) {
            lines.push(`    usagePage: ${rule.usagePage}`, `    usage: ${rule.usage}`);
        }
        if (rule.serialNumber !== undefined) lines.push(`    serialNumber: ${text(rule.serialNumber)}`);
        if (rule.usbPort !== undefined) lines.push(`    usbPort: ${text(rule.usbPort)}`);
        if (rule.logReports !== undefined) lines.push(`    logReports: ${rule.logReports}`);
    });
    return `${lines.join('\n')}\n`;
}

/**
 * Replaces config.yaml, creating the working directory if needed. Returns the new modification time.
 * Written to a temporary file first, so the hot-reload watcher never reads a half-written file.
 */
export async function writeDevicesConfigFile(content: string): Promise<number> {
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const tempPath = `${CONFIG_PATH}.tmp`;
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, CONFIG_PATH);
    log.info(`${CONFIG_PATH} saved from the config page.`);
    return (await fs.promises.stat(CONFIG_PATH)).mtimeMs;
}

/**
 * Calls onChange whenever config.yaml is modified or created.
 * Works even if the file does not exist yet.
 */
export function watchDevicesConfig(onChange: () => void): void {
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;

        if (curr.mtimeMs === 0) {
            log.warn('config.yaml was removed. Keeping current connections.');
            return;
        }

        log.info('config.yaml changed. Resyncing rules & triggers...');
        onChange();
    });
    log.info(`Hot-reload watcher active on ${CONFIG_PATH}`);
}

export function unwatchDevicesConfig(): void {
    fs.unwatchFile(CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Validation: each function returns a list of human-readable problems
// ---------------------------------------------------------------------------

const isInteger = (v: unknown): v is number => Number.isInteger(v);
export const isPort = (v: unknown): v is number => isInteger(v) && v >= 1 && v <= 65535;

/**
 * The port set in config.yaml, read synchronously at startup. Undefined when the file, or its port, is missing or
 * invalid (an invalid port is logged).
 */
export function readConfiguredPort(): number | undefined {
    let parsed: any;
    try {
        parsed = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return undefined;
    }
    const port = parsed?.port;
    if (port === undefined || port === null) return undefined;
    if (isPort(port)) return port;
    log.error(`config.yaml: port ${JSON.stringify(port)} is not a whole number from 1 to 65535, ignored.`);
    return undefined;
}

/**
 * Lists what is wrong with a config object, e.g. one sent by the config page. Empty when it is valid.
 */
export function validateDevicesConfig(config: any): string[] {
    if (!config || typeof config !== 'object') return ['file is empty or not a mapping'];

    const problems: string[] = [];

    if (config.port !== undefined && !isPort(config.port)) {
        problems.push('port must be a whole number from 1 to 65535');
    }
    if (config.sync !== undefined) {
        const { key, name } = config.sync ?? {};
        if (!((typeof key === 'string' || typeof key === 'number') && String(key).trim() !== '')) {
            problems.push('sync.key must be a non-empty text');
        }
        if (name !== undefined && typeof name !== 'string') problems.push('sync.name must be a text');
    }
    if (config.adminPassword !== undefined && !(typeof config.adminPassword === 'string' && config.adminPassword !== '')) {
        problems.push('adminPassword must be a non-empty text');
    }
    if (
        config.discoveryFilter !== undefined &&
        (!isInteger(config.discoveryFilter?.usagePage) || !isInteger(config.discoveryFilter?.usage))
    ) {
        problems.push('discoveryFilter.usagePage and discoveryFilter.usage must be integers');
    }

    if (!Array.isArray(config.devices)) {
        problems.push('devices must be a list');
        return problems;
    }

    const deviceNames = new Set<string>();
    config.devices.forEach((rule: any, i: number) => {
        problems.push(...validateDeviceRule(rule, `devices[${i}]`));
        if (typeof rule?.name === 'string') {
            if (deviceNames.has(rule.name)) {
                problems.push(`devices[${i}].name "${rule.name}" is used twice (the lines refer to devices by name, so it must be unique)`);
            }
            deviceNames.add(rule.name);
        }
    });

    if (config.lines === undefined) return problems;
    if (!Array.isArray(config.lines)) {
        problems.push('lines must be a list');
        return problems;
    }
    const lineNames = new Set<string>();
    config.lines.forEach((line: any, i: number) => {
        problems.push(...validateLine(line, `lines[${i}]`, deviceNames));
        if (typeof line?.name === 'string') {
            if (lineNames.has(line.name)) problems.push(`lines[${i}].name "${line.name}" is used twice (it must be unique)`);
            lineNames.add(line.name);
        }
    });
    return problems;
}

function validateLine(line: any, where: string, deviceNames: Set<string>): string[] {
    const problems: string[] = [];
    if (typeof line?.name !== 'string' || line.name.trim() === '') {
        problems.push(`${where}.name must be a non-empty string`);
    }
    if (typeof line?.enabled !== 'boolean') {
        problems.push(`${where}.enabled must be true or false`);
    }
    for (const gate of GATES) {
        const rule = line?.[gate];
        if (!rule || typeof rule !== 'object') {
            problems.push(`${where}.${gate} must say which device button ${gate === 'start' ? 'starts' : 'finishes'} the line`);
            continue;
        }
        if (typeof rule.device !== 'string' || rule.device === '') {
            problems.push(`${where}.${gate}.device must be the name of a device`);
        } else if (!deviceNames.has(rule.device)) {
            problems.push(`${where}.${gate}.device "${rule.device}" is not in the devices list`);
        }
        problems.push(...validatePattern(rule, `${where}.${gate}`));
        if (rule.edge !== undefined && rule.edge !== 'press' && rule.edge !== 'release') {
            problems.push(`${where}.${gate}.edge must be press or release`);
        }
    }
    return problems;
}

function validateDeviceRule(rule: any, where: string): string[] {
    const problems: string[] = [];

    if (typeof rule?.name !== 'string' || rule.name === '') {
        problems.push(`${where}.name must be a non-empty string`);
    }
    if (!isInteger(rule?.vendorId) || !isInteger(rule?.productId)) {
        problems.push(`${where}.vendorId and productId must be integers`);
    }
    if (rule?.serialNumber !== undefined && typeof rule.serialNumber !== 'string') {
        problems.push(`${where}.serialNumber must be a string`);
    }
    if (rule?.usbPort !== undefined && typeof rule.usbPort !== 'string') {
        problems.push(`${where}.usbPort must be a string`);
    }
    if ((rule?.usagePage === undefined) !== (rule?.usage === undefined)) {
        problems.push(`${where}.usagePage and usage must be set together`);
    } else if (rule?.usagePage !== undefined && (!isInteger(rule.usagePage) || !isInteger(rule.usage))) {
        problems.push(`${where}.usagePage and usage must be integers`);
    }
    if (rule?.logReports !== undefined && typeof rule.logReports !== 'boolean') {
        problems.push(`${where}.logReports must be true or false`);
    }
    return problems;
}

function validatePattern(pattern: any, where: string): string[] {
    const problems: string[] = [];

    if (!isInteger(pattern?.byteIndex) || !isInteger(pattern?.mask) || !isInteger(pattern?.value)) {
        problems.push(`${where}.byteIndex, mask and value must be integers`);
    } else if ((pattern.value & ~pattern.mask) !== 0) {
        problems.push(`${where}.value has bits outside mask, so it can never match`);
    }
    if (pattern?.reportId !== undefined && !isInteger(pattern.reportId)) {
        problems.push(`${where}.reportId must be an integer`);
    }
    return problems;
}
