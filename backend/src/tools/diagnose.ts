/**
 * Hardware diagnose tool, run with `npm run diagnose`. Does not need the server.
 *
 *   npm run diagnose                          List every HID interface, try to open it, check config.yaml
 *   npm run diagnose -- --listen 046d:c548    Print raw reports of a device and suggest button patterns on exit
 *   npm run diagnose -- --listen <path>       Same, for one interface (path as shown by the list)
 *   ... --duration 30                         Stop listening automatically after 30 seconds
 *   ... --work-dir <dir>                      Read config.yaml from <dir> (or set TIMING_WORK_DIR)
 */
import HID from 'node-hid';
import { CONFIG_PATH, loadDevicesConfig } from '../services/hardware/deviceConfig.js';
import { assignDevices, explainUnmatchedRules, getUsbPort, groupByPath } from '../services/hardware/deviceMatching.js';
import {
    changedBits,
    describeBitChange,
    describeUsage,
    hexId,
    isOsOwned,
    openFailureHint,
    toHex,
} from '../services/hardware/hidDiagnostics.js';
import { errorMessage } from '../utils/logger.js';

// A byte holding buttons pressed one at a time changes one bit per report and takes few values
// (8 buttons + released = 9). More values, or several bits flipping at once, means movement/analog data.
const MAX_BUTTON_BYTE_VALUES = 9;
const MIN_DATA_BYTE_BIT_FLIPS = 3;

const args = process.argv.slice(2);
const listenTarget = argValue('--listen');
const durationSeconds = Number(argValue('--duration') ?? 0);

if (listenTarget) {
    await listen(listenTarget, durationSeconds);
} else {
    await listDevices();
}

function argValue(name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function describeUsages(collections: HID.Device[]): string {
    return collections.map((c) => describeUsage(c.usagePage, c.usage)).join(', ');
}

// ---------------------------------------------------------------------------
// List mode
// ---------------------------------------------------------------------------

async function listDevices(): Promise<void> {
    console.log(`Platform: ${process.platform} | Node ${process.version} | Config: ${CONFIG_PATH}\n`);

    const devices = (await HID.devicesAsync()).filter((d) => d.path);
    const config = await loadDevicesConfig();
    const assignments = config ? assignDevices(config, devices) : [];

    // Device model -> path -> collections, so multi-interface devices are easy to read
    const models = new Map<string, Map<string, HID.Device[]>>();
    for (const [path, collections] of groupByPath(devices)) {
        const { vendorId, productId } = collections[0];
        const key = `${hexId(vendorId)}:${hexId(productId)}`;
        models.set(key, (models.get(key) ?? new Map()).set(path, collections));
    }

    console.log(`Found ${models.size} device model(s):\n`);
    for (const [ids, paths] of models) {
        const first = [...paths.values()][0][0];
        console.log(`■ ${ids}  ${first.manufacturer || '?'} - ${first.product || '?'}`);

        for (const [path, collections] of paths) {
            const probe = probeOpen(collections[0]);
            const rules = assignments.filter((a) => a.device.path === path && a.rule);

            console.log(`    • path: ${path}`);
            console.log(
                `      interface ${collections[0].interface}` +
                ` | serial: ${collections[0].serialNumber || 'N/A'}` +
                ` | USB port: ${getUsbPort(path) ?? 'N/A'}`
            );
            console.log(`      usage(s): ${describeUsages(collections)}`);
            if (collections.length > 1) {
                console.log('      several collections share this path: byte 0 of each report is its report ID');
            }
            console.log(`      open: ${probe.ok ? '✔ readable' : `✘ ${probe.message}`}`);
            if (probe.hint) console.log(`      hint: ${probe.hint}`);
            for (const { rule, used, conflict } of rules) {
                console.log(
                    `      config: rule "${rule!.name}"` +
                    (used ? '' : ' (no enabled line uses it)') +
                    (conflict ? ' (ignored: rule already used by another interface)' : '')
                );
            }
        }
        console.log();
    }

    if (!config) {
        console.log(`${CONFIG_PATH}: missing or invalid (see errors above).`);
        return;
    }
    const unmatched = explainUnmatchedRules(config, devices, assignments);
    console.log(unmatched.length === 0 ? 'config.yaml: every device used by an enabled line is found.' : 'config.yaml problems:');
    unmatched.forEach((explanation) => console.log(`  ${explanation}`));

    console.log(
        '\nNext step: npm run diagnose -- --listen <vid:pid or path>, press each button, then Ctrl+C for suggested button patterns.'
    );
}

function probeOpen(device: HID.Device): { ok: boolean; message?: string; hint?: string } {
    try {
        new HID.HID(device.path!).close();
        return { ok: true };
    } catch (error) {
        const message = errorMessage(error);
        return { ok: false, message, hint: openFailureHint(device, message) ?? undefined };
    }
}

// ---------------------------------------------------------------------------
// Listen mode
// ---------------------------------------------------------------------------

interface Listener {
    label: string;
    device: HID.HID;
    numberedReports: boolean;
    // Last report per report ID (always key 0 for unnumbered reports)
    lastReportById: Map<number, Buffer>;
    reportLengths: Set<number>;
    // Rising edges per "reportId:byteIndex:bit"
    risingEdges: Map<string, number>;
    // Per "reportId:byteIndex": values seen and the most bits flipped in one report, to spot movement bytes
    byteStats: Map<string, { values: Set<number>; maxBitsFlipped: number }>;
}

async function listen(target: string, seconds: number): Promise<void> {
    const paths = [...groupByPath(await HID.devicesAsync())].filter(([path, collections]) =>
        matchesTarget(path, collections[0], target)
    );
    if (paths.length === 0) {
        console.error(`No HID interface matches "${target}". Run "npm run diagnose" to list them.`);
        process.exit(1);
    }

    const listeners: Listener[] = [];
    paths.forEach(([path, collections], index) => {
        const label = `#${index + 1}`;
        const numberedReports = collections.length > 1;
        console.log(`${label} ${path} | usage(s): ${describeUsages(collections)}`);
        try {
            const device = new HID.HID(path);
            const listener: Listener = {
                label,
                device,
                numberedReports,
                lastReportById: new Map(),
                reportLengths: new Set(),
                risingEdges: new Map(),
                byteStats: new Map(),
            };
            device.on('data', (report: Buffer) => onListenReport(listener, report));
            device.on('error', (error: unknown) => console.error(`${label}: read error: ${errorMessage(error)}`));
            listeners.push(listener);
        } catch (error) {
            const message = errorMessage(error);
            const hint = openFailureHint(collections[0], message);
            console.log(`   cannot open: ${message}${hint ? `\n   hint: ${hint}` : ''}`);
        }
    });

    if (listeners.length === 0) process.exit(1);
    if (paths.some(([, collections]) => collections.some(isOsOwned))) {
        console.log('\nNote: this includes a mouse/keyboard interface, so your actions also move the cursor or type.');
    }
    console.log(
        `\nKeep the device still, then press each button/gate 3 times, one button at a time. ` +
        (seconds > 0 ? `Stopping in ${seconds}s.` : 'Press Ctrl+C when done.') +
        '\nOnly reports that differ from the previous one (with the same report ID) are printed.\n'
    );

    const stop = () => {
        listeners.forEach((l) => l.device.close());
        printSuggestions(listeners);
        process.exit(0);
    };
    process.once('SIGINT', stop);
    if (seconds > 0) setTimeout(stop, seconds * 1000);
}

function matchesTarget(path: string, device: HID.Device, target: string): boolean {
    if (path === target) return true;

    const match = /^(?:0x)?([0-9a-f]{1,4}):(?:0x)?([0-9a-f]{1,4})$/i.exec(target);
    return (
        !!match &&
        device.vendorId === parseInt(match[1], 16) &&
        device.productId === parseInt(match[2], 16)
    );
}

function onListenReport(listener: Listener, report: Buffer): void {
    const reportId = listener.numberedReports ? report[0] : 0;
    const previous = listener.lastReportById.get(reportId);
    listener.lastReportById.set(reportId, report);
    listener.reportLengths.add(report.length);

    const changes = changedBits(previous, report);
    if (previous && changes.length === 0) return;

    const time = Temporal.Now.plainTimeISO().toString().slice(0, 12);
    console.log(
        `${time} ${listener.label}` +
        (listener.numberedReports ? ` | report ID ${reportId}` : '') +
        ` | ${toHex(report)}` +
        (previous ? ` | ${changes.map(describeBitChange).join(', ')}` : ' | first report with this ID')
    );

    if (!previous) return;
    changes.filter((c) => c.isSet).forEach(({ byteIndex, bit }) => {
        const key = `${reportId}:${byteIndex}:${bit}`;
        listener.risingEdges.set(key, (listener.risingEdges.get(key) ?? 0) + 1);
    });

    const flipsPerByte = new Map<number, number>();
    changes.forEach(({ byteIndex }) => flipsPerByte.set(byteIndex, (flipsPerByte.get(byteIndex) ?? 0) + 1));
    flipsPerByte.forEach((flips, byteIndex) => {
        const key = `${reportId}:${byteIndex}`;
        const stats = listener.byteStats.get(key) ?? { values: new Set([previous[byteIndex] ?? 0]), maxBitsFlipped: 0 };
        stats.values.add(report[byteIndex] ?? 0);
        stats.maxBitsFlipped = Math.max(stats.maxBitsFlipped, flips);
        listener.byteStats.set(key, stats);
    });
}

function isDataByte(listener: Listener, reportId: number, byteIndex: number): boolean {
    const stats = listener.byteStats.get(`${reportId}:${byteIndex}`);
    return !!stats && (stats.values.size > MAX_BUTTON_BYTE_VALUES || stats.maxBitsFlipped >= MIN_DATA_BYTE_BIT_FLIPS);
}

function printSuggestions(listeners: Listener[]): void {
    console.log('\n================ Summary ================');

    for (const listener of listeners) {
        console.log(`\n${listener.label} | report length(s): ${[...listener.reportLengths].join(', ') || 'no reports'}`);

        const bits = [...listener.risingEdges]
            .map(([key, count]) => {
                const [reportId, byteIndex, bit] = key.split(':').map(Number);
                return { reportId, byteIndex, bit, count };
            })
            .sort((a, b) => a.reportId - b.reportId || a.byteIndex - b.byteIndex || a.bit - b.bit);

        if (bits.length === 0) {
            console.log('  No bit went from 0 to 1. Nothing was pressed, or this interface does not carry the buttons.');
            continue;
        }

        bits.forEach(({ reportId, byteIndex, bit, count }) => {
            const where = listener.numberedReports ? `report ID ${reportId}, ` : '';
            const kind = isDataByte(listener, reportId, byteIndex) ? '  ← movement/analog byte, not a button' : '';
            console.log(`  ${where}${describeBitChange({ byteIndex, bit, isSet: true })} set ${count}x${kind}`);
        });

        const buttons = bits.filter((b) => !isDataByte(listener, b.reportId, b.byteIndex));
        if (buttons.length === 0) {
            console.log('\n  Only movement/analog bytes changed: no button found. Keep the device still while pressing.');
            continue;
        }

        console.log('\n  Buttons found, to use as the start or finish of a line in config.yaml (or on the configuration page):');
        buttons.forEach(({ reportId, byteIndex, bit }, i) => {
            const mask = `0x${(1 << bit).toString(16).padStart(2, '0')}`;
            console.log(`    # Button ${i + 1}`);
            if (listener.numberedReports) console.log(`    reportId: ${reportId}`);
            console.log(`    byteIndex: ${byteIndex}`);
            console.log(`    mask: ${mask}`);
            console.log(`    value: ${mask}`);
        });
    }
}
