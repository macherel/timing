<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import DisciplineSettingsForm from '../components/nav/DisciplineSettingsForm.vue';
import { discipline, disciplineExists, eventName, eventsLoaded, leaveSettings, loadEvents } from '../selection';

/**
 * The settings of a discipline (/<event>/<discipline>/config): attempts, period, access, best time, precision. Hidden
 * while the administration is locked. Saving or cancelling goes back to the page of the discipline it came from, as
 * the gear beside the title does; leaving another way with unsaved changes asks first.
 */
const { t } = useI18n();
const form = ref<InstanceType<typeof DisciplineSettingsForm> | null>(null);
// Cancel leaves without asking: the changes are dropped on purpose
let discarding = false;

const mayLeave = () => discarding || !form.value?.dirty || confirm(t('config.confirmLeave'));
onBeforeRouteLeave(mayLeave);
// Another discipline chosen in the title menu
onBeforeRouteUpdate(mayLeave);

function onDone(): void {
  discarding = true;
  leaveSettings();
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (form.value?.dirty) event.preventDefault();
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload));

if (!eventsLoaded.value) loadEvents();
</script>

<template>
  <main class="page settings-page">
    <h2>{{ $t('switcher.settingsOf', { event: eventName, discipline }) }}</h2>
    <div v-if="eventsLoaded && !disciplineExists" class="alert hint choose">
      <span>{{ $t('race.chooseEventAndDiscipline') }}</span>
      <RouterLink to="/" class="button">{{ $t('common.choose') }}</RouterLink>
    </div>
    <section v-else-if="disciplineExists" class="card">
      <DisciplineSettingsForm
        ref="form"
        :key="`${eventName}\n${discipline}`"
        :event="eventName"
        :discipline="discipline"
        @done="onDone"
      />
    </section>
  </main>
</template>

<style scoped>
.settings-page {
  max-width: 560px;
}
.choose {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
