import { describe, expect, it } from 'vitest';
import type HID from 'node-hid';
import { evaluateReport, gateTriggers, mergeTriggers, type GateTrigger } from '../src/services/hardware/triggers.js';
import { assignDevices, explainUnmatchedRules, getUsbPort, isActive } from '../src/services/hardware/deviceMatching.js';
import { openFailureHint } from '../src/services/hardware/hidDiagnostics.js';
import { parseReportDescriptor } from '../src/services/hardware/usbHid.js';
import type { DevicesConfig, LineRule } from '../src/services/hardware/deviceConfig.js';

const LEFT_BUTTON: GateTrigger = { line: 'Line 1', gate: 'start', edge: 'press', byteIndex: 0, mask: 0x01, value: 0x01 };
const RIGHT_BUTTON: GateTrigger = { line: 'Line 1', gate: 'finish', edge: 'press', byteIndex: 0, mask: 0x02, value: 0x02 };
const report = (...bytes: number[]) => Buffer.from(bytes);
const fired = (triggers: ReturnType<typeof mergeTriggers>, bytes: Buffer) =>
    evaluateReport(triggers, bytes).map((t) => `${t.line} ${t.gate}`);

describe('evaluateReport', () => {
    it('fires a press trigger when its pattern starts matching, once', () => {
        const triggers = mergeTriggers([], [LEFT_BUTTON]);
        expect(fired(triggers, report(0x01, 0))).toEqual(['Line 1 start']);
        // Still pressed: no new edge
        expect(fired(triggers, report(0x01, 5))).toEqual([]);
        expect(fired(triggers, report(0x00, 0))).toEqual([]);
        expect(fired(triggers, report(0x01, 0))).toEqual(['Line 1 start']);
    });

    it('fires a release trigger when its pattern stops matching', () => {
        const triggers = mergeTriggers([], [{ ...LEFT_BUTTON, edge: 'release' }]);
        expect(fired(triggers, report(0x01))).toEqual([]);
        expect(fired(triggers, report(0x00))).toEqual(['Line 1 start']);
    });

    it('only looks at the bits of its mask, so other buttons do not interfere', () => {
        const triggers = mergeTriggers([], [LEFT_BUTTON, RIGHT_BUTTON]);
        expect(fired(triggers, report(0x03))).toEqual(['Line 1 start', 'Line 1 finish']);
        // Left released while right stays pressed
        expect(fired(triggers, report(0x02))).toEqual([]);
        expect(fired(triggers, report(0x03))).toEqual(['Line 1 start']);
    });

    it('fires every line a button is the gate of (e.g. one start for two lines)', () => {
        const triggers = mergeTriggers([], [LEFT_BUTTON, { ...LEFT_BUTTON, line: 'Line 2' }]);
        expect(fired(triggers, report(0x01))).toEqual(['Line 1 start', 'Line 2 start']);
    });

    it('ignores reports of another report ID, and reports too short for its byte', () => {
        const triggers = mergeTriggers([], [{ ...LEFT_BUTTON, reportId: 2, byteIndex: 1 }]);
        expect(fired(triggers, report(1, 0x01))).toEqual([]);
        expect(fired(triggers, report(2))).toEqual([]);
        expect(fired(triggers, report(2, 0x01))).toEqual(['Line 1 start']);
    });
});

describe('mergeTriggers', () => {
    it('keeps the pressed state of a pattern on a config reload, even for another line, so a held button does not fire twice', () => {
        const before = mergeTriggers([], [LEFT_BUTTON]);
        evaluateReport(before, report(0x01));
        const after = mergeTriggers(before, [{ ...LEFT_BUTTON, line: 'Renamed' }, RIGHT_BUTTON]);
        expect(after.map((t) => t.isMatched)).toEqual([true, false]);
        expect(fired(after, report(0x01))).toEqual([]);
    });

    it('starts changed patterns released', () => {
        const before = mergeTriggers([], [LEFT_BUTTON]);
        evaluateReport(before, report(0x01));
        expect(mergeTriggers(before, [{ ...LEFT_BUTTON, mask: 0x03, value: 0x01 }])[0].isMatched).toBe(false);
    });
});

describe('gateTriggers', () => {
    it('lists the gates of the enabled lines that use a device', () => {
        const line = (name: string, enabled: boolean, start: string, finish: string): LineRule => ({
            name,
            enabled,
            start: { device: start, reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01 },
            finish: { device: finish, byteIndex: 1, mask: 0x02, value: 0x02, edge: 'release' },
        });
        const config: DevicesConfig = {
            lines: [line('Line 1', true, 'A', 'B'), line('Line 2', true, 'A', 'A'), line('Off', false, 'A', 'A')],
            devices: [],
        };
        expect(gateTriggers(config, 'A')).toEqual([
            { line: 'Line 1', gate: 'start', edge: 'press', reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01 },
            { line: 'Line 2', gate: 'start', edge: 'press', reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01 },
            { line: 'Line 2', gate: 'finish', edge: 'release', byteIndex: 1, mask: 0x02, value: 0x02 },
        ]);
        expect(gateTriggers(config, 'B').map((t) => `${t.line} ${t.gate}`)).toEqual(['Line 1 finish']);
    });
});

describe('assignDevices', () => {
    const device = (path: string, extra: Partial<HID.Device> = {}): HID.Device =>
        ({ path, vendorId: 0x046d, productId: 0xc548, usagePage: 1, usage: 2, interface: 0, release: 0, ...extra }) as HID.Device;
    // Every device is used by a line, unless `unused` names it
    const config = (devices: DevicesConfig['devices'], discoveryFilter?: DevicesConfig['discoveryFilter'], unused: string[] = []): DevicesConfig => ({
        lines: devices
            .filter((d) => !unused.includes(d.name))
            .map((d) => ({
                name: `Line ${d.name}`,
                enabled: true,
                start: { device: d.name, byteIndex: 0, mask: 1, value: 1 },
                finish: { device: d.name, byteIndex: 0, mask: 2, value: 2 },
            })),
        devices,
        discoveryFilter,
    });
    const rule = (name: string, extra: Partial<DevicesConfig['devices'][number]> = {}) => ({
        name,
        vendorId: 0x046d,
        productId: 0xc548,
        ...extra,
    });

    it('gives a rule to the matching interface; other devices are listed without a rule', () => {
        const assignments = assignDevices(config([rule('Start')]), [device('/a'), device('/b', { vendorId: 0x1234 })]);
        expect(assignments.map((a) => [a.device.path, a.rule?.name, isActive(a)])).toEqual([
            ['/a', 'Start', true],
            ['/b', undefined, false],
        ]);
    });

    it('does not listen to a device that no enabled line uses', () => {
        const [assignment] = assignDevices(config([rule('Spare')], undefined, ['Spare']), [device('/a')]);
        expect([assignment.rule?.name, assignment.used, isActive(assignment)]).toEqual(['Spare', false, false]);
    });

    it('leaves out devices outside the discovery filter that no rule names', () => {
        const assignments = assignDevices(config([rule('Start')], { usagePage: 1, usage: 2 }), [device('/a'), device('/k', { vendorId: 0x1234, usage: 6 })]);
        expect(assignments.map((a) => a.device.path)).toEqual(['/a']);
    });

    it('gives a rule to the first interface by path only: the next ones are conflicts', () => {
        const assignments = assignDevices(config([rule('Start')]), [device('/b'), device('/a')]);
        expect(assignments.map((a) => [a.device.path, a.conflict, isActive(a)])).toEqual([
            ['/a', false, true],
            ['/b', true, false],
        ]);
    });

    it('tells identical devices apart by serial number', () => {
        const assignments = assignDevices(config([rule('Start', { serialNumber: 'S1' }), rule('Finish', { serialNumber: 'S2' })]), [
            device('/a', { serialNumber: 'S2' }),
            device('/b', { serialNumber: 'S1' }),
        ]);
        expect(assignments.map((a) => `${a.device.path} ${a.rule?.name}`)).toEqual(['/a Finish', '/b Start']);
    });

    it('only uses the interface of the discovery filter, unless the rule sets its own usage', () => {
        const keyboard = device('/k', { usage: 6 });
        expect(assignDevices(config([rule('Start')], { usagePage: 1, usage: 2 }), [keyboard])[0]?.rule).toBeUndefined();
        expect(assignDevices(config([rule('Start', { usagePage: 1, usage: 6 })], { usagePage: 1, usage: 2 }), [keyboard])[0].rule?.name).toBe(
            'Start',
        );
    });

    it('explains why a device used by a line matches nothing', () => {
        const cfg = config([rule('Start', { vendorId: 0x1111 }), rule('Finish', { serialNumber: 'X' })]);
        const devices = [device('/a', { serialNumber: 'Y' })];
        const [missing, mismatch] = explainUnmatchedRules(cfg, devices, assignDevices(cfg, devices));
        expect(missing).toMatch(/Rule "Start" .* nothing with this VID\/PID is plugged in/);
        expect(mismatch).toMatch(/Rule "Finish" .* plugged in but none of its interfaces fit, serialNumber "X"/);
    });
});

describe('parseReportDescriptor', () => {
    it('reads the usage of a mouse without report IDs, ignoring nested collections', () => {
        // Usage Page (Generic Desktop), Usage (Mouse), Collection (Application), Usage (Pointer), Collection (Physical),
        // Usage Page (Button), Input, End Collection, End Collection
        const mouse = Buffer.from([0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x05, 0x09, 0x81, 0x02, 0xc0, 0xc0]);
        expect(parseReportDescriptor(mouse)).toEqual({ collections: [{ usagePage: 1, usage: 2 }], numberedReports: false });
    });

    it('lists every top-level collection and sees report IDs', () => {
        const composite = Buffer.from([
            0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, 0x02, 0x81, 0x02, 0xc0, // Mouse, report ID 2
            0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x03, 0x81, 0x00, 0xc0, // Consumer Control, report ID 3
            0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x10, 0xc0, // Vendor-defined page 0xFF00 (2-byte page)
        ]);
        expect(parseReportDescriptor(composite)).toEqual({
            collections: [
                { usagePage: 1, usage: 2 },
                { usagePage: 12, usage: 1 },
                { usagePage: 0xff00, usage: 1 },
            ],
            numberedReports: true,
        });
    });

    it('reads an extended usage (page in the high 16 bits) and skips long items', () => {
        const descriptor = Buffer.from([0xfe, 0x02, 0x00, 0xaa, 0xbb, 0x0b, 0x06, 0x00, 0x01, 0x00, 0xa1, 0x01, 0xc0]);
        expect(parseReportDescriptor(descriptor).collections).toEqual([{ usagePage: 1, usage: 6 }]);
    });
});

describe('interfaces read with libusb', () => {
    it('take their USB port from their path, on every platform', () => {
        expect(getUsbPort('usb:3-6.3:0')).toBe('3-6.3');
    });

    it('explain how to install WinUSB when Windows has no driver for libusb', () => {
        const device = { path: 'usb:1-2:0', vendorId: 0x046d, productId: 0xc548, interface: 0 } as HID.Device;
        const hint = openFailureHint(device, 'LIBUSB_ERROR_NOT_SUPPORTED');
        if (process.platform === 'win32') expect(hint).toContain('Zadig');
        expect(openFailureHint(device, 'LIBUSB_ERROR_BUSY')).toContain('Another program');
    });
});
