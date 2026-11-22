<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineFile } from '../../types';
import FileTable from './FileTable.vue';

/** Results tab of the settings page of a discipline: its results file and their UDA export, to download. */
const props = defineProps<{
  event: string;
  discipline: string;
  files: DisciplineFile[];
}>();

const { t } = useI18n();
const resultFiles = computed(() => props.files.filter((file) => file.kind === 'results' || file.kind === 'uda'));
const label = (file: DisciplineFile) => t(file.kind === 'uda' ? 'files.udaLabel' : 'files.resultsLabel');
const filePath = (name: string) =>
  `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/files/${encodeURIComponent(name)}`;
</script>

<template>
  <section class="result-files">
    <FileTable :files="resultFiles" :path="filePath" :empty="$t('files.noResult')" :label="label" />
  </section>
</template>
