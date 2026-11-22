import { expect, test, type Page } from '@playwright/test';
import { resetServer, cross, getReady, participantInput, pickParticipant, resetWorkDir, writeFiles } from './helpers';

const RESULTS_HEADER = 'bib;name;start;finish;status;updated';

test.beforeEach(async ({ request }) => {
  resetWorkDir();
  await resetServer(request);
});

/** The race page and the live page of the same computer, side by side. */
async function openPages(page: Page) {
  const live = await page.context().newPage();
  await page.goto('/?event=CFM26&discipline=100m');
  await live.goto('/live?event=CFM26&discipline=100m');
  return { race: page, live, card: live.locator('.lane') };
}

test('follows the race page: next up, ready, running, finished, waiting', async ({ page, request }) => {
  const { race, live, card } = await openPages(page);
  await expect(card).toContainText('Waiting');

  await pickParticipant(race, 'hug', '7 Hugo Guérin');
  await expect(card).toContainText('7 Hugo Guérin');
  await expect(card).toContainText('Next up');
  await expect(card).toContainText('No time yet');

  await getReady(race);
  await expect(card).toContainText('Ready');

  await cross(request, 'start');
  await expect(card.getByRole('timer')).toBeVisible();

  await cross(request, 'finish');
  await expect(card.locator('.clock.done')).toHaveText(/^\d+\.\d{2}$/);
  await expect(card).toContainText(/Best: \d+\.\d{2} \(rank 1\)/);
  await expect(live.locator('.ranking tbody tr')).toHaveCount(1);

  // Clearing the participant keeps the time of the last run
  await race.locator('.picker .clear').click();
  await expect(card.locator('.clock.done')).toBeVisible();
});

test('does not show a participant without attempts left as next up', async ({ page, request }) => {
  writeFiles({
    'CFM26/100m/config.yaml': 'attempts: 1\n',
    'CFM26/100m/CFM26-100m-results.csv': `${RESULTS_HEADER}\n12;Léa Martin;2026-11-05T10:00:00Z;2026-11-05T10:00:10Z;OK;2026-11-05T10:00:10Z\n`,
  });
  const { race, card } = await openPages(page);
  await pickParticipant(race, 'lea', '12 Léa Martin');
  // Once the server knows Léa is selected, the card still does not show her
  await expect
    .poll(async () => JSON.stringify((await (await request.get('/api/live')).json()).instances[0].viewing))
    .toContain('Léa Martin');
  await expect(card).not.toContainText('Next up');
  await expect(card).not.toContainText('Léa Martin');

  // A participant with an attempt left (and who is not the last one to have run) is shown
  await race.locator('.picker .clear').click();
  await pickParticipant(race, 'jean', '21 Jean-Luc Martin');
  await expect(card).toContainText('Next up');
});

test('ranks by best valid time, invalid runs left out and disqualified runs without time last', async ({ page }) => {
  writeFiles({
    'CFM26/100m/CFM26-100m-results.csv': [
      RESULTS_HEADER,
      '7;Hugo Guérin;2026-11-05T10:00:00Z;2026-11-05T10:00:12.000Z;OK;2026-11-05T10:00:12Z',
      '7;Hugo Guérin;2026-11-05T10:05:00Z;2026-11-05T10:05:11.500Z;OK;2026-11-05T10:05:11Z',
      '12;Léa Martin;2026-11-05T10:01:00Z;2026-11-05T10:01:10.250Z;OK;2026-11-05T10:01:10Z',
      '21;Jean-Luc Martin;2026-11-05T10:02:00Z;;DQ;2026-11-05T10:02:05Z',
      // Faster, but invalid: it does not count
      '21;Jean-Luc Martin;2026-11-05T10:03:00Z;2026-11-05T10:03:05Z;INVALID;2026-11-05T10:03:05Z',
    ].join('\n'),
  });
  const { live } = await openPages(page);
  const rows = live.locator('.ranking tbody tr');
  await expect(rows).toHaveCount(3);
  const cells = async (index: number) => (await rows.nth(index).locator('td').allTextContents()).map((text) => text.trim());
  expect(await cells(0)).toEqual(['1', '12', 'Léa Martin', 'women', '10.25', '1']);
  expect(await cells(1)).toEqual(['2', '7', 'Hugo Guérin', 'men', '11.50', '2']);
  expect(await cells(2)).toEqual(['–', '21', 'Jean-Luc Martin', 'men', '—', '1']);
});

test('asks to choose the discipline when none is selected', async ({ page }) => {
  writeFiles({ 'UNICON22/Slalom/all.csv': '1;Ann\n' });
  await page.goto('/live');
  await expect(page.getByText('Choose the event and discipline to show.')).toBeVisible();
  await page.getByRole('button', { name: 'Choose', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Event and discipline' })).toBeVisible();
  // The race page search field is not on this page
  await expect(participantInput(page)).toHaveCount(0);
});

test('updates the ranking at each finish, also for a participant who runs again', async ({ page, request }) => {
  const { race, live, card } = await openPages(page);
  await pickParticipant(race, 'hug', '7 Hugo Guérin');
  for (const runs of ['1', '2', '3']) {
    await getReady(race);
    await cross(request, 'start');
    await expect(card.getByRole('timer')).toBeVisible();
    await cross(request, 'finish');
    await expect(card.locator('.clock.done')).toBeVisible();
    // The results are reloaded once the new one is saved
    await expect(live.locator('.ranking tbody tr td.runs')).toHaveText(runs);
  }
});
