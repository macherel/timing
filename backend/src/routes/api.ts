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
