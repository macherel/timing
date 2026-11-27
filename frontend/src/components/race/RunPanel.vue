<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, Measure, Participant, RunResult, RunState, RunStatus } from '../../types';
import { formatDuration, formatTime, formatValue, parseInstant } from '../../format';
import { bestRule, countsAsAttempt, eliminatedAt, failedAt, isBetterTime, openDistance, sameRun, valueOf, withinAttempts } from '../../race/results';

// Refresh rate of the running clock
const CLOCK_INTERVAL_MS = 50;

const props = defineProps<{
  participant: Participant;
  // The line the run is timed on, null when this computer has none
  line: string | null;
  // The name of the key that starts and finishes the run on the manual line (disciplines timed by hand), null otherwise
  keyLabel?: string | null;
  // The run of the line
  run: RunState;
  // This participant's results in the discipline, oldest first
  results: RunResult[];
  // Time of the run that just finished, highlighted until the next run
  lastResult: RunResult | null;
  // The last run of the line, any participant: the distance it suggests for the next one
  previousRun?: RunResult | null;
  // How many runs the results show at once, the latest first (the others by scrolling): those the discipline settings
  // ask for, unless changed for now from the title
  resultRows?: number;
  // How many the discipline settings ask for, when it differs from `resultRows`: the title offers to go back to it
  settingsResultRows?: number;
  busy: boolean;
  // Why runs and result changes are disabled (outside the discipline's period), or null
  closed: string | null;
  // Why no run can start on the line (not ready or disabled), or null; its results can still be changed
  startBlocked?: string | null;
  // Runs allowed per participant, from config.yaml (in the discipline folder). null: unlimited
  attempts: number | null;
  // Which time is the best, from config.yaml: shortest, or longest for a slow race
  best: DisciplineSettings['best'];
  // Unit of the times, from config.yaml: the times are shown with as many decimals (a distance is in centimetres)
  precision: DisciplineSettings['precision'];
  // What a run measures, from config.yaml: a time (by default), or a distance typed here before the participant is
  // ready, then validated or not
  measure?: Measure;
  // For a distance, runs allowed at one same distance, from config.yaml: a participant who used them all is eliminated.
  // null: unlimited
  attemptsPerDistance?: number | null;
  // For a distance, the shortest distance that can be typed, in centimetres, from config.yaml: suggested before the
  // first run of the line. null: no minimum
  minDistance?: number | null;
  // For a distance, whether the participant can change distance before validating the last one they tried
  allowDistanceChange?: boolean;
}>();
const emit = defineEmits<{
  // With the distance typed, in centimetres, for a discipline that measures a distance
  ready: [distance?: number, unlock?: boolean];
  validate: [];
  cancel: [];
  invalidate: [];
  disqualify: [];
  setStatus: [result: RunResult, status: RunStatus];
  // For now only: the settings of the discipline are not changed
  resizeResults: [rows: number];
}>();

// The most runs shown at once
const MAX_RESULT_ROWS = 50;
const rows = computed(() => props.resultRows ?? 5);
// The results, the latest first, with their number (the first run is 1)
const latestFirst = computed(() => props.results.map((result, index) => ({ result, n: index + 1 })).reverse());
// The results scroll beyond `rows` runs: as high as its header and that many rows
const scroller = ref<HTMLElement | null>(null);
const maxHeight = ref<string | undefined>(undefined);
function fitHeight(): void {
  const element = scroller.value;
  if (!element) return;
  const trs = [...element.querySelectorAll<HTMLElement>('tbody tr')];
  const height =
    (element.querySelector<HTMLElement>('thead')?.offsetHeight ?? 0) + trs.slice(0, rows.value).reduce((sum, tr) => sum + tr.offsetHeight, 0);
  maxHeight.value = trs.length > rows.value && height > 0 ? `${height}px` : undefined;
}
watch(
  [() => props.results.length, rows],
  async ([length], [before]) => {
    await nextTick();
    fitHeight();
    // A new run: shown at the top
    if (length !== before && scroller.value) scroller.value.scrollTop = 0;
  },
  { immediate: true },
);
onMounted(fitHeight);

const { t } = useI18n();

const STATUSES: RunStatus[] = ['ok', 'invalid', 'dq'];
const statusLabel = (status: RunStatus) => t(`common.status.${status}`);
const statusHint = (status: RunStatus) => t(`run.hints.${status}`);

const measure = computed<Measure>(() => props.measure ?? 'time');
const isDistance = computed(() => measure.value === 'distance');
const showValue = (value: number) => formatValue(value, measure.value, props.precision);
const valueOfResult = (result: RunResult) => valueOf(result, measure.value);

const isThisRun = computed(() => props.run.status !== 'idle' && props.run.participant.bib === props.participant.bib);
// The distance this participant is ready with, waiting for the operator to say whether it is valid
const distanceToValidate = computed(() =>
  isThisRun.value && props.run.status === 'ready' && props.run.distanceCm !== undefined ? props.run.distanceCm : null,
);
// The runs beyond the attempts allowed (e.g. an invalid run made valid afterwards): they are shown, but do not count
const beyondAttempts = computed(() => {
  const within = new Set(withinAttempts(props.results, props.attempts));
  return new Set(props.results.filter((result) => !within.has(result)));
});
// Best value among the valid runs within the attempts allowed (shortest or longest time, longest distance); invalid and
// disqualified runs never count
const bestValue = computed(() => {
  const rule = bestRule({ measure: measure.value, best: props.best });
  const values = props.results.flatMap((result) => {
    if (beyondAttempts.value.has(result)) return [];
    const value = valueOfResult(result);
    return result.status !== 'ok' || value === null ? [] : [value];
  });
  return values.reduce<number | null>((best, value) => (best === null || isBetterTime(value, best, rule) ? value : best), null);
});
const validCount = computed(() => props.results.filter((result) => result.status === 'ok').length);
const usedAttempts = computed(() => props.results.filter(countsAsAttempt).length);
// The distance at which the participant used all the attempts allowed at one distance: they are eliminated
const eliminated = computed(() => (isDistance.value ? eliminatedAt(props.results, props.attemptsPerDistance) : null));
const noAttemptLeft = computed(() => (props.attempts !== null && usedAttempts.value >= props.attempts) || eliminated.value !== null);
// The distance the participant started and did not validate yet: their next attempt is at it
const startedDistance = computed(() => (isDistance.value && !props.allowDistanceChange ? openDistance(props.results) : null));
// Unlocked by the operator, exceptionally: the participant may change distance without validating the one started
const unlocked = ref(false);
const locked = computed(() => startedDistance.value !== null && !unlocked.value);
// Attempts failed at that distance since it was last validated
const usedAtStarted = computed(() => (startedDistance.value === null ? 0 : failedAt(props.results, startedDistance.value)));
// The attempt being run or about to be run, e.g. "Attempt 2 of 3"
const attemptLabel = computed(() => {
  if (eliminated.value !== null && !isThisRun.value) {
    return t('run.eliminated', { n: props.attemptsPerDistance ?? 0, distance: showValue(eliminated.value) });
  }
  if (noAttemptLeft.value && !isThisRun.value) return t('run.allUsed', props.attempts ?? 0);
  const next = usedAttempts.value + 1;
  return props.attempts === null ? t('run.attempt', { n: next }) : t('run.attemptOf', { n: next, total: props.attempts });
});

// Why the participant cannot get ready now, or null when they can
const readyBlocked = computed(
  () => props.busy || props.line === null || !!props.startBlocked || props.run.status !== 'idle' || noAttemptLeft.value || props.closed !== null,
);
const readyTitle = computed(() => {
  if (props.line === null) return t('run.noLine');
  if (props.startBlocked) return props.startBlocked;
  if (props.closed) return t('run.closedTitle', { reason: props.closed });
  if (noAttemptLeft.value) return t('run.noAttemptLeft');
  return undefined;
});

// The distance as typed, in centimetres (Vue gives a number input's value as a number)
const distanceInput = ref<number | string>('');
const distanceField = ref<HTMLInputElement | null>(null);
// The shortest distance that can be typed, in centimetres
const minDistance = computed(() => (isDistance.value ? (props.minDistance ?? null) : null));
// The distance suggested, in centimetres: that of the last run of the line, or 5 cm more when it is a valid run of
// this participant, and never below the minimum distance (the one suggested before the first run of the line). null
// without such a run nor minimum
const SUGGESTED_STEP_CM = 5;
const suggestedDistance = computed(() => {
  if (!isDistance.value) return null;
  const previous = props.previousRun;
  const min = minDistance.value;
  if (!previous || previous.distanceCm == null) return min;
  const same = previous.bib === props.participant.bib && previous.status === 'ok';
  const suggested = same ? previous.distanceCm + SUGGESTED_STEP_CM : previous.distanceCm;
  return min === null ? suggested : Math.max(suggested, min);
});
// Typed again for the next participant, or the next attempt once this one is saved; the distance started and not
// validated yet is the only one possible, otherwise the one suggested
watch(
  [() => props.participant.bib, distanceToValidate, startedDistance, suggestedDistance],
  ([, waiting, started, suggested]) => {
    unlocked.value = false;
    if (waiting === null) distanceInput.value = started ?? suggested ?? '';
  },
  { immediate: true },
);

function ready(): void {
  if (!isDistance.value) {
    emit('ready');
    return;
  }
  const distance = Number(distanceInput.value);
  if (String(distanceInput.value).trim() === '' || !Number.isInteger(distance) || distance < (minDistance.value ?? 1)) {
    distanceField.value?.focus();
    return;
  }
  if (startedDistance.value !== null && unlocked.value) emit('ready', distance, true);
  else emit('ready', distance);
}

// Unlocks the distance started, to type another one, or locks it again on it
async function toggleLock(): Promise<void> {
  unlocked.value = !unlocked.value;
  if (!unlocked.value) {
    distanceInput.value = startedDistance.value ?? '';
    return;
  }
  await nextTick();
  distanceField.value?.focus();
  distanceField.value?.select();
}

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
          <template v-if="participant.category">{{ participant.category }} · </template><span :class="{ 'no-attempt': noAttemptLeft && !isThisRun }">{{ attemptLabel }}</span>
        </div>
      </div>
    </div>

    <div class="status">
      <template v-if="distanceToValidate !== null">
        <span class="clock mono pending" :title="$t('run.toValidate')" data-testid="distance-to-validate">{{ showValue(distanceToValidate) }}</span>
        <button type="button" class="validate" :disabled="busy" :title="$t('run.validateTitle')" @click="$emit('validate')">
          {{ $t('run.validate') }}
        </button>
        <button type="button" class="warn" :disabled="busy" :title="$t('run.invalidateDistanceTitle')" @click="$emit('invalidate')">
          {{ $t('run.invalidate') }}
        </button>
        <button type="button" class="danger" :disabled="busy" :title="$t('run.disqualifyDistanceTitle')" @click="$emit('disqualify')">
          {{ $t('run.disqualify') }}
        </button>
      </template>
      <template v-else-if="isThisRun && run.status === 'ready'">
        <span class="state">{{ $t('run.waitingStart') }}</span>
        <i18n-t v-if="keyLabel" keypath="run.pressToStart" tag="span" class="key-hint" data-testid="key-hint">
          <template #key><kbd>{{ keyLabel }}</kbd></template>
        </i18n-t>
        <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">{{ $t('common.cancel') }}</button>
      </template>
      <template v-else-if="isThisRun && run.status === 'running'">
        <span class="clock mono" role="timer">{{ formatDuration(elapsed, 1) }}</span>
        <i18n-t v-if="keyLabel" keypath="run.pressToFinish" tag="span" class="key-hint" data-testid="key-hint">
          <template #key><kbd>{{ keyLabel }}</kbd></template>
        </i18n-t>
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
        <span v-else-if="lastResult && valueOfResult(lastResult) !== null" class="clock mono done" :title="$t('run.justFinished')">
          {{ showValue(valueOfResult(lastResult)!) }}
        </span>
        <form v-if="isDistance" class="distance" @submit.prevent="ready">
          <button
            v-if="startedDistance !== null"
            type="button"
            class="lock"
            :class="{ unlocked }"
            :disabled="readyBlocked"
            :title="$t(unlocked ? 'run.lockDistance' : 'run.unlockDistance')"
            :aria-label="$t(unlocked ? 'run.lockDistance' : 'run.unlockDistance')"
            :aria-pressed="unlocked"
            data-testid="distance-locked"
            @click="toggleLock"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path :d="unlocked ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'" />
            </svg>
          </button>
          <input
            ref="distanceField"
            v-model="distanceInput"
            type="number"
            inputmode="numeric"
            required
            :min="minDistance ?? 1"
            step="1"
            max="99999"
            :placeholder="String(minDistance ?? 0)"
            :disabled="readyBlocked"
            :readonly="locked"
            :class="{ locked }"
            :title="locked ? $t('run.distanceLocked') : undefined"
            :aria-label="locked ? $t('run.distanceLocked') : $t('run.distanceInCentimetres')"
            data-testid="distance-input"
          />
          <span class="unit">cm</span>
          <button type="submit" class="ready" :disabled="readyBlocked" :title="readyTitle">{{ $t('run.readyDistance') }}</button>
        </form>
        <button v-else type="button" class="ready" :disabled="readyBlocked" :title="readyTitle" @click="ready">
          {{ $t('run.ready') }}
        </button>
        <p v-if="isDistance && startedDistance !== null && !noAttemptLeft" class="started muted" data-testid="started-distance">
          {{
            attemptsPerDistance
              ? $t('run.attemptOf', { n: usedAtStarted + 1, total: attemptsPerDistance })
              : $t('run.attempt', { n: usedAtStarted + 1 })
          }}
        </p>
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
      <div class="title">
        <h3>{{ $t('run.results') }} <span class="muted">({{ results.length }})</span></h3>
        <span class="resize" role="group" :aria-label="$t('run.resultRows', rows)">
          <button type="button" :disabled="rows <= 1" :title="$t('recent.fewer')" :aria-label="$t('recent.fewer')" data-testid="results-fewer" @click="$emit('resizeResults', rows - 1)">−</button>
          <button type="button" :disabled="rows >= MAX_RESULT_ROWS" :title="$t('recent.more')" :aria-label="$t('recent.more')" data-testid="results-more" @click="$emit('resizeResults', rows + 1)">+</button>
          <button
            v-if="settingsResultRows !== undefined && settingsResultRows !== rows"
            type="button"
            class="reset"
            :title="$t('recent.reset', { n: settingsResultRows })"
            data-testid="results-reset"
            @click="$emit('resizeResults', settingsResultRows)"
          >
            {{ $t('recent.resetLabel') }}
          </button>
        </span>
      </div>
      <p v-if="results.length === 0" class="muted">{{ $t('run.noRun') }}</p>
      <div v-else ref="scroller" class="scroller" :style="{ maxHeight }" data-testid="results-scroller">
      <table>
        <thead>
          <tr>
            <th>{{ $t('run.run') }}</th>
            <th>{{ $t(isDistance ? 'run.distance' : 'run.time') }}</th>
            <th>{{ $t(isDistance ? 'run.typedAt' : 'run.startedAt') }}</th>
            <th>{{ $t('run.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="{ result, n } in latestFirst"
            :key="`${n}-${result.start}`"
            :class="{
              best: result.status === 'ok' && !beyondAttempts.has(result) && valueOfResult(result) === bestValue,
              beyond: beyondAttempts.has(result),
              last: lastResult !== null && sameRun(result, lastResult),
              void: result.status !== 'ok',
            }"
          >
            <td>{{ n }}</td>
            <td class="mono time">
              <s v-if="result.status !== 'ok' && valueOfResult(result) !== null">{{ showValue(valueOfResult(result)!) }}</s>
              <template v-else-if="valueOfResult(result) !== null">{{ showValue(valueOfResult(result)!) }}</template>
              <span v-else class="muted" :title="$t(isDistance ? 'run.noDistance' : 'run.noTime')">—</span>
              <span v-if="result.status === 'ok' && !beyondAttempts.has(result) && valueOfResult(result) === bestValue && validCount > 1" class="badge ok">{{ $t('run.best') }}</span>
              <span v-if="beyondAttempts.has(result)" class="badge beyond" :title="$t('run.beyondAttemptsTitle', { n: attempts ?? 0 })" data-testid="beyond-attempts">{{ $t('run.beyondAttempts') }}</span>
            </td>
            <td class="mono muted">{{ formatTime(result.start) }}</td>
            <td>
              <select
                class="status-select"
                :class="result.status"
                :value="result.status"
                :disabled="busy || closed !== null"
                :title="statusHint(result.status)"
                :aria-label="$t('run.statusOf', { n })"
                @change="onStatusChange($event, result)"
              >
                <option v-for="status in STATUSES" :key="status" :value="status" :disabled="status === 'ok' && valueOfResult(result) === null">
                  {{ statusLabel(status) }}
                </option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
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
.key-hint {
  font-size: 1.1em;
}
.key-hint kbd {
  font-family: inherit;
  font-weight: 600;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-bottom-width: 3px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-h);
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
.clock.pending {
  color: var(--warn);
}
.distance {
  display: flex;
  align-items: center;
  gap: 8px;
}
.distance input {
  width: 7em;
  font-size: 1.4em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.started {
  flex-basis: 100%;
  margin: 0;
  text-align: right;
}
.distance input.locked {
  color: var(--text-muted);
  cursor: not-allowed;
}
.distance .lock {
  display: inline-flex;
  padding: 4px;
  background: none;
  border: none;
  cursor: pointer;
}
.distance .lock.unlocked svg {
  stroke: var(--warn);
}
.distance .lock svg {
  width: 1.4em;
  height: 1.4em;
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.distance .unit {
  font-size: 1.2em;
  font-weight: 600;
}
.status button.validate {
  font-size: 1.2em;
  padding: 10px 24px;
  background: var(--ok);
  border-color: var(--ok);
}
button.ready {
  font-size: 1.2em;
  padding: 10px 24px;
}
.other,
.results {
  grid-column: 1 / -1;
}
.results .title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 8px;
}
.results h3 {
  margin: 0;
}
.resize {
  display: inline-flex;
  gap: 4px;
}
.resize button {
  min-width: 2em;
  padding: 2px 8px;
}
.resize button.reset {
  font-size: 0.9em;
}
.scroller {
  max-width: 600px;
  overflow-y: auto;
}
.scroller thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
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
tr.void td,
tr.beyond td {
  color: var(--text-muted);
}
.time .badge.beyond {
  margin-left: 8px;
  color: var(--warn);
  border-color: var(--warn);
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
