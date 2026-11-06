<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type {
  DisciplineSettings,
  RunStatus,
  EventSummary,
  EventsResponse,
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

const route = useRoute();
const router = useRouter();

const workDir = ref('');
const events = ref<EventSummary[]>([]);
const eventsLoaded = ref(false);
const loadError = ref<string | null>(null);

const participants = ref<Participant[]>([]);
const problems = ref<string[]>([]);
const NO_SETTINGS: DisciplineSettings = { attempts: null, start: null, end: null, access: 'auto' };
const settings = ref<DisciplineSettings>({ ...NO_SETTINGS });

// The current time, refreshed often enough that the page opens and closes on the minute
const now = ref(Date.now());
const clockTimer = setInterval(() => (now.value = Date.now()), 5_000);
onUnmounted(() => clearInterval(clockTimer));

/** A UTC date-time in the browser's local time with its offset, e.g. "2026-11-05 08:00 +01:00", for messages. */
function showDateTime(iso: string): string {
  const date = new Date(iso);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  return `${toLocalInput(iso).replace('T', ' ')} ${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** An ISO 8601 date-time with offset as the browser's local YYYY-MM-DDTHH:MM, for a datetime-local input. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local input value (browser's local time) as ISO 8601 in UTC, as stored in config.yaml. */
function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 16) + 'Z';
}

// Why the start - end period closes the discipline now, or null when it is within the period
const outsidePeriod = computed(() => {
  const { start, end } = settings.value;
  if (start && now.value < Date.parse(start)) return `it opens on ${showDateTime(start)}`;
  if (end && now.value >= Date.parse(end)) return `it closed on ${showDateTime(end)}`;
  return null;
});

// Why runs and result changes are disabled (locked, or outside the period unless access is open), or null.
// The backend checks it too: this only avoids offering actions that would be refused.
const closedReason = computed(() => {
  if (settings.value.access === 'locked') return 'its results are locked';
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
// Discipline settings form: the attempts as typed, empty for unlimited (Vue gives a number input's value as a number)
const editingSettings = ref(false);
const attemptsInput = ref<string | number>('');
// YYYY-MM-DD from the date inputs, empty for no limit
const startInput = ref('');
const endInput = ref('');
const accessInput = ref<DisciplineSettings['access']>('auto');
const ACCESS_OPTIONS: { value: DisciplineSettings['access']; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Open during the period above' },
  { value: 'open', label: 'Open', hint: 'Always open, ignores the period (e.g. to correct a result)' },
  { value: 'locked', label: 'Locked', hint: 'Never open: results are final' },
];

const settingsError = ref<string | null>(null);
const savingSettings = ref(false);

function openSettings(): void {
  attemptsInput.value = settings.value.attempts === null ? '' : String(settings.value.attempts);
  startInput.value = toLocalInput(settings.value.start);
  endInput.value = toLocalInput(settings.value.end);
  accessInput.value = settings.value.access;
  settingsError.value = null;
  editingSettings.value = true;
}

async function saveSettings(): Promise<void> {
  const text = String(attemptsInput.value ?? '').trim();
  const attempts = text === '' ? null : Number(text);
  if (attempts !== null && !(Number.isInteger(attempts) && attempts >= 1)) {
    settingsError.value = 'Attempts must be a whole number from 1, or empty for unlimited.';
    return;
  }
  if (startInput.value && endInput.value && startInput.value >= endInput.value) {
    settingsError.value = 'The start must be before the end.';
    return;
  }
  savingSettings.value = true;
  try {
    const saved = await getJson<{ settings: DisciplineSettings }>(`${disciplinePath()}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { attempts, start: fromLocalInput(startInput.value), end: fromLocalInput(endInput.value), access: accessInput.value } }),
    });
    settings.value = saved.settings;
    editingSettings.value = false;
  } catch (e) {
    settingsError.value = `Cannot save the settings: ${errorText(e)}`;
  } finally {
    savingSettings.value = false;
  }
}

const participantResults = computed(() => results.value.filter((result) => result.bib === selected.value?.bib));

// The chosen event and discipline live in the URL (?event=…&discipline=…), so a reload or a bookmark keeps them
const queryValue = (key: string) => (typeof route.query[key] === 'string' ? route.query[key] : '');
const eventName = computed({
  get: () => queryValue('event'),
  set: (event) => router.replace({ query: { ...route.query, event: event || undefined, discipline: undefined } }),
});
const discipline = computed({
  get: () => queryValue('discipline'),
  set: (name) => router.replace({ query: { ...route.query, discipline: name || undefined } }),
});

const currentEvent = computed(() => events.value.find((event) => event.name === eventName.value));
const disciplineExists = computed(() => currentEvent.value?.disciplines.includes(discipline.value) ?? false);

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

async function loadEvents(): Promise<void> {
  try {
    const body = await getJson<EventsResponse>('/api/events');
    workDir.value = body.workDir;
    events.value = body.events;
    loadError.value = null;
  } catch (e) {
    loadError.value = `Cannot load the events: ${errorText(e)}`;
  }
  eventsLoaded.value = true;
  // Select the only choice, so a single event or discipline needs no click
  if (!eventName.value && events.value.length === 1) eventName.value = events.value[0].name;
}

// Ignores the answer of a request when another one was started meanwhile (fast discipline changes)
let participantsRequest = 0;

async function loadResults(): Promise<void> {
  try {
    results.value = (await getJson<ResultsResponse>(`${disciplinePath()}/results`)).results;
  } catch (e) {
    loadError.value = `Cannot load the results: ${errorText(e)}`;
  }
}

/** Shows the event, discipline and participant of a run in progress, e.g. started from another browser. */
function showRun(): void {
  const current = run.value;
  if (current.status === 'idle') return;
  if (current.event !== eventName.value || current.discipline !== discipline.value) {
    router.replace({ query: { ...route.query, event: current.event, discipline: current.discipline } });
  } else if (selected.value?.bib !== current.participant.bib) {
    selected.value = participants.value.find((p) => p.bib === current.participant.bib) ?? null;
  }
}

async function loadRun(): Promise<void> {
  try {
    run.value = await getJson<RunState>('/api/run');
    showRun();
  } catch (e) {
    loadError.value = `Cannot load the current run: ${errorText(e)}`;
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
    loadError.value = `Cannot change the result: ${errorText(e)}`;
  } finally {
    busy.value = false;
  }
}

// Reloads the run on each WebSocket (re)connection, so a run that changed while disconnected is shown
useRaceSocket({ onMessage, onConnect: loadRun });

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
    const what = {
      ready: 'get the participant ready',
      cancel: 'cancel the run',
      invalidate: 'invalidate the run',
      disqualify: 'disqualify the participant',
    }[action];
    loadError.value = `Cannot ${what}: ${errorText(e)}`;
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  if (run.value.status === 'running' && !confirm('Cancel this run? Its time will not be saved.')) return;
  postRun('cancel');
}

/** Ends the running run now, saved as INVALID or DQ, after a confirmation. */
function voidRun(action: 'invalidate' | 'disqualify'): void {
  if (run.value.status !== 'running') return;
  const { bib, name } = run.value.participant;
  const question =
    action === 'disqualify'
      ? `Disqualify ${bib} ${name}? The run ends now and is saved as disqualified (DQ).`
      : `Invalidate this run of ${bib} ${name}? The run ends now and is saved as invalid (not a disqualification).`;
  if (!confirm(question)) return;
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
    loadError.value = `Cannot load the participants: ${errorText(e)}`;
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

watch(currentEvent, (event) => {
  if (event && !discipline.value && event.disciplines.length === 1) discipline.value = event.disciplines[0];
});
watch([eventName, discipline], () => {
  selected.value = null;
  editingSettings.value = false;
  loadParticipants();
});
watch(selected, () => (lastResult.value = null));

onMounted(reload);
</script>

<template>
  <main class="page">
    <div class="page-header">
      <h1>Race</h1>
      <button type="button" class="secondary" title="Read the folders and CSV files again" @click="reload">Reload lists</button>
    </div>

    <p v-if="loadError" class="alert error">{{ loadError }}</p>

    <div v-if="eventsLoaded && events.length === 0 && !loadError" class="alert hint">
      <p>No event yet. Create one folder per event in <code>{{ workDir }}</code>, one subfolder per discipline, and put the participant CSV files in it:</p>
      <pre class="tree">CFM26/
  100m/
    femmes.csv     bib;name
    hommes.csv     1;Hugo Guérin</pre>
      <p>Then click <em>Reload lists</em>.</p>
    </div>

    <section v-else class="card selectors">
      <label class="field">
        Event
        <select v-model="eventName" :disabled="locked">
          <option value="" disabled>Choose an event</option>
          <option v-for="event in events" :key="event.name" :value="event.name">{{ event.name }}</option>
        </select>
      </label>

      <div class="field">
        <span class="label-row">
          <label for="discipline-select">Discipline</label>
          <button
            type="button"
            class="link"
            :disabled="!disciplineExists"
            :aria-expanded="editingSettings"
            title="Settings of this discipline (number of attempts)"
            @click="editingSettings ? (editingSettings = false) : openSettings()"
          >
            ⚙ Settings
          </button>
        </span>
        <select id="discipline-select" v-model="discipline" :disabled="locked || !currentEvent || currentEvent.disciplines.length === 0">
          <option value="" disabled>
            {{ currentEvent && currentEvent.disciplines.length === 0 ? 'No discipline in this event' : 'Choose a discipline' }}
          </option>
          <option v-for="name in currentEvent?.disciplines ?? []" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>

      <div class="field participant">
        <span>
          Participant
          <span v-if="disciplineExists && !loadingParticipants" class="muted">
            <template v-if="settings.attempts !== null">({{ remainingCount }} remaining / {{ participants.length }})</template>
            <template v-else>({{ participants.length }})</template>
          </span>
        </span>
        <ParticipantPicker
          ref="picker"
          v-model="selected"
          :participants="participants"
          :finished="finishedBibs"
          :disabled="locked || !disciplineExists"
        />
      </div>
    </section>

    <form v-if="editingSettings && disciplineExists" class="card settings" @submit.prevent="saveSettings">
      <h3>Settings of {{ eventName }} / {{ discipline }}</h3>
      <label class="field">
        Attempts per participant
        <input v-model="attemptsInput" type="number" min="1" step="1" placeholder="Unlimited" class="attempts" />
      </label>
      <p class="muted small">Invalid runs do not use up an attempt. Leave empty for unlimited attempts.</p>
      <div class="period">
        <label class="field">
          Start
          <input v-model="startInput" type="datetime-local" :max="endInput || undefined" />
        </label>
        <label class="field">
          End
          <input v-model="endInput" type="datetime-local" :min="startInput || undefined" />
        </label>
      </div>
      <p class="muted small">
        Runs can be timed and results changed only from the start until the end (this computer's time, saved in UTC).
        Leave empty for no limit.
      </p>
      <fieldset class="access">
        <legend>Runs and result changes</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in ACCESS_OPTIONS" :key="option.value" :class="[option.value, { checked: accessInput === option.value }]" :title="option.hint">
            <input v-model="accessInput" type="radio" name="access" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
        <p class="muted small">{{ ACCESS_OPTIONS.find((option) => option.value === accessInput)?.hint }}</p>
      </fieldset>
      <p v-if="settingsError" class="alert error">{{ settingsError }}</p>
      <div class="actions">
        <button type="submit" :disabled="savingSettings">Save</button>
        <button type="button" class="secondary" @click="editingSettings = false">Cancel</button>
      </div>
    </form>

    <p v-if="disciplineExists && forcedOpen" class="alert hint">
      {{ eventName }} / {{ discipline }} is open although {{ outsidePeriod }}: access is forced open in
      <em>⚙ Settings</em>.
    </p>

    <p v-if="disciplineExists && closedReason" class="alert warn">
      {{ eventName }} / {{ discipline }} is closed: {{ closedReason }}. Runs and result changes are disabled
      (see <em>⚙ Settings</em>).
    </p>

    <p v-if="disciplineExists && !loadingParticipants && participants.length === 0" class="alert warn">
      No participant in {{ eventName }} / {{ discipline }}: add CSV files with <code>bib;name</code> lines to its folder.
    </p>

    <details v-if="problems.length > 0" class="alert warn">
      <summary>{{ problems.length }} problem(s) in the files of {{ discipline }}</summary>
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
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.selectors {
  display: grid;
  grid-template-columns: minmax(10em, 1fr) minmax(10em, 1fr) minmax(16em, 2fr);
  gap: 12px 16px;
  align-items: start;
}
@media (max-width: 720px) {
  .selectors {
    grid-template-columns: 1fr;
  }
}
.selectors select {
  padding: 8px;
}
.label-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
button.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 1em;
}
button.link:disabled {
  color: var(--text-muted);
}
.settings h3 {
  margin: 0 0 12px;
}
.access {
  margin: 12px 0 0;
  padding: 0;
  border: none;
}
.access legend {
  font-size: 0.85em;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.segmented label {
  padding: 5px 14px;
  cursor: pointer;
  color: var(--text);
  border-left: 1px solid var(--border);
}
.segmented label:first-child {
  border-left: none;
}
.segmented input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.segmented label:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.segmented label.checked {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}
.segmented label.open.checked {
  background: var(--ok-bg);
  color: var(--ok);
}
.segmented label.locked.checked {
  background: var(--error-bg);
  color: var(--error);
}
.period {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.settings input[type='datetime-local'] {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-h);
}
.settings .attempts {
  font: inherit;
  width: 8em;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-h);
}
.settings .actions {
  display: flex;
  gap: 8px;
}
.settings .actions button {
  margin: 0;
}
.small {
  font-size: 0.85em;
  margin-top: 6px;
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
