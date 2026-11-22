import { describe, expect, it } from 'vitest';
import {
  gateStatus,
  emptyDevice,
  emptyForm,
  emptyLine,
  findPressedButton,
  groupProblems,
  parseHex,
  reportKey,
  toConfig,
  toForm,
} from '../src/config/configForm';
import { setLocale } from '../src/i18n';
import type { DeviceStatus, DevicesConfig, HardwareStatus, HidInterface, RecentReport } from '../src/types';

const CONFIG: DevicesConfig = {
  port: 8080,
  sync: { key: 'amber-otter-glide', name: 'Finish line' },
  discoveryFilter: { usagePage: 1, usage: 2 },
  lines: [
    {
      name: 'Line 1',
      enabled: true,
      start: { device: 'Receiver', reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01 },
      finish: { device: 'Finish gate', byteIndex: 0, mask: 0x02, value: 0x02, edge: 'release' },
    },
  ],
  devices: [
    { name: 'Receiver', vendorId: 0x046d, productId: 0xc548, serialNumber: 'ABC' },
    { name: 'Finish gate', vendorId: 0x1234, productId: 0x0001 },
  ],
};

describe('configuration form', () => {
  it('shows IDs and masks in hex, and gives back the same config', () => {
    const form = toForm(CONFIG);
    expect(form.devices[0]).toMatchObject({ vendorId: '0x046d', productId: '0xc548', usagePage: '' });
    expect(form.lines[0].start).toMatchObject({ deviceKey: form.devices[0].key, mask: '0x01', reportId: '2', edge: 'press' });
    expect(form.lines[0].finish).toMatchObject({ deviceKey: form.devices[1].key, reportId: '', edge: 'release' });
    expect(form).toMatchObject({ port: '8080', useSync: true, syncKey: 'amber-otter-glide', useDiscoveryFilter: true });
    expect(toConfig(form)).toEqual(CONFIG);
  });

  it('keeps a line on its device when the device is renamed', () => {
    const form = toForm(CONFIG);
    form.devices[0].name = 'Gate A';
    expect(toConfig(form).lines![0].start.device).toBe('Gate A');
  });

  it('leaves out empty optional fields and switched-off sections', () => {
    const form = emptyForm();
    form.syncKey = 'kept only when sync is on';
    form.devices.push(emptyDevice('Device 1'));
    const config = toConfig(form);
    expect(config).toEqual({ lines: [], devices: [{ name: 'Device 1', vendorId: undefined, productId: undefined }] });
    expect(config.sync).toBeUndefined();
    expect(config.discoveryFilter).toBeUndefined();
    expect(config.devices[0].serialNumber).toBeUndefined();
  });

  it('gives a line without a device an empty device name, for the backend to report', () => {
    const form = emptyForm();
    form.lines.push(emptyLine('Line 1'));
    expect(toConfig(form).lines![0].start.device).toBe('');
  });

  it('turns text that is not a number into NaN, for the backend to report on that field', () => {
    const form = toForm(CONFIG);
    form.port = '80a';
    form.devices[0].vendorId = 'xyz';
    form.lines[0].start.mask = 'zz';
    const config = toConfig(form);
    expect(config.port).toBeNaN();
    expect(config.devices[0].vendorId).toBeNaN();
    expect(config.lines![0].start.mask).toBeNaN();
  });

  it('accepts hex with or without 0x, in any case', () => {
    expect(parseHex('0x046d')).toBe(0x046d);
    expect(parseHex('046D')).toBe(0x046d);
    expect(parseHex(' ')).toBeUndefined();
    expect(parseHex('0xzz')).toBeNaN();
  });
});

describe('groupProblems', () => {
  const problems = [
    'port must be a whole number from 1 to 65535',
    'devices[0].name must be a non-empty string',
    'lines[1].start.mask must be…',
    'lines[1].name must be a non-empty string',
  ];

  it('gives each line and device its problems, with the gate of a line', () => {
    const { general, byLine, byDevice } = groupProblems(problems);
    expect(general).toEqual(['port must be a whole number from 1 to 65535']);
    expect(byDevice.get(0)).toEqual(['name must be a non-empty string']);
    expect(byLine.get(1)).toEqual(['Start: mask must be…', 'name must be a non-empty string']);
  });

  it('names the gate in the current language', () => {
    setLocale('fr');
    expect(groupProblems(problems).byLine.get(1)?.[0]).toBe('Départ : mask must be…');
    setLocale('en');
  });
});

describe('findPressedButton', () => {
  const report = (at: string, bits: RecentReport['bits'], reportId: number | null = null): RecentReport => ({
    at,
    reportId,
    hex: '',
    changes: [],
    bits,
  });

  it('finds the first bit set in a new report, in its lowest byte', () => {
    const old = { path: '/a', report: report('1', [{ byteIndex: 1, bit: 0, isSet: true }]) };
    const known = new Set([reportKey(old.path, old.report)]);
    const reports = [
      old,
      { path: '/a', report: report('2', [{ byteIndex: 1, bit: 0, isSet: false }]) },
      { path: '/a', report: report('3', [{ byteIndex: 3, bit: 2, isSet: true }, { byteIndex: 1, bit: 1, isSet: true }], 2) },
    ];
    expect(findPressedButton(reports, known)).toEqual({ reportId: 2, byteIndex: 1, mask: 0x02 });
  });

  it('finds nothing without a new press', () => {
    expect(findPressedButton([{ path: '/a', report: report('1', [{ byteIndex: 0, bit: 0, isSet: false }]) }], new Set())).toBeNull();
  });
});

describe('gateStatus', () => {
  const form = toForm({
    devices: [{ name: 'Receiver', vendorId: 0x046d, productId: 0xc548 }],
    lines: [
      { name: 'Line 1', enabled: true, start: { device: 'Receiver', byteIndex: 1, mask: 1, value: 1 }, finish: { device: 'Receiver', byteIndex: 1, mask: 2, value: 2 } },
    ],
  });
  const line = form.lines[0];
  const plugged = { path: '/dev/hidraw0', vendorId: '046d', productId: 'c548', serialNumber: '', usbPort: '1-2' } as HidInterface;
  const opened = (state: DeviceStatus['state']) =>
    ({ deviceName: 'Receiver', path: '/dev/hidraw0', state, since: '', error: 'EACCES' }) as DeviceStatus;
  const status = (interfaces: HidInterface[], devices: DeviceStatus[] = []) => ({ interfaces, devices }) as unknown as HardwareStatus;

  it('tells whether the device of a gate is listened to', () => {
    expect(gateStatus(line, 'start', form.devices, null, false).state).toBe('checking');
    expect(gateStatus(line, 'start', form.devices, status([]), false).state).toBe('missing');
    expect(gateStatus(line, 'start', form.devices, status([plugged], [opened('listening')]), false).state).toBe('ready');
    expect(gateStatus(line, 'start', form.devices, status([plugged], [opened('failing')]), false)).toEqual({ state: 'failing', error: 'EACCES' });
    expect(gateStatus(line, 'start', form.devices, status([plugged]), true).state).toBe('unsaved');
    expect(gateStatus(line, 'start', form.devices, status([plugged]), false).state).toBe('notListened');
    expect(gateStatus({ ...line, enabled: false }, 'start', form.devices, status([plugged]), false).state).toBe('disabled');
    expect(gateStatus({ ...line, start: { ...line.start, deviceKey: null } }, 'start', form.devices, status([plugged]), false).state).toBe('none');
  });

  it('only counts the interfaces matching the serial number and USB port of the device', () => {
    const devices = [{ ...form.devices[0], usbPort: '3-1' }];
    expect(gateStatus(line, 'start', devices, status([plugged], [opened('listening')]), false).state).toBe('missing');
  });
});
