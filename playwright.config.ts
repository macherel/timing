import { defineConfig } from '@playwright/test';
import { PORT, WORK_DIR } from './e2e/env';

/**
 * End-to-end tests: the built app (npm run build) in a browser, with simulated gates instead of USB devices.
 * Run with `npm run test:e2e`, which builds first.
 *
 * The browser is the installed Google Chrome. Set E2E_CHANNEL=chromium to use Playwright's own Chromium instead
 * (install it once with `npx playwright install chromium`).
 */
export default defineConfig({
  testDir: 'e2e',
  // The server has one run in progress at a time: tests run one after the other
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    // Texts and dates as in the assertions, whatever the language of the machine
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node backend/dist/server.js --work-dir "${WORK_DIR}" --port ${PORT}`,
    url: `http://localhost:${PORT}/api/status`,
    env: { TIMING_SIMULATE_GATES: '1' },
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
