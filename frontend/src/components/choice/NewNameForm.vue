<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

/**
 * "+ New …" on the home page: a discreet button that turns into a name field, to create an event or a discipline.
 * `create` returns why the name was refused, or null once created.
 */
const props = defineProps<{
  // Text of the button, e.g. "+ New event"
  label: string;
  // Name of the field, read by screen readers and shown as its placeholder
  fieldLabel: string;
  create: (name: string) => Promise<string | null>;
  // Opens with the field focused when it turns true, e.g. for the first discipline of an event just created
  initiallyOpen?: boolean;
}>();

const editing = ref(false);
const name = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);

async function start(): Promise<void> {
  editing.value = true;
  error.value = null;
  await nextTick();
  input.value?.focus();
}

function cancel(): void {
  editing.value = false;
  name.value = '';
  error.value = null;
}

async function submit(): Promise<void> {
  if (!name.value.trim() || busy.value) return;
  busy.value = true;
  try {
    error.value = await props.create(name.value.trim());
    if (error.value === null) cancel();
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.initiallyOpen,
  (open) => {
    if (open) start();
  },
  { immediate: true },
);
</script>

<template>
  <button v-if="!editing" type="button" class="add" @click="start">{{ label }}</button>
  <form v-else class="new-name" @submit.prevent="submit" @keydown.esc.stop="cancel">
    <div class="row">
      <input
        ref="input"
        v-model="name"
        type="text"
        maxlength="64"
        :placeholder="fieldLabel"
        :aria-label="fieldLabel"
        :aria-invalid="error !== null"
        @input="error = null"
      />
      <button type="submit" :disabled="busy || !name.trim()">{{ $t('choice.create') }}</button>
      <button type="button" class="secondary" @click="cancel">{{ $t('common.cancel') }}</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  </form>
</template>

<style scoped>
/* Discreet: a dashed outline, the same look as the things it adds */
.add {
  margin: 0;
  padding: 8px 14px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-muted);
}
.add:hover,
.add:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.row input {
  flex: 1;
  min-width: 160px;
}
.row button {
  margin: 0;
}
.alert {
  margin: 8px 0 0;
}
</style>
