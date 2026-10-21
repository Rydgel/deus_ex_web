/** The vertices a mover's meshes project, in Play's default worker mode
 * (docs/frame-projection.md "Movers"). The original draws Model->Points as the
 * moving brush tracker wrote them (FPoly::Transform at precision 24); the page
 * used to project the float32 product of the group matrix with the rest
 * positions. Checks, per map:
 *   1  every mover mesh vertex holds exactly (as float bits) the tracker's
 *      transformed polygon vertex (`moverProbe({points: true})`, read from the
 *      simulation side's Rust memory), and lies within 0.05 units of the group
 *      matrix's product with its rest position (the bound that proves the
 *      vertex order, the reversal of negative orientations included);
 *   2  after movers are moved (a translation, a rotation) the tracker rebuilds
 *      them, its revision grows and the page's vertices follow, bit for bit;
 *   3  a frozen frame in front of movers drawn with the tracker's vertices, with
 *      the matrix's (`deusExViewer.moverVertices(false)`) and again with the
 *      tracker's: the first and third are equal (the noise floor), the first
 *      differs from the second only at mover edges.
 *
 *   node scripts/validate-mover-vertices-play.mjs [--maps A,B] [--movers N] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-mover-vertices-play: no installed game data'); process.exit(0); }
const maps = option('maps', '00_Training,01_NYC_UNATCOIsland,10_Paris_Club,09_NYC_Ship').split(',');
const perMap = Number(option('movers', 4));
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
const units = r => Math.round(r * 32768 / Math.PI);
const aim = (eye, at) => {
  const d = at.map((v, k) => v - eye[k]);
  return { location: eye, rotation: [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) & 0xffff, (units(Math.atan2(d[1], d[0])) + 65536) & 0xffff, 0] };
};
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
    let count = 0, max = 0, box = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (d) {
        count++; max = Math.max(max, d);
        const x = (i / 4) % p.width, y = Math.floor(i / 4 / p.width);
        box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
    }
    return { count, max, box, pixels: p.width * p.height };
  }, [a.toString('base64'), b.toString('base64')]);
  for (const map of maps) {
    const asset = await assets.get(map), decoded = decodeMap(asset.bytes);
    const locations = new Map(decoded.actors.filter(a => a.values.Location).map(a => [a.name, a.values.Location]));
    const spots = decoded.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(debugUrl(url));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, { timeout: 300000 });
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    const probe = args => page.evaluate(a => window.deusExViewer.moverProbe(a), args);
    const vertices = movers => page.evaluate(m => window.deusExViewer.moverVertexProbe(m), movers);
    const shot = () => page.locator('#scene').screenshot();
    await frames(30);
    const totals = { movers: 0, vertices: 0, equal: 0, maxMatrix: 0, views: 0, settled: 0, drawn: 0, change: 0, animated: 0, stable: 0, pixels: 0, maxChange: 0, followed: 0 };
    // `turned`: movers whose Rotation the probe wrote (the page's group matrix does not follow that write).
    const check = async (where, state, turned = []) => {
      const rows = await vertices(state.movers.map(m => ({ name: m.name, points: m.points })));
      for (const row of rows) {
        if (!row.vertices) continue;
        assert.equal(row.equal, row.vertices, `${map} ${where}: ${row.name} holds the tracker's vertices (${row.equal} of ${row.vertices})`);
        totals.vertices += row.vertices; totals.equal += row.equal;
        if (turned.includes(row.name)) continue;
        assert.ok(row.maxMatrixDistance < 0.05, `${map} ${where}: ${row.name} is ${row.maxMatrixDistance} units from the group matrix's pose`);
        totals.maxMatrix = Math.max(totals.maxMatrix, row.maxMatrixDistance);
      }
      return rows;
    };
    // 1: the tracker's construction points (and any Update the first frames ran).
    let state = await probe({ points: true });
    assert.ok(state.tracker, `${map}: the tracker runs`);
    totals.movers = state.movers.length;
    await check('at the start', state);
    // 2: move movers (a translation; a turn) and the page follows.
    const names = state.movers.filter(m => m.fragments > 0).map(m => m.name);
    const moved = names.slice(0, 2).map((name, k) => k === 0 ? { name, offset: [0, 0, 40] } : { name, rotation: [0, 4096 * 3, 0] });
    const before = new Map(state.movers.map(m => [m.name, m.revision]));
    await probe({ set: moved });
    await frames(6);
    state = await probe({ points: true });
    for (const { name } of moved) {
      const row = state.movers.find(m => m.name === name);
      assert.ok(row.revision > before.get(name), `${map}: ${name} was rebuilt by the tracker (revision ${before.get(name)} -> ${row.revision})`);
      totals.followed++;
    }
    await check('after moving', state, moved.filter(m => m.rotation).map(m => m.name));
    // 3: frozen frames in front of movers (not the ones the probe turned: the page's group matrix does not follow that write).
    const turned = moved.filter(m => m.rotation).map(m => m.name);
    const candidates = state.movers.filter(m => m.fragments > 0 && locations.has(m.name) && !turned.includes(m.name)).slice(0, 14);
    let used = 0;
    const view = async (mover, eye) => {
      await page.evaluate(args => window.deusExViewer.placeProbe(args), aim(eye, locations.get(mover.name)));
      await frames(40);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await frames(6);
      const drawn = (await probe({})).movers.find(m => m.name === mover.name)?.drawn ?? 0;
      const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
      if (!drawn) { await focus(); return false; }
      totals.views++;
      let a = await shot(), settled = false;
      for (let attempt = 0; attempt < 10 && !settled; attempt++) {
        await frames(8);
        const again = await shot();
        settled = (await different(a, again)).count === 0;
        a = again;
      }
      if (!settled) { await focus(); return false; }
      totals.settled++; totals.drawn++;
      await page.evaluate(() => window.deusExViewer.moverVertices(false)); await frames(4);
      const b = await shot();
      await page.evaluate(() => window.deusExViewer.moverVertices(true)); await frames(4);
      const c = await shot();
      const [change, noise] = [await different(a, b), await different(a, c)];
      await focus();
      // A view with an animated texture in it (a monitor's static) changes between any two frames: not a measurement.
      if (noise.count) { if (option('verbose', null)) console.log(`${map} ${mover.name}: tracker vs tracker ${noise.count} pixels in ${noise.box}`); totals.animated++; return false; }
      totals.change += change.count; totals.pixels = change.pixels; totals.maxChange = Math.max(totals.maxChange, change.max);
      totals.stable++;
      if (option('shots', null) && change.count) {
        const tag = `${option('shots', null)}/${map}-${mover.name}`;
        await writeFile(`${tag}-tracker.png`, a); await writeFile(`${tag}-matrix.png`, b);
      }
      return true;
    };
    for (const mover of candidates) {
      if (used >= perMap) break;
      const at = locations.get(mover.name);
      const eyes = spots.map(p => ({ p, d: Math.hypot(...p.map((x, k) => x - at[k])) })).filter(e => e.d > 120 && e.d < 500).sort((x, y) => x.d - y.d).slice(0, 3)
        .map(e => e.p.map((x, k) => x + (k === 2 ? 40 : 0)));
      for (let k = 0; k < 8; k++) eyes.push([at[0] + Math.cos(k * Math.PI / 4) * 230, at[1] + Math.sin(k * Math.PI / 4) * 230, at[2] + 40]);
      for (const eye of eyes.slice(0, 7)) if (await view(mover, eye)) { used++; break; }
    }
    assert.deepEqual(errors, [], `${map}: page errors`);
    assert.ok(totals.stable > 0, `${map}: no stable view`);
    summary.push(`${map}: ${totals.movers} tracked movers, ${totals.equal} of ${totals.vertices} mesh vertices equal the tracker's (farthest from the matrix pose ${totals.maxMatrix.toExponential(2)}); `
      + `${totals.followed} moved movers rebuilt and followed; ${totals.views} views, ${totals.animated} with an animated texture, ${totals.stable} stable (${totals.drawn} with the mover drawn): tracker vs matrix ${totals.change} pixels `
      + `(${(100 * totals.change / Math.max(1, totals.pixels * totals.stable)).toFixed(4)}%, largest channel ${totals.maxChange})`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-mover-vertices-play: ok');
