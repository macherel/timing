<script setup lang="ts">
import { useRoute } from 'vue-router';
import NavMenu from './components/nav/NavMenu.vue';
import EventSwitcher from './components/nav/EventSwitcher.vue';
import LockButton from './components/nav/LockButton.vue';
import { usesSelection } from './selection';

const route = useRoute();
</script>

<template>
  <nav class="nav">
    <NavMenu />
    <EventSwitcher v-if="usesSelection(route)" class="event-title" />
    <LockButton class="lock" />
  </nav>
  <RouterView />
</template>

<style scoped>
/* Page menu on the left; on race pages, the event and discipline in the middle as the title */
.nav {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px 12px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.event-title {
  grid-column: 2;
}
/* Discreet padlock of the administration lock, at the right */
.lock {
  grid-column: 3;
  grid-row: 1;
  justify-self: end;
}
/* Narrow screens: the title on its own line, under the menu */
@media (max-width: 720px) {
  .nav {
    grid-template-columns: 1fr;
    justify-items: start;
  }
  .event-title {
    grid-column: 1;
    justify-self: center;
  }
  .lock {
    grid-column: 1;
  }
}
</style>
