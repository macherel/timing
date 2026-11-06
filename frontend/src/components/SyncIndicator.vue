<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { SyncStatus } from '../types';

const REFRESH_MS = 5000;
// The latest change wins when two computers change the same thing, so their clocks must roughly agree
const CLOCK_WARNING_MS = 2000;

const status = ref<SyncStatus | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/api/sync');
    status.value = response.ok ? await response.json() : null;
  } catch {
    status.value = null;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
});
onUnmounted(() => clearInterval(timer));

const failing = computed(() => status.value?.peers.filter((peer) => peer.error) ?? []);
const skewed = computed(
  () => status.value?.peers.filter((peer) => peer.clockOffsetMs !== null && Math.abs(peer.clockOffsetMs) > CLOCK_WARNING_MS) ?? [],
);
const kind = computed(() => {
  if (!status.value?.enabled) return 'off';
  if (failing.value.length > 0 || skewed.value.length > 0) return 'warn';
  return status.value.peers.length > 0 ? 'ok' : 'alone';
});
const label = computed(() => {
  const peers = status.value?.peers.length ?? 0;
  if (!status.value?.enabled) return 'Sync off';
  if (peers === 0) return 'Sync: no other computer';
  return `Synced with ${peers} computer${peers > 1 ? 's' : ''}`;
});
const details = computed(() => {
  if (!status.value) return 'Sync status unavailable';
  if (!status.value.enabled) return 'Add sync.yaml with a key to the working directory to sync with other computers.';
  const lines = [`This computer: ${status.value.name}`];
  for (const peer of status.value.peers) {
    const offset = peer.clockOffsetMs !== null && Math.abs(peer.clockOffsetMs) > CLOCK_WARNING_MS;
    lines.push(
      `${peer.name} (${peer.address}:${peer.port})` +
        (peer.error ? ` — sync failing: ${peer.error}` : '') +
        (offset ? ` — clock differs by ${(peer.clockOffsetMs! / 1000).toFixed(1)} s` : ''),
    );
  }
  if (status.value.peers.length === 0) lines.push('No other computer with the same key found on the network.');
  return lines.join('\n');
});
</script>

<template>
  <span class="sync" :class="kind" :title="details" role="status">
    <span class="dot" aria-hidden="true"></span>
    {{ label }}
    <template v-if="failing.length > 0">· failing</template>
    <template v-else-if="skewed.length > 0">· clocks differ</template>
  </span>
</template>

<style scoped>
.sync {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--text-muted);
  cursor: help;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
}
.ok {
  color: var(--ok);
}
.ok .dot {
  background: var(--ok);
}
.warn {
  color: var(--warn);
}
.warn .dot {
  background: var(--warn);
}
.alone .dot {
  background: var(--text-muted);
}
</style>
