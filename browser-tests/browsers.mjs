/** The browser matrix's per-browser options (playwright.config.mjs projects, docs/stage-7-exit-criteria.md 7.1). A spec that ran in
 * Chromium's full headless build (the 'chromium' channel) keeps it there; Firefox and WebKit take their own builds. */
export const chromiumChannel = { channel: [async ({ browserName }, use) => use(browserName === 'chromium' ? 'chromium' : undefined), { scope: 'worker' }] };

/** The servers the specs open: the dev server and the production preview that playwright.config.mjs starts, or another checkout's
 * (DX_SUITE_TREE there, or DX_BASE_URL and DX_PREVIEW_URL). */
export const BASE = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';
export const PREVIEW = process.env.DX_PREVIEW_URL ?? 'http://127.0.0.1:5174';
