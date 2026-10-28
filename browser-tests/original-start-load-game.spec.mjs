import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';
import { lockedMove } from './menu-cursor.mjs';

// The original's Load Game screen from the default start, as the original shows it with no saves (docs/save-directory.md): a click on MenuMain's
// Load Game button opens MenuScreenLoadGame (native 3013 CreateGameDirectoryObject and the GameDirectory natives behind it), with an empty list,
// no info text, Load Game and Delete Game insensitive and the free space the browser reports (StorageManager.estimate(), a host input); Escape
// returns to MenuMain. The button is reached the way the start's input spec does: the menu's cursor follows relative motion, clamped at the
// corner first. Chromium's new headless mode grants pointer lock and fullscreen, so no window opens on the desktop.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });

test('the default start opens the Load Game screen with the empty save directory and closes it with Escape', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
  const state = async () => ({ menu: (await probe({ op: 'state' }))?.top ?? null, error: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null) });
  const map = name => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map === name && !s.runtimeError; }, name, { timeout: 240_000 });
  // `?saves=off`: the empty directory the original shows with no saves, whatever the dev server's own Save folder holds (browser-tests/save-folder.spec.mjs lists real ones)
  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/?saves=off`);
  await map('DX');
  let box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // takes the pointer
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state()).menu).toBe('deusex.menumain');
  box = await page.locator('#scene').boundingBox();
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  const load = (await probe({ op: 'center', field: 'winButtons', index: 2 })).result;   // MenuMain's third button, Load Game
  let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const go = async (x, y, steps = 20) => { await lockedMove(page, at, { x, y }, steps); at = { x, y }; await page.waitForTimeout(150); };
  for (let k = 0; k < 4; k++) { await go(at.x - box.width / 2, at.y - box.height / 2); await go(at.x + 0.001, at.y + 0.001, 1); }
  await go(at.x + box.width * load.x / buffer.w, at.y + box.height * load.y / buffer.h);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();

  await expect.poll(async () => (await state()).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  expect((await state()).error).toBeNull();
  // the screen's state: no rows, no info, Load Game and Delete Game insensitive, Cancel sensitive
  const list = (await probe({ op: 'list', field: 'lstGames' })).result;
  expect(list.rows).toEqual([]);
  expect(list.selectedCount).toBe(0);
  expect((await probe({ op: 'text', field: 'winSaveInfo' })).result).toBe('');
  const controls = (await probe({ op: 'controls' })).result;
  const sensitive = Object.fromEntries(controls.menu.actionButtons.filter(button => button.window !== null).map(button => [button.key || '(cancel)', controls.windows[button.window].sensitive]));
  expect(sensitive).toEqual({ '(cancel)': true, LOAD: false, DELETE: false });
  // the free space is the browser's own estimate (quota less usage, in whole megabytes), or the fixed default when it has none
  const label = (await probe({ op: 'text', field: 'winFreeSpace' })).result;
  expect(label).toMatch(/^Free Space: \d+MB$/);
  const shown = Number(/\d+/.exec(label)[0]);
  const estimate = await page.evaluate(async () => { const e = await navigator.storage?.estimate?.(); return e ? Math.floor((e.quota - e.usage) / 1048576) : null; });
  if (estimate === null) expect(shown).toBe(8192);
  else expect(Math.abs(shown - Math.min(estimate, (2 ** 31 - 1) / 1024))).toBeLessThanOrEqual(Math.max(64, estimate * 0.01));

  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state()).menu).toBe('deusex.menumain');
  expect((await state()).error).toBeNull();
  expect(errors).toEqual([]);
});
