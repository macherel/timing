<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceStatus, HidInterface, MonitorStatus } from '../types';
import InterfaceDetails from './InterfaceDetails.vue';

// One physical device: all its HID interfaces, whether a rule of config.yaml listens to them or not.
// `devices` are the configured connections of these interfaces; the diagnostics page asks the backend to open the
// other interfaces while this card is shown, so their reports are in `monitor`.
const props = defineProps<{ interfaces: HidInterface[]; devices: DeviceStatus[]; platform: string }>();

const first = computed(() => props.interfaces[0]);
const productName = computed(() => first.value.product || `${first.value.vendorId}:${first.value.productId}`);
const title = computed(() => (props.devices.length > 0 ? props.devices.map((d) => d.deviceName).join(' / ') : productName.value));

// Configured connection, or connection opened for this page, of each interface
const statusByPath = computed(() => {
  const map = new Map<string, MonitorStatus>();
  for (const item of props.interfaces) if (item.monitor) map.set(item.path, item.monitor);
  for (const device of props.devices) map.set(device.path, device);
  return map;
});
const configuredByPath = computed(() => new Map(props.devices.map((d) => [d.path, d])));

// Interfaces by USB interface number, as Zadig and the Device Manager list them: on Windows each HID collection has
// its own path, so one USB interface can show several rows. -1 (no USB interface number) comes last.
const usbInterfaces = computed(() => {
  const groups = new Map<number, HidInterface[]>();
  for (const item of props.interfaces) groups.set(item.interfaceNumber, [...(groups.get(item.interfaceNumber) ?? []), item]);
  return [...groups]
    .sort(([a], [b]) => (a < 0 ? 1 : b < 0 ? -1 : a - b))
    .map(([number, items]) => ({ number, items: [...items].sort((a, b) => a.path.localeCompare(b.path)) }));
});
const sortedInterfaces = computed(() => usbInterfaces.value.flatMap((group) => group.items));

// listening: a rule listens to it; disabled: only disabled (or ignored) rules name it; none: not in config.yaml
const configState = computed(() => {
  if (props.devices.length > 0) return props.devices.every((d) => d.state === 'listening') ? 'listening' : 'failing';
  return props.interfaces.some((i) => i.rules.length > 0) ? 'disabled' : 'none';
});
// Opens the configuration page with a new device pre-filled with these IDs
const addLink = computed(() => ({
  path: '/config',
  query: { add: `${first.value.vendorId}:${first.value.productId}`, name: productName.value },
}));
// Windows and macOS keep mice and keyboards to themselves
const osOwnedUnreadable = computed(() => props.platform !== 'linux');
</script>

<template>
  <article class="card">
    <header class="card-header">
      <h3>{{ title }}</h3>
      <span v-if="configState === 'listening' || configState === 'failing'" class="badge" :class="configState === 'listening' ? 'ok' : 'error'">
        {{ $t(`hid.states.${configState}`) }}
      </span>
      <span v-else class="badge">{{ configState === 'disabled' ? $t('interfaces.disabled') : $t('hid.notConfigured') }}</span>
      <RouterLink v-if="configState === 'none'" :to="addLink" class="add-link">{{ $t('unconfigured.add') }}</RouterLink>
      <RouterLink v-else to="/config" class="add-link">{{ $t('diagnostics.editConfig') }}</RouterLink>
    </header>

    <dl class="facts">
      <dt>{{ $t('hid.device') }}</dt>
      <dd>{{ productName }}</dd>
      <dt>{{ $t('unconfigured.manufacturer') }}</dt>
      <dd>{{ first.manufacturer || '?' }}</dd>
      <dt>{{ $t('unconfigured.vendorProduct') }}</dt>
      <dd class="mono">{{ first.vendorId }}:{{ first.productId }}</dd>
      <dt>{{ $t('hid.serial') }}</dt>
      <dd class="mono">{{ first.serialNumber || '—' }}</dd>
      <dt>{{ $t('hid.usbPort') }}</dt>
      <dd class="mono">{{ first.usbPort ?? '—' }}</dd>
    </dl>
    <p v-if="configState === 'none' || configState === 'disabled'" class="muted">{{ $t('unconfigured.explain') }}</p>

    <h4>{{ $t('unconfigured.interfaces') }}</h4>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>{{ $t('hid.usages') }}</th>
            <th>{{ $t('hid.path') }}</th>
            <th>{{ $t('interfaces.rule') }}</th>
            <th>{{ $t('deviceCard.state') }}</th>
          </tr>
        </thead>
        <tbody v-for="group in usbInterfaces" :key="group.number">
          <tr class="group">
            <th colspan="4" scope="rowgroup">
              {{ group.number >= 0 ? $t('deviceCard.usbInterface', { number: group.number }) : $t('deviceCard.noUsbInterface') }}
            </th>
          </tr>
          <tr v-for="item in group.items" :key="item.path" :class="{ configured: configuredByPath.has(item.path) }">
            <td>
              <div v-for="usage in item.usages" :key="usage">{{ usage }}</div>
              <div v-if="item.usages.length > 1" class="muted">{{ $t('hid.severalCollections') }}</div>
              <div v-if="item.osOwned && osOwnedUnreadable" class="warn-text">{{ $t('hid.osOwned', { platform }) }}</div>
            </td>
            <td class="mono path">
              {{ item.path }}
              <div v-if="item.transport === 'usb'"><span class="badge" :title="$t('hid.usbDirectHint')">{{ $t('hid.usbDirect') }}</span></div>
            </td>
            <td>
              <div v-for="rule in item.rules" :key="rule.name">
                {{ rule.name }}
                <span v-if="!rule.enabled" class="badge">{{ $t('interfaces.disabled') }}</span>
                <span v-if="rule.conflict" class="badge error" :title="$t('interfaces.conflict')">{{ $t('interfaces.ignored') }}</span>
              </div>
              <span v-if="item.rules.length === 0" class="muted">—</span>
            </td>
            <td>
              <span v-if="statusByPath.get(item.path)" class="badge" :class="statusByPath.get(item.path)!.state === 'listening' ? 'ok' : 'error'">
                {{ $t(`hid.states.${statusByPath.get(item.path)!.state}`) }}
              </span>
              <span v-else class="muted">{{ $t('unconfigured.opening') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Folded by default; Vue does not bind `open`, so an unfolded interface stays open across the status refreshes -->
    <template v-for="item in sortedInterfaces" :key="item.path">
      <details v-if="statusByPath.get(item.path)" class="interface">
        <summary>
          <h4>
            <span v-if="configuredByPath.get(item.path)">{{ configuredByPath.get(item.path)!.deviceName }}</span>
            <span :class="{ muted: configuredByPath.has(item.path) }">{{ item.usages.join(', ') }}</span>
            <span class="mono muted">{{ item.path }}</span>
            <span class="badge" :class="statusByPath.get(item.path)!.state === 'listening' ? 'ok' : 'error'">
              {{ $t(`hid.states.${statusByPath.get(item.path)!.state}`) }}
            </span>
          </h4>
        </summary>
        <InterfaceDetails :status="statusByPath.get(item.path)!" />
      </details>
    </template>
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
.configured td {
  background: var(--accent-bg);
}
.group th {
  padding-top: 14px;
  color: var(--text-h);
  font-weight: 600;
  text-align: left;
}
.interface {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.interface summary {
  cursor: pointer;
  list-style: none;
}
.interface summary::-webkit-details-marker {
  display: none;
}
/* Disclosure arrow, turned down when open */
.interface summary h4::before {
  content: '▸';
  display: inline-block;
  transition: transform 0.15s;
}
.interface[open] summary h4::before {
  transform: rotate(90deg);
}
.interface summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.interface h4 {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
}
.interface h4 .mono {
  font-weight: normal;
  font-size: 0.85em;
  word-break: break-all;
}
</style>
