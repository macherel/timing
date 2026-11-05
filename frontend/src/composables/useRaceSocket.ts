import { onMounted, onUnmounted, ref } from 'vue';
import type { RaceUpdateMessage, ServerMessage } from '../types';

const RECONNECT_DELAY_MS = 2000;
const EVENTS_KEPT = 100;

function getWebSocketUrl(): string {
  if (import.meta.env.DEV) {
    return 'ws://localhost:3001';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

/**
 * Connects to the backend WebSocket, reconnects when it drops, and keeps the latest race events (newest first).
 * `onMessage` receives every message; `onConnect` runs on each (re)connection, to reload state missed meanwhile.
 */
export function useRaceSocket(options: { onMessage?: (message: ServerMessage) => void; onConnect?: () => void } = {}) {
  const connected = ref(false);
  const events = ref<RaceUpdateMessage[]>([]);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function connect(): void {
    socket = new WebSocket(getWebSocketUrl());
    socket.onopen = () => {
      connected.value = true;
      options.onConnect?.();
    };
    socket.onclose = () => {
      connected.value = false;
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    socket.onmessage = (event) => {
      const message: ServerMessage = JSON.parse(event.data);
      if (message.type === 'RACE_UPDATE') {
        events.value = [message, ...events.value].slice(0, EVENTS_KEPT);
      }
      options.onMessage?.(message);
    };
  }

  onMounted(connect);
  onUnmounted(() => {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  });

  return { connected, events, clear: () => (events.value = []) };
}
