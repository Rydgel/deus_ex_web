// Volumetric fog in Play (docs/volumetric-fog.md "Play"): on 02_NYC_Bar,
// Light90's volume (VolumeRadius 128, VolumeBrightness 32, VolumeFog 64)
// fills the bar's fog zones. Each frame the fog pass recomputes the fog maps
// of the visible fog-zone surfaces through the Rust loop and draws them with
// ONE/INVSRCALPHA; the frame changes when the pass is hidden.
//
// The default mode runs the simulation in the worker: decal-probe.mjs
// placeProbe moves the player there, and the page's fog pass is read through
// deusExViewer.fog() (`--query sim=inline` runs it on the page).
//
// Movers (with the brush tracker; --mover off skips it): the player then
// faces DeusExMover9, a door in the bar's fog zone inside Light90's volume.
// Its drawn polygons get fog maps over the tracker surface's lattice, and
// the frame's most fogged one, with the loop's inputs, is run through the
// unchanged Render.dll fog loop (native-volumetric-fog-oracle.py): the
// texels and the early-out flag must be equal.
//
//   node scripts/validate-volumetric-fog-play.mjs [--url http://...] [--query sim=inline] [--shots DIR] [--mover off]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {volumetricLight, sortVolumetricLights} from '../src/runtime/volumetric-fog.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-volumetric-fog-play: no installed game data'); process.exit(0); }
const map = '02_NYC_Bar', shots = option('shots', null), query = option('query', '');
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url.replace(/\/$/, '')}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.evaluate(() => window.deusExViewer.placeProbe({ location: [-900, -330, 80], rotation: [0, 25000, 0] }));
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(90);
  report = await page.evaluate(() => ({ ...window.deusExViewer.fog(),
    runtimeError: window.deusExViewer.status().runtimeError?.message ?? null }));
  const on = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/fog-${map}.png`});
  await page.evaluate(() => window.deusExViewer.showFog(false));
  await frames(3);
  const off = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/fog-${map}-off.png`});
  report.differing = Buffer.compare(on, off) !== 0;
  await page.evaluate(() => window.deusExViewer.showFog(true));
  if (option('mover', 'on') !== 'off') {
    const placed = await page.evaluate(() => window.deusExViewer.moverDecalProbe({ place: true, name: 'DeusExMover9', distance: 200 }));
    await frames(30);
    report.mover = { placed: { mover: placed.mover, surface: placed.surface },
      ...await page.evaluate(() => ({ stats: window.deusExViewer.fog().stats, runtimeError: window.deusExViewer.status().runtimeError?.message ?? null })) };
    if (shots) await page.screenshot({path: `${shots}/fog-${map}-mover.png`});
  }
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
const moverCase = report.mover?.stats.moverCase ?? null;
if (moverCase) report.mover.stats.moverCase = { ...moverCase, texels: `${moverCase.texels.length / 4} texels` };
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stats.surfaces > 0 && report.stats.lights === 1, 'fog-zone surfaces and Light90 are collected');
assert.ok(report.stats.kernel, 'the Rust fog loop is in use');
assert.ok(report.stats.drawn > 0 && report.stats.texels > 0, 'visible fog surfaces get fog maps this frame');
assert.ok(report.differing, 'the fog pass changes the frame');
let moverNote = '';
if (report.mover) {
  assert.equal(report.mover.runtimeError, null);
  assert.ok(report.mover.stats.movers > 0, 'drawn mover polygons in the fog zone get fog maps');
  assert.ok(moverCase, 'a mover polygon is fogged');
  // The same surface through the unchanged fog loop.
  const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
  if (existsSync(python)) {
    const io = new DataView(new ArrayBuffer(4)), bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));
    const lights = moverCase.lights.map(volumetricLight), order = sortVolumetricLights(lights).map(light => lights.indexOf(light));
    const c = moverCase.coords, g = moverCase.grid;
    const [reference] = JSON.parse(execFileSync(python, ['scripts/native-volumetric-fog-oracle.py', gameDirectory()], { encoding: 'utf8',
      maxBuffer: 1 << 26, input: JSON.stringify([{ coords: [...c.origin, ...c.x, ...c.y, ...c.z].map(bits),
        grid: { base: g.base.map(bits), stepU: g.stepU.map(bits), stepV: g.stepV.map(bits) }, width: moverCase.width, height: moverCase.height,
        missFlag: moverCase.missFlag, order, lights: moverCase.lights.map(l => ({ ...l, location: l.location.map(bits),
          color: l.color.map(bits), brightness: bits(l.brightness) })) }]) }));
    assert.equal(reference.texels.length, moverCase.texels.length, 'the fog map size');
    for (let i = 0; i < reference.texels.length; i++)
      if (reference.texels[i] !== moverCase.texels[i]) assert.fail(`mover fog texel byte ${i}: ${moverCase.texels[i]} vs the original's ${reference.texels[i]}`);
    moverNote = `; ${moverCase.mover} polygon ${moverCase.polygon}: ${moverCase.width}x${moverCase.height} fog map equal to Render.dll's loop`;
  } else moverNote = `; ${moverCase.mover} polygon ${moverCase.polygon} fogged (no native probe environment for the oracle)`;
}
console.log(`validate-volumetric-fog-play: PASS (${map}${query ? `, ${query}` : ''}: ${report.stats.drawn} of ${report.stats.surfaces} fog surfaces, ${report.stats.texels} texels${moverNote})`);
