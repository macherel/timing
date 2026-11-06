import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../types/messages.js';
import { createLogger } from '../utils/logger.js';
import { notifyActivityChange } from '../utils/localChanges.js';

const log = createLogger('WebSocket');

let wss: WebSocketServer | null = null;

// The event and discipline each connected race page shows
const views = new Map<WebSocket, { event: string; discipline: string }>();

/** Event and discipline shown by the race pages connected now, without duplicates. */
export function getViewing(): { event: string; discipline: string }[] {
    const unique = new Map([...views.values()].map((view) => [`${view.event}\n${view.discipline}`, view]));
    return [...unique.values()];
}

function onClientMessage(ws: WebSocket, data: unknown): void {
    let message: ClientMessage;
    try {
        message = JSON.parse(String(data));
    } catch {
        return;
    }
    if (message?.type !== 'VIEWING') return;
    if (typeof message.event === 'string' && typeof message.discipline === 'string' && message.event && message.discipline) {
        views.set(ws, { event: message.event, discipline: message.discipline });
    } else {
        views.delete(ws);
    }
    notifyActivityChange();
}

/**
 * Starts the WebSocket server on the existing HTTP server (same port).
 */
export function setupWebSocketServer(httpServer: HTTPServer): WebSocketServer {
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws: WebSocket) => {
        log.info('Frontend client connected');
        ws.on('message', (data) => onClientMessage(ws, data));
        ws.on('close', () => {
            log.info('Frontend client disconnected');
            if (views.delete(ws)) notifyActivityChange();
        });
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
