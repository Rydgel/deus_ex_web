import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A browser that gives the page no WebGL 2 (docs/stage-7-exit-criteria.md row 7.7.2, docs/boot.md "No WebGL 2"): WebGL turned off for real,
// Chromium's --disable-webgl and Firefox's webgl.disabled. three.js cannot make its renderer, and the gate says what is missing.
// WebKit has no such switch under Playwright (it ignores Chromium's): there the canvas refuses every WebGL context, as a browser
// without WebGL does (getContext returns null), which is modelled, not turned off.
test.use({ launchOptions: [async ({ browserName }, use) => use(browserName === 'firefox' ? { firefoxUserPrefs: { 'webgl.disabled': true } }
  : browserName === 'chromium' ? { args: ['--disable-webgl'] } : {}), { scope: 'worker' }] });

test('with WebGL turned off, the gate says the game needs WebGL 2 instead of a dead page', async ({ page, browserName }) => {
  if (browserName === 'webkit') await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/i.test(type) ? null : getContext.call(this, type, ...rest); };
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/`);
  await expect(page.locator('#gate-title')).toHaveText('This browser cannot draw the game');
  await expect(page.locator('#gate-message')).toContainText('The game needs WebGL 2, which the browser did not give the page');
  await expect(page.locator('#gate-choose')).toBeHidden();
  await expect(page.locator('#gate-saves')).toBeHidden();
  expect(await page.evaluate(() => typeof window.deusExViewer)).toBe('undefined');
  expect(errors.length).toBe(1);                                         // three.js's own throw, which stops the page's module
});
