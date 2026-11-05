import { onMounted, onUnmounted, ref } from 'vue';
import type { HardwareStatus } from '../types';

// Same rate as the backend device scan
const POLL_INTERVAL_MS = 1000;

/**
 * Polls GET /api/hardware/status. Polling can be paused to read a report list without it scrolling.
 */
export function useHardwareStatus() {
  const status = ref<HardwareStatus | null>(null);
  const error = ref<string | null>(null);
  const paused = ref(false);
  const lastUpdate = ref<Date | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/api/hardware/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      status.value = await response.json();
      error.value = null;
      lastUpdate.value = new Date();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  onMounted(() => {
    refresh();
    timer = setInterval(() => {
      if (!paused.value) refresh();
    }, POLL_INTERVAL_MS);
  });
  onUnmounted(() => clearInterval(timer));

  return { status, error, paused, lastUpdate, refresh };
}
