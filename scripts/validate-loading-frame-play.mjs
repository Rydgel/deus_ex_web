/** The loading and saving frames in Play's page (docs/loading-frame.md): a travel and a loaded game keep LoadMap's PaintProgress frame of the
 * level they leave on the canvas for the whole load, as the original does, instead of the page's gate; a save shows SaveCurrentLevel's
 * PaintProgress frame (SAVING) while it works.
 *
 * On the debugging page's first map, 00_Training, in the default worker mode (`--browser firefox` and `--sim inline` for the others):
 * 1. a menu Save Game (MenuMain's Save Game, then Enter in the new slot's name), 2. `LocalTravel 00_TrainingCombat` (a travel within the mission),
 * 3. the Quick Save key (GreyPlus), then 4. `LoadGame -1` (a loaded game). For each save (the travel's SaveCurrentLevel(-2) too):
 *    - a SAVING frame is drawn: its flash is PaintProgress's (below) and its console tiles are DrawLevelAction's "SAVING" laid out as below;
 *    - on screen in the display frames it is up (read back from the canvas each display frame): darkened, with the blue text's bounding box
 *      SAVING's ink as the original's grab has it (125 x 23 pixels at 1280 x 720, docs/loading-frame.md "Saving"); for the menu save, the
 *      frame before it has no HUD (the screen's root.Hide());
 *    - the slot is written (Save0001, QuickSave) with the frame before as its picture (not the darkened one), and the time the frame was on screen is reported beside the original's (Wine, 00_Training:
 *      Quick Save 67 ms, Save Game 50 ms, the travel's 50 ms).
 * For each load:
 *    - the page's gate stays hidden from the travel to the arrival;
 *    - the travel's frame is the loading frame: its flash is PaintProgress's (FlashScale 0.1 and FlashFog 0, halved and clamped by
 *      UGameEngine::Draw: EndFlash's alpha 25), and its console tiles are Engine.Console.DrawLevelAction's "LOADING" as UCanvas lays it
 *      out: Engine.LargeFont's glyphs (read from Engine.u here) at FrameX/2 - XL/2, FrameY/2 - YL/2 truncated, STY_Translucent, DrawColor
 *      (0, 0, 255);
 *    - on screen during the load: the frame is darkened (its mean brightness a fraction of the frame before the travel) and the blue text's
 *      bounding box is LOADING's ink as the original's measured frame has it (146 x 23 pixels, docs/loading-frame.md), centred on the glyph cells;
 *    - the next level arrives with no Play stop or page error.
 *
 *   node scripts/validate-loading-frame-play.mjs [--browser chromium|firefox] [--sim worker|inline] [--shots DIR] */
import assert from 'node:assert/strict';
import { chromium, firefox } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeFontExport } from '../src/runtime/script-font-model.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';

const NAME = 'validate-loading-frame-play';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const engine = option('browser', 'chromium'), simMode = option('sim', null), shotsDir = option('shots', null);
let root;
try { root = gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }

// Engine.LargeFont's glyphs (Engine.u), the font Console.DrawLevelAction sets for LoadingMessage.
const files = [];
for (const dir of ['System', 'Textures']) for (const name of await readdir(path.join(root, dir))) files.push({ path: `${dir}/${name}`, read: () => readFile(path.join(root, dir, name)) });
const engineAsset = await new AssetStore(files).get('Engine');
const fontIndex = engineAsset.exportsByPath.get('largefont'), fontEntry = engineAsset.pkg.exports.at(fontIndex - 1);
const font = decodeFontExport(engineAsset.bytes.subarray(fontEntry.serialOffset, fontEntry.serialOffset + fontEntry.serialSize), 'LargeFont');
/** PrintActionMessage's tiles for `text` in a `width` x `height` frame: StrLen's XL and YL (each glyph's USize summed, the largest VSize;
 * SpaceX = SpaceY = 0 after Canvas.Reset), SetPos(FrameX/2 - XL/2, FrameY/2 - YL/2) in float, DrawText from the truncated position. */
function expectedTiles(text, width, height) {
  const glyphs = [...text].map(ch => { const c = ch.charCodeAt(0), page = Math.trunc(c / font.charsPerPage); return [page, font.pages[page].chars[c % font.charsPerPage]]; });
  const xl = glyphs.reduce((sum, [, g]) => sum + g[2], 0), yl = Math.max(...glyphs.map(([, g]) => g[3]));
  let x = Math.trunc(Math.fround(Math.fround(width / 2) - Math.fround(xl / 2)));
  const y = Math.trunc(Math.fround(Math.fround(height / 2) - Math.fround(yl / 2)));
  return glyphs.map(([page, [u, v, w, h]]) => { const tile = { page, x, y, width: w, height: h, u, v, color: [0, 0, 255], style: 3 }; x += w; return tile; });
}

const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = engine === 'firefox' ? await firefox.launch() : await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--mute-audio'] });
const failures = [], notes = [];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const target = new URL(debugUrl(`${url}/`));
  target.searchParams.set('antialias', '0');
  if (simMode) target.searchParams.set('sim', simMode);
  await page.goto(target.href);
  const ready = map => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map?.toLowerCase() === map.toLowerCase(); },
    map, { timeout: 300000, polling: 100 });
  const status = () => page.evaluate(() => { const s = window.deusExViewer.status(); return { map: s.map, sim: s.sim, runtimeError: s.runtimeError?.message ?? null }; });
  const exec = lines => page.evaluate(lines => window.deusExViewer.viewProbe({ exec: lines }), lines);
  const settle = ms => page.waitForTimeout(ms);
  const shot = () => page.locator('#scene').screenshot();
  // A PNG screenshot's size, mean brightness and the bounding box of its blue pixels (blue 60 or more above red and green), through the
  // page's own decoder.
  const measure = png => page.evaluate(async data => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0, blue = 0, x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      if (pixels[i + 2] - Math.max(pixels[i], pixels[i + 1]) <= 60) continue;
      const x = (i / 4) % image.width, y = Math.floor(i / 4 / image.width);
      blue++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { width: image.width, height: image.height, mean: sum / (pixels.length / 4) / 3, blue, box: blue ? { x0, x1, y0, y1 } : null };
  }, [...png]);

  /** One load: `start` issues it; the checks above, while it runs and once `arrive` is ready. */
  async function checkLoad(label, start, arrive) {
    await settle(1500);
    const before = await shot();
    if (shotsDir) await writeFile(`${shotsDir}/${label}-before.png`, before);
    // the gate's state on every display frame from here to the arrival
    await page.evaluate(() => {
      const record = window.__loadingRecord = { gateShown: 0, frames: 0, loading: 0 };
      const watch = () => { record.frames++; if (!document.getElementById('gate').hidden) record.gateShown++;
        if (!window.deusExViewer.status().ready) record.loading++; if (!record.done) requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    });
    const previous = await page.evaluate(() => window.deusExViewer.loadingFrame());
    await start();
    await page.waitForFunction(() => !window.deusExViewer.status().ready, null, { timeout: 60000, polling: 20 });
    await settle(200);
    const during = await shot();
    if (shotsDir) await writeFile(`${shotsDir}/${label}-loading.png`, during);
    await ready(arrive);
    const record = await page.evaluate(() => { window.__loadingRecord.done = true; return window.__loadingRecord; });
    const s = await status();
    if (s.runtimeError) failures.push(`${label}: Play stopped: ${s.runtimeError}`);
    if (record.gateShown) failures.push(`${label}: the page's gate showed on ${record.gateShown} of ${record.frames} display frames`);
    const frame = await page.evaluate(() => window.deusExViewer.loadingFrame());
    if (!frame || JSON.stringify(frame) === JSON.stringify(previous)) { failures.push(`${label}: no loading frame was drawn`); return; }
    // the flash UGameEngine::Draw hands EndFlash: FlashScale 0.1 halved, FlashFog 0
    const half = Math.fround(Math.fround(0.1) * 0.5);
    try { assert.deepEqual(frame.flash, { scale: [half, half, half, 0], fog: [0, 0, 0, 0] }); }
    catch { failures.push(`${label}: the loading frame's flash is ${JSON.stringify(frame.flash)}`); }
    const expected = expectedTiles('LOADING', frame.width, frame.height);
    const drawn = frame.tiles.map(t => ({ page: Number(/\.page(\d+)$/.exec(t.texture.key)?.[1]), x: t.x, y: t.y, width: t.width, height: t.height, u: t.u, v: t.v, color: t.color, style: t.style }));
    try { assert.deepEqual(drawn, expected); }
    catch { failures.push(`${label}: console tiles ${JSON.stringify(drawn)} differ from PrintActionMessage's ${JSON.stringify(expected)}`); }
    if (!frame.tiles.every(t => t.texture.package === 'Engine' && t.texture.key.toLowerCase().includes('largefont'))) failures.push(`${label}: a tile is not Engine.LargeFont's page`);
    // on screen (the element screenshot is the canvas's CSS box, which the page may place under its toolbar: only sizes and the horizontal
    // centre are compared)
    const a = await measure(before), b = await measure(during), sx = b.width / frame.width, sy = b.height / frame.height;
    const first = expected[0], last = expected.at(-1), centre = (first.x + last.x + last.width) / 2 * sx;
    const ink = b.box && { width: b.box.x1 - b.box.x0 + 1, height: b.box.y1 - b.box.y0 + 1, centre: (b.box.x0 + b.box.x1 + 1) / 2 };
    notes.push(`${label}: ${frame.width}x${frame.height}, mean brightness ${a.mean.toFixed(1)} -> ${b.mean.toFixed(1)}, ${b.blue} blue pixels, ` +
      `ink ${ink ? `${ink.width}x${ink.height} centred at x ${ink.centre}` : 'none'} (cells centred at ${centre.toFixed(1)}), ${record.loading} display frames loading`);
    if (!(b.mean < a.mean * 0.5 + 1)) failures.push(`${label}: the frame during the load is not darkened (${a.mean.toFixed(1)} -> ${b.mean.toFixed(1)})`);
    if (!ink || Math.abs(ink.width - 146 * sx) > 2 || Math.abs(ink.height - 23 * sy) > 2 || Math.abs(ink.centre - centre) > 3)
      failures.push(`${label}: the blue text on screen is not LOADING's ink (${JSON.stringify(ink)}, ${b.blue} pixels; cells centred at ${centre.toFixed(1)})`);
  }

  /** Each display frame from here until `stop`: the canvas's mean brightness (a 64 x 48 reduction), the bounding box of the blue pixels in
   * the 400 x 120 box at its centre and the green pixels of the HUD's body display in the 100 x 100 corner at its top left, read back right
   * after the page drew, and how many SAVING frames the page had drawn by then. */
  const sample = () => page.evaluate(() => {
    const canvas = document.querySelector('#scene'), small = new OffscreenCanvas(64, 48), box = new OffscreenCanvas(400, 120), corner = new OffscreenCanvas(100, 100);
    const a = small.getContext('2d', { willReadFrequently: true }), b = box.getContext('2d', { willReadFrequently: true }), c = corner.getContext('2d', { willReadFrequently: true });
    const record = window.__savingRecord = { frames: [], done: false };
    const watch = time => {
      if (record.done) return;
      a.drawImage(canvas, 0, 0, 64, 48);
      const px = a.getImageData(0, 0, 64, 48).data;
      let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      const x = Math.round(canvas.width / 2 - 200), y = Math.round(canvas.height / 2 - 60);
      b.clearRect(0, 0, 400, 120); b.drawImage(canvas, x, y, 400, 120, 0, 0, 400, 120);
      const bx = b.getImageData(0, 0, 400, 120).data;
      let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
      for (let i = 0; i < bx.length; i += 4) {
        if (bx[i + 2] - Math.max(bx[i], bx[i + 1]) <= 60) continue;
        const px_ = (i / 4) % 400, py = Math.floor(i / 4 / 400);
        x0 = Math.min(x0, px_); x1 = Math.max(x1, px_); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      c.clearRect(0, 0, 100, 100); c.drawImage(canvas, 0, 0, 100, 100, 0, 0, 100, 100);
      const cx = c.getImageData(0, 0, 100, 100).data;
      let hud = 0; for (let i = 0; i < cx.length; i += 4) if (cx[i + 1] - Math.max(cx[i], cx[i + 2]) > 40) hud++;
      record.frames.push({ time, mean: sum / (px.length / 4) / 3, hud, saving: window.deusExViewer.savingFrames().length,
        ink: x1 < 0 ? null : { width: x1 - x0 + 1, height: y1 - y0 + 1, centre: x + (x0 + x1 + 1) / 2 } });
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  const stopSample = () => page.evaluate(() => { window.__savingRecord.done = true; return window.__savingRecord.frames; });
  const savingFrames = () => page.evaluate(() => window.deusExViewer.savingFrames());
  const slotDirs = () => page.evaluate(async () => (await window.deusExViewer.saves.list()).map(slot => slot.dir));
  /** One SAVING frame (`frame`, a savingFrames() entry): its flash and console tiles. */
  function checkSavingFrame(label, frame) {
    const half = Math.fround(Math.fround(0.1) * 0.5);
    try { assert.deepEqual(frame.flash, { scale: [half, half, half, 0], fog: [0, 0, 0, 0] }); }
    catch { failures.push(`${label}: the SAVING frame's flash is ${JSON.stringify(frame.flash)}`); }
    const expected = expectedTiles('SAVING', frame.width, frame.height);
    const drawn = frame.tiles.map(t => ({ page: Number(/\.page(\d+)$/.exec(t.texture.key)?.[1]), x: t.x, y: t.y, width: t.width, height: t.height, u: t.u, v: t.v, color: t.color, style: t.style }));
    try { assert.deepEqual(drawn, expected); }
    catch { failures.push(`${label}: SAVING tiles ${JSON.stringify(drawn)} differ from PrintActionMessage's ${JSON.stringify(expected)}`); }
    if (!frame.tiles.every(t => t.texture.package === 'Engine' && t.texture.key.toLowerCase().includes('largefont'))) failures.push(`${label}: a SAVING tile is not Engine.LargeFont's page`);
    return expected;
  }
  /** A save started by `start`: the SAVING frame drawn and on screen, the slot `dir` written. `original` the original's time on screen (ms). */
  async function checkSaving(label, start, dir, original, { hudBefore = true } = {}) {
    await settle(1000);
    const count = (await savingFrames()).length;
    await sample();
    // (a few display frames read back first: the frame before the save is among them)
    await page.waitForFunction(() => window.__savingRecord.frames.length >= 5, null, { timeout: 10000, polling: 20 });
    await start();
    try {
      await page.waitForFunction(count => { const list = window.deusExViewer.savingFrames(); return list.length > count && list.at(-1).replacedAt !== null; },
        count, { timeout: 60000, polling: 20 });
    } catch { failures.push(`${label}: no SAVING frame was drawn and replaced`); await stopSample(); return; }
    await settle(300);
    const frames = await stopSample(), frame = (await savingFrames()).at(-1);
    const expected = checkSavingFrame(label, frame);
    if (!(await slotDirs()).includes(dir)) {
      await page.waitForFunction(async dir => (await window.deusExViewer.saves.list()).some(slot => slot.dir === dir), dir, { timeout: 30000, polling: 200 })
        .catch(() => failures.push(`${label}: the slot ${dir} was not written`));
    }
    // the slot's picture is the frame before the SAVING frame (SaveGame's GenerateSnapshot precedes SaveCurrentLevel), not the darkened one:
    // the mean grey of its 160 x 120 against the canvas's mean brightness before the save
    let picture = null;
    try {
      const bytes = Uint8Array.from(await page.evaluate(dir => window.deusExViewer.saves.read(dir, 'SaveInfo.dxs'), dir));
      const image = parseSaveInfo(bytes).snapshot.image;
      let sum = 0; for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) sum += image.data[y * image.width + x];
      picture = sum / (160 * 120);
    } catch (error) { failures.push(`${label}: the slot's picture could not be read (${error.message})`); }
    // on screen (drawing-buffer pixels, the tiles' own): the first display frame read back after the SAVING frame was drawn, the frames that
    // still show it (the same brightness), and the frame before it
    const at = frames.findIndex(f => f.saving > count), first = frames[at], before = frames[at - 1];
    let shown = 0;
    while (at >= 0 && at + shown < frames.length && frames[at + shown].mean === first.mean) shown++;
    const cells = (expected[0].x + expected.at(-1).x + expected.at(-1).width) / 2;
    const shownMs = frame.replacedAt - frame.drawnAt;
    notes.push(`${label}: ${frame.width}x${frame.height} in ${frame.map}, on screen ${shownMs.toFixed(0)} ms (read back in ${shown} display frames; the original's ${original} ms), ` +
      `mean brightness ${before?.mean.toFixed(1)} -> ${first?.mean.toFixed(1)} (the slot's picture ${picture?.toFixed(1)}), HUD corner ${before?.hud} -> ${first?.hud} green pixels, ink ${first?.ink ? `${first.ink.width}x${first.ink.height} centred at x ${first.ink.centre}` : 'none'} (cells centred at ${cells})`);
    if (!first || !before) { failures.push(`${label}: the SAVING frame was not read back on screen`); return; }
    if (!(first.mean < before.mean * 0.5 + 1)) failures.push(`${label}: the SAVING frame is not darkened (${before.mean.toFixed(1)} -> ${first.mean.toFixed(1)})`);
    if (picture !== null && !(picture > before.mean * 0.5)) failures.push(`${label}: the slot's picture (mean ${picture.toFixed(1)}) is darker than the frame before the save (${before.mean.toFixed(1)})`);
    if (!first.ink || Math.abs(first.ink.width - 125) > 2 || Math.abs(first.ink.height - 23) > 2 || Math.abs(first.ink.centre - cells) > 3)
      failures.push(`${label}: the blue text on screen is not SAVING's ink (${JSON.stringify(first.ink)}; cells centred at ${cells})`);
    // the HUD's body display: drawn in the frame before a Quick Save's SAVING frame, not before the Save Game screen's (root.Hide())
    if (hudBefore ? before.hud < 50 : before.hud > 0) failures.push(`${label}: the frame before the SAVING frame has ${before.hud} green HUD pixels in its corner`);
  }

  await ready('00_Training');
  notes.push(`sim ${(await status()).sim}`);
  await settle(2000);
  // 1. a menu Save Game: MenuMain's Save Game, then Enter in the new slot's name (MenuScreenSaveGame.ConfirmSaveGame -> SaveGame -> PerformSave)
  const menuStep = async step => { const out = await page.evaluate(step => window.deusExViewer.settingsProbe(step), step); await settle(400); return out; };
  await checkSaving('menu save', async () => {
    await menuStep({ op: 'menu' });
    await menuStep({ op: 'invoke', screen: 'MenuScreenSaveGame' });
    const top = (await menuStep({ op: 'state' }))?.top;
    if (top !== 'deusex.menuscreensavegame') failures.push(`menu save: the Save Game screen did not open (${top})`);
    await settle(1000);   // the screen's two ticks to its preview
    await page.keyboard.press('Enter');
  }, 'Save0001', 50, { hudBefore: false });
  // 2. the travel, whose SaveCurrentLevel(-2) shows SAVING before LoadMap's LOADING
  const savedBefore = (await savingFrames()).length;
  await checkLoad('travel', () => exec(['LocalTravel 00_TrainingCombat']), '00_TrainingCombat');
  const travelSaving = (await savingFrames()).slice(savedBefore);
  if (travelSaving.length !== 1 || travelSaving[0].map !== '00_Training') failures.push(`travel: ${travelSaving.length} SAVING frames drawn (${travelSaving.map(f => f.map).join(', ')})`);
  else { checkSavingFrame('travel', travelSaving[0]); notes.push(`travel: SAVING on screen ${(travelSaving[0].replacedAt - travelSaving[0].drawnAt).toFixed(0)} ms before LOADING (the original's 50 ms)`); }
  await page.waitForFunction(async () => { const out = await window.deusExViewer.liveProbe({ read: { names: ['@player'], props: ['dataLinkPlay'] } });
    return out.read['@player']?.dataLinkPlay == null; }, null, { timeout: 180000, polling: 1000 });
  // 3. the Quick Save key (DefUser.ini GreyPlus=QuickSave)
  await checkSaving('quick save', () => page.keyboard.press('NumpadAdd'), 'QuickSave', 67);
  await settle(1000);
  await checkLoad('loadgame', () => exec(['LoadGame -1']), '00_TrainingCombat');
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally { await browser.close(); await server.close(); }
for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: a save shows the darkened PaintProgress frame with the console's SAVING while it works; a travel and a loaded game keep the one with LOADING for the whole load, no gate`);
