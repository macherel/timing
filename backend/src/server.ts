import express from 'express';
import { createServer } from 'http';
import cors from 'cors';

import apiRouter from './routes/api.js';
import { setupFrontendMiddleware } from './middlewares/frontend.js';
import { setupWebSocketServer } from './websocket/wsServer.js';
import { initHardwareService, stopHardwareService } from './services/hardwareService.js';
import { initSyncService, stopSyncService } from './services/syncService.js';
import { createLogger } from './utils/logger.js';
import { checkWorkDir } from './utils/workDir.js';
import { openBrowser } from './utils/openBrowser.js';

const log = createLogger('Server');
const PORT = process.env.PORT || 3001;
// --open: show the app in the default browser once the server listens (used by the packaged launchers)
const OPEN_BROWSER = process.argv.includes('--open');
// Open WebSocket connections keep server.close() waiting, so shutdown is forced after this delay
const SHUTDOWN_TIMEOUT_MS = 2000;

checkWorkDir();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRouter);
setupFrontendMiddleware(app);

// HTTP and WebSocket share the same port
const server = createServer(app);
setupWebSocketServer(server);

server.listen(PORT, () => {
    log.info(`🚀 Backend listening on http://localhost:${PORT}`);
    initHardwareService();
    initSyncService(Number(PORT));
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
