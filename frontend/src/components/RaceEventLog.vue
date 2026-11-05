<script setup lang="ts">
import type { RaceUpdateMessage } from '../types';
import { formatTime } from '../format';

defineProps<{ events: RaceUpdateMessage[] }>();
</script>

<template>
  <p v-if="events.length === 0" class="muted">No crossing received since this page was opened.</p>
  <div v-else class="scroll">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Device</th>
          <th>Action</th>
          <th>Crossings for device</th>
          <th>Exact timestamp</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="event in events" :key="event.deviceId + event.timestamp">
          <td class="mono">{{ formatTime(event.timestamp) }}</td>
          <td>{{ event.deviceName }}</td>
          <td>{{ event.action }}</td>
          <td>{{ event.allCrossings.length }}</td>
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
