import { expect, test } from '@playwright/test';
import { SAMPLE, chooseLine, participantInput, readFile, resetServer, resetWorkDir, writeFiles } from './helpers';

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

test('explains how to add events, then opens the race page on the only event and discipline once they exist', async ({ page }) => {
  resetWorkDir({});
  // The race page without a discipline leads to the list, the home page
  await page.goto('/race');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('No event yet.')).toBeVisible();

  writeFiles({ 'CFM26/100m/men.csv': '7;Hugo Guérin\n' });
  await page.getByRole('button', { name: '↻ Reload lists' }).click();

  // A single event and discipline need no click
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await chooseLine(page);
  await expect(page.getByRole('button', { name: 'CFM26 · 100m' })).toBeVisible();
  await expect(page.getByText('Participant (1)')).toBeVisible();
});

test('lists the events with their disciplines, and opens the race page on the one clicked', async ({ page }) => {
  writeFiles({ 'CFM26/Slalom/all.csv': '1;Ann\n', 'UNICON22/Slalom/all.csv': '2;Bob\n' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose the event and discipline to time' })).toBeVisible();
  // An accordion: one event open at a time, none at first when nothing was chosen before
  const header = (name: string) => page.getByRole('button', { name: new RegExp(`^${name} `) });
  const cfm = page.getByRole('region', { name: 'CFM26' });
  const unicon = page.getByRole('region', { name: 'UNICON22' });
  await expect(header('CFM26')).toContainText('2 disciplines');
  await expect(cfm).toBeHidden();
  await header('UNICON22').click();
  await expect(unicon.locator('.disciplines').getByRole('button')).toHaveText(['Slalom']);
  await header('CFM26').click();
  await expect(unicon).toBeHidden();
  await expect(cfm.locator('.disciplines').getByRole('button')).toHaveText(['100m', 'Slalom']);

  await cfm.getByRole('button', { name: '100m' }).click();
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await chooseLine(page);
  await expect(participantInput(page)).toBeVisible();

  // Back on the list from the menu: the event of the last choice is open
  await page.getByRole('button', { name: /Timing/ }).click();
  await page.getByRole('menuitem', { name: 'Events' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cfm).toBeVisible();
  await expect(unicon).toBeHidden();
});

test('switches between the race and live pages, on the list and on a discipline', async ({ page }) => {
  writeFiles({ 'UNICON22/Slalom/all.csv': '1;Ann\n' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose the event and discipline to time' })).toBeVisible();
  const pageSwitch = page.getByRole('navigation', { name: 'Race or live page' });
  await pageSwitch.getByRole('link', { name: 'Live' }).click();
  await expect(page).toHaveURL(/\/\?open=live$/);
  await expect(page.getByRole('heading', { name: 'Choose the event and discipline to show live' })).toBeVisible();

  await page.getByRole('button', { name: /^UNICON22 / }).click();
  await page.getByRole('region', { name: 'UNICON22' }).getByRole('button', { name: 'Slalom' }).click();
  await expect(page).toHaveURL(/\/UNICON22\/Slalom\/live$/);
  await expect(page.getByRole('heading', { name: 'Ranking' })).toBeVisible();

  // The switch keeps the event and discipline
  await pageSwitch.getByRole('link', { name: 'Race' }).click();
  await expect(page).toHaveURL(/\/UNICON22\/Slalom\/race$/);
  await expect(page.getByRole('button', { name: 'UNICON22 · Slalom' })).toBeVisible();

  // The live page without a discipline leads to the list, set to open the live page
  await page.goto('/live');
  await expect(page).toHaveURL(/\/\?open=live$/);
});

test('opens the pages of a discipline from the links made before it was in the path', async ({ page }) => {
  resetWorkDir(SAMPLE);
  await page.goto('/?event=CFM26&discipline=100m');
  await expect(page).toHaveURL(/\/CFM26\/100m\/race$/);
  await page.goto('/live?event=CFM26&discipline=100m');
  await expect(page).toHaveURL(/\/CFM26\/100m\/live$/);
});

test('creates an event and its disciplines, unless the administration is locked', async ({ page }) => {
  resetWorkDir({});
  await page.goto('/');
  await page.getByRole('button', { name: '+ New event' }).click();
  await page.getByRole('textbox', { name: 'Name of the new event' }).fill('UNICON22');
  await page.getByRole('button', { name: 'Create' }).click();

  // The new event is open, its first discipline asked at once
  const field = page.getByRole('textbox', { name: 'Name of the new discipline of UNICON22' });
  await expect(field).toBeFocused();
  await field.fill('Slalom');
  await field.press('Enter');
  const unicon = page.getByRole('region', { name: 'UNICON22' });
  await expect(unicon.getByRole('button', { name: 'Slalom', exact: true })).toBeVisible();
  // The only discipline does not open by itself while creating
  await expect(page).toHaveURL(/\/$/);
  expect(readFile('UNICON22/Slalom/config.yaml')).toContain('access: auto');

  // A name that exists already (case ignored) is refused
  await unicon.getByRole('button', { name: '+ New discipline' }).click();
  await unicon.getByRole('textbox').fill('slalom');
  await unicon.getByRole('button', { name: 'Create' }).click();
  await expect(unicon.getByRole('alert')).toHaveText('Cannot create it: The discipline Slalom already exists.');
  await unicon.getByRole('button', { name: 'Cancel' }).click();

  await unicon.getByRole('button', { name: 'Slalom', exact: true }).click();
  await expect(page).toHaveURL(/\/UNICON22\/Slalom\/race$/);

  // Locked: nothing to create
  writeFiles({ 'config.yaml': 'adminPassword: "s3cret"\n' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '+ New event' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New discipline' })).toHaveCount(0);
});
