import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A browser that gives the page no WebGL 2 (docs/stage-7-exit-criteria.md row 7.7.2, docs/boot.md "No WebGL 2"): WebGL turned off for real,
// Chromium's --disable-webgl and Firefox's webgl.disabled. three.js cannot make its renderer, and the gate says what is missing.
test.use({ launchOptions: [async ({ browserName }, use) => use(browserName === 'firefox' ? { firefoxUserPrefs: { 'webgl.disabled': true } } : { args: ['--disable-webgl'] }), { scope: 'worker' }] });

test('with WebGL turned off, the gate says the game needs WebGL 2 instead of a dead page', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/`);
  await expect(page.locator('#gate-title')).toHaveText('This browser cannot draw the game');
  await expect(page.locator('#gate-message')).toContainText('The game needs WebGL 2, which the browser did not give the page');
  await expect(page.locator('#gate-choose')).toBeHidden();
  await expect(page.locator('#gate-saves')).toBeHidden();
  expect(await page.evaluate(() => typeof window.deusExViewer)).toBe('undefined');
  expect(errors.length).toBe(1);                                         // three.js's own throw, which stops the page's module
});
