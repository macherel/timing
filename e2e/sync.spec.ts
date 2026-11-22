import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { cross, chooseLine, readFile, resetWorkDir, SAMPLE } from './helpers';

/**
 * Two computers on the network with the same sync key: two more servers started by this test, with their own
 * working directories. Discovery (UDP broadcast every 3 s) takes a few seconds.
 */
const KEY = `e2e-${crypto.randomUUID()}`;
const computers = [
  { name: 'Start line', port: 3993, dir: path.join(os.tmpdir(), 'timing-e2e-sync-a') },
  { name: 'Finish line', port: 3994, dir: path.join(os.tmpdir(), 'timing-e2e-sync-b') },
];
const [a, b] = computers;
const url = (computer: (typeof computers)[number], urlPath: string) => `http://localhost:${computer.port}${urlPath}`;
const processes: ChildProcess[] = [];

test.describe.configure({ timeout: 60_000 });

test.beforeAll(async ({ request }) => {
  for (const computer of computers) {
    resetWorkDir({ 'config.yaml': `sync:\n  key: ${KEY}\n  name: ${computer.name}\ndevices: []\n` }, computer.dir);
    processes.push(
      spawn(process.execPath, ['backend/dist/server.js', '--work-dir', computer.dir, '--port', String(computer.port)], {
        env: { ...process.env, TIMING_SIMULATE_GATES: '1' },
        stdio: 'ignore',
      }),
    );
  }
  // Each one sees the other
  for (const computer of computers) {
    await expect
      .poll(async () => (await (await request.get(url(computer, '/api/sync')).catch(() => null))?.json())?.peers?.length ?? 0, {
        timeout: 20_000,
      })
      .toBe(1);
  }
});

test.afterAll(() => {
  for (const child of processes) child.kill();
  for (const computer of computers) fs.rmSync(computer.dir, { recursive: true, force: true });
});

test('shares the participants, the results and the live activity', async ({ page, request }) => {
  // The participants are added on one computer only
  for (const [file, content] of Object.entries(SAMPLE)) {
    fs.mkdirSync(path.dirname(path.join(a.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(a.dir, file), content);
  }
  await expect.poll(() => readFile('CFM26/100m/men.csv', b.dir), { timeout: 15_000 }).toBe(SAMPLE['CFM26/100m/men.csv']);

  // The finish line computer shows the live page, the start line computer times a run
  const live = page;
  await live.goto(url(b, '/CFM26/100m/live'));
  const race = await page.context().newPage();
  await race.goto(url(a, '/CFM26/100m/race'));
  await chooseLine(race);
  await race.getByPlaceholder('Bib number or name').fill('lea');
  await race.getByRole('option', { name: '12 Léa Martin' }).click();

  const card = live.locator('.lane', { hasText: 'Start line' });
  await expect(card).toContainText('Next up', { timeout: 10_000 });

  await race.getByRole('button', { name: 'Ready to start' }).click();
  await expect(card).toContainText('Ready');
  await cross(request, 'start', url(a, ''));
  await expect(card.getByRole('timer')).toBeVisible();
  await cross(request, 'finish', url(a, ''));

  // The result reaches the other computer's results file and ranking
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv', b.dir), { timeout: 15_000 }).toMatch(/\n12;Léa Martin;.+;OK;/);
  await expect(live.locator('.ranking tbody tr')).toHaveCount(1);
  await expect(live.locator('.ranking tbody tr td.name')).toHaveText('Léa Martin');
});

test('resets the results on both computers when the participants change, and shares the backup', async ({ request }) => {
  // Runs from the test before
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv', b.dir), { timeout: 15_000 }).toMatch(/\n12;Léa Martin;/);

  const response = await request.put(url(a, '/api/events/CFM26/100m/files/women.csv'), {
    headers: { 'Content-Type': 'text/csv' },
    data: 'bib;name\n13;Inès Roux\n',
  });
  expect(response.status()).toBe(200);

  // The other computer gets the backup, with the participants of before, then drops the runs
  await expect.poll(() => readFile('CFM26/100m/women.csv', b.dir), { timeout: 15_000 }).toBe('bib;name\n13;Inès Roux\n');
  await expect.poll(() => readFile('CFM26/100m/CFM26-100m-results.csv', b.dir), { timeout: 15_000 }).toBeNull();
  const backups = fs.readdirSync(path.join(b.dir, 'CFM26/100m/backup'));
  expect(backups).toEqual(fs.readdirSync(path.join(a.dir, 'CFM26/100m/backup')));
  expect(readFile(`CFM26/100m/backup/${backups[0]}/CFM26-100m-women-${backups[0]}.csv`, b.dir)).toBe(SAMPLE['CFM26/100m/women.csv']);
  expect(readFile(`CFM26/100m/backup/${backups[0]}/CFM26-100m-results-${backups[0]}.csv`, b.dir)).toMatch(/\n12;Léa Martin;/);

  // The runs dropped do not come back
  await new Promise((resolve) => setTimeout(resolve, 4000));
  expect(readFile('CFM26/100m/CFM26-100m-results.csv', a.dir)).toBeNull();
  expect(readFile('CFM26/100m/CFM26-100m-results.csv', b.dir)).toBeNull();
});
