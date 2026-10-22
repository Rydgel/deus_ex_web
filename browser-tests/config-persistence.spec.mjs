import { test, expect } from '@playwright/test';

// Configuration persistence on the default start (docs/config-persistence.md), in Chromium's new headless mode (which grants fullscreen and the
// pointer lock) and the default worker mode: what the original menus change reaches DeusEx.ini and User.ini in the browser's storage, and a new page
// reads it back as the original reads its files at the next run. The menu steps are the worker-side `settingsProbe` (validation only); the key press
// that rebinds is a real keyboard event.
test.use({ channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 } });

const base = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';
const probe = (page, step) => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const ready = (page, map) => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && !s.runtimeError; }, map, { timeout: 240_000 });
const state = async page => ({ ...(await probe(page, { op: 'state' })), error: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null) });
const frames = (page, n = 12) => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); await window.deusExViewer.settled(); }, n);
const step = async (page, spec) => { const out = await probe(page, spec); await frames(page); return out; };
const storage = page => page.evaluate(() => window.deusExViewer.status().storage);
const buffer = page => page.evaluate(() => { const canvas = document.querySelector('#scene'); return [canvas.width, canvas.height]; });

/** The default start: wait for the logo map, take the pointer with a click, and open the main menu with Escape. */
async function startMenu(page, url = `${base}/`) {
  await page.goto(url);
  await ready(page, 'DX');
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).top).toBe('deusex.menumain');
}

test('a rebound key, a resolution and the options survive a reload, and New Game asks to train once', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await startMenu(page);
  expect(await storage(page)).toMatchObject({ state: 'on' });

  // Settings > Keyboard/Mouse: the second row (Use object in world) takes G, OK
  await step(page, { op: 'invoke', screen: 'MenuSettings' });
  await step(page, { op: 'invoke', screen: 'MenuScreenCustomizeKeys' });
  expect((await probe(page, { op: 'console', command: 'KEYBINDING G' })).result).toBe('ShowGoalsWindow');
  await page.keyboard.press('ArrowDown'); await frames(page, 4);
  await page.keyboard.press('Enter'); await frames(page, 4);
  expect((await probe(page, { op: 'field', name: 'bWaitingForInput' })).result).toBe(true);
  await page.keyboard.press('KeyG'); await frames(page, 4);
  await step(page, { op: 'action', action: 1 });
  expect((await probe(page, { op: 'console', command: 'KEYBINDING G' })).result).toBe('ParseRightClick');

  // a resolution: SetRes fixes the drawing buffer and saves the viewport the page is in (windowed: the click takes only the pointer)
  const before = await buffer(page);
  await step(page, { op: 'console', command: 'SetRes 800x600' });
  await frames(page, 12);
  expect(await buffer(page)).toEqual([800, 600]);
  expect(before).not.toEqual([800, 600]);

  // Settings > Controls: Invert Mouse and Mouse Sensitivity; Game Options: UI/Menu Background
  expect((await state(page)).top).toBe('deusex.menusettings');
  await step(page, { op: 'invoke', screen: 'MenuScreenControls' });
  await step(page, { op: 'press', choice: 'MenuChoice_InvertMouse' });
  await step(page, { op: 'drag', choice: 'MenuChoice_MouseSensitivity', tick: 6 });
  await step(page, { op: 'action', action: 1 });
  await step(page, { op: 'invoke', screen: 'MenuScreenOptions' });
  await step(page, { op: 'press', choice: 'MenuChoice_UIBackground' });
  await step(page, { op: 'press', choice: 'MenuChoice_Subtitles' });
  await step(page, { op: 'action', action: 1 });
  // Brightness, with the console command the Brightness slider sends: the page's control follows it, and the next start takes the saved one
  await step(page, { op: 'console', command: 'set ini:Engine.Engine.ViewportManager Brightness 0.8' });
  await step(page, { op: 'console', command: 'FLUSH' });
  const changed = await state(page);
  expect(changed.player).toMatchObject({ mouseSensitivity: 7, invertMouse: true, uiBackground: 1, subtitles: false });
  expect((await page.evaluate(() => window.deusExViewer.status().brightness))).toBeCloseTo(0.8, 5);

  // Main menu > New Game: the Training Mission prompt, once
  await step(page, { op: 'escape' });
  await step(page, { op: 'button', index: 0 });
  expect((await state(page)).player.askedToTrain).toBe(true);
  expect((await state(page)).top).toMatch(/messagebox/);
  await step(page, { op: 'pressField', field: 'btnNo' });
  expect((await state(page)).top).toBe('deusex.menuselectdifficulty');
  expect((await state(page)).error).toBeNull();

  // a new map reads the kept files, not the installed ones: Training's player has the changed options
  await step(page, { op: 'escape' });
  await step(page, { op: 'button', index: 4 });
  await ready(page, '00_Training');
  expect((await state(page)).player).toMatchObject({ mouseSensitivity: 7, invertMouse: true, uiBackground: 1, subtitles: false, askedToTrain: true });

  // a new page
  await page.reload();
  await ready(page, 'DX');
  expect(await storage(page)).toMatchObject({ state: 'on' });
  expect(await buffer(page)).toEqual([800, 600]);                         // the saved WindowedViewportX/Y (the page starts windowed), at the first frame
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).top).toBe('deusex.menumain');
  expect((await probe(page, { op: 'console', command: 'KEYBINDING G' })).result).toBe('ParseRightClick');
  const again = await state(page);
  expect(again.player).toMatchObject({ mouseSensitivity: 7, invertMouse: true, uiBackground: 1, subtitles: false, askedToTrain: true });
  expect((await page.evaluate(() => window.deusExViewer.status().brightness))).toBeCloseTo(0.8, 5);
  expect((await probe(page, { op: 'console', command: 'GetCurrentRes' })).result).toBe('800x600');
  // New Game goes to the difficulty screen without the prompt
  await step(page, { op: 'button', index: 0 });
  expect((await state(page)).top).toBe('deusex.menuselectdifficulty');
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

test('the debugging page starts from the installed files and keeps nothing', async ({ page }) => {
  await page.goto(`${base}/?debug=1`);
  await ready(page, '00_Training');
  expect(await storage(page)).toMatchObject({ state: 'off' });
  await step(page, { op: 'menu' });
  await step(page, { op: 'invoke', screen: 'MenuSettings' });
  await step(page, { op: 'invoke', screen: 'MenuScreenControls' });
  await step(page, { op: 'press', choice: 'MenuChoice_InvertMouse' });
  await step(page, { op: 'action', action: 1 });
  expect((await state(page)).player.invertMouse).toBe(true);
  await page.reload();
  await ready(page, '00_Training');
  expect((await state(page)).player.invertMouse).toBe(false);
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'deusex-web'))).toBe(false);
});

test('storage the browser blocks: the installed files, a message, settings for the session only', async ({ page }) => {
  // what a browser with site data blocked does: reading indexedDB throws a SecurityError
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }); });
  await startMenu(page);
  const status = await storage(page);
  expect(status).toMatchObject({ state: 'unavailable', kind: 'blocked' });
  expect(status.message).toMatch(/blocks storage/);
  await expect(page.locator('#toast')).toContainText('blocks storage');
  await step(page, { op: 'invoke', screen: 'MenuSettings' });
  await step(page, { op: 'invoke', screen: 'MenuScreenControls' });
  await step(page, { op: 'press', choice: 'MenuChoice_InvertMouse' });
  await step(page, { op: 'action', action: 1 });
  expect((await state(page)).player.invertMouse).toBe(true);
  expect((await state(page)).error).toBeNull();
  await page.reload();
  await ready(page, 'DX');
  await page.mouse.click(640, 400); await page.waitForTimeout(300); await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).top).toBe('deusex.menumain');
  expect((await state(page)).player.invertMouse).toBe(false);
});

test('a database from a newer version is left alone and the page runs on the installed files', async ({ page }) => {
  await page.goto(`${base}/?debug=1`);                                   // an origin to hold the database; the debugging page does not open it
  await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open('deusex-web', 9); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); }));
  await startMenu(page);
  expect(await storage(page)).toMatchObject({ state: 'unavailable', kind: 'newer' });
  await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('deusex-web'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); }));
});

test('?persist=reset forgets what was kept and keeps from then on', async ({ page }) => {
  await startMenu(page);
  await step(page, { op: 'invoke', screen: 'MenuSettings' });
  await step(page, { op: 'invoke', screen: 'MenuScreenControls' });
  await step(page, { op: 'press', choice: 'MenuChoice_InvertMouse' });
  await step(page, { op: 'action', action: 1 });
  await frames(page, 20);
  await startMenu(page, `${base}/`);
  expect((await state(page)).player.invertMouse).toBe(true);
  await startMenu(page, `${base}/?persist=reset`);
  expect((await state(page)).player.invertMouse).toBe(false);
});
