import { createRouter, createWebHistory } from 'vue-router';
import ConfigPage from './pages/ConfigPage.vue';
import DiagnosticsPage from './pages/DiagnosticsPage.vue';
import RacePage from './pages/RacePage.vue';
import LivePage from './pages/LivePage.vue';
import { installSelection } from './selection';
import { adminLocked, checkLock } from './adminLock';
import { locale, t } from './i18n';
import { watch } from 'vue';

declare module 'vue-router' {
  interface RouteMeta {
    // Key of the page name in the texts (pages.<page>), shown in the menu and the browser tab
    page?: 'race' | 'live' | 'diagnostics' | 'config';
    // Menu group: race pages work on the selected event and discipline, administration pages on the computer
    section?: 'race' | 'admin';
  }
}

export const router = createRouter({
  // The backend serves index.html for every non-API path, so plain URLs work after a reload
  history: createWebHistory(),
  routes: [
    // The order of the routes is the order of the menu
    { path: '/', component: RacePage, meta: { page: 'race', section: 'race' } },
    { path: '/live', component: LivePage, meta: { page: 'live', section: 'race' } },
    { path: '/diagnostics', component: DiagnosticsPage, meta: { page: 'diagnostics', section: 'admin' } },
    { path: '/config', component: ConfigPage, meta: { page: 'config', section: 'admin' } },
    { path: '/:unknown(.*)*', redirect: '/' },
  ],
});

installSelection(router);

// While the administration is locked, its pages lead to the race page
router.beforeEach(async (to) => {
  await checkLock();
  if (to.meta.section === 'admin' && adminLocked.value) return { path: '/' };
});

// Locking from an administration page leaves it
watch(adminLocked, (locked) => {
  if (locked && router.currentRoute.value.meta.section === 'admin') router.push('/');
});

// The browser tab shows the page name, in the current language
watch(
  [router.currentRoute, locale],
  ([route]) => (document.title = route.meta.page ? `${t(`pages.${route.meta.page}`)} · Timing` : 'Timing'),
  { immediate: true },
);
