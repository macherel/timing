import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import ConfigPage from './pages/ConfigPage.vue';
import DiagnosticsPage from './pages/DiagnosticsPage.vue';
import RacePage from './pages/RacePage.vue';
import LivePage from './pages/LivePage.vue';
import ChoicePage from './pages/ChoicePage.vue';
import DisciplineConfigPage from './pages/DisciplineConfigPage.vue';
import { disciplineRoute, installSelection } from './selection';
import { adminLocked, checkLock } from './adminLock';
import { locale, t } from './i18n';
import { watch } from 'vue';

declare module 'vue-router' {
  interface RouteMeta {
    // Key of the page name in the texts (pages.<page>), shown in the menu and the browser tab
    page?: 'choice' | 'race' | 'live' | 'disciplineConfig' | 'diagnostics' | 'config';
    // Menu group: race pages are about the events, administration pages about the computer
    section?: 'race' | 'admin';
    // Whether the page works on the selected event and discipline (/<event>/<discipline>/…)
    selection?: boolean;
    // Whether the page is hidden while the administration is locked, though not an administration page
    adminOnly?: boolean;
  }
}

/** The race or live page of the discipline in the query of an old link (?event=…&discipline=…), or else the list. */
function fromOldLink(to: Pick<RouteLocationNormalized, 'query'>, page: 'race' | 'live') {
  const { event, discipline } = to.query;
  if (typeof event === 'string' && event && typeof discipline === 'string' && discipline) {
    // A redirect keeps the query unless given another one
    return { ...disciplineRoute(page, event, discipline), query: {} };
  }
  return { path: '/', query: { event: event || undefined, open: page === 'live' ? 'live' : undefined } };
}

export const router = createRouter({
  // The backend serves index.html for every non-API path, so plain URLs work after a reload
  history: createWebHistory(),
  routes: [
    // The order of the routes is the order of the menu
    // The home page: the events and their disciplines, to open the race page (or the live page, ?open=live) on one
    { path: '/', name: 'choice', component: ChoicePage, meta: { page: 'choice', section: 'race' } },
    // The pages of a discipline
    { path: '/:event/:discipline/race', name: 'race', component: RacePage, meta: { page: 'race', section: 'race', selection: true } },
    { path: '/:event/:discipline/live', name: 'live', component: LivePage, meta: { page: 'live', section: 'race', selection: true } },
    {
      // Its tabs: …/config (settings), …/config/participants, …/config/results
      path: '/:event/:discipline/config/:tab(participants|results)?',
      name: 'disciplineConfig',
      component: DisciplineConfigPage,
      meta: { page: 'disciplineConfig', section: 'race', selection: true, adminOnly: true },
    },
    { path: '/:event/:discipline', redirect: (to) => ({ name: 'race', params: to.params }) },
    // Links from before the discipline was in the path
    { path: '/race', redirect: (to) => fromOldLink(to, 'race') },
    { path: '/live', redirect: (to) => fromOldLink(to, 'live') },
    // Its tabs: /config (lines), /config/devices, /config/network, /config/access
    { path: '/config/:tab(devices|network|access)?', name: 'config', component: ConfigPage, meta: { page: 'config', section: 'admin' } },
    { path: '/diagnostics', name: 'diagnostics', component: DiagnosticsPage, meta: { page: 'diagnostics', section: 'admin' } },
    { path: '/:unknown(.*)*', redirect: '/' },
  ],
});

installSelection(router);

// Links to the race page from when it was the home page
router.beforeEach((to) => {
  if (to.path === '/' && to.query.event && to.query.discipline) return fromOldLink(to, 'race');
});

/** Where a page leads while the administration is locked: its discipline's race page, or the home page. Null: open. */
function lockedOut(to: RouteLocationNormalized) {
  if (!adminLocked.value) return null;
  if (to.meta.adminOnly) return { name: 'race', params: to.params };
  return to.meta.section === 'admin' ? { path: '/' } : null;
}

router.beforeEach(async (to) => {
  await checkLock();
  return lockedOut(to) ?? true;
});

// Locking from a page of the administration leaves it
watch(adminLocked, () => {
  const target = lockedOut(router.currentRoute.value);
  if (target) router.push(target);
});

// The browser tab shows the page name, in the current language
watch(
  [router.currentRoute, locale],
  ([route]) => (document.title = route.meta.page ? `${t(`pages.${route.meta.page}`)} · Timing` : 'Timing'),
  { immediate: true },
);
