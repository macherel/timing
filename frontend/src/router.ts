import { createRouter, createWebHistory } from 'vue-router';
import ConfigPage from './pages/ConfigPage.vue';
import DiagnosticsPage from './pages/DiagnosticsPage.vue';
import RacePage from './pages/RacePage.vue';
import LivePage from './pages/LivePage.vue';
import { installSelection } from './selection';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    // Menu group: race pages work on the selected event and discipline, administration pages on the computer
    section?: 'race' | 'admin';
  }
}

export const router = createRouter({
  // The backend serves index.html for every non-API path, so plain URLs work after a reload
  history: createWebHistory(),
  routes: [
    // The order of the routes is the order of the menu
    { path: '/', component: RacePage, meta: { title: 'Race', section: 'race' } },
    { path: '/live', component: LivePage, meta: { title: 'Live', section: 'race' } },
    { path: '/diagnostics', component: DiagnosticsPage, meta: { title: 'Diagnostics', section: 'admin' } },
    { path: '/config', component: ConfigPage, meta: { title: 'Hardware configuration', section: 'admin' } },
    { path: '/:unknown(.*)*', redirect: '/' },
  ],
});

installSelection(router);

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Timing` : 'Timing';
});
