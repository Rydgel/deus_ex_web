import { test, expect } from '@playwright/test';

// macOS requires a focused native browser window for pointer lock.
test.use({ headless: false });
test('double-click locks the mouse and Escape releases it', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(() => window.deusExViewer?.status().ready);
  await page.bringToFront();
  await page.locator('#scene').dblclick({ position: { x: 450, y: 400 } });
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id)).toBe('scene');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBeNull();
});
