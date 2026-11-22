<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { usePopover } from '../../composables/usePopover';
import { adminLocked, lockAdmin, lockProtected, unlockAdmin } from '../../adminLock';

/**
 * Discreet padlock at the right of the navigation bar, only when config.yaml has an adminPassword: locks the
 * administration, or asks for the password to unlock it.
 */
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const { open, close } = usePopover(root, button);
const password = ref('');
const wrong = ref(false);
const failed = ref<string | null>(null);
const checking = ref(false);

watch(open, async (isOpen) => {
  password.value = '';
  wrong.value = false;
  failed.value = null;
  if (!isOpen) return;
  await nextTick();
  input.value?.focus();
});

function onClick(): void {
  if (adminLocked.value) open.value = !open.value;
  else lockAdmin();
}

async function submit(): Promise<void> {
  checking.value = true;
  failed.value = null;
  try {
    wrong.value = !(await unlockAdmin(password.value));
    if (wrong.value) {
      password.value = '';
      input.value?.focus();
    } else {
      close();
    }
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div v-if="lockProtected" ref="root" class="lock">
    <button
      ref="button"
      type="button"
      class="lock-button"
      :class="{ unlocked: !adminLocked }"
      :title="adminLocked ? $t('lock.unlockTitle') : $t('lock.lockTitle')"
      :aria-label="adminLocked ? $t('lock.unlockTitle') : $t('lock.lockTitle')"
      :aria-expanded="adminLocked ? open : undefined"
      data-testid="lock-button"
      @click="onClick"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
        <path
          :d="adminLocked ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 5.8-1'"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <form v-if="open && adminLocked" class="panel" role="dialog" :aria-label="$t('lock.panelLabel')" @submit.prevent="submit">
      <label class="field">
        {{ $t('lock.password') }}
        <input ref="input" v-model="password" type="password" autocomplete="current-password" :aria-invalid="wrong" />
      </label>
      <p v-if="wrong" class="error small">{{ $t('lock.wrong') }}</p>
      <p v-if="failed" class="error small">{{ $t('lock.failed', { error: failed }) }}</p>
      <button type="submit" :disabled="checking || password === ''">{{ $t('lock.unlock') }}</button>
    </form>
  </div>
</template>

<style scoped>
.lock {
  position: relative;
}
/* Discreet: a faded padlock, clearer on hover */
.lock-button {
  display: inline-flex;
  margin: 0;
  padding: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  opacity: 0.35;
}
.lock-button:hover,
.lock-button:focus-visible,
.lock-button[aria-expanded='true'] {
  opacity: 1;
}
.lock-button.unlocked {
  opacity: 0.6;
}
.panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 220px;
  max-width: calc(100vw - 32px);
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.panel p {
  margin: 0;
}
.panel input {
  width: 100%;
}
.error {
  color: var(--error);
}
.small {
  font-size: 0.85em;
}
</style>
