<script setup lang="ts">
import { useRoute } from 'vue-router';
import NavMenu from './components/nav/NavMenu.vue';
import EventSwitcher from './components/nav/EventSwitcher.vue';
import LockButton from './components/nav/LockButton.vue';
import PageSwitch from './components/nav/PageSwitch.vue';
import { switchesPage, usesSelection } from './selection';

const route = useRoute();
</script>

<template>
  <nav class="nav">
    <NavMenu />
    <EventSwitcher v-if="usesSelection(route)" class="event-title" />
    <div class="tools">
      <PageSwitch v-if="switchesPage(route)" />
      <LockButton />
    </div>
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
/* At the right: the discreet race / live switch, and the padlock of the administration lock */
.tools {
  grid-column: 3;
  grid-row: 1;
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 12px;
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
  .tools {
    grid-column: 1;
  }
}
</style>
