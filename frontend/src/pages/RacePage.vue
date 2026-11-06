<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  DisciplineSettings,
  RunStatus,
  Participant,
  ParticipantsResponse,
  ResultsResponse,
  RunResult,
  RunState,
  ServerMessage,
} from '../types';
import { useRaceSocket } from '../composables/useRaceSocket';
import ParticipantPicker from '../components/race/ParticipantPicker.vue';
import { countsAsAttempt, sameRun } from '../race/results';
import RunPanel from '../components/race/RunPanel.vue';
import { showDateTime } from '../race/dateTime';
import {
  currentEvent,
  discipline,
  disciplineExists,
  eventName,
  events,
  eventsError,
  eventsLoaded,
  loadEvents,
  reloadRequests,
  select,
  selectionLock,
  switcherOpen,
  workDir,
} from '../selection';

const { t, locale } = useI18n();

const loadError = ref<string | null>(null);

const participants = ref<Participant[]>([]);
const problems = ref<string[]>([]);
const NO_SETTINGS: DisciplineSettings = { attempts: null, start: null, end: null, access: 'auto' };
const settings = ref<DisciplineSettings>({ ...NO_SETTINGS });

// The current time, refreshed often enough that the page opens and closes on the minute
const now = ref(Date.now());
const clockTimer = setInterval(() => (now.value = Date.now()), 5_000);
onUnmounted(() => clearInterval(clockTimer));

// Why the start - end period closes the discipline now, or null when it is within the period
const outsidePeriod = computed(() => {
  const { start, end } = settings.value;
  if (start && now.value < Date.parse(start)) return t('race.reason.notStarted', { date: showDateTime(start) });
  if (end && now.value >= Date.parse(end)) return t('race.reason.ended', { date: showDateTime(end) });
  return null;
});

// Why runs and result changes are disabled (locked, or outside the period unless access is open), or null.
// The backend checks it too: this only avoids offering actions that would be refused.
const closedReason = computed(() => {
  if (settings.value.access === 'locked') return t('race.reason.locked');
  if (settings.value.access === 'open') return null;
  return outsidePeriod.value;
});
// Open although the period would close it: shown as a reminder, so it is not left open by mistake
const forcedOpen = computed(() => settings.value.access === 'open' && outsidePeriod.value !== null);
const loadingParticipants = ref(false);
const selected = ref<Participant | null>(null);
const picker = ref<InstanceType<typeof ParticipantPicker> | null>(null);

// The timed run is kept by the backend and pushed to every open page
const run = ref<RunState>({ status: 'idle' });
const results = ref<RunResult[]>([]);
const lastResult = ref<RunResult | null>(null);
const busy = ref(false);
// While a participant is ready or running, the event, discipline and participant cannot change
const locked = computed(() => run.value.status !== 'idle');
watch(
  [locked, locale],
  ([isLocked]) => (selectionLock.value = isLocked ? t('race.runInProgress') : null),
  { immediate: true },
);
onUnmounted(() => (selectionLock.value = null));
// Bibs of the participants who used all their attempts (none when attempts are unlimited)
const finishedBibs = computed(() => {
  const limit = settings.value.attempts;
  if (limit === null) return new Set<string>();
  const used = new Map<string, number>();
  for (const result of results.value) {
    if (countsAsAttempt(result)) used.set(result.bib, (used.get(result.bib) ?? 0) + 1);
  }
  return new Set([...used].filter(([, count]) => count >= limit).map(([bib]) => bib));
});
const remainingCount = computed(() => participants.value.filter((p) => !finishedBibs.value.has(p.bib)).length);
const participantResults = computed(() => results.value.filter((result) => result.bib === selected.value?.bib));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.problems?.join(' ') ?? `HTTP ${response.status}`);
  return body;
}

const disciplinePath = () => `/api/events/${encodeURIComponent(eventName.value)}/${encodeURIComponent(discipline.value)}`;
const runIsHere = () =>
  run.value.status !== 'idle' && run.value.event === eventName.value && run.value.discipline === discipline.value;

// Ignores the answer of a request when another one was started meanwhile (fast discipline changes)
let participantsRequest = 0;

async function loadResults(): Promise<void> {
  try {
    results.value = (await getJson<ResultsResponse>(`${disciplinePath()}/results`)).results;
  } catch (e) {
    loadError.value = t('race.errors.loadResults', { error: errorText(e) });
  }
}

/** Shows the event, discipline and participant of a run in progress, e.g. started from another browser. */
function showRun(): void {
  const current = run.value;
  if (current.status === 'idle') return;
  if (current.event !== eventName.value || current.discipline !== discipline.value) {
    select(current.event, current.discipline);
  } else if (selected.value?.bib !== current.participant.bib) {
    selected.value = participants.value.find((p) => p.bib === current.participant.bib) ?? null;
  }
}

async function loadRun(): Promise<void> {
  try {
    run.value = await getJson<RunState>('/api/run');
    showRun();
  } catch (e) {
    loadError.value = t('race.errors.loadRun', { error: errorText(e) });
  }
}

function onMessage(message: ServerMessage): void {
  if (message.type === 'RUN_UPDATE') {
    if (message.run.status === 'ready') lastResult.value = null;
    run.value = message.run;
    showRun();
  } else if (message.type === 'RUN_RESULT' && message.event === eventName.value && message.discipline === discipline.value) {
    results.value = [...results.value, message.result];
    if (message.result.bib === selected.value?.bib) lastResult.value = message.result;
  } else if (message.type === 'RESULT_UPDATE' && message.event === eventName.value && message.discipline === discipline.value) {
    replaceResult(message.result);
  } else if (message.type === 'SETTINGS_UPDATE' && message.event === eventName.value && message.discipline === discipline.value) {
    settings.value = message.settings;
  } else if (message.type === 'SYNC_UPDATE') {
    // Another computer added or changed files: new events or disciplines, participants, settings or results
    loadEvents().then(() => {
      if (message.event === eventName.value && message.discipline === discipline.value) loadParticipants();
    });
  }
}

function replaceResult(result: RunResult): void {
  results.value = results.value.map((r) => (sameRun(r, result) ? result : r));
  if (lastResult.value && sameRun(lastResult.value, result)) lastResult.value = result;
}

/** Changes the status of a saved run (valid, invalid or disqualified). */
async function setStatus(result: RunResult, status: RunStatus): Promise<void> {
  if (status === result.status) return;
  busy.value = true;
  try {
    replaceResult(
      await getJson<RunResult>(`${disciplinePath()}/results`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bib: result.bib, start: result.start, status }),
      }),
    );
    loadError.value = null;
  } catch (e) {
    loadError.value = t('race.errors.changeResult', { error: errorText(e) });
  } finally {
    busy.value = false;
  }
}

// Reloads the run on each WebSocket (re)connection, so a run that changed while disconnected is shown
// Tells the backend which event and discipline this race page shows, for the live page of every synced computer
function sendViewing(): void {
  send({
    type: 'VIEWING',
    event: disciplineExists.value ? eventName.value : null,
    discipline: disciplineExists.value ? discipline.value : null,
  });
}
const { send } = useRaceSocket({
  onMessage,
  onConnect: () => {
    loadRun();
    sendViewing();
  },
});
watch([eventName, discipline, disciplineExists], sendViewing);

async function postRun(action: 'ready' | 'cancel' | 'invalidate' | 'disqualify'): Promise<void> {
  busy.value = true;
  try {
    const body = action === 'ready' ? { event: eventName.value, discipline: discipline.value, bib: selected.value?.bib } : {};
    run.value = await getJson<RunState>(`/api/run/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (action === 'ready') lastResult.value = null;
    loadError.value = null;
  } catch (e) {
    loadError.value = t(`race.errors.${action}`, { error: errorText(e) });
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  if (run.value.status === 'running' && !confirm(t('race.confirmCancel'))) return;
  postRun('cancel');
}

/** Ends the running run now, saved as INVALID or DQ, after a confirmation. */
function voidRun(action: 'invalidate' | 'disqualify'): void {
  if (run.value.status !== 'running') return;
  const { bib, name } = run.value.participant;
  if (!confirm(t(action === 'disqualify' ? 'race.confirmDisqualify' : 'race.confirmInvalidate', { bib, name }))) return;
  postRun(action);
}

async function loadParticipants(): Promise<void> {
  const request = ++participantsRequest;
  if (!disciplineExists.value) {
    participants.value = [];
    problems.value = [];
    settings.value = { ...NO_SETTINGS };
    results.value = [];
    selected.value = null;
    return;
  }

  loadingParticipants.value = true;
  try {
    const [list] = await Promise.all([getJson<ParticipantsResponse>(`${disciplinePath()}/participants`), loadResults()]);
    if (request !== participantsRequest) return;
    participants.value = list.participants;
    problems.value = list.problems;
    settings.value = list.settings;
    loadError.value = null;
    // The participant of a run in progress here, or else the one selected before a reload when still in the list
    const wanted = runIsHere() && run.value.status !== 'idle' ? run.value.participant : selected.value;
    selected.value = list.participants.find((p) => p.bib === wanted?.bib && p.name === wanted?.name) ?? null;
  } catch (e) {
    if (request !== participantsRequest) return;
    loadError.value = t('race.errors.loadParticipants', { error: errorText(e) });
  } finally {
    if (request === participantsRequest) loadingParticipants.value = false;
  }
  await nextTick();
  if (!selected.value) picker.value?.focus();
}

async function reload(): Promise<void> {
  await loadEvents();
  await loadParticipants();
}

watch([eventName, discipline], () => {
  selected.value = null;
  loadParticipants();
});
watch(selected, () => (lastResult.value = null));
// "Reload lists" in the event switcher
watch(reloadRequests, loadParticipants);

onMounted(reload);
</script>

<template>
  <main class="page">
    <p v-if="loadError || eventsError" class="alert error">{{ loadError ?? eventsError }}</p>

    <div v-if="eventsLoaded && events.length === 0 && !eventsError" class="alert hint">
      <i18n-t keypath="race.noEvent" tag="p">
        <template #dir><code>{{ workDir }}</code></template>
      </i18n-t>
      <pre class="tree">CFM26/
  100m/
    femmes.csv     bib;name
    hommes.csv     1;Hugo Guérin</pre>
      <i18n-t keypath="race.noEventThen" tag="p">
        <template #button><em>{{ $t('switcher.reload') }}</em></template>
      </i18n-t>
    </div>

    <div v-else-if="eventsLoaded && !disciplineExists" class="alert hint choose">
      <span>{{ currentEvent ? $t('race.chooseDisciplineOf', { event: eventName }) : $t('race.chooseEventAndDiscipline') }}</span>
      <button type="button" @click.stop="switcherOpen = true">{{ $t('common.choose') }}</button>
    </div>

    <section v-else-if="disciplineExists" class="card">
      <div class="field participant">
        <span>
          {{ $t('race.participant') }}
          <span v-if="!loadingParticipants" class="muted">
            <template v-if="settings.attempts !== null">{{ $t('race.remaining', { remaining: remainingCount, total: participants.length }) }}</template>
            <template v-else>{{ $t('race.count', { total: participants.length }) }}</template>
          </span>
        </span>
        <ParticipantPicker
          ref="picker"
          v-model="selected"
          :participants="participants"
          :finished="finishedBibs"
          :disabled="locked"
        />
      </div>
    </section>

    <p v-if="disciplineExists && forcedOpen" class="alert hint">
      {{ $t('race.forcedOpen', { event: eventName, discipline, reason: outsidePeriod }) }}
    </p>

    <p v-if="disciplineExists && closedReason" class="alert warn">
      {{ $t('race.closed', { event: eventName, discipline, reason: closedReason }) }}
    </p>

    <i18n-t
      v-if="disciplineExists && !loadingParticipants && participants.length === 0"
      keypath="race.noParticipant"
      tag="p"
      class="alert warn"
    >
      <template #event>{{ eventName }}</template>
      <template #discipline>{{ discipline }}</template>
      <template #format><code>bib;name</code></template>
    </i18n-t>

    <details v-if="problems.length > 0" class="alert warn">
      <summary>{{ $t('race.problems', { discipline }, problems.length) }}</summary>
      <ul>
        <li v-for="problem in problems" :key="problem">{{ problem }}</li>
      </ul>
    </details>

    <RunPanel
      :closed="closedReason"
      :attempts="settings.attempts"
      v-if="selected"
      :participant="selected"
      :run="run"
      :results="participantResults"
      :last-result="lastResult"
      :busy="busy"
      @ready="postRun('ready')"
      @cancel="cancel"
      @invalidate="voidRun('invalidate')"
      @disqualify="voidRun('disqualify')"
      @set-status="setStatus"
    />
  </main>
</template>

<style scoped>
.choose {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.choose button {
  margin: 0;
}
.tree {
  font-family: var(--mono);
  font-size: 0.9em;
  margin: 8px 0;
}
details ul {
  margin: 8px 0 0;
  padding-left: 24px;
}
</style>
