<script setup lang="ts">
import { computed } from 'vue';
import type { RecentReport } from '../types';
import { formatTime } from '../format';

// Reports that differ from the previous one with the same report ID, oldest first (as sent by the backend)
const props = defineProps<{ reports: RecentReport[]; numberedReports: boolean }>();

const newestFirst = computed(() => [...props.reports].reverse());
</script>

<template>
  <p class="muted">{{ $t('deviceCard.recentHint') }}</p>
  <p v-if="newestFirst.length === 0" class="muted">{{ $t('deviceCard.noChange') }}</p>
  <div v-else class="scroll">
    <table>
      <thead>
        <tr>
          <th>{{ $t('hid.time') }}</th>
          <th v-if="numberedReports">{{ $t('hid.reportId') }}</th>
          <th>{{ $t('deviceCard.bytes') }}</th>
          <th>{{ $t('deviceCard.changedBits') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="report in newestFirst" :key="report.at + report.hex">
          <td class="mono">{{ formatTime(report.at) }}</td>
          <td v-if="numberedReports">{{ report.reportId }}</td>
          <td class="mono nowrap">{{ report.hex }}</td>
          <td>{{ report.changes.length ? report.changes.join(', ') : $t('deviceCard.firstReport') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.nowrap {
  white-space: nowrap;
}
.scroll {
  max-height: 320px;
  overflow: auto;
}
</style>
