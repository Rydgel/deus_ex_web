import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// macOS requires a focused native browser window for pointer lock.
test.use({ headless: false });
// A real Escape releases the lock by the browser's own rule, before the page sees the key; Playwright's synthetic Escape does not go
// through that rule (original-start-input.spec.mjs), so the release here is the call the rule makes, document.exitPointerLock(). What
// the page owns is checked: the lost lock lets go of what the player held (main.mjs pointerlockchange: the held keys and the
// simulation's input reset), so the player stops although W is still down.
test('double-click locks the mouse, and a lost lock lets go of the held movement', async ({ page }) => {
  const status = () => page.evaluate(() => window.deusExViewer.status());
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded);
  await page.bringToFront();
  await page.locator('#scene').dblclick({ position: { x: 450, y: 400 } });
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id)).toBe('scene');
  await page.waitForTimeout(300);   // (the lock's own pointerlockchange resets the held input: a key pressed before it runs is let go)
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async () => (await status()).gameplay.player.velocity[0]).toBeGreaterThan(100);
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBeNull();
    await expect.poll(async () => Math.hypot(...(await status()).gameplay.player.velocity.slice(0, 2)), { timeout: 10000 }).toBeLessThan(1);
  } finally { await page.keyboard.up('KeyW'); }
  expect((await status()).runtimeError).toBeNull();
});

test('blur pauses simulation, clears held movement and resumes without catch-up', async ({ page }) => {
  const status = () => page.evaluate(() => window.deusExViewer.status());
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded);
  await page.bringToFront();
  await page.locator('#scene').click({ position: { x: 450, y: 400 } });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await status()).gameplay.player.velocity[0]).toBeGreaterThan(100);
  // Playwright forces focus on its pages. Deliver the event explicitly to test
  // the game's response; actual OS focus/visibility delivery is separate coverage.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  expect((await status()).paused).toBe(true);
  // Worker mode: the frames posted before the blur (run, their time before it) land after it, and the game status comes with every
  // 15th post (main.mjs postSimFrame), so the state the blur froze is the first status that the next one repeats (the player was
  // walking at over 100 units/s). Inline mode has it at once.
  const frozen = await page.evaluate(async () => {
    const viewer = window.deusExViewer;
    if (viewer.status().sim !== 'worker') return viewer.status().gameplay.player;
    const next = async previous => { while (viewer.status().gameplay === previous) await new Promise(resolve => setTimeout(resolve, 20)); return viewer.status().gameplay; };
    for (let last = await next(viewer.status().gameplay); ;) {
      const now = await next(last);
      if (JSON.stringify(now.player) === JSON.stringify(last.player)) return now.player;
      last = now;
    }
  });
  await page.waitForTimeout(600);
  expect((await status()).gameplay.player).toEqual(frozen);
  await page.keyboard.up('KeyW');
  await page.locator('#scene').click({ position: { x: 450, y: 400 } });
  await expect.poll(async () => (await status()).gameplay.player.velocity[0]).toBeLessThan(.1);
  const resumed = (await status()).gameplay.player;
  expect(resumed.position[0] - frozen.position[0]).toBeLessThan(30);
  await page.waitForTimeout(250);
  expect((await status()).gameplay.player.position).toEqual(resumed.position);
});
