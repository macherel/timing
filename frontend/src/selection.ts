import { computed, ref } from 'vue';
import type { RouteLocationNamedRaw, RouteLocationNormalized, Router } from 'vue-router';
import type { EventSummary, EventsResponse } from './types';
import { t } from './i18n';

/**
 * The event and discipline the race pages work on, shared by the event switcher of the navigation bar and the pages.
 *
 * They are the start of the URL of the pages of a discipline (/<event>/<discipline>/race, …/live, …/config), so a
 * reload or a bookmark keeps them. The home page (/) lists the events to choose from (ChoicePage). The last choice is
 * remembered in the browser, to open its event in that list.
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

/** The pages of a discipline, by route name. */
export type DisciplinePage = 'race' | 'live' | 'disciplineConfig';

/** The URL of a page of a discipline. */
export const disciplineRoute = (page: DisciplinePage, event: string, disciplineName: string): RouteLocationNamedRaw => ({
  name: page,
  params: { event, discipline: disciplineName },
});

/** Whether a page works on the selected event and discipline (the pages of a discipline, not the administration). */
export const usesSelection = (route: RouteLocationNormalized) => route.meta.selection === true;

/** Whether the page is the list of the events (the home page), or a race page: the race / live switch is shown. */
export const switchesPage = (route: RouteLocationNormalized) => route.path === '/' || usesSelection(route);

/** The page that a click in the list of the events opens: the live page with ?open=live, else the race page. */
export const listTarget = (route: RouteLocationNormalized): 'race' | 'live' => (route.query.open === 'live' ? 'live' : 'race');

function remembered(): { event: string; discipline: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return typeof saved?.event === 'string' && typeof saved?.discipline === 'string' ? saved : null;
  } catch {
    return null;
  }
}

/** The last event and discipline chosen, in this page or before the app was opened again, or null. */
export function lastSelection(): { event: string; discipline: string } | null {
  return remembered();
}

function remember(selection: { event: string; discipline: string }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Private window or blocked storage: the choice is only kept in the URL
  }
}

/** Shows the current page of a discipline (race, live or settings) on another event and discipline. */
export function select(event: string, disciplineName: string): void {
  const current = router.currentRoute.value;
  const page: DisciplinePage = usesSelection(current) ? (current.name as DisciplinePage) : 'race';
  router.replace(disciplineRoute(page, event, disciplineName));
}

/**
 * Leaves the settings page of the discipline: back to the page of the discipline it was opened from, or else its race
 * page. The settings page asks first when it has unsaved changes.
 */
export function leaveSettings(): void {
  const race = router.resolve(disciplineRoute('race', eventName.value, discipline.value)).href;
  const prefix = race.slice(0, race.lastIndexOf('/') + 1);
  const previous = router.options.history.state.back;
  if (typeof previous === 'string' && previous.startsWith(prefix)) router.back();
  else router.push(race);
}

/** Reads the events of the working directory. */
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
}

/** Connects the selection to the router: follows the URL of the pages of a discipline, and remembers each choice. */
export function installSelection(appRouter: Router): void {
  router = appRouter;

  router.afterEach((to) => {
    if (!usesSelection(to)) return;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    query.value = { event: text(to.params.event), discipline: text(to.params.discipline) };
    remember(query.value);
  });
}
