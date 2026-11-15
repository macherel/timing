import { expect, test } from '@playwright/test';
import { readFile, resetWorkDir, writeFiles } from './helpers';

test.beforeEach(() => resetWorkDir());

test.describe('configuration page', () => {
  test('creates config.yaml with a device, after the problems are fixed', async ({ page }) => {
    await page.goto('/config');
    await expect(page.getByText('does not exist yet: saving creates it')).toBeVisible();

    await page.getByRole('button', { name: '+ Add device' }).click();
    // A new device has no IDs yet: the backend lists the problem on the device
    await expect(page.getByText('vendorId and productId must be integers')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByLabel('Device name').fill('Start gate');
    await page.getByLabel('Vendor ID (hex)').fill('0x046d');
    await page.getByLabel('Product ID (hex)').fill('c548');
    await page.getByPlaceholder('1', { exact: true }).fill('1');
    await page.getByPlaceholder('0x01').first().fill('0x01');
    await page.getByPlaceholder('0x01').last().fill('0x01');
    await page.getByPlaceholder('start_crossed').fill('start_crossed');
    await expect(page.getByText('✔ valid')).toBeVisible();

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. The app applies the new configuration within a second.')).toBeVisible();
    const saved = readFile('config.yaml')!;
    expect(saved).toContain('name: "Start gate"');
    expect(saved).toContain('vendorId: 0x046d');
    expect(saved).toContain('productId: 0xc548');
    expect(saved).toContain('action: "start_crossed"');
  });

  test('saves the port and the sync settings', async ({ page }) => {
    writeFiles({ 'config.yaml': 'devices: []\n' });
    await page.goto('/config');
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
    await page.goto('/config');
    await page.getByLabel('Port of the app').fill('8080');
    await expect(page.getByText('unsaved changes')).toBeVisible();

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('You have unsaved changes. Leave this page anyway?');
      return dialog.dismiss();
    });
    await page.getByRole('button', { name: /Hardware configuration/ }).click();
    await page.getByRole('menuitem', { name: 'Diagnostics' }).click();
    await expect(page).toHaveURL(/\/config$/);
  });
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
    await page.goto('/');
    await page.getByRole('button', { name: /^Timing/ }).click();
    await page.getByRole('menuitemradio', { name: 'Français' }).click();

    await expect(page.getByPlaceholder('Numéro de dossard ou nom')).toBeVisible();
    await expect(page).toHaveTitle('Course · Timing');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

    await page.reload();
    await expect(page.getByPlaceholder('Numéro de dossard ou nom')).toBeVisible();
    await page.getByRole('button', { name: /^Timing/ }).click();
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
