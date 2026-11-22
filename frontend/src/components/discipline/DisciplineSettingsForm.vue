<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings } from '../../types';
import { fromLocalInput, toLocalInput } from '../../race/dateTime';
import { DECIMALS, formatDuration } from '../../format';

/**
 * Edits a discipline's config.yaml: attempts, best time, precision and rounding of the times, period, access and the number
 * of last runs of the line shown. Loads the settings itself; the race pages get the
 * saved ones through the SETTINGS_UPDATE message. Tells whether it has unsaved changes (dirty).
 */
const props = defineProps<{ event: string; discipline: string }>();
const emit = defineEmits<{ done: [] }>();

const { t } = useI18n();

const ACCESS_OPTIONS = computed(() =>
  (['auto', 'open', 'locked'] as const).map((value) => ({
    value,
    label: t(`settings.access.${value}`),
    hint: t(`settings.access.${value}Hint`),
  })),
);

const BEST_OPTIONS = computed(() =>
  (['shortest', 'longest'] as const).map((value) => ({
    value,
    label: t(`settings.best.${value}`),
    hint: t(`settings.best.${value}Hint`),
  })),
);

const PRECISION_OPTIONS = computed(() =>
  (['second', 'tenth', 'hundredth', 'thousandth'] as const).map((value) => ({ value, label: t(`settings.precision.${value}`) })),
);

const ROUNDING_OPTIONS = computed(() =>
  (['truncate', 'nearest', 'up'] as const).map((value) => ({
    value,
    label: t(`settings.rounding.${value}`),
    hint: t(`settings.rounding.${value}Hint`),
  })),
);

// What the chosen precision and rounding make of a measured time (same rule as the backend), in tenths of a millisecond
const EXACT_TIME = 123_456; // 12.3456 s
const UNIT: Record<DisciplineSettings['precision'], number> = { second: 10_000, tenth: 1_000, hundredth: 100, thousandth: 10 };
const timeExample = computed(() => {
  const unit = UNIT[precisionInput.value];
  const round = { truncate: Math.floor, nearest: Math.round, up: Math.ceil }[roundingInput.value];
  const time = formatDuration((round(EXACT_TIME / unit) * unit) / 10, DECIMALS[precisionInput.value]);
  return t('settings.timeExample', { exact: '12.3456', time });
});

// The attempts as typed, empty for unlimited (Vue gives a number input's value as a number)
const attemptsInput = ref<string | number>('');
// Local YYYY-MM-DDTHH:MM from the datetime inputs, empty for no limit
const startInput = ref('');
const endInput = ref('');
const accessInput = ref<DisciplineSettings['access']>('auto');
const bestInput = ref<DisciplineSettings['best']>('shortest');
const precisionInput = ref<DisciplineSettings['precision']>('hundredth');
const roundingInput = ref<DisciplineSettings['rounding']>('up');
const recentRunsInput = ref<string | number>(3);
const loaded = ref(false);
const error = ref<string | null>(null);
const saving = ref(false);

// The fields as loaded or last saved, to tell whether they were changed since
const fields = () =>
  JSON.stringify([
    String(attemptsInput.value ?? '').trim(),
    startInput.value,
    endInput.value,
    accessInput.value,
    bestInput.value,
    precisionInput.value,
    roundingInput.value,
    String(recentRunsInput.value ?? '').trim(),
  ]);
const savedFields = ref('');
/** Whether the form has changes not saved yet. */
const dirty = computed(() => loaded.value && fields() !== savedFields.value);
defineExpose({ dirty });

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
    bestInput.value = settings.best;
    precisionInput.value = settings.precision;
    roundingInput.value = settings.rounding;
    recentRunsInput.value = settings.recentRuns;
    savedFields.value = fields();
    loaded.value = true;
  } catch (e) {
    error.value = t('settings.loadError', { error: errorText(e) });
  }
});

async function save(): Promise<void> {
  const text = String(attemptsInput.value ?? '').trim();
  const attempts = text === '' ? null : Number(text);
  if (attempts !== null && !(Number.isInteger(attempts) && attempts >= 1)) {
    error.value = t('settings.attemptsInvalid');
    return;
  }
  const recentRuns = Number(String(recentRunsInput.value ?? '').trim() || 3);
  if (!(Number.isInteger(recentRuns) && recentRuns >= 0)) {
    error.value = t('settings.recentRunsInvalid');
    return;
  }
  if (startInput.value && endInput.value && startInput.value >= endInput.value) {
    error.value = t('settings.startAfterEnd');
    return;
  }
  saving.value = true;
  try {
    await request({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          attempts,
          start: fromLocalInput(startInput.value),
          end: fromLocalInput(endInput.value),
          access: accessInput.value,
          best: bestInput.value,
          precision: precisionInput.value,
          rounding: roundingInput.value,
          recentRuns,
        },
      }),
    });
    savedFields.value = fields();
    emit('done');
  } catch (e) {
    error.value = t('settings.saveError', { error: errorText(e) });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="settings" @submit.prevent="save">
    <template v-if="loaded">
      <label class="field">
        {{ $t('settings.attempts') }}
        <input v-model="attemptsInput" type="number" min="1" step="1" :placeholder="$t('settings.unlimited')" class="attempts" />
      </label>
      <p class="muted small">{{ $t('settings.attemptsHint') }}</p>
      <label class="field">
        {{ $t('settings.recentRuns') }}
        <input v-model="recentRunsInput" type="number" min="0" step="1" placeholder="3" class="attempts" data-testid="recent-runs-input" />
      </label>
      <p class="muted small">{{ $t('settings.recentRunsHint') }}</p>
      <fieldset class="choice">
        <legend>{{ $t('settings.best.legend') }}</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in BEST_OPTIONS" :key="option.value" :class="{ checked: bestInput === option.value }" :title="option.hint">
            <input v-model="bestInput" type="radio" name="best" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
        <p class="muted small">{{ BEST_OPTIONS.find((option) => option.value === bestInput)?.hint }}</p>
      </fieldset>
      <fieldset class="choice">
        <legend>{{ $t('settings.precision.legend') }}</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in PRECISION_OPTIONS" :key="option.value" :class="{ checked: precisionInput === option.value }">
            <input v-model="precisionInput" type="radio" name="precision" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
      </fieldset>
      <fieldset class="choice">
        <legend>{{ $t('settings.rounding.legend') }}</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in ROUNDING_OPTIONS" :key="option.value" :class="{ checked: roundingInput === option.value }" :title="option.hint">
            <input v-model="roundingInput" type="radio" name="rounding" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
        <p class="muted small">
          {{ ROUNDING_OPTIONS.find((option) => option.value === roundingInput)?.hint }}. {{ timeExample }}
        </p>
      </fieldset>
      <div class="period">
        <label class="field">
          {{ $t('settings.start') }}
          <input v-model="startInput" type="datetime-local" :max="endInput || undefined" />
        </label>
        <label class="field">
          {{ $t('settings.end') }}
          <input v-model="endInput" type="datetime-local" :min="startInput || undefined" />
        </label>
      </div>
      <p class="muted small">{{ $t('settings.periodHint') }}</p>
      <fieldset class="choice">
        <legend>{{ $t('settings.accessLegend') }}</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="option in ACCESS_OPTIONS" :key="option.value" :class="[option.value, { checked: accessInput === option.value }]" :title="option.hint">
            <input v-model="accessInput" type="radio" name="access" :value="option.value" />
            {{ option.label }}
          </label>
        </div>
        <p class="muted small">{{ ACCESS_OPTIONS.find((option) => option.value === accessInput)?.hint }}</p>
      </fieldset>
    </template>
    <p v-else-if="!error" class="muted small">{{ $t('common.loading') }}</p>
    <p v-if="error" class="alert error">{{ error }}</p>
    <div class="actions">
      <button type="submit" :disabled="saving || !loaded">{{ $t('common.save') }}</button>
      <button type="button" class="secondary" @click="emit('done')">{{ $t('common.cancel') }}</button>
    </div>
  </form>
</template>

<style scoped>
.choice {
  margin: 12px 0 0;
  padding: 0;
  border: none;
}
.choice legend {
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
