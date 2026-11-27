<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, Measure, UdaColumn, UdaFormat } from '../../types';
import { defaultColumns, exportOf, isCustom, isDefault, loadUdaFormats, MAX_UDA_COLUMNS } from '../../udaColumns';

/**
 * The export section of the settings of a discipline: whether the UDA export has a header line, its columns, one by
 * one (a title, in the header line, shown only with it, and a value for each participant, both templates), added,
 * removed and moved, or copied from another discipline,
 * its separator and the order of its lines, with a preview of the export of the results of the moment made by the
 * server with these settings, not saved yet, and a reminder of the template syntax.
 */
const props = defineProps<{
  event: string;
  discipline: string;
  // The settings being edited that change the export
  measure: Measure;
  attempts: number | null;
  best: DisciplineSettings['best'];
  precision: DisciplineSettings['precision'];
  rounding: DisciplineSettings['rounding'];
}>();
const header = defineModel<boolean>('header', { required: true });
const columns = defineModel<UdaColumn[]>('columns', { required: true });
const separator = defineModel<string>('separator', { required: true });
const sort = defineModel<string>('sort', { required: true });

const { t } = useI18n();

function addColumn(): void {
  columns.value = [...columns.value, { title: '', value: '' }];
}
function removeColumn(index: number): void {
  columns.value = columns.value.filter((_, other) => other !== index);
}
/** Moves a column one place earlier (-1) or later (1). */
function moveColumn(index: number, by: -1 | 1): void {
  const moved = [...columns.value];
  [moved[index], moved[index + by]] = [moved[index + by], moved[index]];
  columns.value = moved;
}
function setColumn(index: number, part: keyof UdaColumn, text: string): void {
  columns.value = columns.value.map((column, other) => (other === index ? { ...column, [part]: text } : column));
}
const usesDefault = computed(() => isDefault(columns.value, props.measure));

// The formats of the other disciplines that are not the UDA format, to copy one: those of the same measure first
const formats = ref<UdaFormat[]>([]);
const otherFormats = computed(() => formats.value.filter((format) => isCustom(format) && !(format.event === props.event && format.discipline === props.discipline)));
const formatGroups = computed(() =>
  [
    { label: t('settings.uda.sameMeasure'), formats: otherFormats.value.filter((format) => format.measure === props.measure) },
    { label: t('settings.uda.otherMeasure'), formats: otherFormats.value.filter((format) => format.measure !== props.measure) },
  ].filter((group) => group.formats.length > 0),
);
const formatKey = (format: UdaFormat) => `${format.event}\n${format.discipline}`;
onMounted(async () => {
  try {
    formats.value = await loadUdaFormats();
  } catch {
    // Nothing to copy from, then
  }
});
/** Copies the format of another discipline (chosen in the menu, which goes back to its prompt). */
function copyFormat(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const format = otherFormats.value.find((other) => formatKey(other) === select.value);
  select.value = '';
  if (!format) return;
  const copied = exportOf(format, props.measure);
  header.value = copied.header;
  columns.value = copied.columns;
  separator.value = copied.separator;
  sort.value = copied.sort;
}

const SEPARATORS = [
  { value: ',', key: 'comma' },
  { value: ';', key: 'semicolon' },
  { value: '\t', key: 'tab' },
  { value: '|', key: 'pipe' },
  { value: ' ', key: 'space' },
] as const;
// A separator of config.yaml that is none of these is kept, as it is
const separatorOptions = computed(() => {
  const options: { value: string; label: string }[] = SEPARATORS.map(({ value, key }) => ({ value, label: t(`settings.uda.separators.${key}`) }));
  if (!SEPARATORS.some((option) => option.value === separator.value)) options.push({ value: separator.value, label: `« ${separator.value} »` });
  return options;
});

// Variables of a participant, by measure, with the name of their description in the texts
const VARIABLES: { name: string; measure?: Measure }[] = [
  { name: 'bib' },
  { name: 'name' },
  { name: 'firstName' },
  { name: 'lastName' },
  { name: 'category' },
  { name: 'status' },
  { name: 'rank' },
  { name: 'categoryRank' },
  { name: 'runs' },
  { name: 'okRuns' },
  { name: 'attempts' },
  { name: 'bestRun' },
  { name: 'bestAttempt' },
  { name: 'minutes', measure: 'time' },
  { name: 'seconds', measure: 'time' },
  { name: 'fraction', measure: 'time' },
  { name: 'units', measure: 'time' },
  { name: 'timeMs', measure: 'time' },
  { name: 'distance', measure: 'distance' },
  { name: 'count' },
  { name: 'event' },
  { name: 'discipline' },
];
const variables = computed(() => VARIABLES.filter((variable) => !variable.measure || variable.measure === props.measure));

// The syntax, by example: the code is not translated, its explanation is
const SYNTAX = [
  { code: '{bib}', key: 'variable' },
  { code: '{minutes * 60 + seconds}', key: 'formula' },
  { code: '{distance / 100}', key: 'division' },
  { code: '{distance % 100}', key: 'remainder' },
  { code: '{name + " " + upper(lastName)}', key: 'join' },
  { code: '{if status == "OK"}…{elif status == "DQ"}…{else}…{end}', key: 'condition' },
  { code: '== != < <= > >=   && || !', key: 'operators' },
  { code: '{pad(fraction, 2)}', key: 'pad' },
  { code: 'upper(x) lower(x) trim(x) len(x) left(x, n) right(x, n)', key: 'texts' },
  { code: 'min(a, b…) max(a, b…) abs(x)', key: 'numbers' },
  { code: '{col("Country")}', key: 'column' },
  { code: '{{ }}', key: 'braces' },
] as const;

// The preview: the first lines of the export, and the problems found
const PREVIEW_LINES = 15;
const previewText = ref<string | null>(null);
const previewProblems = ref<string[]>([]);
const previewError = ref<string | null>(null);
const previewLines = computed(() => (previewText.value ?? '').split('\r\n').filter((text, index, all) => index < all.length - 1 || text !== ''));
const shownLines = computed(() => previewLines.value.slice(0, PREVIEW_LINES));
const hiddenLines = computed(() => Math.max(0, previewLines.value.length - PREVIEW_LINES));
// The fields with a problem, as "<column number> title" or "<column number> value" (a problem of a participant is in
// the value)
const wrongFields = computed(
  () =>
    new Set(
      previewProblems.value.flatMap((problem) => {
        const match = /column (\d+)(,? (title|value|bib))/.exec(problem);
        return match ? [`${match[1]} ${match[3] === 'title' ? 'title' : 'value'}`] : [];
      }),
    ),
);
const isWrong = (index: number, part: keyof UdaColumn) => wrongFields.value.has(`${index + 1} ${part}`);

let timer: ReturnType<typeof setTimeout> | undefined;
let previewRequest = 0;
const PREVIEW_DELAY_MS = 300;

async function preview(): Promise<void> {
  const request = ++previewRequest;
  const path = `/api/events/${encodeURIComponent(props.event)}/${encodeURIComponent(props.discipline)}/uda-preview`;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          measure: props.measure,
          attempts: props.attempts,
          best: props.best,
          precision: props.precision,
          rounding: props.rounding,
          udaHeader: header.value,
          udaColumns: columns.value,
          udaSeparator: separator.value,
          udaSort: sort.value.trim() || 'bib',
        },
      }),
    });
    const body = await response.json().catch(() => null);
    if (request !== previewRequest) return;
    if (!response.ok) throw new Error(body?.problems?.join(' ') ?? `HTTP ${response.status}`);
    previewText.value = body.text;
    previewProblems.value = body.problems;
    previewError.value = null;
  } catch (e) {
    if (request === previewRequest) previewError.value = t('settings.uda.previewError', { error: e instanceof Error ? e.message : String(e) });
  }
}

watch(
  () => [header.value, columns.value, separator.value, sort.value, props.measure, props.attempts, props.best, props.precision, props.rounding, props.event, props.discipline],
  () => {
    clearTimeout(timer);
    timer = setTimeout(preview, PREVIEW_DELAY_MS);
  },
  { immediate: true, deep: true },
);
onUnmounted(() => clearTimeout(timer));

// The tab of a line made visible in the preview
const visible = (text: string) => text.replace(/\t/g, '→');
</script>

<template>
  <label v-if="formatGroups.length > 0" class="field copy">
    {{ $t('settings.uda.copyFrom') }}
    <select data-testid="uda-copy" @change="copyFormat">
      <option value="">{{ $t('settings.uda.copyPrompt') }}</option>
      <optgroup v-for="group in formatGroups" :key="group.label" :label="group.label">
        <option v-for="format in group.formats" :key="formatKey(format)" :value="formatKey(format)">{{ format.event }} · {{ format.discipline }}</option>
      </optgroup>
    </select>
  </label>

  <label class="check">
    <input v-model="header" type="checkbox" data-testid="uda-header" />
    {{ $t('settings.uda.header') }}
  </label>
  <p class="muted small">{{ $t('settings.uda.headerHint') }}</p>

  <h4>{{ $t('settings.uda.columns') }}</h4>
  <p class="muted small">{{ $t('settings.uda.columnsHint') }}</p>
  <ol class="columns" :class="{ 'with-titles': header }" data-testid="uda-columns">
    <li class="column-head" aria-hidden="true">
      <span></span>
      <span v-if="header">{{ $t('settings.uda.columnTitle') }}</span>
      <span>{{ $t('settings.uda.columnValue') }}</span>
      <span></span>
    </li>
    <li v-for="(column, index) in columns" :key="index" class="column" data-testid="uda-column">
      <span class="number">{{ index + 1 }}</span>
      <input
        v-if="header"
        :value="column.title"
        type="text"
        class="mono title"
        :class="{ wrong: isWrong(index, 'title') }"
        :placeholder="$t('settings.uda.noTitle')"
        :aria-label="$t('settings.uda.titleOf', { n: index + 1 })"
        spellcheck="false"
        data-testid="uda-column-title"
        @input="setColumn(index, 'title', ($event.target as HTMLInputElement).value)"
      />
      <input
        :value="column.value"
        type="text"
        class="mono value"
        :class="{ wrong: isWrong(index, 'value') }"
        :aria-label="$t('settings.uda.valueOf', { n: index + 1 })"
        spellcheck="false"
        data-testid="uda-column-value"
        @input="setColumn(index, 'value', ($event.target as HTMLInputElement).value)"
      />
      <span class="buttons">
        <button
          type="button"
          class="icon secondary"
          :disabled="index === 0"
          :title="$t('settings.uda.moveEarlier', { n: index + 1 })"
          :aria-label="$t('settings.uda.moveEarlier', { n: index + 1 })"
          @click="moveColumn(index, -1)"
        >
          ↑
        </button>
        <button
          type="button"
          class="icon secondary"
          :disabled="index === columns.length - 1"
          :title="$t('settings.uda.moveLater', { n: index + 1 })"
          :aria-label="$t('settings.uda.moveLater', { n: index + 1 })"
          @click="moveColumn(index, 1)"
        >
          ↓
        </button>
        <button
          type="button"
          class="icon secondary remove"
          :disabled="columns.length === 1"
          :title="$t('settings.uda.removeColumn', { n: index + 1 })"
          :aria-label="$t('settings.uda.removeColumn', { n: index + 1 })"
          @click="removeColumn(index)"
        >
          ✕
        </button>
      </span>
    </li>
  </ol>
  <div class="column-actions">
    <button type="button" class="secondary" :disabled="columns.length >= MAX_UDA_COLUMNS" data-testid="uda-add-column" @click="addColumn">
      {{ $t('settings.uda.addColumn') }}
    </button>
    <button v-if="!usesDefault" type="button" class="secondary" data-testid="uda-reset-columns" @click="columns = defaultColumns(measure)">
      {{ $t('settings.uda.resetColumns') }}
    </button>
  </div>

  <div class="row">
    <label class="field">
      {{ $t('settings.uda.separator') }}
      <select v-model="separator" data-testid="uda-separator">
        <option v-for="option in separatorOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label class="field">
      {{ $t('settings.uda.sort') }}
      <input v-model="sort" type="text" class="mono" placeholder="bib" spellcheck="false" data-testid="uda-sort" />
    </label>
  </div>
  <p class="muted small">{{ $t('settings.uda.sortHint') }}</p>

  <h4>{{ $t('settings.uda.preview') }}</h4>
  <p v-if="previewError" class="alert error">{{ previewError }}</p>
  <ul v-if="previewProblems.length > 0" class="alert error problems" data-testid="uda-problems">
    <li v-for="problem in previewProblems.slice(0, 5)" :key="problem">{{ problem }}</li>
    <li v-if="previewProblems.length > 5">{{ $t('settings.uda.moreProblems', { count: previewProblems.length - 5 }) }}</li>
  </ul>
  <pre v-if="shownLines.length > 0" class="preview" data-testid="uda-preview">{{ shownLines.map(visible).join('\n') }}</pre>
  <p v-else-if="previewText !== null" class="muted small">{{ $t('settings.uda.previewEmpty') }}</p>
  <p v-if="hiddenLines > 0" class="muted small">{{ $t('settings.uda.moreLines', { count: hiddenLines }) }}</p>

  <details class="help">
    <summary>{{ $t('settings.uda.help') }}</summary>
    <table>
      <tbody>
        <tr v-for="item in SYNTAX" :key="item.key">
          <td><code>{{ item.code }}</code></td>
          <td>{{ $t(`settings.uda.syntax.${item.key}`) }}</td>
        </tr>
      </tbody>
    </table>
    <h4>{{ $t('settings.uda.variables') }}</h4>
    <table>
      <tbody>
        <tr v-for="variable in variables" :key="variable.name">
          <td><code>{{ variable.name }}</code></td>
          <td>{{ $t(`settings.uda.vars.${variable.name}`) }}</td>
        </tr>
      </tbody>
    </table>
  </details>
</template>

<style scoped>
input,
select {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-h);
  min-width: 0;
}
.mono {
  font-family: var(--mono);
}
input.wrong {
  border-color: var(--error);
  outline: 1px solid var(--error);
}
.columns {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.column,
.column-head {
  display: grid;
  grid-template-columns: 1.5em minmax(10em, 1fr) auto;
  gap: 6px;
  align-items: center;
}
.with-titles .column,
.with-titles .column-head {
  grid-template-columns: 1.5em minmax(6em, 1fr) minmax(10em, 2.5fr) auto;
}
.copy {
  margin: 0 0 12px;
}
.copy select {
  align-self: flex-start;
  max-width: 100%;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-weight: 600;
}
.column-head {
  font-size: 0.85em;
  color: var(--text-muted);
}
.number {
  color: var(--text-muted);
  text-align: right;
}
.buttons {
  display: flex;
  gap: 2px;
}
.icon {
  padding: 4px 8px;
  min-width: 2em;
}
.remove:not(:disabled) {
  color: var(--error);
}
/* On a narrow screen, the value goes under the title, the buttons beside it */
@media (max-width: 600px) {
  .column-head {
    display: none;
  }
  .with-titles .column {
    grid-template-columns: 1.5em 1fr auto;
  }
  .with-titles .column .number,
  .with-titles .column .title,
  .with-titles .column .buttons {
    grid-row: 1;
  }
  .with-titles .column .value {
    grid-row: 2;
    grid-column: 2 / 4;
  }
}
.column-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 12px;
}
.field {
  margin-top: 12px;
}
.row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.row input {
  width: 14em;
}
.row + .muted {
  margin-bottom: 12px;
}
.preview {
  margin: 4px 0;
  padding: 8px 10px;
  max-height: 22em;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--code-bg);
  font-family: var(--mono);
  font-size: 0.9em;
}
.problems {
  margin: 4px 0;
  padding-left: 28px;
}
.help {
  margin-top: 16px;
}
.help summary {
  cursor: pointer;
  font-weight: 600;
}
.help table {
  border-collapse: collapse;
  font-size: 0.9em;
  margin-top: 6px;
}
.help td {
  padding: 3px 12px 3px 0;
  vertical-align: top;
}
.help td:first-child {
  overflow-wrap: anywhere;
}
</style>
