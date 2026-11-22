import { ref } from 'vue';

/**
 * The keys of the disciplines timed by hand, kept as the KeyboardEvent.code of the browser: the key at that place on
 * the keyboard, whatever its layout (KeyA is the key of A on a QWERTY keyboard, of Q on an AZERTY one).
 */

// Keys with a name in each language
const NAMED = [
  'Space',
  'Enter',
  'NumpadEnter',
  'Backspace',
  'Tab',
  'Escape',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ContextMenu',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;

// What each key types on this keyboard, from the browser when it tells (Chrome and Edge, on localhost or HTTPS), so a
// letter is named as on the keyboard, e.g. KeyA is "Q" on an AZERTY keyboard
const layout = ref<Map<string, string> | null>(null);
const keyboardApi = (globalThis.navigator as { keyboard?: { getLayoutMap?: () => Promise<Iterable<[string, string]>> } } | undefined)?.keyboard;
keyboardApi
  ?.getLayoutMap?.()
  .then((map) => (layout.value = new Map(map)))
  .catch(() => undefined);

/**
 * Whether a key can be the trigger key of a discipline: any key the browser names (all but a few, e.g. Fn), except the
 * Windows key (Meta, OS in older browsers), whose release opens the Start menu of the system, which the page cannot stop.
 */
export const canTrigger = (code: string): boolean => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code) && !/^(Meta|OS)(Left|Right)$/.test(code);

/** Whether a key is a modifier (Shift, Ctrl, Alt, Meta): pressing it sets its own modifier flag on the event. */
export const isModifierKey = (code: string): boolean => /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);

/**
 * The name of a key to show, e.g. "Space" (translated by `t`), "A" for KeyA, "1" for Digit1. `key` is what the key
 * types on this keyboard, when known: it gives the right letter on any layout.
 */
export function keyLabel(code: string, t: (key: string) => string, key?: string): string {
  if ((NAMED as readonly string[]).includes(code)) return t(`keys.${code}`);
  const typed = key ?? layout.value?.get(code);
  if (typed && typed.length === 1 && typed !== ' ') return typed.toUpperCase();
  const match = /^(?:Key|Digit)(.)$/.exec(code);
  return match ? match[1] : code;
}
