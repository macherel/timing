import type HID from 'node-hid';

/**
 * Helpers to describe HID devices and reports in a human-readable way, for logs and the diagnose tool.
 */

const USAGE_NAMES: Record<string, string> = {
    '1/1': 'Pointer',
    '1/2': 'Mouse',
    '1/4': 'Joystick',
    '1/5': 'Gamepad',
    '1/6': 'Keyboard',
    '1/7': 'Keypad',
    '1/128': 'System Control',
    '12/1': 'Consumer Control (media keys)',
};

/** Formats a vendor/product ID like USB tools do: 0x046d. */
export function hexId(id: number): string {
    return `0x${id.toString(16).padStart(4, '0')}`;
}

/** e.g. "1/2 (Mouse)" or "65280/1 (vendor-defined)". */
export function describeUsage(usagePage: number | undefined, usage: number | undefined): string {
    if (usagePage === undefined || usage === undefined) return 'unknown usage';
    const name = USAGE_NAMES[`${usagePage}/${usage}`] ?? (usagePage >= 0xff00 ? 'vendor-defined' : 'other');
    return `${usagePage}/${usage} (${name})`;
}

/**
 * Mice and keyboards are opened exclusively by Windows and macOS, so node-hid cannot read them there.
 */
export function isOsOwned(device: Pick<HID.Device, 'usagePage' | 'usage'>): boolean {
    return device.usagePage === 1 && (device.usage === 2 || device.usage === 6);
}

/**
 * Explains a failed open with the most likely cause and what to do about it.
 */
export function openFailureHint(device: HID.Device, message: string): string | null {
    if (isOsOwned(device) && process.platform !== 'linux') {
        return (
            `${process.platform === 'win32' ? 'Windows' : 'The OS'} does not let applications read mice or keyboards. ` +
            `Run "npm run diagnose" to look for another interface of this device (e.g. vendor-defined usagePage >= 65280), ` +
            `or switch the device to a joystick/gamepad or raw HID mode if it has one.`
        );
    }
    if (process.platform === 'linux' && /permission denied/i.test(message)) {
        const vid = device.vendorId.toString(16).padStart(4, '0');
        const pid = device.productId.toString(16).padStart(4, '0');
        return (
            `Missing permission on ${device.path}. Add a udev rule, e.g. ` +
            `KERNEL=="hidraw*", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0660", GROUP="plugdev"`
        );
    }
    return null;
}

/** e.g. "02 01 00 00". */
export function toHex(report: Buffer | number[]): string {
    return Array.from(report, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export interface BitChange {
    byteIndex: number;
    bit: number;    // 0 = least significant
    isSet: boolean; // New state of the bit
}

/**
 * Lists the bits that differ between two reports (a missing byte counts as 0).
 */
export function changedBits(previous: Buffer | undefined, current: Buffer): BitChange[] {
    const changes: BitChange[] = [];
    const length = Math.max(previous?.length ?? 0, current.length);

    for (let byteIndex = 0; byteIndex < length; byteIndex++) {
        const before = previous?.[byteIndex] ?? 0;
        const after = current[byteIndex] ?? 0;
        const diff = before ^ after;
        for (let bit = 0; bit < 8; bit++) {
            if (diff & (1 << bit)) {
                changes.push({ byteIndex, bit, isSet: (after & (1 << bit)) !== 0 });
            }
        }
    }
    return changes;
}

/** e.g. "byte 1 bit 0 ↑ (mask 0x01)". */
export function describeBitChange({ byteIndex, bit, isSet }: BitChange): string {
    return `byte ${byteIndex} bit ${bit} ${isSet ? '↑' : '↓'} (mask 0x${(1 << bit).toString(16).padStart(2, '0')})`;
}
