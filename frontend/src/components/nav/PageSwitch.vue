<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import { useRoute } from 'vue-router';
import { listTarget } from '../../selection';

/**
 * Discreet race / live toggle of the navigation bar, as two small icons (a stopwatch, a broadcast), named by their
 * tooltip. On a race page, goes to the other page on the same event and
 * discipline; on the home page, chooses which of them a click in the list of the events opens.
 */
const PAGES = ['race', 'live'] as const;

const route = useRoute();
const onList = () => route.path === '/';

const linkTo = (page: (typeof PAGES)[number]): RouteLocationRaw =>
  onList()
    ? { path: '/', query: { ...route.query, open: page === 'live' ? 'live' : undefined } }
    : { name: page, params: route.params };
const isCurrent = (page: string) => (onList() ? listTarget(route) : route.name) === page;
</script>

<template>
  <nav class="page-switch" :aria-label="$t('nav.pageSwitch')">
    <RouterLink
      v-for="page in PAGES"
      :key="page"
      :to="linkTo(page)"
      :replace="onList()"
      class="option"
      :class="{ current: isCurrent(page) }"
      :aria-current="isCurrent(page) ? 'true' : undefined"
      :title="$t(`pages.${page}`)"
      :aria-label="$t(`pages.${page}`)"
    >
      <svg v-if="page === 'race'" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="13.5" r="7.5" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M12 13.5V9.5M10 3h4M18.5 6.5l1.5-1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="12" r="2.2" fill="currentColor" />
        <path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* A small pill, the current page's icon in a lighter knob */
.page-switch {
  display: inline-flex;
  padding: 2px;
  border-radius: 999px;
  background: var(--code-bg);
}
.option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 20px;
  border-radius: 999px;
  color: var(--text-muted);
  opacity: 0.7;
}
.option:hover,
.option:focus-visible {
  opacity: 1;
  outline: none;
}
.option.current {
  color: var(--text-h);
  background: var(--bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  opacity: 1;
}
</style>
