/**
 * Builds ready-to-run packages of the app, with their own Node runtime:
 *   release/timing-<version>-linux-x64.tar.gz
 *   release/timing-<version>-win-x64.zip
 * <version> is the commit date-time (UTC) and the commit, e.g. 20261116-1432-2beba2a, or the build date-time alone
 * when git or the repository is not available (see releaseVersion).
 *
 *   npm run package                      Both platforms
 *   npm run package -- --platform win    One platform (linux or win)
 *
 * Runs on Linux and Windows. node-hid ships prebuilt binaries for every platform, so the same
 * node_modules works everywhere; only the Node runtime differs. Build the Linux package on Linux:
 * archives made on Windows lose the executable permission of the runtime and launchers.
 *
 * On Windows, the runtime is timing.exe: the Windows node.exe with the app icon and name, and with
 * scripts/windowsLauncher.cjs as its main script (a single executable application), so the app starts from a
 * file with its own icon. A .cmd file can only have the icon of all .cmd files.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { readmeFiles } from './packageReadme.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const CACHE_DIR = path.join(RELEASE_DIR, '.cache');
const NODE_DIST_URL = 'https://nodejs.org/dist';
// Working directory of the packaged app, beside the launchers
const DATA_DIR = 'data';
// Copied into DATA_DIR: an example config.yaml and example events, so the app has something to show on its first start
const SAMPLE_DATA_DIR = 'sample-data';
// Windows launcher: its main script, and its icon made from the app icon at each build, in the sizes Windows shows
const WINDOWS_LAUNCHER_SCRIPT = 'scripts/windowsLauncher.cjs';
const APP_ICON = 'frontend/public/favicon.svg';
const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

// The packaged runtime is the Node running this script, so it must satisfy .nvmrc
const NODE_VERSION = process.version;
const REQUIRED_NODE_MAJOR = Number(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim());

const PLATFORMS = {
    linux: {
        name: 'linux-x64',
        nodeArchive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
        nodeBinary: 'node',
        // Prebuilt native folders to keep, see node_modules/node-hid/prebuilds and node_modules/usb/prebuilds
        prebuildTarget: 'linux-x64',
        archive: 'tar.gz',
    },
    win: {
        name: 'win-x64',
        nodeArchive: 'win-x64/node.exe',
        nodeBinary: 'node.exe',
        prebuildTarget: 'win32-x64',
        archive: 'zip',
    },
};

const IS_WINDOWS_HOST = process.platform === 'win32';
const version = releaseVersion();

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
    // --ignore-scripts: node-hid and usb would otherwise check (or build) the binary for the build machine only
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(appDir, 'backend'));
    for (const module of ['node-hid', 'usb']) {
        prunePrebuilds(module, path.join(appDir, `backend/node_modules/${module}/prebuilds`), platform.prebuildTarget);
    }

    console.log(`  Adding Node ${NODE_VERSION} runtime`);
    if (platform.name.startsWith('win')) {
        await buildWindowsLauncher(await nodeBinary(platform, checksums), path.join(packageDir, 'timing.exe'));
    } else {
        const runtimePath = path.join(packageDir, 'runtime', platform.nodeBinary);
        fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
        fs.copyFileSync(await nodeBinary(platform, checksums), runtimePath);
    }

    writeLaunchers(packageDir, platform);
    // The launchers use data/ as the working directory: config.yaml and the event folders go there. It starts with
    // the example data, not the developer's workdir/ (its sync key and devices are their own)
    copy(SAMPLE_DATA_DIR, path.join(packageDir, DATA_DIR));
    const readmes = readmeFiles({ version, nodeVersion: NODE_VERSION, platformName: platform.name, dataDir: DATA_DIR });
    for (const [fileName, text] of Object.entries(readmes)) fs.writeFileSync(path.join(packageDir, fileName), text);

    const archivePath = createArchive(packageName, platform.archive);
    console.log(`  ✔ ${path.relative(ROOT, archivePath)} (${(fs.statSync(archivePath).size / 1e6).toFixed(1)} MB)`);
}

/** Keeps only the prebuilt binaries of the target platform: "linux-x64" (usb) or "HID-linux-x64" (node-hid). */
function prunePrebuilds(module, prebuildsDir, target) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
        if (entry !== target && !entry.endsWith(`-${target}`)) fs.rmSync(path.join(prebuildsDir, entry), { recursive: true });
    }
    if (fs.readdirSync(prebuildsDir).length === 0) {
        throw new Error(`${module} has no prebuilt binary for ${target}.`);
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

/**
 * Makes timing.exe from the Windows node.exe: the app icon (frontend/public/favicon.svg) and name in its resources, then scripts/windowsLauncher.cjs
 * as its main script. The Microsoft signature of node.exe is removed: it would no longer match the changed file.
 * The main script is built for the target node.exe, which must be the same Node version as the one running this
 * script: without a snapshot or code cache, the build does not depend on the platform it runs on.
 */
async function buildWindowsLauncher(nodeExePath, launcherPath) {
    const executable = NtExecutable.from(fs.readFileSync(nodeExePath), { ignoreCert: true });
    const resources = NtExecutableResource.from(executable);

    const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
    if (iconGroups.length === 0) throw new Error(`${nodeExePath} has no icon to replace.`);
    const svg = fs.readFileSync(path.join(ROOT, APP_ICON));
    // Windows reads PNG images in icons, in 32-bit colours
    const icons = WINDOWS_ICON_SIZES.map((size) => {
        const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
        return Data.RawIconItem.from(png, size, size, 32);
    });
    for (const group of iconGroups) {
        Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
    }

    // Name shown by Windows (Task Manager, file properties) instead of "Node.js JavaScript Runtime"
    const [versionInfo] = Resource.VersionInfo.fromEntries(resources.entries);
    if (!versionInfo) throw new Error(`${nodeExePath} has no version information.`);
    // 20261116-1432-2beba2a -> 2026.1116.1432.0, the numeric form Windows shows for the file version
    const [date, time] = version.split('-');
    versionInfo.setFileVersion(Number(date.slice(0, 4)), Number(date.slice(4)), Number(time), 0);
    versionInfo.setProductVersion(Number(date.slice(0, 4)), Number(date.slice(4)), Number(time), 0);
    for (const language of versionInfo.getAllLanguagesForStringValues()) {
        versionInfo.setStringValues(language, {
            FileDescription: 'Timing',
            ProductName: 'Timing',
            InternalName: 'timing',
            OriginalFilename: 'timing.exe',
            FileVersion: version,
            ProductVersion: version,
            Comments: `Node.js ${NODE_VERSION}`,
        });
    }
    versionInfo.outputToResourceEntries(resources.entries);

    resources.outputResource(executable);
    const runtimePath = path.join(CACHE_DIR, `timing-${version}.exe`);
    fs.writeFileSync(runtimePath, Buffer.from(executable.generate()));

    const configPath = path.join(CACHE_DIR, 'windows-launcher-sea.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            main: path.join(ROOT, WINDOWS_LAUNCHER_SCRIPT),
            executable: runtimePath,
            output: launcherPath,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
        })
    );
    try {
        execFileSync(process.execPath, ['--build-sea', configPath], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch {
        throw new Error('Building timing.exe failed.');
    } finally {
        fs.rmSync(runtimePath, { force: true });
        fs.rmSync(configPath, { force: true });
    }
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
            // The server starts from timing.exe itself, see scripts/windowsLauncher.cjs
            if (name === 'timing') continue;
            fs.writeFileSync(
                path.join(packageDir, `${name}.cmd`),
                `@echo off\r\nrem ${description}.\r\n` +
                    `rem Working directory: ${DATA_DIR} beside this file, unless TIMING_WORK_DIR or --work-dir says otherwise.\r\n` +
                    `"%~dp0timing.exe" ${name} %*\r\n` +
                    // Double-clicked, the window would close before the output can be read
                    'if "%~1"=="" pause\r\n'
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

/**
 * The version of the packages: commit date-time in UTC and short commit hash, e.g. 20261116-1432-2beba2a, so a
 * package tells which code it was built from and when that code was committed; building the same commit again gives
 * the same version. "-dirty" is added when the working tree has changes that are not committed: the package then
 * holds code that no commit has. Without git, or outside a git clone, the version is the build date-time alone,
 * e.g. 20261116-1432.
 */
function releaseVersion() {
    // 2026-11-16T14:32:05.123Z -> 20261116-1432
    const formatDateTime = (date) => date.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        const commit = git('rev-parse', '--short', 'HEAD');
        const commitDate = new Date(Number(git('log', '-1', '--format=%ct', 'HEAD')) * 1000);
        const dirty = git('status', '--porcelain') !== '';
        return `${formatDateTime(commitDate)}-${commit}${dirty ? '-dirty' : ''}`;
    } catch {
        console.warn('  ⚠ git or the repository is not available: the version is the build date-time only.');
        return formatDateTime(new Date());
    }
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
