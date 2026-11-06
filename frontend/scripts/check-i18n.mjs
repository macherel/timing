/**
 * Checks that every text key used in the frontend exists in src/locales/en.ts, the reference language (the type
 * check covers the other languages, typed against en.ts, but not the keys written in templates).
 *
 * Finds the literal keys of t('…'), $t('…') and keypath="…". Keys built at run time, like `pages.${page}`, are only
 * checked up to their fixed start. Run by `npm run build`, or alone with `node scripts/check-i18n.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');
const { default: en } = await import(path.join(SRC, 'locales/en.ts'));

function hasKey(key) {
  let node = en;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === 'string';
}

function hasPrefix(prefix) {
  let node = en;
  for (const part of prefix.split('.').filter(Boolean)) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === 'object';
}

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'locales') yield* sourceFiles(file);
    } else if (/\.(vue|ts)$/.test(entry.name)) {
      yield file;
    }
  }
}

const problems = [];
let checked = 0;
for (const file of sourceFiles(SRC)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const where = `${path.relative(SRC, file)}:${index + 1}`;
    for (const match of line.matchAll(/\$?\bt\(\s*'([\w.]+)'|keypath="([\w.]+)"/g)) {
      const key = match[1] ?? match[2];
      checked++;
      if (!hasKey(key)) problems.push(`${where}: unknown text key "${key}"`);
    }
    for (const match of line.matchAll(/\$?\bt\(\s*`([\w.]*)\$\{/g)) {
      checked++;
      if (!hasPrefix(match[1])) problems.push(`${where}: unknown text key group "${match[1]}"`);
    }
  });
}

if (problems.length > 0) {
  console.error(`${problems.length} text key problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`i18n: ${checked} text keys checked, all in src/locales/en.ts.`);
