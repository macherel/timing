import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMessage } from '../types/messages.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WebSocket');

let wss: WebSocketServer | null = null;

/**
 * Starts the WebSocket server on the existing HTTP server (same port).
 */
export function setupWebSocketServer(httpServer: HTTPServer): WebSocketServer {
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws: WebSocket) => {
        log.info('Frontend client connected');
        ws.on('close', () => log.info('Frontend client disconnected'));
        ws.on('error', (error) => log.error('Client error:', error));
    });

    log.info('WebSocket server ready');
    return wss;
}

/**
 * Sends a message to all connected frontend clients.
 */
export function broadcastToUI(message: ServerMessage): void {
    if (!wss) {
        log.warn('Attempted to broadcast before server initialization.');
        return;
    }

    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}
