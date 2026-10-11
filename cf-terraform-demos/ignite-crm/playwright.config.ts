/**
 * @file Offline Playwright journeys (specification §12.5): the whole application — both Workers,
 *   local D1, and the local Cloudflare Access emulation — driven through a real browser at desktop
 *   and mobile sizes. `webServer` runs `scripts/e2e-server.ts`, which recreates a **dedicated**
 *   local state directory (`.cloudflare/e2e-state`), applies the data and local seed migrations to
 *   it, and starts `cf dev` on its own port. The developer's `pnpm start` state is never touched,
 *   every run starts from the same seed, and no test reaches live Cloudflare infrastructure.
 *   Journeys run serially in one worker because they share that database; each creates records with
 *   a per-project suffix so desktop and mobile runs do not collide.
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * Port for the E2E dev server, distinct from `pnpm start` (5173).
 */
export const E2E_PORT = 5199;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Finite at every level so a wedged journey cannot hang CI or an agent.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  globalTimeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: '.cloudflare/e2e-results',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: `node scripts/e2e-server.ts ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/cdn-cgi/access/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
