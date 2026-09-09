import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests', timeout: 120_000, workers: 1,
  use: { browserName: 'chromium', viewport: { width: 1440, height: 960 }, screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
    { command: 'npm run preview', url: 'http://127.0.0.1:5174', reuseExistingServer: true },
  ],
});
