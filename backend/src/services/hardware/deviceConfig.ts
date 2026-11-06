import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { createLogger, errorMessage } from '../../utils/logger.js';
import { workDirPath } from '../../utils/workDir.js';

const log = createLogger('Config');

export const CONFIG_PATH = workDirPath('config.yaml');

/**
 * A byte pattern in a HID report that fires race actions.
 */
export interface TriggerRule {
    reportId?: number;       // Optional: only look at reports whose byte 0 (report ID) has this value
    byteIndex: number;       // Byte to inspect (index 0 is the report ID for numbered reports)
    mask: number;            // Bits of that byte to compare
    value: number;           // Matches when (byte & mask) === value
    action?: string;         // Fired when the pattern starts matching (press)
    releaseAction?: string;  // Fired when the pattern stops matching (release)
}

/**
 * A device to listen to: which HID interface it is, and which report patterns fire race actions.
 */
export interface DeviceRule {
    name: string;           // Identifies the device in race events, so it must be unique
    vendorId: number;
    productId: number;
    usagePage?: number;     // Optional: HID interface to use, overrides discoveryFilter for this rule
    usage?: number;
    serialNumber?: string;  // Optional: bind the rule to one specific unit
    usbPort?: string;       // Optional: bind the rule to a physical USB port, e.g. "3-5" (Linux only)
    enabled: boolean;
    logReports?: boolean;   // Optional: log every changed raw report, to work out trigger bytes
    triggers?: TriggerRule[];
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
    // Optional default HID interface for all rules (usagePage 1 / usage 2 = mouse)
    discoveryFilter?: {
        usagePage: number;
        usage: number;
    };
    devices: DeviceRule[];
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

    if (config.discoveryFilter) {
        lines.push(
            '# Default HID interface for rules without usagePage/usage (1/2 = mouse)',
            'discoveryFilter:',
            `  usagePage: ${config.discoveryFilter.usagePage}`,
            `  usage: ${config.discoveryFilter.usage}`,
            ''
        );
    }

    if (config.devices.length === 0) {
        lines.push('devices: []');
        return `${lines.join('\n')}\n`;
    }

    lines.push('devices:');
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
        lines.push(`    enabled: ${rule.enabled}`);
        if (rule.logReports !== undefined) lines.push(`    logReports: ${rule.logReports}`);

        if (!rule.triggers?.length) return;
        lines.push('    triggers:');
        for (const trigger of rule.triggers) {
            const fields = [
                trigger.reportId !== undefined ? `reportId: ${trigger.reportId}` : null,
                `byteIndex: ${trigger.byteIndex}`,
                `mask: ${hex(trigger.mask, 2)}`,
                `value: ${hex(trigger.value, 2)}`,
                trigger.action !== undefined ? `action: ${text(trigger.action)}` : null,
                trigger.releaseAction !== undefined ? `releaseAction: ${text(trigger.releaseAction)}` : null,
            ].filter((field) => field !== null);
            lines.push(`      - ${fields[0]}`, ...fields.slice(1).map((field) => `        ${field}`));
        }
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

    const seenNames = new Set<string>();
    config.devices.forEach((rule: any, i: number) => {
        problems.push(...validateDeviceRule(rule, `devices[${i}]`));

        if (typeof rule?.name === 'string') {
            if (seenNames.has(rule.name)) {
                problems.push(`devices[${i}].name "${rule.name}" is used twice (names identify devices in race events and must be unique)`);
            }
            seenNames.add(rule.name);
        }
    });
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
    if (typeof rule?.enabled !== 'boolean') {
        problems.push(`${where}.enabled must be true or false`);
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

    if (rule?.triggers === undefined) return problems;
    if (!Array.isArray(rule.triggers)) {
        problems.push(`${where}.triggers must be a list`);
        return problems;
    }
    rule.triggers.forEach((trigger: any, j: number) => {
        problems.push(...validateTrigger(trigger, `${where}.triggers[${j}]`));
    });
    return problems;
}

function validateTrigger(trigger: any, where: string): string[] {
    const problems: string[] = [];

    if (!isInteger(trigger?.byteIndex) || !isInteger(trigger?.mask) || !isInteger(trigger?.value)) {
        problems.push(`${where}.byteIndex, mask and value must be integers`);
    } else if ((trigger.value & ~trigger.mask) !== 0) {
        problems.push(`${where}.value has bits outside mask, so it can never match`);
    }
    if (trigger?.reportId !== undefined && !isInteger(trigger.reportId)) {
        problems.push(`${where}.reportId must be an integer`);
    }
    if (trigger?.action === undefined && trigger?.releaseAction === undefined) {
        problems.push(`${where} needs an action or a releaseAction`);
    }
    for (const field of ['action', 'releaseAction']) {
        if (trigger?.[field] !== undefined && (typeof trigger[field] !== 'string' || trigger[field] === '')) {
            problems.push(`${where}.${field} must be a non-empty string`);
        }
    }
    return problems;
}
