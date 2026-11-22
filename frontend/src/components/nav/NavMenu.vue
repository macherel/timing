<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePopover } from '../../composables/usePopover';
import SyncIndicator from '../SyncIndicator.vue';
import LanguageFlag from './LanguageFlag.vue';
import { LOCALES, locale, setLocale } from '../../i18n';
import { adminLocked } from '../../adminLock';
import { listTarget } from '../../selection';

const SECTIONS = ['race', 'admin'] as const;

const route = useRoute();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const { open, toggle, close } = usePopover(root, button);
// Sync state, shown at the bottom of the menu; a problem also shows a dot on the button
const syncKind = ref<'off' | 'alone' | 'ok' | 'warn'>('off');

// Items of each section. The race section has a single item, the list of the events (the home page), opening the live
// page from the live page. The administration lists its pages, in the order of the routes, and is hidden while locked
const groups = computed(() => {
  const live = route.name === 'live' || (route.path === '/' && listTarget(route) === 'live');
  const race = [{ to: live ? '/?open=live' : '/', page: 'choice', current: route.path === '/' }];
  const admin = router.options.routes
    .filter((r) => r.meta?.section === 'admin' && r.meta.page)
    .map((r) => ({ to: { name: r.name }, page: r.meta!.page!, current: route.name === r.name }));
  return SECTIONS.filter((key) => key !== 'admin' || !adminLocked.value)
    .map((key) => ({ key, items: key === 'race' ? race : admin }))
    .filter((group) => group.items.length > 0);
});

watch(() => route.path, close);

// Arrow keys move between the items of the open menu
async function onMenuKey(event: KeyboardEvent): Promise<void> {
  const items = [...(menu.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
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
      :aria-label="$t('nav.menu')"
      :title="$t('nav.menu')"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="openWithKeyboard"
    >
      <img src="/favicon.svg" class="logo" alt="" />
      <span v-if="syncKind === 'warn'" class="warn-dot" :title="$t('nav.syncProblem')" :aria-label="$t('nav.syncProblemLabel')"></span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <div v-show="open" ref="menu" class="dropdown" role="menu" @keydown="onMenuKey">
      <template v-for="group in groups" :key="group.key">
        <div class="group-label" role="presentation">{{ $t(`nav.sections.${group.key}`) }}</div>
        <RouterLink
          v-for="item in group.items"
          :key="item.page"
          :to="item.to"
          role="menuitem"
          class="item"
          :class="{ current: item.current }"
          :aria-current="item.current ? 'page' : undefined"
        >
          {{ $t(`pages.${item.page}`) }}
        </RouterLink>
      </template>
      <div class="group-label" role="presentation">{{ $t('nav.language') }}</div>
      <div class="languages" role="group" :aria-label="$t('nav.language')">
        <button
          v-for="option in LOCALES"
          :key="option.code"
          type="button"
          role="menuitemradio"
          class="item language"
          :class="{ current: locale === option.code }"
          :aria-checked="locale === option.code"
          :lang="option.code"
          :title="option.name"
          :aria-label="option.name"
          @click="setLocale(option.code)"
        >
          <LanguageFlag :code="option.code" />
        </button>
      </div>
      <div class="group-label" role="presentation">{{ $t('nav.sync') }}</div>
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
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
}
.menu-button:hover,
.menu-button[aria-expanded='true'] {
  background: var(--accent-bg);
}
/* The menu button: the icon of the app */
.logo {
  display: block;
  width: 22px;
  height: 22px;
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
/* Languages side by side, as buttons that look like the menu items */
.languages {
  display: flex;
  gap: 4px;
  padding: 2px 4px;
}
/* Flags: the other languages faded, the current one framed */
.item.language {
  margin: 0;
  padding: 5px 6px;
  background: transparent;
  border: 2px solid transparent;
  cursor: pointer;
  opacity: 0.55;
}
.item.language:hover,
.item.language:focus-visible {
  opacity: 1;
}
.item.language.current {
  opacity: 1;
  border-color: var(--accent);
}
</style>
