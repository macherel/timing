<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, Participant, RunResult, RunState, RunStatus } from '../../types';
import { DECIMALS, formatDuration, formatTime, parseInstant } from '../../format';
import { countsAsAttempt, isBetterTime, sameRun } from '../../race/results';

// Refresh rate of the running clock
const CLOCK_INTERVAL_MS = 50;

const props = defineProps<{
  participant: Participant;
  // The line the run is timed on, null when this computer has none
  line: string | null;
  // The run of the line
  run: RunState;
  // This participant's results in the discipline, oldest first
  results: RunResult[];
  // Time of the run that just finished, highlighted until the next run
  lastResult: RunResult | null;
  busy: boolean;
  // Why runs and result changes are disabled (outside the discipline's period), or null
  closed: string | null;
  // Why no run can start on the line (not ready or disabled), or null; its results can still be changed
  startBlocked?: string | null;
  // Runs allowed per participant, from config.yaml (in the discipline folder). null: unlimited
  attempts: number | null;
  // Which time is the best, from config.yaml: shortest, or longest for a slow race
  best: DisciplineSettings['best'];
  // Unit of the times, from config.yaml: the times are shown with as many decimals
  precision: DisciplineSettings['precision'];
}>();
const emit = defineEmits<{ ready: []; cancel: []; invalidate: []; disqualify: []; setStatus: [result: RunResult, status: RunStatus] }>();

const { t } = useI18n();

const STATUSES: RunStatus[] = ['ok', 'invalid', 'dq'];
const statusLabel = (status: RunStatus) => t(`common.status.${status}`);
const statusHint = (status: RunStatus) => t(`run.hints.${status}`);

const showTime = (ms: number) => formatDuration(ms, DECIMALS[props.precision]);

const isThisRun = computed(() => props.run.status !== 'idle' && props.run.participant.bib === props.participant.bib);
// Best time among the valid runs (shortest, or longest for a slow race); invalid and disqualified runs never count
const bestMs = computed(() => {
  const times = props.results.flatMap((result) => (result.status !== 'ok' || result.timeMs === null ? [] : [result.timeMs]));
  return times.reduce<number | null>((best, time) => (best === null || isBetterTime(time, best, props.best) ? time : best), null);
});
const validCount = computed(() => props.results.filter((result) => result.status === 'ok').length);
const usedAttempts = computed(() => props.results.filter(countsAsAttempt).length);
const noAttemptLeft = computed(() => props.attempts !== null && usedAttempts.value >= props.attempts);
// The attempt being run or about to be run, e.g. "Attempt 2 of 3"
const attemptLabel = computed(() => {
  if (noAttemptLeft.value && !isThisRun.value) return t('run.allUsed', props.attempts ?? 0);
  const next = usedAttempts.value + 1;
  return props.attempts === null ? t('run.attempt', { n: next }) : t('run.attemptOf', { n: next, total: props.attempts });
});

// The select shows the saved status until the change is saved (then the new result comes back), so a failed save
// does not leave it showing a status that is not in the file
function onStatusChange(event: Event, result: RunResult): void {
  const select = event.target as HTMLSelectElement;
  const status = select.value as RunStatus;
  select.value = result.status;
  emit('setStatus', result, status);
}

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
        <div class="muted">
          {{ participant.file }} · <span :class="{ 'no-attempt': noAttemptLeft && !isThisRun }">{{ attemptLabel }}</span>
        </div>
      </div>
    </div>

    <div class="status">
      <template v-if="isThisRun && run.status === 'ready'">
        <span class="state">{{ $t('run.waitingStart') }}</span>
        <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">{{ $t('common.cancel') }}</button>
      </template>
      <template v-else-if="isThisRun && run.status === 'running'">
        <span class="clock mono" role="timer">{{ formatDuration(elapsed, 1) }}</span>
        <button type="button" class="secondary" :disabled="busy" :title="$t('run.cancelRunTitle')" @click="$emit('cancel')">
          {{ $t('run.cancelRun') }}
        </button>
        <button type="button" class="warn" :disabled="busy" :title="$t('run.invalidateTitle')" @click="$emit('invalidate')">
          {{ $t('run.invalidate') }}
        </button>
        <button type="button" class="danger" :disabled="busy" :title="$t('run.disqualifyTitle')" @click="$emit('disqualify')">
          {{ $t('run.disqualify') }}
        </button>
      </template>
      <template v-else>
        <span v-if="lastResult && lastResult.status !== 'ok'" class="clock" :class="lastResult.status" :title="statusHint(lastResult.status)">
          {{ statusLabel(lastResult.status) }}
        </span>
        <span v-else-if="lastResult?.timeMs != null" class="clock mono done" :title="$t('run.justFinished')">
          {{ showTime(lastResult.timeMs) }}
        </span>
        <button
          type="button"
          class="ready"
          :disabled="busy || line === null || !!startBlocked || run.status !== 'idle' || noAttemptLeft || closed !== null"
          :title="
            line === null
              ? $t('run.noLine')
              : startBlocked
                ? startBlocked
                : closed
                ? $t('run.closedTitle', { reason: closed })
                : noAttemptLeft
                  ? $t('run.noAttemptLeft')
                  : undefined
          "
          @click="$emit('ready')"
        >
          {{ $t('run.ready') }}
        </button>
      </template>
    </div>

    <p v-if="!isThisRun && run.status !== 'idle'" class="alert warn other">
      {{
        $t(run.status === 'ready' ? 'run.otherWaiting' : 'run.otherRunning', {
          bib: run.participant.bib,
          name: run.participant.name,
          event: run.event,
          discipline: run.discipline,
        })
      }}
    </p>

    <div class="results">
      <h3>{{ $t('run.results') }} <span class="muted">({{ results.length }})</span></h3>
      <p v-if="results.length === 0" class="muted">{{ $t('run.noRun') }}</p>
      <table v-else>
        <thead>
          <tr>
            <th>{{ $t('run.run') }}</th>
            <th>{{ $t('run.time') }}</th>
            <th>{{ $t('run.startedAt') }}</th>
            <th>{{ $t('run.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(result, index) in results"
            :key="`${index}-${result.start}`"
            :class="{
              best: result.status === 'ok' && result.timeMs === bestMs,
              last: lastResult !== null && sameRun(result, lastResult),
              void: result.status !== 'ok',
            }"
          >
            <td>{{ index + 1 }}</td>
            <td class="mono time">
              <s v-if="result.status !== 'ok' && result.timeMs !== null">{{ showTime(result.timeMs) }}</s>
              <template v-else-if="result.timeMs !== null">{{ showTime(result.timeMs) }}</template>
              <span v-else class="muted" :title="$t('run.noTime')">—</span>
              <span v-if="result.status === 'ok' && result.timeMs === bestMs && validCount > 1" class="badge ok">{{ $t('run.best') }}</span>
            </td>
            <td class="mono muted">{{ formatTime(result.start) }}</td>
            <td>
              <select
                class="status-select"
                :class="result.status"
                :value="result.status"
                :disabled="busy || closed !== null"
                :title="statusHint(result.status)"
                :aria-label="$t('run.statusOf', { n: index + 1 })"
                @change="onStatusChange($event, result)"
              >
                <option v-for="status in STATUSES" :key="status" :value="status" :disabled="status === 'ok' && result.timeMs === null">
                  {{ statusLabel(status) }}
                </option>
              </select>
            </td>
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
  max-width: 600px;
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
.time .badge.ok {
  margin-left: 8px;
}
.status-select {
  font-size: 0.85em;
  padding: 2px 6px;
}
.status-select.invalid {
  color: var(--warn);
  border-color: var(--warn);
}
.status-select.dq {
  color: var(--error);
  border-color: var(--error);
}
tr.void td {
  color: var(--text-muted);
}
.clock.dq {
  color: var(--error);
}
.no-attempt {
  color: var(--error);
  font-weight: 600;
}
.clock.invalid {
  color: var(--warn);
}
.status button.warn {
  background: var(--warn);
  border-color: var(--warn);
}
.status button.danger {
  background: var(--error);
  border-color: var(--error);
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
