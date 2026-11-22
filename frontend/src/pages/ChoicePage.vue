<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useRaceSocket } from '../composables/useRaceSocket';
import { disciplineRoute, events, eventsError, eventsLoaded, lastSelection, listTarget, loadEvents, workDir } from '../selection';

/**
 * The home page: every event of the working directory, as an accordion of its disciplines. A click opens the race page
 * on it, or the live page (?open=live, set by the race / live switch of the navigation bar).
 */
const route = useRoute();
const router = useRouter();

// The race or live page, to open on the discipline chosen
const target = computed(() => listTarget(route));

// Accordion: one event open at a time, at first the one in the URL or of the last choice, or the only one
const asked = route.query.event;
const openEvent = ref(typeof asked === 'string' && asked ? asked : (lastSelection()?.event ?? ''));
const isOpen = (event: string) => openEvent.value === event || events.value.length === 1;
const toggle = (event: string) => (openEvent.value = openEvent.value === event ? '' : event);
const panelId = (index: number) => `event-panel-${index}`;
const refreshing = ref(false);

function open(event: string, discipline: string, replace = false): void {
  const location = disciplineRoute(target.value, event, discipline);
  if (replace) router.replace(location);
  else router.push(location);
}

// A single event and discipline need no click
watch(
  events,
  (list) => {
    if (list.length === 1 && list[0].disciplines.length === 1) open(list[0].name, list[0].disciplines[0], true);
  },
  { immediate: true },
);

async function reload(): Promise<void> {
  refreshing.value = true;
  await loadEvents();
  refreshing.value = false;
}

// Folders added on another computer appear without a reload
useRaceSocket({
  onMessage: (message) => {
    if (message.type === 'SYNC_UPDATE') loadEvents();
  },
});

loadEvents();
</script>

<template>
  <main class="page choice">
    <p v-if="eventsError" class="alert error">{{ eventsError }}</p>

    <div class="heading">
      <h2>{{ $t(target === 'live' ? 'choice.titleLive' : 'choice.title') }}</h2>
      <button type="button" class="secondary" :disabled="refreshing" :title="$t('switcher.reloadTitle')" @click="reload">
        {{ $t('switcher.reload') }}
      </button>
    </div>

    <p v-if="!eventsLoaded" class="muted">{{ $t('common.loading') }}</p>

    <div v-else-if="events.length === 0 && !eventsError" class="alert hint">
      <i18n-t keypath="choice.noEvent" tag="p">
        <template #dir><code>{{ workDir }}</code></template>
      </i18n-t>
      <pre class="tree">CFM26/
  100m/
    femmes.csv     bib;name
    hommes.csv     1;Hugo Guérin</pre>
      <i18n-t keypath="choice.noEventThen" tag="p">
        <template #button><em>{{ $t('switcher.reload') }}</em></template>
      </i18n-t>
    </div>

    <div v-else class="accordion">
      <section v-for="(event, index) in events" :key="event.name" class="event" :class="{ open: isOpen(event.name) }">
        <h3>
          <button
            type="button"
            class="event-header"
            :aria-expanded="isOpen(event.name)"
            :aria-controls="panelId(index)"
            @click="toggle(event.name)"
          >
            <span class="chevron" aria-hidden="true">▸</span>
            <span class="event-name">{{ event.name }}</span>
            <span class="muted count">{{ $t('choice.disciplines', event.disciplines.length) }}</span>
          </button>
        </h3>
        <div v-show="isOpen(event.name)" :id="panelId(index)" role="region" :aria-label="event.name" class="panel">
          <p v-if="event.disciplines.length === 0" class="muted small">{{ $t('switcher.noDiscipline') }}</p>
          <div v-else class="disciplines">
            <button
              v-for="discipline in event.disciplines"
              :key="discipline"
              type="button"
              class="discipline"
              @click="open(event.name, discipline)"
            >
              {{ discipline }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.heading h2 {
  margin: 0;
  flex: 1;
}
.heading button {
  margin: 0;
}
/* One fold per event, its disciplines as large buttons, easy to hit on a touch screen */
.accordion {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.event + .event {
  border-top: 1px solid var(--border);
}
.event h3 {
  margin: 0;
}
.event-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 0;
  padding: 14px 16px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-h);
  font-size: 1.2em;
  font-weight: 600;
  text-align: left;
}
.event-header:hover,
.event-header:focus-visible {
  background: var(--accent-bg);
  outline: none;
}
.event-name {
  flex: 1;
}
.count {
  font-size: 0.75em;
  font-weight: 400;
}
.chevron {
  font-size: 0.8em;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.event.open .chevron {
  transform: rotate(90deg);
}
.panel {
  padding: 4px 16px 16px 40px;
}
.disciplines {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.discipline {
  margin: 0;
  min-width: 96px;
  padding: 10px 16px;
  font-size: 1.1em;
  font-weight: 600;
  background: var(--bg);
  color: var(--text-h);
  border: 1px solid var(--border);
}
.discipline:hover,
.discipline:focus-visible {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.small {
  font-size: 0.85em;
}
.tree {
  font-family: var(--mono);
  font-size: 0.9em;
  margin: 8px 0;
}
</style>
