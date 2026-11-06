<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePopover } from '../../composables/usePopover';
import DisciplineSettingsForm from './DisciplineSettingsForm.vue';
import {
  currentEvent,
  discipline,
  disciplineExists,
  eventName,
  events,
  eventsLoaded,
  loadEvents,
  reloadRequests,
  select,
  selectionLock,
  switcherOpen,
} from '../../selection';

/**
 * Second half of the page title on race pages ("CFM26 · 100m ▾"): opens a panel to change the event and discipline,
 * edit the discipline settings and read the folders again.
 */
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const eventSelect = ref<HTMLSelectElement | null>(null);
const { toggle, close } = usePopover(root, button, switcherOpen);
const editingSettings = ref(false);
const { t } = useI18n();

const label = computed(() => {
  if (!eventName.value) return t('switcher.chooseEvent');
  return discipline.value ? `${eventName.value} · ${discipline.value}` : t('switcher.chooseDisciplineOf', { event: eventName.value });
});
const incomplete = computed(() => !eventName.value || !discipline.value);

// Fresh lists each time it opens (folders may have been added), and the focus on the first choice to make
watch(switcherOpen, async (isOpen) => {
  editingSettings.value = false;
  if (!isOpen) return;
  loadEvents();
  await nextTick();
  if (!selectionLock.value) eventSelect.value?.focus();
});
watch([eventName, discipline], () => (editingSettings.value = false));

function onEvent(name: string): void {
  const event = events.value.find((e) => e.name === name);
  select(name, event?.disciplines.length === 1 ? event.disciplines[0] : '');
  if (event?.disciplines.length === 1) close();
}

function onDiscipline(name: string): void {
  select(eventName.value, name);
  close();
}

function reload(): void {
  loadEvents();
  reloadRequests.value++;
}
</script>

<template>
  <div ref="root" class="switcher">
    <button
      ref="button"
      type="button"
      class="switch-button"
      :class="{ incomplete }"
      aria-haspopup="dialog"
      :aria-expanded="switcherOpen"
      :title="$t('switcher.buttonTitle')"
      @click="toggle"
    >
      {{ label }}
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="switcherOpen" class="panel" :class="{ wide: editingSettings }" role="dialog" :aria-label="$t('switcher.panelLabel')">
      <p v-if="eventsLoaded && events.length === 0" class="muted">{{ $t('switcher.noEvent') }}</p>
      <template v-else>
        <p v-if="selectionLock" class="lock muted">{{ selectionLock }}</p>
        <div class="choices">
          <label class="field">
            {{ $t('switcher.event') }}
            <select
              ref="eventSelect"
              :value="eventName"
              :disabled="selectionLock !== null"
              @change="onEvent(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ $t('switcher.chooseEvent') }}</option>
              <option v-for="event in events" :key="event.name" :value="event.name">{{ event.name }}</option>
            </select>
          </label>
          <label class="field">
            {{ $t('switcher.discipline') }}
            <select
              :value="discipline"
              :disabled="selectionLock !== null || !currentEvent || currentEvent.disciplines.length === 0"
              @change="onDiscipline(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>
                {{ currentEvent && currentEvent.disciplines.length === 0 ? $t('switcher.noDiscipline') : $t('switcher.chooseDiscipline') }}
              </option>
              <option v-for="name in currentEvent?.disciplines ?? []" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </div>
      </template>

      <div class="tools">
        <button
          v-if="disciplineExists"
          type="button"
          class="link"
          :aria-expanded="editingSettings"
          :title="$t('switcher.settingsTitle')"
          @click="editingSettings = !editingSettings"
        >
          {{ $t('switcher.settings') }}
        </button>
        <button type="button" class="link" :title="$t('switcher.reloadTitle')" @click="reload">{{ $t('switcher.reload') }}</button>
      </div>

      <section v-if="editingSettings && disciplineExists" class="settings-section">
        <h3>{{ $t('switcher.settingsOf', { event: eventName, discipline }) }}</h3>
        <DisciplineSettingsForm :event="eventName" :discipline="discipline" @done="editingSettings = false" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.switcher {
  position: relative;
}
/* The title of the race pages, centred in the navigation bar: "CFM26 · 100m ▾" */
.switch-button {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 4px 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-h);
  font-size: 1.8em;
  font-weight: 700;
  line-height: 1.2;
}
.switch-button:hover,
.switch-button[aria-expanded='true'] {
  background: var(--accent-bg);
}
.switch-button.incomplete {
  color: var(--accent);
  border: 1px dashed var(--accent);
}
.caret {
  font-size: 0.5em;
  color: var(--text-muted);
}
.panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 300px;
  max-width: calc(100vw - 32px);
  padding: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.panel.wide {
  width: 460px;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel select {
  width: 100%;
}
.panel p {
  margin: 0;
}
.lock {
  font-size: 0.85em;
}
.tools {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
button.link {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 0.9em;
}
.settings-section {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.settings-section h3 {
  margin: 0 0 10px;
  font-size: 1em;
}
</style>
