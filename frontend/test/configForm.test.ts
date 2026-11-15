import { describe, expect, it } from 'vitest';
import { emptyDevice, emptyForm, groupProblems, parseHex, toConfig, toForm } from '../src/config/configForm';
import { setLocale } from '../src/i18n';
import type { DevicesConfig } from '../src/types';

const CONFIG: DevicesConfig = {
  port: 8080,
  sync: { key: 'amber-otter-glide', name: 'Finish line' },
  discoveryFilter: { usagePage: 1, usage: 2 },
  devices: [
    {
      name: 'Start gate',
      vendorId: 0x046d,
      productId: 0xc548,
      serialNumber: 'ABC',
      enabled: true,
      triggers: [{ reportId: 2, byteIndex: 1, mask: 0x01, value: 0x01, action: 'start_crossed' }],
    },
  ],
};

describe('configuration form', () => {
  it('shows IDs and masks in hex, and gives back the same config', () => {
    const form = toForm(CONFIG);
    expect(form.devices[0]).toMatchObject({ vendorId: '0x046d', productId: '0xc548', usagePage: '' });
    expect(form.devices[0].triggers[0]).toMatchObject({ mask: '0x01', reportId: '2', releaseAction: '' });
    expect(form).toMatchObject({ port: '8080', useSync: true, syncKey: 'amber-otter-glide', useDiscoveryFilter: true });
    expect(toConfig(form)).toEqual(CONFIG);
  });

  it('leaves out empty optional fields and switched-off sections', () => {
    const form = emptyForm();
    form.syncKey = 'kept only when sync is on';
    form.devices.push(emptyDevice('Device 1'));
    const config = toConfig(form);
    expect(config).toEqual({ devices: [expect.objectContaining({ name: 'Device 1', enabled: true })] });
    expect(config.sync).toBeUndefined();
    expect(config.discoveryFilter).toBeUndefined();
    expect(config.devices[0].serialNumber).toBeUndefined();
  });

  it('turns text that is not a number into NaN, for the backend to report on that field', () => {
    const form = toForm(CONFIG);
    form.port = '80a';
    form.devices[0].vendorId = 'xyz';
    const config = toConfig(form);
    expect(config.port).toBeNaN();
    expect(config.devices[0].vendorId).toBeNaN();
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
    'devices[1].triggers[2].mask must be…',
  ];

  it('gives each device its problems, trigger problems with the trigger number', () => {
    const { general, byDevice } = groupProblems(problems);
    expect(general).toEqual(['port must be a whole number from 1 to 65535']);
    expect(byDevice.get(0)).toEqual(['name must be a non-empty string']);
    expect(byDevice.get(1)).toEqual(['Trigger 3: mask must be…']);
  });

  it('names the trigger in the current language', () => {
    setLocale('fr');
    expect(groupProblems(problems).byDevice.get(1)).toEqual(['Déclencheur 3 : mask must be…']);
  });
});
