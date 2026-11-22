import { expect, test } from '@playwright/test';
import { chooseLine, readFile, resetWorkDir, writeFiles } from './helpers';

test.beforeEach(() => resetWorkDir());

test.describe('configuration page', () => {
  test('creates config.yaml with a line on a device, after the problems are fixed', async ({ page }) => {
    await page.goto('/config');
    await expect(page.getByText('does not exist yet: saving creates it')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Lines' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page).toHaveURL(/\/config\/devices$/);
    await page.getByRole('button', { name: '+ Add device' }).click();
    // A new device has no IDs yet: the backend lists the problem on the device, counted on its tab
    await expect(page.getByText('vendorId and productId must be integers')).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Devices/ })).toContainText('1');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByLabel('Device name').fill('Receiver');
    await page.getByLabel('Vendor ID (hex)').fill('0x046d');
    await page.getByLabel('Product ID (hex)').fill('c548');
    await expect(page.getByText('✔ valid')).toBeVisible();

    // A new line uses the only device for its start and finish; its buttons are still to set
    await page.getByRole('tab', { name: 'Lines' }).click();
    await page.getByRole('button', { name: '+ Add line' }).click();
    await expect(page.getByText('Start: byteIndex, mask and value must be integers')).toBeVisible();
    for (const [gate, mask] of [['Start', '0x01'], ['Finish', '0x02']]) {
      const fieldset = page.getByRole('group', { name: gate });
      await expect(fieldset.getByLabel('Device')).toHaveValue(/\d+/);
      await fieldset.getByLabel('Byte').fill('1');
      await fieldset.getByLabel('Mask').fill(mask);
      await fieldset.getByLabel('Value').fill(mask);
    }
    await page.getByRole('group', { name: 'Finish' }).getByLabel('Crossing on').selectOption('release');
    await expect(page.getByText('✔ valid')).toBeVisible();
    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.getByText('Used by: Line 1')).toBeVisible();

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. The app applies the new configuration within a second.')).toBeVisible();
    const saved = readFile('config.yaml')!;
    expect(saved).toContain('vendorId: 0x046d');
    expect(saved).toContain('productId: 0xc548');
    expect(saved).toMatch(/lines:\n {2}- name: "Line 1"\n {4}enabled: true\n {4}start:\n {6}device: "Receiver"\n {6}byteIndex: 1\n {6}mask: 0x01/);
    expect(saved).toMatch(/finish:\n {6}device: "Receiver"\n {6}byteIndex: 1\n {6}mask: 0x02\n {6}value: 0x02\n {6}edge: release/);
  });

  test('keeps the lines on their device when it is renamed, and asks before removing a used device', async ({ page }) => {
    writeFiles({
      'config.yaml': [
        'lines:',
        '  - { name: "North", enabled: true, start: { device: "G", byteIndex: 0, mask: 1, value: 1 }, finish: { device: "G", byteIndex: 0, mask: 2, value: 2 } }',
        'devices: [{ name: "G", vendorId: 1, productId: 1 }]',
      ].join('\n'),
    });
    await page.goto('/config/devices');
    await page.getByLabel('Device name').fill('Gate');
    await page.getByRole('tab', { name: 'Lines' }).click();
    await expect(page.getByRole('group', { name: 'Start' }).getByLabel('Device')).toContainText('Gate');
    await expect(page.getByText('✔ valid')).toBeVisible();
    await page.getByRole('tab', { name: 'Devices' }).click();

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('Remove device "Gate"? It is used by: North. Their start or finish will have no device.');
      return dialog.dismiss();
    });
    await page.getByTitle('Remove device').click();
    await expect(page.getByLabel('Device name')).toHaveValue('Gate');
  });

  test('saves the port and the sync settings', async ({ page }) => {
    writeFiles({ 'config.yaml': 'devices: []\n' });
    await page.goto('/config');
    await expect(page.getByText('No line yet')).toBeVisible();
    await page.getByRole('tab', { name: 'Network' }).click();
    await page.getByLabel('Port of the app').fill('70000');
    await expect(page.getByText('port must be a whole number from 1 to 65535')).toBeVisible();
    await page.getByLabel('Port of the app').fill('8080');

    await page.getByText('Sync the events with the other computers').click();
    await page.getByLabel('Key', { exact: true }).fill('amber-otter-glide');
    await page.getByLabel('Name of this computer').fill('Finish line');
    await expect(page.getByText('✔ valid')).toBeVisible();
    await page.keyboard.press('Control+s');

    await expect(page.getByText(/^Saved\./)).toBeVisible();
    expect(readFile('config.yaml')).toMatch(/port: 8080[\s\S]*sync:\n {2}key: "amber-otter-glide"\n {2}name: "Finish line"/);
  });

  test('shows an invalid config.yaml as text, to fix it by hand', async ({ page }) => {
    writeFiles({ 'config.yaml': 'devices: [\n' });
    await page.goto('/config');
    await expect(page.getByText('config.yaml cannot be shown in the form because it is invalid:')).toBeVisible();
    await expect(page.locator('pre.raw')).toHaveText('devices: [\n');
  });

  test('asks before leaving with unsaved changes', async ({ page }) => {
    writeFiles({ 'config.yaml': 'devices: []\n' });
    await page.goto('/config/network');
    await page.getByLabel('Port of the app').fill('8080');
    await expect(page.getByText('unsaved changes')).toBeVisible();
    // Another tab keeps them, without asking
    await page.getByRole('tab', { name: 'Access' }).click();
    await page.getByRole('tab', { name: 'Network' }).click();
    await expect(page.getByLabel('Port of the app')).toHaveValue('8080');

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('You have unsaved changes. Leave this page anyway?');
      return dialog.dismiss();
    });
    await page.getByRole('button', { name: /Timing/ }).click();
    await page.getByRole('menuitem', { name: 'Diagnostics' }).click();
    await expect(page).toHaveURL(/\/config\/network$/);
  });
});

test('the administration password hides the administration until it is typed', async ({ page }) => {
  await page.goto('/config/access');
  await page.getByTestId('admin-password').fill('s3cret');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. The app applies the new configuration within a second.')).toBeVisible();
  expect(readFile('config.yaml')).toContain('adminPassword: "s3cret"');

  // The browser that set the password stays unlocked; the padlock locks it
  await page.getByRole('button', { name: 'Lock the administration' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await page.getByRole('button', { name: /Timing/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Diagnostics' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Events' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Discipline settings' })).toHaveCount(0);

  // The administration URLs lead to the home page, the settings of a discipline to its race page
  await page.goto('/diagnostics');
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await page.goto('/CFM26/100m/config');
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);

  await page.getByRole('button', { name: 'Unlock the administration' }).click();
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('Wrong password.')).toBeVisible();
  await page.getByLabel('Password').fill('s3cret');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('button', { name: /Timing/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Diagnostics' })).toBeVisible();
});

test('diagnostics page shows the backend and the configuration state', async ({ page }) => {
  writeFiles({ 'config.yaml': 'devices: []\n' });
  await page.goto('/diagnostics');
  await expect(page.locator('.summary')).toContainText('online');
  await expect(page.locator('.summary')).toContainText('connected');
  await expect(page.getByRole('link', { name: 'Edit configuration' })).toBeVisible();
});

test.describe('language', () => {
  test('switches to French with the flag, and keeps it after a reload', async ({ page }) => {
    await page.goto('/CFM26/100m/race');
    await chooseLine(page);
    await page.getByRole('button', { name: /Timing/ }).click();
    await page.getByRole('menuitemradio', { name: 'Français' }).click();

    await expect(page.getByPlaceholder('Numéro de dossard ou nom')).toBeVisible();
    await expect(page).toHaveTitle('Course · Timing');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

    await page.reload();
    await chooseLine(page);
    await expect(page.getByPlaceholder('Numéro de dossard ou nom')).toBeVisible();
    await page.getByRole('button', { name: /Timing/ }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Français' })).toHaveAttribute('aria-checked', 'true');
  });

  test("uses the browser's language the first time", async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await page.goto('/live');
    await expect(page).toHaveTitle('Direct · Timing');
    await expect(page.getByRole('heading', { name: 'Classement' })).toBeVisible();
    await context.close();
  });
});
