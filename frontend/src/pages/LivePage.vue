<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { LiveInstance, Participant, ParticipantsResponse, ResultsResponse, RunResult, ServerMessage } from '../types';
import { useRaceSocket } from '../composables/useRaceSocket';
import { formatDuration, parseInstant } from '../format';
import { sameRun } from '../race/results';
import { discipline, disciplineExists, eventName, eventsLoaded, loadEvents, switcherOpen } from '../selection';

/**
 * Public display of the selected event and discipline: what every synced computer showing it on its race page is
 * doing (participant ready, running clock, last time), and the ranking by best time.
 */

// Refresh rate of the running clocks, and otherwise of the "just finished" highlight
const CLOCK_INTERVAL_MS = 100;
const IDLE_INTERVAL_MS = 1000;
// A finished run stays highlighted in the ranking for this long
const RECENT_MS = 15_000;

const instances = ref<LiveInstance[]>([]);
const results = ref<RunResult[]>([]);
const participants = ref<Participant[]>([]);
const error = ref<string | null>(null);

const isHere = (item: { event: string; discipline: string } | null | undefined) =>
  !!item && item.event === eventName.value && item.discipline === discipline.value;

// Computers whose race page shows this discipline, or that are timing a run in it
const onTrack = computed(() =>
  instances.value
    .filter((instance) => instance.viewing.some(isHere) || (instance.run.status !== 'idle' && isHere(instance.run)))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name)),
);

type CardState =
  | { kind: 'running'; bib: string; name: string; startedAt: string }
  | { kind: 'ready'; bib: string; name: string }
  | { kind: 'finished'; result: RunResult }
  | { kind: 'waiting' };

function cardState(instance: LiveInstance): CardState {
  const { run, lastResult } = instance;
  if (run.status === 'running' && isHere(run)) {
    return { kind: 'running', bib: run.participant.bib, name: run.participant.name, startedAt: run.startedAt };
  }
  if (run.status === 'ready' && isHere(run)) return { kind: 'ready', bib: run.participant.bib, name: run.participant.name };
  if (lastResult && isHere(lastResult)) {
    // The saved result, so a status changed since (DQ, invalid, valid again) shows here too
    return { kind: 'finished', result: results.value.find((r) => sameRun(r, lastResult.result)) ?? lastResult.result };
  }
  return { kind: 'waiting' };
}

// Running clocks: this computer's time corrected by each computer's clock offset
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const anyRunning = computed(() => onTrack.value.some((instance) => cardState(instance).kind === 'running'));
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
const categoryOf = computed(() => new Map(participants.value.map((p) => [p.bib, p.file])));
const recentRuns = computed(() => {
  const keys = new Set<string>();
  for (const instance of instances.value) {
    const last = instance.lastResult;
    if (last && isHere(last) && now.value - Date.parse(last.endedAt) < RECENT_MS) keys.add(last.result.bib);
  }
  return keys;
});
// Invalid runs (not the participant's fault) are left out: they are not counted and give no time
const ranking = computed(() => {
  const byBib = new Map<string, { bib: string; name: string; best: number | null; runs: number }>();
  for (const result of results.value) {
    if (result.status === 'invalid') continue;
    const entry = byBib.get(result.bib) ?? { bib: result.bib, name: result.name, best: null, runs: 0 };
    entry.runs++;
    if (result.status === 'ok' && result.timeMs !== null && (entry.best === null || result.timeMs < entry.best)) {
      entry.best = result.timeMs;
    }
    byBib.set(result.bib, entry);
  }
  return [...byBib.values()].sort(
    (a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || Number(a.bib) - Number(b.bib),
  );
});
const bestOf = computed(() => new Map(ranking.value.map((entry) => [entry.bib, entry.best])));

/** The best time so far of a participant on track, e.g. "Best: 2.378 (3rd)". */
function bestText(bib: string): string {
  const best = bestOf.value.get(bib);
  if (best === undefined || best === null) return 'No time yet';
  const rank = ranking.value.findIndex((entry) => entry.best === best) + 1;
  return `Best: ${formatDuration(best)} (rank ${rank})`;
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
    error.value = `Cannot load the live activity: ${e instanceof Error ? e.message : String(e)}`;
  }
}

let resultsRequest = 0;
async function loadResults(): Promise<void> {
  const request = ++resultsRequest;
  if (!disciplineExists.value) {
    results.value = [];
    participants.value = [];
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
    error.value = null;
  } catch (e) {
    if (request === resultsRequest) error.value = `Cannot load the results: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function onMessage(message: ServerMessage): void {
  if (message.type === 'LIVE_UPDATE') {
    instances.value = message.instances;
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
      <span>Choose the event and discipline to show.</span>
      <button type="button" @click.stop="switcherOpen = true">Choose</button>
    </div>

    <template v-else-if="disciplineExists">
      <section class="track" aria-label="On track">
        <p v-if="onTrack.length === 0" class="muted empty">No computer shows {{ eventName }} · {{ discipline }} on its race page.</p>
        <article v-for="instance in onTrack" :key="instance.id" class="lane" :class="cardState(instance).kind">
          <div class="lane-name">{{ instance.name }}</div>
          <template v-for="state in [cardState(instance)]" :key="state.kind">
            <template v-if="state.kind === 'running'">
              <div class="who"><span class="bib">{{ state.bib }}</span> {{ state.name }}</div>
              <div class="clock mono" role="timer">{{ formatDuration(elapsed(instance, state.startedAt), 1) }}</div>
              <div class="best">{{ bestText(state.bib) }}</div>
            </template>
            <template v-else-if="state.kind === 'ready'">
              <div class="who"><span class="bib">{{ state.bib }}</span> {{ state.name }}</div>
              <div class="status-text">Ready</div>
              <div class="best">{{ bestText(state.bib) }}</div>
            </template>
            <template v-else-if="state.kind === 'finished'">
              <div class="who"><span class="bib">{{ state.result.bib }}</span> {{ state.result.name }}</div>
              <div v-if="state.result.status === 'ok' && state.result.timeMs !== null" class="clock mono done">
                {{ formatDuration(state.result.timeMs) }}
              </div>
              <div v-else class="status-text void">{{ state.result.status === 'dq' ? 'DQ' : 'Invalid' }}</div>
              <div class="best">{{ bestText(state.result.bib) }}</div>
            </template>
            <div v-else class="status-text muted">Waiting</div>
          </template>
        </article>
      </section>

      <section class="ranking" aria-label="Ranking">
        <h2>Ranking</h2>
        <p v-if="ranking.length === 0" class="muted">No result yet.</p>
        <table v-else>
          <thead>
            <tr>
              <th class="rank">#</th>
              <th>Bib</th>
              <th>Name</th>
              <th>Category</th>
              <th class="time">Best time</th>
              <th class="runs">Runs</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in ranking" :key="entry.bib" :class="{ recent: recentRuns.has(entry.bib), 'no-time': entry.best === null }">
              <td class="rank">{{ rankOf(index) ?? '–' }}</td>
              <td class="mono">{{ entry.bib }}</td>
              <td class="name">{{ entry.name }}</td>
              <td class="muted">{{ categoryOf.get(entry.bib) ?? '' }}</td>
              <td class="time mono">{{ entry.best === null ? '—' : formatDuration(entry.best) }}</td>
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
.choose button {
  margin: 0;
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
