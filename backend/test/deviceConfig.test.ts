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
    devices: [
        {
            name: 'Start gate',
            vendorId: 0x046d,
            productId: 0xc548,
            usagePage: 1,
            usage: 2,
            serialNumber: 'ABC',
            usbPort: '3-5',
            enabled: true,
            logReports: true,
            triggers: [{ reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01, action: 'start_crossed', releaseAction: 'start_released' }],
        },
        { name: 'Finish gate', vendorId: 0x1234, productId: 0x0001, enabled: false, triggers: [{ byteIndex: 0, mask: 0x02, value: 0x02, action: 'finish_crossed' }] },
    ],
};

describe('config.yaml', () => {
    it('is written so that it reads back the same, with IDs and masks in hex', () => {
        const text = stringifyDevicesConfig(FULL);
        expect(text).toContain('port: 8080');
        expect(text).toContain('vendorId: 0x046d');
        expect(text).toContain('mask: 0x01');
        expect(text).toContain('key: "amber-otter-glide"');
        expect(parseDevicesConfig(text)).toEqual({ config: FULL, problems: [] });
    });

    it('accepts an empty device list', () => {
        expect(parseDevicesConfig(stringifyDevicesConfig({ devices: [] }))).toEqual({ config: { devices: [] }, problems: [] });
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
            devices: [
                { name: 'A', vendorId: 1, productId: 1, enabled: true, triggers: [{ byteIndex: 0, mask: 0x01, value: 0x02, action: 'x' }] },
                { name: 'A', vendorId: 'x', productId: 1, enabled: 'yes', usagePage: 1, triggers: [{ byteIndex: 0, mask: 1, value: 1 }] },
            ],
        });
        expect(problems).toEqual([
            'port must be a whole number from 1 to 65535',
            'sync.key must be a non-empty text',
            'devices[0].triggers[0].value has bits outside mask, so it can never match',
            'devices[1].vendorId and productId must be integers',
            'devices[1].enabled must be true or false',
            'devices[1].usagePage and usage must be set together',
            'devices[1].triggers[0] needs an action or a releaseAction',
            'devices[1].name "A" is used twice (names identify devices in race events and must be unique)',
        ]);
    });

    it('rejects what is not a mapping with a device list', () => {
        expect(validateDevicesConfig(null)).toEqual(['file is empty or not a mapping']);
        expect(validateDevicesConfig({})).toEqual(['devices must be a list']);
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
