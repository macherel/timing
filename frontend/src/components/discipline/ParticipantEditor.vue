<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EditableParticipant, EditableParticipants, NameField } from '../../types';
import { searchParticipants } from '../../race/participantSearch';

/**
 * The participants of the data tab of the settings page of a discipline, to add, change or remove by hand. Each
 * change rewrites the participant's row in its file (the backend keeps the file's other columns); the results are
 * kept, so a participant with runs keeps their bib and cannot be removed. The name is edited in the name columns of
 * the file: one name, or the first and last names of a UDA export. One participant is edited at a time, in its row
 * (Enter saves, Escape cancels); a new one in a row at the end.
 */
const props = defineProps<{
  event: string;
  discipline: string;
  list: EditableParticipants | null;
}>();
const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();

interface Draft {
  bib: string;
  fields: Record<NameField, string>;
  category: string;
  file: string;
}

const files = computed(() => props.list?.files ?? []);
const query = ref('');
// The bib of the participant being changed, 'new' for one being added, null for none
const editing = ref<string | null>(null);
const draft = ref<Draft>(emptyDraft());
const busy = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);

const participants = computed(() => searchParticipants(props.list?.participants ?? [], query.value, Infinity));
// A discipline without file gets one with a name column at the first participant added
const nameFieldsOf = (file: string): NameField[] => files.value.find((candidate) => candidate.name === file)?.nameFields ?? ['name'];
const draftFields = computed(() => nameFieldsOf(draft.value.file));
const draftTimed = computed(() => editing.value !== 'new' && props.list?.participants.find((p) => p.bib === editing.value)?.timed === true);
const fieldLabel = (field: NameField) => t(`participantEditor.${field}`);

function emptyDraft(): Draft {
  return { bib: '', fields: { name: '', firstName: '', lastName: '' }, category: '', file: files.value[0]?.name ?? '' };
}

function focusForm(): void {
  nextTick(() => root.value?.querySelector<HTMLInputElement>('tr.editing input:not(:disabled)')?.focus());
}

function startAdd(): void {
  draft.value = emptyDraft();
  editing.value = 'new';
  focusForm();
}

function startEdit(participant: EditableParticipant): void {
  draft.value = { bib: participant.bib, fields: { ...participant.fields }, category: participant.category, file: participant.file };
  editing.value = participant.bib;
  focusForm();
}

function stopEditing(): void {
  editing.value = null;
}

const basePath = () => `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/participants`;

/** Sends a change; the message says what was done, or the error why not. */
async function send(method: string, url: string, body: unknown, done: string): Promise<boolean> {
  message.value = null;
  error.value = null;
  busy.value = true;
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const answer = await response.json().catch(() => null);
      throw new Error(answer?.problems?.join(' ') ?? `HTTP ${response.status}`);
    }
    message.value = done;
    emit('changed');
    return true;
  } catch (e) {
    error.value = t('participantEditor.error', { error: e instanceof Error ? e.message : String(e) });
    return false;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  const { bib, fields, category, file } = draft.value;
  const input = { bib: bib.trim(), fields: Object.fromEntries(draftFields.value.map((field) => [field, fields[field]])), category };
  const name = draftFields.value
    .map((field) => fields[field].trim())
    .filter(Boolean)
    .join(' ');
  const saved =
    editing.value === 'new'
      ? await send('POST', basePath(), { ...input, ...(file ? { file } : {}) }, t('participantEditor.added', { bib: input.bib, name }))
      : await send('PUT', `${basePath()}/${encodeURIComponent(editing.value!)}`, input, t('participantEditor.saved', { bib: input.bib, name }));
  if (saved) editing.value = null;
}

async function remove(participant: EditableParticipant): Promise<void> {
  const { bib, name, file } = participant;
  if (!confirm(t('participantEditor.confirmRemove', { bib, name, file }))) return;
  const removed = await send('DELETE', `${basePath()}/${encodeURIComponent(bib)}`, undefined, t('participantEditor.removed', { bib, name }));
  if (removed && editing.value === bib) editing.value = null;
}
</script>

<template>
  <div ref="root" class="participant-editor">
    <p class="muted">{{ $t('participantEditor.hint') }}</p>

    <div class="toolbar">
      <input v-model="query" type="search" class="search" :placeholder="$t('participantEditor.search')" :aria-label="$t('participantEditor.search')" />
      <button type="button" :disabled="busy || editing === 'new'" @click="startAdd">{{ $t('participantEditor.add') }}</button>
    </div>

    <!-- The inputs of the row being edited belong to this form, so Enter saves -->
    <form id="participant-form" @submit.prevent="save" />

    <table v-if="participants.length > 0 || editing === 'new'" class="participants" @keydown.esc="stopEditing">
      <thead>
        <tr>
          <th class="bib">{{ $t('participantEditor.bib') }}</th>
          <th>{{ $t('participantEditor.name') }}</th>
          <th>{{ $t('participantEditor.category') }}</th>
          <th v-if="files.length > 1">{{ $t('participantEditor.file') }}</th>
          <th><span class="visually-hidden">{{ $t('files.actions') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="participant in participants" :key="participant.bib">
          <tr v-if="editing !== participant.bib">
            <td class="bib mono">{{ participant.bib }}</td>
            <td>{{ participant.name }}</td>
            <td class="muted">{{ participant.category }}</td>
            <td v-if="files.length > 1" class="muted mono">{{ participant.file }}</td>
            <td class="actions">
              <button type="button" class="secondary small" :disabled="busy" @click="startEdit(participant)">{{ $t('participantEditor.edit') }}</button>
              <button
                type="button"
                class="danger small"
                :disabled="busy || participant.timed"
                :title="participant.timed ? $t('participantEditor.timed') : undefined"
                @click="remove(participant)"
              >
                {{ $t('participantEditor.remove') }}
              </button>
            </td>
          </tr>
          <tr v-else class="editing">
            <td class="bib">
              <input
                v-model="draft.bib"
                type="text"
                form="participant-form"
                class="mono"
                inputmode="numeric"
                pattern="\d+"
                required
                :disabled="draftTimed"
                :title="draftTimed ? $t('participantEditor.timed') : undefined"
                :aria-label="$t('participantEditor.bib')"
              />
            </td>
            <td>
              <div class="names">
                <input
                  v-for="field in draftFields"
                  :key="field"
                  v-model="draft.fields[field]"
                  type="text"
                  form="participant-form"
                  :placeholder="fieldLabel(field)"
                  :aria-label="fieldLabel(field)"
                />
              </div>
            </td>
            <td>
              <input v-model="draft.category" type="text" form="participant-form" :aria-label="$t('participantEditor.category')" />
            </td>
            <td v-if="files.length > 1" class="muted mono">{{ draft.file }}</td>
            <td class="actions">
              <button type="submit" form="participant-form" class="small" :disabled="busy">{{ $t('common.save') }}</button>
              <button type="button" class="secondary small" :disabled="busy" @click="stopEditing">{{ $t('common.cancel') }}</button>
            </td>
          </tr>
        </template>
        <tr v-if="editing === 'new'" class="editing">
          <td class="bib">
            <input
              v-model="draft.bib"
              type="text"
              form="participant-form"
              class="mono"
              inputmode="numeric"
              pattern="\d+"
              required
              :aria-label="$t('participantEditor.bib')"
            />
          </td>
          <td>
            <div class="names">
              <input
                v-for="field in draftFields"
                :key="field"
                v-model="draft.fields[field]"
                type="text"
                form="participant-form"
                :placeholder="fieldLabel(field)"
                :aria-label="fieldLabel(field)"
              />
            </div>
          </td>
          <td>
            <input v-model="draft.category" type="text" form="participant-form" :aria-label="$t('participantEditor.category')" />
          </td>
          <td v-if="files.length > 1">
            <select v-model="draft.file" form="participant-form" :aria-label="$t('participantEditor.file')">
              <option v-for="file in files" :key="file.name" :value="file.name">{{ file.name }}</option>
            </select>
          </td>
          <td class="actions">
            <button type="submit" form="participant-form" class="small" :disabled="busy">{{ $t('participantEditor.addSave') }}</button>
            <button type="button" class="secondary small" :disabled="busy" @click="stopEditing">{{ $t('common.cancel') }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="query.trim()" class="muted">{{ $t('picker.noMatch', { query: query.trim() }) }}</p>
    <p v-else class="muted">{{ $t('participantEditor.none') }}</p>

    <p v-if="message" class="alert hint" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
}
.toolbar button {
  margin: 0;
}
.search {
  flex: 1;
  min-width: 12em;
}
.participants {
  width: 100%;
}
.bib {
  width: 5em;
  text-align: right;
}
.names {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.names input {
  flex: 1;
  min-width: 8em;
}
td input,
td select {
  margin: 0;
  width: 100%;
  box-sizing: border-box;
}
.bib input {
  text-align: right;
}
.actions {
  text-align: right;
  white-space: nowrap;
}
.actions button {
  margin: 0;
}
.actions button + button {
  margin-left: 8px;
}
button.small {
  padding: 2px 10px;
  font-size: 0.9em;
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
