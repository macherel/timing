<script setup lang="ts">
import { computed } from 'vue';
import type { TriggerState } from '../types';
import { hexByte } from '../format';

const props = defineProps<{
  hex: string;
  triggers: TriggerState[];
  numberedReports: boolean;
}>();

const BITS = [7, 6, 5, 4, 3, 2, 1, 0];

const bytes = computed(() => props.hex.split(' ').map((h) => parseInt(h, 16)));

// Bits read by a trigger that applies to this report (same report ID, or no report ID filter)
function isWatched(byteIndex: number, bit: number): boolean {
  return props.triggers.some(
    (t) =>
      t.byteIndex === byteIndex &&
      (t.mask & (1 << bit)) !== 0 &&
      (t.reportId === undefined || t.reportId === bytes.value[0]),
  );
}

function isSet(value: number, bit: number): boolean {
  return (value & (1 << bit)) !== 0;
}
</script>

<template>
  <table class="report-bytes">
    <thead>
      <tr>
        <th>{{ $t('hid.byte') }}</th>
        <th>{{ $t('report.hex') }}</th>
        <th v-for="bit in BITS" :key="bit" class="bit-head">{{ bit }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(value, byteIndex) in bytes" :key="byteIndex">
        <td>
          {{ byteIndex }}
          <span v-if="numberedReports && byteIndex === 0" class="muted">{{ $t('report.reportId') }}</span>
        </td>
        <td class="mono">{{ hexByte(value) }}</td>
        <td
          v-for="bit in BITS"
          :key="bit"
          class="bit"
          :class="{ set: isSet(value, bit), watched: isWatched(byteIndex, bit) }"
          :title="
            $t('report.bit', { byte: byteIndex, bit, mask: hexByte(1 << bit) }) +
            (isWatched(byteIndex, bit) ? ` ${$t('report.usedByTrigger')}` : '')
          "
        >
          {{ isSet(value, bit) ? 1 : 0 }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.report-bytes {
  width: auto;
}
.bit-head,
.bit {
  width: 1.8em;
  text-align: center;
  font-family: var(--mono);
}
.bit {
  color: var(--text-muted);
}
.bit.set {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}
.bit.watched {
  outline: 2px solid var(--warn);
  outline-offset: -2px;
}
</style>
