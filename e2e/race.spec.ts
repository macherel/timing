import { expect, test } from '@playwright/test';
import { resetServer, cross, getReady, participantInput, pickParticipant, readFile, resetWorkDir, startRun, writeFiles } from './helpers';

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

test('explains how to add events, then picks the only event and discipline once they exist', async ({ page }) => {
  resetWorkDir({});
  await page.goto('/');
  await expect(page.getByText('No event yet.')).toBeVisible();

  writeFiles({ 'CFM26/100m/men.csv': '7;Hugo Guérin\n' });
  await page.getByRole('button', { name: 'Choose an event' }).click();
  await page.getByRole('button', { name: '↻ Reload lists' }).click();

  // A single event and discipline need no click
  await expect(page.getByRole('button', { name: 'CFM26 · 100m' })).toBeVisible();
  await expect(page.getByText('Participant (1)')).toBeVisible();
  await expect(page).toHaveURL(/event=CFM26&discipline=100m/);
});

test('times a run from the start to the finish gate and saves it', async ({ page, request }) => {
  await page.goto('/');
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  await expect(page.getByText('men · Attempt 1')).toBeVisible();

  await getReady(page);
  // The participant cannot change during a run
  await expect(participantInput(page)).toBeDisabled();

  await cross(request, 'start');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish');

  const row = page.locator('.results tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(1)).toHaveText(/^\d+\.\d{2}$/);
  await expect(page.getByText('men · Attempt 2')).toBeVisible();
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;.+;OK;/);
});

test('times runs on two lines at once, each from its own gates', async ({ page, request }) => {
  await page.goto('/');
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
  await expect(tab('Line 1')).toHaveAttribute('aria-selected', 'true');
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  await startRun(page, request);
  await expect(tab('Line 1')).toContainText('7');

  // The other line is free: another participant can get ready and run on it meanwhile
  await tab('Line 2').click();
  await expect(participantInput(page)).toBeEnabled();
  await pickParticipant(page, 'lea', '12 Léa Martin');
  await getReady(page);
  await cross(request, 'start', undefined, 'Line 2');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish', undefined, 'Line 2');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n12;Léa Martin;.+;OK;/);

  // Hugo is still running on line 1, until its finish gate
  await tab('Line 1').click();
  await expect(participantInput(page)).toHaveValue('7 · Hugo Guérin');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish', undefined, 'Line 1');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;.+;OK;/);
});

test('cancels a run without saving it, after a confirmation', async ({ page, request }) => {
  await page.goto('/');
  await pickParticipant(page, '7', '7 Hugo Guérin');
  await startRun(page, request);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeEnabled();
  await expect(page.getByText('No run yet.')).toBeVisible();
  expect(readFile('CFM26/100m/CFM26-100m-results.csv')).toBeNull();
});

test('disqualifies a running participant, then turns the run into an invalid one that gives the attempt back', async ({ page, request }) => {
  writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 1\n' });
  await page.goto('/');
  await expect(page.getByText('Participant (3 remaining / 3)')).toBeVisible();
  await pickParticipant(page, 'lea', '12 Léa Martin');
  await startRun(page, request);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Disqualify' }).click();

  const status = page.getByRole('combobox', { name: 'Status of run 1' });
  await expect(status).toHaveValue('dq');
  await expect(page.getByText('Its only attempt is used')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeDisabled();
  await expect(page.getByText('Participant (2 remaining / 3)')).toBeVisible();

  // An invalid run is not the participant's fault: it does not use the attempt
  await status.selectOption('invalid');
  await expect(status).toHaveValue('invalid');
  await expect(page.getByText('women · Attempt 1 of 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeEnabled();
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n12;Léa Martin;.+;;INVALID;/);
});

test('shows participants without attempts left as done in the list', async ({ page }) => {
  writeFiles({
    'CFM26/100m/config.yaml': 'attempts: 1\n',
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n21;Jean-Luc Martin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n',
  });
  await page.goto('/');
  await participantInput(page).fill('martin');
  await expect(page.getByRole('option', { name: '21 Jean-Luc Martin' })).toContainText('done');
  await expect(page.getByRole('option', { name: '12 Léa Martin' })).not.toContainText('done');
});

test('locks the discipline from its settings, which disables runs and result changes', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n',
  });
  await page.goto('/');
  await pickParticipant(page, '7', '7 Hugo Guérin');

  await page.getByRole('button', { name: 'CFM26 · 100m' }).click();
  await page.getByRole('button', { name: '⚙ Discipline settings' }).click();
  await page.getByText('Locked', { exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('CFM26 / 100m is closed: its results are locked.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Status of run 1' })).toBeDisabled();
  expect(readFile('CFM26/100m/config.yaml')).toContain('access: locked');
});

test('shows the times with the precision and rounding of the discipline settings', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10.3441Z;OK;2026-11-05T10:00:11Z\n',
  });
  await page.goto('/');
  await pickParticipant(page, '7', '7 Hugo Guérin');
  // By default: rounded up to the hundredth
  const time = page.locator('.results tbody tr td').nth(1);
  await expect(time).toHaveText('10.35');

  await page.getByRole('button', { name: 'CFM26 · 100m' }).click();
  await page.getByRole('button', { name: '⚙ Discipline settings' }).click();
  await page.getByText('Thousandth', { exact: true }).click();
  await page.getByText('Truncate', { exact: true }).click();
  await expect(page.getByText('A measured time of 12.3456 s gives 12.345.')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(time).toHaveText('10.344');
  expect(readFile('CFM26/100m/config.yaml')).toMatch(/precision: thousandth\n.*\nrounding: truncate\n/);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toContain('7,,0,10,34\r\n');
});

test('refuses invalid discipline settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'CFM26 · 100m' }).click();
  await page.getByRole('button', { name: '⚙ Discipline settings' }).click();

  await page.getByLabel('Attempts per participant').fill('0');
  await page.getByRole('button', { name: 'Save' }).click();
  // The browser refuses it first (min 1), so the form is not sent
  await expect(page.getByLabel('Attempts per participant')).toHaveJSProperty('validity.valid', false);

  // An end before the start: the browser refuses it too (the end's min is the start)
  await page.getByLabel('Attempts per participant').fill('');
  await page.getByLabel('Start').fill('2026-11-05T18:00');
  await page.getByLabel('End').fill('2026-11-05T08:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('End')).toHaveJSProperty('validity.rangeUnderflow', true);
  expect(readFile('CFM26/100m/config.yaml')).toBeNull();
});

test('lists the problems of the participant files', async ({ page }) => {
  writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\nx;No bib\n' });
  await page.goto('/');
  // The participant list opens when the page focuses the search field: close it
  await participantInput(page).press('Escape');
  await page.getByText('1 problem in the files of 100m').click();
  await expect(page.getByText('men.csv, line 3: bib "x" is not a number')).toBeVisible();
});
