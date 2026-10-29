/** Sprites in a mirror's child frame, as the original's tiles, in Play's default worker mode (docs/frame-projection.md
 * "A mirror frame's sprites"). 10_Paris_Club's wall mirrors (BSP nodes 16 and 38): the map's Light actors are DT_Sprite
 * editor icons the shipped game hides (bHidden); the nearest ones in front of each mirror are shown (`set` bHidden through
 * placeProbe), so the simulation side's scan has sprites at known places, and the player looks at the mirror from the room
 * (two distances, three lateral offsets). The mirror's OccludeBsp child frame then holds sprites in its Frame->Sprite: the
 * sprite records carry `frames` and FDynamicSprite::Setup's floats of that child frame, `screens[frame]`.
 *
 * The frame is frozen (window blurred, the sprite scene no longer taking snapshots). For each sprite a child frame draws,
 * drawn alone in that frame (hidden in the main frame and in the other passes), against the frame without any sprite:
 *   - the pixels the reflection adds lie inside the reference tile (src/runtime/sprite-tile.mjs from the record's Setup
 *     floats of that child frame and the master frame's rectangle: the canvas holds the master frame while a child frame
 *     draws, docs/frame-projection.md "The canvas' frame") and touch its edges where the mirror's polygon and the geometry in
 *     front of it do not clip the tile;
 *   - with a static probe texture (red first rows, green last rows) the first row is on top in the reflection (a mirror
 *     flips left and right only).
 *
 *   node scripts/validate-sprite-tiles-mirror-play.mjs [--map M --mirrors 16,38 --lights N] [--dpr 1] [--mutate (the reference tile moved 8 pixels: must fail)]
 *   (MIRROR_SHOTS=dir keeps the frames) */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { depthConstants } from '../src/runtime/frame-projection.mjs';
import { spriteVertices } from '../src/runtime/sprite-tile.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-sprite-tiles-mirror-play: no installed game data'); process.exit(0); }
const map = option('map', '10_Paris_Club'), mirrorNodes = option('mirrors', '16,38').split(',').map(Number), wanted = Number(option('lights', 6));
const root = gameDirectory(), files = [];
for (const name of await readdir(path.join(root, 'Maps'))) files.push({ path: `Maps/${name}`, read: () => readFile(path.join(root, 'Maps', name)) });
const assets = new AssetStore(files), decoded = decodeMap((await assets.get(map)).bytes);
// Each mirror polygon and the Light actors in front of it, nearest first.
const units = r => Math.round(r * 32768 / Math.PI);
const mirrors = mirrorNodes.map(index => {
  const node = decoded.model.nodes.at(index), center = [0, 0, 0];
  for (let k = 0; k < node.vertexCount; k++) { const p = decoded.model.points.at(decoded.model.vertices.at(node.vertexPool + k).point); for (let j = 0; j < 3; j++) center[j] += p[j] / node.vertexCount; }
  const normal = node.plane.slice(0, 3), w = node.plane[3];
  const lights = decoded.actors.filter(a => a.className === 'Light' && a.values.Location).map(a => {
    const L = a.values.Location, side = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2] - w;
    return { name: a.name ?? a.objectName, side, distance: Math.hypot(...L.map((v, k) => v - center[k])) };
  }).filter(l => l.side > 16 && l.distance < 700).sort((p, q) => p.distance - q.distance).slice(0, wanted);
  assert.ok(lights.length, `Light actors stand in front of mirror node ${index}`);
  return { index, center, normal, lights };
});
// The player in the room, `distance` units out along the mirror's normal and `lateral` along it, looking at the mirror
// (the eye is 40 above the player's location).
const views = mirrors.flatMap(m => [450, 300].flatMap(distance => [0, -200, 200].map(lateral => {
  const tangent = [-m.normal[1], m.normal[0], 0], length = Math.hypot(tangent[0], tangent[1]) || 1;
  const eye = m.center.map((v, k) => v + m.normal[k] * distance + tangent[k] / length * lateral), aim = m.center.map((v, k) => v - eye[k]);
  return { label: `mirror ${m.index}, ${distance} out, ${lateral} aside`, location: [eye[0], eye[1], eye[2] - 40],
    rotation: [(units(Math.atan2(aim[2], Math.hypot(aim[0], aim[1]))) + 65536) % 65536, (units(Math.atan2(aim[1], aim[0])) + 65536) % 65536, 0] };
})));

const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const summary = [], started = performance.now(), dpr = Number(option('dpr', 1));
const totals = { views: 0, withSprites: 0, pairs: 0, visible: 0, inside: 0, edges: 0, sides: 0, probes: 0, flipped: 0, lit: 0 };
const progress = text => console.error(`[${((performance.now() - started) / 1000).toFixed(0)} s] ${text}`);
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: dpr });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__deusSprites={get scene(){return spriteScene;},get mainRect(){return mainRect;}};\n` });
  });
  await page.goto(debugUrl(url));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 300000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, { timeout: 300000 });
  progress('the map is loaded');
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(30);
  for (const light of new Set(mirrors.flatMap(m => m.lights.map(l => l.name))))
    await page.evaluate(actor => window.deusExViewer.placeProbe({ set: { actor, fields: { bHidden: false } } }), light);
  const shot = () => page.locator('#scene').screenshot();
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
  /** Sprite `only` drawn in child frame `frame` alone (null: nothing drawn at all); no sprite in the main frame. */
  const show = async (only, frame) => {
    await page.evaluate(([only, frame]) => {
      window.__deusSprites.scene.root.children.forEach((o, i) => {
        o.userData.saved ??= { main: o.userData.main, frames: o.userData.frames };
        o.userData.main = false; o.userData.frames = i === only ? [frame] : null;
      });
    }, [only, frame]);
    await frames(3);
    return shot();
  };
  const restore = () => page.evaluate(() => window.__deusSprites.scene.root.children.forEach(o => { if (o.userData.saved) { o.userData.main = o.userData.saved.main; o.userData.frames = o.userData.saved.frames; o.userData.saved = null; } }));
  const probe = (index, on) => page.evaluate(([index, on]) => {
    const o = window.__deusSprites.scene.root.children[index];
    if (!on) { if (o.userData.originalMap) { o.material.map = o.userData.originalMap; o.userData.originalMap = null; } return; }
    const map = o.material.map, T = map.constructor, data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) data.set(y < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255], 4 * (64 * y + x));
    const t = new T(data, 64, 64);
    t.format = map.format; t.type = map.type; t.colorSpace = map.colorSpace; t.flipY = false; t.magFilter = t.minFilter = 1003;
    t.generateMipmaps = false; t.needsUpdate = true;
    o.userData.originalMap = map; o.material.map = t;
  }, [index, on]);

  for (const view of views) {
    totals.views++;
    await page.evaluate(([location, rotation]) => window.deusExViewer.placeProbe({ location, rotation }), [view.location, view.rotation]);
    await frames(60);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await frames(6);
    // The simulation keeps sending snapshots; the sprite scene stops taking them so the frame, its records and Setup's floats stay one state.
    await page.evaluate(() => { const scene = window.__deusSprites.scene; if (!scene.keepUpdate) { scene.keepUpdate = scene.update; scene.update = () => {}; } });
    await frames(3);
    const state = await page.evaluate(() => {
      const scene = window.__deusSprites.scene, fp = window.deusExViewer.vertexProjection();
      return { fp: { rect: fp.rect }, mainRect: window.__deusSprites.mainRect, sprites: scene.root.children.map((o, i) => ({ i, visible: o.visible,
        main: o.userData.main, frames: o.userData.frames, screens: o.userData.screens, b: o.material.userData.tile.b.value.toArray(), c: o.material.userData.tile.c.value.toArray() })) };
    });
    const origin = await page.evaluate(() => { const r = document.querySelector('#scene').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    const [width, height] = state.fp.rect, { x: xb, y: yb } = state.mainRect, depth = depthConstants(32);
    const inFrames = state.sprites.filter(s => s.frames?.length && s.screens);
    progress(`${view.label}: ${state.sprites.length} sprites, ${state.sprites.filter(s => s.main).length} in the main frame, ${inFrames.length} in a child frame`);
    const lines = [];
    if (inFrames.length) {
      totals.withSprites++;
      const none = await show(null, 0);
      let probed = false;
      for (const sprite of inFrames) for (const frame of sprite.frames) {
        totals.pairs++;
        const screen = sprite.screens[frame];
        assert.ok(screen, `sprite ${sprite.i} carries Setup's floats of child frame ${frame}`);
        const [z, sx, sy, persp] = screen;
        const reference = spriteVertices({ z, screenX: sx, screenY: sy, persp, drawScale: sprite.b[2] },
          { usize: sprite.b[0], vsize: sprite.b[1], infoUSize: sprite.c[0], infoVSize: sprite.c[1], uScale: sprite.b[3], vScale: sprite.b[3] },
          { fx: width, fy: height, xb, yb }, depth);
        const box = await diffBox(await show(sprite.i, frame), none);
        const lit = box && { ...box, x0: box.x0 - origin[0] * dpr, x1: box.x1 - origin[0] * dpr, y0: box.y0 - origin[1] * dpr, y1: box.y1 - origin[1] * dpr };
        if (!reference) { assert.equal(lit, null, `${view.label}: sprite ${sprite.i} in frame ${frame} is clipped away`); continue; }
        const [v0, , v2] = reference.vertices;
        // --mutate: the reference tile 8 pixels to the right of where the original puts it; the comparison must fail.
        const shift = process.argv.includes('--mutate') ? 8 : 0;
        const expect = { x0: Math.max(Math.ceil(v0.x + shift), xb), y0: Math.max(Math.ceil(v0.y), yb), x1: Math.min(Math.floor(v2.x + shift), xb + width - 1), y1: Math.min(Math.floor(v2.y), yb + height - 1) };
        if (!lit) { lines.push(`sprite ${sprite.i} frame ${frame}: tile ${JSON.stringify(expect)}, nothing lit (the mirror's polygon or geometry hides it)`); continue; }
        totals.visible++; totals.lit += lit.count;
        const within = (b, e) => b.x0 >= e.x0 - 1 && b.y0 >= e.y0 - 1 && b.x1 <= e.x1 + 1 && b.y1 <= e.y1 + 1;
        const mirrored = { x0: 2 * xb + width - 1 - expect.x1, x1: 2 * xb + width - 1 - expect.x0, y0: expect.y0, y1: expect.y1 };
        const direct = within(lit, expect);
        if (!direct && within(lit, mirrored)) totals.flipped++;
        // The sides where the lit box reaches the tile's edge (a mirror polygon or nearer geometry clips the others).
        const touch = (a, b) => Math.abs(a - b) <= 1;
        const sides = [touch(lit.x0, expect.x0), touch(lit.y0, expect.y0), touch(lit.x1, expect.x1), touch(lit.y1, expect.y1)].filter(Boolean).length;
        lines.push(`sprite ${sprite.i} frame ${frame} (Z ${z.toFixed(1)}, ${sprite.b[0]}x${sprite.b[1]} x ${sprite.b[2]}): tile ${JSON.stringify(expect)}, lit ${lit.count} px in ${JSON.stringify([lit.x0, lit.y0, lit.x1, lit.y1])}, `
          + `${direct ? `inside it, reaching ${sides} of its 4 sides` : 'OUTSIDE it'}`);
        assert.ok(direct, `${view.label}: sprite ${sprite.i} in frame ${frame}: lit pixels ${JSON.stringify(lit)} lie in the tile ${JSON.stringify(expect)}`);
        totals.inside++; totals.sides += sides; if (sides >= 3) totals.edges++;
        if (process.env.MIRROR_SHOTS) await writeFile(`${process.env.MIRROR_SHOTS}/mirror-${totals.views}-${sprite.i}-${frame}.png`, await show(sprite.i, frame));
        // The probe texture on the first well-lit sprite of the view: the first texture row is the top of the reflection.
        if (!probed && lit.count >= 150) {
          probed = true;
          await probe(sprite.i, true);
          const probeNone = await show(null, 0), probeOn = await show(sprite.i, frame);
          const mid = (origin[1] + yb + (expect.y0 + expect.y1) / 2) * dpr, h = await halves(probeOn, probeNone, mid);
          await probe(sprite.i, false);
          assert.ok(h.topRed > 4 * h.topGreen && h.bottomGreen > 4 * h.bottomRed, `${view.label}: the reflection's first texture row is on top ${JSON.stringify(h)}`);
          totals.probes++;
          lines.push(`  probe texture, first row on top: ${JSON.stringify(h)}`);
        }
      }
      await restore();
    }
    await page.evaluate(() => { const scene = window.__deusSprites.scene; scene.update = scene.keepUpdate; scene.keepUpdate = null; window.dispatchEvent(new Event('focus')); });
    summary.push(`${view.label} (player ${view.location.map(Math.round)}, yaw ${view.rotation[1]}): ${state.sprites.length} sprites, ${state.sprites.filter(s => s.main).length} in the main frame, ${inFrames.length} drawn by a child frame${lines.length ? '\n  ' + lines.join('\n  ') : ''}`);
  }
  assert.deepEqual(errors, [], 'page errors');
  assert.ok(totals.visible >= 3 && totals.probes >= 1, `child-frame sprites are visible in the mirror (${totals.visible}) and a probe is measured (${totals.probes})`);
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log(`validate-sprite-tiles-mirror-play: ok (${map}: ${totals.views} views, ${totals.withSprites} with a child-frame sprite, ${totals.pairs} sprite-frame pairs, ${totals.visible} visible alone in the final frame (${totals.lit} px), `
  + `${totals.inside} inside their reference tile, ${totals.edges} of them reaching 3 or 4 of its sides, ${totals.flipped} only in the horizontally mirrored tile, ${totals.probes} probe textures upright)`);
