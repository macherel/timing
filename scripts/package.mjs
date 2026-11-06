/**
 * Builds ready-to-run packages of the app, with their own Node runtime:
 *   release/timing-<version>-linux-x64.tar.gz
 *   release/timing-<version>-win-x64.zip
 *
 *   npm run package                      Both platforms
 *   npm run package -- --platform win    One platform (linux or win)
 *
 * Runs on Linux and Windows. node-hid ships prebuilt binaries for every platform, so the same
 * node_modules works everywhere; only the Node runtime differs. Build the Linux package on Linux:
 * archives made on Windows lose the executable permission of the runtime and launchers.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const CACHE_DIR = path.join(RELEASE_DIR, '.cache');
const NODE_DIST_URL = 'https://nodejs.org/dist';
// Working directory of the packaged app, beside the launchers
const DATA_DIR = 'data';

// The packaged runtime is the Node running this script, so it must satisfy .nvmrc
const NODE_VERSION = process.version;
const REQUIRED_NODE_MAJOR = Number(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim());

const PLATFORMS = {
    linux: {
        name: 'linux-x64',
        nodeArchive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
        nodeBinary: 'node',
        // Prebuilt node-hid folders to keep, see node_modules/node-hid/prebuilds
        prebuildSuffix: '-linux-x64',
        archive: 'tar.gz',
    },
    win: {
        name: 'win-x64',
        nodeArchive: 'win-x64/node.exe',
        nodeBinary: 'node.exe',
        prebuildSuffix: '-win32-x64',
        archive: 'zip',
    },
};

const IS_WINDOWS_HOST = process.platform === 'win32';
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/package.json'), 'utf8')).version;

main().catch((error) => {
    console.error(`\n✘ ${error.message}`);
    process.exit(1);
});

async function main() {
    const platforms = selectedPlatforms();
    if (Number(NODE_VERSION.slice(1).split('.')[0]) < REQUIRED_NODE_MAJOR) {
        throw new Error(`Node ${NODE_VERSION} is running, but the app needs Node ${REQUIRED_NODE_MAJOR}. Run "nvm use" first.`);
    }

    step('Building frontend and backend');
    // Stale files from deleted sources must not end up in the package
    fs.rmSync(path.join(ROOT, 'backend/dist'), { recursive: true, force: true });
    run('npm', ['run', 'build'], ROOT);

    const checksums = await fetchChecksums();
    for (const key of platforms) {
        await buildPackage(PLATFORMS[key], checksums);
    }
}

function selectedPlatforms() {
    const args = process.argv.slice(2);
    const selected = args.flatMap((arg, i) => (arg === '--platform' ? [args[i + 1]] : []));
    if (selected.length === 0) return Object.keys(PLATFORMS);

    const unknown = selected.filter((p) => !(p in PLATFORMS));
    if (unknown.length > 0) {
        throw new Error(`Unknown platform "${unknown.join(', ')}". Use: ${Object.keys(PLATFORMS).join(', ')}`);
    }
    return selected;
}

async function buildPackage(platform, checksums) {
    const packageName = `timing-${version}-${platform.name}`;
    const packageDir = path.join(RELEASE_DIR, packageName);
    step(`Packaging ${packageName}`);
    if (platform.name.startsWith('linux') && IS_WINDOWS_HOST) {
        console.warn('  ⚠ Built on Windows: run "chmod +x runtime/node *.sh" after unpacking on Linux.');
    }

    fs.rmSync(packageDir, { recursive: true, force: true });
    const appDir = path.join(packageDir, 'app');

    // Same layout as the repository, so the backend finds frontend/dist at the same relative path
    copy('backend/dist', path.join(appDir, 'backend/dist'));
    copy('backend/package.json', path.join(appDir, 'backend/package.json'));
    copy('backend/package-lock.json', path.join(appDir, 'backend/package-lock.json'));
    copy('frontend/dist', path.join(appDir, 'frontend/dist'));

    console.log('  Installing production dependencies');
    // --ignore-scripts: node-hid would otherwise check (or build) the binary for the build machine only
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(appDir, 'backend'));
    pruneHidPrebuilds(path.join(appDir, 'backend/node_modules/node-hid/prebuilds'), platform.prebuildSuffix);

    console.log(`  Adding Node ${NODE_VERSION} runtime`);
    const runtimePath = path.join(packageDir, 'runtime', platform.nodeBinary);
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.copyFileSync(await nodeBinary(platform, checksums), runtimePath);

    writeLaunchers(packageDir, platform);
    // The launchers use data/ as the working directory: config.yaml and the event folders go there
    fs.mkdirSync(path.join(packageDir, DATA_DIR));
    if (fs.existsSync(path.join(ROOT, 'workdir/config.yaml'))) {
        copy('workdir/config.yaml', path.join(packageDir, DATA_DIR, 'config.yaml'));
    } else {
        console.log(`  workdir/config.yaml not found: ${DATA_DIR}/ has no config.yaml (create it from the configuration page).`);
    }
    fs.writeFileSync(path.join(packageDir, 'README.txt'), readme(platform));

    const archivePath = createArchive(packageName, platform.archive);
    console.log(`  ✔ ${path.relative(ROOT, archivePath)} (${(fs.statSync(archivePath).size / 1e6).toFixed(1)} MB)`);
}

/** Keeps only the prebuilt node-hid binaries of the target platform. */
function pruneHidPrebuilds(prebuildsDir, suffix) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
        if (!entry.endsWith(suffix)) fs.rmSync(path.join(prebuildsDir, entry), { recursive: true });
    }
    if (fs.readdirSync(prebuildsDir).length === 0) {
        throw new Error(`node-hid has no prebuilt binary ending with "${suffix}".`);
    }
}

// ---------------------------------------------------------------------------
// Node runtime: downloaded once into release/.cache and checked against the official SHA-256 sums
// ---------------------------------------------------------------------------

async function fetchChecksums() {
    const response = await fetch(`${NODE_DIST_URL}/${NODE_VERSION}/SHASUMS256.txt`);
    if (!response.ok) throw new Error(`Cannot download the Node ${NODE_VERSION} checksums: HTTP ${response.status}`);

    // Lines look like "<sha256>  win-x64/node.exe"
    const checksums = new Map();
    for (const line of (await response.text()).split('\n')) {
        const [hash, file] = line.trim().split(/\s+/);
        if (hash && file) checksums.set(file, hash);
    }
    return checksums;
}

/** Returns the path of the platform's node binary, downloading and extracting it if needed. */
async function nodeBinary(platform, checksums) {
    const cacheDir = path.join(CACHE_DIR, `node-${NODE_VERSION}-${platform.name}`);
    const binaryPath = path.join(cacheDir, platform.nodeBinary);
    if (fs.existsSync(binaryPath)) return binaryPath;

    fs.mkdirSync(cacheDir, { recursive: true });
    const downloadPath = path.join(cacheDir, path.basename(platform.nodeArchive));
    await download(`${NODE_DIST_URL}/${NODE_VERSION}/${platform.nodeArchive}`, downloadPath, checksums.get(platform.nodeArchive));

    if (downloadPath.endsWith('.tar.xz')) {
        const binaryInArchive = `${path.basename(downloadPath, '.tar.xz')}/bin/node`;
        run('tar', ['-xJf', downloadPath, '-C', cacheDir, '--strip-components=2', binaryInArchive]);
        fs.rmSync(downloadPath);
    }
    return binaryPath;
}

async function download(url, destination, expectedHash) {
    if (!expectedHash) throw new Error(`No checksum published for ${url}`);
    console.log(`  Downloading ${url}`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    const content = Buffer.from(await response.arrayBuffer());

    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== expectedHash) throw new Error(`Checksum mismatch for ${url}`);
    fs.writeFileSync(destination, content);
}

// ---------------------------------------------------------------------------
// Package content
// ---------------------------------------------------------------------------

function writeLaunchers(packageDir, platform) {
    const launchers = [
        ['timing', 'server.js --open', 'Starts the timing server and opens it in the browser'],
        ['diagnose', 'tools/diagnose.js', 'Lists HID devices and helps to write triggers'],
    ];

    for (const [name, command, description] of launchers) {
        const [script, ...options] = command.split(' ');
        const extraArgs = options.map((option) => ` ${option}`).join('');
        if (platform.name.startsWith('win')) {
            // Double-clicked, the window would close before the output can be read
            const pause = name === 'diagnose' ? 'if "%~1"=="" pause\r\n' : 'if errorlevel 1 pause\r\n';
            fs.writeFileSync(
                path.join(packageDir, `${name}.cmd`),
                `@echo off\r\nrem ${description}.\r\n` +
                    `rem Working directory: ${DATA_DIR} beside this file, unless TIMING_WORK_DIR or --work-dir says otherwise.\r\n` +
                    'setlocal\r\n' +
                    `if not defined TIMING_WORK_DIR set "TIMING_WORK_DIR=%~dp0${DATA_DIR}"\r\n` +
                    `"%~dp0runtime\\node.exe" "%~dp0app\\backend\\dist\\${script.replace('/', '\\')}"${extraArgs} %*\r\n` +
                    pause
            );
        } else {
            const launcherPath = path.join(packageDir, `${name}.sh`);
            fs.writeFileSync(
                launcherPath,
                `#!/bin/sh\n# ${description}.\n` +
                    `# Working directory: ${DATA_DIR} beside this file, unless TIMING_WORK_DIR or --work-dir says otherwise.\n` +
                    `DIR="$(cd "$(dirname "$0")" && pwd)"\n` +
                    `export TIMING_WORK_DIR="\${TIMING_WORK_DIR:-$DIR/${DATA_DIR}}"\n` +
                    `exec "$DIR/runtime/node" "$DIR/app/backend/dist/${script}"${extraArgs} "$@"\n`
            );
            fs.chmodSync(launcherPath, 0o755);
        }
    }
}

function readme(platform) {
    const isWindows = platform.name.startsWith('win');
    const start = isWindows ? 'timing.cmd' : './timing.sh';
    const diagnose = isWindows ? 'diagnose.cmd' : './diagnose.sh';
    const newline = isWindows ? '\r\n' : '\n';

    return [
        `Timing ${version} (${platform.name}, Node ${NODE_VERSION} included)`,
        '',
        'START',
        `  ${start}`,
        '  The app opens in the browser at http://localhost:3001 (to change the port, set port in data/config.yaml or on the config page, then restart).',
        isWindows ? '  Double-clicking the file also works.' : '',
        '  Closing the browser does not stop the app: stop it with Ctrl+C in its terminal window.',
        '',
        'DATA',
        `  The ${DATA_DIR} folder beside this file holds everything the app reads and writes, whatever folder it is`,
        '  started from:',
        `    ${DATA_DIR}/config.yaml                            devices, port and sync key (edited on the configuration page)`,
        `    ${DATA_DIR}/<event>/<discipline>/*.csv             participants, one "bib;name" line each`,
        `    ${DATA_DIR}/<event>/<discipline>/config.yaml       discipline settings (attempts, period, access)`,
        `    ${DATA_DIR}/<event>/<discipline>/results.csv       timed runs, written by the app`,
        '  Without config.yaml, the app starts with no devices: add them on the configuration page, which creates it.',
        '  To use another folder: --work-dir <dir>, or the TIMING_WORK_DIR environment variable.',
        `  Example: ${start} --work-dir ${isWindows ? 'C:\\timing' : '/srv/timing'}`,
        '  Changes to the files are applied while the app runs.',
        '',
        'FINDING A DEVICE',
        `  ${diagnose}                          list HID devices and check config.yaml`,
        `  ${diagnose} --listen <vid:pid>       show raw reports, press each button 3 times, then Ctrl+C`,
        '  The web page also has a diagnostics view of every lane and HID interface.',
        '',
        isWindows
            ? 'NOTE: Windows does not let applications read devices that appear only as a mouse or keyboard.\n' +
              '  The diagnose tool says when that is the case and lists the other interfaces of the device.'
            : 'NOTE: reading /dev/hidraw* needs a udev rule. The diagnose tool prints the exact rule for a device\n' +
              '  it cannot open. Put it in /etc/udev/rules.d/99-timing.rules and replug the device.',
        '',
    ]
        .join('\n')
        .replace(/\n/g, newline);
}

function createArchive(packageName, format) {
    const archivePath = path.join(RELEASE_DIR, `${packageName}.${format}`);
    fs.rmSync(archivePath, { force: true });

    if (format === 'tar.gz') {
        run('tar', ['-czf', archivePath, packageName], RELEASE_DIR);
    } else if (IS_WINDOWS_HOST) {
        // Windows' tar (bsdtar) picks the zip format from the extension with -a
        run('tar', ['-a', '-cf', archivePath, packageName], RELEASE_DIR);
    } else {
        run('zip', ['-qr', archivePath, packageName], RELEASE_DIR);
    }
    return archivePath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(ROOT, from), to, { recursive: true });
}

function run(command, args, cwd = ROOT) {
    try {
        // npm is a .cmd file on Windows, which needs a shell
        execFileSync(command, args, { cwd, stdio: 'inherit', shell: IS_WINDOWS_HOST });
    } catch {
        throw new Error(`"${command} ${args.join(' ')}" failed${command === 'zip' ? ' (is zip installed?)' : ''}.`);
    }
}

function step(message) {
    console.log(`\n▶ ${message}`);
}
