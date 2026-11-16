import { EventEmitter } from 'events';
import type HID from 'node-hid';
import type * as UsbModule from 'usb';
import { createLogger, errorMessage } from '../../utils/logger.js';

/**
 * HID interfaces read straight over USB with libusb, for the interfaces that the OS HID driver no longer handles.
 *
 * Windows keeps mice and keyboards to itself, so node-hid cannot read them. Replacing the driver of that USB interface
 * with WinUSB (with Zadig) hands it over to libusb: Windows no longer sees it as a mouse, and node-hid no longer lists
 * it. This module finds those interfaces and describes them like node-hid does (one entry per top-level collection,
 * read from the HID report descriptor), so that config rules, triggers and the diagnostics page work the same way.
 *
 * Interfaces that node-hid lists are left alone: on Linux the kernel HID driver serves them all through hidraw.
 */

const log = createLogger('USB');

const USB_CLASS_HID = 3;
const HID_DESCRIPTOR = 0x21;
const REPORT_DESCRIPTOR = 0x22;
// Concurrent interrupt transfers kept queued, so no report is missed while one is being handled
const POLL_TRANSFERS = 4;

/** Path of a USB interface read with libusb, e.g. "usb:3-6.3:0" (bus-ports, as in Linux sysfs, then interface). */
export function isUsbPath(devicePath: string): boolean {
    return devicePath.startsWith('usb:');
}

/** The physical USB port of a libusb path, e.g. "3-6.3". */
export function usbPortOfPath(devicePath: string): string {
    return devicePath.slice('usb:'.length).split(':')[0];
}

export interface UsbHidInterface {
    path: string;
    // One entry per top-level collection, like node-hid enumerates them (usage unknown when unreadable)
    entries: HID.Device[];
    // Byte 0 of every report is a report ID (the report descriptor declares report IDs)
    numberedReports: boolean;
    device: UsbModule.Device;
    interfaceNumber: number;
    endpointAddress: number;
    packetSize: number;
}

// ---------------------------------------------------------------------------
// HID report descriptor
// ---------------------------------------------------------------------------

export interface ReportDescriptorSummary {
    collections: Array<{ usagePage: number; usage: number }>;
    numberedReports: boolean;
}

/**
 * Reads the top-level collections (usage page / usage) of a HID report descriptor, and whether it uses report IDs.
 */
export function parseReportDescriptor(descriptor: Buffer): ReportDescriptorSummary {
    const collections: ReportDescriptorSummary['collections'] = [];
    let numberedReports = false;
    let usagePage = 0;
    let usage: { value: number; extended: boolean } | undefined;
    let depth = 0;

    for (let i = 0; i < descriptor.length; ) {
        const prefix = descriptor[i];
        // Long item: 0xFE, data size, long tag, data
        if (prefix === 0xfe) {
            i += 3 + (descriptor[i + 1] ?? 0);
            continue;
        }
        const size = [0, 1, 2, 4][prefix & 0x03];
        let data = 0;
        for (let k = 0; k < size; k++) data += (descriptor[i + 1 + k] ?? 0) * 2 ** (8 * k);
        i += 1 + size;

        switch (prefix & 0xfc) {
            case 0x04: // Usage Page (global)
                usagePage = data;
                break;
            case 0x84: // Report ID (global)
                numberedReports = true;
                break;
            case 0x08: // Usage (local): the first one names the collection that follows
                usage ??= { value: data, extended: size === 4 };
                break;
            case 0xa0: // Collection
                if (depth === 0 && usage) {
                    collections.push(
                        usage.extended
                            ? { usagePage: Math.floor(usage.value / 0x10000), usage: usage.value & 0xffff }
                            : { usagePage, usage: usage.value }
                    );
                }
                depth++;
                usage = undefined;
                break;
            case 0xc0: // End Collection
                depth = Math.max(0, depth - 1);
                usage = undefined;
                break;
            case 0x80: // Input, Output, Feature: main items clear the local items
            case 0x90:
            case 0xb0:
                usage = undefined;
                break;
        }
    }
    return { collections, numberedReports };
}

/** Length of the report descriptor, from the HID class descriptor that follows the interface descriptor. */
function reportDescriptorLength(interfaceExtra: Buffer): number | null {
    for (let i = 0; i + 1 < interfaceExtra.length && interfaceExtra[i] > 0; i += interfaceExtra[i]) {
        if (interfaceExtra[i + 1] !== HID_DESCRIPTOR) continue;
        // bLength, bDescriptorType, bcdHID (2), bCountryCode, bNumDescriptors, then (type, length (2)) pairs
        for (let d = i + 6; d + 2 < i + interfaceExtra[i]; d += 3) {
            if (interfaceExtra[d] === REPORT_DESCRIPTOR) return interfaceExtra.readUInt16LE(d + 1);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// libusb access
// ---------------------------------------------------------------------------

// Loaded on first use, so the app still starts if the native module is missing for this platform
let usbModule: typeof UsbModule | null | undefined;

async function loadUsb(): Promise<typeof UsbModule | null> {
    if (usbModule !== undefined) return usbModule;
    try {
        usbModule = await import('usb');
    } catch (error) {
        log.warn(`libusb is not available, devices using the WinUSB driver will not be read: ${errorMessage(error)}`);
        usbModule = null;
    }
    return usbModule;
}

// Devices are opened once, whatever the number of their interfaces in use (descriptor reads, readers)
const openDevices = new Map<UsbModule.Device, number>();

function acquire(device: UsbModule.Device): void {
    const users = openDevices.get(device) ?? 0;
    if (users === 0) device.open();
    openDevices.set(device, users + 1);
}

function release(device: UsbModule.Device): void {
    const users = (openDevices.get(device) ?? 1) - 1;
    if (users > 0) {
        openDevices.set(device, users);
        return;
    }
    openDevices.delete(device);
    try {
        device.close();
    } catch (error) {
        log.debug('Close failed:', errorMessage(error));
    }
}

function stringDescriptor(device: UsbModule.Device, index: number): Promise<string> {
    if (!index) return Promise.resolve('');
    return new Promise((resolve) => device.getStringDescriptor(index, (error, value) => resolve(error ? '' : (value ?? ''))));
}

function controlIn(device: UsbModule.Device, request: number, value: number, index: number, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        // 0x81: device to host, standard request, recipient interface
        device.controlTransfer(0x81, request, value, index, length, (error, data) =>
            error ? reject(error) : resolve(data as Buffer)
        )
    );
}

// Descriptions of the interfaces seen by the last scans, so that devices are opened once to read them
const descriptions = new Map<string, { key: string; strings: [string, string, string]; summary: ReportDescriptorSummary | null }>();

async function describe(
    device: UsbModule.Device,
    iface: UsbModule.InterfaceDescriptor,
    cacheKey: string,
    devicePath: string
): Promise<{ strings: [string, string, string]; summary: ReportDescriptorSummary | null }> {
    const cached = descriptions.get(devicePath);
    if (cached?.key === cacheKey) return cached;

    const { iManufacturer, iProduct, iSerialNumber } = device.deviceDescriptor;
    let strings: [string, string, string] = ['', '', ''];
    let summary: ReportDescriptorSummary | null = null;
    try {
        acquire(device);
    } catch (error) {
        // Not cached: retried on the next scan. Opening the interface will show the error on the diagnostics page.
        log.debug(`Cannot open ${devicePath} to read its descriptors: ${errorMessage(error)}`);
        return { strings, summary };
    }
    try {
        strings = [
            await stringDescriptor(device, iManufacturer),
            await stringDescriptor(device, iProduct),
            await stringDescriptor(device, iSerialNumber),
        ];
        const length = reportDescriptorLength(iface.extra) ?? 1024;
        const descriptor = await controlIn(device, 0x06, (REPORT_DESCRIPTOR << 8) | 0, iface.bInterfaceNumber, length);
        summary = parseReportDescriptor(descriptor);
    } catch (error) {
        log.debug(`Cannot read the report descriptor of ${devicePath}: ${errorMessage(error)}`);
    } finally {
        release(device);
    }
    descriptions.set(devicePath, { key: cacheKey, strings, summary });
    return { strings, summary };
}

// The USB scan running now, if any
let runningScan: Promise<unknown> | null = null;

/** Whether a USB scan is running (it may block the event loop on Windows, see scanUsbHidInterfaces). */
export function isUsbScanInProgress(): boolean {
    return runningScan !== null;
}

/** Resolves when no USB scan is running. */
export async function waitForUsbScan(): Promise<void> {
    while (runningScan) await runningScan;
}

/**
 * Lists the USB HID interfaces that node-hid does not list (e.g. given to WinUSB with Zadig).
 * Lists every USB device, which blocks the event loop briefly on Windows: call it sparingly.
 */
export function scanUsbHidInterfaces(hidDevices: HID.Device[]): Promise<UsbHidInterface[]> {
    const scan = scanAll(hidDevices);
    runningScan = scan;
    const done = () => {
        if (runningScan === scan) runningScan = null;
    };
    scan.then(done, done);
    return scan;
}

async function scanAll(hidDevices: HID.Device[]): Promise<UsbHidInterface[]> {
    const usb = await loadUsb();
    if (!usb) return [];

    // Interfaces served by the OS HID driver. Windows gives no interface number (-1) to single-interface devices.
    const servedByHid = new Set(hidDevices.map((d) => `${d.vendorId}:${d.productId}:${d.interface}`));
    const isServedByHid = (vid: number, pid: number, iface: number) =>
        servedByHid.has(`${vid}:${pid}:${iface}`) || servedByHid.has(`${vid}:${pid}:-1`);

    let devices: UsbModule.Device[];
    try {
        devices = usb.getDeviceList();
    } catch (error) {
        log.error('Failed to list USB devices:', errorMessage(error));
        return [];
    }

    const found: UsbHidInterface[] = [];
    for (const device of devices) {
        // Root hubs have no port
        if (!device.portNumbers?.length) continue;
        let config: UsbModule.ConfigDescriptor | undefined;
        try {
            config = device.configDescriptor;
        } catch {
            continue;
        }
        const { idVendor, idProduct, bcdDevice } = device.deviceDescriptor;

        for (const alternates of config?.interfaces ?? []) {
            const iface = alternates[0];
            if (!iface || iface.bInterfaceClass !== USB_CLASS_HID) continue;
            if (isServedByHid(idVendor, idProduct, iface.bInterfaceNumber)) continue;
            const endpoint = iface.endpoints.find(
                (e) => (e.bEndpointAddress & 0x80) !== 0 && (e.bmAttributes & 0x03) === 3 // interrupt IN
            );
            if (!endpoint) continue;

            const devicePath = `usb:${device.busNumber}-${device.portNumbers.join('.')}:${iface.bInterfaceNumber}`;
            const { strings, summary } = await describe(device, iface, `${idVendor}:${idProduct}`, devicePath);
            const [manufacturer, product, serialNumber] = strings;
            const base = {
                vendorId: idVendor,
                productId: idProduct,
                path: devicePath,
                manufacturer,
                product,
                serialNumber,
                release: bcdDevice,
                interface: iface.bInterfaceNumber,
            };
            const collections = summary?.collections.length ? summary.collections : [undefined];
            found.push({
                path: devicePath,
                entries: collections.map((c) => ({ ...base, usagePage: c?.usagePage, usage: c?.usage }) as HID.Device),
                numberedReports: summary?.numberedReports ?? false,
                device,
                interfaceNumber: iface.bInterfaceNumber,
                endpointAddress: endpoint.bEndpointAddress,
                packetSize: endpoint.wMaxPacketSize,
            });
        }
    }

    const seen = new Set(found.map((f) => f.path));
    descriptions.forEach((_, devicePath) => {
        if (!seen.has(devicePath)) descriptions.delete(devicePath);
    });
    return found;
}

/**
 * Reads the reports of a USB HID interface, with the same events as node-hid: 'data' (Buffer) and 'error'.
 * Throws when the interface cannot be opened or claimed.
 */
export class UsbHidReader extends EventEmitter {
    private readonly iface: UsbModule.Interface;
    private readonly endpoint: UsbModule.InEndpoint;
    private closed = false;

    constructor(private readonly target: UsbHidInterface) {
        super();
        acquire(target.device);
        try {
            this.iface = target.device.interface(target.interfaceNumber);
            this.iface.claim();
            const endpoint = this.iface.endpoint(target.endpointAddress);
            if (!endpoint) throw new Error(`Endpoint 0x${target.endpointAddress.toString(16)} not found`);
            this.endpoint = endpoint as UsbModule.InEndpoint;
        } catch (error) {
            release(target.device);
            throw error;
        }
        this.endpoint.on('data', (report: Buffer) => {
            if (report.length > 0) this.emit('data', report);
        });
        this.endpoint.on('error', (error: unknown) => this.emit('error', error));
        this.endpoint.startPoll(POLL_TRANSFERS, target.packetSize);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const done = () => {
            try {
                this.iface.release(() => release(this.target.device));
            } catch {
                release(this.target.device);
            }
        };
        try {
            this.endpoint.stopPoll(done);
        } catch {
            // Polling already stopped by an error (e.g. unplugged)
            done();
        }
    }
}
