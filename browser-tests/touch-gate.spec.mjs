import { test, expect, devices } from '@playwright/test';
import { PREVIEW } from './browsers.mjs';

// What the public page shows a visitor (docs/development.md "The public page"), on the production build, before any game folder is chosen.

// A phone: touch is the main pointer and nothing hovers. The game needs a keyboard and a mouse, so the gate says so and offers no folder
// button (style.css, `#gate-touch`). Chromium only: Playwright's phone emulation (isMobile) does not exist in Firefox.
test('on a phone, the gate says the game needs a computer and offers no folder button', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'phone emulation is Chromium\'s');
  const { defaultBrowserType, ...phone } = devices['Pixel 7'];
  const context = await browser.newContext(phone);
  try {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${PREVIEW}/`);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
    await expect(page.getByRole('heading', { name: 'The game needs a computer' })).toBeVisible();
    await expect(page.locator('#gate-touch')).toContainText('a keyboard and a mouse');
    for (const hidden of ['#gate-title', '#gate-message', '#gate-choose', '#gate-saves']) await expect(page.locator(hidden)).toBeHidden();
    await expect(page.locator('#gate-notice')).toContainText('You need your own copy of Deus Ex');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('on a computer, the gate offers the folder button, links to the source and has a tab icon', async ({ page }) => {
  const failures = []; page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${PREVIEW}/`);
  await expect(page.getByRole('heading', { name: 'Open your Deus Ex installation' })).toBeVisible();
  await expect(page.locator('#gate-choose')).toBeVisible();
  await expect(page.locator('#gate-touch')).toBeHidden();
  await expect(page.locator('#gate-notice a')).toHaveAttribute('href', 'https://github.com/Rydgel/deus_ex_web');
  await expect(page.locator('#gate-notice')).toContainText('Embracer Group');
  // The icon is the build's own file (or inlined in the page): fetched from the page, it is an SVG image.
  const icon = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="icon"]'); if (!link) return null;
    const response = await fetch(link.href); return { ok: response.ok, type: response.headers.get('content-type') ?? (await response.blob()).type };
  });
  expect(icon?.ok).toBe(true); expect(icon.type).toContain('image/svg+xml');
  expect(failures).toEqual([]);
});
