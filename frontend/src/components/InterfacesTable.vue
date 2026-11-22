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
    {{ $t('interfaces.onlyConfigured') }}
  </label>
  <p v-if="rows.length === 0" class="muted">{{ $t('interfaces.none') }}</p>
  <div v-else class="scroll">
    <table>
      <thead>
        <tr>
          <th>{{ $t('hid.device') }}</th>
          <th>{{ $t('interfaces.vidPid') }}</th>
          <th>{{ $t('hid.usages') }}</th>
          <th>{{ $t('hid.interface') }}</th>
          <th>{{ $t('hid.serial') }}</th>
          <th>{{ $t('hid.usbPort') }}</th>
          <th>{{ $t('hid.path') }}</th>
          <th>{{ $t('interfaces.rule') }}</th>
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
            <div v-if="item.usages.length > 1" class="muted">{{ $t('hid.severalCollections') }}</div>
            <div v-if="item.osOwned && osOwnedUnreadable" class="warn-text">{{ $t('hid.osOwned', { platform }) }}</div>
          </td>
          <td>{{ item.interfaceNumber }}</td>
          <td class="mono">{{ item.serialNumber || '—' }}</td>
          <td class="mono">{{ item.usbPort ?? '—' }}</td>
          <td class="mono path">
            {{ item.path }}
            <div v-if="item.transport === 'usb'"><span class="badge" :title="$t('hid.usbDirectHint')">{{ $t('hid.usbDirect') }}</span></div>
          </td>
          <td>
            <div v-for="rule in item.rules" :key="rule.name">
              {{ rule.name }}
              <span v-if="!rule.used" class="badge" :title="$t('interfaces.unusedHint')">{{ $t('interfaces.unused') }}</span>
              <span v-if="rule.conflict" class="badge error" :title="$t('interfaces.conflict')">{{ $t('interfaces.ignored') }}</span>
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
