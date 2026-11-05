<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type {
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
import RunPanel from '../components/race/RunPanel.vue';

const route = useRoute();
const router = useRouter();

const workDir = ref('');
const events = ref<EventSummary[]>([]);
const eventsLoaded = ref(false);
const loadError = ref<string | null>(null);

const participants = ref<Participant[]>([]);
const problems = ref<string[]>([]);
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
  }
}

// Reloads the run on each WebSocket (re)connection, so a run that changed while disconnected is shown
useRaceSocket({ onMessage, onConnect: loadRun });

async function postRun(action: 'ready' | 'cancel'): Promise<void> {
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
    loadError.value = `Cannot ${action === 'ready' ? 'get the participant ready' : 'cancel the run'}: ${errorText(e)}`;
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  if (run.value.status === 'running' && !confirm('Cancel this run? Its time will not be saved.')) return;
  postRun('cancel');
}

async function loadParticipants(): Promise<void> {
  const request = ++participantsRequest;
  if (!disciplineExists.value) {
    participants.value = [];
    problems.value = [];
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

      <label class="field">
        Discipline
        <select v-model="discipline" :disabled="locked || !currentEvent || currentEvent.disciplines.length === 0">
          <option value="" disabled>
            {{ currentEvent && currentEvent.disciplines.length === 0 ? 'No discipline in this event' : 'Choose a discipline' }}
          </option>
          <option v-for="name in currentEvent?.disciplines ?? []" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>

      <div class="field participant">
        <span>
          Participant
          <span v-if="disciplineExists && !loadingParticipants" class="muted">({{ participants.length }})</span>
        </span>
        <ParticipantPicker ref="picker" v-model="selected" :participants="participants" :disabled="locked || !disciplineExists" />
      </div>
    </section>

    <p v-if="disciplineExists && !loadingParticipants && participants.length === 0" class="alert warn">
      No participant in {{ eventName }} / {{ discipline }}: add CSV files with <code>bib;name</code> lines to its folder.
    </p>

    <details v-if="problems.length > 0" class="alert warn">
      <summary>{{ problems.length }} CSV line(s) skipped</summary>
      <ul>
        <li v-for="problem in problems" :key="problem">{{ problem }}</li>
      </ul>
    </details>

    <RunPanel
      v-if="selected"
      :participant="selected"
      :run="run"
      :results="participantResults"
      :last-result="lastResult"
      :busy="busy"
      @ready="postRun('ready')"
      @cancel="cancel"
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
