import { expect, test, type Page } from '@playwright/test';
import { SAMPLE, resetServer, cross, getReady, participantInput, pickParticipant, readFile, chooseLine, resetWorkDir, startRun, writeFiles } from './helpers';

/** Opens the settings page of the discipline with the gear beside the title. */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Discipline settings' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/config$/);
}

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

test('times a run from the start to the finish gate and saves it', async ({ page, request }) => {
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  await expect(page.getByText('Attempt 1', { exact: true })).toBeVisible();

  await getReady(page);
  // The participant cannot change during a run
  await expect(participantInput(page)).toBeDisabled();

  await cross(request, 'start');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish');

  const row = page.locator('.results tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(1)).toHaveText(/^\d+\.\d{2}$/);
  await expect(page.getByText('Attempt 2', { exact: true })).toBeVisible();
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;.+;OK;/);
});

test('times runs on two lines at once, each from its own gates', async ({ page, request }) => {
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  const back = () => page.getByRole('button', { name: 'Back to the choice of a line' }).click();
  await expect(page.getByTestId('current-line')).toHaveText('Line 1');
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  await startRun(page, request);

  // The other line is free: another participant can get ready and run on it meanwhile
  await back();
  await expect(page.getByTestId('line-choice').getByRole('button', { name: /^Line 1/ })).toContainText('7 Hugo Guérin');
  await chooseLine(page, 'Line 2');
  await expect(participantInput(page)).toBeEnabled();
  await pickParticipant(page, 'lea', '12 Léa Martin');
  await getReady(page);
  await cross(request, 'start', undefined, 'Line 2');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish', undefined, 'Line 2');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
  // The results file records the computer and the line of the run, and the line shows its last runs from it
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n12;Léa Martin;.+;OK;[^;\n]+;Line 2;/);
  const recent = page.getByTestId('recent-runs').locator('tbody tr');
  await expect(recent).toHaveCount(1);
  await expect(recent).toContainText('Léa Martin');

  // Hugo is still running on line 1, until its finish gate
  await back();
  await chooseLine(page, 'Line 1');
  await expect(participantInput(page)).toHaveValue('7 · Hugo Guérin');
  await expect(page.getByRole('timer')).toBeVisible();
  await cross(request, 'finish', undefined, 'Line 1');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;.+;OK;[^;\n]+;Line 1;/);
  // Only the runs of this line
  await expect(recent).toHaveCount(1);
  await expect(recent).toContainText('Hugo Guérin');
});

test('disqualifies a running participant, then turns the run into an invalid one that gives the attempt back', async ({ page, request }) => {
  writeFiles({ 'CFM26/100m/config.yaml': 'attempts: 1\n' });
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
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
  await expect(page.getByText('Attempt 1 of 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeEnabled();
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n12;Léa Martin;.+;;INVALID;/);
});

test('shows participants without attempts left as done in the list', async ({ page }) => {
  writeFiles({
    'CFM26/100m/config.yaml': 'attempts: 1\n',
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n21;Jean-Luc Martin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n',
  });
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  await participantInput(page).fill('martin');
  await expect(page.getByRole('option', { name: '21 Jean-Luc Martin' })).toContainText('done');
  await expect(page.getByRole('option', { name: '12 Léa Martin' })).not.toContainText('done');
});

test('locks the discipline from its settings, which disables runs and result changes', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv':
      'bib;name;start;finish;status;updated\n7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n',
  });
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  await pickParticipant(page, '7', '7 Hugo Guérin');

  await openSettings(page);
  await page.getByRole('tab', { name: 'Lock' }).click();
  await page.getByText('Locked', { exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  // Back on the race page, on the same line
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await pickParticipant(page, '7', '7 Hugo Guérin');
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
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  await pickParticipant(page, '7', '7 Hugo Guérin');
  // By default: rounded up to the hundredth
  const time = page.locator('.results tbody tr td').nth(1);
  await expect(time).toHaveText('10.35');

  await openSettings(page);
  await page.getByRole('tab', { name: 'Advanced settings' }).click();
  await page.getByText('Thousandth', { exact: true }).click();
  await page.getByText('Truncate', { exact: true }).click();
  await expect(page.getByText('A measured time of 12.3456 s gives 12.345.')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await pickParticipant(page, '7', '7 Hugo Guérin');
  await expect(time).toHaveText('10.344');
  expect(readFile('CFM26/100m/config.yaml')).toMatch(/precision: thousandth\n.*\nrounding: truncate\n/);
  // The fraction of a second in the unit of the precision
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toContain('7,,0,10,344\r\n');
});

test('asks for the line each time it is opened, and goes back to this choice', async ({ page }) => {
  await page.goto('/CFM26/100m/race');
  const choice = page.getByTestId('line-choice');
  await expect(choice.getByRole('heading', { name: 'Which line do you time on?' })).toBeVisible();
  await expect(participantInput(page)).toHaveCount(0);

  await choice.getByRole('button', { name: /^Line 2/ }).click();
  await expect(page.getByTestId('current-line')).toHaveText('Line 2');
  // No tabs: changing the line always goes through the choice
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(participantInput(page)).toBeVisible();

  // The back button goes back to the choice
  await page.getByRole('button', { name: 'Back to the choice of a line' }).click();
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: /^Line 1/ }).click();
  await expect(page.getByTestId('current-line')).toHaveText('Line 1');

  // Asked again when the page is opened again
  await page.reload();
  await expect(choice).toBeVisible();
});

test('opens a disabled line to see its results, but starts no run on it', async ({ browser, request }) => {
  const gate = (mask: number) => `{ device: "G", byteIndex: 0, mask: ${mask}, value: ${mask} }`;
  resetWorkDir({
    ...SAMPLE,
    'config.yaml': [
      'lines:',
      `  - { name: "North", enabled: true, start: ${gate(1)}, finish: ${gate(2)} }`,
      `  - { name: "Off", enabled: false, start: ${gate(1)}, finish: ${gate(2)} }`,
      'devices: [{ name: "G", vendorId: 1, productId: 1 }]',
    ].join('\n'),
  });
  await resetServer(request);
  const page = await (await browser.newContext()).newPage();
  await page.goto('/CFM26/100m/race');
  const choice = page.getByTestId('line-choice');
  const disabled = 'No new start on this line: it is disabled on the Configuration page. Its results can still be changed.';
  await expect(choice.getByRole('button', { name: /^Off/ })).toHaveAttribute('title', disabled);
  await choice.getByRole('button', { name: /^Off/ }).click();
  await expect(page.getByTestId('start-blocked')).toHaveText(disabled);
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeDisabled();

  // The other line starts runs
  await page.getByRole('button', { name: 'Back to the choice of a line' }).click();
  await chooseLine(page, 'North');
  await expect(page.getByTestId('start-blocked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ready to start' })).toBeEnabled();
  await page.context().close();
});

test('times a discipline by hand with its trigger key, on the manual line', async ({ page }) => {
  await page.goto('/CFM26/100m/race');
  // The manual line is not one of the lines to choose
  await expect(page.getByTestId('line-choice').getByRole('button')).toHaveCount(2);

  await openSettings(page);
  // Without the setting, the discipline is timed by the gates
  await expect(page.getByRole('radio', { name: 'Gates' })).toBeChecked();
  await expect(page.getByTestId('trigger-key')).toHaveCount(0);
  await page.getByText('Manual (keyboard)', { exact: true }).click();
  await expect(page.getByTestId('trigger-hint')).toContainText('on the line “Manuel” of each computer');
  // The space bar by default, changed by pressing the new key: any key, Tab too
  await expect(page.getByTestId('trigger-key')).toHaveText('Space');
  await page.getByRole('button', { name: 'Change the key' }).click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('trigger-key')).toHaveText('Tab');
  // Taken for the choice only: the focus did not move to the next field
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.getByRole('button', { name: 'Change the key' }).click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trigger-key')).toHaveText('Enter');
  await page.getByRole('button', { name: 'Save' }).click();
  expect(readFile('CFM26/100m/config.yaml')).toMatch(/trigger: keyboard\n.*\ntriggerKey: Enter\n/);

  // No line to choose: the discipline runs on the manual line
  await expect(page.getByTestId('current-line')).toHaveText('Manuel');
  await expect(page.getByRole('button', { name: 'Back to the choice of a line' })).toHaveCount(0);
  await pickParticipant(page, 'hug', '7 Hugo Guérin');

  // Nobody is ready: the key does nothing
  await participantInput(page).blur();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Waiting for the start…')).toHaveCount(0);
  await getReady(page);
  await expect(page.getByTestId('key-hint')).toHaveText('Press Enter to start.');
  // Only the trigger key starts the run
  await page.keyboard.press('Space');
  await expect(page.getByText('Waiting for the start…')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByTestId('key-hint')).toHaveText('Press Enter at the finish.');

  // A focused button is not clicked by the key during the run: the press finishes the run
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Invalidate' }).focus();
  await page.keyboard.press('Enter');
  const row = page.locator('.results tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(1)).toHaveText(/^\d+\.\d{2}$/);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;.+;OK;[^;]*;Manuel;/);
});

test('measures a distance typed by the operator, then validated or not, on the manual line', async ({ page }) => {
  await page.goto('/CFM26/100m/race');
  await openSettings(page);
  await expect(page.getByRole('radio', { name: 'Time' })).toBeChecked();
  await page.getByText('Distance', { exact: true }).click();
  await expect(page.getByTestId('measure-hint')).toContainText('The longest distance is the best');
  // No best time nor trigger for a distance
  await expect(page.getByRole('radio', { name: 'Gates' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => readFile('CFM26/100m/config.yaml')).toMatch(/\nmeasure: distance\n/);

  // No line to choose: the distance is typed on the manual line
  await expect(page.getByTestId('current-line')).toHaveText('Manuel');
  await pickParticipant(page, 'hug', '7 Hugo Guérin');
  // In centimetres
  await page.getByTestId('distance-input').fill('345');
  await page.getByTestId('distance-input').press('Enter');
  await expect(page.getByTestId('distance-to-validate')).toHaveText('345 cm');
  await page.getByRole('button', { name: 'Validate', exact: true }).click();

  const rows = page.locator('.results tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('td').nth(1)).toHaveText('345 cm');
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv')).toMatch(/\n7;Hugo Guérin;[^;]+;[^;]+;345;OK;[^;]*;Manuel;/);
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-uda-results.csv')).toContain('7,,345\r\n');

  // A longer distance, not valid: saved with its distance, struck through
  await page.getByTestId('distance-input').fill('410');
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await page.getByRole('button', { name: 'Disqualify' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('td s')).toHaveText('410 cm');

  await page.goto('/CFM26/100m/live');
  await expect(page.locator('.ranking th.time')).toHaveText('Best distance');
  await expect(page.locator('.ranking tbody tr').first().locator('td.time')).toHaveText('345 cm');
});

test('closes the discipline settings with the gear, asking first when changes are not saved', async ({ page }) => {
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  const gear = page.getByRole('link', { name: 'Discipline settings' });

  // Nothing changed: closed at once
  await openSettings(page);
  await gear.click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);

  // A change not saved: asks, and stays when the answer is no
  await openSettings(page);
  await page.getByRole('tab', { name: 'Advanced settings' }).click();
  await page.getByText('Thousandth', { exact: true }).click();
  const answers: string[] = [];
  page.on('dialog', (dialog) => {
    answers.push(dialog.message());
    return answers.length === 1 ? dialog.dismiss() : dialog.accept();
  });
  await gear.click();
  await expect.poll(() => answers.length).toBe(1);
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/advanced$/);
  await gear.click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  expect(answers).toEqual(Array(2).fill('You have unsaved changes. Leave this page anyway?'));
  expect(readFile('CFM26/100m/config.yaml')).toBeNull();
});

test('refuses invalid discipline settings', async ({ page }) => {
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  await openSettings(page);

  await page.getByLabel('Attempts per participant').fill('0');
  await page.getByRole('button', { name: 'Save' }).click();
  // The browser refuses it first (min 1), so the form is not sent
  await expect(page.getByLabel('Attempts per participant')).toHaveJSProperty('validity.valid', false);

  // An end before the start: the browser refuses it too (the end's min is the start), and shows its tab
  await page.getByLabel('Attempts per participant').fill('');
  await page.getByRole('tab', { name: 'Lock' }).click();
  await page.getByLabel('Start').fill('2026-11-05T18:00');
  await page.getByLabel('End').fill('2026-11-05T08:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('End')).toHaveJSProperty('validity.rangeUnderflow', true);
  await page.getByRole('tab', { name: 'Basic settings' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/config\/lock$/);
  await expect(page.getByLabel('End')).toBeVisible();
  expect(readFile('CFM26/100m/config.yaml')).toBeNull();
});

test('lists the problems of the participant files', async ({ page }) => {
  writeFiles({ 'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\nx;No bib\n' });
  await page.goto('/CFM26/100m/race');
  await chooseLine(page);
  // The participant list opens when the page focuses the search field: close it
  await participantInput(page).press('Escape');
  await page.getByText('1 problem in the files of 100m').click();
  await expect(page.getByText('men.csv, line 3: bib "x" is not a number')).toBeVisible();
});
