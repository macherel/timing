<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  DisciplineSettings,
  LineRun,
  LiveInstance,
  Participant,
  ParticipantsResponse,
  ResultsResponse,
  RunResult,
  ServerMessage,
} from '../types';
import { useRaceSocket } from '../composables/useRaceSocket';
import { formatDuration, formatValue, parseInstant } from '../format';
import { bestRule, countsAsAttempt, eliminatedAt, isBetterTime, sameRun, valueOf, withinAttempts } from '../race/results';
import { discipline, disciplineExists, eventName, eventsLoaded, loadEvents } from '../selection';

/**
 * Public display of the selected event and discipline: what every line of the synced computers showing it on a race
 * page is doing (participant selected or ready, running clock, last time), and the ranking by best time. In a
 * discipline that measures a distance: the distance waiting to be validated, the last distance, and the ranking by
 * longest distance.
 */

// Refresh rate of the running clocks, and otherwise of the "just finished" highlight
const CLOCK_INTERVAL_MS = 100;
const IDLE_INTERVAL_MS = 1000;
// A finished run stays highlighted in the ranking for this long
const RECENT_MS = 15_000;

const { t } = useI18n();

const instances = ref<LiveInstance[]>([]);
const results = ref<RunResult[]>([]);
const participants = ref<Participant[]>([]);
// Runs allowed per participant in the discipline, null: unlimited
const attempts = ref<number | null>(null);
// For a distance, runs allowed at one same distance, null: unlimited
const attemptsPerDistance = ref<number | null>(null);
// What a run measures: a time or a distance
const measure = ref<NonNullable<DisciplineSettings['measure']>>('time');
const isDistance = computed(() => measure.value === 'distance');
// Which time is the best: shortest, or longest for a slow race; the longest distance
const bestSetting = ref<DisciplineSettings['best']>('shortest');
const best = computed(() => bestRule({ measure: measure.value, best: bestSetting.value }));
// Unit of the times (or distances): they are shown with as many decimals
const precision = ref<DisciplineSettings['precision']>('hundredth');
const showValue = (value: number) => formatValue(value, measure.value, precision.value);
const valueOfResult = (result: RunResult) => valueOf(result, measure.value);
const error = ref<string | null>(null);

const isHere = (item: { event: string; discipline: string } | null | undefined) =>
  !!item && item.event === eventName.value && item.discipline === discipline.value;

// A line of a computer, shown as a card
interface Lane {
  key: string;
  instance: LiveInstance;
  line: LineRun;
}

// The lines that a race page shows with this discipline, or that are timing a run in it: this computer first
const onTrack = computed(() =>
  [...instances.value]
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name))
    .flatMap((instance) =>
      instance.lines
        .filter(
          (line) =>
            (line.run.status !== 'idle' && isHere(line.run)) ||
            instance.viewing.some((view) => isHere(view) && view.line === line.line),
        )
        .map((line): Lane => ({ key: `${instance.id}\n${line.line}`, instance, line })),
    ),
);

type CardState =
  | { kind: 'running'; bib: string; name: string; startedAt: string }
  | { kind: 'ready'; bib: string; name: string; distanceCm: number | null }
  | { kind: 'selected'; bib: string; name: string }
  | { kind: 'finished'; result: RunResult }
  | { kind: 'waiting' };

function cardState({ instance, line }: Lane): CardState {
  const { run, lastResult } = line;
  if (run.status === 'running' && isHere(run)) {
    return { kind: 'running', bib: run.participant.bib, name: run.participant.name, startedAt: run.startedAt };
  }
  if (run.status === 'ready' && isHere(run)) {
    return { kind: 'ready', bib: run.participant.bib, name: run.participant.name, distanceCm: run.distanceCm ?? null };
  }
  // A participant selected on its race page, before they are ready, unless they have no attempt left (they
  // cannot run again). The last result stays while the same participant is selected (e.g. just after their run)
  const selected = instance.viewing.find(
    (view) => isHere(view) && view.line === line.line && view.participant && !noAttemptLeft(view.participant.bib),
  )?.participant;
  const last = lastResult && isHere(lastResult) ? lastResult : null;
  if (selected && selected.bib !== last?.result.bib) return { kind: 'selected', bib: selected.bib, name: selected.name };
  if (last) {
    // The saved result, so a status changed since (DQ, invalid, valid again) shows here too
    return { kind: 'finished', result: results.value.find((r) => sameRun(r, last.result)) ?? last.result };
  }
  return { kind: 'waiting' };
}

/** Whether a participant used all the attempts of the discipline, or is eliminated (same rule as the race page). */
function noAttemptLeft(bib: string): boolean {
  const runs = results.value.filter((result) => result.bib === bib);
  if (attempts.value !== null && runs.filter(countsAsAttempt).length >= attempts.value) return true;
  return isDistance.value && eliminatedAt(runs, attemptsPerDistance.value) !== null;
}

// Running clocks: this computer's time corrected by each computer's clock offset
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const anyRunning = computed(() => onTrack.value.some((lane) => cardState(lane).kind === 'running'));
watch(
  anyRunning,
  (running) => {
    clearInterval(clockTimer);
    clockTimer = setInterval(() => (now.value = Date.now()), running ? CLOCK_INTERVAL_MS : IDLE_INTERVAL_MS);
  },
  { immediate: true },
);
onUnmounted(() => clearInterval(clockTimer));
const elapsed = (instance: LiveInstance, startedAt: string) => now.value + instance.clockOffsetMs - parseInstant(startedAt);

// Ranking: best valid time of each participant, then the participants with runs but no valid time
const categoryOf = computed(() => new Map(participants.value.map((p) => [p.bib, p.category])));
// The category column is shown only when a participant has one
const hasCategories = computed(() => participants.value.some((p) => p.category !== ''));
const recentRuns = computed(() => {
  const keys = new Set<string>();
  for (const line of instances.value.flatMap((instance) => instance.lines)) {
    const last = line.lastResult;
    if (last && isHere(last) && now.value - Date.parse(last.endedAt) < RECENT_MS) keys.add(last.result.bib);
  }
  return keys;
});
// Invalid runs (not the participant's fault) are left out: they are not counted and give no time
const ranking = computed(() => {
  const byBib = new Map<string, { bib: string; name: string; best: number | null; runs: number }>();
  // The runs beyond the attempts allowed (e.g. an invalid run made valid afterwards) do not count
  for (const result of withinAttempts(results.value, attempts.value)) {
    if (result.status === 'invalid') continue;
    const entry = byBib.get(result.bib) ?? { bib: result.bib, name: result.name, best: null, runs: 0 };
    entry.runs++;
    const value = valueOfResult(result);
    if (result.status === 'ok' && value !== null && (entry.best === null || isBetterTime(value, entry.best, best.value))) {
      entry.best = value;
    }
    byBib.set(result.bib, entry);
  }
  // Longest first for a slow race; the participants without a valid time always come last
  const sign = best.value === 'longest' ? -1 : 1;
  return [...byBib.values()].sort(
    (a, b) =>
      Number(a.best === null) - Number(b.best === null) ||
      sign * ((a.best ?? 0) - (b.best ?? 0)) ||
      Number(a.bib) - Number(b.bib),
  );
});
const bestOf = computed(() => new Map(ranking.value.map((entry) => [entry.bib, entry.best])));

/** The best time so far of a participant on track, e.g. "Best: 2.378 (3rd)". */
function bestText(bib: string): string {
  const best = bestOf.value.get(bib);
  if (best === undefined || best === null) return t(isDistance.value ? 'live.noDistance' : 'live.noTime');
  const rank = ranking.value.findIndex((entry) => entry.best === best) + 1;
  return t('live.best', { time: showValue(best), rank });
}

// Rank among the participants with a valid time (equal times share a rank)
function rankOf(index: number): number | null {
  const entry = ranking.value[index];
  if (entry.best === null) return null;
  return ranking.value.findIndex((other) => other.best === entry.best) + 1;
}

const disciplinePath = () => `/api/events/${encodeURIComponent(eventName.value)}/${encodeURIComponent(discipline.value)}`;

async function loadLive(): Promise<void> {
  try {
    const response = await fetch('/api/live');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    instances.value = (await response.json()).instances;
  } catch (e) {
    error.value = t('live.loadError', { error: e instanceof Error ? e.message : String(e) });
  }
}

let resultsRequest = 0;
async function loadResults(): Promise<void> {
  const request = ++resultsRequest;
  if (!disciplineExists.value) {
    results.value = [];
    participants.value = [];
    attempts.value = null;
    attemptsPerDistance.value = null;
    measure.value = 'time';
    bestSetting.value = 'shortest';
    precision.value = 'hundredth';
    return;
  }
  try {
    const [resultsBody, participantsBody] = await Promise.all([
      fetch(`${disciplinePath()}/results`).then((r) => r.json() as Promise<ResultsResponse>),
      fetch(`${disciplinePath()}/participants`).then((r) => r.json() as Promise<ParticipantsResponse>),
    ]);
    if (request !== resultsRequest) return;
    results.value = resultsBody.results ?? [];
    participants.value = participantsBody.participants ?? [];
    attempts.value = participantsBody.settings?.attempts ?? null;
    attemptsPerDistance.value = participantsBody.settings?.attemptsPerDistance ?? null;
    measure.value = participantsBody.settings?.measure ?? 'time';
    bestSetting.value = participantsBody.settings?.best ?? 'shortest';
    precision.value = participantsBody.settings?.precision ?? 'hundredth';
    error.value = null;
  } catch (e) {
    if (request === resultsRequest) error.value = t('race.errors.loadResults', { error: e instanceof Error ? e.message : String(e) });
  }
}

function onMessage(message: ServerMessage): void {
  if (message.type === 'LIVE_UPDATE') {
    instances.value = message.instances;
  } else if (message.type === 'SETTINGS_UPDATE' && isHere(message)) {
    attempts.value = message.settings.attempts;
    attemptsPerDistance.value = message.settings.attemptsPerDistance ?? null;
    measure.value = message.settings.measure ?? 'time';
    bestSetting.value = message.settings.best;
    precision.value = message.settings.precision;
    // The times depend on the precision and rounding
    loadResults();
  } else if (
    (message.type === 'RUN_RESULT' || message.type === 'RESULT_UPDATE' || message.type === 'SYNC_UPDATE') &&
    isHere(message)
  ) {
    loadResults();
  }
}

useRaceSocket({
  onMessage,
  onConnect: () => {
    loadLive();
    loadResults();
  },
});
if (!eventsLoaded.value) loadEvents();
watch([eventName, discipline, disciplineExists], loadResults, { immediate: true });
</script>

<template>
  <main class="page live">

    <p v-if="error" class="alert error">{{ error }}</p>

    <div v-if="eventsLoaded && !disciplineExists" class="alert hint choose">
      <span>{{ $t('live.choose') }}</span>
      <RouterLink to="/?open=live" class="button">{{ $t('common.choose') }}</RouterLink>
    </div>

    <template v-else-if="disciplineExists">
      <section class="track" :aria-label="$t('live.onTrack')">
        <p v-if="onTrack.length === 0" class="muted empty">{{ $t('live.nobody', { event: eventName, discipline }) }}</p>
        <article v-for="lane in onTrack" :key="lane.key" class="lane" :class="cardState(lane).kind">
          <div class="lane-name">{{ lane.instance.name }} · {{ lane.line.line }}</div>
          <template v-for="state in [cardState(lane)]" :key="state.kind">
            <template v-if="state.kind === 'running'">
              <div class="who"><span class="bib">{{ state.bib }}</span> {{ state.name }}</div>
              <div class="clock mono" role="timer">{{ formatDuration(elapsed(lane.instance, state.startedAt), 1) }}</div>
              <div class="best">{{ bestText(state.bib) }}</div>
            </template>
            <template v-else-if="state.kind === 'ready'">
              <div class="who"><span class="bib">{{ state.bib }}</span> {{ state.name }}</div>
              <template v-if="state.distanceCm !== null">
                <div class="clock mono pending">{{ showValue(state.distanceCm) }}</div>
                <div class="status-text">{{ $t('live.toValidate') }}</div>
              </template>
              <div v-else class="status-text">{{ $t('live.ready') }}</div>
              <div class="best">{{ bestText(state.bib) }}</div>
            </template>
            <template v-else-if="state.kind === 'selected'">
              <div class="who"><span class="bib">{{ state.bib }}</span> {{ state.name }}</div>
              <div class="status-text muted">{{ $t('live.nextUp') }}</div>
              <div class="best">{{ bestText(state.bib) }}</div>
            </template>
            <template v-else-if="state.kind === 'finished'">
              <div class="who"><span class="bib">{{ state.result.bib }}</span> {{ state.result.name }}</div>
              <div v-if="state.result.status === 'ok' && valueOfResult(state.result) !== null" class="clock mono done">
                {{ showValue(valueOfResult(state.result)!) }}
              </div>
              <div v-else class="status-text void">{{ $t(`common.status.${state.result.status}`) }}</div>
              <div class="best">{{ bestText(state.result.bib) }}</div>
            </template>
            <div v-else class="status-text muted">{{ $t('live.waiting') }}</div>
          </template>
        </article>
      </section>

      <section class="ranking" :aria-label="$t('live.ranking')">
        <h2>{{ $t('live.ranking') }}</h2>
        <p v-if="ranking.length === 0" class="muted">{{ $t('live.noResult') }}</p>
        <table v-else>
          <thead>
            <tr>
              <th class="rank">#</th>
              <th>{{ $t('live.bib') }}</th>
              <th>{{ $t('live.name') }}</th>
              <th v-if="hasCategories">{{ $t('live.category') }}</th>
              <th class="time">{{ $t(isDistance ? 'live.bestDistance' : 'live.bestTime') }}</th>
              <th class="runs">{{ $t('live.runs') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in ranking" :key="entry.bib" :class="{ recent: recentRuns.has(entry.bib), 'no-time': entry.best === null }">
              <td class="rank">{{ rankOf(index) ?? '–' }}</td>
              <td class="mono">{{ entry.bib }}</td>
              <td class="name">{{ entry.name }}</td>
              <td v-if="hasCategories" class="muted">{{ categoryOf.get(entry.bib) ?? '' }}</td>
              <td class="time mono">{{ entry.best === null ? '—' : showValue(entry.best) }}</td>
              <td class="runs muted">{{ entry.runs }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </main>
</template>

<style scoped>
.live {
  font-size: 1.1em;
}
.choose {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.track {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  margin: 16px 0 8px;
}
.empty {
  grid-column: 1 / -1;
}
.lane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 20px;
  border: 1px solid var(--border);
  border-left: 8px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.lane.ready {
  border-left-color: var(--warn);
}
.lane.running {
  border-left-color: var(--ok);
}
.lane.finished {
  border-left-color: var(--accent);
}
.lane-name {
  font-size: 0.8em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.who {
  font-size: 1.3em;
  font-weight: 600;
  color: var(--text-h);
}
.bib {
  color: var(--accent);
  margin-right: 6px;
}
.clock {
  font-size: 3.2em;
  font-weight: 700;
  line-height: 1.1;
  color: var(--ok);
  font-variant-numeric: tabular-nums;
}
.clock.done {
  color: var(--text-h);
}
.clock.pending {
  color: var(--warn);
}
.best {
  font-size: 1.1em;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.status-text {
  font-size: 2em;
  font-weight: 700;
  color: var(--warn);
}
.status-text.void {
  color: var(--error);
}
.status-text.muted {
  font-size: 1.4em;
  font-weight: 600;
  color: var(--text-muted);
}
.ranking table {
  font-size: 1.05em;
}
.ranking td {
  padding: 8px 10px;
}
.rank {
  width: 3em;
  font-weight: 700;
  color: var(--text-h);
}
.name {
  font-weight: 600;
  color: var(--text-h);
}
.time {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text-h);
}
.runs {
  text-align: right;
  width: 4em;
}
tr.recent {
  background: var(--accent-bg);
}
tr.no-time .time,
tr.no-time .rank {
  color: var(--text-muted);
  font-weight: normal;
}
</style>
