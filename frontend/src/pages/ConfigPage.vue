<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import type { ConfigFileResponse } from '../types';
import { useHardwareStatus } from '../composables/useHardwareStatus';
import {
  emptyForm,
  emptyDevice,
  groupProblems,
  toConfig,
  toForm,
  type ConfigForm,
} from '../config/configForm';
import DeviceEditor from '../components/config/DeviceEditor.vue';
import ToastMessage from '../components/ToastMessage.vue';

// Delay between the last change and the server-side validation
const VALIDATE_DELAY_MS = 300;
// How long the "Saved" confirmation stays visible; errors and warnings stay until the next action
const SAVED_MESSAGE_MS = 4000;
// Suggestions for trigger actions; only actions containing start, finish or click are recorded as crossings
const SUGGESTED_ACTIONS = ['start_crossed', 'finish_crossed'];

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
// Connected devices for the dropdowns, refreshed as the backend rescans (devices plugged or unplugged)
const { status: hardwareStatus } = useHardwareStatus();
const interfaces = computed(() => hardwareStatus.value?.interfaces ?? []);

const config = computed(() => toConfig(form.value));
const isDirty = computed(() => loaded.value && JSON.stringify(config.value) !== savedSnapshot.value);
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
  if (isDirty.value && !confirm('Discard your unsaved changes and reload the file?')) return;
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
  if (!confirm('Start from an empty form? Saving will replace the current config.yaml.')) return;
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
      message.value = { kind: 'ok', text: 'Saved. The app applies the new configuration within a second.' };
    } else if (response.status === 409) {
      conflict.value = true;
      message.value = {
        kind: 'warn',
        text: 'config.yaml was changed outside this page since it was loaded. Reload it, then redo your changes.',
      };
    } else {
      problems.value = body.problems ?? [];
      message.value = { kind: 'error', text: `Not saved (HTTP ${response.status}).` };
    }
  } catch (e) {
    message.value = { kind: 'error', text: `Not saved: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    saving.value = false;
  }
}

function addDevice(): void {
  form.value.devices.push(emptyDevice(`Device ${form.value.devices.length + 1}`));
}

const route = useRoute();
const router = useRouter();

/**
 * "Add to configuration" on the Diagnostics page opens /config?add=<vid>:<pid>&name=<product>:
 * adds a device with those IDs, left unsaved for the user to complete.
 */
function addDeviceFromLink(): void {
  const [vendorId, productId] = String(route.query.add ?? '').split(':');
  if (!vendorId || !productId) return;

  const device = emptyDevice(String(route.query.name || `Device ${form.value.devices.length + 1}`));
  device.vendorId = vendorId;
  device.productId = productId;
  form.value.devices.push(device);
  // Done once: a page reload must not add it again
  router.replace({ query: {} });
}

function removeDevice(index: number): void {
  const name = form.value.devices[index].name || `#${index + 1}`;
  if (confirm(`Remove device "${name}"?`)) form.value.devices.splice(index, 1);
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
        if (run === validationRun) problems.value = [`Cannot validate: ${e instanceof Error ? e.message : String(e)}`];
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

onBeforeRouteLeave(() => !isDirty.value || confirm('You have unsaved changes. Leave this page anyway?'));
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
        <button type="button" class="secondary" @click="load">Reload from disk</button>
        <button type="button" :disabled="!canSave" title="Ctrl+S" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </header>

    <p v-if="loadError" class="alert error">Cannot load the configuration: {{ loadError }}</p>

    <template v-if="loaded">
      <p class="muted">
        <span class="mono">{{ path }}</span>
        <span v-if="!fileExists"> · does not exist yet: saving creates it</span>
        <span v-else-if="isDirty"> · unsaved changes</span>
        <span v-else> · saved</span>
        <span v-if="!invalidFile">
          ·
          <span v-if="validating">checking…</span>
          <span v-else-if="problems.length === 0" class="ok-text">✔ valid</span>
          <span v-else class="error-text">✘ {{ problems.length }} problem(s)</span>
        </span>
      </p>

      <Teleport to="body">
        <Transition name="toast">
          <ToastMessage v-if="message" :kind="message.kind" @close="message = null">
            {{ message.text }}
            <button v-if="conflict" type="button" class="secondary inline" @click="load">Reload</button>
          </ToastMessage>
        </Transition>
      </Teleport>

      <section v-if="invalidFile">
        <div class="alert error">
          <p>config.yaml cannot be shown in the form because it is invalid:</p>
          <ul>
            <li v-for="problem in invalidFile.problems" :key="problem">{{ problem }}</li>
          </ul>
          <p>Fix it in a text editor and click "Reload from disk", or start over in the form.</p>
          <button type="button" class="secondary inline" @click="startOver">Start from an empty form</button>
        </div>
        <pre class="raw">{{ invalidFile.content }}</pre>
      </section>

      <template v-else>
        <p class="muted small">Saving rewrites config.yaml in a standard layout: comments in the file are not kept.</p>

        <ul v-if="groupedProblems.general.length > 0 && !validating" class="alert error problems">
          <li v-for="problem in groupedProblems.general" :key="problem">{{ problem }}</li>
        </ul>

        <section>
          <h2>Port</h2>
          <div class="row">
            <label class="field">
              <span>Port of the app</span>
              <input v-model="form.port" type="text" inputmode="numeric" class="short" placeholder="3001" />
            </label>
            <span class="muted small">
              Used when the app starts: restart it after a change, then open it at the new address. Empty for 3001.
              The --port option and the PORT environment variable take precedence.
            </span>
          </div>
        </section>

        <section>
          <h2>Sync</h2>
          <label class="switch">
            <input v-model="form.useSync" type="checkbox" />
            Sync the events with the other computers on the local network that have the same key
          </label>
          <div v-if="form.useSync" class="row">
            <label class="field">
              <span>Key</span>
              <input v-model="form.syncKey" type="text" placeholder="e.g. amber-otter-glide" />
            </label>
            <label class="field">
              <span>Name of this computer</span>
              <input v-model="form.syncName" type="text" placeholder="The computer name" />
            </label>
            <span class="muted small">Applied a few seconds after saving, no restart needed.</span>
          </div>
        </section>

        <section>
          <h2>Default interface</h2>
          <label class="switch">
            <input v-model="form.useDiscoveryFilter" type="checkbox" />
            Only use one HID interface of each device, unless the device below says otherwise
          </label>
          <div v-if="form.useDiscoveryFilter" class="row">
            <label class="field">
              <span>Usage page</span>
              <input v-model="form.discoveryUsagePage" type="text" inputmode="numeric" class="short" />
            </label>
            <label class="field">
              <span>Usage</span>
              <input v-model="form.discoveryUsage" type="text" inputmode="numeric" class="short" />
            </label>
            <span class="muted small">1 / 2 is a mouse, 1 / 6 a keyboard, 1 / 5 a gamepad.</span>
          </div>
        </section>

        <section>
          <h2>Devices</h2>
          <p v-if="form.devices.length === 0" class="muted">No device yet.</p>
          <p v-else class="muted small">
            When several entries match the same HID interface, the first one in this list is used. The device name
            identifies it in race events, so it must be unique.
          </p>
          <DeviceEditor
            v-for="(device, index) in form.devices"
            :key="device.key"
            v-model="form.devices[index]"
            :index="index"
            :count="form.devices.length"
            :problems="validating ? [] : (groupedProblems.byDevice.get(index) ?? [])"
            :interfaces="interfaces"
            @remove="removeDevice(index)"
            @move="moveDevice(index, $event)"
          />
          <button type="button" class="secondary" @click="addDevice">+ Add device</button>
        </section>
      </template>
    </template>

    <datalist id="trigger-actions">
      <option v-for="action in SUGGESTED_ACTIONS" :key="action" :value="action" />
    </datalist>
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
