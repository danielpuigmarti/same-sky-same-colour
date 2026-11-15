// Browser tests: Chromium against the site served by tools/serve.mjs.
// The site is served under a folder, as on its public host, so an address that starts with "/" fails here too.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE = '/under-a-folder/';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tools/serve.mjs --quiet --port ${PORT} --base ${BASE}`,
    url: `http://127.0.0.1:${PORT}${BASE}`,
    reuseExistingServer: !process.env.CI,
  },
});
