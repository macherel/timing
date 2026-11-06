import express from 'express';
import { createServer } from 'http';
import cors from 'cors';

import apiRouter from './routes/api.js';
import { setupFrontendMiddleware } from './middlewares/frontend.js';
import { setupWebSocketServer } from './websocket/wsServer.js';
import { initHardwareService, stopHardwareService } from './services/hardwareService.js';
import { initSyncService, stopSyncService } from './services/syncService.js';
import { createLogger } from './utils/logger.js';
import { argValue, checkWorkDir } from './utils/workDir.js';
import { openBrowser } from './utils/openBrowser.js';
import { isPort, readConfiguredPort } from './services/hardware/deviceConfig.js';

const log = createLogger('Server');
const DEFAULT_PORT = 3001;
const PORT = choosePort();
// --open: show the app in the default browser once the server listens (used by the packaged launchers)
const OPEN_BROWSER = process.argv.includes('--open');
// Open WebSocket connections keep server.close() waiting, so shutdown is forced after this delay
const SHUTDOWN_TIMEOUT_MS = 2000;

checkWorkDir();

/**
 * The HTTP port, chosen in this order: the --port <n> argument, the PORT environment variable, port in
 * config.yaml, then 3001.
 */
function choosePort(): number {
    const sources: [string, string | undefined][] = [
        ['--port', argValue('--port')],
        ['PORT', process.env.PORT],
    ];
    for (const [source, value] of sources) {
        if (value === undefined || value === '') continue;
        const port = Number(value);
        if (isPort(port)) return port;
        log.error(`${source} "${value}" is not a whole number from 1 to 65535, ignored.`);
    }
    return readConfiguredPort() ?? DEFAULT_PORT;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRouter);
setupFrontendMiddleware(app);

// HTTP and WebSocket share the same port
const server = createServer(app);
setupWebSocketServer(server);

server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
        log.error(`Port ${PORT} is already used, maybe by another copy of the app. Choose another one with port in config.yaml, --port or PORT.`);
    } else {
        log.error(`Cannot listen on port ${PORT}: ${error.message}`);
    }
    process.exit(1);
});

server.listen(PORT, () => {
    log.info(`🚀 Backend listening on http://localhost:${PORT}`);
    initHardwareService();
    initSyncService(PORT);
    if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
});

// Release the HID devices and watchers on shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        log.info(`Received ${signal}, shutting down...`);
        stopHardwareService();
        stopSyncService();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    });
}
