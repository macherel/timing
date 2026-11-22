<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { DisciplineFile, ParticipantsResponse } from '../types';
import { useRaceSocket } from '../composables/useRaceSocket';
import DisciplineSettingsForm, { type SettingsSection } from '../components/discipline/DisciplineSettingsForm.vue';
import ParticipantFiles from '../components/discipline/ParticipantFiles.vue';
import ResultFiles from '../components/discipline/ResultFiles.vue';
import PageTabs from '../components/PageTabs.vue';
import { discipline, disciplineExists, eventName, eventsLoaded, leaveSettings, loadEvents } from '../selection';

/**
 * The settings page of a discipline (/<event>/<discipline>/config), hidden while the administration is locked, in
 * five tabs, each with its URL. The first three are the sections of one form, saved together:
 * - settings (…/config): the basic settings, what triggers the runs, attempts and best time;
 * - advanced (…/config/advanced): precision and rounding of the times, last runs shown;
 * - lock (…/config/lock): period and access.
 *   Saving or cancelling goes back to the page of the discipline it came from, as the gear beside the title does;
 *   leaving another way with unsaved changes asks first. Switching tabs keeps them;
 * - participants (…/config/participants): its participant files, to download, replace or add;
 * - results (…/config/results): its results file and their UDA export, to download.
 */
const TABS = ['settings', 'advanced', 'lock', 'participants', 'results'] as const;
type Tab = (typeof TABS)[number];
// The tabs of the settings form, and its section on each
const SECTIONS: Partial<Record<Tab, SettingsSection>> = { settings: 'basic', advanced: 'advanced', lock: 'lock' };

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() => TABS.find((name) => name !== 'settings' && name === route.params.tab) ?? 'settings');
const section = computed(() => SECTIONS[tab.value] ?? null);
const tabs = computed(() =>
  TABS.map((name) => ({
    key: name,
    label: t(`disciplineConfig.tabs.${name}`),
    to: tabRoute(name),
  })),
);

function tabRoute(name: Tab) {
  return { name: 'disciplineConfig', params: { event: eventName.value, discipline: discipline.value, ...(name === 'settings' ? {} : { tab: name }) } };
}

/** Shows the tab of a section of the settings form, e.g. the one of an invalid field. */
function showSection(wanted: SettingsSection): void {
  const name = TABS.find((candidate) => SECTIONS[candidate] === wanted);
  if (name) router.replace(tabRoute(name));
}

const form = ref<InstanceType<typeof DisciplineSettingsForm> | null>(null);
// Cancel leaves without asking: the changes are dropped on purpose
let discarding = false;

const mayLeave = () => discarding || !form.value?.dirty || confirm(t('config.confirmLeave'));
onBeforeRouteLeave(mayLeave);
// Another discipline chosen in the title menu asks too, not another tab
onBeforeRouteUpdate((to, from) => (to.params.event === from.params.event && to.params.discipline === from.params.discipline) || mayLeave());

function onDone(): void {
  discarding = true;
  leaveSettings();
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (form.value?.dirty) event.preventDefault();
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload));

// The files of the discipline, with its participants count and the problems found in their files
const files = ref<DisciplineFile[]>([]);
const count = ref<number | null>(null);
const problems = ref<string[]>([]);
const filesError = ref<string | null>(null);
let filesRequest = 0;

async function loadFiles(): Promise<void> {
  const request = ++filesRequest;
  const base = `/api/events/${encodeURIComponent(eventName.value)}/${encodeURIComponent(discipline.value)}`;
  try {
    const [filesResponse, participantsResponse] = await Promise.all([fetch(`${base}/files`), fetch(`${base}/participants`)]);
    if (!filesResponse.ok) throw new Error(`HTTP ${filesResponse.status}`);
    if (!participantsResponse.ok) throw new Error(`HTTP ${participantsResponse.status}`);
    const list: { files: DisciplineFile[] } = await filesResponse.json();
    const participants: ParticipantsResponse = await participantsResponse.json();
    if (request !== filesRequest) return;
    files.value = list.files;
    count.value = participants.participants.length;
    problems.value = participants.problems;
    filesError.value = null;
  } catch (e) {
    if (request === filesRequest) filesError.value = t('files.loadError', { error: e instanceof Error ? e.message : String(e) });
  }
}

watch(
  [eventName, discipline, disciplineExists],
  () => {
    if (disciplineExists.value) loadFiles();
  },
  { immediate: true },
);

// New results, or files copied by the sync or uploaded from another page
useRaceSocket({
  onMessage: (message) => {
    const here = 'event' in message && message.event === eventName.value && 'discipline' in message && message.discipline === discipline.value;
    if (here && (message.type === 'SYNC_UPDATE' || message.type === 'RUN_RESULT' || message.type === 'RESULT_UPDATE')) loadFiles();
  },
});

if (!eventsLoaded.value) loadEvents();
</script>

<template>
  <main class="page settings-page">
    <h2>{{ $t('switcher.settingsOf', { event: eventName, discipline }) }}</h2>
    <div v-if="eventsLoaded && !disciplineExists" class="alert hint choose">
      <span>{{ $t('race.chooseEventAndDiscipline') }}</span>
      <RouterLink to="/" class="button">{{ $t('common.choose') }}</RouterLink>
    </div>
    <template v-else-if="disciplineExists">
      <PageTabs :tabs="tabs" :current="tab" :label="$t('disciplineConfig.tabsLabel')" />

      <!-- Kept while another tab is shown, so its changes are not lost -->
      <section v-show="section" :id="`panel-${tab}`" role="tabpanel" :aria-labelledby="`tab-${tab}`" class="card">
        <DisciplineSettingsForm
          ref="form"
          :key="`${eventName}\n${discipline}`"
          :event="eventName"
          :discipline="discipline"
          :section="section ?? 'basic'"
          @done="onDone"
          @show-section="showSection"
        />
      </section>
      <section v-if="!section" :id="`panel-${tab}`" role="tabpanel" :aria-labelledby="`tab-${tab}`" class="card">
        <p v-if="filesError" class="alert error">{{ filesError }}</p>
        <ParticipantFiles
          v-if="tab === 'participants'"
          :event="eventName"
          :discipline="discipline"
          :files="files"
          :count="count"
          :problems="problems"
          @changed="loadFiles"
        />
        <ResultFiles v-else :event="eventName" :discipline="discipline" :files="files" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.settings-page {
  max-width: 760px;
}
.choose {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.card {
  border-top-left-radius: 0;
}
</style>
