<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';

/**
 * Tabs of a page, each a link to its URL (switching tabs replaces the history entry, so Back leaves the page). The
 * panels are the page's: each has the id panel-<key> and aria-labelledby tab-<key>, and sits right below, in a .card
 * whose top left corner joins the current tab.
 */
defineProps<{
  tabs: { key: string; label: string; to: RouteLocationRaw; count?: number }[];
  current: string;
  label: string;
}>();
</script>

<template>
  <nav class="tabs" role="tablist" :aria-label="label">
    <RouterLink
      v-for="tab in tabs"
      :id="`tab-${tab.key}`"
      :key="tab.key"
      :to="tab.to"
      replace
      role="tab"
      class="tab"
      :class="{ current: current === tab.key }"
      :aria-selected="current === tab.key"
      :aria-controls="`panel-${tab.key}`"
    >
      {{ tab.label }}
      <span v-if="tab.count" class="count" :aria-label="$t('tabs.problems', { n: tab.count }, tab.count)">{{ tab.count }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* A line of links, the current one joined to the card of its panel below */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: -1px;
  overflow-x: auto;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  color: var(--text-muted);
  text-decoration: none;
  white-space: nowrap;
}
.tab:hover,
.tab:focus-visible {
  color: var(--text-h);
  outline: none;
}
.tab.current {
  color: var(--text-h);
  font-weight: 600;
  background: var(--surface);
  border-color: var(--border);
}
/* Problems found in the panel of a tab */
.count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--error);
  color: var(--bg);
  font-size: 0.75em;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}
</style>
