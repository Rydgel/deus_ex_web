import { defineConfig } from '@playwright/test';
// The Stage 7 browser matrix (docs/stage-7-exit-criteria.md D1, row 7.10.2): one project per engine, `--project chromium|firefox|webkit`.
// Playwright's WebKit for Linux is an Ubuntu build that needs Ubuntu's libraries (ICU 74, libxml2.so.2, flite); it runs on macOS,
// or on Linux with DX_WEBKIT=1 where those are installed.
const webkit = process.platform === 'darwin' || process.env.DX_WEBKIT === '1';
export default defineConfig({
  testDir: './browser-tests', timeout: 120_000, workers: 1,
  use: { viewport: { width: 1440, height: 960 }, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    ...(webkit ? [{ name: 'webkit', use: { browserName: 'webkit' } }] : []),
  ],
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
    { command: 'npm run preview', url: 'http://127.0.0.1:5174', reuseExistingServer: true },
  ],
});
