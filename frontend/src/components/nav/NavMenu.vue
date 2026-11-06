<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePopover } from '../../composables/usePopover';
import SyncIndicator from '../SyncIndicator.vue';

const SECTIONS = [
  { key: 'race', label: 'Race' },
  { key: 'admin', label: 'Administration' },
] as const;

const route = useRoute();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const { open, toggle, close } = usePopover(root, button);
// Sync state, shown at the bottom of the menu; a problem also shows a dot on the button
const syncKind = ref<'off' | 'alone' | 'ok' | 'warn'>('off');

// Pages of each section, in the order of the routes
const groups = computed(() =>
  SECTIONS.map((section) => ({
    ...section,
    pages: router.options.routes.filter((r) => r.meta?.section === section.key && r.meta.title),
  })).filter((group) => group.pages.length > 0),
);
const currentSection = computed(() => SECTIONS.find((s) => s.key === route.meta.section)?.label);

watch(() => route.path, close);

// Arrow keys move between the items of the open menu
async function onMenuKey(event: KeyboardEvent): Promise<void> {
  const items = [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
  if (target === undefined || items.length === 0) return;
  event.preventDefault();
  items[(target + items.length) % items.length].focus();
}

async function openWithKeyboard(): Promise<void> {
  open.value = true;
  await nextTick();
  menu.value?.querySelector<HTMLElement>('[aria-current="page"], [role="menuitem"]')?.focus();
}
</script>

<template>
  <div ref="root" class="nav-menu">
    <button
      ref="button"
      type="button"
      class="menu-button"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="openWithKeyboard"
    >
      <span class="brand">Timing</span>
      <span v-if="currentSection === 'Administration'" class="section">Administration ·</span>
      <span class="page-name">{{ route.meta.title }}</span>
      <span v-if="syncKind === 'warn'" class="warn-dot" title="Sync problem: open the menu for details" aria-label="Sync problem"></span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <div v-show="open" ref="menu" class="dropdown" role="menu" @keydown="onMenuKey">
      <template v-for="group in groups" :key="group.key">
        <div class="group-label" role="presentation">{{ group.label }}</div>
        <RouterLink
          v-for="page in group.pages"
          :key="page.path"
          :to="page.path"
          role="menuitem"
          class="item"
          :class="{ current: route.path === page.path }"
          :aria-current="route.path === page.path ? 'page' : undefined"
        >
          {{ page.meta?.title }}
        </RouterLink>
      </template>
      <div class="group-label" role="presentation">Sync</div>
      <SyncIndicator class="sync-state" @kind="syncKind = $event" />
    </div>
  </div>
</template>

<style scoped>
.nav-menu {
  position: relative;
}
.menu-button {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
}
.menu-button:hover,
.menu-button[aria-expanded='true'] {
  background: var(--accent-bg);
}
/* The menu button is the page title: "Timing  Race ▾" */
.brand {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--text-muted);
}
.section {
  font-size: 0.85em;
  color: var(--text-muted);
}
.page-name {
  font-size: 1.35em;
  font-weight: 700;
  color: var(--text-h);
}
.warn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  align-self: center;
}
.sync-state {
  padding: 2px 10px 6px;
}
.caret {
  font-size: 0.8em;
  color: var(--text-muted);
}
.dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 220px;
  max-width: min(340px, calc(100vw - 32px));
  padding: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.group-label {
  padding: 8px 10px 4px;
  font-size: 0.75em;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.group-label:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--border);
}
.item {
  display: block;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
}
.item:hover,
.item:focus-visible {
  background: var(--accent-bg);
  outline: none;
}
.item.current {
  color: var(--accent);
  font-weight: 600;
}
</style>
