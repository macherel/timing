import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, Viewing } from '../types/messages.js';
import { createLogger } from '../utils/logger.js';
import { notifyActivityChange } from '../utils/localChanges.js';

const log = createLogger('WebSocket');

let wss: WebSocketServer | null = null;

// The event, discipline and selected participant each connected race page shows
const views = new Map<WebSocket, Viewing>();

/** What the race pages connected now show, without duplicates. */
export function getViewing(): Viewing[] {
    const key = (view: Viewing) => `${view.event}\n${view.discipline}\n${view.participant?.bib ?? ''}`;
    const unique = new Map([...views.values()].map((view) => [key(view), view]));
    return [...unique.values()];
}

const isParticipant = (value: any): value is { bib: string; name: string } =>
    typeof value?.bib === 'string' && typeof value?.name === 'string';

function onClientMessage(ws: WebSocket, data: unknown): void {
    let message: ClientMessage;
    try {
        message = JSON.parse(String(data));
    } catch {
        return;
    }
    if (message?.type !== 'VIEWING') return;
    if (typeof message.event === 'string' && typeof message.discipline === 'string' && message.event && message.discipline) {
        const participant = isParticipant(message.participant)
            ? { bib: message.participant.bib, name: message.participant.name }
            : null;
        views.set(ws, { event: message.event, discipline: message.discipline, participant });
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
    // ws repeats the HTTP server's errors (e.g. port already used), which server.ts reports: without a listener they would crash
    wss.on('error', () => {});

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
