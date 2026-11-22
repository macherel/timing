import { computed, ref } from 'vue';

/**
 * The administration lock (adminPassword in config.yaml): while it is locked, the menu hides the administration pages,
 * the event switcher hides the discipline settings, and the administration URLs lead to the race page.
 *
 * Unlocking gives a token from the server, remembered by this browser. The server says whether it still unlocks:
 * changing the password or restarting the app locks every browser again.
 */

const STORAGE_KEY = 'timing.adminToken';

// Whether config.yaml has a password, and whether this browser typed it. Unknown until the first check
const isProtected = ref(false);
const unlocked = ref(true);

export const lockProtected = computed(() => isProtected.value);
export const adminLocked = computed(() => isProtected.value && !unlocked.value);

function storedToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode or storage blocked: unlocked until the page is reloaded
  }
}

let memoryToken: string | null = null;

/** Asks the server whether a password is set and whether this browser is unlocked. Keeps the state on failure. */
export async function checkLock(): Promise<void> {
  const token = memoryToken ?? storedToken();
  try {
    const response = await fetch(`/api/admin/lock${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    if (!response.ok) return;
    const state: { protected: boolean; unlocked: boolean } = await response.json();
    isProtected.value = state.protected;
    unlocked.value = state.unlocked;
  } catch {
    // Server unreachable: keep the current state
  }
}

/** Sends the password typed. False when it is wrong. */
export async function unlockAdmin(password: string): Promise<boolean> {
  const response = await fetch('/api/admin/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { token } = await response.json();
  memoryToken = token;
  storeToken(token);
  isProtected.value = true;
  unlocked.value = true;
  return true;
}

export function lockAdmin(): void {
  memoryToken = null;
  storeToken(null);
  unlocked.value = false;
}
