import { expect, test } from '@playwright/test';
import { chooseLine, readFile, resetServer, resetWorkDir, writeFiles } from './helpers';

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

test('replaces the participant files of a discipline that has several, but adds none', async ({ page }) => {
  await page.goto('/CFM26/100m/config');
  await expect(page.getByRole('tab', { name: 'Basic settings' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Participants' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/participants$/);
  const panel = page.getByRole('tabpanel');
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

test('saves the first participant file of a discipline as participants.csv, then replaces it', async ({ page }) => {
  writeFiles({ 'CFM26/200m/config.yaml': 'access: auto\n' });
  await page.goto('/CFM26/200m/config/participants');
  await expect(page.getByText('No participant file yet')).toBeVisible();

  await page.getByTestId('add-participant-file').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n30;Zoé Petit\n') });
  await expect(page.getByRole('status')).toHaveText('participants.csv added.');
  const panel = page.getByRole('tabpanel');
  await expect(panel.locator('tbody .mono')).toHaveText(['participants.csv']);
  await expect(panel).toContainText('1 participant in all.');
  expect(readFile('CFM26/200m/participants.csv')).toBe('bib;name\n30;Zoé Petit\n');
  // A single file: no other one
  await expect(page.getByRole('button', { name: /Send the participant file/ })).toHaveCount(0);

  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Replace…' }).click();
  await (await chooser).setFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: Buffer.from('bib;name\n30;Zoé Petit\n31;Paul Roux\n') });
  await expect(page.getByRole('status')).toHaveText('participants.csv replaced.');
  await expect(panel).toContainText('2 participants in all.');

  // The race page has the new participants
  await page.goto('/CFM26/200m/race');
  await chooseLine(page);
  await expect(page.getByText('Participant (2)')).toBeVisible();
});

test('downloads the results of a discipline, and keeps the settings changed in another tab', async ({ page }) => {
  await page.goto('/CFM26/100m/config/results');
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
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('tab', { name: 'Basic settings' }).click();
  await expect(page.getByText('Thousandth', { exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Advanced settings' }).click();
  await expect(page.getByRole('radio', { name: 'Thousandth' })).toBeChecked();
});
