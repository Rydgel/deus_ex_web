/** The loading frame in Play's page (docs/loading-frame.md): a travel and a loaded game keep LoadMap's PaintProgress frame of the level they
 * leave on the canvas for the whole load, as the original does, instead of the page's gate.
 *
 * On the debugging page's first map, 00_Training, in the default worker mode (`--browser firefox` and `--sim inline` for the others):
 * 1. `LocalTravel 00_TrainingCombat` (a travel), then 2. `QuickSave` and `LoadGame -1` (a loaded game). For each load:
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

  await ready('00_Training');
  notes.push(`sim ${(await status()).sim}`);
  await settle(2000);
  await checkLoad('travel', () => exec(['LocalTravel 00_TrainingCombat']), '00_TrainingCombat');
  await page.waitForFunction(async () => { const out = await window.deusExViewer.liveProbe({ read: { names: ['@player'], props: ['dataLinkPlay'] } });
    return out.read['@player']?.dataLinkPlay == null; }, null, { timeout: 180000, polling: 1000 });
  await exec(['QuickSave']);
  await settle(3000);
  await checkLoad('loadgame', () => exec(['LoadGame -1']), '00_TrainingCombat');
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally { await browser.close(); await server.close(); }
for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: a travel and a loaded game keep the darkened PaintProgress frame with the console's LOADING for the whole load, no gate`);
