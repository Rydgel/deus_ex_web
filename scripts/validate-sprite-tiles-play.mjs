/** Sprites as the original's tiles in Play's default worker mode (docs/frame-projection.md
 * "Sprites"). On 02_NYC_Street the player stands by ParticleGenerator3's vent: the
 * simulation side's records carry FDynamicSprite::Setup's floats for the frame, the
 * page's vertex shader builds DrawActorSprite's rectangle, UCanvas::DrawTile's clip and
 * D3DDrv's four vertices from them (sprite-tile-glsl.mjs).
 *
 * The frame is frozen (deusExViewer.freeze(), the sprite scene stops taking snapshots). In three
 * views (the vent, and rotated so the smoke straddles the frame's edges), for each sprite
 * drawn in the main frame, the sprite alone (the others on a layer the camera does not
 * see) against the frame without any sprite:
 *   - its lit pixels lie inside the reference tile (src/runtime/sprite-tile.mjs from the
 *     record's Setup floats and the frame's rectangle: the D3D pixel centres its quad
 *     covers) and fill most of it;
 *   - with a static probe texture (red first rows, green last rows) on the sprite with both halves most in the frame:
 *     the first texture row is on top, in the tile and in the camera's billboard (the
 *     fallback of a ViewportWindow's pass), and the two differ at the quad's edges only;
 *   - with the probe on every sprite, the whole frame drawn with tiles and with
 *     billboards differs only along the sprites' edges.
 * (Sprites' real textures are fire textures that animate between screenshots, so the
 * probe is the stable measure.)
 *
 *   node scripts/validate-sprite-tiles-play.mjs      (SPRITE_SHOTS=dir keeps the probe frames) */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { depthConstants } from '../src/runtime/frame-projection.mjs';
import { spriteVertices } from '../src/runtime/sprite-tile.mjs';
import { debugUrl } from './page-url.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-sprite-tiles-play: no installed game data'); process.exit(0); }
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const map = '02_NYC_Street', summary = [], started = performance.now();
const progress = text => console.error(`[${((performance.now() - started) / 1000).toFixed(0)} s] ${text}`);
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__deusSprites={get scene(){return spriteScene;},get mainRect(){return mainRect;}};\n` });
  });
  // SPRITE_OLD_ORIENTATION=1: the billboard fallback without its V flip, as it drew before 2026-10-15 (upside down against the
  // original's tile); the run reports the probe's halves for it instead of asserting them.
  const oldOrientation = Boolean(process.env.SPRITE_OLD_ORIENTATION);
  if (oldOrientation) await page.route(/\/src\/viewer\/frame-projection\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('vMapUv.y = 1.0 - vMapUv.y;', '') });
  });
  await page.goto(debugUrl(url));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 300000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 300000 });
  progress('the map is loaded');
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const vent = await page.evaluate(() => window.deusExViewer.renderPassProbe({ locate: 'ParticleGenerator3' }));
  assert.ok(vent, 'ParticleGenerator3 is on the map');
  // The player by the vent, looking up at it; then rotated so the smoke is at the frame's edge.
  await page.evaluate(([x, y, z]) => window.deusExViewer.placeProbe({ location: [x - 160, y, z + 40], rotation: [65536 - 1200, 0, 0] }), vent);
  const shot = () => page.locator('#scene').screenshot();
  // The comparisons run in a page of their own (the screenshots are PNGs).
  const compare = await browser.newPage();
  const loadPng = `async base64 => {
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  }`;
  const diffBox = (a, b) => compare.evaluate(`(async ([a, b]) => {
    const load = ${loadPng};
    const [p, q] = [await load(a), await load(b)];
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      if (p.data[i] === q.data[i] && p.data[i + 1] === q.data[i + 1] && p.data[i + 2] === q.data[i + 2]) continue;
      const k = i / 4, x = k % p.width, y = Math.floor(k / p.width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); count++;
    }
    return count ? { x0, y0, x1, y1, count } : null;
  })(${JSON.stringify([a.toString('base64'), b.toString('base64')])})`);
  // Which of the probe's two colours (red above, green below) dominates the pixels that differ from the frame without sprites,
  // above and below `midY` (page coordinates).
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
  /** Show sprite `only` (null: all, -1: none) with the tiles on or off. */
  const set = async (tiles, only) => {
    await page.evaluate(([tiles, only]) => {
      window.deusExViewer.spriteTiles(tiles);
      window.__deusSprites.scene.root.children.forEach((o, i) => { o.layers.set(only === null || only === i ? 0 : 5); });
    }, [tiles, only]);
    await frames(3);
    return shot();
  };
  /** The probe texture (red first rows over green last rows) on sprites `indices`, or their own textures back. */
  const probe = (indices, on) => page.evaluate(([indices, on]) => {
    for (const i of indices) {
      const o = window.__deusSprites.scene.root.children[i];
      if (!on) { if (o.userData.originalMap) { o.material.map = o.userData.originalMap; o.userData.originalMap = null; } continue; }
      const map = o.material.map, T = map.constructor, data = new Uint8Array(64 * 64 * 4);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) data.set(y < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255], 4 * (64 * y + x));
      const t = new T(data, 64, 64);
      t.format = map.format; t.type = map.type; t.colorSpace = map.colorSpace; t.flipY = false; t.magFilter = t.minFilter = 1003;
      t.generateMipmaps = false; t.needsUpdate = true;
      o.userData.originalMap = map; o.material.map = t;
    }
  }, [indices, on]);
  const view = async (label, expectSprites) => {
    await frames(40);
    await page.evaluate(() => (window.dispatchEvent(new Event('blur')), window.deusExViewer.freeze()));
    await frames(6);
    // The simulation keeps sending snapshots; the sprite scene stops taking them so the frame, its records and the Setup floats stay one state.
    await page.evaluate(() => { const scene = window.__deusSprites.scene; if (!scene.keepUpdate) { scene.keepUpdate = scene.update; scene.update = () => {}; } });
    await frames(3);
    const state = await page.evaluate(() => {
      const scene = window.__deusSprites.scene, fp = window.deusExViewer.vertexProjection();
      return { fp: { rect: fp.rect, depth: fp.depth }, mainRect: window.__deusSprites.mainRect, sprites: scene.root.children.map((o, i) => ({ i, visible: o.visible,
        main: o.userData.main, screens: o.userData.screens, b: o.material.userData.tile.b.value.toArray(), c: o.material.userData.tile.c.value.toArray(),
        style: o.material.userData.blend })).filter(s => s.visible && s.main) };
    });
    // The element screenshot is in page coordinates; the drawing buffer starts at the canvas element's corner.
    const origin = await page.evaluate(() => { const r = document.querySelector('#scene').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    const toCanvas = box => box && { ...box, x0: box.x0 - origin[0], x1: box.x1 - origin[0], y0: box.y0 - origin[1], y1: box.y1 - origin[1] };
    const drawn = state.sprites.filter(s => s.screens?.[0]);
    assert.ok(drawn.length >= expectSprites, `${label}: ${drawn.length} sprites carry the main frame's Setup floats (wanted ${expectSprites})`);
    assert.equal(drawn.length, state.sprites.length, `${label}: every sprite the main frame draws carries them`);
    // The main frame's size is the projection's (the uniform's first two terms); its offset is the page's main rectangle (XB, YB).
    const [width, height] = state.fp.rect, { x: xb, y: yb } = state.mainRect, depth = depthConstants(32);
    progress(`${label}: ${drawn.length} sprites`);
    const none = await set(true, -1);
    let inside = 0, filled = 0, measured = 0;
    const references = new Map();
    for (const sprite of drawn.slice(0, 12)) {
      const [z, sx, sy, persp] = sprite.screens[0];
      const reference = spriteVertices({ z, screenX: sx, screenY: sy, persp, drawScale: sprite.b[2] },
        { usize: sprite.b[0], vsize: sprite.b[1], infoUSize: sprite.c[0], infoVSize: sprite.c[1], uScale: sprite.b[3], vScale: sprite.b[3] },
        { fx: width, fy: height, xb, yb }, depth);
      references.set(sprite.i, reference);
      const onBox = toCanvas(await diffBox(await set(true, sprite.i), none));
      if (!reference) { assert.equal(onBox, null, `${label}: sprite ${sprite.i} is clipped away`); continue; }
      const [v0, , v2] = reference.vertices;
      // The D3D pixel centres the quad covers: columns ceil(x0)..floor(x1), clipped to the frame's rectangle.
      const expect = { x0: Math.max(Math.ceil(v0.x), xb), y0: Math.max(Math.ceil(v0.y), yb), x1: Math.min(Math.floor(v2.x), xb + width - 1), y1: Math.min(Math.floor(v2.y), yb + height - 1) };
      if (!onBox) continue;
      measured++;
      assert.ok(onBox.x0 >= expect.x0 - 1 && onBox.y0 >= expect.y0 - 1 && onBox.x1 <= expect.x1 + 1 && onBox.y1 <= expect.y1 + 1,
        `${label}: sprite ${sprite.i}'s pixels ${JSON.stringify(onBox)} lie in the tile ${JSON.stringify(expect)}`);
      inside++;
      const fill = (onBox.x1 - onBox.x0 + 1) * (onBox.y1 - onBox.y0 + 1) / (Math.max(1, expect.x1 - expect.x0 + 1) * Math.max(1, expect.y1 - expect.y0 + 1));
      if (fill > 0.3) filled++;
    }
    assert.ok(measured > 0, `${label}: at least one sprite is visible`);
    // The probe texture on a measured sprite: the first texture row is the top of the tile (D3DDrv draws V = 0 there). Both halves
    // must show, so the sprite with the most frame rows on the shorter side of its middle: the vent's smoke tiles are taller than
    // the frame, and the first one's middle can sit a few rows above the frame's bottom edge or under it, with the particles' state.
    const candidates = drawn.filter(s => references.get(s.i));
    const rowsEachSide = s => { const { y, yl } = references.get(s.i).icon, middle = y + yl / 2; return Math.min(middle - Math.max(y, 0), Math.min(y + yl, height) - middle); };
    const first = candidates.reduce((best, s) => rowsEachSide(s) > rowsEachSide(best) ? s : best, candidates[0]);
    const reference = references.get(first.i), mid = origin[1] + yb + reference.icon.y + reference.icon.yl / 2;
    await probe([first.i], true);
    const probeNone = await set(true, -1), probeTile = await set(true, first.i), probeBillboard = await set(false, first.i);
    if (process.env.SPRITE_SHOTS) {
      const name = label.replace(/\W+/g, '-');
      await writeFile(`${process.env.SPRITE_SHOTS}/${name}-probe-tile.png`, probeTile); await writeFile(`${process.env.SPRITE_SHOTS}/${name}-probe-billboard.png`, probeBillboard);
    }
    const tileHalves = await halves(probeTile, probeNone, mid), billboardHalves = await halves(probeBillboard, probeNone, mid);
    await probe([first.i], false);
    const upright = h => h.topRed > 4 * h.topGreen && h.bottomGreen > 4 * h.bottomRed;
    assert.ok(upright(tileHalves), `${label}: the tile's first texture row is on top ${JSON.stringify(tileHalves)}`);
    const edge = await diffBox(probeTile, probeBillboard), covered = tileHalves.topRed + tileHalves.bottomGreen;
    if (!oldOrientation) {
      assert.ok(upright(billboardHalves), `${label}: the billboard's first texture row is on top ${JSON.stringify(billboardHalves)}`);
      assert.ok(!edge || edge.count < 0.1 * covered, `${label}: the probe tile and billboard differ in ${edge?.count} of ${covered} pixels`);
    }
    // The probe on every sprite: the whole frame with tiles and with billboards.
    await probe(drawn.map(s => s.i), true);
    const allNone = await set(true, -1), allTiles = await set(true, null), allBillboards = await set(false, null);
    await probe(drawn.map(s => s.i), false);
    const sprites = await diffBox(allTiles, allNone), whole = await diffBox(allTiles, allBillboards);
    await page.evaluate(() => { window.deusExViewer.spriteTiles(true); window.__deusSprites.scene.root.children.forEach(o => o.layers.set(0)); const scene = window.__deusSprites.scene; scene.update = scene.keepUpdate; scene.keepUpdate = null; window.dispatchEvent(new Event('focus')); });
    assert.ok(oldOrientation || !whole || whole.count < 0.1 * sprites.count, `${label}: tiles and billboards differ in ${whole?.count} of ${sprites.count} sprite pixels`);
    summary.push(`${label}: ${drawn.length} sprites with Setup floats; ${measured} drawn alone, ${inside} inside the reference tile (${filled} fill over 30% of it); `
      + `probe texture, first row on top: tile ${JSON.stringify(tileHalves)}, billboard ${JSON.stringify(billboardHalves)}, the two differ in ${edge?.count ?? 0} of ${covered} pixels; `
      + `all sprites with the probe: ${sprites.count} sprite pixels, tiles against billboards differ in ${whole?.count ?? 0}`);
  };
  await frames(120);
  await view('vent', 1);
  // Rotated so the smoke straddles the frame's edges.
  for (const yaw of [-2400, 2400]) {
    await page.evaluate(yaw => window.deusExViewer.placeProbe({ rotation: [65536 - 1200, (yaw + 65536) & 0xffff, 0] }), yaw);
    await frames(30);
    await view(`vent at yaw ${yaw}`, 1);
  }
  assert.deepEqual(errors, [], 'page errors');
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-sprite-tiles-play: ok');
