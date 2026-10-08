// The 3D frame OccludeBsp gets in Play (docs/render-pass-precision.md "The 3D
// frame's projection"), in the default worker mode: on 01_NYC_UNATCOIsland the
// page draws frames, and the last frame's master FSceneNode words (sim-session
// visibility(): `master`, with the view, viewport and render rectangle that
// made them) are the frame CreateMasterFrame builds on the viewport plus
// XRootWindow::PreRender's ComputeRenderSize at 24 bits on the rectangle, as
// the Rust core builds it from those inputs, bit for bit; and they are not
// the one-call 64-bit frame Play built before. The screen span words hold the
// viewport's size.
//
//   node scripts/validate-master-frame-play.mjs [--url http://...] [--query a=1&b=2]
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {createBspOcclusion} from '../src/runtime/bsp-occlusion.mjs';
import {surfaceTextureFlags} from './occlusion-request.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-master-frame-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
if (!url) {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root: dir, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const map = '01_NYC_UNATCOIsland';
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let snapshots = [];
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(30);
  // Frames at three viewing angles (the player turns with the mouse).
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.deusExViewer.settled());
    await frames(4);
    const visibility = await page.evaluate(() => window.deusExViewer.visibility());
    if (visibility?.master) snapshots.push(visibility.master);
    await page.mouse.move(400 + 80 * k, 300); await page.mouse.down(); await page.mouse.move(520 + 80 * k, 320); await page.mouse.up();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server?.close(); }
assert.ok(snapshots.length > 0, 'Play reports the master frame');

const files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get(map), model = decodeMap(asset.bytes).model;
const occlusion = createBspOcclusion((await loadScriptVmKernel()).occlusion, model, {
  surfaceTextureFlags: await surfaceTextureFlags(assets, asset, model), zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0))});
// Words Play sets after the master frame (zone: the tracker's fragments are not in this model; counters, time, options).
const skipped = new Set([42, 44, 45, 46, 47]);
const same = (a, b) => a.every((word, k) => skipped.has(k) || (word >>> 0) === (b[k] >>> 0));
let distinct = 0;
for (const m of snapshots) {
  const camera = {location: m.location, rotation: m.rotation, fov: m.fov};
  const expected = occlusion.master({...camera, width: m.viewport[0], height: m.viewport[1], render: {width: m.render[0], height: m.render[1]}}).frame;
  assert.ok(same(m.words, expected), `Play's master frame (${m.viewport.join('x')}, render ${m.render.join('x')}, FOV ${m.fov}) is the pass frame`);
  assert.deepEqual([m.words[61], m.words[62]], m.viewport, 'the screen span is the viewport');
  assert.deepEqual([m.words[12], m.words[13]], m.render, 'X and Y are the render rectangle');
  const before = occlusion.master({...camera, width: m.render[0], height: m.render[1]}).frame;
  if (!same(m.words, before)) distinct++;
}
assert.ok(distinct === snapshots.length, 'and not the one-call 64-bit frame');
occlusion.dispose();
console.log(`validate-master-frame-play: PASS (${snapshots.length} Play frames on ${map}, worker mode: master frame = CreateMasterFrame on ${snapshots[0].viewport.join('x')} + ComputeRenderSize at 24 bits on ${snapshots[0].render.join('x')}, ${distinct} differ from the 64-bit frame)`);
