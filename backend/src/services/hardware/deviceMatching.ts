import fs from 'fs';
import path from 'path';
import type HID from 'node-hid';
import type { DeviceRule, DevicesConfig } from './deviceConfig.js';
import { describeUsage, hexId } from './hidDiagnostics.js';
import { isUsbPath, usbPortOfPath } from './usbHid.js';

export type HidDevice = HID.Device & { path: string };

/**
 * A HID interface found on the system, with the config rule that applies to it.
 */
export interface DeviceAssignment {
    device: HidDevice;
    usbPort: string | null;
    rule: DeviceRule | undefined;
    // Another interface already claimed the same rule
    conflict: boolean;
}

export type ActiveAssignment = DeviceAssignment & { rule: DeviceRule };

/**
 * True when the interface should be listened to: its rule is enabled and not claimed by another interface.
 */
export function isActive(assignment: DeviceAssignment): assignment is ActiveAssignment {
    return !!assignment.rule?.enabled && !assignment.conflict;
}

/**
 * Finds the rule for each HID interface on the system.
 * Returns the interfaces that match a rule or the discovery filter; the rest of the system is ignored.
 * When several interfaces match the same enabled rule, only the first one (by path) gets it.
 */
export function assignDevices(config: DevicesConfig, systemDevices: HID.Device[]): DeviceAssignment[] {
    // Sorted by path so that, on a rule conflict, the same interface wins every time
    const candidates = systemDevices
        .filter((d): d is HidDevice => !!d.path)
        .sort((a, b) => a.path.localeCompare(b.path));

    // Rule -> path that claimed it
    const claimedRules = new Map<DeviceRule, string>();
    const assignments: DeviceAssignment[] = [];

    for (const device of candidates) {
        const usbPort = getUsbPort(device.path);
        const rule = config.devices.find((r) => ruleMatches(config, r, device, usbPort));
        if (!rule && !matchesUsage(device, config.discoveryFilter)) continue;

        const claimedBy = rule?.enabled ? claimedRules.get(rule) : undefined;
        // On Linux, one hidraw path carries several collections (one entry each): it is still one device
        if (claimedBy === device.path) continue;

        if (rule?.enabled && claimedBy === undefined) claimedRules.set(rule, device.path);
        assignments.push({ device, usbPort, rule, conflict: claimedBy !== undefined });
    }
    return assignments;
}

/**
 * Groups enumeration entries by path. On Linux one hidraw path lists one entry per collection;
 * on Windows every collection has its own path.
 */
export function groupByPath(systemDevices: HID.Device[]): Map<string, HID.Device[]> {
    const groups = new Map<string, HID.Device[]>();
    for (const device of systemDevices) {
        if (!device.path) continue;
        groups.set(device.path, [...(groups.get(device.path) ?? []), device]);
    }
    return groups;
}

/**
 * Explains, for each enabled rule that no interface uses, why nothing matched.
 */
export function explainUnmatchedRules(
    config: DevicesConfig,
    systemDevices: HID.Device[],
    assignments: DeviceAssignment[]
): string[] {
    const usedRules = new Set(assignments.filter(isActive).map((a) => a.rule));

    return config.devices
        .filter((rule) => rule.enabled && !usedRules.has(rule))
        .map((rule) => {
            const sameIds = systemDevices.filter(
                (d) => d.vendorId === rule.vendorId && d.productId === rule.productId
            );
            const header = `Rule "${rule.name}" (${hexId(rule.vendorId)}:${hexId(rule.productId)}) matches no device:`;

            if (sameIds.length === 0) {
                return `${header} nothing with this VID/PID is plugged in. Run "npm run diagnose" to list devices.`;
            }

            const usage = ruleUsage(config, rule);
            const interfaces = sameIds
                .map((d) => {
                    const port = d.path ? getUsbPort(d.path) : null;
                    return (
                        `      - usage ${describeUsage(d.usagePage, d.usage)} | serial: ${d.serialNumber || 'N/A'}` +
                        ` | USB port: ${port ?? 'N/A'} | path: ${d.path}`
                    );
                })
                .join('\n');
            return (
                `${header} the device is plugged in but none of its interfaces fit` +
                (usage ? ` the required usage ${describeUsage(usage.usagePage, usage.usage)}` : '') +
                (rule.serialNumber !== undefined ? `, serialNumber "${rule.serialNumber}"` : '') +
                (rule.usbPort !== undefined ? `, usbPort "${rule.usbPort}"` : '') +
                `. Available interfaces:\n${interfaces}`
            );
        });
}

/**
 * One log line describing an assignment, plus a hint when it is ignored because of a conflict.
 */
export function describeAssignment({ device, usbPort, rule, conflict }: DeviceAssignment, index: number): string {
    const line =
        `  [${index + 1}] Product: ${device.product || 'N/A'}` +
        ` | VID: ${hexId(device.vendorId)} | PID: ${hexId(device.productId)}` +
        ` | Usage: ${describeUsage(device.usagePage, device.usage)}` +
        ` | Serial: ${device.serialNumber || 'N/A'} | USB port: ${usbPort ?? 'N/A'} | Path: ${device.path}` +
        ` | Rule: ${rule?.name ?? 'none'} | Enabled: ${rule?.enabled ?? false}`;

    if (!conflict) return line;
    return (
        `${line}\n      ⚠ Rule "${rule!.name}" already matches another interface, ignoring this one. ` +
        `Add usagePage/usage to the rule if it is another interface of the same device, ` +
        `or serialNumber/usbPort if it is an identical device.`
    );
}

/** The usage a rule requires: its own, or the discovery filter's. */
function ruleUsage(config: DevicesConfig, rule: DeviceRule): { usagePage: number; usage: number } | undefined {
    if (rule.usagePage !== undefined && rule.usage !== undefined) {
        return { usagePage: rule.usagePage, usage: rule.usage };
    }
    return config.discoveryFilter;
}

function matchesUsage(device: HID.Device, usage: { usagePage: number; usage: number } | undefined): boolean {
    return !usage || (device.usagePage === usage.usagePage && device.usage === usage.usage);
}

function ruleMatches(config: DevicesConfig, rule: DeviceRule, device: HidDevice, usbPort: string | null): boolean {
    return (
        rule.vendorId === device.vendorId &&
        rule.productId === device.productId &&
        matchesUsage(device, ruleUsage(config, rule)) &&
        (rule.serialNumber === undefined || rule.serialNumber === device.serialNumber) &&
        (rule.usbPort === undefined || rule.usbPort === usbPort)
    );
}

/**
 * Resolves the physical USB port (e.g. "3-5" or "1-2.4") of a hidraw device through sysfs, or of an interface read
 * with libusb. Returns null for other HID devices on other platforms, and for non-USB devices (e.g. I2C touchpads).
 */
export function getUsbPort(devicePath: string): string | null {
    // Interfaces read with libusb carry their port in their path, on every platform
    if (isUsbPath(devicePath)) return usbPortOfPath(devicePath);
    if (process.platform !== 'linux' || !devicePath.startsWith('/dev/hidraw')) return null;
    try {
        // e.g. /sys/devices/pci0000:00/0000:00:14.0/usb3/3-5/3-5:1.1/0003:046D:C548.0065
        const sysPath = fs.realpathSync(`/sys/class/hidraw/${path.basename(devicePath)}/device`);
        return sysPath.split('/').findLast((segment) => /^\d+-[\d.]+$/.test(segment)) ?? null;
    } catch {
        return null;
    }
}
