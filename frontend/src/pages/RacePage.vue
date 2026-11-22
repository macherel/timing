<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  DisciplineSettings,
  LineRun,
  LinesResponse,
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
import { countsAsAttempt, recentRunsOf, sameRun } from '../race/results';
import RunPanel from '../components/race/RunPanel.vue';
import RecentRuns from '../components/race/RecentRuns.vue';
import { showDateTime } from '../race/dateTime';
import {
  currentEvent,
  discipline,
  disciplineExists,
  eventName,
  eventsError,
  eventsLoaded,
  loadEvents,
  reloadRequests,
  select,
  selectedLine,
  selectLine,
  selectionLock,
} from '../selection';

const { t, locale } = useI18n();

const loadError = ref<string | null>(null);

const participants = ref<Participant[]>([]);
const problems = ref<string[]>([]);
const NO_SETTINGS: DisciplineSettings = {
  attempts: null,
  start: null,
  end: null,
  access: 'auto',
  best: 'shortest',
  precision: 'hundredth',
  rounding: 'up',
  recentRuns: 3,
  trigger: 'gates',
};
const settings = ref<DisciplineSettings>({ ...NO_SETTINGS });
// The event and discipline whose settings are loaded: until then, whether it is timed by hand is not known
const settingsOf = ref<string | null>(null);
const disciplineKey = () => `${eventName.value}\n${discipline.value}`;
const settingsKnown = computed(() => !disciplineExists.value || settingsOf.value === disciplineKey());
// A discipline timed by hand runs on the manual line of this computer, with the space bar: no line to choose
const manual = computed(() => disciplineExists.value && settings.value.trigger === 'keyboard');

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

// The lines of this computer and their runs are kept by the backend and pushed to every open page
const lines = ref<LineRun[]>([]);
const linesLoaded = ref(false);
// The name of this computer, as written with each result beside its line
const computer = ref<string | null>(null);
// A line can start runs when it is enabled and the app listens to its start and finish devices. Any line can be chosen
// though, to edit its results, or to cancel a run in progress after a device is unplugged
// The lines of config.yaml, to choose from for a discipline timed by the gates (the manual line is not one of them)
const gateLines = computed(() => lines.value.filter((item) => !item.manual));
const readyLines = computed(() => gateLines.value.filter((item) => item.ready));
// Why a line cannot start a run, or null when it can
const notReadyReason = (item: LineRun) =>
  item.ready ? null : item.enabled ? t('race.lineNotReady') : t('race.lineDisabled');
// Green: ready and free; orange or green: a participant is ready or running; red: no run can start
const dotClass = (item: LineRun) => (item.run.status !== 'idle' ? item.run.status : item.ready ? 'idle' : 'unusable');
// The line this page times on: the manual line for a discipline timed by hand, otherwise the one chosen in this browser.
// None is chosen for the user: until they choose one, the page only shows the lines to choose from
const line = computed(() =>
  manual.value ? (lines.value.find((l) => l.manual) ?? null) : (gateLines.value.find((l) => l.line === selectedLine.value) ?? null),
);
const startBlocked = computed(() => (line.value ? notReadyReason(line.value) : null));
// A chosen line removed from config.yaml is let go, back to the choice of a line: the page never moves to another line
// by itself
watch([line, linesLoaded], ([current, loaded]) => {
  if (!current && loaded && selectedLine.value && !manual.value) selectLine('');
});
const run = computed<RunState>(() => line.value?.run ?? { status: 'idle' });
const results = ref<RunResult[]>([]);
const lastResult = ref<RunResult | null>(null);
const busy = ref(false);
// While a participant is ready or running on the line, the event, discipline and participant cannot change
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
// The last runs of the discipline timed on this line of this computer, the latest first, as many as its settings say
const recentRuns = computed(() => {
  const name = line.value?.line;
  if (!name || computer.value === null) return [];
  return recentRunsOf(results.value, computer.value, name, settings.value.recentRuns);
});

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
    const last = lastResult.value;
    if (last) lastResult.value = results.value.find((result) => sameRun(result, last)) ?? last;
  } catch (e) {
    loadError.value = t('race.errors.loadResults', { error: errorText(e) });
  }
}

/** Shows the event, discipline and participant of the run in progress on the line, e.g. started from another browser. */
function showRun(): void {
  const current = run.value;
  if (current.status === 'idle') return;
  if (current.event !== eventName.value || current.discipline !== discipline.value) {
    select(current.event, current.discipline);
  } else if (selected.value?.bib !== current.participant.bib) {
    selected.value = participants.value.find((p) => p.bib === current.participant.bib) ?? null;
  }
}

async function loadLines(): Promise<void> {
  try {
    const response = await getJson<LinesResponse>('/api/lines');
    computer.value = response.computer;
    lines.value = response.lines;
    linesLoaded.value = true;
    showRun();
  } catch (e) {
    loadError.value = t('race.errors.loadRun', { error: errorText(e) });
  }
}

/** Sets the run of a line, as the backend reported it. */
function setRun(name: string, next: RunState): void {
  const entry = lines.value.find((l) => l.line === name);
  if (!entry) return;
  entry.run = next;
  if (entry === line.value) {
    if (next.status === 'ready') lastResult.value = null;
    showRun();
  }
}

async function chooseLine(name: string): Promise<void> {
  selectLine(name);
  lastResult.value = null;
  showRun();
  // The participant field appears with the line
  await nextTick();
  if (!selected.value) picker.value?.focus();
}

function onMessage(message: ServerMessage): void {
  if (message.type === 'RUN_UPDATE') {
    setRun(message.line, message.run);
  } else if (message.type === 'LINES_UPDATE') {
    lines.value = message.lines;
    showRun();
  } else if (message.type === 'RUN_RESULT' && message.event === eventName.value && message.discipline === discipline.value) {
    results.value = [...results.value, message.result];
    if (message.result.bib === selected.value?.bib) lastResult.value = message.result;
  } else if (message.type === 'RESULT_UPDATE' && message.event === eventName.value && message.discipline === discipline.value) {
    replaceResult(message.result);
  } else if (message.type === 'SETTINGS_UPDATE' && message.event === eventName.value && message.discipline === discipline.value) {
    settings.value = message.settings;
    // The times depend on the precision and rounding
    loadResults();
  } else if (message.type === 'EVENTS_UPDATE') {
    // An event or discipline was created: the lists of the title menu
    loadEvents();
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

// Tells the backend which event, discipline, line and participant this race page shows, for the live page of every
// synced computer
function sendViewing(): void {
  send({
    type: 'VIEWING',
    event: disciplineExists.value ? eventName.value : null,
    discipline: disciplineExists.value ? discipline.value : null,
    line: line.value?.line ?? null,
    participant: disciplineExists.value && selected.value ? { bib: selected.value.bib, name: selected.value.name } : null,
  });
}
// Reloads the lines on each WebSocket (re)connection, so a run that changed while disconnected is shown
const { send } = useRaceSocket({
  onMessage,
  onConnect: () => {
    loadLines();
    sendViewing();
  },
});
watch([eventName, discipline, disciplineExists, selected, () => line.value?.line], sendViewing);

async function postRun(action: 'ready' | 'cancel' | 'invalidate' | 'disqualify'): Promise<void> {
  const name = line.value?.line;
  if (!name) return;
  busy.value = true;
  try {
    const body = action === 'ready' ? { event: eventName.value, discipline: discipline.value, bib: selected.value?.bib } : {};
    const next = await getJson<RunState>(`/api/lines/${encodeURIComponent(name)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setRun(name, next);
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

// The manual line is started and finished with the space bar, while a participant is ready or running on it. The
// press is sent at once: the backend timestamps it on arrival, and makes it the start or the finish
const keyboardLine = computed(() => (line.value?.manual ? line.value.line : null));
// Whether the last space bar press was taken for the run: its release is then taken too
let spaceTaken = false;

const isSpace = (event: KeyboardEvent) => event.code === 'Space' || event.key === ' ';

/** Whether typing a space in this element is expected (a text field), so the press is left to it. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
}

function onKeyDown(event: KeyboardEvent): void {
  const name = keyboardLine.value;
  if (!name || !isSpace(event) || run.value.status === 'idle' || isTextField(event.target)) return;
  // Neither clicks a focused button nor scrolls the page
  event.preventDefault();
  spaceTaken = true;
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  pressKey(name);
}

// A focused button is clicked when the space bar is released: not when its press was taken for the run
function onKeyUp(event: KeyboardEvent): void {
  if (!isSpace(event) || !spaceTaken) return;
  spaceTaken = false;
  event.preventDefault();
}

async function pressKey(name: string): Promise<void> {
  try {
    // The run is updated by the RUN_UPDATE message, in the order of the presses (two answers may come in any order)
    await getJson<RunState>(`/api/lines/${encodeURIComponent(name)}/key`, { method: 'POST' });
    loadError.value = null;
  } catch (e) {
    loadError.value = t('race.errors.key', { error: errorText(e) });
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
});

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
    settingsOf.value = disciplineKey();
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

    <i18n-t v-if="linesLoaded && settingsKnown && !manual && gateLines.length === 0" keypath="race.noLine" tag="p" class="alert warn">
      <template #config><RouterLink to="/config">{{ $t('pages.config') }}</RouterLink></template>
    </i18n-t>
    <section v-else-if="linesLoaded && settingsKnown && !line" class="line-choice" data-testid="line-choice">
      <h2>{{ $t('race.chooseLine') }}</h2>
      <i18n-t v-if="readyLines.length === 0" keypath="race.noReadyLine" tag="p" class="alert warn">
        <template #config><RouterLink to="/config">{{ $t('pages.config') }}</RouterLink></template>
      </i18n-t>
      <div class="line-cards">
        <button
          v-for="item in gateLines"
          :key="item.line"
          type="button"
          class="line-card"
          :class="{ blocked: !item.ready && item.run.status === 'idle' }"
          :title="notReadyReason(item) ?? undefined"
          @click="chooseLine(item.line)"
        >
          <span class="line-card-name"><span class="dot" :class="dotClass(item)"></span>{{ item.line }}</span>
          <span class="muted small">
            <template v-if="item.run.status !== 'idle'">{{ $t(`race.lineState.${item.run.status}`) }} · {{ item.run.participant.bib }} {{ item.run.participant.name }}</template>
            <template v-else-if="item.ready">{{ $t('race.lineState.idle') }}</template>
            <template v-else>&nbsp;</template>
          </span>
        </button>
      </div>
    </section>
    <div v-else-if="line" class="line-bar">
    <button v-if="!manual" type="button" class="secondary icon back" :title="$t('race.backToLines')" :aria-label="$t('race.backToLines')" @click="selectLine('')">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <p class="line-name" data-testid="current-line">
      <span class="dot" :class="dotClass(line)" :title="notReadyReason(line) ?? $t(`race.lineState.${line.run.status}`)"></span>
      {{ line.line }}
    </p>
    </div>

    <template v-if="line">
    <p v-if="startBlocked && run.status === 'idle'" class="alert warn" data-testid="start-blocked">{{ startBlocked }}</p>
    <div v-if="eventsLoaded && !disciplineExists" class="alert hint choose">
      <span>{{ currentEvent ? $t('race.chooseDisciplineOf', { event: eventName }) : $t('race.chooseEventAndDiscipline') }}</span>
      <RouterLink to="/" class="button">{{ $t('common.choose') }}</RouterLink>
    </div>

    <section v-if="disciplineExists" class="card">
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
      :line="line?.line ?? null"
      :keyboard="line?.manual ?? false"
      :start-blocked="startBlocked"
      :attempts="settings.attempts"
      :best="settings.best"
      :precision="settings.precision"
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

    <RecentRuns
      v-if="disciplineExists && settings.recentRuns > 0"
      :results="recentRuns"
      :count="settings.recentRuns"
      :precision="settings.precision"
    />
    </template>
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

.line-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--border);
}
/* Green: the line is ready (its devices are listened to); orange: a participant waits for the start */
.dot.idle {
  background: var(--ok);
}
.dot.ready {
  background: var(--warn);
}
.dot.running {
  background: var(--ok);
}
.dot.unusable {
  background: var(--error);
}
.line-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: 600;
  color: var(--text-h);
}
.line-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.line-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 16px;
  text-align: left;
  background: var(--surface);
  color: var(--text-h);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.line-card.blocked {
  opacity: 0.75;
}
.line-card-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 1.2em;
  font-weight: 600;
}
.small {
  font-size: 0.85em;
}
details ul {
  margin: 8px 0 0;
  padding-left: 24px;
}
</style>
