import { createRouter, createWebHistory } from 'vue-router';
import ConfigPage from './pages/ConfigPage.vue';
import DiagnosticsPage from './pages/DiagnosticsPage.vue';

export const router = createRouter({
  // The backend serves index.html for every non-API path, so plain URLs work after a reload
  history: createWebHistory(),
  routes: [
    // No race page yet: the app opens on the diagnostics
    { path: '/', redirect: '/diagnostics' },
    { path: '/diagnostics', component: DiagnosticsPage, meta: { title: 'Diagnostics' } },
    { path: '/config', component: ConfigPage, meta: { title: 'Configuration' } },
    { path: '/:unknown(.*)*', redirect: '/' },
  ],
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Timing` : 'Timing';
});
