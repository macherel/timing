<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useHardwareStatus } from '../composables/useHardwareStatus';
import { useRaceSocket } from '../composables/useRaceSocket';
import { formatTime } from '../format';
import InterfacesTable from '../components/InterfacesTable.vue';
import DeviceCard from '../components/DeviceCard.vue';
import RaceEventLog from '../components/RaceEventLog.vue';
import UnconfiguredDeviceCard from '../components/UnconfiguredDeviceCard.vue';
import type { DeviceStatus, HidInterface } from '../types';

const { status, error, paused, lastUpdate } = useHardwareStatus();
const { connected, events, clear } = useRaceSocket();

// One tab per configured device (keyed by name), then one per connected device model that no configured device
// uses (keyed by VID:PID). Keys survive the status refreshes, so the selected tab stays selected.
type DeviceTab =
  | { key: string; label: string; kind: 'configured'; device: DeviceStatus }
  | { key: string; label: string; kind: 'unconfigured'; interfaces: HidInterface[] };

const tabs = computed<DeviceTab[]>(() => {
  if (!status.value) return [];
  const configured: DeviceTab[] = status.value.devices.map((device) => ({
    key: `configured:${device.deviceName}`,
    label: device.deviceName,
    kind: 'configured',
    device,
  }));

  const models = new Map<string, HidInterface[]>();
  for (const item of status.value.interfaces) {
    const id = `${item.vendorId}:${item.productId}`;
    models.set(id, [...(models.get(id) ?? []), item]);
  }
  const unconfigured: DeviceTab[] = [...models]
    .filter(([, interfaces]) => interfaces.every((i) => i.rules.length === 0))
    .map(([id, interfaces]) => ({
      key: `unconfigured:${id}`,
      label: interfaces[0].product || id,
      kind: 'unconfigured' as const,
      interfaces,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...configured, ...unconfigured];
});

const selectedKey = ref<string | null>(null);
const selectedTab = computed(() => tabs.value.find((t) => t.key === selectedKey.value) ?? tabs.value[0]);
const tabList = ref<HTMLElement | null>(null);

// Arrow keys, Home and End move between tabs, as in any tab list
async function onTabKeydown(event: KeyboardEvent, index: number): Promise<void> {
  const last = tabs.value.length - 1;
  const target = {
    ArrowRight: index === last ? 0 : index + 1,
    ArrowLeft: index === 0 ? last : index - 1,
    Home: 0,
    End: last,
  }[event.key];
  if (target === undefined) return;

  event.preventDefault();
  selectedKey.value = tabs.value[target].key;
  await nextTick();
  tabList.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}
</script>

<template>
  <main class="page">
    <!-- The page title is in the navigation bar -->
    <header class="page-header">
      <button type="button" @click="paused = !paused">{{ paused ? $t('diagnostics.resume') : $t('diagnostics.pause') }}</button>
    </header>

    <section class="summary">
      <div>
        <span class="label">{{ $t('diagnostics.backend') }}</span>
        <span class="badge" :class="error ? 'error' : status ? 'ok' : ''">
          {{ error ? $t('diagnostics.unreachable', { error }) : status ? $t('diagnostics.online') : $t('diagnostics.connecting') }}
        </span>
      </div>
      <div>
        <span class="label">{{ $t('diagnostics.liveEvents') }}</span>
        <span class="badge" :class="connected ? 'ok' : 'error'">{{ connected ? $t('diagnostics.connected') : $t('diagnostics.disconnected') }}</span>
      </div>
      <div v-if="status">
        <span class="label">{{ $t('diagnostics.platform') }}</span>
        <span class="badge">{{ status.platform }}</span>
      </div>
      <div v-if="status">
        <span class="label">config.yaml</span>
        <span class="badge" :class="status.configValid ? 'ok' : 'error'">
          {{ status.configValid ? $t('diagnostics.configValid') : $t('diagnostics.configInvalid') }}
        </span>
        <span class="mono muted">{{ status.configPath }}</span>
        <RouterLink to="/config">{{ $t('diagnostics.editConfig') }}</RouterLink>
      </div>
      <div v-if="status?.lastScanAt">
        <span class="label">{{ $t('diagnostics.lastScan') }}</span>
        <span>{{ formatTime(status.lastScanAt) }}</span>
      </div>
      <div v-if="lastUpdate">
        <span class="label">{{ $t('diagnostics.pageUpdated') }}</span>
        <span>{{ lastUpdate.toLocaleTimeString($i18n.locale) }}{{ paused ? ` ${$t('diagnostics.paused')}` : '' }}</span>
      </div>
    </section>

    <template v-if="status">
      <section>
        <h2>{{ $t('diagnostics.devices') }}</h2>
        <p v-if="tabs.length === 0" class="muted">{{ $t('diagnostics.noHid') }}</p>
        <template v-else>
          <p v-if="status.devices.length === 0" class="muted">{{ $t('diagnostics.noneOpen') }}</p>
          <div ref="tabList" class="tabs" role="tablist" :aria-label="$t('diagnostics.devices')">
            <button
              v-for="(tab, index) in tabs"
              :id="`device-tab-${index}`"
              :key="tab.key"
              type="button"
              role="tab"
              class="tab"
              :class="{ unconfigured: tab.kind === 'unconfigured', 'first-unconfigured': tab.kind === 'unconfigured' && tabs[index - 1]?.kind === 'configured' }"
              :aria-selected="tab === selectedTab"
              :tabindex="tab === selectedTab ? 0 : -1"
              aria-controls="device-panel"
              @click="selectedKey = tab.key"
              @keydown="onTabKeydown($event, index)"
            >
              <span
                class="dot"
                :class="tab.kind === 'configured' ? tab.device.state : ''"
                :title="tab.kind === 'configured' ? $t(`hid.states.${tab.device.state}`) : $t('hid.notConfigured')"
              ></span>
              {{ tab.label }}
            </button>
          </div>
          <div
            v-if="selectedTab"
            id="device-panel"
            role="tabpanel"
            class="tab-panel"
            :aria-labelledby="`device-tab-${tabs.indexOf(selectedTab)}`"
          >
            <DeviceCard v-if="selectedTab.kind === 'configured'" :device="selectedTab.device" />
            <UnconfiguredDeviceCard v-else :interfaces="selectedTab.interfaces" :platform="status.platform" />
          </div>
        </template>
      </section>

      <section v-if="status.unmatchedRules.length > 0">
        <h2>{{ $t('diagnostics.configProblems') }}</h2>
        <pre v-for="explanation in status.unmatchedRules" :key="explanation" class="alert warn">{{ explanation }}</pre>
      </section>

      <section>
        <h2>{{ $t('diagnostics.raceEvents') }}</h2>
        <button v-if="events.length > 0" type="button" class="secondary" @click="clear">{{ $t('common.clear') }}</button>
        <RaceEventLog :events="events" />
      </section>

      <section>
        <h2>{{ $t('diagnostics.hidTitle') }}</h2>
        <i18n-t keypath="diagnostics.hidHint" tag="p" class="muted">
          <template #config><code>config.yaml</code></template>
          <template #command><code>npm run diagnose -- --listen &lt;vid:pid&gt;</code></template>
        </i18n-t>
        <InterfacesTable :interfaces="status.interfaces" :platform="status.platform" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin-bottom: -1px;
  white-space: nowrap;
  background: transparent;
  color: var(--text);
  border: 1px solid transparent;
  border-radius: 8px 8px 0 0;
}
.tab.unconfigured {
  color: var(--text-muted);
}
/* Separates the configured devices from the others */
.tab.first-unconfigured {
  margin-left: 12px;
}
.tab:hover {
  background: var(--accent-bg);
}
.tab[aria-selected='true'] {
  color: var(--text-h);
  font-weight: 600;
  background: var(--surface);
  border-color: var(--border);
  border-bottom-color: var(--surface);
}
.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.dot.listening {
  background: var(--ok);
}
.dot.failing {
  background: var(--error);
}
/* The selected tab and its card read as one block */
.tab-panel :deep(.card) {
  border-top: none;
  border-radius: 0 0 8px 8px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
}
.summary > div {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.label {
  font-size: 0.8em;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
pre.alert {
  white-space: pre-wrap;
  font-family: var(--mono);
  font-size: 0.85em;
}
</style>
