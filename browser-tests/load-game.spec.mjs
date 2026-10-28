import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Loading a saved game in the page (docs/travel.md "Play, step 4"): the real desktop slots of the Wine capture (Save0001 and QuickSave, Training) reach the
// default start's browser storage by the Saves window's import, and are loaded by the original's own controls: the Load Game screen from the logo map's
// menu and from the running game's Escape menu, the QuickLoad key with its confirm box, and Load Game from the menu a death leads to. Chromium's new
// headless mode, the default worker mode. The slots are read from DX_SAVE_DIR (default the Wine prefix's Save folder) and never changed.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });
test.setTimeout(900_000);

const base = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';
const SAVES = process.env.DX_SAVE_DIR ?? new URL('../.work/real-saves', import.meta.url).pathname;
const have = await Promise.all(['Save0001', 'QuickSave'].map(dir => readdir(path.join(SAVES, dir)).then(list => list.includes('SaveInfo.dxs'), () => false)));
test.skip(!have.every(Boolean), 'the real saves are not here');

// The saved pawns (docs/travel.md; the captures w-old1 and w-oldq): where the original put the player after loading each slot
const SAVE0001 = { x: 3132.2, y: 801.9, row: 0 };
const QUICKSAVE = { x: -1149.2, y: 825.8, row: 1 };

const probe = (page, step) => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const menu = async page => (await probe(page, { op: 'state' }))?.top ?? null;
const status = page => page.evaluate(() => { const s = window.deusExViewer.status(); return { ready: s.ready, map: s.map, error: s.runtimeError?.message ?? null, position: s.position, health: s.gameplay?.player?.health ?? null }; });
const ready = (page, name) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && String(s.map).toLowerCase() === name.toLowerCase() && !s.runtimeError; }, name, { timeout: 240_000 });
const frames = (page, n = 8) => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); await window.deusExViewer.settled(); }, n);

/** Click a window of the menu: the pointer is released first (the game holds it), then moved to the window's centre (the default start's input spec). */
async function clickWindow(page, field, index, actionKey) {
  const box = await page.locator('#scene').boundingBox();
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  const target = (await probe(page, { op: 'center', ...(actionKey ? { actionKey } : { field, ...(index === undefined ? {} : { index }) }) })).result;
  let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const go = async (x, y, steps = 20) => { await page.mouse.move(x, y, { steps }); at = { x, y }; await page.waitForTimeout(150); };
  if (await page.evaluate(() => Boolean(document.pointerLockElement)))
    for (let k = 0; k < 4; k++) { await go(at.x - box.width / 2, at.y - box.height / 2); await go(at.x + 0.001, at.y + 0.001, 1); }
  else at = { x: box.x, y: box.y };
  await go(at.x + box.width * target.x / buffer.w, at.y + box.height * target.y / buffer.h);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
}

/** MenuMain (the pointer taken with a click first on the logo map), its Load Game button, then the row `row` of the screen and its Load button. */
async function loadFromMenu(page, row, { opened = false } = {}) {
  if (!opened) {
    await page.keyboard.press('Escape');
    await expect.poll(() => menu(page)).toBe('deusex.menumain');
  }
  await clickWindow(page, 'winButtons', 2);
  await expect.poll(() => menu(page), { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  const rows = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  expect(rows.rows.length).toBeGreaterThanOrEqual(2);
  for (let k = rows.selected; k < row; k++) { await page.keyboard.press('ArrowDown'); await frames(page, 4); }
  expect((await probe(page, { op: 'list', field: 'lstGames' })).result.selected).toBe(row);
  await clickWindow(page, undefined, undefined, 'LOAD');
}

const near = (position, slot) => Math.abs(position[0] - slot.x) < 2 && Math.abs(position[1] - slot.y) < 2;

test('real desktop slots load from the logo map\'s menu, the running game\'s menu and QuickLoad, and Load Game works after a death', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/`);
  await ready(page, 'DX');
  // the player's slots: the desktop game's Save folder imported into the browser's storage by the Saves window
  await page.keyboard.press('Escape');
  await expect.poll(() => menu(page)).toBe('deusex.menumain');
  await page.locator('#page-saves').click();
  await page.locator('#saves-input').setInputFiles(SAVES);
  await expect(page.locator('#saves-status')).toHaveText(/\(\d+ saves\)/);
  await page.locator('#saves-close').click();

  // 1. Load Game from the logo map's menu (still open): row 0 is Save0001 (UNATCO Training Course)
  await loadFromMenu(page, SAVE0001.row, { opened: true });
  await ready(page, '00_training');
  await frames(page, 30);
  let s = await status(page);
  expect(s.error).toBeNull();
  expect(near(s.position, SAVE0001), `the player stands where Save0001 left it: ${s.position}`).toBe(true);
  await page.screenshot({ path: 'reports/browser/load-game-save0001.png' });

  // 2. from the running game's Escape menu: QuickSave (row 1)
  await loadFromMenu(page, QUICKSAVE.row);
  await expect.poll(async () => near((await status(page)).position, QUICKSAVE), { timeout: 240_000 }).toBe(true);
  await ready(page, '00_training');
  s = await status(page);
  expect(s.error).toBeNull();

  // 3. QuickLoad: the player walks away, the numpad slash key opens the original's confirm box, its Yes button loads QuickSave again
  await frames(page, 30);
  for (let attempt = 0; attempt < 4 && near((await status(page)).position, QUICKSAVE); attempt++) {
    await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW'); await frames(page, 10);
  }
  expect(near((await status(page)).position, QUICKSAVE), `the player walked away from ${QUICKSAVE.x}, ${QUICKSAVE.y}`).toBe(false);
  await page.keyboard.press('NumpadDivide');
  await expect.poll(() => menu(page), { timeout: 30_000 }).toBe('deusex.menuuimessageboxwindow');
  await page.screenshot({ path: 'reports/browser/load-game-quickload-box.png' });
  await clickWindow(page, 'btnYes');
  await expect.poll(async () => near((await status(page)).position, QUICKSAVE), { timeout: 240_000 }).toBe(true);
  await ready(page, '00_training');

  // 4. death: the console's Suicide, 20 s of the dying camera, `OPEN DXONLY`, the menu, Load Game
  await page.evaluate(() => window.deusExViewer.viewProbe({ exec: ['Suicide'] }));
  await expect.poll(async () => String((await status(page)).map).toLowerCase(), { timeout: 120_000 }).toBe('dxonly');
  await ready(page, 'DXOnly');
  await page.keyboard.press('Escape');
  await expect.poll(() => menu(page), { timeout: 30_000 }).toBe('deusex.menumain');
  await page.screenshot({ path: 'reports/browser/load-game-after-death.png' });
  await clickWindow(page, 'winButtons', 2);
  await expect.poll(() => menu(page), { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await clickWindow(page, undefined, undefined, 'LOAD');
  await ready(page, '00_training');
  s = await status(page);
  expect(s.error).toBeNull();
  expect(near(s.position, SAVE0001), `after the death the first row loads Save0001: ${s.position}`).toBe(true);
  expect(errors).toEqual([]);
});
