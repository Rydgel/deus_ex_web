import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { lockedMove } from './menu-cursor.mjs';

// Saving from the default start (travel step 4, docs/travel.md "Play, step 4", docs/save-storage.md "Writing a save"): Escape -> Save Game on 00_Training writes
// `Save0001` through the original's own scripts (MenuScreenSaveGame -> DeusExPlayer.SaveGame, native 3011) into the browser's storage in the original's
// format; the Load Game screen then lists it with its picture; the Quick Save key writes `QuickSave`; Delete Game removes a slot's directory.
// Chromium's new headless mode (no window on the desktop), the default worker mode. The storage is the page's own (IndexedDB of a fresh context).
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });
test.setTimeout(600_000);

const base = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';
const probe = (page, step) => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const state = async page => ({ menu: (await probe(page, { op: 'state' }))?.top ?? null, error: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null) });
const ready = (page, name) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map === name && !s.runtimeError; }, name, { timeout: 240_000 });
const slots = page => page.evaluate(() => window.deusExViewer.saves.list());
const readBytes = async (page, dir, name) => Uint8Array.from(await page.evaluate(([dir, name]) => window.deusExViewer.saves.read(dir, name), [dir, name]));

/** The picture the Load Game screen shows in its snapshot window, read from the drawing buffer (browser-tests/save-folder.spec.mjs has the same). */
async function shownPicture(page) {
  const centre = (await probe(page, { op: 'center', field: 'winSnapshot' })).result;
  const rect = { x: Math.round(centre.x - centre.w / 2), y: Math.round(centre.y - centre.h / 2), w: Math.round(centre.w), h: Math.round(centre.h) };
  for (let attempt = 0; attempt < 20; attempt++) {
    const data = await page.evaluate(rect => new Promise(resolve => requestAnimationFrame(() => {
      const copy = document.createElement('canvas'); copy.width = rect.w; copy.height = rect.h;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(document.querySelector('#scene'), rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      resolve(Array.from(context.getImageData(0, 0, rect.w, rect.h).data));
    })), rect);
    if (data.some(value => value !== 0)) return { image: { width: rect.w, height: rect.h, data: Uint8Array.from(data) }, rect };
  }
  throw new Error('the snapshot window never showed a picture');
}
/** The Pearson correlation of a shown picture's grey levels with a texture's top-left 160 x 120 indices. */
function correlation(shown, texture) {
  const xs = [], ys = [];
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) { xs.push(shown.data[(y * shown.width + x) * 4 + 1]); ys.push(texture[y * 256 + x]); }
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/** The menu cursor follows relative motion under the pointer lock: clamp it at the root's corner, then move by the control's drawing-buffer
 * position (original-start-load-game.spec). A free pointer reaches the menu at its own position: Firefox releases the lock for its prompt
 * when the first kept save asks for persistent storage (navigator.storage.persist(), measured 2026-10-28; docs/save-storage.md). */
async function cursor(page) {
  let box = await page.locator('#scene').boundingBox();
  let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const go = async (x, y, steps = 20) => { await lockedMove(page, at, { x, y }, steps); at = { x, y }; await page.waitForTimeout(120); };
  // (a click with the pointer free takes the lock again on its release, the default start's first click: the cursor is parked anew then)
  const locked = () => page.evaluate(() => Boolean(document.pointerLockElement));
  let ref = null;
  const park = async () => { for (let k = 0; k < 4; k++) { await go(at.x - box.width / 2, at.y - box.height / 2); await go(at.x + 0.001, at.y + 0.001, 1); } ref = { ...at }; };
  if (await locked()) await park();
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  return {
    async click(spec) {
      box = await page.locator('#scene').boundingBox();
      if (!(await locked())) ref = null;
      else if (!ref) await park();
      const target = (await probe(page, { op: 'center', ...spec })).result, origin = ref ?? { x: box.x, y: box.y };
      await go(origin.x + box.width * target.x / buffer.w, origin.y + box.height * target.y / buffer.h);
      await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up(); await page.waitForTimeout(250);
    },
  };
}

test('Esc, Save Game writes Save0001 into the browser; the Load Game screen lists it with its picture; the Quick Save key writes QuickSave; Delete Game removes the slot', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/`);
  await ready(page, 'DX');
  let box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);        // takes the pointer
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  let mouse = await cursor(page);
  await mouse.click({ field: 'winButtons', index: 4 });                          // Training
  await ready(page, '00_Training');
  await page.waitForTimeout(1500);                                               // a few seconds of play: frames drawn, the scene lit

  // Esc -> Save Game
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  mouse = await cursor(page);
  await mouse.click({ field: 'winButtons', index: 1 });                          // Save Game
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreensavegame');
  await page.waitForTimeout(1000);                                               // the screen's two ticks to its preview
  expect((await state(page)).error).toBeNull();
  const rows = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  expect(rows.rows.length).toBe(1);                                              // the new-save row
  await mouse.click({ actionKey: 'SAVE' });
  await expect.poll(async () => (await slots(page)).map(slot => slot.dir), { timeout: 30_000 }).toContain('Save0001');
  await expect.poll(async () => (await state(page)).menu).toBeNull();            // the screen closed (ClearWindowStack)

  const listing = (await slots(page)).find(slot => slot.dir === 'Save0001');
  expect(listing.files.map(file => file.name).sort()).toEqual(['00_training.dxs', 'SaveInfo.dxs']);
  const infoBytes = await readBytes(page, 'Save0001', 'SaveInfo.dxs');
  const info = parseSaveInfo(infoBytes);
  expect(info.properties).toMatchObject({ DirectoryIndex: 1, Description: 'UNATCO Training Course', MissionLocation: 'UNATCO Training Course', MapName: '00_training', saveCount: 1 });
  expect(info.snapshot.image).toMatchObject({ width: 256, height: 128, format: 0 });
  const lit = info.snapshot.image.data.filter((value, i) => value > 8 && i % 256 < 160 && (i >> 8) < 120).length;
  expect(lit).toBeGreaterThan(160 * 120 * 0.2);                                    // a picture of the frame, not the black fallback
  // the level file is a package with the player and its flag store in it
  const level = parsePackage(await readBytes(page, 'Save0001', '00_training.dxs'));
  const classes = new Set(level.exports.map(entry => entry.className));
  for (const name of ['JCDentonMale', 'FlagBase', 'AugmentationManager', 'SkillManager', 'Level']) expect(classes.has(name), name).toBe(true);

  // a second save, named: the typed name replaces the selected default and the edit control's Enter saves it (a new slot, Save0002)
  const saveScreen = async () => {
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
    const cursorAt = await cursor(page);
    await cursorAt.click({ field: 'winButtons', index: 1 });
    await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreensavegame');
    await page.waitForTimeout(1000);
    return cursorAt;
  };
  await saveScreen();
  await page.keyboard.type('My first name');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await slots(page)).map(slot => slot.dir), { timeout: 30_000 }).toContain('Save0002');
  await expect.poll(async () => (await state(page)).menu).toBeNull();
  const named = parseSaveInfo(await readBytes(page, 'Save0002', 'SaveInfo.dxs'));
  expect(named.properties).toMatchObject({ DirectoryIndex: 2, Description: 'My first name', saveCount: 2 });

  // saving over a slot asks first (MB_Overwrite); Yes writes it again, in place
  mouse = await saveScreen();
  const screenRows = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  const over = screenRows.rows.findIndex(row => row[0] === 'UNATCO Training Course');
  expect(over).toBeGreaterThan(0);
  await mouse.click({ field: 'lstGames', row: over });
  await mouse.click({ actionKey: 'SAVE' });
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menuuimessageboxwindow');
  await mouse.click({ field: 'btnYes' });
  await expect.poll(async () => parseSaveInfo(await readBytes(page, 'Save0001', 'SaveInfo.dxs')).properties.saveCount, { timeout: 30_000 }).toBe(3);
  await expect.poll(async () => (await state(page)).menu).toBeNull();
  expect((await slots(page)).map(slot => slot.dir)).toEqual(['Save0001', 'Save0002']);

  // the Load Game screen lists them with the info and the picture
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  mouse = await cursor(page);
  await mouse.click({ field: 'winButtons', index: 2 });                          // Load Game
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  const listed = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  expect(listed.rows.map(row => row[0]).sort()).toEqual(['My first name', 'UNATCO Training Course']);
  expect((await probe(page, { op: 'text', field: 'winSaveInfo' })).result).toMatch(/^Location: UNATCO Training Course\nSave Count: \d\n/);
  // the selected row's picture is the SaveInfo's own: the snapshot window shows the texture's top-left 160 x 120 (through the display ramp: correlation, not equality)
  const slotOf = { 'My first name': 'Save0002', 'UNATCO Training Course': 'Save0001' };
  const shownSlot = slotOf[listed.rows[listed.selected][0]];
  const pictures = Object.fromEntries(await Promise.all(Object.values(slotOf).map(async slot => [slot, parseSaveInfo(await readBytes(page, slot, 'SaveInfo.dxs')).snapshot.image.data])));
  const shown = await shownPicture(page);
  expect([shown.image.width, shown.image.height]).toEqual([160, 120]);
  expect(correlation(shown.image, pictures[shownSlot]), `the ${shownSlot} picture`).toBeGreaterThan(0.97);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBeNull();

  // the Quick Save key
  await expect.poll(async () => { await page.keyboard.press('NumpadAdd'); return (await slots(page)).map(slot => slot.dir); }, { timeout: 120_000, intervals: [1500] }).toContain('QuickSave');
  const quick = parseSaveInfo(await readBytes(page, 'QuickSave', 'SaveInfo.dxs'));
  expect(quick.properties).toMatchObject({ DirectoryIndex: -1, Description: 'Quick Save', MapName: '00_training' });
  // Delete Game: the Load Game screen's Delete button asks, and DeleteGame removes the slot's directory from the storage
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  mouse = await cursor(page);
  await mouse.click({ field: 'winButtons', index: 2 });
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  const both = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  expect(both.rows.map(row => row[0]).sort()).toEqual(['My first name', 'Quick Save', 'UNATCO Training Course']);
  await mouse.click({ field: 'lstGames', row: both.rows.findIndex(row => row[0] === 'UNATCO Training Course') });
  await mouse.click({ actionKey: 'DELETE' });
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menuuimessageboxwindow');
  await mouse.click({ field: 'btnYes' });
  await expect.poll(async () => (await slots(page)).map(slot => slot.dir), { timeout: 30_000 }).toEqual(['QuickSave', 'Save0002']);
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

test('a storage that refuses the save: the game goes on, the failure is named in the Saves window and a toast, the listing is the old one; the next save is kept', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/`);
  await ready(page, 'DX');
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  await (await cursor(page)).click({ field: 'winButtons', index: 4 });
  await ready(page, '00_Training');
  await page.waitForTimeout(1500);
  // the browser's quota is exhausted: IndexedDB refuses the bytes of a file
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__refuse = true;
    IDBObjectStore.prototype.put = function (...args) { if (window.__refuse && this.name === 'savedata') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, args); };
  });
  // (a DataLink plays for a while after the Training starts and refuses a quick save: the key is pressed until the game takes it)
  await expect.poll(async () => { await page.keyboard.press('NumpadAdd'); return page.evaluate(() => window.deusExViewer.saves.status().saveError?.kind ?? null); },
    { timeout: 120_000, intervals: [1500] }).toBe('quota');
  expect(await page.evaluate(() => window.deusExViewer.saves.status().saveError.slot)).toBe('QuickSave');
  await expect(page.locator('#toast')).toContainText('The game could not be saved');
  expect(await slots(page)).toEqual([]);
  expect((await state(page)).error).toBeNull();                                  // the game goes on
  // the simulation's own listing is the old one: the Load Game screen shows no slot
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  const mouse = await cursor(page);
  await mouse.click({ field: 'winButtons', index: 2 });
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  expect((await probe(page, { op: 'list', field: 'lstGames' })).result.rows).toEqual([]);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBeNull();
  // room again: the next save is kept and clears the failure
  await page.evaluate(() => { window.__refuse = false; });
  await page.keyboard.press('NumpadAdd');
  await expect.poll(async () => (await slots(page)).map(slot => slot.dir), { timeout: 30_000, intervals: [1500] }).toEqual(['QuickSave']);
  expect(await page.evaluate(() => window.deusExViewer.saves.status().saveError)).toBeNull();
  expect(errors).toEqual([]);
});
