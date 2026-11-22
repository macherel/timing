<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineFile } from '../../types';
import FileTable from './FileTable.vue';

/**
 * Participants of the data tab of the settings page of a discipline: its participant CSV files, to download or replace, with the
 * number of participants and the problems found in the files. A discipline without one gets its file here, saved as
 * <event>-<discipline>-competitors.csv; one with files only has them replaced (the backend refuses another). New participants reset the
 * results (the backend saves them first): asked for confirmation when the discipline has results.
 */
const props = defineProps<{
  event: string;
  discipline: string;
  files: DisciplineFile[];
  count: number | null;
  problems: string[];
}>();
const emit = defineEmits<{ changed: [] }>();

// Same limit and name as the backend
const MAX_BYTES = 5 * 1024 * 1024;
const competitorsFile = computed(() => `${props.event}-${props.discipline}-competitors.csv`);

const { t } = useI18n();
const participantFiles = computed(() => props.files.filter((file) => file.kind === 'participants'));
const hasResults = computed(() => props.files.some((file) => file.kind === 'results'));
const busy = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);
const addInput = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);
// The file that "Replace" writes over
const replacing = ref('');

const filePath = (name: string) =>
  `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/files/${encodeURIComponent(name)}`;

/** Sends a file; the message says what was done, or the error why not. */
async function upload(file: File, name: string): Promise<void> {
  if (file.size > MAX_BYTES) {
    error.value = t('files.tooLarge', { name: file.name });
    return;
  }
  const response = await fetch(filePath(name), { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: file });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.problems?.join(' ') ?? `HTTP ${response.status}`);
  message.value = t(body.created ? 'files.added' : 'files.replaced', { name: body.name });
}

async function send(file: File, name: string): Promise<void> {
  if (hasResults.value && !confirm(t('files.confirmReset'))) return;
  message.value = null;
  error.value = null;
  busy.value = true;
  try {
    await upload(file, name);
  } catch (e) {
    error.value = t('files.uploadError', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
    emit('changed');
  }
}

// The first participant file, whatever its name
function onAdd(event: Event): void {
  const input = event.target as HTMLInputElement;
  const [file] = input.files ?? [];
  input.value = '';
  if (file) send(file, competitorsFile.value);
}

function startReplace(name: string): void {
  replacing.value = name;
  replaceInput.value?.click();
}

function onReplace(event: Event): void {
  const input = event.target as HTMLInputElement;
  const [file] = input.files ?? [];
  input.value = '';
  if (file) send(file, replacing.value);
}
</script>

<template>
  <section class="participant-files">
    <p class="muted">
      {{ $t('files.participantsHint') }}
      <template v-if="count !== null"> {{ $t('files.count', { n: count }, count) }}</template>
    </p>

    <FileTable :files="participantFiles" :path="filePath" :empty="$t('files.noParticipantFile', { name: competitorsFile })">
      <template #actions="{ file }">
        <button type="button" class="secondary small" :disabled="busy" @click="startReplace(file.name)">
          {{ $t('files.replace') }}
        </button>
      </template>
    </FileTable>

    <div v-if="participantFiles.length === 0" class="add">
      <button type="button" :disabled="busy" @click="addInput?.click()">{{ $t('files.add') }}</button>
      <input ref="addInput" type="file" accept=".csv,text/csv" hidden data-testid="add-participant-file" @change="onAdd" />
    </div>
    <input ref="replaceInput" type="file" accept=".csv,text/csv" hidden data-testid="replace-participant-file" @change="onReplace" />

    <p v-if="message" class="alert hint" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <details v-if="problems.length > 0" class="alert warn">
      <summary>{{ $t('race.problems', { discipline }, problems.length) }}</summary>
      <ul>
        <li v-for="problem in problems" :key="problem">{{ problem }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.add {
  margin-top: 12px;
}
.add button {
  margin: 0;
}
button.small {
  margin: 0;
  padding: 2px 10px;
  font-size: 0.9em;
}
details ul {
  margin: 8px 0 0;
  padding-left: 24px;
}
</style>
