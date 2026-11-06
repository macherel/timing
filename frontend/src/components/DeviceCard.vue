<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceStatus } from '../types';
import { formatTime, hexByte } from '../format';
import ReportBytes from './ReportBytes.vue';

const props = defineProps<{ device: DeviceStatus }>();

const recentReports = computed(() => [...(props.device.recentReports ?? [])].reverse());
</script>

<template>
  <article class="card">
    <header class="card-header">
      <h3>{{ device.deviceName }}</h3>
      <span class="badge" :class="device.state === 'listening' ? 'ok' : 'error'">{{ $t(`hid.states.${device.state}`) }}</span>
    </header>

    <dl class="facts">
      <dt>{{ $t('hid.path') }}</dt>
      <dd class="mono">{{ device.path }}</dd>
      <dt>{{ $t('deviceCard.since') }}</dt>
      <dd>{{ formatTime(device.since) }}</dd>
      <template v-if="device.state === 'listening'">
        <dt>{{ $t('deviceCard.reportsReceived') }}</dt>
        <dd>{{ device.reportCount }}</dd>
        <dt>{{ $t('deviceCard.lastReport') }}</dt>
        <dd>{{ device.lastReportAt ? formatTime(device.lastReportAt) : $t('deviceCard.noneYet') }}</dd>
      </template>
      <template v-else>
        <dt>{{ $t('deviceCard.attempts') }}</dt>
        <dd>{{ device.attempts }}</dd>
      </template>
    </dl>

    <template v-if="device.state === 'failing'">
      <p class="alert error">{{ device.error }}</p>
      <p v-if="device.hint" class="alert hint">{{ device.hint }}</p>
    </template>

    <template v-else>
      <h4>{{ $t('hid.triggers') }}</h4>
      <p v-if="!device.triggers?.length" class="muted">{{ $t('deviceCard.noTrigger') }}</p>
      <table v-else>
        <thead>
          <tr>
            <th>{{ $t('hid.reportId') }}</th>
            <th>{{ $t('hid.byte') }}</th>
            <th>{{ $t('hid.mask') }}</th>
            <th>{{ $t('hid.value') }}</th>
            <th>{{ $t('hid.pressAction') }}</th>
            <th>{{ $t('hid.releaseAction') }}</th>
            <th>{{ $t('deviceCard.state') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(trigger, i) in device.triggers" :key="i">
            <td>{{ trigger.reportId ?? $t('common.any') }}</td>
            <td>{{ trigger.byteIndex }}</td>
            <td class="mono">{{ hexByte(trigger.mask) }}</td>
            <td class="mono">{{ hexByte(trigger.value) }}</td>
            <td>{{ trigger.action ?? '—' }}</td>
            <td>{{ trigger.releaseAction ?? '—' }}</td>
            <td>
              <span class="badge" :class="{ ok: trigger.isMatched }">{{ trigger.isMatched ? $t('deviceCard.pressed') : $t('deviceCard.idle') }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h4>{{ $t('deviceCard.lastReport') }}</h4>
      <p v-if="!device.lastReportHex" class="muted">{{ $t('deviceCard.noReport') }}</p>
      <template v-else>
        <p class="muted">{{ $t('deviceCard.watchedHint') }}</p>
        <ReportBytes
          :hex="device.lastReportHex"
          :triggers="device.triggers ?? []"
          :numbered-reports="device.numberedReports ?? false"
        />
      </template>

      <h4>{{ $t('deviceCard.recentChanges') }}</h4>
      <p class="muted">{{ $t('deviceCard.recentHint') }}</p>
      <p v-if="recentReports.length === 0" class="muted">{{ $t('deviceCard.noChange') }}</p>
      <div v-else class="scroll">
        <table>
          <thead>
            <tr>
              <th>{{ $t('hid.time') }}</th>
              <th v-if="device.numberedReports">{{ $t('hid.reportId') }}</th>
              <th>{{ $t('deviceCard.bytes') }}</th>
              <th>{{ $t('deviceCard.changedBits') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="report in recentReports" :key="report.at + report.hex">
              <td class="mono">{{ formatTime(report.at) }}</td>
              <td v-if="device.numberedReports">{{ report.reportId }}</td>
              <td class="mono nowrap">{{ report.hex }}</td>
              <td>{{ report.changes.length ? report.changes.join(', ') : $t('deviceCard.firstReport') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </article>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card-header h3 {
  margin: 0;
}
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
.nowrap {
  white-space: nowrap;
}
.scroll {
  max-height: 320px;
  overflow: auto;
}
</style>
