import { watch } from 'vue';
import { createI18n } from 'vue-i18n';
import de from './locales/de';
import en from './locales/en';
import fr from './locales/fr';

/**
 * Languages of the interface. The texts are in src/locales: en.ts is the reference, and each other language has the
 * same keys (its file is typed with Messages, so a missing or extra key fails the build).
 *
 * The language is chosen in the page menu and remembered in the browser. The first time, the browser's preferred
 * language is used when available, English otherwise. Texts sent by the backend (validation problems, device
 * hints) stay in English.
 *
 * To add a language: copy en.ts to <code>.ts, translate it, and add it to LOCALES and to messages below.
 */

export type Messages = typeof en;

// Checks the keys given to t() and $t()
declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends Messages {}
}

export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
] as const;
export type Locale = (typeof LOCALES)[number]['code'];

const STORAGE_KEY = 'timing.locale';

const isLocale = (code: unknown): code is Locale => LOCALES.some((locale) => locale.code === code);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Private window or blocked storage: use the browser's language
  }
  for (const language of navigator.languages ?? [navigator.language]) {
    const code = language.split('-')[0].toLowerCase();
    if (isLocale(code)) return code;
  }
  return 'en';
}

/** French uses the singular for 0 and 1 ("0 problème"), English the plural for 0 ("0 problems"). */
function frenchPlural(choice: number, choicesLength: number): number {
  const count = Math.abs(choice);
  if (choicesLength === 2) return count <= 1 ? 0 : 1;
  return Math.min(count, 2);
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { en, fr, de },
  pluralRules: { fr: frenchPlural },
});

/** For modules outside components (in components, use $t in templates and useI18n() in scripts). */
export const t = i18n.global.t;
export const locale = i18n.global.locale;

export function setLocale(code: Locale): void {
  locale.value = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // The choice is kept until the page is reloaded
  }
}

// Screen readers and the browser (spell checking, hyphenation) follow the page's language
watch(locale, (code) => (document.documentElement.lang = code), { immediate: true });
