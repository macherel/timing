import { beforeEach, describe, expect, it } from 'vitest';
import {
    parseDevicesConfig,
    readConfiguredPort,
    stringifyDevicesConfig,
    validateDevicesConfig,
    type DevicesConfig,
} from '../src/services/hardware/deviceConfig.js';
import { resetWorkDir, writeFiles } from './helpers.js';

const FULL: DevicesConfig = {
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
        {
            name: 'Line 2',
            enabled: false,
            start: { device: 'Receiver', reportId: 2, byteIndex: 1, mask: 0x04, value: 0x04 },
            finish: { device: 'Receiver', reportId: 2, byteIndex: 1, mask: 0x08, value: 0x08 },
        },
    ],
    devices: [
        {
            name: 'Receiver',
            vendorId: 0x046d,
            productId: 0xc548,
            usagePage: 1,
            usage: 2,
            serialNumber: 'ABC',
            usbPort: '3-5',
            logReports: true,
        },
        { name: 'Finish gate', vendorId: 0x1234, productId: 0x0001 },
    ],
};

const gate = (device: string, extra: object = {}) => ({ device, byteIndex: 0, mask: 1, value: 1, ...extra });

describe('config.yaml', () => {
    it('is written so that it reads back the same, with IDs and masks in hex', () => {
        const text = stringifyDevicesConfig(FULL);
        expect(text).toContain('port: 8080');
        expect(text).toContain('vendorId: 0x046d');
        expect(text).toContain('mask: 0x01');
        expect(text).toContain('key: "amber-otter-glide"');
        expect(text).toMatch(/lines:\n {2}- name: "Line 1"\n {4}enabled: true\n {4}start:\n {6}device: "Receiver"\n {6}reportId: 2\n/);
        expect(parseDevicesConfig(text)).toEqual({ config: FULL, problems: [] });
    });

    it('accepts no line and no device', () => {
        expect(parseDevicesConfig(stringifyDevicesConfig({ lines: [], devices: [] }))).toEqual({ config: { lines: [], devices: [] }, problems: [] });
        // A file without lines times nothing
        expect(parseDevicesConfig('devices: []\n')).toEqual({ config: { devices: [] }, problems: [] });
    });

    it('reports YAML syntax errors', () => {
        const { config, problems } = parseDevicesConfig('devices: [');
        expect(config).toBeNull();
        expect(problems[0]).toMatch(/^YAML syntax error/);
    });

    it('lists every problem with its place', () => {
        const problems = validateDevicesConfig({
            port: 70000,
            sync: { key: ' ' },
            lines: [
                { name: 'L', enabled: true, start: gate('A', { mask: 0x01, value: 0x02 }), finish: gate('Nope') },
                { name: 'L', enabled: 'yes', start: gate('A', { edge: 'down' }) },
            ],
            devices: [
                { name: 'A', vendorId: 1, productId: 1 },
                { name: 'A', vendorId: 'x', productId: 1, usagePage: 1 },
            ],
        });
        expect(problems).toEqual([
            'port must be a whole number from 1 to 65535',
            'sync.key must be a non-empty text',
            'devices[1].vendorId and productId must be integers',
            'devices[1].usagePage and usage must be set together',
            'devices[1].name "A" is used twice (the lines refer to devices by name, so it must be unique)',
            'lines[0].start.value has bits outside mask, so it can never match',
            'lines[0].finish.device "Nope" is not in the devices list',
            'lines[1].enabled must be true or false',
            'lines[1].start.edge must be press or release',
            'lines[1].finish must say which device button finishes the line',
            'lines[1].name "L" is used twice (it must be unique)',
        ]);
    });

    it('rejects what is not a mapping with a device list', () => {
        expect(validateDevicesConfig(null)).toEqual(['file is empty or not a mapping']);
        expect(validateDevicesConfig({})).toEqual(['devices must be a list']);
        expect(validateDevicesConfig({ devices: [], lines: {} })).toEqual(['lines must be a list']);
    });
});

describe('readConfiguredPort', () => {
    beforeEach(resetWorkDir);

    it('reads the port of config.yaml', () => {
        writeFiles({ 'config.yaml': 'port: 8080\ndevices: []\n' });
        expect(readConfiguredPort()).toBe(8080);
    });

    it('is undefined without a file, without a port, or with an invalid port', () => {
        expect(readConfiguredPort()).toBeUndefined();
        writeFiles({ 'config.yaml': 'devices: []\n' });
        expect(readConfiguredPort()).toBeUndefined();
        writeFiles({ 'config.yaml': 'port: 99999\n' });
        expect(readConfiguredPort()).toBeUndefined();
        writeFiles({ 'config.yaml': 'port: [\n' });
        expect(readConfiguredPort()).toBeUndefined();
    });
});
