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
    prepareRun,
    RUN_STATUSES,
    setResultStatus,
    voidRun,
} from '../services/runService.js';
import { WORK_DIR } from '../utils/workDir.js';

const router = Router();

// Server health check route
router.get('/status', (req: Request, res: Response) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

// Device diagnostics: which devices are listening or failing, and why
router.get('/hardware/status', (req: Request, res: Response) => {
    res.json(getHardwareStatus());
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
    const { attempts, start, end, access } = req.body.settings;
    await saveDisciplineSettings(dir, {
        attempts,
        start: start ? toDateTime(start, 'start') : null,
        end: end ? toDateTime(end, 'end') : null,
        access: access ?? 'auto',
    });
    const saved = await loadDisciplineSettings(dir);
    broadcastToUI({ type: 'SETTINGS_UPDATE', event, discipline, settings: saved.settings });
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
