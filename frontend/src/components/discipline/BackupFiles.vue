<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Backup, DisciplineFile } from '../../types';
import { showDateTime } from '../../race/dateTime';
import FileTable from './FileTable.vue';

/**
 * Backups of the results of a discipline, newest first: made each time its participants changed, each with its results
 * file, their UDA export and the participant files they were timed for, to download. Each one folds out, folded at first.
 */
const props = defineProps<{
  event: string;
  discipline: string;
  backups: Backup[];
}>();

const { t } = useI18n();
const LABELS: Partial<Record<DisciplineFile['kind'], string>> = { results: 'files.resultsLabel', uda: 'files.udaLabel' };
const label = (file: DisciplineFile) => t(LABELS[file.kind] ?? 'files.backupParticipantsLabel');
const filePath = (backup: string) => (name: string) =>
  `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/backups/${encodeURIComponent(backup)}/${encodeURIComponent(name)}`;
</script>

<template>
  <section class="backup-files">
    <p class="muted">{{ $t('files.backupsHint') }}</p>
    <p v-if="backups.length === 0" class="muted">{{ $t('files.noBackup') }}</p>
    <details v-for="backup in backups" :key="backup.name" class="backup">
      <summary>{{ $t('files.backupOf', { date: backup.date ? showDateTime(backup.date) : backup.name }) }}</summary>
      <FileTable :files="backup.files" :path="filePath(backup.name)" :empty="$t('files.noBackupFile')" :label="label" />
    </details>
  </section>
</template>

<style scoped>
.backup + .backup {
  margin-top: 8px;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.backup[open] summary {
  margin-bottom: 4px;
}
</style>
