import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import path from 'node:path';

// The Load Game screen with the player's real saves (docs/save-storage.md "The folder flow"): copies of the two real saves of the Wine capture
// (docs/save-directory.md) reach the default start by the page's own controls, and its Load Game screen lists them with the info and the snapshot picture the
// original showed, and Load Game loads a slot from the picked folder (docs/travel.md "Play, step 4").
//  1. a folder the player picks: here the origin private file system, a real FileSystemDirectoryHandle, handed to the page by the browser's picker call;
//  2. an import of a Save folder into the browser's storage, and an export of it as a zip.
// Chromium's new headless mode, the default worker mode. The saves are read from DX_SAVE_DIR (default the Wine prefix's Save folder) and never changed.
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });

const base = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';
// (the copy of the Wine prefix's two desktop slots kept in .work/real-saves: the prefix's own Save folder is rewritten by the capture sessions)
const SAVES = process.env.DX_SAVE_DIR ?? new URL('../.work/real-saves', import.meta.url).pathname;
const SLOTS = ['QuickSave', 'Save0001'];
const files = [];
for (const dir of SLOTS) for (const name of await readdir(path.join(SAVES, dir)).catch(() => [])) files.push({ path: `${dir}/${name}`, bytes: await readFile(path.join(SAVES, dir, name)) });
const haveSaves = SLOTS.every(dir => files.some(file => file.path === `${dir}/SaveInfo.dxs`));
test.skip(!haveSaves, 'the real saves are not here');

// What the original's screen showed for them (docs/save-directory.md "Measured", sd1/load1.png and load2.png)
const ROWS = [['UNATCO Training Course', '09/12/2026 02:47pm', '1368353280.000000', '1.000000'], ['Quick Save', '09/09/2026 02:27pm', '1368051968.000000', '-1.000000']];
const INFO = ['Location: UNATCO Training Course\nSave Count: 1\nPlay Time: 00:16:23\nFile Size: 4MB', 'Location: UNATCO Training Course\nSave Count: 4\nPlay Time: 00:56:46\nFile Size: 4MB'];

const probe = (page, step) => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const state = async page => ({ menu: (await probe(page, { op: 'state' }))?.top ?? null, error: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null) });
const ready = (page, name) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map === name && !s.runtimeError; }, name, { timeout: 240_000 });
const frames = (page, n = 8) => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); await window.deusExViewer.settled(); }, n);
const savesStatus = page => page.evaluate(() => window.deusExViewer.saves.status());

/** The folder a player would pick: the installation `Deus Ex` (a `System` folder and its `Save`) in the origin private file system, a real
 * FileSystemDirectoryHandle, written from a page of the same origin that is not the game; `showDirectoryPicker` then answers with it as the picker does for
 * the player's choice. (Chromium's headless mode closes the page when it reads a stored handle back out of IndexedDB, as the page does at a later visit,
 * so the later-visit path is not driven here: test/save-persistence.test.mjs covers it against a fake handle.) */
async function seedFolder(page) {
  await page.goto(`${base}/__game__/manifest`);
  await page.evaluate(async list => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('Deus Ex', { recursive: true }); } catch { /* none yet */ }
    const top = await root.getDirectoryHandle('Deus Ex', { create: true });
    await top.getDirectoryHandle('System', { create: true });
    const save = await top.getDirectoryHandle('Save', { create: true });
    for (const { path, b64 } of list) {
      const [dir, name] = path.split('/');
      const handle = await (await save.getDirectoryHandle(dir, { create: true })).getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      await writable.close();
    }
  }, files.map(file => ({ path: file.path, b64: file.bytes.toString('base64') })));
  await page.addInitScript(() => {
    window.pickerCalls = [];
    window.showDirectoryPicker = async options => { window.pickerCalls.push(options); return (await navigator.storage.getDirectory()).getDirectoryHandle('Deus Ex'); };
  });
}

/** The file sizes in the seeded folder, to show the page changed nothing there. */
const folderSizes = page => page.evaluate(async () => {
  const save = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Deus Ex')).getDirectoryHandle('Save');
  const out = {};
  for await (const dir of save.values()) for await (const entry of dir.values()) out[`${dir.name}/${entry.name}`] = (await entry.getFile()).size;
  return out;
});

/** Click a window of the menu: the pointer is released first (the game holds it), then moved to the window's centre, the way the menu's cursor follows
 * the mouse (relative motion, clamped at the corner first, as the default start's input spec does). */
async function clickWindow(page, field, index, actionKey) {
  const box = await page.locator('#scene').boundingBox();
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  const target = (await probe(page, { op: 'center', ...(actionKey ? { actionKey } : { field, ...(index === undefined ? {} : { index }) }) })).result;
  let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const go = async (x, y, steps = 20) => { await page.mouse.move(x, y, { steps }); at = { x, y }; await page.waitForTimeout(150); };
  // A free pointer reaches the menu at its own position; a locked one moves the menu's cursor by relative motion (parked in the corner first).
  if (await page.evaluate(() => Boolean(document.pointerLockElement)))
    for (let k = 0; k < 4; k++) { await go(at.x - box.width / 2, at.y - box.height / 2); await go(at.x + 0.001, at.y + 0.001, 1); }
  else at = { x: box.x, y: box.y };
  await go(at.x + box.width * target.x / buffer.w, at.y + box.height * target.y / buffer.h);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
}

/** The main menu, as the default start gets there (the pointer taken with a click, Escape), then its Load Game button. */
async function openLoadGame(page) {
  const box = await page.locator('#scene').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  await clickWindow(page, 'winButtons', 2);                          // MenuMain's third button, Load Game
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  expect((await state(page)).error).toBeNull();
}

/** The picture the Load Game screen shows in its snapshot window, read from the drawing buffer itself: the page's canvas copied, in the animation frame
 * after the game drew it, into a 2D canvas (so each UI pixel is one pixel, whatever the canvas's CSS size). The window's rectangle is the menu driver's
 * `center` (drawing-buffer pixels). */
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

/** How well a shown picture follows a texture's top-left 160 x 120 indices: the Pearson correlation of the grey levels (the display ramp is monotonic, so
 * a correct picture correlates near 1 whatever the ramp). */
function correlation(shown, texture) {
  const xs = [], ys = [];
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) { xs.push(shown.data[(y * shown.width + x) * 4 + 1]); ys.push(texture[y * 256 + x]); }
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/** The Load Game screen against the original's: the rows and the info of the selected row, both rows, and the two snapshot pictures, each the real file's
 * texture (top-left 160 x 120, unscaled) through one function of the palette index, as in the Wine capture (scripts/validate-save-snapshot.mjs). */
async function expectRealSaves(page, label) {
  const { parseSaveInfo } = await import('../src/runtime/save-info.mjs');
  const textures = Object.fromEntries(SLOTS.map(dir => [dir, parseSaveInfo(files.find(file => file.path === `${dir}/SaveInfo.dxs`).bytes).snapshot.image.data]));
  const list = (await probe(page, { op: 'list', field: 'lstGames' })).result;
  expect(list.rows, `${label}: rows`).toEqual(ROWS);
  expect(list.selected).toBe(0);
  expect((await probe(page, { op: 'text', field: 'winSaveInfo' })).result).toBe(INFO[0]);
  const controls = (await probe(page, { op: 'controls' })).result;
  const sensitive = Object.fromEntries(controls.menu.actionButtons.filter(button => button.window !== null).map(button => [button.key || '(cancel)', controls.windows[button.window].sensitive]));
  expect(sensitive).toEqual({ '(cancel)': true, LOAD: true, DELETE: true });
  const checkPicture = async (slot, other) => {
    await frames(page, 6);
    const shot = await shownPicture(page);
    expect([shot.image.width, shot.image.height], `${slot}: the snapshot window`).toEqual([160, 120]);
    expect(correlation(shot.image, textures[slot])).toBeGreaterThan(0.97);
    expect(correlation(shot.image, textures[other])).toBeLessThan(0.9);
    const seen = new Map();
    let conflicts = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
      const index = textures[slot][y * 256 + x], level = shot.image.data[(y * 160 + x) * 4 + 1];
      if (!seen.has(index)) seen.set(index, level); else if (seen.get(index) !== level) conflicts++;
    }
    expect(conflicts, `${slot}: every pixel of the picture is one function of the texture's index`).toBe(0);
    const ordered = [...seen].sort((a, b) => a[0] - b[0]).map(([, level]) => level);
    expect(ordered.every((level, i) => i === 0 || level >= ordered[i - 1]), `${slot}: the display ramp does not reverse`).toBe(true);
    return shot;
  };
  const first = await checkPicture('Save0001', 'QuickSave');
  console.log(`${label}: snapshot window ${first.rect.w}x${first.rect.h} buffer px at (${first.rect.x}, ${first.rect.y})`);
  await page.keyboard.press('ArrowDown'); await frames(page, 6);
  expect((await probe(page, { op: 'list', field: 'lstGames' })).result.selected).toBe(1);
  expect((await probe(page, { op: 'text', field: 'winSaveInfo' })).result).toBe(INFO[1]);
  await checkPicture('QuickSave', 'Save0001');
  await page.screenshot({ path: `reports/browser/load-game-saves-${label}.png` });
  await page.keyboard.press('ArrowUp'); await frames(page, 4);
}

test('a folder the player picks is the save directory: the default start lists its real saves with their pictures, and Load Game loads the slot from it', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await seedFolder(page);
  await page.goto(`${base}/`);
  await ready(page, 'DX');
  // the default start's look: no page bars and no Saves window; the saves are where the browser keeps them until the player picks a folder
  expect(await page.locator('.toolbar').isVisible()).toBe(false);
  expect(await page.locator('#saves-dialog').evaluate(dialog => dialog.open)).toBe(false);
  expect(await savesStatus(page)).toMatchObject({ source: 'browser', slots: 0, canPickFolder: true });
  // The page's own controls appear only while an original menu holds the mouse (no shortcut: on the default start Alt is the game's
  // Strafe). The Saves button opens the Saves window; "Use a Save folder" is the player's pick of the game folder: its Save folder is the
  // save directory.
  await expect(page.locator('#page-buttons')).toBeHidden();
  await page.keyboard.press('Alt+s');
  expect(await page.locator('#saves-dialog').evaluate(dialog => dialog.open)).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  await expect(page.locator('#page-buttons')).toBeVisible();
  await page.locator('#page-saves').click();
  await expect(page.locator('#saves-dialog')).toBeVisible();
  // (the dev server adds that it also lists the installed game's own Save folder, read-only)
  await expect(page.locator('#saves-status')).toHaveText(/^Saves are kept in this browser \(0 saves\)\./);
  await page.locator('#saves-folder').click();
  await expect(page.locator('#saves-status')).toHaveText(/^Saves are in the Save folder of “Deus Ex” \(2 saves\)\./);
  expect(await page.evaluate(() => window.pickerCalls)).toEqual([{ id: 'deusex-saves', mode: 'readwrite' }]);
  expect(await savesStatus(page)).toMatchObject({ source: 'folder', slots: 2, folder: { name: 'Deus Ex', state: 'granted', installed: true } });
  await page.screenshot({ path: 'reports/browser/saves-window.png' });
  await page.locator('#saves-close').click();
  await expect(page.locator('#saves-dialog')).not.toBeVisible();

  // MenuMain is still open: its third button, Load Game
  await clickWindow(page, 'winButtons', 2);
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  expect((await state(page)).error).toBeNull();
  await expectRealSaves(page, 'folder');

  // Load Game (docs/travel.md "Play, step 4"): its button reaches LoadGame -> ClientTravel("?loadgame=1"); the page reads the slot's files from the picked folder
  // and the first row, Save0001 (UNATCO Training Course), loads: the saved level with the saved player
  await clickWindow(page, undefined, undefined, 'LOAD');
  await ready(page, '00_training');
  expect((await state(page)).error).toBeNull();
  // nothing was written to the player's folder
  expect(await folderSizes(page)).toEqual(Object.fromEntries(files.map(file => [file.path, file.bytes.length])));
  expect(errors).toEqual([]);
});

test('saves imported into the browser are listed by the default start and exported as a zip of the game\'s Save folder', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/`);
  await ready(page, 'DX');
  // the Saves window from the page button an original menu shows (Escape opens MenuMain)
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).menu).toBe('deusex.menumain');
  await page.locator('#page-saves').click();
  await expect(page.locator('#saves-dialog')).toBeVisible();
  await expect(page.locator('#saves-export')).toBeDisabled();
  // the player chooses the desktop game's Save folder (a webkitdirectory input): its files come in under their own directory names
  await page.locator('#saves-input').setInputFiles(SAVES);
  await expect(page.locator('#saves-status')).toHaveText(/^Saves are kept in this browser \(2 saves\)\./);
  expect(await savesStatus(page)).toMatchObject({ source: 'browser', slots: 2 });
  // the zip: every file at Save/<slot>/<file>, with the bytes the folder had
  const download = page.waitForEvent('download');
  await page.locator('#saves-export').click();
  const zipPath = info.outputPath('saves.zip');
  await (await download).saveAs(zipPath);
  const zip = await readFile(zipPath);
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const entries = [];
  for (let at = zip.readUInt32LE(end + 16), n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const nameLength = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42), size = zip.readUInt32LE(at + 24);
    const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28) + size);
    entries.push({ name: zip.toString('utf8', at + 46, at + 46 + nameLength), crc: zip.readUInt32LE(at + 16), data });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  expect(entries.map(entry => entry.name).sort()).toEqual(files.map(file => `Save/${file.path}`).sort());
  for (const entry of entries) {
    const original = files.find(file => `Save/${file.path}` === entry.name).bytes;
    expect(entry.data.equals(original), `${entry.name}: the bytes the folder had`).toBe(true);
    expect(entry.crc).toBe(crc32(original));
  }
  await page.locator('#saves-close').click();

  // MenuMain is still open: its third button, Load Game
  await clickWindow(page, 'winButtons', 2);
  await expect.poll(async () => (await state(page)).menu, { timeout: 30_000 }).toBe('deusex.menuscreenloadgame');
  await page.waitForTimeout(500);
  expect((await state(page)).error).toBeNull();
  await expectRealSaves(page, 'browser');
  expect(errors).toEqual([]);
});

test('the dev server lists the installed game\'s Save folder read-only and serves only the files of a save', async ({ request }) => {
  const listing = await request.get(`${base}/__game__/saves`);
  expect(listing.status()).toBe(200);
  const { files: listed } = await listing.json();
  for (const entry of listed) {
    expect(entry.dir).toMatch(/^(Save-?\d+|QuickSave|Current)$/i);
    expect(Object.keys(entry).sort()).toEqual(['dir', 'modified', 'name', 'size']);
  }
  if (listed.length) {
    const first = listed[0];
    const served = await request.get(`${base}/__game__/save/${encodeURIComponent(first.dir)}/${encodeURIComponent(first.name)}`);
    expect(served.status()).toBe(200);
    expect((await served.body()).length).toBe(first.size);
  }
  // nothing outside the two levels the game uses: other directories, parents, other levels
  for (const suffix of ['System/DeusEx.ini', 'Maps/00_Training.dx', '..%2FSystem%2FDeusEx.ini/x', 'Save0001/..%2F..%2FSystem%2FDeusEx.ini', 'Save0001/a/b', 'Save0001', 'Save0001/', 'Save0001/%00']) {
    expect((await request.get(`${base}/__game__/save/${suffix}`)).status(), suffix).toBe(404);
  }
  // read-only: no write method, no cross-site read
  expect((await request.post(`${base}/__game__/saves`)).status()).toBe(403);
  expect((await request.put(`${base}/__game__/save/Save0001/SaveInfo.dxs`, { data: 'x' })).status()).toBe(403);
  expect((await request.delete(`${base}/__game__/save/Save0001/SaveInfo.dxs`)).status()).toBe(403);
  expect((await request.get(`${base}/__game__/saves`, { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
});
