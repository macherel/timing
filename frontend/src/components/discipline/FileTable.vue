<script setup lang="ts">
import type { DisciplineFile } from '../../types';
import { showDateTime } from '../../race/dateTime';

/**
 * Files of a discipline as a table: name, label, last change, size, and a download link, then the actions given in the
 * `actions` slot.
 */
defineProps<{
  files: DisciplineFile[];
  // URL of a file of the discipline
  path: (name: string) => string;
  // Shown when there is no file
  empty: string;
  // Text shown under the name of a file, e.g. what it holds
  label?: (file: DisciplineFile) => string;
}>();

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <p v-if="files.length === 0" class="muted">{{ empty }}</p>
  <table v-else class="files">
    <thead>
      <tr>
        <th>{{ $t('files.name') }}</th>
        <th>{{ $t('files.modified') }}</th>
        <th class="size">{{ $t('files.size') }}</th>
        <th><span class="visually-hidden">{{ $t('files.actions') }}</span></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="file in files" :key="file.name">
        <td>
          <span class="mono">{{ file.name }}</span>
          <span v-if="label" class="muted small label">{{ label(file) }}</span>
        </td>
        <td>{{ showDateTime(file.modified) }}</td>
        <td class="size">{{ size(file.size) }}</td>
        <td class="actions">
          <a :href="path(file.name)" :download="file.name" class="download">{{ $t('files.download') }}</a>
          <slot name="actions" :file="file" />
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.files {
  width: 100%;
}
.label {
  display: block;
}
.small {
  font-size: 0.85em;
}
.size {
  text-align: right;
  white-space: nowrap;
}
.actions {
  text-align: right;
  white-space: nowrap;
}
.actions > * + * {
  margin-left: 12px;
}
.download {
  color: var(--accent);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
