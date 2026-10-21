/** D3DDrv's detail-texture pass drawn by Play's page, in the default worker mode (docs/frame-projection.md "Detail textures",
 * "Play"). The window is blurred (no simulation step, level time still) and one frozen frame is drawn several ways:
 *   A  the default: the simulation's fans drawn in the recorded states;
 *   B  the detail scene hidden (the frame without the pass);
 *   C  shown again (A must repeat: the noise floor);
 *   D  the fans' alpha words zeroed in the page (alpha 0 at D: the stage's colour is 0x808080, the blend 2 * src * dst, so the
 *      frame must not change beyond the 8-bit rounding of 2 * 128/255).
 * Checks, at close-up views of a Training wall and the Island's pier deck (antialiasing off, so edges are exact):
 *   - the pixels that differ between A and B lie inside the reference fans (the pack's triangles rasterized here on the CPU, one
 *     pixel of margin) and fill most of them; the fans darken what they cover on average (the detail textures' mean is below grey);
 *   - D equals B up to 1 level; A repeats in C;
 *   - at Training's entrance floor mirror at a slant (a mirror frame and a sky frame inside it) every frame that carries fans is
 *     drawn by its own pass: a render call of that frame's camera shows only that frame's meshes;
 *   - ?detailTextures=0 builds no scene and no pack, and its frame equals B inside the fans' region.
 *
 *   node scripts/validate-detail-play.mjs [--dpr 1] [--shots DIR] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-detail-play: no installed game data'); process.exit(0); }
const dpr = Number(option('dpr', 1)), shotsDir = option('shots', null);
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });

const JOBS = [
  { map: '00_Training', views: [
    { name: 'Training wall at 30', location: [-736, 1344 - 30, 560], rotation: [0, 16384, 0] },
    { name: 'Training wall at 120, turned', location: [-1100, 1344 - 120, 560], rotation: [0, 16384 + 5000, 0] },
  ] },
  { map: '01_NYC_UNATCOIsland', views: [
    { name: 'Island deck from 70', location: [-4761, 10431, -304 + 70], rotation: [65536 - 9000, 20000, 0] },
  ] },
];
const MIRROR = { map: '00_Training', name: 'entrance floor mirror, slant', location: [-1149, 1200, -85], rotation: [65536 - 9000, 57344, 0] };
const summary = [];

try {
  const compare = await browser.newPage();
  /** Pixel arrays of two PNGs: the per-pixel largest channel difference and the second image's mean change in the region. */
  const decode = png => compare.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(image.data) };
  }, png.toString('base64'));

  const open = async (map, query) => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: dpr });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\nwindow.__deusDetail={get scene(){return detailScene;},get visible(){return lastVisibility;},renderer,camera};\n` });
    });
    await page.goto(debugUrl(`${url}/?antialias=0${query}`));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    const drawn = n => page.evaluate(async n => {
      const draws = () => window.deusExViewer.framePhases(false).draws, until = draws() + n;
      while (draws() < until) await new Promise(r => requestAnimationFrame(r));
    }, n);
    const shot = async () => decode(await page.locator('#scene').screenshot());
    await frames(30);
    return { page, errors, frames, drawn, shot };
  };

  /** The fans of the main frame as screen triangles (canvas pixels, top-down), from the pack the page drew. */
  const fanTriangles = page => page.evaluate(() => {
    const pack = window.__deusDetail.visible?.detail;
    if (!pack) return [];
    const floats = new Float32Array(pack.buffer, pack.byteOffset, pack.length), out = [];
    for (let at = 1, n = 0; n < pack[0]; n++) {
      const index = pack[at], length = pack[at + 1], words = at + 2;
      at += 2 + length;
      if (index !== 0) continue;
      for (let w = 0; w < length;) {
        const fans = pack[words + w + 3]; w += 4;
        for (let k = 0; k < fans; k++) {
          const count = pack[words + w + 2], first = words + w + 3;
          const vertex = v => [floats[first + 7 * v], floats[first + 7 * v + 1]];
          for (let v = 1; v + 1 < count; v++) out.push([vertex(0), vertex(v), vertex(v + 1)]);
          w += 3 + 7 * count;
        }
      }
    }
    return out;
  });
  /** The pixels (i, j) whose position lies in one of the triangles dilated by `margin` pixels. */
  function coverage(triangles, width, height, margin) {
    const covered = new Uint8Array(width * height), inside = (p, a, b, c) => {
      const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]), d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]),
        d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    for (const [a, b, c] of triangles) {
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - margin - 1)), maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0]) + margin + 1));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - margin - 1)), maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1]) + margin + 1));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (covered[y * width + x]) continue;
        for (let dy = -margin; dy <= margin && !covered[y * width + x]; dy++) for (let dx = -margin; dx <= margin; dx++)
          if (inside([x + dx, y + dy], a, b, c)) { covered[y * width + x] = 1; break; }
      }
    }
    return covered;
  }
  const diff = (a, b, covered, excluded) => {
    let changed = 0, outside = 0, max = 0, covers = 0, darker = 0, brighter = 0, lumA = 0, lumB = 0, coveredChanged = 0;
    for (let p = 0; p < covered.length; p++) {
      if (excluded[p]) continue;
      const i = 4 * p, d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (covered[p]) { covers++; lumA += a.data[i] + a.data[i + 1] + a.data[i + 2]; lumB += b.data[i] + b.data[i + 1] + b.data[i + 2]; }
      if (!d) continue;
      changed++; max = Math.max(max, d);
      if (!covered[p]) outside++; else coveredChanged++;
      if (a.data[i] + a.data[i + 1] + a.data[i + 2] < b.data[i] + b.data[i + 1] + b.data[i + 2]) darker++; else brighter++;
    }
    return { changed, outside, max, covers, coveredChanged, darker, brighter, meanA: lumA / Math.max(1, covers) / 3, meanB: lumB / Math.max(1, covers) / 3 };
  };

  for (const job of JOBS) {
    const session = await open(job.map, '');
    const { page, errors, frames, drawn, shot } = session;
    for (const view of job.views) {
      await page.evaluate(args => window.deusExViewer.placeProbe(args), view);
      await frames(40);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await drawn(6);
      const info = await page.evaluate(() => window.deusExViewer.detail());
      assert.ok(info.on, `${view.name}: the page has a detail scene`);
      assert.deepEqual(info.notes, [], `${view.name}: detail scene notes`);
      let a = await shot();
      for (let attempt = 0; attempt < 10; attempt++) {   // the frozen frame settles (textures decode, atlases upload)
        await drawn(6);
        const again = await shot();
        const settled = again.data.every((v, i) => v === a.data[i]);
        a = again;
        if (settled) break;
      }
      // The HUD's own animation (the augmentation widget) changes a few pixels from frame to frame whatever the pass does: the
      // box of the pixels that differ between two shots of the same frozen frame is left out of every comparison.
      const again = await shot();
      const excluded = new Uint8Array(a.width * a.height);
      {
        let minX = a.width, minY = a.height, maxX = -1, maxY = -1;
        for (let p = 0; p < excluded.length; p++) {
          const i = 4 * p;
          if (a.data[i] !== again.data[i] || a.data[i + 1] !== again.data[i + 1] || a.data[i + 2] !== again.data[i + 2]) {
            const x = p % a.width, y = Math.floor(p / a.width);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
        for (let y = Math.max(0, minY - 4); y <= Math.min(a.height - 1, maxY + 4); y++)
          for (let x = Math.max(0, minX - 4); x <= Math.min(a.width - 1, maxX + 4); x++) excluded[y * a.width + x] = 1;
        assert.ok(maxX < 0 || (maxX - minX) * (maxY - minY) < 0.1 * a.width * a.height, `${view.name}: the frozen frame is stable outside a small region (${minX},${minY}..${maxX},${maxY})`);
      }
      const triangles = await fanTriangles(page);
      assert.ok(triangles.length > 0, `${view.name}: the frame has detail fans (${JSON.stringify(info.frames)})`);
      const detail = await page.evaluate(() => window.deusExViewer.detail());
      assert.ok(detail.drawnTriangles > 0 && detail.meshes.some(m => m.frame === 0), `${view.name}: the page built the fans' meshes`);
      await page.evaluate(() => { window.__deusDetail.scene.root.visible = false; });
      await drawn(3);
      const b = await shot();
      await page.evaluate(() => { window.__deusDetail.scene.root.visible = true; });
      await drawn(3);
      const c = await shot();
      // D: every fan vertex' alpha word zeroed, the page's copy of the pack.
      await page.evaluate(() => {
        const scene = window.__deusDetail.scene, original = scene.update;
        window.__deusDetail.restore = () => { scene.update = original; };
        scene.update = (pack, skip) => {
          if (!pack) return original(pack, skip);
          const copy = pack.slice();
          for (let at = 1, n = 0; n < copy[0]; n++) {
            const length = copy[at + 1], words = at + 2;
            at += 2 + length;
            for (let w = 0; w < length;) {
              const fans = copy[words + w + 3]; w += 4;
              for (let k = 0; k < fans; k++) {
                const count = copy[words + w + 2];
                for (let v = 0; v < count; v++) copy[words + w + 3 + 7 * v + 4] &= 0x00ffffff;
                w += 3 + 7 * count;
              }
            }
          }
          return original(copy, skip);
        };
      });
      await drawn(3);
      const d = await shot();
      await page.evaluate(() => window.__deusDetail.restore());
      await drawn(3);
      const covered = coverage(triangles, a.width, a.height, 1);
      const ab = diff(a, b, covered, excluded), ac = diff(a, c, covered, excluded), db = diff(d, b, covered, excluded);
      if (shotsDir) { await writeFile(`${shotsDir}/${job.map}-${view.name.replace(/\W+/g, '_')}-on.png`, Buffer.from(await page.locator('#scene').screenshot())); }
      assert.equal(ac.changed, 0, `${view.name}: the frame drawn twice with the pass differs`);
      assert.ok(ab.changed > 200, `${view.name}: the pass changes the frame (${ab.changed} pixels)`);
      assert.equal(ab.outside, 0, `${view.name}: ${ab.outside} changed pixels lie outside the reference fans`);
      assert.ok(ab.coveredChanged > 0.3 * triangles.length || ab.coveredChanged > 0.3 * ab.covers, `${view.name}: the changed pixels fill the fans (${ab.coveredChanged} of ${ab.covers})`);
      assert.ok(ab.meanA < ab.meanB, `${view.name}: the fans darken what they cover (mean ${ab.meanB.toFixed(2)} -> ${ab.meanA.toFixed(2)})`);
      assert.ok(db.max <= 1, `${view.name}: alpha 0 leaves the frame unchanged (largest channel difference ${db.max}, ${db.changed} pixels)`);
      summary.push(`${view.name}: ${triangles.length} fan triangles, ${ab.changed} pixels change (${ab.coveredChanged} of ${ab.covers} covered, ${ab.outside} outside, largest ${ab.max}), ` +
        `mean ${ab.meanB.toFixed(2)} -> ${ab.meanA.toFixed(2)}, alpha 0: ${db.changed} pixels (largest ${db.max})`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    assert.deepEqual(errors, [], `${job.map}: page errors`);
    await page.close();
  }

  // Child frames: Training's entrance floor mirror. Each render call shows only the meshes of the frame it draws.
  {
    const { page, errors, frames, drawn } = await open(MIRROR.map, '');
    await page.evaluate(args => window.deusExViewer.placeProbe(args), MIRROR);
    await frames(40);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await drawn(6);
    const info = await page.evaluate(() => window.deusExViewer.detail());
    const withFans = info.frames.map(f => f.index);
    assert.ok(withFans.includes(0) && withFans.some(i => i > 0), `${MIRROR.name}: fans in the main frame and a child frame (${JSON.stringify(info.frames)})`);
    const calls = await page.evaluate(async () => {
      const { renderer, scene } = window.__deusDetail, original = renderer.render.bind(renderer), seen = [];
      renderer.render = (s, camera) => {
        seen.push({ target: renderer.getRenderTarget()?.width ?? null, shown: window.deusExViewer.detail().meshes.filter(m => m.visible).map(m => m.frame) });
        return original(s, camera);
      };
      const draws = () => window.deusExViewer.framePhases(false).draws, until = draws() + 2;
      while (draws() < until) await new Promise(r => requestAnimationFrame(r));
      renderer.render = original;
      return seen;
    });
    const child = calls.filter(call => call.target !== null && call.shown.length), main = calls.filter(call => call.target === null && call.shown.length);
    assert.ok(child.length > 0 && child.every(call => call.shown.every(i => i > 0)), `${MIRROR.name}: a child frame's pass shows only child frames' fans ${JSON.stringify(calls)}`);
    assert.ok(main.length > 0 && main.every(call => call.shown.every(i => i === 0)), `${MIRROR.name}: the main pass shows only the main frame's fans ${JSON.stringify(calls)}`);
    assert.deepEqual(errors, [], `${MIRROR.name}: page errors`);
    summary.push(`${MIRROR.name}: frames with fans ${withFans}; ${child.length} child passes and ${main.length} main passes drew only their own frame's fans`);
    await page.close();
  }

  // The switch: no pass at all.
  {
    const { page, errors, frames, drawn } = await open(JOBS[0].map, '&detailTextures=0');
    await page.evaluate(args => window.deusExViewer.placeProbe(args), JOBS[0].views[0]);
    await frames(40);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await drawn(6);
    const info = await page.evaluate(() => window.deusExViewer.detail());
    assert.equal(info.on, false, '?detailTextures=0: no detail scene');
    assert.deepEqual(info.frames, [], '?detailTextures=0: the simulation side sends no fans');
    assert.deepEqual(errors, [], '?detailTextures=0: page errors');
    summary.push('?detailTextures=0: no scene, no fans');
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-detail-play: ok');
