import { ref } from 'vue';

/**
 * The manual line of this tab: each tab of the race page that times by hand or measures a distance takes its own, so
 * several participants can run at once on one computer (same names as the backend's lines.ts). The first free one is
 * taken, "Manuel", then "Manuel 2"…, and held with a Web Lock until the tab closes, so no other tab takes it. A reload
 * takes the same one again (remembered for the tab). Without Web Locks (e.g. a page opened from another computer over
 * plain HTTP), and when all are taken, the tab uses "Manuel".
 */

export const MANUAL_LINE = 'Manuel';
export const MAX_MANUAL_LINES = 9;
const STORAGE_KEY = 'timing.manualLine';
const LOCK_PREFIX = 'timing.manualLine.';

/** The name of the nth manual line (from 1): "Manuel", "Manuel 2"… */
export function manualLineName(n: number): string {
  return n === 1 ? MANUAL_LINE : `${MANUAL_LINE} ${n}`;
}

// null until claimed
export const manualLine = ref<string | null>(null);

let claiming: Promise<void> | null = null;

/** Takes a manual line for this tab, once; later calls wait for the same one. */
export function claimManualLine(): Promise<void> {
  claiming ??= claim();
  return claiming;
}

async function claim(): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    manualLine.value = MANUAL_LINE;
    return;
  }
  const preferred = remembered();
  const numbers = Array.from({ length: MAX_MANUAL_LINES }, (_, i) => i + 1);
  const order = preferred === null ? numbers : [preferred, ...numbers.filter((n) => n !== preferred)];
  for (const n of order) {
    if (await hold(locks, n)) {
      manualLine.value = manualLineName(n);
      try {
        sessionStorage.setItem(STORAGE_KEY, String(n));
      } catch {
        // Not remembered: a reload takes the first free one
      }
      return;
    }
  }
  manualLine.value = MANUAL_LINE;
}

/** Holds the lock of the nth manual line until the tab closes, if no other tab holds it. */
function hold(locks: LockManager, n: number): Promise<boolean> {
  return new Promise((resolve) => {
    locks
      .request(`${LOCK_PREFIX}${n}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Never settled: held for the life of the tab
        return lock === null ? undefined : new Promise<void>(() => {});
      })
      .catch(() => resolve(false));
  });
}

function remembered(): number | null {
  try {
    const n = Number(sessionStorage.getItem(STORAGE_KEY));
    return Number.isInteger(n) && n >= 1 && n <= MAX_MANUAL_LINES ? n : null;
  } catch {
    return null;
  }
}
