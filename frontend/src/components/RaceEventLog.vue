<script setup lang="ts">
import type { RaceUpdateMessage } from '../types';
import { formatTime } from '../format';

defineProps<{ events: RaceUpdateMessage[] }>();
</script>

<template>
  <p v-if="events.length === 0" class="muted">{{ $t('eventLog.none') }}</p>
  <div v-else class="scroll">
    <table>
      <thead>
        <tr>
          <th>{{ $t('hid.time') }}</th>
          <th>{{ $t('eventLog.line') }}</th>
          <th>{{ $t('eventLog.gate') }}</th>
          <th>{{ $t('hid.device') }}</th>
          <th>{{ $t('eventLog.timestamp') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="event in events" :key="`${event.line}\n${event.gate}\n${event.timestamp}`">
          <td class="mono">{{ formatTime(event.timestamp) }}</td>
          <td>{{ event.line }}</td>
          <td>{{ $t(`line.${event.gate}`) }}</td>
          <td>{{ event.deviceName }}</td>
          <td class="mono muted">{{ event.timestamp }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.scroll {
  max-height: 320px;
  overflow: auto;
}
</style>
