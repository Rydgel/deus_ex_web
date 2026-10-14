/** The original's vertex projection in Play's default worker mode
 * (docs/frame-projection.md): at seeded views of the Island and the Paris club
 * and in front of the Bar's and the Smugglers' mirrors (mirror child frames),
 * the page draws one frozen frame (the window blurred: no simulation step,
 * Level time still) four ways and compares the PNGs of the 3D view:
 *   A  the vertex stage on (every pass that has a frame projects its vertices
 *      with Render.dll's and D3DDrv's chain),
 *   B  the vertex stage off (the camera's matrices, posed from the same frame),
 *   C  on again (the noise floor: anything that is not the projection),
 *   D  on with the frame's origin moved by 8 units (proves the shader
 *      consumes the frame it is given: a large change).
 * A against B is the change; A against C must be zero and A against D large.
 * The frame the page draws with is also read back: the uniforms during the
 * main pass equal the simulation's master frame words.
 *
 *   node scripts/validate-frame-projection-play.mjs [views per map] [--maps A,B] [--dpr 2] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-frame-projection-play: no installed game data'); process.exit(0); }
const views = Number(process.argv.slice(2).find(arg => /^\d+$/.test(arg)) ?? 4), dpr = Number(option('dpr', 1));
const maps = option('maps', '01_NYC_UNATCOIsland,10_Paris_Club,02_NYC_Bar,00_Training').split(',');
// Fixed views in front of mirrors (docs/mirror-surfaces.md; the club's tunnel).
const FIXED = {
  '10_Paris_Club': [{ location: [2063, 273, 30], rotation: [0, 32768, 0] }, { location: [2063, 273, 30], rotation: [0, 40960, 0] }],
  '02_NYC_Bar': [{ location: [-768, -600, 95], rotation: [0, 49152, 0] }],
  '02_NYC_Hotel': [{ location: [1880, -1158, 148], rotation: [0, 32768, 0] }],
  '02_NYC_Smug': [{ location: [-576, 1530, 250], rotation: [0, 16384, 0] }],
  '11_Paris_Everett': [{ location: [1024, 1640, 430], rotation: [0, 53000, 0] }],
};
const files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const summary = [];
try {
  const compare = await browser.newPage();
  const different = (a, b) => compare.evaluate(async ([x, y]) => {
    const load = async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [p, q] = [await load(x), await load(y)];
    let count = 0, max = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (d) { count++; max = Math.max(max, d); }
    }
    return { count, max, pixels: p.width * p.height };
  }, [a.toString('base64'), b.toString('base64')]);
  for (const map of maps) {
    const asset = await assets.get(map), decoded = decodeMap(asset.bytes);
    let state = 0x9e3779b9 ^ map.length;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const spots = decoded.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: dpr });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    const shot = () => page.locator('#scene').screenshot();
    await frames(30);
    // Training: the player takes the crowbar, so the first-person weapon draws in every frame.
    if (map === '00_Training') {
      await page.evaluate(async () => {
        const viewer = window.deusExViewer, frame = n => new Promise(resolve => { let k = 0; const step = () => (++k >= n ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });
        const at = await viewer.renderPassProbe({ locate: 'WeaponCrowbar1' });
        await viewer.placeProbe({ location: [at[0] - 48, at[1], at[2] + 20], lookAt: 'WeaponCrowbar1' }); await frame(20);
        await viewer.placeProbe({ lookAt: 'WeaponCrowbar1' }); await frame(10);
        await viewer.renderPassProbe({ take: 'WeaponCrowbar1' }); await frame(90);
      });
    }
    // The module the page runs: the perturbation wraps `use`.
    await page.evaluate(async () => {
      const { frameProjection } = await import('/src/viewer/frame-projection.mjs');
      window.__fp = { frameProjection, use: frameProjection.use, shift: 0, passes: [] };
      frameProjection.use = function (projection, rect, view, mirror) {
        window.__fp.passes.push({ origin: projection?.coords?.slice(0, 3), view: { ...view }, mirror });
        const coords = projection?.coords && window.__fp.shift ? projection.coords.map((v, i) => (i === 2 ? v + window.__fp.shift : v)) : projection?.coords;
        return window.__fp.use.call(this, projection && { ...projection, coords }, rect, view, mirror);
      };
    });
    // Views in front of the map's mirrors (surface flag PF_Mirrored), aimed at the polygon.
    const model = decoded.model, mirrorNodes = [];
    model.nodes.forEach((n, i) => { if (n.vertexCount >= 3 && model.surfaces[n.surface].flags & 0x08000000) mirrorNodes.push(i); });
    const mirrorViews = mirrorNodes.length ? Array.from({ length: Math.min(2, mirrorNodes.length) }, (_, k) => {
      const n = model.nodes[mirrorNodes[Math.floor((k + random()) * mirrorNodes.length / 2) % mirrorNodes.length]], c = [0, 0, 0];
      for (let j = 0; j < n.vertexCount; j++) { const p = model.points[model.vertices[n.vertexPool + j].point]; for (let a = 0; a < 3; a++) c[a] += p[a] / n.vertexCount; }
      const distance = 120 + random() * 250, eye = c.map((v, a) => v + n.plane[a] * distance + (a === 2 ? 20 : 0)), d = c.map((v, a) => v - eye[a]);
      const units = r => Math.round(r * 32768 / Math.PI);
      return { location: eye, rotation: [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) & 0xffff, (units(Math.atan2(d[1], d[0])) + 65536) & 0xffff, 0] };
    }) : [];
    const list = [...(FIXED[map] ?? []), ...mirrorViews, ...Array.from({ length: Math.max(0, views - (FIXED[map]?.length ?? 0)) }, () => {
      const at = spots[Math.floor(random() * spots.length)];
      return { location: at.map((c, k) => c + (k === 2 ? 10 : 0)), rotation: [Math.floor(random() * 3000) - 1500 & 0xffff, Math.floor(random() * 65536), 0] };
    })];
    const per = [], totals = { views: 0, settled: 0, change: 0, noise: 0, shifted: 0, pixels: 0, childPasses: 0, maxChange: 0, mirrorFrames: 0, requested: 0 };
    for (const view of list) {
      await page.evaluate(args => window.deusExViewer.placeProbe(args), view);
      await frames(40);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await frames(6);
      await page.evaluate(() => { window.deusExViewer.vertexProjection(true); window.__fp.shift = 0; window.__fp.passes.length = 0; });
      await frames(3);
      let a = await shot(), settled = false;
      for (let attempt = 0; attempt < 10 && !settled; attempt++) {
        await frames(8);
        const again = await shot();
        settled = (await different(a, again)).count === 0;
        a = again;
      }
      totals.views++;
      if (!settled) { per.push('unsettled'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); continue; }
      totals.settled++;
      // The passes the frame was drawn with.
      const passes = await page.evaluate(() => { window.__fp.passes.length = 0; return null; });
      await frames(2);
      const seen = await page.evaluate(() => window.__fp.passes);
      const main = await page.evaluate(() => window.deusExViewer.visibility()?.master);
      // Mirror child frames the page drew (Frame->Mirror -1 at odd depths), and the mirrors the main frame requested.
      const requested = await page.evaluate(() => window.deusExViewer.visibility()?.mirrors.length ?? 0);
      totals.mirrorFrames += seen.filter(pass => pass.mirror < 0).length; totals.requested += requested;
      totals.childPasses += Math.max(0, seen.filter(pass => pass.origin).length - 1);
      if (main && seen.length) {
        // The last pass of a frame is the main one: its origin is the master frame's Coords origin.
        const last = seen.filter(pass => pass.origin).at(-1);
        const origin = main.words.slice(0, 3).map(w => { const u = new Uint32Array([w >>> 0]); return new Float32Array(u.buffer)[0]; });
        assert.deepEqual(last.origin, origin, `${map}: the main pass projects with the master frame's origin`);
      }
      await page.evaluate(() => window.deusExViewer.vertexProjection(false)); await frames(3);
      const b = await shot();
      await page.evaluate(() => window.deusExViewer.vertexProjection(true)); await frames(3);
      const c = await shot();
      await page.evaluate(() => { window.__fp.shift = 8; }); await frames(3);
      const d = await shot();
      await page.evaluate(() => { window.__fp.shift = 0; });
      const [change, noise, shifted] = [await different(a, b), await different(a, c), await different(a, d)];
      per.push(`${change.count}/${noise.count}/${shifted.count}`);
      // --shots DIR keeps the frames of a view whose change is large (inspection).
      if (option('shots', null) && change.count > 2000) {
        const tag = `${option('shots', null)}/${map}-${totals.views}`;
        await writeFile(`${tag}-on.png`, a); await writeFile(`${tag}-off.png`, b);
        console.log(`${map} view ${JSON.stringify(view)}: ${change.count} pixels; frames in ${tag}-{on,off}.png`);
      }
      totals.pixels = change.pixels; totals.change += change.count; totals.noise += noise.count; totals.shifted += shifted.count;
      totals.maxChange = Math.max(totals.maxChange, change.max);
      assert.equal(noise.count, 0, `${map}: the vertex stage drawn twice differs`);
      assert.ok(shifted.count > 0.01 * change.pixels, `${map}: moving the frame's origin changes only ${shifted.count} pixels: the shader does not consume the frame`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    assert.deepEqual(errors, [], `${map}: page errors`);
    summary.push(`${map} (${dpr} px per CSS px, ${totals.pixels} pixels a view): ${totals.settled} of ${totals.views} views settled, ${totals.childPasses} child passes (${totals.mirrorFrames} drawn with Frame->Mirror -1, ${totals.requested} mirror requests); ` +
      `vertex stage vs camera ${totals.change} pixels (${(100 * totals.change / Math.max(1, totals.pixels * totals.settled)).toFixed(4)}%, largest channel ${totals.maxChange}), ` +
      `noise ${totals.noise}, origin moved ${totals.shifted}; per view change/noise/moved ${per.join(' ')}`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-frame-projection-play: ok');
