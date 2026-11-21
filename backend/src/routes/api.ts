import fs from 'fs';
import { Router, Request, Response } from 'express';
import { getHardwareStatus } from '../services/hardwareService.js';
import {
    CONFIG_PATH,
    parseDevicesConfig,
    readDevicesConfigFile,
    stringifyDevicesConfig,
    validateDevicesConfig,
    writeDevicesConfigFile,
} from '../services/hardware/deviceConfig.js';
import {
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
    cancelRun,
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
import { handleRaceEvent } from '../services/raceService.js';
import { notifyLocalChange } from '../utils/localChanges.js';
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

// Gate crossings sent over HTTP instead of by the USB gates, for the end-to-end tests and for training without
// hardware. Off unless the server is started with TIMING_SIMULATE_GATES=1, so it cannot fire during a real race.
export const SIMULATE_GATES = process.env.TIMING_SIMULATE_GATES === '1';
const SIMULATED_ACTIONS = ['start_crossed', 'finish_crossed'];

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
    const { attempts, start, end, access, best, precision, rounding } = req.body.settings;
    await saveDisciplineSettings(dir, {
        attempts,
        start: start ? toDateTime(start, 'start') : null,
        end: end ? toDateTime(end, 'end') : null,
        access: access ?? DEFAULT_SETTINGS.access,
        best: best ?? DEFAULT_SETTINGS.best,
        precision: precision ?? DEFAULT_SETTINGS.precision,
        rounding: rounding ?? DEFAULT_SETTINGS.rounding,
    });
    // The best result of each participant and its time may have changed (shortest or longest, precision, rounding)
    await writeUdaResults(event, discipline);
    const saved = await loadDisciplineSettings(dir);
    broadcastToUI({ type: 'SETTINGS_UPDATE', event, discipline, settings: saved.settings });
    notifyLocalChange(event, discipline);
    res.json(saved);
});

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

// Race page: the current run (idle, ready or running)
router.get('/run', (req: Request, res: Response) => {
    res.json(getRunState());
});

// Race page: a participant is ready, the next start crossing starts their run. `bib` must be in the discipline
router.post('/run/ready', async (req: Request, res: Response) => {
    const { event, discipline, bib } = req.body ?? {};
    const list = typeof event === 'string' && typeof discipline === 'string' ? await loadParticipants(event, discipline) : null;
    const participant = list?.participants.find((p) => p.bib === String(bib));
    if (!participant) {
        res.status(404).json({ problems: ['Unknown event, discipline or participant.'] });
        return;
    }
    const problem = await prepareRun(event, discipline, participant);
    if (problem) {
        res.status(409).json({ problems: [problem] });
        return;
    }
    res.json(getRunState());
});

// Race page: ends the running run now and saves it as DQ (disqualify) or INVALID (invalidate), without a time.
// 409 when no run is in progress
for (const [action, status] of [['disqualify', 'dq'], ['invalidate', 'invalid']] as const) {
    router.post(`/run/${action}`, (req: Request, res: Response) => {
        const problem = voidRun(status);
        if (problem) {
            res.status(409).json({ problems: [problem] });
            return;
        }
        res.json(getRunState());
    });
}

// Race page: abandons the ready or running run, nothing is saved
router.post('/run/cancel', (req: Request, res: Response) => {
    cancelRun();
    res.json(getRunState());
});

// Simulated gates (see SIMULATE_GATES): fires a start_crossed or finish_crossed action now, as a gate would
if (SIMULATE_GATES) {
    log.warn('Simulated gates are on (TIMING_SIMULATE_GATES=1): POST /api/simulate/crossing fires crossings, POST /api/simulate/reset starts over.');
    router.post('/simulate/crossing', (req: Request, res: Response) => {
        const action = req.body?.action;
        if (!SIMULATED_ACTIONS.includes(action)) {
            res.status(400).json({ problems: [`action must be ${SIMULATED_ACTIONS.join(' or ')}.`] });
            return;
        }
        handleRaceEvent('simulator', 'Simulator', action, Temporal.Now.instant());
        res.json(getRunState());
    });

    // Starts over: no run in progress and no last result on the live pages (between end-to-end tests)
    router.post('/simulate/reset', (req: Request, res: Response) => {
        resetRuns();
        res.json(getRunState());
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

// Sync: every results.csv line of a discipline
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

export default router;
