import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A hidden tab (docs/stage-7-exit-criteria.md row 7.6.4, docs/boot.md): Play draws and ticks nothing while the page is hidden, and comes
// back by itself, with no click and with no catch-up (main.mjs `resumeClock`: the first frame after carries one frame's dt), the held
// input let go. Headless Chromium and Firefox keep a background tab visible (a second tab brought to the front, or the window minimized
// over CDP, leaves `visibilityState` 'visible' and the frames running, measured 2026-10-31), so the hide here is the HTML one modelled:
// `document.hidden`, a `visibilitychange` event, and no animation frame until the page shows again. A real hidden tab, system sleep and
// the audio are not measured by it.
test.use({ viewport: { width: 960, height: 640 } });
test.setTimeout(240_000);

test('a hidden page draws and ticks nothing, and shows again by itself with no catch-up and the held input let go', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let hidden = false; const held = [];
    const frame = window.requestAnimationFrame.bind(window);
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    window.requestAnimationFrame = callback => frame(time => { if (hidden) held.push(callback); else callback(time); });
    window.hidePageForTest = on => {
      hidden = on; document.dispatchEvent(new Event('visibilitychange'));
      if (!on) for (const callback of held.splice(0)) frame(callback);
    };
  });
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded, null, { timeout: 200_000 });
  const view = () => page.evaluate(() => window.deusExViewer.viewProbe({}));
  const drawn = () => page.evaluate(() => window.deusExViewer.status().frame);
  await page.locator('#scene').click({ position: { x: 480, y: 320 } });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.hidePageForTest(true));
  await page.waitForTimeout(200);                                         // a frame in flight lands
  const hidden = { view: await view(), drawn: await drawn() };
  await page.waitForTimeout(3000);
  const still = { view: await view(), drawn: await drawn() };
  expect(still.drawn).toBe(hidden.drawn);                                 // no frame
  expect(still.view.timeSeconds).toBe(hidden.view.timeSeconds);           // no tick
  expect(still.view.location).toEqual(hidden.view.location);
  // shown again, with no click; W is still down on the keyboard, but the page let go of it when it was hidden
  const shown = Date.now();
  await page.evaluate(() => window.hidePageForTest(false));
  await page.waitForFunction(drawn => window.deusExViewer.status().frame > drawn + 20, still.drawn);
  const back = await view(), real = (Date.now() - shown) / 1000;
  const advanced = (back.timeSeconds - still.view.timeSeconds) / back.timeDilation;
  expect(advanced).toBeGreaterThan(0);                                    // it runs again by itself
  expect(advanced).toBeLessThanOrEqual(real + 0.1);                       // and the three hidden seconds are not caught up
  await page.waitForTimeout(1000);
  const settled = await view(); await page.waitForTimeout(500);
  expect((await view()).location).toEqual(settled.location);              // the player is not walking on
  await page.keyboard.up('KeyW');
  expect((await page.evaluate(() => window.deusExViewer.status())).runtimeError).toBeNull();
  expect(errors).toEqual([]);
});
