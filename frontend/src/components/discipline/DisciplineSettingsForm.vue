<script lang="ts">
/** The sections of the settings, each on its tab of the settings page. */
export type SettingsSection = 'basic' | 'advanced' | 'lock' | 'export';
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, UdaColumn } from '../../types';
import { fromLocalInput, toLocalInput } from '../../race/dateTime';
import { DECIMALS, formatDuration } from '../../format';
import { canTrigger, keyLabel } from '../../race/keys';
import UdaExportSettings from './UdaExportSettings.vue';
import { defaultColumns, defaultExport, exportOf, isDefault, loadUdaFormats, type UdaExport } from '../../udaColumns';

/**
 * Edits a discipline's config.yaml, in three sections shown one at a time (the tabs of the settings page) and saved
 * together:
 * - basic: what a run measures (a time or a distance), for a distance the minimum distance, attempts (and for a
 *   distance, per distance), best time and what triggers the runs (gates, or a key
 *   for a discipline timed by hand), the last two for a time only;
 * - advanced: precision and rounding of the times (a distance is in centimetres), and the number of last runs of the
 *   line shown;
 * - lock: period and access;
 * - export: the columns of the UDA export, its separator and the order of its lines, with a preview.
 * Loads the settings itself; the race pages get the saved ones through the SETTINGS_UPDATE message. Tells whether it
 * has unsaved changes (dirty).
 */
const props = defineProps<{ event: string; discipline: string; section: SettingsSection }>();
const emit = defineEmits<{ done: []; showSection: [section: SettingsSection] }>();

const { t } = useI18n();

const MEASURE_OPTIONS = computed(() =>
  (['time', 'distance'] as const).map((value) => ({
    value,
    label: t(`settings.measure.${value}`),
    hint: t(`settings.measure.${value}Hint`),
  })),
);

const TRIGGER_OPTIONS = computed(() =>
  (['gates', 'keyboard'] as const).map((value) => ({
    value,
    label: t(`settings.trigger.${value}`),
    hint: t(`settings.trigger.${value}Hint`),
  })),
);

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

const measureInput = ref<NonNullable<DisciplineSettings['measure']>>('time');
// For a distance, the attempts at one same distance as typed, empty for unlimited
const attemptsPerDistanceInput = ref<string | number>('');
// For a distance, the minimum distance in centimetres as typed, empty for none
const minDistanceInput = ref<string | number>('');
// For a distance, whether a participant can change distance before validating the last one they tried
const allowDistanceChangeInput = ref(false);
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
const resultRowsInput = ref<string | number>(5);
const triggerInput = ref<DisciplineSettings['trigger']>('gates');
// The UDA export: its columns (those of the UDA format until changed), the separator and the order
const udaHeaderInput = ref(false);
const udaColumnsInput = ref<UdaColumn[]>(defaultColumns('time'));
const udaSeparatorInput = ref(',');
const udaSortInput = ref('bib');
/** Sets the UDA export settings being edited. */
function setExport(format: UdaExport): void {
  udaHeaderInput.value = format.header;
  udaColumnsInput.value = format.columns;
  udaSeparatorInput.value = format.separator;
  udaSortInput.value = format.sort;
}

/**
 * Another measure chosen: the UDA export takes the format of the last discipline saved that measures it (another one),
 * or the UDA format when there is none.
 */
async function onMeasureChange(): Promise<void> {
  const measure = measureInput.value;
  let format: UdaExport = defaultExport(measure);
  try {
    const last = (await loadUdaFormats()).find((other) => other.measure === measure && !(other.event === props.event && other.discipline === props.discipline));
    if (last) format = exportOf(last, measure);
  } catch {
    // The UDA format, then
  }
  // Unless the measure changed again meanwhile
  if (measureInput.value === measure) setExport(format);
}
// The attempts as typed, as the preview of the export counts them (null: unlimited or not a valid number)
const attemptsValue = computed(() => {
  const value = Number(String(attemptsInput.value ?? '').trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
});
// The trigger key as its KeyboardEvent.code, and what it typed when it was chosen here (its name on this keyboard)
const triggerKeyInput = ref('Space');
const triggerKeyTyped = ref<string | undefined>(undefined);
const triggerKeyName = computed(() => keyLabel(triggerKeyInput.value, t, triggerKeyTyped.value));
// Waiting for the press of the new key
const choosingKey = ref(false);
// Keys pressed while choosing and not released yet: their release is taken too
const heldKeys = new Set<string>();
const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

function chooseKey(): void {
  choosingKey.value = true;
  heldKeys.clear();
  for (const type of KEY_EVENTS) window.addEventListener(type, onKeyWhileChoosing, true);
  window.addEventListener('blur', onWindowBlur);
  clearTimeout(contextMenuTimer);
  window.addEventListener('contextmenu', preventContextMenu, true);
}

// The menu key opens the context menu with its own event, after its release on Windows: it is refused while choosing,
// and a moment after
let contextMenuTimer: ReturnType<typeof setTimeout> | undefined;
const CONTEXT_MENU_DELAY_MS = 500;

function preventContextMenu(event: Event): void {
  event.preventDefault();
}

function stopChoosingKey(): void {
  choosingKey.value = false;
  if (heldKeys.size === 0) stopListening();
}

function stopListening(): void {
  for (const type of KEY_EVENTS) window.removeEventListener(type, onKeyWhileChoosing, true);
  window.removeEventListener('blur', onWindowBlur);
  clearTimeout(contextMenuTimer);
  contextMenuTimer = setTimeout(() => window.removeEventListener('contextmenu', preventContextMenu, true), CONTEXT_MENU_DELAY_MS);
}

// The window gets no release of the keys held when it loses the focus (e.g. Alt+Tab): they are not waited for any more,
// so the keyboard works again once the key is chosen
function onWindowBlur(): void {
  heldKeys.clear();
  if (!choosingKey.value) stopListening();
}

// Any key can be chosen, Tab, Esc, Shift, Ctrl and Alt too, but the Windows key (see canTrigger): only the Cancel button
// stops the choice. The press and the
// release are taken before the page and the browser see them, so the key does nothing else: Enter would save the form,
// the space bar click the button, Tab move the focus, Esc close a menu, Alt open the menu of the browser, the menu key
// open the context menu
function onKeyWhileChoosing(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.type === 'keyup') {
    heldKeys.delete(event.code);
    if (!choosingKey.value && heldKeys.size === 0) stopListening();
    return;
  }
  if (event.type !== 'keydown') return;
  heldKeys.add(event.code);
  if (!choosingKey.value || !canTrigger(event.code)) return;
  triggerKeyInput.value = event.code;
  triggerKeyTyped.value = event.key;
  stopChoosingKey();
}
onUnmounted(() => {
  choosingKey.value = false;
  stopListening();
  clearTimeout(contextMenuTimer);
  window.removeEventListener('contextmenu', preventContextMenu, true);
});
const loaded = ref(false);
const error = ref<string | null>(null);
const saving = ref(false);

// The fields as loaded or last saved, to tell whether they were changed since
const fields = () =>
  JSON.stringify([
    measureInput.value,
    String(attemptsInput.value ?? '').trim(),
    String(attemptsPerDistanceInput.value ?? '').trim(),
    String(minDistanceInput.value ?? '').trim(),
    allowDistanceChangeInput.value,
    startInput.value,
    endInput.value,
    accessInput.value,
    bestInput.value,
    precisionInput.value,
    roundingInput.value,
    String(recentRunsInput.value ?? '').trim(),
    String(resultRowsInput.value ?? '').trim(),
    triggerInput.value,
    triggerKeyInput.value,
    udaHeaderInput.value,
    udaColumnsInput.value,
    udaSeparatorInput.value,
    udaSortInput.value.trim(),
  ]);
const savedFields = ref('');
/** Whether the form has changes not saved yet. */
const dirty = computed(() => loaded.value && fields() !== savedFields.value);
defineExpose({ dirty });

// The browser refuses to send the form while a field is invalid, and says why beside it: a field of a hidden section
// is shown first. Only the first invalid field of a submission counts: the browser checks them all
let showingInvalid = false;
async function onInvalid(event: Event): Promise<void> {
  const field = event.target as HTMLInputElement;
  const section = field.closest<HTMLElement>('[data-section]')?.dataset.section as SettingsSection | undefined;
  if (showingInvalid || !section || section === props.section) return;
  showingInvalid = true;
  emit('showSection', section);
  // The tab follows the URL, so it changes a little later: the field can only show why once its section is shown
  await new Promise<void>((resolve) => {
    const done = () => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const stop = watch(() => props.section, (shown) => shown === section && done());
    const timer = setTimeout(done, 1000);
  });
  await nextTick();
  // Fires invalid again, ignored while showingInvalid is set
  if (props.section === section) field.reportValidity();
  showingInvalid = false;
}

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
    // Missing from a server of an older version: a time, as without the setting
    measureInput.value = settings.measure ?? 'time';
    attemptsInput.value = settings.attempts === null ? '' : String(settings.attempts);
    attemptsPerDistanceInput.value = settings.attemptsPerDistance == null ? '' : String(settings.attemptsPerDistance);
    minDistanceInput.value = settings.minDistance == null ? '' : String(settings.minDistance);
    allowDistanceChangeInput.value = settings.allowDistanceChange ?? false;
    startInput.value = toLocalInput(settings.start);
    endInput.value = toLocalInput(settings.end);
    accessInput.value = settings.access;
    bestInput.value = settings.best;
    precisionInput.value = settings.precision;
    roundingInput.value = settings.rounding;
    recentRunsInput.value = settings.recentRuns;
    resultRowsInput.value = settings.resultRows ?? 5;
    // Missing from a server of an older version: the gates, as without the setting
    triggerInput.value = settings.trigger ?? 'gates';
    triggerKeyInput.value = settings.triggerKey ?? 'Space';
    // Missing from a server of an older version: the UDA format
    udaHeaderInput.value = settings.udaHeader ?? false;
    udaColumnsInput.value = settings.udaColumns ?? defaultColumns(measureInput.value);
    udaSeparatorInput.value = settings.udaSeparator ?? ',';
    udaSortInput.value = settings.udaSort ?? 'bib';
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
  const perDistanceText = String(attemptsPerDistanceInput.value ?? '').trim();
  const attemptsPerDistance = perDistanceText === '' ? null : Number(perDistanceText);
  if (attemptsPerDistance !== null && !(Number.isInteger(attemptsPerDistance) && attemptsPerDistance >= 1)) {
    error.value = t('settings.attemptsPerDistanceInvalid');
    return;
  }
  const minDistanceText = String(minDistanceInput.value ?? '').trim();
  const minDistance = minDistanceText === '' ? null : Number(minDistanceText);
  if (minDistance !== null && !(Number.isInteger(minDistance) && minDistance >= 1 && minDistance < 100_000)) {
    error.value = t('settings.minDistanceInvalid');
    return;
  }
  const recentRuns = Number(String(recentRunsInput.value ?? '').trim() || 3);
  if (!(Number.isInteger(recentRuns) && recentRuns >= 0)) {
    error.value = t('settings.recentRunsInvalid');
    return;
  }
  const resultRows = Number(String(resultRowsInput.value ?? '').trim() || 5);
  if (!(Number.isInteger(resultRows) && resultRows >= 1)) {
    error.value = t('settings.resultRowsInvalid');
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
          measure: measureInput.value,
          attempts,
          attemptsPerDistance,
          minDistance,
          allowDistanceChange: allowDistanceChangeInput.value,
          start: fromLocalInput(startInput.value),
          end: fromLocalInput(endInput.value),
          access: accessInput.value,
          best: bestInput.value,
          precision: precisionInput.value,
          rounding: roundingInput.value,
          recentRuns,
          resultRows,
          trigger: triggerInput.value,
          triggerKey: triggerKeyInput.value,
          udaHeader: udaHeaderInput.value,
          // The UDA format is saved as no columns: it follows the measure
          udaColumns: isDefault(udaColumnsInput.value, measureInput.value) ? null : udaColumnsInput.value,
          udaSeparator: udaSeparatorInput.value,
          udaSort: udaSortInput.value.trim() || 'bib',
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
  <form class="settings" @submit.prevent="save" @invalid.capture="onInvalid">
    <template v-if="loaded">
      <div v-show="section === 'basic'" data-section="basic">
        <fieldset class="choice">
          <legend>{{ $t('settings.measure.legend') }}</legend>
          <div class="segmented" role="radiogroup">
            <label v-for="option in MEASURE_OPTIONS" :key="option.value" :class="{ checked: measureInput === option.value }" :title="option.hint">
              <input v-model="measureInput" type="radio" name="measure" :value="option.value" @change="onMeasureChange" />
              {{ option.label }}
            </label>
          </div>
          <p class="muted small" data-testid="measure-hint">{{ MEASURE_OPTIONS.find((option) => option.value === measureInput)?.hint }}</p>
        </fieldset>
        <template v-if="measureInput === 'distance'">
          <label class="field">
            {{ $t('settings.minDistance') }}
            <span class="with-unit">
              <input v-model="minDistanceInput" type="number" min="1" max="99999" step="1" :placeholder="$t('settings.noMinimum')" class="attempts" data-testid="min-distance" />
              cm
            </span>
          </label>
          <p class="muted small">{{ $t('settings.minDistanceHint') }}</p>
        </template>
        <label class="field">
          {{ $t('settings.attempts') }}
          <input v-model="attemptsInput" type="number" min="1" step="1" :placeholder="$t('settings.unlimited')" class="attempts" />
        </label>
        <p class="muted small">{{ $t('settings.attemptsHint') }}</p>
        <template v-if="measureInput === 'distance'">
          <label class="field">
            {{ $t('settings.attemptsPerDistance') }}
            <input v-model="attemptsPerDistanceInput" type="number" min="1" step="1" :placeholder="$t('settings.unlimited')" class="attempts" data-testid="attempts-per-distance" />
          </label>
          <p class="muted small">{{ $t('settings.attemptsPerDistanceHint') }}</p>
        </template>
        <fieldset v-if="measureInput === 'time'" class="choice">
          <legend>{{ $t('settings.best.legend') }}</legend>
          <div class="segmented" role="radiogroup">
            <label v-for="option in BEST_OPTIONS" :key="option.value" :class="{ checked: bestInput === option.value }" :title="option.hint">
              <input v-model="bestInput" type="radio" name="best" :value="option.value" />
              {{ option.label }}
            </label>
          </div>
          <p class="muted small">{{ BEST_OPTIONS.find((option) => option.value === bestInput)?.hint }}</p>
        </fieldset>
        <fieldset v-if="measureInput === 'time'" class="choice">
          <legend>{{ $t('settings.trigger.legend') }}</legend>
          <div class="segmented" role="radiogroup">
            <label v-for="option in TRIGGER_OPTIONS" :key="option.value" :class="{ checked: triggerInput === option.value }" :title="option.hint">
              <input v-model="triggerInput" type="radio" name="trigger" :value="option.value" />
              {{ option.label }}
            </label>
          </div>
          <p class="muted small" data-testid="trigger-hint">{{ TRIGGER_OPTIONS.find((option) => option.value === triggerInput)?.hint }}</p>
        </fieldset>
        <div v-if="measureInput === 'time' && triggerInput === 'keyboard'" class="trigger-key">
          <span class="key-label">{{ $t('settings.triggerKey.label') }}</span>
          <div class="key-row">
            <kbd data-testid="trigger-key">{{ triggerKeyName }}</kbd>
            <button v-if="!choosingKey" type="button" class="secondary" @click="chooseKey">{{ $t('settings.triggerKey.change') }}</button>
            <template v-else>
              <span class="choosing" role="status">{{ $t('settings.triggerKey.press') }}</span>
              <button type="button" class="secondary" @click="stopChoosingKey">{{ $t('common.cancel') }}</button>
            </template>
          </div>
          <p class="muted small">{{ $t('settings.triggerKey.hint') }}</p>
        </div>
      </div>

      <div v-show="section === 'advanced'" data-section="advanced">
        <fieldset v-if="measureInput === 'time'" class="choice">
          <legend>{{ $t('settings.precision.legend') }}</legend>
          <div class="segmented" role="radiogroup">
            <label v-for="option in PRECISION_OPTIONS" :key="option.value" :class="{ checked: precisionInput === option.value }">
              <input v-model="precisionInput" type="radio" name="precision" :value="option.value" />
              {{ option.label }}
            </label>
          </div>
        </fieldset>
        <fieldset v-if="measureInput === 'time'" class="choice">
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
        <template v-if="measureInput === 'distance'">
          <label class="check">
            <input v-model="allowDistanceChangeInput" type="checkbox" data-testid="allow-distance-change" />
            {{ $t('settings.allowDistanceChange') }}
          </label>
          <p class="muted small">{{ $t('settings.allowDistanceChangeHint') }}</p>
        </template>
        <label class="field">
          {{ $t('settings.resultRows') }}
          <input v-model="resultRowsInput" type="number" min="1" step="1" placeholder="5" class="attempts" data-testid="result-rows-input" />
        </label>
        <p class="muted small">{{ $t('settings.resultRowsHint') }}</p>
        <label class="field">
          {{ $t('settings.recentRuns') }}
          <input v-model="recentRunsInput" type="number" min="0" step="1" placeholder="3" class="attempts" data-testid="recent-runs-input" />
        </label>
        <p class="muted small">{{ $t('settings.recentRunsHint') }}</p>
      </div>

      <div v-show="section === 'lock'" data-section="lock">
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
      </div>

      <div v-show="section === 'export'" data-section="export">
        <UdaExportSettings
          v-model:header="udaHeaderInput"
          v-model:columns="udaColumnsInput"
          v-model:separator="udaSeparatorInput"
          v-model:sort="udaSortInput"
          :event="event"
          :discipline="discipline"
          :measure="measureInput"
          :attempts="attemptsValue"
          :best="bestInput"
          :precision="precisionInput"
          :rounding="roundingInput"
        />
      </div>
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
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-weight: 600;
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
.trigger-key {
  margin-top: 12px;
}
.key-label {
  font-size: 0.85em;
  color: var(--text-muted);
}
.key-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.key-row kbd {
  font-family: inherit;
  font-weight: 600;
  min-width: 3em;
  text-align: center;
  padding: 3px 12px;
  border: 1px solid var(--border);
  border-bottom-width: 3px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-h);
}
.choosing {
  color: var(--accent);
  font-weight: 600;
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
.with-unit {
  display: flex;
  align-items: center;
  gap: 6px;
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
