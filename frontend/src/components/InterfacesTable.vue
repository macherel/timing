<script setup lang="ts">
import { computed, ref } from 'vue';
import type { HidInterface } from '../types';

const props = defineProps<{ interfaces: HidInterface[]; platform: string }>();

const onlyConfigured = ref(false);

// Interfaces used by a rule first, then by device and path
const rows = computed(() =>
  props.interfaces
    .filter((i) => !onlyConfigured.value || i.rules.length > 0)
    .sort(
      (a, b) =>
        Number(b.rules.length > 0) - Number(a.rules.length > 0) ||
        `${a.vendorId}:${a.productId}`.localeCompare(`${b.vendorId}:${b.productId}`) ||
        a.path.localeCompare(b.path),
    ),
);

// Windows and macOS keep mice and keyboards to themselves
const osOwnedUnreadable = computed(() => props.platform !== 'linux');
</script>

<template>
  <label class="toggle">
    <input v-model="onlyConfigured" type="checkbox" />
    Only interfaces used by a rule
  </label>
  <p v-if="rows.length === 0" class="muted">No HID interface found.</p>
  <div v-else class="scroll">
    <table>
      <thead>
        <tr>
          <th>Device</th>
          <th>VID:PID</th>
          <th>Usage(s)</th>
          <th>Interface</th>
          <th>Serial</th>
          <th>USB port</th>
          <th>Path</th>
          <th>Rule</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.path" :class="{ configured: item.rules.length > 0 }">
          <td>
            {{ item.product || '?' }}
            <div class="muted">{{ item.manufacturer }}</div>
          </td>
          <td class="mono">{{ item.vendorId }}:{{ item.productId }}</td>
          <td>
            <div v-for="usage in item.usages" :key="usage">{{ usage }}</div>
            <div v-if="item.usages.length > 1" class="muted">several collections: byte 0 is the report ID</div>
            <div v-if="item.osOwned && osOwnedUnreadable" class="warn-text">mouse/keyboard: not readable on {{ platform }}</div>
          </td>
          <td>{{ item.interfaceNumber }}</td>
          <td class="mono">{{ item.serialNumber || '—' }}</td>
          <td class="mono">{{ item.usbPort ?? '—' }}</td>
          <td class="mono path">{{ item.path }}</td>
          <td>
            <div v-for="rule in item.rules" :key="rule.name">
              {{ rule.name }}
              <span v-if="!rule.enabled" class="badge">disabled</span>
              <span v-if="rule.conflict" class="badge error" title="Another interface already uses this rule">ignored</span>
            </div>
            <span v-if="item.rules.length === 0" class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.scroll {
  overflow-x: auto;
}
.configured td {
  background: var(--accent-bg);
}
.path {
  word-break: break-all;
  min-width: 12em;
}
</style>
