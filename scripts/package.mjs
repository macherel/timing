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
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readmeFiles } from './packageReadme.mjs';

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
