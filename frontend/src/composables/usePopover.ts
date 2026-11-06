import { onMounted, onUnmounted, ref, type Ref } from 'vue';

/**
 * Open state of a dropdown: closes on Escape (giving the focus back to its button) and on a click outside `root`.
 */
export function usePopover(root: Ref<HTMLElement | null>, button: Ref<HTMLElement | null>, open = ref(false)) {
  function onPointerDown(event: PointerEvent): void {
    if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (open.value && event.key === 'Escape') {
      open.value = false;
      button.value?.focus();
    }
  }
  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
  });
  onUnmounted(() => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
  });
  return { open, toggle: () => (open.value = !open.value), close: () => (open.value = false) };
}
