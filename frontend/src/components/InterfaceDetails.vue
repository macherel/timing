<script setup lang="ts">
import type { MonitorStatus, TriggerState } from '../types';
import { formatTime, hexByte } from '../format';
import ReportBytes from './ReportBytes.vue';
import ReportHistory from './ReportHistory.vue';

// State and reports of one open (or failing) HID interface. `triggers` (the gates of the lines on it) is only set on
// an interface used by a line; the others are opened for the diagnostics page only.
defineProps<{ status: MonitorStatus & { triggers?: TriggerState[] } }>();
</script>

<template>
  <dl class="facts">
    <dt>{{ $t('deviceCard.since') }}</dt>
    <dd>{{ formatTime(status.since) }}</dd>
    <template v-if="status.state === 'listening'">
      <dt>{{ $t('deviceCard.reportsReceived') }}</dt>
      <dd>{{ status.reportCount }}</dd>
      <dt>{{ $t('deviceCard.lastReport') }}</dt>
      <dd>{{ status.lastReportAt ? formatTime(status.lastReportAt) : $t('deviceCard.noneYet') }}</dd>
    </template>
    <template v-else>
      <dt>{{ $t('deviceCard.attempts') }}</dt>
      <dd>{{ status.attempts }}</dd>
    </template>
  </dl>

  <template v-if="status.state === 'failing'">
    <p class="alert error">{{ status.error }}</p>
    <p v-if="status.hint" class="alert hint">{{ status.hint }}</p>
  </template>

  <template v-else>
    <template v-if="status.triggers">
      <h5>{{ $t('hid.triggers') }}</h5>
      <p v-if="status.triggers.length === 0" class="muted">{{ $t('deviceCard.noTrigger') }}</p>
      <table v-else>
        <thead>
          <tr>
            <th>{{ $t('eventLog.line') }}</th>
            <th>{{ $t('eventLog.gate') }}</th>
            <th>{{ $t('hid.reportId') }}</th>
            <th>{{ $t('hid.byte') }}</th>
            <th>{{ $t('hid.mask') }}</th>
            <th>{{ $t('hid.value') }}</th>
            <th>{{ $t('line.edge') }}</th>
            <th>{{ $t('deviceCard.state') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(trigger, i) in status.triggers" :key="i">
            <td>{{ trigger.line }}</td>
            <td>{{ $t(`line.${trigger.gate}`) }}</td>
            <td>{{ trigger.reportId ?? $t('common.any') }}</td>
            <td>{{ trigger.byteIndex }}</td>
            <td class="mono">{{ hexByte(trigger.mask) }}</td>
            <td class="mono">{{ hexByte(trigger.value) }}</td>
            <td>{{ $t(`line.${trigger.edge}`) }}</td>
            <td>
              <span class="badge" :class="{ ok: trigger.isMatched }">{{ trigger.isMatched ? $t('deviceCard.pressed') : $t('deviceCard.idle') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <h5>{{ $t('deviceCard.lastReport') }}</h5>
    <p v-if="!status.lastReportHex" class="muted">{{ $t('deviceCard.noReport') }}</p>
    <template v-else>
      <p v-if="status.triggers?.length" class="muted">{{ $t('deviceCard.watchedHint') }}</p>
      <ReportBytes :hex="status.lastReportHex" :triggers="status.triggers ?? []" :numbered-reports="status.numberedReports ?? false" />
    </template>

    <h5>{{ $t('deviceCard.recentChanges') }}</h5>
    <ReportHistory :reports="status.recentReports ?? []" :numbered-reports="status.numberedReports ?? false" />
  </template>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 12px 0;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
}
</style>
