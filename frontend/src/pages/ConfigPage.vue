<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ConfigFileResponse, Gate, HidInterface, RecentReport } from '../types';
import { useHardwareStatus } from '../composables/useHardwareStatus';
import {
  emptyForm,
  emptyDevice,
  emptyLine,
  deviceInterfaces,
  findPressedButton,
  GATES,
  gateStatus,
  groupProblems,
  hex,
  parseHex,
  reportKey,
  toConfig,
  toForm,
  type ConfigForm,
  type DeviceForm,
  type GateStatus,
} from '../config/configForm';
import DeviceEditor from '../components/config/DeviceEditor.vue';
import LineEditor from '../components/config/LineEditor.vue';
import ToastMessage from '../components/ToastMessage.vue';

// Delay between the last change and the server-side validation
const VALIDATE_DELAY_MS = 300;
// How long the "Saved" confirmation stays visible; errors and warnings stay until the next action
const SAVED_MESSAGE_MS = 4000;
// How long the detection of a button waits for a press
const DETECT_TIMEOUT_MS = 20_000;

const { t } = useI18n();

const path = ref('');
const form = ref<ConfigForm>(emptyForm());
// The config as last loaded or saved, to know whether the form has unsaved changes
const savedSnapshot = ref('');
// Modification time of the file the page loaded, sent back on save to detect concurrent changes
const modifiedAt = ref<number | null>(null);
const fileExists = ref(false);
// Set when config.yaml exists but cannot be shown in the form
const invalidFile = ref<{ content: string; problems: string[] } | null>(null);
const loaded = ref(false);
const loadError = ref<string | null>(null);

const problems = ref<string[]>([]);
const validating = ref(false);
const saving = ref(false);
const message = ref<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;
watch(message, (current) => {
  clearTimeout(messageTimer);
  if (current?.kind === 'ok') messageTimer = setTimeout(() => (message.value = null), SAVED_MESSAGE_MS);
});
const conflict = ref(false);
// The gate waiting for a button press (see startDetection)
const detection = ref<{
  lineKey: number;
  gate: Gate;
  deviceKey: number;
  // Reports already received when the detection started
  known: Set<string> | null;
  startedAt: number;
  message: { kind: 'hint' | 'error'; text: string } | null;
} | null>(null);

// Connected devices for the dropdowns, refreshed as the backend rescans (devices plugged or unplugged). While a button
// is detected, its device is opened even if no saved line uses it yet, to read its reports
const detectedModel = computed(() => {
  const deviceKey = detection.value?.deviceKey;
  const device = form.value.devices.find((d) => d.key === deviceKey);
  if (!device) return null;
  const vendorId = parseHex(device.vendorId);
  const productId = parseHex(device.productId);
  if (vendorId === undefined || productId === undefined || Number.isNaN(vendorId) || Number.isNaN(productId)) return null;
  return `${hex(vendorId, 4)}:${hex(productId, 4)}`;
});
const { status: hardwareStatus } = useHardwareStatus(() => (detectedModel.value ? [detectedModel.value] : []));
// One entry per connected device model, replaced only when the list changes: the status is polled every second,
// and re-rendering the editors that often closes the open dropdowns (Windows)
const connectedModels = shallowRef<HidInterface[]>([]);
watch(hardwareStatus, (current) => {
  const models = new Map<string, HidInterface>();
  for (const item of current?.interfaces ?? []) models.set(`${item.vendorId}:${item.productId}`, item);
  const sorted = [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, model]) => model);
  const describe = (list: HidInterface[]) =>
    JSON.stringify(list.map((m) => [m.vendorId, m.productId, m.manufacturer, m.product]));
  if (describe(sorted) !== describe(connectedModels.value)) connectedModels.value = sorted;
});

const config = computed(() => toConfig(form.value));
const isDirty = computed(() => loaded.value && JSON.stringify(config.value) !== savedSnapshot.value);

// Whether the devices of each line can record its crossings right now, by line key. Replaced only when it changes,
// for the same reason as connectedModels
type LineStatus = Record<Gate, GateStatus>;
const lineStatuses = shallowRef(new Map<number, LineStatus>());
watch(
  [hardwareStatus, form, isDirty],
  () => {
    const next = new Map<number, LineStatus>(
      form.value.lines.map((line) => [
        line.key,
        {
          start: gateStatus(line, 'start', form.value.devices, hardwareStatus.value, isDirty.value),
          finish: gateStatus(line, 'finish', form.value.devices, hardwareStatus.value, isDirty.value),
        },
      ]),
    );
    if (JSON.stringify([...next]) !== JSON.stringify([...lineStatuses.value])) lineStatuses.value = next;
  },
  { deep: true, immediate: true },
);
const enabledLines = computed(() => form.value.lines.filter((line) => line.enabled));
const readyLines = computed(
  () => enabledLines.value.filter((line) => GATES.every((gate) => lineStatuses.value.get(line.key)?.[gate].state === 'ready')).length,
);
const hardwareChecked = computed(() => hardwareStatus.value !== null);
const groupedProblems = computed(() => groupProblems(problems.value));
const canSave = computed(
  () =>
    loaded.value &&
    !invalidFile.value &&
    (isDirty.value || !fileExists.value) &&
    problems.value.length === 0 &&
    !validating.value &&
    !saving.value,
);

async function load(): Promise<void> {
  if (isDirty.value && !confirm(t('config.confirmDiscard'))) return;
  stopDetection();
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file: ConfigFileResponse = await response.json();

    path.value = file.path;
    modifiedAt.value = file.modifiedAt;
    fileExists.value = file.modifiedAt !== null;
    invalidFile.value = file.config === null && file.content ? { content: file.content, problems: file.problems } : null;
    setForm(file.config ? toForm(file.config) : emptyForm());
    loadError.value = null;
    conflict.value = false;
    message.value = null;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

function setForm(newForm: ConfigForm): void {
  form.value = newForm;
  savedSnapshot.value = JSON.stringify(toConfig(newForm));
  loaded.value = true;
}

/** The file on disk is invalid: edit it in the form from scratch, overwriting it on save. */
function startOver(): void {
  if (!confirm(t('config.confirmStartOver'))) return;
  invalidFile.value = null;
  savedSnapshot.value = '';
}

async function save(): Promise<void> {
  saving.value = true;
  message.value = null;
  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: config.value, modifiedAt: modifiedAt.value }),
    });
    const body = await response.json();

    if (response.ok) {
      modifiedAt.value = body.modifiedAt;
      fileExists.value = true;
      savedSnapshot.value = JSON.stringify(config.value);
      message.value = { kind: 'ok', text: t('config.saved') };
    } else if (response.status === 409) {
      conflict.value = true;
      message.value = { kind: 'warn', text: t('config.conflict') };
    } else {
      problems.value = body.problems ?? [];
      message.value = { kind: 'error', text: t('config.notSavedHttp', { status: response.status }) };
    }
  } catch (e) {
    message.value = { kind: 'error', text: t('config.notSaved', { error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    saving.value = false;
  }
}

function addDevice(): void {
  form.value.devices.push(emptyDevice(t('config.defaultDeviceName', { n: form.value.devices.length + 1 })));
}

/** A new line, on the only device when there is one. */
function addLine(): void {
  const { lines, devices } = form.value;
  lines.push(emptyLine(t('config.defaultLineName', { n: lines.length + 1 }), devices.length === 1 ? devices[0].key : null));
}

function removeLine(index: number): void {
  const name = form.value.lines[index].name || `#${index + 1}`;
  if (!confirm(t('config.confirmRemoveLine', { name }))) return;
  if (detection.value?.lineKey === form.value.lines[index].key) stopDetection();
  form.value.lines.splice(index, 1);
}

function moveLine(index: number, delta: number): void {
  const [line] = form.value.lines.splice(index, 1);
  form.value.lines.splice(index + delta, 0, line);
}

/** Names of the lines that use a device, to show on the device. */
function linesUsing(device: DeviceForm): string[] {
  return form.value.lines
    .filter((line) => GATES.some((gate) => line[gate].deviceKey === device.key))
    .map((line, i) => line.name.trim() || `#${i + 1}`);
}

// ---------------------------------------------------------------------------
// Detection of a button: waits for a press on the device of a gate, and fills the gate's pattern with it
// ---------------------------------------------------------------------------


/** The recent reports of the connected interfaces of a device, oldest first, and why they cannot be read. */
function deviceReports(device: DeviceForm): { reports: { path: string; report: RecentReport }[]; failure: string | null; found: boolean } {
  const status = hardwareStatus.value;
  const interfaces = deviceInterfaces(device, status);
  const reports: { path: string; report: RecentReport }[] = [];
  let failure: string | null = null;
  for (const item of interfaces) {
    const state = status?.devices.find((d) => d.path === item.path) ?? item.monitor;
    if (state?.state === 'failing') failure = [state.error, state.hint].filter(Boolean).join(' ');
    for (const report of state?.recentReports ?? []) reports.push({ path: item.path, report });
  }
  return { reports, failure: reports.length === 0 ? failure : null, found: interfaces.length > 0 };
}

function startDetection(lineKey: number, gate: Gate): void {
  const line = form.value.lines.find((l) => l.key === lineKey);
  const deviceKey = line?.[gate].deviceKey;
  if (deviceKey == null) return;
  detection.value = { lineKey, gate, deviceKey, known: null, startedAt: Date.now(), message: { kind: 'hint', text: t('line.detectPress') } };
  checkDetection();
}

function stopDetection(): void {
  detection.value = null;
}

function checkDetection(): void {
  const current = detection.value;
  if (!current) return;
  const line = form.value.lines.find((l) => l.key === current.lineKey);
  const device = form.value.devices.find((d) => d.key === current.deviceKey);
  if (!line || !device || line[current.gate].deviceKey !== current.deviceKey) {
    stopDetection();
    return;
  }
  const { reports, failure, found } = deviceReports(device);
  // The reports already there were received before the click
  if (!current.known) {
    current.known = new Set(reports.map(({ path, report }) => reportKey(path, report)));
  }
  const button = findPressedButton(reports, current.known);
  if (button) {
    const gate = line[current.gate];
    gate.reportId = button.reportId === null ? '' : String(button.reportId);
    gate.byteIndex = String(button.byteIndex);
    gate.mask = hex(button.mask, 2);
    gate.value = hex(button.mask, 2);
    stopDetection();
  } else if (Date.now() - current.startedAt > DETECT_TIMEOUT_MS) {
    current.message = { kind: 'error', text: t('line.detectTimeout') };
  } else if (!found && hardwareStatus.value) {
    current.message = { kind: 'error', text: t('line.detectNotConnected') };
  } else if (failure) {
    current.message = { kind: 'error', text: t('line.detectCannotRead', { error: failure }) };
  } else {
    current.message = { kind: 'hint', text: t('line.detectPress') };
  }
}
watch(hardwareStatus, checkDetection);

const route = useRoute();
const router = useRouter();

/**
 * "Add to configuration" on the Diagnostics page opens /config?add=<vid>:<pid>&name=<product>:
 * adds a device with those IDs, left unsaved for the user to complete.
 */
function addDeviceFromLink(): void {
  const [vendorId, productId] = String(route.query.add ?? '').split(':');
  if (!vendorId || !productId) return;

  const device = emptyDevice(String(route.query.name || t('config.defaultDeviceName', { n: form.value.devices.length + 1 })));
  device.vendorId = vendorId;
  device.productId = productId;
  form.value.devices.push(device);
  // Done once: a page reload must not add it again
  router.replace({ query: {} });
}

function removeDevice(index: number): void {
  const device = form.value.devices[index];
  const name = device.name || `#${index + 1}`;
  const usedBy = linesUsing(device);
  const question = usedBy.length > 0 ? t('config.confirmRemoveUsed', { name, lines: usedBy.join(', ') }) : t('config.confirmRemove', { name });
  if (!confirm(question)) return;
  if (detection.value?.deviceKey === device.key) stopDetection();
  form.value.devices.splice(index, 1);
}

function moveDevice(index: number, delta: number): void {
  const [device] = form.value.devices.splice(index, 1);
  form.value.devices.splice(index + delta, 0, device);
}

// Server-side validation, so the rules are exactly the ones the app applies
let validateTimer: ReturnType<typeof setTimeout> | undefined;
let validationRun = 0;
watch(
  config,
  () => {
    clearTimeout(validateTimer);
    validating.value = true;
    validateTimer = setTimeout(async () => {
      const run = ++validationRun;
      try {
        const response = await fetch('/api/config/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: config.value }),
        });
        const body = await response.json();
        // An older request answering late must not overwrite a newer result
        if (run === validationRun) problems.value = body.problems ?? [];
      } catch (e) {
        if (run === validationRun) problems.value = [t('config.cannotValidate', { error: e instanceof Error ? e.message : String(e) })];
      } finally {
        if (run === validationRun) validating.value = false;
      }
    }, VALIDATE_DELAY_MS);
  },
  { deep: true },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (canSave.value) save();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (isDirty.value) event.preventDefault();
}

onBeforeRouteLeave(() => !isDirty.value || confirm(t('config.confirmLeave')));
onMounted(async () => {
  await load();
  if (loaded.value && !invalidFile.value) addDeviceFromLink();
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  clearTimeout(validateTimer);
  clearTimeout(messageTimer);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <main class="page">
    <!-- The page title is in the navigation bar -->
    <header class="page-header">
      <div class="actions">
        <button type="button" class="secondary" @click="load">{{ $t('config.reloadFromDisk') }}</button>
        <button type="button" :disabled="!canSave" title="Ctrl+S" @click="save">
          {{ saving ? $t('config.saving') : $t('common.save') }}
        </button>
      </div>
    </header>

    <p v-if="loadError" class="alert error">{{ $t('config.loadError', { error: loadError }) }}</p>

    <template v-if="loaded">
      <p class="muted">
        <span class="mono">{{ path }}</span>
        <span v-if="!fileExists"> · {{ $t('config.fileMissing') }}</span>
        <span v-else-if="isDirty"> · {{ $t('config.unsaved') }}</span>
        <span v-else> · {{ $t('config.savedState') }}</span>
        <span v-if="!invalidFile">
          ·
          <span v-if="validating">{{ $t('config.checking') }}</span>
          <span v-else-if="problems.length === 0" class="ok-text">{{ $t('config.valid') }}</span>
          <span v-else class="error-text">{{ $t('config.problems', problems.length) }}</span>
        </span>
        <span v-if="!invalidFile && enabledLines.length > 0 && hardwareChecked">
          ·
          <span :class="readyLines === enabledLines.length ? 'ok-text' : 'error-text'" data-testid="lines-ready">
            {{ $t('config.linesReady', { ready: readyLines, total: enabledLines.length }) }}
          </span>
        </span>
      </p>

      <Teleport to="body">
        <Transition name="toast">
          <ToastMessage v-if="message" :kind="message.kind" @close="message = null">
            {{ message.text }}
            <button v-if="conflict" type="button" class="secondary inline" @click="load">{{ $t('common.reload') }}</button>
          </ToastMessage>
        </Transition>
      </Teleport>

      <section v-if="invalidFile">
        <div class="alert error">
          <p>{{ $t('config.invalidFile') }}</p>
          <ul>
            <li v-for="problem in invalidFile.problems" :key="problem">{{ problem }}</li>
          </ul>
          <p>{{ $t('config.invalidFileFix', { button: $t('config.reloadFromDisk') }) }}</p>
          <button type="button" class="secondary inline" @click="startOver">{{ $t('config.startOver') }}</button>
        </div>
        <pre class="raw">{{ invalidFile.content }}</pre>
      </section>

      <template v-else>
        <p class="muted small">{{ $t('config.rewriteNote') }}</p>

        <ul v-if="groupedProblems.general.length > 0 && !validating" class="alert error problems">
          <li v-for="problem in groupedProblems.general" :key="problem">{{ problem }}</li>
        </ul>

        <section>
          <h2>{{ $t('config.lines') }}</h2>
          <p v-if="form.lines.length === 0" class="muted">{{ $t('config.noLine') }}</p>
          <p v-else class="muted small">{{ $t('config.linesHint') }}</p>
          <LineEditor
            v-for="(line, index) in form.lines"
            :key="line.key"
            v-model="form.lines[index]"
            :index="index"
            :count="form.lines.length"
            :problems="validating ? [] : (groupedProblems.byLine.get(index) ?? [])"
            :devices="form.devices"
            :status="lineStatuses.get(line.key) ?? null"
            :detecting="detection?.lineKey === line.key ? detection.gate : null"
            :detect-message="detection?.lineKey === line.key ? detection.message : null"
            @remove="removeLine(index)"
            @move="moveLine(index, $event)"
            @detect="startDetection(line.key, $event)"
            @stop-detect="stopDetection"
          />
          <button type="button" class="secondary" @click="addLine">{{ $t('config.addLine') }}</button>
        </section>

        <section>
          <h2>{{ $t('config.devices') }}</h2>
          <p v-if="form.devices.length === 0" class="muted">{{ $t('config.noDevice') }}</p>
          <p v-else class="muted small">{{ $t('config.devicesHint') }}</p>
          <DeviceEditor
            v-for="(device, index) in form.devices"
            :key="device.key"
            v-model="form.devices[index]"
            :index="index"
            :count="form.devices.length"
            :problems="validating ? [] : (groupedProblems.byDevice.get(index) ?? [])"
            :connected-models="connectedModels"
            :used-by="linesUsing(device)"
            @remove="removeDevice(index)"
            @move="moveDevice(index, $event)"
          />
          <button type="button" class="secondary" @click="addDevice">{{ $t('config.addDevice') }}</button>
        </section>

        <section>
          <h2>{{ $t('config.port.title') }}</h2>
          <div class="row">
            <label class="field">
              <span>{{ $t('config.port.label') }}</span>
              <input v-model="form.port" type="text" inputmode="numeric" class="short" placeholder="3001" />
            </label>
            <span class="muted small">{{ $t('config.port.hint') }}</span>
          </div>
        </section>

        <section>
          <h2>{{ $t('config.sync.title') }}</h2>
          <label class="switch">
            <input v-model="form.useSync" type="checkbox" />
            {{ $t('config.sync.enable') }}
          </label>
          <div v-if="form.useSync" class="row">
            <label class="field">
              <span>{{ $t('config.sync.key') }}</span>
              <input v-model="form.syncKey" type="text" :placeholder="$t('config.sync.keyPlaceholder')" />
            </label>
            <label class="field">
              <span>{{ $t('config.sync.name') }}</span>
              <input v-model="form.syncName" type="text" :placeholder="$t('config.sync.namePlaceholder')" />
            </label>
            <span class="muted small">{{ $t('config.sync.hint') }}</span>
          </div>
        </section>

        <section>
          <h2>{{ $t('config.discovery.title') }}</h2>
          <label class="switch">
            <input v-model="form.useDiscoveryFilter" type="checkbox" />
            {{ $t('config.discovery.enable') }}
          </label>
          <div v-if="form.useDiscoveryFilter" class="row">
            <label class="field">
              <span>{{ $t('hid.usagePage') }}</span>
              <input v-model="form.discoveryUsagePage" type="text" inputmode="numeric" class="short" />
            </label>
            <label class="field">
              <span>{{ $t('hid.usage') }}</span>
              <input v-model="form.discoveryUsage" type="text" inputmode="numeric" class="short" />
            </label>
            <span class="muted small">{{ $t('config.discovery.hint') }}</span>
          </div>
        </section>

      </template>
    </template>

  </main>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 8px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
  margin-top: 12px;
}
.small {
  font-size: 0.85em;
}
.ok-text {
  color: var(--ok);
}
.error-text {
  color: var(--error);
}
.problems {
  padding-left: 32px;
}
.raw {
  font-family: var(--mono);
  font-size: 0.85em;
  padding: 12px;
  background: var(--code-bg);
  border-radius: 6px;
  overflow-x: auto;
}
button.inline {
  padding: 2px 10px;
}
/* The toast is teleported to <body>, so its transition classes are not scoped */
:global(.toast-enter-active),
:global(.toast-leave-active) {
  transition:
    opacity 0.2s,
    transform 0.2s;
}
:global(.toast-enter-from),
:global(.toast-leave-to) {
  opacity: 0;
  transform: translateY(8px);
}
</style>
