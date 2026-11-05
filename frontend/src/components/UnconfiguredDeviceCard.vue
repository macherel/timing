<script setup lang="ts">
import { computed } from 'vue';
import type { HidInterface } from '../types';

// All interfaces of one connected device model (same VID:PID) that no device in config.yaml uses
const props = defineProps<{ interfaces: HidInterface[]; platform: string }>();

const first = computed(() => props.interfaces[0]);
const name = computed(() => first.value.product || `${first.value.vendorId}:${first.value.productId}`);
// Opens the configuration page with a new device pre-filled with these IDs
const addLink = computed(() => ({
  path: '/config',
  query: { add: `${first.value.vendorId}:${first.value.productId}`, name: name.value },
}));
// Windows and macOS keep mice and keyboards to themselves
const osOwnedUnreadable = computed(() => props.platform !== 'linux');
</script>

<template>
  <article class="card">
    <header class="card-header">
      <h3>{{ name }}</h3>
      <span class="badge">not configured</span>
      <RouterLink :to="addLink" class="add-link">+ Add to configuration</RouterLink>
    </header>

    <dl class="facts">
      <dt>Manufacturer</dt>
      <dd>{{ first.manufacturer || '?' }}</dd>
      <dt>Vendor / product ID</dt>
      <dd class="mono">{{ first.vendorId }}:{{ first.productId }}</dd>
    </dl>
    <p class="muted">
      The app does not open devices that are not in the configuration, so no report is shown. To see which bits its
      buttons change, add it to the configuration, or run <code>npm run diagnose -- --listen {{ first.vendorId }}:{{ first.productId }}</code>.
    </p>

    <h4>HID interfaces</h4>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Usage(s)</th>
            <th>Interface</th>
            <th>Serial</th>
            <th>USB port</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in interfaces" :key="item.path">
            <td>
              <div v-for="usage in item.usages" :key="usage">{{ usage }}</div>
              <div v-if="item.usages.length > 1" class="muted">several collections: byte 0 is the report ID</div>
              <div v-if="item.osOwned && osOwnedUnreadable" class="warn-text">mouse/keyboard: not readable on {{ platform }}</div>
            </td>
            <td>{{ item.interfaceNumber }}</td>
            <td class="mono">{{ item.serialNumber || '—' }}</td>
            <td class="mono">{{ item.usbPort ?? '—' }}</td>
            <td class="mono path">{{ item.path }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </article>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.card-header h3 {
  margin: 0;
}
.add-link {
  margin-left: auto;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  color: var(--accent);
  text-decoration: none;
}
.add-link:hover {
  background: var(--accent-bg);
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
.scroll {
  overflow-x: auto;
}
.path {
  word-break: break-all;
}
</style>
