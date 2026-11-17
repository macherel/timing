import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../src/locales/en';
import de from '../src/locales/de';
import fr from '../src/locales/fr';
import { i18n, locale, setLocale, t } from '../src/i18n';

/** Every key of a texts object, e.g. "race.reason.locked". */
function keys(messages: object, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === 'object' ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

/** The {placeholders} of a text, sorted. */
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('texts', () => {
  it('has the same keys in every language', () => {
    expect(keys(fr)).toEqual(keys(en));
    expect(keys(de)).toEqual(keys(en));
  });

  it('uses the same placeholders in every language', () => {
    const lookup = (messages: object, key: string) => key.split('.').reduce((node: any, part) => node[part], messages) as string;
    for (const key of keys(en)) {
      expect(placeholders(lookup(fr, key)), key).toEqual(placeholders(lookup(en, key)));
      expect(placeholders(lookup(de, key)), key).toEqual(placeholders(lookup(en, key)));
    }
  });

  it('compiles every text in every language (no stray { } @ $ |)', () => {
    for (const code of ['en', 'fr', 'de'] as const) {
      setLocale(code);
      for (const key of keys(en)) {
        // A text that cannot be compiled comes back as its key
        expect(t(key as any, { n: 2 }), `${code}: ${key}`).not.toBe(key);
      }
    }
  });
});

describe('plurals', () => {
  it('uses the plural for 0 in English and German, and the singular in French', () => {
    expect(t('config.problems', 0)).toBe('✘ 0 problems');
    expect(t('config.problems', 1)).toBe('✘ 1 problem');
    setLocale('fr');
    expect(t('config.problems', 0)).toBe('✘ 0 problème');
    expect(t('config.problems', 1)).toBe('✘ 1 problème');
    expect(t('config.problems', 2)).toBe('✘ 2 problèmes');
    setLocale('de');
    expect(t('config.problems', 0)).toBe('✘ 0 Probleme');
    expect(t('config.problems', 1)).toBe('✘ 1 Problem');
  });
});

describe('language choice', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is remembered in the browser and sets the page language', () => {
    setLocale('fr');
    expect(locale.value).toBe('fr');
    expect(localStorage.getItem('timing.locale')).toBe('fr');
    return vi.waitFor(() => expect(document.documentElement.lang).toBe('fr'));
  });

  it("starts with the remembered language, else the browser's, else English", async () => {
    const start = async (languages: string[], saved?: string) => {
      localStorage.clear();
      if (saved) localStorage.setItem('timing.locale', saved);
      vi.stubGlobal('navigator', { ...navigator, languages });
      vi.resetModules();
      return (await import('../src/i18n')).locale.value;
    };
    expect(await start(['es', 'fr-CA'])).toBe('fr');
    expect(await start(['de-AT', 'fr-CA'])).toBe('de');
    expect(await start(['fr-FR'], 'en')).toBe('en');
    expect(await start(['es', 'it'])).toBe('en');
    expect(await start(['en-GB'], 'klingon')).toBe('en');
  });

  it('falls back to English for a text missing in a language', () => {
    expect(i18n.global.fallbackLocale.value).toBe('en');
  });
});
