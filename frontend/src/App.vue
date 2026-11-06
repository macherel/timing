<script setup lang="ts">
import SyncIndicator from './components/SyncIndicator.vue';
</script>

<template>
  <nav class="nav">
    <span class="brand">Timing</span>
    <RouterLink to="/">Race</RouterLink>
    <RouterLink to="/diagnostics">Diagnostics</RouterLink>
    <RouterLink to="/config">Configuration</RouterLink>
    <SyncIndicator class="sync-indicator" />
  </nav>
  <RouterView />
</template>

<style scoped>
.sync-indicator {
  margin-left: auto;
}
.nav {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-wrap: wrap;
}
.brand {
  font-weight: 600;
  color: var(--text-h);
  margin-right: 16px;
}
.nav a {
  color: var(--text);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: 6px;
}
.nav a:hover {
  background: var(--accent-bg);
}
.nav a.router-link-active {
  color: var(--accent);
  background: var(--accent-bg);
  font-weight: 600;
}
</style>
