<script setup lang="ts">
/**
 * A message floating in the bottom-right corner, above the page, so showing or hiding it does not move the layout.
 * Render it inside <Teleport to="body"> so no parent can clip or reposition it.
 */
defineProps<{ kind: 'ok' | 'error' | 'warn' }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="toast" :class="kind" :role="kind === 'ok' ? 'status' : 'alert'">
    <div class="content"><slot /></div>
    <button type="button" class="close" title="Close" @click="$emit('close')">✕</button>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  max-width: min(440px, calc(100vw - 32px));
  padding: 12px 12px 12px 16px;
  background: var(--surface);
  color: var(--text-h);
  border: 1px solid var(--border);
  border-left: 4px solid var(--accent);
  border-radius: 8px;
  box-shadow:
    rgba(0, 0, 0, 0.15) 0 10px 15px -3px,
    rgba(0, 0, 0, 0.08) 0 4px 6px -2px;
}
.toast.ok {
  border-left-color: var(--ok);
}
.toast.warn {
  border-left-color: var(--warn);
}
.toast.error {
  border-left-color: var(--error);
}
.content {
  flex: 1;
}
.close {
  padding: 0 6px;
  background: transparent;
  border: none;
  color: var(--text-muted);
}
.close:hover {
  color: var(--text-h);
}
</style>
