/** The browser matrix's per-browser options (playwright.config.mjs projects, docs/stage-7-exit-criteria.md 7.1). A spec that ran in
 * Chromium's full headless build (the 'chromium' channel) keeps it there; Firefox and WebKit take their own builds. */
export const chromiumChannel = { channel: [async ({ browserName }, use) => use(browserName === 'chromium' ? 'chromium' : undefined), { scope: 'worker' }] };
