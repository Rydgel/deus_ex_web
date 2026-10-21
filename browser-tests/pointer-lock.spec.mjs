import { test, expect } from '@playwright/test';

// macOS requires a focused native browser window for pointer lock.
test.use({ headless: false });
test('double-click locks the mouse and Escape releases it', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/?debug=1');
  await page.waitForFunction(() => window.deusExViewer?.status().ready);
  await page.bringToFront();
  await page.locator('#scene').dblclick({ position: { x: 450, y: 400 } });
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id)).toBe('scene');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBeNull();
});

test('blur pauses simulation, clears held movement and resumes without catch-up', async ({ page }) => {
  const status = () => page.evaluate(() => window.deusExViewer.status());
  await page.goto('http://127.0.0.1:5173/?debug=1');
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded);
  await page.bringToFront();
  await page.locator('#scene').click({ position: { x: 450, y: 400 } });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await status()).gameplay.player.velocity[0]).toBeGreaterThan(100);
  // Playwright forces focus on its pages. Deliver the event explicitly to test
  // the game's response; actual OS focus/visibility delivery is separate coverage.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  expect((await status()).paused).toBe(true);
  const frozen = (await status()).gameplay.player;
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
