<script setup lang="ts">
import type { Gate } from '../../types';
import { GATES, type DeviceForm, type LineForm } from '../../config/configForm';

const line = defineModel<LineForm>({ required: true });
defineProps<{
  index: number;
  count: number;
  problems: string[];
  devices: DeviceForm[];
  // The gate of this line waiting for a button press, and what the detection says (e.g. why it failed)
  detecting: Gate | null;
  detectMessage: { kind: 'hint' | 'error'; text: string } | null;
}>();
defineEmits<{ remove: []; move: [delta: number]; detect: [gate: Gate]; stopDetect: [] }>();

const deviceLabel = (device: DeviceForm, index: number) => device.name.trim() || `#${index + 1}`;
</script>

<template>
  <article class="card line" :class="{ disabled: !line.enabled, invalid: problems.length > 0 }">
    <header class="line-header">
      <span class="line-number">#{{ index + 1 }}</span>
      <label class="field grow">
        <span>{{ $t('line.name') }}</span>
        <input v-model="line.name" type="text" :placeholder="$t('line.namePlaceholder')" />
      </label>
      <label class="switch">
        <input v-model="line.enabled" type="checkbox" />
        {{ $t('line.enabled') }}
      </label>
      <div class="line-actions">
        <button type="button" class="icon" :disabled="index === 0" :title="$t('line.moveUp')" @click="$emit('move', -1)">↑</button>
        <button type="button" class="icon" :disabled="index === count - 1" :title="$t('line.moveDown')" @click="$emit('move', 1)">↓</button>
        <button type="button" class="icon danger" :title="$t('line.remove')" @click="$emit('remove')">✕</button>
      </div>
    </header>

    <div class="gates">
      <fieldset v-for="gate in GATES" :key="gate" class="gate" :class="gate">
        <legend>{{ $t(`line.${gate}`) }}</legend>
        <div class="row">
          <label class="field grow">
            <span>{{ $t('line.device') }}</span>
            <select v-model="line[gate].deviceKey">
              <option :value="null" disabled>{{ devices.length === 0 ? $t('line.noDevice') : $t('line.chooseDevice') }}</option>
              <option v-for="(device, i) in devices" :key="device.key" :value="device.key">{{ deviceLabel(device, i) }}</option>
            </select>
          </label>
          <button
            v-if="detecting !== gate"
            type="button"
            class="secondary"
            :disabled="line[gate].deviceKey === null || detecting !== null"
            :title="$t('line.detectTitle')"
            @click="$emit('detect', gate)"
          >
            {{ $t('line.detect') }}
          </button>
          <button v-else type="button" class="secondary" @click="$emit('stopDetect')">{{ $t('common.cancel') }}</button>
        </div>
        <p v-if="detecting === gate && detectMessage" class="alert detect" :class="detectMessage.kind">{{ detectMessage.text }}</p>
        <div class="row pattern">
          <label class="field">
            <span>{{ $t('hid.reportId') }}</span>
            <input v-model="line[gate].reportId" type="text" inputmode="numeric" class="tiny" :placeholder="$t('common.any')" />
          </label>
          <label class="field">
            <span>{{ $t('hid.byte') }}</span>
            <input v-model="line[gate].byteIndex" type="text" inputmode="numeric" class="tiny" placeholder="1" />
          </label>
          <label class="field">
            <span>{{ $t('hid.mask') }}</span>
            <input v-model="line[gate].mask" type="text" class="mono tiny" placeholder="0x01" />
          </label>
          <label class="field">
            <span>{{ $t('hid.value') }}</span>
            <input v-model="line[gate].value" type="text" class="mono tiny" placeholder="0x01" />
          </label>
          <label class="field">
            <span>{{ $t('line.edge') }}</span>
            <select v-model="line[gate].edge">
              <option value="press">{{ $t('line.press') }}</option>
              <option value="release">{{ $t('line.release') }}</option>
            </select>
          </label>
        </div>
      </fieldset>
    </div>
    <i18n-t keypath="line.patternHint" tag="p" class="muted small">
      <template #condition><code>(report[byte] &amp; mask) == value</code></template>
      <template #button><em>{{ $t('line.detect') }}</em></template>
    </i18n-t>

    <ul v-if="problems.length > 0" class="alert error problems">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>
  </article>
</template>

<style scoped>
.line.disabled {
  opacity: 0.7;
}
.line.invalid {
  border-color: var(--error);
}
.line-header {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.line-number {
  font-weight: 600;
  color: var(--text-muted);
  padding-bottom: 6px;
}
.line-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.grow {
  flex: 1 1 200px;
}
.gates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.gate {
  border: 1px solid var(--border);
  border-left: 4px solid var(--border);
  border-radius: 8px;
  padding: 8px 14px 14px;
  margin: 0;
  min-width: 0;
}
.gate.start {
  border-left-color: var(--warn);
}
.gate.finish {
  border-left-color: var(--ok);
}
.gate legend {
  font-weight: 600;
  color: var(--text-h);
  padding: 0 6px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
}
.pattern {
  margin-top: 12px;
}
.detect {
  margin: 12px 0 0;
}
.small {
  font-size: 0.85em;
  margin-top: 8px;
}
.problems {
  padding-left: 32px;
  margin-bottom: 0;
}
</style>
