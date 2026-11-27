import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from './env';
import { chooseLine, readFile, resetServer, resetWorkDir, writeFiles } from './helpers';

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

test('replaces the participant files of a discipline that has several, but adds none', async ({ page }) => {
  await page.goto('/CFM26/100m/config');
  await expect(page.getByRole('tab', { name: 'Basic settings' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/data$/);
  const panel = page.getByRole('region', { name: 'Participants' });
  await expect(panel.locator('tbody .mono')).toHaveText(['men.csv', 'women.csv']);
  await expect(panel).toContainText('3 participants in all.');
  await expect(page.getByRole('button', { name: /Send the participant file/ })).toHaveCount(0);

  // Replace a file from its row, whatever the name of the file chosen
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('row', { name: /women\.csv/ }).getByRole('button', { name: 'Replace…' }).click();
  await (await chooser).setFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n12;Léa Martin\n13;Inès Roux\n') });
  await expect(page.getByRole('status')).toHaveText('women.csv replaced.');
  await expect(panel).toContainText('4 participants in all.');
  await expect(panel.locator('tbody .mono')).toHaveText(['men.csv', 'women.csv']);

  const download = page.waitForEvent('download');
  await panel.getByRole('row', { name: /men\.csv/ }).first().getByRole('link', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('men.csv');
});

test('adds, changes and removes participants by hand, keeping the results', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:12Z;OK;2026-11-05T10:00:12Z\n',
  });
  await page.goto('/CFM26/100m/config/data');
  const list = page.getByRole('region', { name: 'Participant list' });
  const row = (name: RegExp) => list.getByRole('row', { name });
  // Folded at first
  await expect(list.getByRole('button', { name: '+ Add a participant' })).toBeHidden();
  await list.getByText('Participant list').click();
  await expect(list.locator('tbody tr')).toHaveCount(3);

  // Added to the file chosen, with a category: the file gets a category column
  await list.getByRole('button', { name: '+ Add a participant' }).click();
  await list.getByLabel('Bib', { exact: true }).fill('30');
  await list.getByLabel('Name', { exact: true }).fill('Zoé Petit');
  await list.getByLabel('Category', { exact: true }).fill('Junior F');
  await list.getByLabel('File', { exact: true }).selectOption('women.csv');
  await list.getByLabel('Category', { exact: true }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('30 Zoé Petit added.');
  await expect(row(/Zoé Petit/)).toContainText('Junior F');
  expect(readFile('CFM26/100m/women.csv')).toBe('bib;name;Category\n12;Léa Martin\n30;Zoé Petit;Junior F\n');
  await expect(page.getByRole('region', { name: 'Participants' })).toContainText('4 participants in all.');

  // A participant with runs keeps their bib and cannot be removed, but their name can change
  await expect(row(/Hugo Guérin/).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await row(/Hugo Guérin/).getByRole('button', { name: 'Edit' }).click();
  await expect(list.getByLabel('Bib', { exact: true })).toBeDisabled();
  await list.getByLabel('Name', { exact: true }).fill('Hugo Guérin-Roy');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('7 Hugo Guérin-Roy saved.');
  expect(readFile('CFM26/100m/men.csv')).toBe('bib;name\n7;Hugo Guérin-Roy\n21;Jean-Luc Martin\n');

  // Escape cancels a change
  await row(/Jean-Luc Martin/).getByRole('button', { name: 'Edit' }).click();
  await list.getByLabel('Name', { exact: true }).fill('Nobody');
  await list.getByLabel('Name', { exact: true }).press('Escape');
  await expect(row(/Jean-Luc Martin/)).toBeVisible();

  // A bib already used is refused
  await row(/Jean-Luc Martin/).getByRole('button', { name: 'Edit' }).click();
  await list.getByLabel('Bib', { exact: true }).fill('12');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toHaveText('Cannot change the participants: Bib 12 is already used.');
  await list.getByRole('button', { name: 'Cancel' }).click();

  page.once('dialog', (dialog) => dialog.accept());
  await row(/Jean-Luc Martin/).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status')).toHaveText('21 Jean-Luc Martin removed.');
  await expect(list.locator('tbody tr')).toHaveCount(3);

  await list.getByPlaceholder('Search a bib or a name').fill('zoe');
  await expect(list.locator('tbody tr')).toHaveCount(1);

  // The results are kept
  expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toContain('7;Hugo Guérin;');
});

test('saves the first participant file of a discipline as <event>-<discipline>-competitors.csv, then replaces it', async ({ page }) => {
  writeFiles({ 'CFM26/200m/config.yaml': 'access: auto\n' });
  // The address of the former participants tab opens the data tab
  await page.goto('/CFM26/200m/config/participants');
  await expect(page).toHaveURL(/\/CFM26\/200m\/config\/data$/);
  await expect(page.getByText('No participant file yet')).toBeVisible();

  await page.getByTestId('add-participant-file').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n30;Zoé Petit\n') });
  await expect(page.getByRole('status')).toHaveText('CFM26-200m-competitors.csv added.');
  const panel = page.getByRole('region', { name: 'Participants' });
  await expect(panel.locator('tbody .mono')).toHaveText(['CFM26-200m-competitors.csv']);
  await expect(panel).toContainText('1 participant in all.');
  expect(readFile('CFM26/200m/CFM26-200m-competitors.csv')).toBe('bib;name\n30;Zoé Petit\n');
  // A single file: no other one
  await expect(page.getByRole('button', { name: /Send the participant file/ })).toHaveCount(0);

  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Replace…' }).click();
  await (await chooser).setFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n30;Zoé Petit\n31;Paul Roux\n') });
  await expect(page.getByRole('status')).toHaveText('CFM26-200m-competitors.csv replaced.');
  await expect(panel).toContainText('2 participants in all.');

  // The race page has the new participants
  await page.goto('/CFM26/200m/race');
  await chooseLine(page);
  await expect(page.getByText('Participant (2)')).toBeVisible();
});

test('resets the results, after a backup with the participants and a confirmation, when the participants change', async ({ page }) => {
  const run = '7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;PC;Line 1;2026-11-05T10:00:10Z';
  writeFiles({ 'CFM26/100m/CFM26-100m-results.csv': `bib;name;start;finish;status;computer;line;updated\n${run}\n` });
  await page.goto('/CFM26/100m/config/data');
  const panel = page.getByRole('region', { name: 'Participants' });
  const backups = page.getByRole('region', { name: 'Backups' });
  await expect(backups).toContainText('No backup yet.');

  // Declined: nothing changes
  page.once('dialog', (dialog) => dialog.dismiss());
  let chooser = page.waitForEvent('filechooser');
  await panel.getByRole('row', { name: /women\.csv/ }).getByRole('button', { name: 'Replace…' }).click();
  await (await chooser).setFiles({ name: 'women.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n13;Inès Roux\n') });
  await expect(panel).toContainText('3 participants in all.');
  expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toContain(run);

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('resets the results');
    dialog.accept();
  });
  chooser = page.waitForEvent('filechooser');
  await panel.getByRole('row', { name: /women\.csv/ }).getByRole('button', { name: 'Replace…' }).click();
  await (await chooser).setFiles({ name: 'women.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n13;Inès Roux\n') });
  await expect(page.getByRole('status')).toHaveText('women.csv replaced.');
  expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBeNull();

  // The backup holds the results and the participants they were timed for
  const backup = backups.locator('summary', { hasText: /^Results of / });
  await expect(backup).toHaveCount(1);
  // Folded at first
  await expect(backups.locator('tbody .mono').first()).toBeHidden();
  await backup.click();
  // Each file suffixed by the date of the backup
  const [folder] = fs.readdirSync(path.join(WORK_DIR, 'CFM26/100m/backup'));
  await expect(backups.locator('tbody .mono')).toHaveText(
    ['CFM26-100m-results', 'CFM26-100m-uda-results', 'CFM26-100m-men', 'CFM26-100m-women'].map((name) => `${name}-${folder}.csv`),
  );
  const download = page.waitForEvent('download');
  await backups.getByRole('row', { name: /CFM26-100m-women-/ }).getByRole('link', { name: 'Download' }).click();
  const saved = await (await download).path();
  expect(fs.readFileSync(saved, 'utf8')).toContain('Léa Martin');
  expect((await download).suggestedFilename()).toBe(`CFM26-100m-women-${folder}.csv`);
  expect(readFile(`CFM26/100m/backup/${folder}/CFM26-100m-results-${folder}.csv`)).toContain(run.replace(';OK;', ';;OK;'));
  expect(readFile(`CFM26/100m/backup/${folder}/CFM26-100m-uda-results-${folder}.csv`)).toContain('7,,0,10,0');
});

test('downloads the results of a discipline, and keeps the settings changed in another tab', async ({ page }) => {
  await page.goto('/CFM26/100m/config/results');
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/data$/);
  await expect(page.getByText('No result yet')).toBeVisible();

  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n',
  });
  await page.reload();
  const row = page.getByRole('row', { name: /CFM26-100m-results\.csv/ });
  await expect(row).toContainText('Every run');
  const download = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('CFM26-100m-results.csv');

  // A change of the settings stays while another tab is shown
  await page.getByRole('tab', { name: 'Advanced settings' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/advanced$/);
  await page.getByText('Thousandth', { exact: true }).click();
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('tab', { name: 'Basic settings' }).click();
  await expect(page.getByText('Thousandth', { exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Advanced settings' }).click();
  await expect(page.getByRole('radio', { name: 'Thousandth' })).toBeChecked();
});

test('writes the UDA export from columns set one by one in the export tab, previewed before they are saved', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:01:10.25Z;OK;2026-11-05T10:01:10Z\n12;Léa Martin;2026-11-05T10:02:00Z;2026-11-05T10:02:30Z;DQ;2026-11-05T10:02:30Z\n',
  });
  await page.goto('/CFM26/100m/config/export');
  await expect(page.getByRole('tab', { name: 'UDA export' })).toHaveAttribute('aria-selected', 'true');
  // The columns of the UDA format until they are changed
  const values = page.getByTestId('uda-column-value');
  await expect(values).toHaveCount(5);
  await expect(page.getByTestId('uda-preview')).toHaveText('7,,1,10,25\n12,DQ,0,0,0\n21,DNF,0,0,0');
  await expect(page.getByTestId('uda-reset-columns')).toHaveCount(0);

  // Two columns removed, one changed, one added, and a header line of their titles
  await page.getByRole('button', { name: 'Remove column 5' }).click();
  await page.getByRole('button', { name: 'Remove column 4' }).click();
  await page.getByLabel('Value of column 3').fill('{if status == "OK"}{minutes * 60 + seconds}.{pad(fraction, 2)}{end}');
  await page.getByLabel('Value of column 2').fill('{status}');
  await page.getByTestId('uda-add-column').click();
  await page.getByLabel('Value of column 4').fill('{rank}');
  await expect(page.getByLabel('Title of column 1')).toHaveCount(0);
  await page.getByTestId('uda-header').check();
  for (const [n, title] of [[1, 'Bib'], [2, 'Status'], [3, 'Time'], [4, 'Rank']] as const) await page.getByLabel(`Title of column ${n}`).fill(title);
  await page.getByTestId('uda-separator').selectOption({ label: 'Semicolon (;)' });
  await page.getByTestId('uda-sort').fill('-bib');
  await expect(page.getByTestId('uda-preview')).toHaveText('Bib;Status;Time;Rank\n21;DNS;;\n12;DQ;;\n7;OK;70.25;1');

  // Moved: the rank second
  await page.getByRole('button', { name: 'Move column 4 up' }).click();
  await page.getByRole('button', { name: 'Move column 3 up' }).click();
  await expect(page.getByTestId('uda-preview')).toHaveText('Bib;Rank;Status;Time\n21;;DNS;\n12;;DQ;\n7;1;OK;70.25');

  // A mistake is shown on its column, and refused on save
  await page.getByLabel('Value of column 2').fill('{nope}');
  await expect(page.getByTestId('uda-problems')).toContainText('udaColumns column 2 value: unknown variable "nope" (character 2)');
  await expect(page.getByLabel('Value of column 2')).toHaveClass(/wrong/);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Cannot save the settings: udaColumns column 2 value: unknown variable/)).toBeVisible();

  await page.getByLabel('Value of column 2').fill('{rank}');
  await expect(page.getByLabel('Value of column 2')).not.toHaveClass(/wrong/);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/\/config/);
  expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('Bib;Rank;Status;Time\r\n21;;DNS;\r\n12;;DQ;\r\n7;1;OK;70.25\r\n');

  // Back to the UDA format: saved as no columns, without header line
  await page.goto('/CFM26/100m/config/export');
  await expect(page.getByTestId('uda-header')).toBeChecked();
  await page.getByTestId('uda-header').uncheck();
  await page.getByTestId('uda-reset-columns').click();
  await expect(values).toHaveCount(5);
  await page.getByTestId('uda-separator').selectOption({ label: 'Comma (,)' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/\/config/);
  expect(readFile('CFM26/100m/config.yaml')).toContain('#udaColumns:');
  expect(readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toBe('21,DNF,0,0,0\r\n12,DQ,0,0,0\r\n7,,1,10,25\r\n');
});

test('reuses the UDA export format of the other disciplines: copied, at creation, and when the performance changes', async ({ page, request }) => {
  const columns = (value: string) => `udaHeader: true\nudaColumns:\n  - title: T\n    value: "${value}"\n`;
  writeFiles({
    'CFM26/relay/config.yaml': columns('{bib}-time'),
    'CFM26/jump/config.yaml': `measure: distance\n${columns('{bib}-distance')}`,
  });
  const at = (relative: string, minutes: number) => {
    const time = new Date(Date.UTC(2026, 10, 5, 10, minutes));
    fs.utimesSync(path.join(WORK_DIR, relative), time, time);
  };
  at('CFM26/relay/config.yaml', 1);
  at('CFM26/jump/config.yaml', 2);

  // A new discipline has the format of the last one saved that measures a time
  expect((await request.post('/api/events/CFM26/disciplines', { data: { name: 'sprint' } })).status()).toBe(201);
  await page.goto('/CFM26/sprint/config/export');
  await expect(page.getByLabel('Value of column 1')).toHaveValue('{bib}-time');
  await expect(page.getByTestId('uda-header')).toBeChecked();

  // Another performance: the format of the last discipline that measures it
  await page.getByRole('tab', { name: 'Basic settings' }).click();
  await page.getByText('Distance', { exact: true }).click();
  await page.getByRole('tab', { name: 'UDA export' }).click();
  await expect(page.getByLabel('Value of column 1')).toHaveValue('{bib}-distance');

  // Copied from another discipline, those of the same performance first
  const copy = page.getByTestId('uda-copy');
  await expect(copy.locator('optgroup')).toHaveCount(2);
  await expect(copy.locator('optgroup').first()).toHaveAttribute('label', 'Same performance');
  await expect(copy.locator('optgroup').first().locator('option')).toHaveText(['CFM26 · jump']);
  await copy.selectOption({ label: 'CFM26 · relay' });
  await expect(page.getByLabel('Value of column 1')).toHaveValue('{bib}-time');
  await expect(copy).toHaveValue('');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/\/config/);
  expect(readFile('CFM26/sprint/config.yaml')).toContain('{bib}-time');
});
