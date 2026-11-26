<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DisciplineSettings, Measure, RunResult, RunStatus } from '../../types';
import { formatTime, formatValue } from '../../format';
import { valueOf } from '../../race/results';

/**
 * The last runs of the discipline timed on the line, as read from the results file (its computer and line columns).
 * Read only: the status of a run is changed in the results of its participant.
 */
const props = defineProps<{
  // The latest first, at most `count`
  results: RunResult[];
  // How many runs the discipline settings ask for
  count: number;
  // Unit of the times, from the discipline settings
  precision: DisciplineSettings['precision'];
  // What a run measures: a time (by default) or a distance
  measure?: Measure;
}>();

const { t } = useI18n();

const isDistance = () => props.measure === 'distance';
const valueOfResult = (result: RunResult) => valueOf(result, props.measure ?? 'time');
const showValue = (value: number) => formatValue(value, props.measure ?? 'time', props.precision);
const statusLabel = (status: RunStatus) => t(`common.status.${status}`);
</script>

<template>
  <section class="card recent" data-testid="recent-runs">
    <h3>{{ $t('recent.title', count) }}</h3>
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
          <td class="mono">{{ result.bib }}</td>
          <td>{{ result.name }}</td>
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
.recent h3 {
  margin: 0 0 8px;
}
.recent table {
  max-width: 700px;
}
.time {
  font-variant-numeric: tabular-nums;
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
