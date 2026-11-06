<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DisciplineSettings } from '../../types';
import { fromLocalInput, toLocalInput } from '../../race/dateTime';

/**
 * Edits a discipline's config.yaml: attempts, period and access. Loads the settings itself; the race pages get the
 * saved ones through the SETTINGS_UPDATE message.
 */
const props = defineProps<{ event: string; discipline: string }>();
const emit = defineEmits<{ done: [] }>();

const ACCESS_OPTIONS: { value: DisciplineSettings['access']; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Open during the period above' },
  { value: 'open', label: 'Open', hint: 'Always open, ignores the period (e.g. to correct a result)' },
  { value: 'locked', label: 'Locked', hint: 'Never open: results are final' },
];

// The attempts as typed, empty for unlimited (Vue gives a number input's value as a number)
const attemptsInput = ref<string | number>('');
// Local YYYY-MM-DDTHH:MM from the datetime inputs, empty for no limit
const startInput = ref('');
const endInput = ref('');
const accessInput = ref<DisciplineSettings['access']>('auto');
const loaded = ref(false);
const error = ref<string | null>(null);
const saving = ref(false);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function request(init?: RequestInit): Promise<{ settings: DisciplineSettings }> {
  const path = `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/settings`;
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.problems?.join(' ') ?? `HTTP ${response.status}`);
  return body;
}

onMounted(async () => {
  try {
    const { settings } = await request();
    attemptsInput.value = settings.attempts === null ? '' : String(settings.attempts);
    startInput.value = toLocalInput(settings.start);
    endInput.value = toLocalInput(settings.end);
    accessInput.value = settings.access;
    loaded.value = true;
  } catch (e) {
    error.value = `Cannot load the settings: ${errorText(e)}`;
  }
});

async function save(): Promise<void> {
  const text = String(attemptsInput.value ?? '').trim();
  const attempts = text === '' ? null : Number(text);
  if (attempts !== null && !(Number.isInteger(attempts) && attempts >= 1)) {
    error.value = 'Attempts must be a whole number from 1, or empty for unlimited.';
    return;
  }
  if (startInput.value && endInput.value && startInput.value >= endInput.value) {
    error.value = 'The start must be before the end.';
    return;
  }
  saving.value = true;
  try {
    await request({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: { attempts, start: fromLocalInput(startInput.value), end: fromLocalInput(endInput.value), access: accessInput.value },
      }),
    });
    emit('done');
  } catch (e) {
    error.value = `Cannot save the settings: ${errorText(e)}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="settings" @submit.prevent="save">
    <template v-if="loaded">
      <label class="field">
        Attempts per participant
        <input v-model="attemptsInput" type="number" min="1" step="1" placeholder="Unlimited" class="attempts" />
      </label>
      <p class="muted small">Invalid runs do not use up an attempt. Leave empty for unlimited attempts.</p>
      <div class="period">
        <label class="field">
          Start
          <input v-model="startInput" type="datetime-local" :max="endInput || undefined" />
        </label>
        <label class="field">
          End
          <input v-model="endInput" type="datetime-local" :min="startInput || undefined" />
        </label>
      </div>
      <p class="muted small">
        Runs can be timed and results changed only from the start until the end (this computer's time, saved in UTC).
        Leave empty for no limit.
      </p>
      <fieldset class="access">
        <legend>Runs and result changes</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in ACCESS_OPTIONS" :key="option.value" :class="[option.value, { checked: accessInput === option.value }]" :title="option.hint">
            <input v-model="accessInput" type="radio" name="access" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
        <p class="muted small">{{ ACCESS_OPTIONS.find((option) => option.value === accessInput)?.hint }}</p>
      </fieldset>
    </template>
    <p v-else-if="!error" class="muted small">Loading…</p>
    <p v-if="error" class="alert error">{{ error }}</p>
    <div class="actions">
      <button type="submit" :disabled="saving || !loaded">Save</button>
      <button type="button" class="secondary" @click="emit('done')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.access {
  margin: 12px 0 0;
  padding: 0;
  border: none;
}
.access legend {
  font-size: 0.85em;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.segmented label {
  padding: 5px 14px;
  cursor: pointer;
  color: var(--text);
  border-left: 1px solid var(--border);
}
.segmented label:first-child {
  border-left: none;
}
.segmented input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.segmented label:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.segmented label.checked {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}
.segmented label.open.checked {
  background: var(--ok-bg);
  color: var(--ok);
}
.segmented label.locked.checked {
  background: var(--error-bg);
  color: var(--error);
}
.period {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.settings input[type='datetime-local'] {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-h);
}
.settings .attempts {
  font: inherit;
  width: 8em;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-h);
}
.settings .actions {
  display: flex;
  gap: 8px;
}
.small {
  font-size: 0.85em;
  margin-top: 6px;
}
</style>
