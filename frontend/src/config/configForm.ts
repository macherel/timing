import type { DeviceRule, DevicesConfig, Gate, GateRule, LineRule, RecentReport } from '../types';
import { t } from '../i18n';

/**
 * Editable form state for config.yaml. Every number is kept as the text typed by the user, so a half-typed
 * value is not lost; it is converted on validation and save. IDs and masks are hex, the rest decimal.
 */
export interface PatternForm {
  reportId: string;
  byteIndex: string;
  mask: string;
  value: string;
}

/** The device button that starts or finishes a line. */
export interface GateForm extends PatternForm {
  // Key of the device in the form, so renaming the device keeps the line on it. null: none chosen
  deviceKey: number | null;
  edge: 'press' | 'release';
}

export interface LineForm {
  // Stable v-for key, so reordering lines keeps each editor's state
  key: number;
  name: string;
  enabled: boolean;
  start: GateForm;
  finish: GateForm;
}

export interface DeviceForm {
  // Stable v-for key, also how the lines refer to the device in the form
  key: number;
  name: string;
  vendorId: string;
  productId: string;
  usagePage: string;
  usage: string;
  serialNumber: string;
  usbPort: string;
  logReports: boolean;
}

export interface ConfigForm {
  // Empty for the default port
  port: string;
  useSync: boolean;
  syncKey: string;
  // Empty for the computer name
  syncName: string;
  useDiscoveryFilter: boolean;
  discoveryUsagePage: string;
  discoveryUsage: string;
  lines: LineForm[];
  devices: DeviceForm[];
}

export const GATES: Gate[] = ['start', 'finish'];

let nextKey = 1;

export function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, '0')}`;
}

export function emptyGate(deviceKey: number | null = null): GateForm {
  return { deviceKey, reportId: '', byteIndex: '', mask: '', value: '', edge: 'press' };
}

/** A new line, on `deviceKey` for its start and finish when given (e.g. the only device). */
export function emptyLine(name: string, deviceKey: number | null = null): LineForm {
  return { key: nextKey++, name, enabled: true, start: emptyGate(deviceKey), finish: emptyGate(deviceKey) };
}

export function emptyDevice(name: string): DeviceForm {
  return {
    key: nextKey++,
    name,
    vendorId: '',
    productId: '',
    usagePage: '',
    usage: '',
    serialNumber: '',
    usbPort: '',
    logReports: false,
  };
}

export function emptyForm(): ConfigForm {
  return {
    port: '',
    useSync: false,
    syncKey: '',
    syncName: '',
    useDiscoveryFilter: false,
    discoveryUsagePage: '1',
    discoveryUsage: '2',
    lines: [],
    devices: [],
  };
}

const text = (value: number | undefined) => (value === undefined ? '' : String(value));

export function toForm(config: DevicesConfig): ConfigForm {
  const devices: DeviceForm[] = config.devices.map((rule) => ({
    key: nextKey++,
    name: rule.name,
    vendorId: hex(rule.vendorId, 4),
    productId: hex(rule.productId, 4),
    usagePage: text(rule.usagePage),
    usage: text(rule.usage),
    serialNumber: rule.serialNumber ?? '',
    usbPort: rule.usbPort ?? '',
    logReports: rule.logReports ?? false,
  }));
  const toGate = (rule: GateRule): GateForm => ({
    deviceKey: devices.find((device) => device.name === rule.device)?.key ?? null,
    reportId: text(rule.reportId),
    byteIndex: text(rule.byteIndex),
    mask: hex(rule.mask, 2),
    value: hex(rule.value, 2),
    edge: rule.edge ?? 'press',
  });
  return {
    port: text(config.port),
    useSync: config.sync !== undefined,
    syncKey: config.sync === undefined ? '' : String(config.sync.key),
    syncName: config.sync?.name ?? '',
    useDiscoveryFilter: config.discoveryFilter !== undefined,
    discoveryUsagePage: text(config.discoveryFilter?.usagePage ?? 1),
    discoveryUsage: text(config.discoveryFilter?.usage ?? 2),
    lines: (config.lines ?? []).map((line) => ({
      key: nextKey++,
      name: line.name,
      enabled: line.enabled,
      start: toGate(line.start),
      finish: toGate(line.finish),
    })),
    devices,
  };
}

/**
 * Builds the config sent to the backend. Empty optional fields are left out; text that is not a number becomes
 * NaN (null in JSON), which the backend reports as a problem on that field.
 */
export function toConfig(form: ConfigForm): DevicesConfig {
  const config: DevicesConfig = {
    port: parseDecimal(form.port),
    lines: form.lines.map((line) => toLine(line, form.devices)),
    devices: form.devices.map(toRule),
  };
  if (form.useSync) config.sync = { key: form.syncKey.trim(), name: optionalText(form.syncName) };
  if (form.useDiscoveryFilter) {
    config.discoveryFilter = {
      usagePage: parseDecimal(form.discoveryUsagePage) as number,
      usage: parseDecimal(form.discoveryUsage) as number,
    };
  }
  return config;
}

function toLine(line: LineForm, devices: DeviceForm[]): LineRule {
  const toGate = (gate: GateForm): GateRule => ({
    // An empty name when no device is chosen (or it was removed): the backend reports it on the gate
    device: devices.find((device) => device.key === gate.deviceKey)?.name.trim() ?? '',
    reportId: parseDecimal(gate.reportId),
    byteIndex: parseDecimal(gate.byteIndex) as number,
    mask: parseHex(gate.mask) as number,
    value: parseHex(gate.value) as number,
    edge: gate.edge === 'release' ? 'release' : undefined,
  });
  return { name: line.name.trim(), enabled: line.enabled, start: toGate(line.start), finish: toGate(line.finish) };
}

function toRule(device: DeviceForm): DeviceRule {
  return {
    name: device.name.trim(),
    vendorId: parseHex(device.vendorId) as number,
    productId: parseHex(device.productId) as number,
    usagePage: parseDecimal(device.usagePage),
    usage: parseDecimal(device.usage),
    serialNumber: optionalText(device.serialNumber),
    usbPort: optionalText(device.usbPort),
    logReports: device.logReports || undefined,
  };
}

function parseDecimal(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/** Accepts "0x046d", "046d" or "46D". */
export function parseHex(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^(0x)?[0-9a-f]+$/i.test(trimmed) ? parseInt(trimmed.replace(/^0x/i, ''), 16) : NaN;
}

function optionalText(text: string): string | undefined {
  return text.trim() === '' ? undefined : text.trim();
}

/**
 * Splits the backend's problems by line and by device. "lines[1].start.mask must be…" goes to line 1 as
 * "Start: mask must be…" (in the current language), "devices[0].name must be…" to device 0 as "name must be…";
 * the other problems stay in `general`.
 */
export function groupProblems(problems: string[]): {
  general: string[];
  byLine: Map<number, string[]>;
  byDevice: Map<number, string[]>;
} {
  const general: string[] = [];
  const byLine = new Map<number, string[]>();
  const byDevice = new Map<number, string[]>();

  for (const problem of problems) {
    const match = /^(lines|devices)\[(\d+)\]\.?\s*(.*)$/s.exec(problem);
    if (!match) {
      general.push(problem);
      continue;
    }
    const [, list, index, rest] = match;
    const target = list === 'lines' ? byLine : byDevice;
    const gate = list === 'lines' ? /^(start|finish)\.?\s*(.*)$/s.exec(rest) : null;
    const text = gate ? t('config.gateProblem', { gate: t(`line.${gate[1]}`), problem: gate[2] }) : rest;
    target.set(Number(index), [...(target.get(Number(index)) ?? []), text]);
  }
  return { general, byLine, byDevice };
}

/** A button found in the reports of a device: its pattern, with the bit as mask and value. */
export interface DetectedButton {
  reportId: number | null;
  byteIndex: number;
  mask: number;
}

/** Identifies a report of the recent reports of an interface, to tell the new ones from those already there. */
export const reportKey = (path: string, report: RecentReport) => `${path}\n${report.at}\n${report.hex}`;

/**
 * The button pressed in the reports that are not in `known` (oldest first): the first bit that goes from 0 to 1, in the
 * lowest byte of its report (buttons come before the movement bytes in a mouse report).
 */
export function findPressedButton(reports: { path: string; report: RecentReport }[], known: Set<string>): DetectedButton | null {
  for (const { path, report } of reports) {
    if (known.has(reportKey(path, report))) continue;
    const rising = (report.bits ?? []).filter((bit) => bit.isSet).sort((a, b) => a.byteIndex - b.byteIndex || a.bit - b.bit);
    if (rising.length === 0) continue;
    return { reportId: report.reportId, byteIndex: rising[0].byteIndex, mask: 1 << rising[0].bit };
  }
  return null;
}
