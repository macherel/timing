import crypto from 'crypto';
import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import type { Activity, LiveInstance } from '../types/messages.js';
import { broadcastToUI, getViewing } from '../websocket/wsServer.js';
import { createLogger, errorMessage } from '../utils/logger.js';
import { onActivityChange, onLocalChange } from '../utils/localChanges.js';
import { WORK_DIR, workDirPath } from '../utils/workDir.js';
import { setSyncName } from '../utils/computerName.js';
import { BACKUP_DIR, isResultsFileName, RESULTS_RESET_FILE, resultsFileName } from './eventService.js';
import { CONFIG_PATH } from './hardware/deviceConfig.js';
import { applyResultsReset, getLineRuns, mergeResultRows, readResultRows, writeUdaResults, type ResultRow } from './runService.js';

const log = createLogger('Sync');

/**
 * Syncs the event folders with the other instances of the app on the local network that have the same sync key.
 *
 * - Discovery: every instance broadcasts an announcement on UDP port 41234 (its id, name, HTTP port and a hash of
 *   its key). Instances with the same key hash become peers; a peer that stops announcing is forgotten.
 * - Sync: each instance pulls from each peer, over HTTP: the list of event files (participant CSVs, discipline
 *   config.yaml and results-reset.yaml, the backups of the results and participants of a discipline) with their
 *   modification time and hash, and the results file lines.
 *     - A file is copied when the peer's copy is newer; the copy keeps the peer's modification time, so it is not
 *       sent back.
 *     - <event>-<discipline>-results.csv is merged line by line (bib + start identify a run), the most recently changed line wins.
 *       A results-reset.yaml copied from a peer drops the runs started before the reset (after a backup of them,
 *       unless the peer's backup has them already), and runs started before it are never taken from a peer. The
 *       backups are copied first, then results-reset.yaml, then the other files: a backup made here holds the
 *       participants of before the reset.
 *   Peers are told when something changes here, so they pull at once; they also pull every few seconds.
 * - Live: each instance also shares its activity (the event, discipline, line and participant selected on its race
 *   pages, and the run in progress and last result of each of its lines), pushed to the peers when it changes and repeated in every announcement. The live
 *   page shows the activity of every computer.
 * - Not synced: config.yaml at the root of the working directory, and runs in progress.
 *   A deleted file or result line comes back from a peer that still has it.
 *
 * Enabled by the sync section of config.yaml (also editable on the config page), read again every few seconds:
 *   sync:
 *     key: amber-otter-glide   # only instances with the same key sync together
 *     name: Finish line        # optional, shown to the other instances (the computer name by default)
 */

const UDP_PORT = 41234;
const ANNOUNCE_INTERVAL_MS = 3000;
// A peer is forgotten when it has not announced itself for this long
const PEER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5000;
// Files that can be synced inside <event>/<discipline>/ (the results file is merged, not copied)
const SYNCED_EXTENSIONS = ['.csv', '.yaml', '.yml'];
// 2: results files are named <event>-<discipline>-results.csv (an older peer would copy them as participant lists)
// 3: the activity has a run per line
// 5: results are reset when the participants change (an older peer would send the runs dropped back), backups are synced
const PROTOCOL = 'timing-sync/5';

// Identifies this process in announcements, so it ignores its own and tells peers apart on one computer
const INSTANCE_ID = crypto.randomUUID();

interface SyncConfig {
    keyHash: string;
    name: string;
}

// The last error reading config.yaml, so it is logged once rather than every few seconds
let lastReadError: string | null = null;

interface Peer {
    id: string;
    name: string;
    address: string;
    port: number;
    lastSeen: number;
    lastSyncAt: string | null;
    error: string | null;
    // Peer clock minus this clock, measured at the last sync. The latest change wins, so clocks must roughly agree
    clockOffsetMs: number | null;
    pulling: boolean;
    pullAgain: boolean;
    // What the peer is doing, for the live page
    activity: Activity | null;
}

/** One event file offered to peers. `path` is "<event>/<discipline>/<file>", or "<event>/<discipline>/backup/<backup>/<file>". */
interface ManifestFile {
    path: string;
    mtimeMs: number;
    hash: string;
}

interface Manifest {
    protocol: string;
    serverTime: string;
    files: ManifestFile[];
    // Digest of each discipline's results file lines, to fetch them only when they differ
    results: { event: string; discipline: string; digest: string }[];
}

let config: SyncConfig | null = null;
let httpPort = 0;
let socket: dgram.Socket | null = null;
let timer: NodeJS.Timeout | null = null;
const peers = new Map<string, Peer>();

// ---------------------------------------------------------------------------
// Configuration and status
// ---------------------------------------------------------------------------

const hashKey = (key: string) => crypto.createHash('sha256').update(`timing-sync\n${key}`).digest('hex');
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** The sync section of config.yaml, or null when there is no key (sync disabled). */
async function readSyncConfig(): Promise<SyncConfig | null> {
    let parsed: any;
    try {
        parsed = yaml.parse(await fs.promises.readFile(CONFIG_PATH, 'utf8'));
    } catch (error: any) {
        if (error.code === 'ENOENT') return null;
        const message = `config.yaml cannot be read, sync is off: ${errorMessage(error)}`;
        if (message !== lastReadError) log.error(message);
        lastReadError = message;
        return null;
    }
    lastReadError = null;
    return toSyncConfig(parsed?.sync);
}

function toSyncConfig(section: any): SyncConfig | null {
    const key = section?.key;
    if ((typeof key !== 'string' && typeof key !== 'number') || String(key).trim() === '') return null;
    const name = typeof section?.name === 'string' && section.name.trim() ? section.name.trim() : os.hostname();
    return { keyHash: hashKey(String(key).trim()), name };
}

/** What the page shows: whether sync is on, and the peers found. */
export function getSyncStatus() {
    return {
        enabled: config !== null,
        name: config?.name ?? null,
        peers: [...peers.values()].map(({ name, address, port, lastSeen, lastSyncAt, error, clockOffsetMs }) => ({
            name,
            address,
            port,
            lastSeen: new Date(lastSeen).toISOString(),
            lastSyncAt,
            error,
            clockOffsetMs,
        })),
    };
}

/** Whether a request comes from a peer with the same key (the hash is sent in the x-timing-sync header). */
export function isPeerRequest(keyHash: string | undefined): boolean {
    return config !== null && keyHash === config.keyHash;
}

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

export function initSyncService(port: number): void {
    httpPort = port;
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', onAnnouncement);
    socket.on('error', (error) => log.error('UDP socket error, discovery stopped:', errorMessage(error)));
    socket.bind(UDP_PORT, () => socket?.setBroadcast(true));

    let activityTimer: NodeJS.Timeout | undefined;
    onActivityChange(() => {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
            broadcastLive();
            pushActivity();
        }, 50);
    });

    let notifyTimer: NodeJS.Timeout | undefined;
    onLocalChange(() => {
        // Several changes in a row (e.g. a status and a result) make one notification
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(notifyPeers, 200);
    });

    timer = setInterval(tick, ANNOUNCE_INTERVAL_MS);
    tick();
}

export function stopSyncService(): void {
    if (timer) clearInterval(timer);
    socket?.close();
    socket = null;
}

/** Re-reads the sync settings, announces this instance, forgets silent peers and pulls from the others. */
async function tick(): Promise<void> {
    const next = await readSyncConfig();
    if ((next === null) !== (config === null) || (next && config && next.keyHash !== config.keyHash)) {
        log.info(next ? `Sync on as "${next.name}" (key in config.yaml).` : 'Sync off (no sync key in config.yaml).');
        peers.clear();
        config = next;
        broadcastLive();
    }
    config = next;
    setSyncName(config?.name ?? null);
    if (!config) return;

    announce();
    for (const peer of peers.values()) {
        if (Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
            peers.delete(peer.id);
            log.info(`Peer "${peer.name}" (${peer.address}:${peer.port}) lost.`);
            broadcastLive();
        } else {
            pull(peer);
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery (UDP broadcast)
// ---------------------------------------------------------------------------

/** The broadcast address of every IPv4 network of this computer, and the generic one. */
function broadcastAddresses(): string[] {
    const addresses = new Set(['255.255.255.255']);
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            const ip = entry.address.split('.').map(Number);
            const mask = entry.netmask.split('.').map(Number);
            addresses.add(ip.map((byte, i) => (byte | (~mask[i] & 255)) & 255).join('.'));
        }
    }
    return [...addresses];
}

function announce(): void {
    if (!socket || !config) return;
    const message = Buffer.from(
        JSON.stringify({
            protocol: PROTOCOL,
            id: INSTANCE_ID,
            name: config.name,
            port: httpPort,
            keyHash: config.keyHash,
            activity: localActivity(),
        })
    );
    for (const address of broadcastAddresses()) {
        socket.send(message, UDP_PORT, address, (error) => {
            // A network without broadcast (e.g. no network at all) only stops discovery on it
            if (error) log.debug(`Cannot announce on ${address}:`, errorMessage(error));
        });
    }
}

function onAnnouncement(data: Buffer, sender: dgram.RemoteInfo): void {
    let message: any;
    try {
        message = JSON.parse(data.toString('utf8'));
    } catch {
        return;
    }
    if (message?.protocol !== PROTOCOL || message.id === INSTANCE_ID || !config) return;
    if (message.keyHash !== config.keyHash || !Number.isInteger(message.port)) return;

    const known = peers.get(message.id);
    if (known) {
        known.lastSeen = Date.now();
        known.address = sender.address;
        known.port = message.port;
        known.name = String(message.name ?? sender.address);
        setPeerActivity(known, message.activity);
        return;
    }
    const peer: Peer = {
        id: message.id,
        name: String(message.name ?? sender.address),
        address: sender.address,
        port: message.port,
        lastSeen: Date.now(),
        lastSyncAt: null,
        error: null,
        clockOffsetMs: null,
        pulling: false,
        pullAgain: false,
        activity: isActivity(message.activity) ? message.activity : null,
    };
    peers.set(peer.id, peer);
    broadcastLive();
    log.info(`Peer "${peer.name}" found at ${peer.address}:${peer.port}.`);
    pull(peer);
}

// ---------------------------------------------------------------------------
// What this instance offers to its peers
// ---------------------------------------------------------------------------

const visibleDirs = async (dir: string) =>
    (await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);

// Hash of each file by path, reused while its size and modification time do not change
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

async function fileHash(file: string, stats: fs.Stats): Promise<string> {
    const cached = hashCache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.hash;
    const hash = sha256(await fs.promises.readFile(file));
    hashCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, hash });
    return hash;
}

/**
 * Digest of results lines in a fixed order, so two files with the same lines in another order match. A line repeated
 * with the same bib and start counts once, as a merge keeps one of them.
 */
function resultsDigest(rows: ResultRow[]): string {
    const lines = new Map(rows.map((row) => [`${row.bib}\t${row.start}`, [row.name, row.finish, row.status, row.computer, row.line, row.updated].join('\t')]));
    return sha256([...lines].map(([key, rest]) => `${key}\t${rest}`).sort().join('\n'));
}

export async function buildManifest(): Promise<Manifest> {
    const manifest: Manifest = { protocol: PROTOCOL, serverTime: new Date().toISOString(), files: [], results: [] };
    for (const event of await visibleDirs(WORK_DIR)) {
        for (const discipline of await visibleDirs(path.join(WORK_DIR, event))) {
            const dir = path.join(WORK_DIR, event, discipline);
            for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                if (isSyncedFileName(event, discipline, entry.name)) {
                    const file = path.join(dir, entry.name);
                    const stats = await fs.promises.stat(file);
                    manifest.files.push({ path: `${event}/${discipline}/${entry.name}`, mtimeMs: stats.mtimeMs, hash: await fileHash(file, stats) });
                }
            }
            for (const backup of await visibleDirs(path.join(dir, BACKUP_DIR))) {
                const backupDir = path.join(dir, BACKUP_DIR, backup);
                for (const entry of await fs.promises.readdir(backupDir, { withFileTypes: true }).catch(() => [])) {
                    if (!entry.isFile() || !isBackupFileName(entry.name)) continue;
                    const file = path.join(backupDir, entry.name);
                    const stats = await fs.promises.stat(file);
                    manifest.files.push({
                        path: `${event}/${discipline}/${BACKUP_DIR}/${backup}/${entry.name}`,
                        mtimeMs: stats.mtimeMs,
                        hash: await fileHash(file, stats),
                    });
                }
            }
            // Read first: reading renames the results.csv of an earlier version
            const rows = (await readResultRows(event, discipline)) ?? [];
            if (fs.existsSync(path.join(dir, resultsFileName(event, discipline)))) {
                manifest.results.push({ event, discipline, digest: resultsDigest(rows) });
            }
        }
    }
    return manifest;
}

function isSyncedFileName(event: string, discipline: string, name: string): boolean {
    return (
        !name.startsWith('.') &&
        // The results file is merged, not copied, and its UDA export is not synced: each computer writes it from its
        // merged results
        !isResultsFileName(event, discipline, name) &&
        SYNCED_EXTENSIONS.includes(path.extname(name).toLowerCase())
    );
}

const isBackupFileName = (name: string) => !name.startsWith('.') && path.extname(name).toLowerCase() === '.csv';

/**
 * The absolute path of "<event>/<discipline>/<file>" or "<event>/<discipline>/backup/<backup>/<file>" in the working directory,
 * or null when it is not a synced file name (so a peer cannot read or write anything else, e.g. with "..").
 */
export function syncedFilePath(relative: unknown): string | null {
    if (typeof relative !== 'string') return null;
    const parts = relative.split('/');
    const validName = (name: string) => name !== '' && !name.startsWith('.') && !/[\\/:\0]/.test(name);
    if (!parts.every(validName)) return null;
    const synced =
        parts.length === 3
            ? isSyncedFileName(parts[0], parts[1], parts[2])
            : parts.length === 5 && parts[2] === BACKUP_DIR && isBackupFileName(parts[4]);
    return synced ? path.join(WORK_DIR, ...parts) : null;
}

/** Whether an event or discipline name received from a peer is a plain folder name. */
export function isFolderName(name: unknown): name is string {
    return typeof name === 'string' && name !== '' && !name.startsWith('.') && !/[\\/:\0]/.test(name);
}

// ---------------------------------------------------------------------------
// Pulling from a peer
// ---------------------------------------------------------------------------

async function request(peer: Peer, urlPath: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`http://${peer.address}:${peer.port}${urlPath}`, {
        ...init,
        headers: { 'x-timing-sync': config?.keyHash ?? '', 'content-type': 'application/json', ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${urlPath}: HTTP ${response.status}`);
    return response;
}

/** Pulls from a peer, one pull at a time; a pull asked for meanwhile runs right after. */
async function pull(peer: Peer): Promise<void> {
    if (peer.pulling) {
        peer.pullAgain = true;
        return;
    }
    peer.pulling = true;
    try {
        do {
            peer.pullAgain = false;
            await pullOnce(peer);
        } while (peer.pullAgain);
        if (peer.error) log.info(`Sync with "${peer.name}" works again.`);
        peer.error = null;
        peer.lastSyncAt = new Date().toISOString();
    } catch (error) {
        const message = errorMessage(error);
        if (peer.error !== message) log.warn(`Sync with "${peer.name}" failed: ${message}`);
        peer.error = message;
    } finally {
        peer.pulling = false;
    }
}

async function pullOnce(peer: Peer): Promise<void> {
    const sentAt = Date.now();
    const manifest = (await (await request(peer, '/api/sync/manifest')).json()) as Manifest;
    if (manifest.protocol !== PROTOCOL) throw new Error(`the peer speaks ${manifest.protocol}, not ${PROTOCOL}`);
    peer.clockOffsetMs = Date.parse(manifest.serverTime) - (sentAt + Date.now()) / 2;

    const changed = new Map<string, { event: string; discipline: string }>();
    const mark = (event: string, discipline: string) => changed.set(`${event}\n${discipline}`, { event, discipline });
    const copied = new Set<string>();
    // The backups first, then the resets: a reset applied here saves the runs it drops with the participants they were
    // timed for, before the new participant files are copied
    const order = (relative: string) => {
        const name = relative.split('/')[2];
        return name === BACKUP_DIR ? 0 : name === RESULTS_RESET_FILE ? 1 : 2;
    };
    const files = [...manifest.files].sort((a, b) => order(String(a.path)) - order(String(b.path)));

    for (const remote of files) {
        const file = syncedFilePath(remote.path);
        if (!file) continue;
        const local = await fs.promises.stat(file).catch(() => null);
        if (local && ((await fileHash(file, local)) === remote.hash || local.mtimeMs >= remote.mtimeMs)) continue;

        const content = Buffer.from(await (await request(peer, `/api/sync/file?path=${encodeURIComponent(remote.path)}`)).arrayBuffer());
        // The file changed on the peer since its list was made: the next pull gets the new version
        if (sha256(content) !== remote.hash) continue;
        await writeSyncedFile(file, content, remote.mtimeMs);
        const [event, discipline, name] = remote.path.split('/');
        mark(event, discipline);
        if (name !== BACKUP_DIR) copied.add(`${event}\n${discipline}`);
        log.info(`${remote.path} copied from "${peer.name}".`);
        // The peer's backup is here already: the runs it saved are not saved again
        if (name === RESULTS_RESET_FILE && (await applyResultsReset(event, discipline))) {
            log.info(`${event}/${discipline}: results reset by "${peer.name}".`);
        }
    }

    for (const remote of manifest.results) {
        if (!isFolderName(remote.event) || !isFolderName(remote.discipline)) continue;
        const localRows = await readResultRows(remote.event, remote.discipline);
        if (localRows && resultsDigest(localRows) === remote.digest) continue;

        const query = `event=${encodeURIComponent(remote.event)}&discipline=${encodeURIComponent(remote.discipline)}`;
        const { rows } = (await (await request(peer, `/api/sync/results?${query}`)).json()) as { rows: ResultRow[] };
        await fs.promises.mkdir(path.join(WORK_DIR, remote.event, remote.discipline), { recursive: true });
        if (await mergeResultRows(remote.event, remote.discipline, rows)) {
            mark(remote.event, remote.discipline);
            log.info(`${remote.event}/${remote.discipline}/${resultsFileName(remote.event, remote.discipline)} merged with "${peer.name}".`);
        }
    }

    for (const { event, discipline } of changed.values()) {
        // A copied config.yaml or participants file can change the best result of the participants
        if (copied.has(`${event}\n${discipline}`)) await writeUdaResults(event, discipline);
        broadcastToUI({ type: 'SYNC_UPDATE', event, discipline });
    }
}

/** Writes a copied file through a temporary file, with the peer's modification time. */
async function writeSyncedFile(file: string, content: Buffer, mtimeMs: number): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.sync.tmp`);
    await fs.promises.writeFile(tempFile, content);
    await fs.promises.rename(tempFile, file);
    await fs.promises.utimes(file, new Date(), new Date(mtimeMs));
}

/** Asks every peer to pull now (after a change here). */
function notifyPeers(): void {
    for (const peer of peers.values()) {
        request(peer, '/api/sync/notify', { method: 'POST', body: JSON.stringify({ id: INSTANCE_ID }) }).catch((error) =>
            log.debug(`Cannot notify "${peer.name}":`, errorMessage(error))
        );
    }
}

/** A peer says it changed something: pull from it now. */
export function onPeerNotification(id: unknown): void {
    const peer = typeof id === 'string' ? peers.get(id) : undefined;
    if (peer) pull(peer);
}

// ---------------------------------------------------------------------------
// Live activity
// ---------------------------------------------------------------------------

function localActivity(): Activity {
    return { viewing: getViewing(), lines: getLineRuns() };
}

/** A light check of an activity received from a peer (the page shows it as text only). */
function isActivity(value: any): value is Activity {
    return (
        value !== null &&
        typeof value === 'object' &&
        Array.isArray(value.viewing) &&
        value.viewing.every(
            (v: any) =>
                typeof v?.event === 'string' &&
                typeof v?.discipline === 'string' &&
                (v.line === null || typeof v.line === 'string') &&
                (v.participant === null || (typeof v.participant?.bib === 'string' && typeof v.participant.name === 'string')),
        ) &&
        Array.isArray(value.lines) &&
        value.lines.every((l: any) => typeof l?.line === 'string' && typeof l.run?.status === 'string')
    );
}

function setPeerActivity(peer: Peer, activity: unknown): void {
    if (!isActivity(activity) || JSON.stringify(activity) === JSON.stringify(peer.activity)) return;
    peer.activity = activity;
    broadcastLive();
}

/** This computer and the synced ones, with what they are doing. */
export function getLive(): LiveInstance[] {
    const self: LiveInstance = { id: INSTANCE_ID, name: config?.name ?? os.hostname(), self: true, clockOffsetMs: 0, ...localActivity() };
    const others = [...peers.values()]
        .filter((peer) => peer.activity)
        .map((peer) => ({ id: peer.id, name: peer.name, self: false, clockOffsetMs: peer.clockOffsetMs ?? 0, ...peer.activity! }));
    return [self, ...others];
}

function broadcastLive(): void {
    broadcastToUI({ type: 'LIVE_UPDATE', instances: getLive() });
}

/** Sends this computer's activity to every peer at once (the announcements repeat it every few seconds). */
function pushActivity(): void {
    const body = JSON.stringify({ id: INSTANCE_ID, activity: localActivity() });
    for (const peer of peers.values()) {
        request(peer, '/api/sync/activity', { method: 'POST', body }).catch((error) =>
            log.debug(`Cannot send the activity to "${peer.name}":`, errorMessage(error))
        );
    }
}

/** A peer sent its activity. */
export function onPeerActivity(id: unknown, activity: unknown): void {
    const peer = typeof id === 'string' ? peers.get(id) : undefined;
    if (peer) setPeerActivity(peer, activity);
}
