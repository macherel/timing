<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { Participant, RunResult, RunState } from '../../types';
import { formatDuration, formatTime, parseInstant } from '../../format';

// Refresh rate of the running clock
const CLOCK_INTERVAL_MS = 50;

const props = defineProps<{
  participant: Participant;
  run: RunState;
  // This participant's results in the discipline, oldest first
  results: RunResult[];
  // Time of the run that just finished, highlighted until the next run
  lastResult: RunResult | null;
  busy: boolean;
}>();
defineEmits<{ ready: []; cancel: [] }>();

const isThisRun = computed(() => props.run.status !== 'idle' && props.run.participant.bib === props.participant.bib);
const bestMs = computed(() => Math.min(...props.results.map((result) => result.timeMs)));

// Running clock, from the browser's time: the saved result comes from the hardware timestamps
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
watch(
  () => props.run.status === 'running',
  (running) => {
    clearInterval(clockTimer);
    if (running) clockTimer = setInterval(() => (now.value = Date.now()), CLOCK_INTERVAL_MS);
  },
  { immediate: true },
);
onUnmounted(() => clearInterval(clockTimer));
const elapsed = computed(() => (props.run.status === 'running' ? now.value - parseInstant(props.run.startedAt) : 0));
</script>

<template>
  <section class="card run" :class="isThisRun ? run.status : 'idle'">
    <div class="who">
      <span class="bib mono">{{ participant.bib }}</span>
      <div>
        <div class="name">{{ participant.name }}</div>
        <div class="muted">{{ participant.file }}</div>
      </div>
    </div>

    <div class="status">
      <template v-if="isThisRun && run.status === 'ready'">
        <span class="state">Waiting for the start…</span>
        <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">Cancel</button>
      </template>
      <template v-else-if="isThisRun && run.status === 'running'">
        <span class="clock mono" role="timer">{{ formatDuration(elapsed, 1) }}</span>
        <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">Cancel run</button>
      </template>
      <template v-else>
        <span v-if="lastResult" class="clock mono done" title="Time of the run that just finished">
          {{ formatDuration(lastResult.timeMs) }}
        </span>
        <button type="button" class="ready" :disabled="busy || run.status !== 'idle'" @click="$emit('ready')">
          Ready to start
        </button>
      </template>
    </div>

    <p v-if="!isThisRun && run.status !== 'idle'" class="alert warn other">
      {{ run.participant.bib }} {{ run.participant.name }} ({{ run.event }} / {{ run.discipline }}) is
      {{ run.status === 'ready' ? 'waiting for the start' : 'running' }}.
    </p>

    <div class="results">
      <h3>Results <span class="muted">({{ results.length }})</span></h3>
      <p v-if="results.length === 0" class="muted">No run yet.</p>
      <table v-else>
        <thead>
          <tr>
            <th>Run</th>
            <th>Time</th>
            <th>Finished at</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(result, index) in results"
            :key="result.finish"
            :class="{ best: result.timeMs === bestMs, last: result.finish === lastResult?.finish }"
          >
            <td>{{ index + 1 }}</td>
            <td class="mono time">
              {{ formatDuration(result.timeMs) }}
              <span v-if="result.timeMs === bestMs && results.length > 1" class="badge ok">best</span>
            </td>
            <td class="mono muted">{{ formatTime(result.finish) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.run {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px 24px;
  align-items: center;
  border-left: 6px solid var(--border);
}
.run.ready {
  border-left-color: var(--warn);
}
.run.running {
  border-left-color: var(--ok);
}
.who {
  display: flex;
  align-items: center;
  gap: 24px;
}
.who .bib {
  font-size: 2.6em;
  font-weight: 700;
  color: var(--accent);
  line-height: 1;
}
.who .name {
  font-size: 1.5em;
  font-weight: 600;
  color: var(--text-h);
}
.status {
  display: flex;
  align-items: center;
  gap: 16px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.state {
  font-size: 1.3em;
  font-weight: 600;
  color: var(--warn);
}
.clock {
  font-size: 2.6em;
  font-weight: 700;
  color: var(--ok);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.clock.done {
  color: var(--text-h);
}
button.ready {
  font-size: 1.2em;
  padding: 10px 24px;
}
.other,
.results {
  grid-column: 1 / -1;
}
.results h3 {
  margin: 0 0 8px;
}
.results table {
  max-width: 480px;
}
.time {
  font-variant-numeric: tabular-nums;
}
tr.best .time {
  font-weight: 700;
  color: var(--ok);
}
tr.last {
  background: var(--accent-bg);
}
@media (max-width: 720px) {
  .run {
    grid-template-columns: 1fr;
  }
  .status {
    justify-content: flex-start;
  }
}
</style>
