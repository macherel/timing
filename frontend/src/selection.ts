import { computed, ref, watch } from 'vue';
import type { RouteLocationNormalized, Router } from 'vue-router';
import type { EventSummary, EventsResponse } from './types';
import { t } from './i18n';

/**
 * The event and discipline the race pages work on, shared by the event switcher of the navigation bar and the pages.
 *
 * They live in the URL of the race pages (?event=…&discipline=…), so a reload or a bookmark keeps them. The last
 * choice is also remembered (in this module and in the browser), so going to an administration page and back, or
 * opening the app again, keeps it.
 */

const STORAGE_KEY = 'timing.selection';

export const events = ref<EventSummary[]>([]);
export const workDir = ref('');
export const eventsLoaded = ref(false);
export const eventsError = ref<string | null>(null);

// Why the event and discipline cannot be changed now (a run is in progress), or null. Set by the race page
export const selectionLock = ref<string | null>(null);
// Whether the event switcher of the navigation bar is open, so a page can open it (e.g. "Choose the event")
export const switcherOpen = ref(false);
// Incremented by "Reload lists" in the event switcher: race pages read their files again
export const reloadRequests = ref(0);

let router: Router;
const query = ref<{ event: string; discipline: string }>({ event: '', discipline: '' });

export const eventName = computed(() => query.value.event);
export const discipline = computed(() => query.value.discipline);
export const currentEvent = computed(() => events.value.find((event) => event.name === eventName.value));
export const disciplineExists = computed(() => currentEvent.value?.disciplines.includes(discipline.value) ?? false);

/**
 * The line the race page times on, chosen on the page. Not remembered when the app is opened again (or reloaded), so
 * the operator always says which line they time on. Empty: none chosen, the race page asks for one.
 */
export const selectedLine = ref('');

export function selectLine(line: string): void {
  selectedLine.value = line;
}

/** Whether a page works on the selected event and discipline (the race pages, not the administration). */
export const usesSelection = (route: RouteLocationNormalized) => route.meta.section === 'race';

function remembered(): { event: string; discipline: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return typeof saved?.event === 'string' && typeof saved?.discipline === 'string' ? saved : null;
  } catch {
    return null;
  }
}

function remember(selection: { event: string; discipline: string }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Private window or blocked storage: the choice is only kept in the URL
  }
}

/** Selects an event and discipline (an empty discipline lets the user choose it). */
export function select(event: string, disciplineName = ''): void {
  router.replace({ query: { ...router.currentRoute.value.query, event: event || undefined, discipline: disciplineName || undefined } });
}

/** Reads the events of the working directory, and selects the only choice when there is one. */
export async function loadEvents(): Promise<void> {
  try {
    const response = await fetch('/api/events');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: EventsResponse = await response.json();
    workDir.value = body.workDir;
    events.value = body.events;
    eventsError.value = null;
  } catch (e) {
    eventsError.value = t('switcher.loadError', { error: e instanceof Error ? e.message : String(e) });
  }
  eventsLoaded.value = true;
  autoSelect();
}

/** A single event or discipline needs no click. */
function autoSelect(): void {
  if (!usesSelection(router.currentRoute.value) || selectionLock.value) return;
  if (!eventName.value && events.value.length === 1) {
    select(events.value[0].name);
  } else if (currentEvent.value && !discipline.value && currentEvent.value.disciplines.length === 1) {
    select(eventName.value, currentEvent.value.disciplines[0]);
  }
}

/**
 * Connects the selection to the router: follows the URL of the race pages, gives a race page opened without a
 * selection the last one, and remembers each choice.
 */
export function installSelection(appRouter: Router): void {
  router = appRouter;

  router.beforeEach((to) => {
    if (!usesSelection(to) || to.query.event !== undefined) return true;
    const last = query.value.event ? query.value : remembered();
    if (!last?.event) return true;
    return { ...to, query: { ...to.query, event: last.event, discipline: last.discipline || undefined } };
  });

  router.afterEach((to) => {
    if (!usesSelection(to)) return;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    query.value = { event: text(to.query.event), discipline: text(to.query.discipline) };
    remember(query.value);
  });

  watch(currentEvent, autoSelect);
}
