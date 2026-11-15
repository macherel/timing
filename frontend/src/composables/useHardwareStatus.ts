import { onMounted, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import type { HardwareStatus } from '../types';

// Same rate as the backend device scan
const POLL_INTERVAL_MS = 1000;

/**
 * Polls GET /api/hardware/status. Polling can be paused to read a report list without it scrolling.
 * @param monitor Device models ("0x046d:0xc548") that are not in the configuration but whose reports should be
 *   shown: the backend keeps them open as long as the polling asks for them.
 */
export function useHardwareStatus(monitor: MaybeRefOrGetter<string[]> = []) {
  const status = ref<HardwareStatus | null>(null);
  const error = ref<string | null>(null);
  const paused = ref(false);
  const lastUpdate = ref<Date | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      const models = toValue(monitor);
      const query = models.length > 0 ? `?monitor=${encodeURIComponent(models.join(','))}` : '';
      const response = await fetch(`/api/hardware/status${query}`);
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
  // A newly asked device is shown without waiting for the next poll
  watch(
    () => toValue(monitor).join(','),
    () => {
      if (!paused.value) refresh();
    },
  );

  return { status, error, paused, lastUpdate, refresh };
}
