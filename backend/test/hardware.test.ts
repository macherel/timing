import { describe, expect, it } from 'vitest';
import type HID from 'node-hid';
import { evaluateReport, mergeTriggers, type ActiveTrigger } from '../src/services/hardware/triggers.js';
import { assignDevices, explainUnmatchedRules, getUsbPort, isActive } from '../src/services/hardware/deviceMatching.js';
import { openFailureHint } from '../src/services/hardware/hidDiagnostics.js';
import { parseReportDescriptor } from '../src/services/hardware/usbHid.js';
import type { DevicesConfig, TriggerRule } from '../src/services/hardware/deviceConfig.js';

const LEFT_BUTTON: TriggerRule = { byteIndex: 0, mask: 0x01, value: 0x01, action: 'start_crossed', releaseAction: 'start_released' };
const report = (...bytes: number[]) => Buffer.from(bytes);

describe('evaluateReport', () => {
    it('fires the action on press and the release action on release, once each', () => {
        const triggers = mergeTriggers([], [LEFT_BUTTON]);
        expect(evaluateReport(triggers, report(0x01, 0))).toEqual([{ kind: 'press', action: 'start_crossed' }]);
        // Still pressed: no new edge
        expect(evaluateReport(triggers, report(0x01, 5))).toEqual([]);
        expect(evaluateReport(triggers, report(0x00, 0))).toEqual([{ kind: 'release', action: 'start_released' }]);
        expect(evaluateReport(triggers, report(0x00, 0))).toEqual([]);
    });

    it('only looks at the bits of its mask, so other buttons do not interfere', () => {
        const triggers = mergeTriggers([], [LEFT_BUTTON, { byteIndex: 0, mask: 0x02, value: 0x02, action: 'finish_crossed' }]);
        expect(evaluateReport(triggers, report(0x03))).toEqual([
            { kind: 'press', action: 'start_crossed' },
            { kind: 'press', action: 'finish_crossed' },
        ]);
        // Left released while right stays pressed
        expect(evaluateReport(triggers, report(0x02))).toEqual([{ kind: 'release', action: 'start_released' }]);
    });

    it('ignores reports of another report ID, and reports too short for its byte', () => {
        const triggers = mergeTriggers([], [{ reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01, action: 'start_crossed' }]);
        expect(evaluateReport(triggers, report(1, 0x01))).toEqual([]);
        expect(evaluateReport(triggers, report(2))).toEqual([]);
        expect(evaluateReport(triggers, report(2, 0x01))).toEqual([{ kind: 'press', action: 'start_crossed' }]);
    });

    it('fires nothing on an edge without an action', () => {
        const triggers = mergeTriggers([], [{ byteIndex: 0, mask: 0x01, value: 0x01, releaseAction: 'finish_crossed' }]);
        expect(evaluateReport(triggers, report(0x01))).toEqual([]);
        expect(evaluateReport(triggers, report(0x00))).toEqual([{ kind: 'release', action: 'finish_crossed' }]);
    });
});

describe('mergeTriggers', () => {
    it('keeps the pressed state of unchanged triggers on a config reload, so a held button does not fire twice', () => {
        const before: ActiveTrigger[] = mergeTriggers([], [LEFT_BUTTON]);
        evaluateReport(before, report(0x01));
        const after = mergeTriggers(before, [LEFT_BUTTON, { byteIndex: 0, mask: 0x04, value: 0x04, action: 'finish_crossed' }]);
        expect(after.map((t) => t.isMatched)).toEqual([true, false]);
        expect(evaluateReport(after, report(0x01))).toEqual([]);
    });

    it('starts changed triggers released', () => {
        const before = mergeTriggers([], [LEFT_BUTTON]);
        evaluateReport(before, report(0x01));
        expect(mergeTriggers(before, [{ ...LEFT_BUTTON, action: 'other' }])[0].isMatched).toBe(false);
    });
});

describe('assignDevices', () => {
    const device = (path: string, extra: Partial<HID.Device> = {}): HID.Device =>
        ({ path, vendorId: 0x046d, productId: 0xc548, usagePage: 1, usage: 2, interface: 0, release: 0, ...extra }) as HID.Device;
    const config = (devices: DevicesConfig['devices'], discoveryFilter?: DevicesConfig['discoveryFilter']): DevicesConfig => ({
        devices,
        discoveryFilter,
    });
    const rule = (name: string, extra: Partial<DevicesConfig['devices'][number]> = {}) => ({
        name,
        vendorId: 0x046d,
        productId: 0xc548,
        enabled: true,
        ...extra,
    });

    it('gives a rule to the matching interface; other devices are listed without a rule', () => {
        const assignments = assignDevices(config([rule('Start')]), [device('/a'), device('/b', { vendorId: 0x1234 })]);
        expect(assignments.map((a) => [a.device.path, a.rule?.name, isActive(a)])).toEqual([
            ['/a', 'Start', true],
            ['/b', undefined, false],
        ]);
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

    it('explains why an enabled rule matches nothing', () => {
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
