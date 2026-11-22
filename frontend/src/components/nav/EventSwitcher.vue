<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { usePopover } from '../../composables/usePopover';
import { adminLocked } from '../../adminLock';
import {
  discipline,
  disciplineRoute,
  leaveSettings,
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
 * Title of the pages of a discipline ("CFM26 · 100m ▾"): opens a panel to change the event and discipline and read the
 * folders again. Beside it, a gear opens the settings page of the discipline (unless the administration is locked).
 */
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const eventSelect = ref<HTMLSelectElement | null>(null);
const { toggle, close } = usePopover(root, button, switcherOpen);
const { t } = useI18n();
const route = useRoute();
// On the settings page, the gear closes it (asking first when changes are not saved)
const onSettings = computed(() => route.name === 'disciplineConfig');
function onGear(event: MouseEvent): void {
  if (!onSettings.value) return;
  event.preventDefault();
  leaveSettings();
}
// The event chosen in the panel: the page changes once its discipline is chosen too
const pendingEvent = ref('');
const pending = computed(() => events.value.find((event) => event.name === pendingEvent.value));

const label = computed(() => {
  if (!eventName.value) return t('switcher.chooseEvent');
  return discipline.value ? `${eventName.value} · ${discipline.value}` : t('switcher.chooseDisciplineOf', { event: eventName.value });
});
const incomplete = computed(() => !eventName.value || !discipline.value);

// Fresh lists each time it opens (folders may have been added), and the focus on the first choice to make
watch(switcherOpen, async (isOpen) => {
  if (!isOpen) return;
  pendingEvent.value = eventName.value;
  loadEvents();
  await nextTick();
  if (!selectionLock.value) eventSelect.value?.focus();
});
function onEvent(name: string): void {
  pendingEvent.value = name;
  const event = events.value.find((e) => e.name === name);
  if (event?.disciplines.length === 1) onDiscipline(event.disciplines[0]);
}

function onDiscipline(name: string): void {
  select(pendingEvent.value, name);
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
    <RouterLink
      v-if="disciplineExists && !adminLocked"
      :to="disciplineRoute('disciplineConfig', eventName, discipline)"
      class="settings-link"
      :class="{ current: onSettings }"
      :aria-current="onSettings ? 'page' : undefined"
      :title="onSettings ? $t('switcher.closeSettings') : $t('switcher.settingsTitle')"
      :aria-label="$t('pages.disciplineConfig')"
      @click="onGear"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
    </RouterLink>

    <div v-if="switcherOpen" class="panel" role="dialog" :aria-label="$t('switcher.panelLabel')">
      <p v-if="eventsLoaded && events.length === 0" class="muted">{{ $t('switcher.noEvent') }}</p>
      <template v-else>
        <p v-if="selectionLock" class="lock muted">{{ selectionLock }}</p>
        <div class="choices">
          <label class="field">
            {{ $t('switcher.event') }}
            <select
              ref="eventSelect"
              :value="pendingEvent"
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
              :value="pendingEvent === eventName ? discipline : ''"
              :disabled="selectionLock !== null || !pending || pending.disciplines.length === 0"
              @change="onDiscipline(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>
                {{ pending && pending.disciplines.length === 0 ? $t('switcher.noDiscipline') : $t('switcher.chooseDiscipline') }}
              </option>
              <option v-for="name in pending?.disciplines ?? []" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </div>
      </template>

      <div class="tools">
        <button type="button" class="link" :title="$t('switcher.reloadTitle')" @click="reload">{{ $t('switcher.reload') }}</button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.switcher {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
}
/* The gear of the discipline settings, discreet beside the title */
.settings-link {
  display: inline-flex;
  padding: 6px;
  border-radius: 6px;
  color: var(--text-muted);
}
.settings-link:hover,
.settings-link:focus-visible,
.settings-link.current {
  color: var(--accent);
  background: var(--accent-bg);
  outline: none;
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
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.link {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 0.9em;
  text-decoration: none;
}
</style>
