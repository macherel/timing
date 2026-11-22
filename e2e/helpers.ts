import fs from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { WORK_DIR } from './env';

/** The sample event most tests use: CFM26, discipline 100m, three participants in two categories. */
export const SAMPLE = {
  'CFM26/100m/men.csv': 'bib;name\n7;Hugo Guérin\n21;Jean-Luc Martin\n',
  'CFM26/100m/women.csv': 'bib;name\n12;Léa Martin\n',
};

/** Replaces the whole working directory of the server with these files (paths relative to it). */
export function resetWorkDir(files: Record<string, string> = SAMPLE, dir = WORK_DIR): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(files, dir);
}

export function writeFiles(files: Record<string, string>, dir = WORK_DIR): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function readFile(relative: string, dir = WORK_DIR): string | null {
  try {
    return fs.readFileSync(path.join(dir, relative), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Fires a crossing of the simulated start or finish gate of a line: the first one by default. Without lines in
 * config.yaml, the server has two simulated lines, "Line 1" and "Line 2".
 */
export async function cross(request: APIRequestContext, gate: 'start' | 'finish', baseURL?: string, line?: string): Promise<void> {
  const response = await request.post(`${baseURL ?? ''}/api/simulate/crossing`, { data: { gate, line } });
  expect(response.ok()).toBe(true);
}

/**
 * Starts the server over: reads config.yaml of the working directory again (none: the simulated lines), no run in
 * progress and no last result, so a test does not see what the previous one did. Call it after resetWorkDir.
 */
export async function resetServer(request: APIRequestContext): Promise<void> {
  expect((await request.post('/api/simulate/reset')).ok()).toBe(true);
}

/** The participant search field of the race page. */
export const participantInput = (page: Page) => page.getByPlaceholder('Bib number or name');

/** Picks a participant on the race page by typing in the search field. */
export async function pickParticipant(page: Page, search: string, label: string): Promise<void> {
  const input = participantInput(page);
  await input.fill(search);
  await page.getByRole('option', { name: label }).click();
  await expect(input).toHaveValue(label.replace(/^(\d+) /, '$1 · '));
}

/** Gets the selected participant ready, and waits until the server is waiting for the start crossing. */
export async function getReady(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ready to start' }).click();
  await expect(page.getByText('Waiting for the start…')).toBeVisible();
}

/** Starts a run of the selected participant with the simulated start gate, and waits for its clock. */
export async function startRun(page: Page, request: APIRequestContext): Promise<void> {
  await getReady(page);
  await cross(request, 'start');
  await expect(page.getByRole('timer')).toBeVisible();
}

/** Chooses a line on the race page, which asks for one each time it is opened. */
export async function chooseLine(page: Page, line = 'Line 1'): Promise<void> {
  await page.getByTestId('line-choice').getByRole('button', { name: new RegExp(`^${line}`) }).click();
}
