<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, Measure, RunResult, RunStatus } from '../../types';
import { formatTime, formatValue } from '../../format';
import { valueOf } from '../../race/results';

/**
 * The last runs of the discipline timed on the line, as read from the results file (its computer and line columns).
 * Read only: the status of a run is changed in the results of its participant, who is selected by a click on their
 * bib or name.
 */
const props = defineProps<{
  // The latest first, at most `count`
  results: RunResult[];
  // How many runs are shown: those the discipline settings ask for, unless changed for now from the title
  count: number;
  // How many runs the discipline settings ask for, when it differs from `count`: the title offers to go back to it
  settingsCount?: number;
  // Unit of the times, from the discipline settings
  precision: DisciplineSettings['precision'];
  // What a run measures: a time (by default) or a distance
  measure?: Measure;
  // Bibs of the participants that can be selected (those of the participant files); none while a run is in progress
  selectable?: Set<string>;
}>();

defineEmits<{
  select: [bib: string];
  // For now only: the settings of the discipline are not changed
  resize: [count: number];
}>();

// The most runs shown at once
const MAX_COUNT = 50;

const { t } = useI18n();

const isDistance = () => props.measure === 'distance';
const valueOfResult = (result: RunResult) => valueOf(result, props.measure ?? 'time');
const showValue = (value: number) => formatValue(value, props.measure ?? 'time', props.precision);
const statusLabel = (status: RunStatus) => t(`common.status.${status}`);
</script>

<template>
  <section class="card recent" data-testid="recent-runs">
    <div class="title">
      <h3>{{ $t('recent.title', count) }}</h3>
      <span class="resize" role="group" :aria-label="$t('recent.resize')">
        <button type="button" :disabled="count <= 1" :title="$t('recent.fewer')" :aria-label="$t('recent.fewer')" data-testid="recent-fewer" @click="$emit('resize', count - 1)">−</button>
        <button type="button" :disabled="count >= MAX_COUNT" :title="$t('recent.more')" :aria-label="$t('recent.more')" data-testid="recent-more" @click="$emit('resize', count + 1)">+</button>
        <button
          v-if="settingsCount !== undefined && settingsCount !== count"
          type="button"
          class="reset"
          :title="$t('recent.reset', { n: settingsCount })"
          data-testid="recent-reset"
          @click="$emit('resize', settingsCount)"
        >
          {{ $t('recent.resetLabel') }}
        </button>
      </span>
    </div>
    <p v-if="results.length === 0" class="muted">{{ $t('recent.none') }}</p>
    <table v-else>
      <thead>
        <tr>
          <th>{{ $t('recent.bib') }}</th>
          <th>{{ $t('recent.name') }}</th>
          <th>{{ $t(isDistance() ? 'run.distance' : 'run.time') }}</th>
          <th>{{ $t(isDistance() ? 'run.typedAt' : 'run.startedAt') }}</th>
          <th>{{ $t('run.status') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="result in results" :key="`${result.bib}-${result.start}`" :class="{ void: result.status !== 'ok' }">
          <template v-if="selectable?.has(result.bib)">
            <td class="mono">
              <button type="button" class="pick" :title="$t('recent.select')" data-testid="recent-select" @click="$emit('select', result.bib)">{{ result.bib }}</button>
            </td>
            <td>
              <button type="button" class="pick" :title="$t('recent.select')" @click="$emit('select', result.bib)">{{ result.name }}</button>
            </td>
          </template>
          <template v-else>
            <td class="mono">{{ result.bib }}</td>
            <td>{{ result.name }}</td>
          </template>
          <td class="mono time">
            <s v-if="result.status !== 'ok' && valueOfResult(result) !== null">{{ showValue(valueOfResult(result)!) }}</s>
            <template v-else-if="valueOfResult(result) !== null">{{ showValue(valueOfResult(result)!) }}</template>
            <span v-else class="muted" :title="$t(isDistance() ? 'run.noDistance' : 'run.noTime')">—</span>
          </td>
          <td class="mono muted">{{ formatTime(result.start) }}</td>
          <td><span class="status" :class="result.status">{{ statusLabel(result.status) }}</span></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.recent .title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 8px;
}
.recent h3 {
  margin: 0;
}
.resize {
  display: inline-flex;
  gap: 4px;
}
.resize button {
  min-width: 2em;
  padding: 2px 8px;
}
.resize button.reset {
  font-size: 0.9em;
}
.recent table {
  max-width: 700px;
}
.time {
  font-variant-numeric: tabular-nums;
}
button.pick {
  padding: 0;
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
button.pick:hover {
  text-decoration: underline;
}
tr.void td {
  color: var(--text-muted);
}
.status.invalid {
  color: var(--warn);
}
.status.dq {
  color: var(--error);
}
</style>
