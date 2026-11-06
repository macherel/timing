import type { DevicesConfig, DeviceRule, TriggerRule } from '../types';

/**
 * Editable form state for config.yaml. Every number is kept as the text typed by the user, so a half-typed
 * value is not lost; it is converted on validation and save. IDs and masks are hex, the rest decimal.
 */
export interface TriggerForm {
  reportId: string;
  byteIndex: string;
  mask: string;
  value: string;
  action: string;
  releaseAction: string;
}

export interface DeviceForm {
  // Stable v-for key, so reordering devices keeps each editor's state
  key: number;
  name: string;
  enabled: boolean;
  vendorId: string;
  productId: string;
  usagePage: string;
  usage: string;
  serialNumber: string;
  usbPort: string;
  logReports: boolean;
  triggers: TriggerForm[];
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
  devices: DeviceForm[];
}

let nextKey = 1;

export function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, '0')}`;
}

export function emptyTrigger(): TriggerForm {
  return { reportId: '', byteIndex: '', mask: '', value: '', action: '', releaseAction: '' };
}

export function emptyDevice(name: string): DeviceForm {
  return {
    key: nextKey++,
    name,
    enabled: true,
    vendorId: '',
    productId: '',
    usagePage: '',
    usage: '',
    serialNumber: '',
    usbPort: '',
    logReports: false,
    triggers: [emptyTrigger()],
  };
}

export function emptyForm(): ConfigForm {
  return { port: '', useSync: false, syncKey: '', syncName: '', useDiscoveryFilter: false, discoveryUsagePage: '1', discoveryUsage: '2', devices: [] };
}

export function toForm(config: DevicesConfig): ConfigForm {
  const text = (value: number | undefined) => (value === undefined ? '' : String(value));
  return {
    port: text(config.port),
    useSync: config.sync !== undefined,
    syncKey: config.sync === undefined ? '' : String(config.sync.key),
    syncName: config.sync?.name ?? '',
    useDiscoveryFilter: config.discoveryFilter !== undefined,
    discoveryUsagePage: text(config.discoveryFilter?.usagePage ?? 1),
    discoveryUsage: text(config.discoveryFilter?.usage ?? 2),
    devices: config.devices.map((rule) => ({
      key: nextKey++,
      name: rule.name,
      enabled: rule.enabled,
      vendorId: hex(rule.vendorId, 4),
      productId: hex(rule.productId, 4),
      usagePage: text(rule.usagePage),
      usage: text(rule.usage),
      serialNumber: rule.serialNumber ?? '',
      usbPort: rule.usbPort ?? '',
      logReports: rule.logReports ?? false,
      triggers: (rule.triggers ?? []).map((trigger) => ({
        reportId: text(trigger.reportId),
        byteIndex: text(trigger.byteIndex),
        mask: hex(trigger.mask, 2),
        value: hex(trigger.value, 2),
        action: trigger.action ?? '',
        releaseAction: trigger.releaseAction ?? '',
      })),
    })),
  };
}

/**
 * Builds the config sent to the backend. Empty optional fields are left out; text that is not a number becomes
 * NaN (null in JSON), which the backend reports as a problem on that field.
 */
export function toConfig(form: ConfigForm): DevicesConfig {
  const config: DevicesConfig = { port: parseDecimal(form.port), devices: form.devices.map(toRule) };
  if (form.useSync) config.sync = { key: form.syncKey.trim(), name: optionalText(form.syncName) };
  if (form.useDiscoveryFilter) {
    config.discoveryFilter = {
      usagePage: parseDecimal(form.discoveryUsagePage) as number,
      usage: parseDecimal(form.discoveryUsage) as number,
    };
  }
  return config;
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
    enabled: device.enabled,
    logReports: device.logReports || undefined,
    triggers: device.triggers.map(toTrigger),
  };
}

function toTrigger(trigger: TriggerForm): TriggerRule {
  return {
    reportId: parseDecimal(trigger.reportId),
    byteIndex: parseDecimal(trigger.byteIndex) as number,
    mask: parseHex(trigger.mask) as number,
    value: parseHex(trigger.value) as number,
    action: optionalText(trigger.action),
    releaseAction: optionalText(trigger.releaseAction),
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
 * Splits the backend's problems by device. "devices[1].triggers[0].mask must be…" goes to device 1 as
 * "Trigger 1: mask must be…"; problems outside a device stay in `general`.
 */
export function groupProblems(problems: string[]): { general: string[]; byDevice: Map<number, string[]> } {
  const general: string[] = [];
  const byDevice = new Map<number, string[]>();

  for (const problem of problems) {
    const match = /^devices\[(\d+)\]\.?\s*(.*)$/s.exec(problem);
    if (!match) {
      general.push(problem);
      continue;
    }
    const index = Number(match[1]);
    const text = match[2].replace(/^triggers\[(\d+)\]\.?\s*/, (_, j) => `Trigger ${Number(j) + 1}: `);
    byDevice.set(index, [...(byDevice.get(index) ?? []), text]);
  }
  return { general, byDevice };
}
