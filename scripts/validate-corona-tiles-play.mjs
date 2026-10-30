/** Light coronas as the original's tiles in Play's default worker mode (docs/coronas.md "On the tile chain").
 * At 02_NYC_BatteryPark the player looks up at Light410 (and with the view turned so its corona
 * straddles each edge of the frame): the simulation's corona scan hands the page DrawFrame's DrawIcon
 * rectangle, the page's vertex shader builds UCanvas::DrawTile's clip and scale and D3DDrv's four
 * vertices from it (sprite-tile-glsl.mjs fpCanvasTile) in the master frame (main.mjs sets the frame
 * around the corona pass).
 *
 * The frame is frozen (deusExViewer.freeze(), the corona pass stops taking icons). In each view, the corona
 * alone against the frame without coronas:
 *   - its lit pixels lie inside the reference tile (src/runtime/sprite-tile.mjs iconVertices from the
 *     icon and the frame's rectangle: the D3D pixel centres its quad covers) and fill most of it;
 *   - with a static probe texture (red first rows, green last rows): the first texture row is on top, as
 *     D3DDrv draws it;
 *   - against the flat orthographic overlay the page drew before (?spriteTiles=off keeps it): the pixels
 *     that differ.
 *
 *   node scripts/validate-corona-tiles-play.mjs [--map M --light L] [--dpr 2]    (CORONA_SHOTS=dir keeps the frames) */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { depthConstants } from '../src/runtime/frame-projection.mjs';
import { iconVertices } from '../src/runtime/sprite-tile.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-corona-tiles-play: no installed game data'); process.exit(0); }
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const map = option('map', '02_NYC_BatteryPark'), lightName = option('light', 'Light410'), dpr = Number(option('dpr', 1));
const summary = [], started = performance.now();
const progress = text => console.error(`[${((performance.now() - started) / 1000).toFixed(0)} s] ${text}`);
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: dpr });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__deusCoronas={get pass(){return coronaPass;},get mainRect(){return mainRect;}};\n` });
  });
  await page.goto(debugUrl(url));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 300000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 300000 });
  progress('the map is loaded');
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(30);
  const aim = await page.evaluate(lookAt => window.deusExViewer.placeProbe({ lookAt }), lightName);
  const shot = () => page.locator('#scene').screenshot();
  const compare = await browser.newPage();
  const loadPng = `async base64 => {
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  }`;
  /** The box of pixels that differ between two frames, their count and the largest channel difference. */
  const diffBox = (a, b) => compare.evaluate(`(async ([a, b]) => {
    const load = ${loadPng};
    const [p, q] = [await load(a), await load(b)];
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0, max = 0, sum = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (!d) continue;
      const k = i / 4, x = k % p.width, y = Math.floor(k / p.width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); count++; max = Math.max(max, d); sum += d;
    }
    return count ? { x0, y0, x1, y1, count, max, mean: sum / count } : null;
  })(${JSON.stringify([a.toString('base64'), b.toString('base64')])})`);
  /** Which of the probe's two colours (red above, green below) dominates the pixels that differ from the frame without it. */
  const halves = (a, b, midY) => compare.evaluate(`(async ([a, b, midY]) => {
    const load = ${loadPng};
    const [p, q] = [await load(a), await load(b)], out = { topRed: 0, topGreen: 0, bottomRed: 0, bottomGreen: 0 };
    for (let i = 0; i < p.data.length; i += 4) {
      const r = p.data[i] - q.data[i], g = p.data[i + 1] - q.data[i + 1];
      if (r === 0 && g === 0 && p.data[i + 2] === q.data[i + 2]) continue;
      const y = Math.floor(i / 4 / p.width), half = y + 0.5 < midY ? 'top' : 'bottom';
      if (r > g) out[half + 'Red']++; else if (g > r) out[half + 'Green']++;
    }
    return out;
  })(${JSON.stringify([a.toString('base64'), b.toString('base64'), midY])})`);
  /** Show corona `only` (null: all, -1: none), with the tile chain on or off. */
  const set = async (tiles, only) => {
    await page.evaluate(([tiles, only]) => {
      window.deusExViewer.spriteTiles(tiles);
      window.__deusCoronas.pass.pool.forEach((m, i) => { m.__shown ??= m.visible; m.visible = m.__shown && (only === null || only === i); });
    }, [tiles, only]);
    await frames(3);
    return shot();
  };
  const probe = (index, on) => page.evaluate(([index, on]) => {
    const m = window.__deusCoronas.pass.pool[index];
    if (!on) { if (m.userData.originalMap) { m.material.map = m.userData.originalMap; m.material.color.copy(m.userData.originalColor); m.userData.originalMap = null; } return; }
    const map = m.material.map, T = map.constructor, data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) data.set(y < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255], 4 * (64 * y + x));
    const t = new T(data, 64, 64);
    t.format = map.format; t.type = map.type; t.colorSpace = map.colorSpace; t.flipY = false; t.magFilter = t.minFilter = 1003;
    t.generateMipmaps = false; t.needsUpdate = true;
    m.userData.originalMap = map; m.userData.originalColor = m.material.color.clone(); m.material.map = t; m.material.color.setRGB(1, 1, 1);
  }, [index, on]);
  const view = async (label, yawOffset) => {
    if (yawOffset) await page.evaluate(([rotation]) => window.deusExViewer.placeProbe({ rotation }), [[aim.rotation[0], (aim.rotation[1] + yawOffset + 65536) & 0xffff, 0]]);
    await frames(70);
    await page.evaluate(() => (window.dispatchEvent(new Event('blur')), window.deusExViewer.freeze()));
    await frames(6);
    // The simulation keeps sending snapshots; the corona pass stops taking them so the frame, its icons and the fade stay one state.
    await page.evaluate(() => { const pass = window.__deusCoronas.pass; if (!pass.keepUpdate) { pass.keepUpdate = pass.update; pass.update = () => ({}); } });
    await frames(3);
    const state = await page.evaluate(() => {
      const pass = window.__deusCoronas.pass, fp = window.deusExViewer.vertexProjection();
      return { fp: { rect: fp.rect, depth: fp.depth }, mainRect: window.__deusCoronas.mainRect, coronas: pass.pool.map((m, i) => ({ i, visible: m.visible,
        icon: m.material.userData.tile.icon.value.toArray(), b: m.material.userData.tile.b.value.toArray(), c: m.material.userData.tile.c.value.toArray(),
        color: m.material.color.toArray() })).filter(c => c.visible) };
    });
    const origin = await page.evaluate(() => { const r = document.querySelector('#scene').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    // The screenshot is in CSS pixels of the page; the drawing buffer is dpr times that.
    const scale = dpr, toCanvas = box => box && { ...box, x0: box.x0 - origin[0] * scale, x1: box.x1 - origin[0] * scale, y0: box.y0 - origin[1] * scale, y1: box.y1 - origin[1] * scale };
    assert.ok(state.coronas.length >= 1, `${label}: a corona is drawn (${state.coronas.length})`);
    const [width, height] = state.fp.rect, { x: xb, y: yb } = state.mainRect, depth = depthConstants(32);
    progress(`${label}: ${state.coronas.length} coronas, frame ${width} x ${height}`);
    const none = await set(true, -1);
    let inside = 0, filled = 0, measured = 0, clipped = 0;
    const lines = [];
    for (const corona of state.coronas.slice(0, 6)) {
      const [x, y, size] = corona.icon;
      const reference = iconVertices({ x, y, xl: size, yl: size }, 1,
        { usize: corona.b[0], vsize: corona.b[1], infoUSize: corona.c[0], infoVSize: corona.c[1], uScale: corona.b[3], vScale: corona.b[3] },
        { fx: width, fy: height, xb, yb }, depth);
      const tileShot = await set(true, corona.i);
      const onBox = toCanvas(await diffBox(tileShot, none));
      if (!reference) { assert.equal(onBox, null, `${label}: corona ${corona.i} is clipped away`); continue; }
      const [v0, , v2] = reference.vertices;
      const expect = { x0: Math.max(Math.ceil(v0.x), xb), y0: Math.max(Math.ceil(v0.y), yb), x1: Math.min(Math.floor(v2.x), xb + width - 1), y1: Math.min(Math.floor(v2.y), yb + height - 1) };
      if (x < 0 || y < 0 || x + size > width || y + size > height) clipped++;
      if (!onBox) continue;
      measured++;
      assert.ok(onBox.x0 >= expect.x0 - 1 && onBox.y0 >= expect.y0 - 1 && onBox.x1 <= expect.x1 + 1 && onBox.y1 <= expect.y1 + 1,
        `${label}: corona ${corona.i}'s pixels ${JSON.stringify(onBox)} lie in the tile ${JSON.stringify(expect)}`);
      inside++;
      const fill = (onBox.x1 - onBox.x0 + 1) * (onBox.y1 - onBox.y0 + 1) / (Math.max(1, expect.x1 - expect.x0 + 1) * Math.max(1, expect.y1 - expect.y0 + 1));
      if (fill > 0.3) filled++;
      // The flat overlay the page drew before (same corona, tile chain off).
      const flatShot = await set(false, corona.i);
      const flat = await diffBox(tileShot, flatShot);
      lines.push(`corona ${corona.i} (${x.toFixed(1)}, ${y.toFixed(1)}, ${size.toFixed(1)}): lit ${onBox.count} px in ${JSON.stringify([onBox.x0, onBox.y0, onBox.x1, onBox.y1])} of tile ${JSON.stringify([expect.x0, expect.y0, expect.x1, expect.y1])}; `
        + `against the flat overlay ${flat ? `${flat.count} px differ (max ${flat.max}, mean ${flat.mean.toFixed(2)})` : 'identical'}`);
      if (process.env.CORONA_SHOTS) await writeFile(`${process.env.CORONA_SHOTS}/${label.replace(/\W+/g, '-')}-${corona.i}-tile.png`, tileShot);
    }
    assert.ok(measured > 0, `${label}: at least one corona is visible`);
    // The probe texture on the first measured corona: the first texture row is the top of the tile.
    const first = state.coronas.find(c => c.icon[2] > 8 && c.icon[0] > -c.icon[2] / 2 && c.icon[0] + c.icon[2] / 2 < width && c.icon[1] > 0 && c.icon[1] + c.icon[2] < height) ?? state.coronas[0];
    const mid = (origin[1] + yb + first.icon[1] + first.icon[2] / 2) * scale;
    await probe(first.i, true);
    const probeNone = await set(true, -1), probeTile = await set(true, first.i), probeFlat = await set(false, first.i);
    const tileHalves = await halves(probeTile, probeNone, mid), flatHalves = await halves(probeFlat, probeNone, mid);
    await probe(first.i, false);
    const upright = h => h.topRed > 4 * h.topGreen && h.bottomGreen > 4 * h.bottomRed;
    assert.ok(upright(tileHalves), `${label}: the tile's first texture row is on top ${JSON.stringify(tileHalves)}`);
    // The flat overlay (a pass without a frame: a camera window's) samples the same way up.
    assert.ok(upright(flatHalves), `${label}: the flat overlay's first texture row is on top ${JSON.stringify(flatHalves)}`);
    await page.evaluate(() => { window.deusExViewer.spriteTiles(true); const pass = window.__deusCoronas.pass; pass.pool.forEach(m => { m.visible = m.__shown ?? m.visible; m.__shown = undefined; });
      pass.update = pass.keepUpdate; pass.keepUpdate = null; window.dispatchEvent(new Event('focus')); });
    summary.push(`${label}: ${state.coronas.length} coronas, ${measured} drawn alone, ${inside} inside the reference tile (${filled} fill over 30% of it, ${clipped} cross the frame's edge); `
      + `probe texture, first row on top: tile ${JSON.stringify(tileHalves)}, flat overlay ${JSON.stringify(flatHalves)}\n  ${lines.join('\n  ')}`);
  };
  await view('centre', 0);
  // Turned so the corona straddles the frame's edges.
  for (const yaw of [-1900, 1900]) await view(`yaw ${yaw}`, yaw);
  assert.deepEqual(errors, [], 'page errors');
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-corona-tiles-play: ok');
