import fs from 'fs';
import express, { Router, Request, Response } from 'express';
import { getHardwareStatus, reloadDevicesConfig } from '../services/hardwareService.js';
import { getLines, isLine, isLineEnabled, isLineReady, isManualLine, MANUAL_LINE, SIMULATE_GATES } from '../services/lines.js';
import {
    CONFIG_PATH,
    GATES,
    parseDevicesConfig,
    readDevicesConfigFile,
    stringifyDevicesConfig,
    validateDevicesConfig,
    writeDevicesConfigFile,
} from '../services/hardware/deviceConfig.js';
import {
    createDiscipline,
    createEvent,
    CreateError,
    DEFAULT_SETTINGS,
    disciplineDir,
    listEvents,
    loadDisciplineSettings,
    loadParticipants,
    saveDisciplineSettings,
    toDateTime,
    validateDisciplineSettings,
} from '../services/eventService.js';
import { broadcastToUI } from '../websocket/wsServer.js';
import {
    disciplineFile,
    listDisciplineFiles,
    MAX_UPLOAD_BYTES,
    UploadError,
    writeParticipantFile,
} from '../services/disciplineFiles.js';
import {
    cancelRun,
    getLineRuns,
    getRunState,
    loadResults,
    resetRuns,
    prepareRun,
    readResultRows,
    RUN_STATUSES,
    setResultStatus,
    voidRun,
    writeUdaResults,
} from '../services/runService.js';
import { WORK_DIR } from '../utils/workDir.js';
import { createLogger } from '../utils/logger.js';
import { handleCrossing } from '../services/raceService.js';
import { notifyLocalChange } from '../utils/localChanges.js';
import { computerName } from '../utils/computerName.js';
import { lockState, unlock } from '../services/adminLock.js';
import {
    buildManifest,
    getLive,
    getSyncStatus,
    isFolderName,
    isPeerRequest,
    onPeerActivity,
    onPeerNotification,
    syncedFilePath,
} from '../services/syncService.js';

const router = Router();
const log = createLogger('API');


// Server health check route
router.get('/status', (req: Request, res: Response) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

// Device diagnostics: which devices are listening or failing, and why.
// ?monitor=0x046d:0xc548,... also opens these devices (not in the configuration) to show their reports
router.get('/hardware/status', (req: Request, res: Response) => {
    const monitor = typeof req.query.monitor === 'string' ? req.query.monitor.split(',').filter(Boolean) : [];
    res.json(getHardwareStatus(monitor));
});

// Race page: events of the working directory, with their disciplines
router.get('/events', async (req: Request, res: Response) => {
    res.json({ workDir: WORK_DIR, events: await listEvents() });
});

/** Sends why an event or discipline cannot be created, or passes on another error. */
function sendCreateError(res: Response, error: unknown): void {
    if (!(error instanceof CreateError)) throw error;
    res.status(error.status).json({ problems: [error.message] });
}

// Home page (administration): creates an event, an empty folder
router.post('/events', async (req: Request, res: Response) => {
    if (typeof req.body?.name !== 'string') {
        res.status(400).json({ problems: ['name must be a string.'] });
        return;
    }
    try {
        const event = await createEvent(req.body.name);
        broadcastToUI({ type: 'EVENTS_UPDATE' });
        res.status(201).json({ event });
    } catch (error) {
        sendCreateError(res, error);
    }
});

// Home page (administration): creates a discipline in an event, a folder with its settings file
router.post('/events/:event/disciplines', async (req: Request, res: Response) => {
    if (typeof req.body?.name !== 'string') {
        res.status(400).json({ problems: ['name must be a string.'] });
        return;
    }
    const event = String(req.params.event);
    try {
        const discipline = await createDiscipline(event, req.body.name);
        broadcastToUI({ type: 'EVENTS_UPDATE' });
        notifyLocalChange(event, discipline);
        res.status(201).json({ event, discipline });
    } catch (error) {
        sendCreateError(res, error);
    }
});

// Race page: participants of a discipline, merged from its CSV files. 404 when the event or discipline does not exist
router.get('/events/:event/:discipline/participants', async (req: Request, res: Response) => {
    const list = await loadParticipants(String(req.params.event), String(req.params.discipline));
    if (!list) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    res.json(list);
});

// Race page: the settings of a discipline, from its config.yaml, with the problems found in it
router.get('/events/:event/:discipline/settings', async (req: Request, res: Response) => {
    const dir = await disciplineDir(String(req.params.event), String(req.params.discipline));
    if (!dir) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    res.json(await loadDisciplineSettings(dir));
});

// Race page: saves the settings of a discipline to its config.yaml, then returns them as read back from the file
router.put('/events/:event/:discipline/settings', async (req: Request, res: Response) => {
    const event = String(req.params.event);
    const discipline = String(req.params.discipline);
    const dir = await disciplineDir(event, discipline);
    if (!dir) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    const problems = validateDisciplineSettings(req.body?.settings);
    if (problems.length > 0) {
        res.status(422).json({ problems });
        return;
    }
    const { attempts, start, end, access, best, precision, rounding, recentRuns, trigger } = req.body.settings;
    await saveDisciplineSettings(dir, {
        attempts,
        start: start ? toDateTime(start, 'start') : null,
        end: end ? toDateTime(end, 'end') : null,
        access: access ?? DEFAULT_SETTINGS.access,
        best: best ?? DEFAULT_SETTINGS.best,
        precision: precision ?? DEFAULT_SETTINGS.precision,
        rounding: rounding ?? DEFAULT_SETTINGS.rounding,
        recentRuns: recentRuns ?? DEFAULT_SETTINGS.recentRuns,
        trigger: trigger ?? DEFAULT_SETTINGS.trigger,
    });
    // The best result of each participant and its time may have changed (shortest or longest, precision, rounding)
    await writeUdaResults(event, discipline);
    const saved = await loadDisciplineSettings(dir);
    broadcastToUI({ type: 'SETTINGS_UPDATE', event, discipline, settings: saved.settings });
    notifyLocalChange(event, discipline);
    res.json(saved);
});

// Settings page of a discipline: its participant files and the files the app writes
router.get('/events/:event/:discipline/files', async (req: Request, res: Response) => {
    const dir = await disciplineDir(String(req.params.event), String(req.params.discipline));
    if (!dir) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    res.json({ files: await listDisciplineFiles(dir) });
});

// Settings page of a discipline: downloads one of its files
router.get('/events/:event/:discipline/files/:file', async (req: Request, res: Response) => {
    const dir = await disciplineDir(String(req.params.event), String(req.params.discipline));
    const file = dir && (await disciplineFile(dir, String(req.params.file)));
    if (!file) {
        res.status(404).json({ problems: ['Unknown event, discipline or file.'] });
        return;
    }
    res.download(file);
});

// Settings page of a discipline: uploads its participant file (the first one, or one replacing a file), as the raw
// bytes of the body
router.put(
    '/events/:event/:discipline/files/:file',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
        const event = String(req.params.event);
        const discipline = String(req.params.discipline);
        const dir = await disciplineDir(event, discipline);
        if (!dir) {
            res.status(404).json({ problems: ['Unknown event or discipline.'] });
            return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            res.status(400).json({ problems: ['The file is empty.'] });
            return;
        }
        let written: { name: string; created: boolean };
        try {
            written = await writeParticipantFile(dir, String(req.params.file), req.body);
        } catch (error) {
            if (!(error instanceof UploadError)) throw error;
            res.status(error.status).json({ problems: [error.message] });
            return;
        }
        // The participants decide which bibs the UDA export lists
        await writeUdaResults(event, discipline);
        broadcastToUI({ type: 'SYNC_UPDATE', event, discipline });
        notifyLocalChange(event, discipline);
        res.status(written.created ? 201 : 200).json(written);
    },
);

// Race page: results of a discipline (every run, oldest first)
router.get('/events/:event/:discipline/results', async (req: Request, res: Response) => {
    const results = await loadResults(String(req.params.event), String(req.params.discipline));
    if (!results) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    res.json({ results });
});

// Race page: changes the status of a saved run (ok, invalid or dq). `bib` and `start` (the run's start instant)
// together identify it
router.patch('/events/:event/:discipline/results', async (req: Request, res: Response) => {
    const { bib, start, status } = req.body ?? {};
    if (typeof bib !== 'string' || typeof start !== 'string' || !RUN_STATUSES.includes(status)) {
        res.status(400).json({ problems: [`bib (string), start (string) and status (${RUN_STATUSES.join(', ')}) are required.`] });
        return;
    }
    const outcome = await setResultStatus(String(req.params.event), String(req.params.discipline), bib, start, status);
    if ('problem' in outcome) {
        res.status(outcome.status).json({ problems: [outcome.problem] });
        return;
    }
    res.json(outcome.result);
});

// Race page: the name of this computer and its lines, each with its run (idle, ready or running) and the last run it ended
router.get('/lines', (req: Request, res: Response) => {
    res.json({ computer: computerName(), lines: getLineRuns() });
});

// The run of the line of the URL, or a 404 answer
function lineRun(req: Request, res: Response): { line: string; ready: boolean } | null {
    const line = String(req.params.line);
    if (getRunState(line)) return { line, ready: isLineReady(line) };
    res.status(404).json({ problems: [`Unknown line "${line}".`] });
    return null;
}

// Race page: a participant is ready on a line, its next start crossing starts their run. `bib` must be in the discipline
router.post('/lines/:line/ready', async (req: Request, res: Response) => {
    const target = lineRun(req, res);
    if (!target) return;
    if (!target.ready) {
        res.status(409).json({ problems: [`${target.line} is not ready: it is disabled, or the app does not listen to the device of its start or finish.`] });
        return;
    }
    const { event, discipline, bib } = req.body ?? {};
    const list = typeof event === 'string' && typeof discipline === 'string' ? await loadParticipants(event, discipline) : null;
    const participant = list?.participants.find((p) => p.bib === String(bib));
    if (!participant) {
        res.status(404).json({ problems: ['Unknown event, discipline or participant.'] });
        return;
    }
    const problem = await prepareRun(target.line, event, discipline, participant);
    if (problem) {
        res.status(409).json({ problems: [problem] });
        return;
    }
    res.json(getRunState(target.line));
});

// Race page: ends the running run of a line now and saves it as DQ (disqualify) or INVALID (invalidate), without a
// time. 409 when no run is in progress on the line
for (const [action, status] of [['disqualify', 'dq'], ['invalidate', 'invalid']] as const) {
    router.post(`/lines/:line/${action}`, (req: Request, res: Response) => {
        const target = lineRun(req, res);
        if (!target) return;
        const problem = voidRun(target.line, status);
        if (problem) {
            res.status(409).json({ problems: [problem] });
            return;
        }
        res.json(getRunState(target.line));
    });
}

// Race page of the manual line (disciplines timed by hand): the space bar was pressed. It is the start crossing of the
// participant who is ready, or the finish crossing of the run in progress. Timestamped on arrival, before anything else
router.post('/lines/:line/key', (req: Request, res: Response) => {
    const instant = Temporal.Now.instant();
    const target = lineRun(req, res);
    if (!target) return;
    if (!isManualLine(target.line)) {
        res.status(409).json({ problems: [`Only the line "${MANUAL_LINE}" is started and finished with the keyboard.`] });
        return;
    }
    const gate = getRunState(target.line)?.status === 'running' ? 'finish' : 'start';
    handleCrossing(target.line, gate, 'Keyboard', instant);
    res.json(getRunState(target.line));
});

// Race page: abandons the ready or running run of a line, nothing is saved
router.post('/lines/:line/cancel', (req: Request, res: Response) => {
    const target = lineRun(req, res);
    if (!target) return;
    cancelRun(target.line);
    res.json(getRunState(target.line));
});

// Simulated gates (see SIMULATE_GATES): a crossing of the start or finish gate of a line (the first enabled one by default)
// now, as a device button would fire it
if (SIMULATE_GATES) {
    log.warn('Simulated gates are on (TIMING_SIMULATE_GATES=1): POST /api/simulate/crossing fires crossings, POST /api/simulate/reset starts over.');
    router.post('/simulate/crossing', (req: Request, res: Response) => {
        const { gate, line = getLines().find(isLineEnabled) } = req.body ?? {};
        if (!GATES.includes(gate)) {
            res.status(400).json({ problems: [`gate must be ${GATES.join(' or ')}.`] });
            return;
        }
        if (!isLine(line)) {
            res.status(404).json({ problems: [`Unknown line "${line}".`] });
            return;
        }
        // Like its device buttons, which are not listened to
        if (!isLineEnabled(line)) {
            res.status(409).json({ problems: [`${line} is disabled.`] });
            return;
        }
        handleCrossing(line, gate, 'Simulator', Temporal.Now.instant());
        res.json(getRunState(line));
    });

    // Starts over: reads config.yaml again (no file: no line, so the simulated lines), no run in progress and no last
    // result on the live pages (between end-to-end tests)
    router.post('/simulate/reset', async (req: Request, res: Response) => {
        await reloadDevicesConfig();
        resetRuns();
        res.json({ lines: getLineRuns() });
    });
}

// Live page: what this computer and the synced ones are doing
router.get('/live', (req: Request, res: Response) => {
    res.json({ instances: getLive() });
});

// Sync: whether it is on and which other computers were found (shown in the navigation bar)
router.get('/sync', (req: Request, res: Response) => {
    res.json(getSyncStatus());
});

// Sync between instances: only for peers with the same key (its hash is in the x-timing-sync header)
router.use('/sync', (req: Request, res: Response, next) => {
    if (isPeerRequest(req.get('x-timing-sync'))) next();
    else res.status(403).json({ problems: ['Sync is off, or the sync key differs.'] });
});

// Sync: the event files and results digests this instance offers
router.get('/sync/manifest', async (req: Request, res: Response) => {
    res.json(await buildManifest());
});

// Sync: one event file, "<event>/<discipline>/<file>"
router.get('/sync/file', async (req: Request, res: Response) => {
    const file = syncedFilePath(req.query.path);
    const content = file && (await fs.promises.readFile(file).catch(() => null));
    if (!content) {
        res.status(404).json({ problems: ['Unknown file.'] });
        return;
    }
    res.type('application/octet-stream').send(content);
});

// Sync: every line of the results file of a discipline
router.get('/sync/results', async (req: Request, res: Response) => {
    const { event, discipline } = req.query;
    const rows = isFolderName(event) && isFolderName(discipline) ? await readResultRows(event, discipline) : null;
    if (!rows) {
        res.status(404).json({ problems: ['Unknown event or discipline.'] });
        return;
    }
    res.json({ rows });
});

// Sync: a peer's activity changed (run, last result, race pages shown)
router.post('/sync/activity', (req: Request, res: Response) => {
    onPeerActivity(req.body?.id, req.body?.activity);
    res.json({ ok: true });
});

// Sync: a peer changed something, pull from it now
router.post('/sync/notify', (req: Request, res: Response) => {
    onPeerNotification(req.body?.id);
    res.json({ ok: true });
});

// Config page: the current config.yaml, parsed. `config` is null when the file is missing or invalid
// (`problems` then says why, and `content` holds the text so it can be shown).
router.get('/config', async (req: Request, res: Response) => {
    const { content, modifiedAt } = await readDevicesConfigFile();
    const { config, problems } = content === null ? { config: null, problems: [] } : parseDevicesConfig(content);
    res.json({ path: CONFIG_PATH, modifiedAt, config, problems, content: config ? undefined : content });
});

// Config page: check a config object without saving it
router.post('/config/validate', (req: Request, res: Response) => {
    res.json({ problems: validateDevicesConfig(req.body?.config) });
});

// Config page: save a config object as config.yaml. The hardware service picks the change up through its
// file watcher. `modifiedAt` is the modification time the page loaded (null for a new file), to detect
// concurrent changes.
router.put('/config', async (req: Request, res: Response) => {
    const { config, modifiedAt } = req.body ?? {};
    const problems = validateDevicesConfig(config);
    if (problems.length > 0) {
        res.status(422).json({ problems });
        return;
    }

    const current = await readDevicesConfigFile();
    if (current.modifiedAt !== modifiedAt) {
        res.status(409).json({ problems: ['config.yaml was changed by someone else since it was loaded.'] });
        return;
    }

    res.json({ modifiedAt: await writeDevicesConfigFile(stringifyDevicesConfig(config)) });
});

// Administration lock: whether config.yaml has an adminPassword, and whether ?token= (from unlock) unlocks it
router.get('/admin/lock', (req: Request, res: Response) => {
    res.json(lockState(req.query.token));
});

// Administration lock: the token for the password typed, to send with GET /admin/lock
router.post('/admin/unlock', (req: Request, res: Response) => {
    const token = unlock(req.body?.password);
    if (token === null) {
        log.warn('Wrong administration password typed.');
        res.status(401).json({ problems: ['Wrong password.'] });
        return;
    }
    res.json({ token });
});

export default router;
