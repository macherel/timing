import { afterEach } from 'vitest';
import { setLocale } from '../src/i18n';

// Tests read the English texts, whatever the language of the machine running them
setLocale('en');
afterEach(() => {
  setLocale('en');
  localStorage.clear();
});
