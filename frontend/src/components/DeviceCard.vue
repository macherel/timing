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
      <span class="badge" :class="device.state === 'listening' ? 'ok' : 'error'">{{ device.state }}</span>
    </header>

    <dl class="facts">
      <dt>Path</dt>
      <dd class="mono">{{ device.path }}</dd>
      <dt>Since</dt>
      <dd>{{ formatTime(device.since) }}</dd>
      <template v-if="device.state === 'listening'">
        <dt>Reports received</dt>
        <dd>{{ device.reportCount }}</dd>
        <dt>Last report</dt>
        <dd>{{ device.lastReportAt ? formatTime(device.lastReportAt) : 'none yet' }}</dd>
      </template>
      <template v-else>
        <dt>Attempts</dt>
        <dd>{{ device.attempts }}</dd>
      </template>
    </dl>

    <template v-if="device.state === 'failing'">
      <p class="alert error">{{ device.error }}</p>
      <p v-if="device.hint" class="alert hint">{{ device.hint }}</p>
    </template>

    <template v-else>
      <h4>Triggers</h4>
      <p v-if="!device.triggers?.length" class="muted">No trigger configured for this device.</p>
      <table v-else>
        <thead>
          <tr>
            <th>Report ID</th>
            <th>Byte</th>
            <th>Mask</th>
            <th>Value</th>
            <th>Press action</th>
            <th>Release action</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(trigger, i) in device.triggers" :key="i">
            <td>{{ trigger.reportId ?? 'any' }}</td>
            <td>{{ trigger.byteIndex }}</td>
            <td class="mono">{{ hexByte(trigger.mask) }}</td>
            <td class="mono">{{ hexByte(trigger.value) }}</td>
            <td>{{ trigger.action ?? '—' }}</td>
            <td>{{ trigger.releaseAction ?? '—' }}</td>
            <td>
              <span class="badge" :class="{ ok: trigger.isMatched }">{{ trigger.isMatched ? 'pressed' : 'idle' }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Last report</h4>
      <p v-if="!device.lastReportHex" class="muted">No report received yet. Press a button on the device.</p>
      <template v-else>
        <p class="muted">Bits outlined in orange are read by a trigger.</p>
        <ReportBytes
          :hex="device.lastReportHex"
          :triggers="device.triggers ?? []"
          :numbered-reports="device.numberedReports ?? false"
        />
      </template>

      <h4>Recent changes</h4>
      <p class="muted">Reports that differ from the previous one with the same report ID, newest first.</p>
      <p v-if="recentReports.length === 0" class="muted">None yet.</p>
      <div v-else class="scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th v-if="device.numberedReports">Report ID</th>
              <th>Bytes</th>
              <th>Changed bits</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="report in recentReports" :key="report.at + report.hex">
              <td class="mono">{{ formatTime(report.at) }}</td>
              <td v-if="device.numberedReports">{{ report.reportId }}</td>
              <td class="mono nowrap">{{ report.hex }}</td>
              <td>{{ report.changes.length ? report.changes.join(', ') : 'first report with this ID' }}</td>
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
