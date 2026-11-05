<script setup lang="ts">
import { computed } from 'vue';
import type { HidInterface } from '../../types';
import { emptyTrigger, parseHex, type DeviceForm } from '../../config/configForm';

const device = defineModel<DeviceForm>({ required: true });
const props = defineProps<{
  index: number;
  count: number;
  problems: string[];
  interfaces: HidInterface[];
}>();
defineEmits<{ remove: []; move: [delta: number] }>();

// One entry per connected device model: the IDs are the same for all its interfaces
const connectedModels = computed(() => {
  const models = new Map<string, HidInterface>();
  for (const item of props.interfaces) models.set(`${item.vendorId}:${item.productId}`, item);
  return [...models.values()];
});

const modelKey = (model: HidInterface) => `${model.vendorId}:${model.productId}`;

// The connected device whose IDs are typed in the form, compared as numbers so "46d" matches "0x046d"
const matchingModel = computed(() => {
  const vendorId = parseHex(device.value.vendorId);
  const productId = parseHex(device.value.productId);
  return connectedModels.value.find(
    (m) => parseInt(m.vendorId, 16) === vendorId && parseInt(m.productId, 16) === productId,
  );
});

const hasIds = computed(() => device.value.vendorId.trim() !== '' || device.value.productId.trim() !== '');

function fillFromConnected(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const model = connectedModels.value.find((m) => modelKey(m) === select.value);
  if (model) {
    device.value.vendorId = model.vendorId;
    device.value.productId = model.productId;
  } else {
    // The placeholder was picked: keep showing the device that matches the IDs
    select.value = matchingModel.value ? modelKey(matchingModel.value) : '';
  }
}

const hasAdvanced = computed(
  () =>
    device.value.usagePage !== '' ||
    device.value.usage !== '' ||
    device.value.serialNumber !== '' ||
    device.value.usbPort !== '' ||
    device.value.logReports,
);
</script>

<template>
  <article class="card device" :class="{ disabled: !device.enabled, invalid: problems.length > 0 }">
    <header class="device-header">
      <span class="device-number">#{{ index + 1 }}</span>
      <label class="field grow">
        <span>Device name</span>
        <input v-model="device.name" type="text" placeholder="Start gate" />
      </label>
      <label class="switch">
        <input v-model="device.enabled" type="checkbox" />
        Enabled
      </label>
      <div class="device-actions">
        <button type="button" class="icon" :disabled="index === 0" title="Move up" @click="$emit('move', -1)">↑</button>
        <button type="button" class="icon" :disabled="index === count - 1" title="Move down" @click="$emit('move', 1)">↓</button>
        <button type="button" class="icon danger" title="Remove device" @click="$emit('remove')">✕</button>
      </div>
    </header>

    <div class="row">
      <label class="field">
        <span>Vendor ID (hex)</span>
        <input v-model="device.vendorId" type="text" class="mono short" placeholder="0x046d" />
      </label>
      <label class="field">
        <span>Product ID (hex)</span>
        <input v-model="device.productId" type="text" class="mono short" placeholder="0xc548" />
      </label>
      <label class="field">
        <span>Connected device</span>
        <select :value="matchingModel ? modelKey(matchingModel) : ''" @change="fillFromConnected">
          <option value="">{{ hasIds ? 'Not connected: choose one to use its IDs…' : 'Choose one to use its IDs…' }}</option>
          <option v-for="model in connectedModels" :key="modelKey(model)" :value="modelKey(model)">
            {{ model.manufacturer }} {{ model.product || '?' }} ({{ model.vendorId }}:{{ model.productId }})
          </option>
        </select>
      </label>
    </div>

    <details class="advanced" :open="hasAdvanced">
      <summary>Interface and unit selection, debugging</summary>
      <div class="row">
        <label class="field">
          <span>Usage page</span>
          <input v-model="device.usagePage" type="text" inputmode="numeric" class="short" placeholder="default" />
        </label>
        <label class="field">
          <span>Usage</span>
          <input v-model="device.usage" type="text" inputmode="numeric" class="short" placeholder="default" />
        </label>
        <label class="field">
          <span>Serial number</span>
          <input v-model="device.serialNumber" type="text" placeholder="any" />
        </label>
        <label class="field">
          <span>USB port (Linux)</span>
          <input v-model="device.usbPort" type="text" class="mono short" placeholder="any, e.g. 3-5" />
        </label>
        <label class="switch">
          <input v-model="device.logReports" type="checkbox" />
          Log raw reports
        </label>
      </div>
      <p class="muted small">
        Usage page and usage pick one interface of the device (otherwise the default interface applies). Serial
        number or USB port tell identical devices apart. The Diagnostics page lists these values for every device.
      </p>
    </details>

    <h4>Triggers</h4>
    <p class="muted small">
      A trigger fires its press action when <code>(report[byte] &amp; mask) == value</code> starts being true, and its
      release action when it stops. Mask and value are hex.
    </p>
    <div class="scroll">
      <table class="triggers">
        <thead>
          <tr>
            <th>Report ID</th>
            <th>Byte</th>
            <th>Mask</th>
            <th>Value</th>
            <th>Press action</th>
            <th>Release action</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(trigger, j) in device.triggers" :key="j">
            <td><input v-model="trigger.reportId" type="text" inputmode="numeric" class="tiny" placeholder="any" /></td>
            <td><input v-model="trigger.byteIndex" type="text" inputmode="numeric" class="tiny" placeholder="1" /></td>
            <td><input v-model="trigger.mask" type="text" class="mono tiny" placeholder="0x01" /></td>
            <td><input v-model="trigger.value" type="text" class="mono tiny" placeholder="0x01" /></td>
            <td><input v-model="trigger.action" type="text" list="trigger-actions" placeholder="start_crossed" /></td>
            <td><input v-model="trigger.releaseAction" type="text" list="trigger-actions" placeholder="none" /></td>
            <td>
              <button type="button" class="icon danger" title="Remove trigger" @click="device.triggers.splice(j, 1)">✕</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <button type="button" class="secondary small-button" @click="device.triggers.push(emptyTrigger())">+ Add trigger</button>

    <ul v-if="problems.length > 0" class="alert error problems">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>
  </article>
</template>

<style scoped>
.device.disabled {
  opacity: 0.7;
}
.device.invalid {
  border-color: var(--error);
}
.device-header {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.device-number {
  font-weight: 600;
  color: var(--text-muted);
  padding-bottom: 6px;
}
.device-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
  margin-top: 12px;
}
.grow {
  flex: 1 1 200px;
}
.advanced {
  margin-top: 12px;
}
.advanced summary {
  cursor: pointer;
  color: var(--text-muted);
}
.small {
  font-size: 0.85em;
  margin-top: 6px;
}
.scroll {
  overflow-x: auto;
}
.triggers td {
  padding: 4px 6px 4px 0;
  border-bottom: none;
}
.small-button {
  margin-top: 8px;
}
.problems {
  padding-left: 32px;
  margin-bottom: 0;
}
</style>
