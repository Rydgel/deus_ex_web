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
// Child frames (--mirror off skips it): on 10_Paris_Club the player faces
// the bar's two mirrors in Light15's fog zone. Each mirror frame gets its
// own fog maps from its reflected Coords (SetupForSurf reads the frame
// DrawFrame is drawing), and the most fogged one goes through the same
// oracle.
//
//   node scripts/validate-volumetric-fog-play.mjs [--url http://...] [--query sim=inline] [--shots DIR] [--mover off] [--mirror off]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {volumetricLight, sortVolumetricLights} from '../src/runtime/volumetric-fog.mjs';
import { debugUrl } from './page-url.mjs';

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
  // (fogNotes=1: the fog pass builds the notes this validator reads, stats.moverCase and frameCase; Play does not)
  await page.goto(debugUrl(`${url.replace(/\/$/, '')}/?${['fogNotes=1', query].filter(Boolean).join('&')}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.evaluate(() => window.deusExViewer.placeProbe({ location: [-900, -330, 80], rotation: [0, 25000, 0] }));
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(90);
  report = await page.evaluate(() => ({ ...window.deusExViewer.fog(), pages: window.deusExViewer.fogPages(),
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
  if (option('mirror', 'on') !== 'off') {
    // 10_Paris_Club's bar mirrors (surfaces 231 and 232, fog zone 7) inside
    // Light15's volume; the Bar's own mirror sits by the Bartender, whose
    // greeting soon takes the view.
    await page.locator('#map').selectOption('10_Paris_Club');
    await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '10_Paris_Club'; }, {}, {timeout: 240000});
    await frames(30);
    await page.evaluate(() => window.deusExViewer.placeProbe({ location: [-122, -1008, 60], rotation: [0, 0, 0] }));
    await frames(60);
    report.mirror = await page.evaluate(() => ({ stats: window.deusExViewer.fog().stats, pages: window.deusExViewer.fogPages(),
      mirrors: window.deusExViewer.status().mirrors, runtimeError: window.deusExViewer.status().runtimeError?.message ?? null }));
    if (shots) await page.screenshot({path: `${shots}/fog-10_Paris_Club-mirror.png`});
  }
  report.pageErrors = errors;
  // The fog pages on the GPU equal their pixels at the end of a frame (fog-pass.mjs: whole pages, then the written tiles; a child
  // frame's copies are undone by its pass's end), on the bar and after the mirror frames.
  for (const [where, pages] of [['02_NYC_Bar', report.pages], ['10_Paris_Club', report.mirror?.pages]]) {
    if (!pages) continue;
    const differing = pages.filter(page => page.differ > 0);
    assert.deepEqual(differing, [], `${where}: fog pages on the GPU differ from their pixels: ${JSON.stringify(differing)}`);
  }
} finally { await browser.close(); await server?.close(); }
const moverCase = report.mover?.stats.moverCase ?? null, frameCase = report.mirror?.stats.frameCase ?? null;
const brief = c => c && { ...c, texels: `${c.texels.length / 4} texels` };
console.log(JSON.stringify({ ...report, mover: report.mover && { ...report.mover, stats: { ...report.mover.stats,
  moverCase: brief(moverCase), frameCase: brief(report.mover.stats.frameCase) } },
  mirror: report.mirror && { ...report.mirror, stats: { ...report.mirror.stats, moverCase: brief(report.mirror.stats.moverCase),
    frameCase: brief(frameCase) } } }, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stats.surfaces > 0 && report.stats.lights === 1, 'fog-zone surfaces and Light90 are collected');
assert.ok(report.stats.kernel, 'the Rust fog loop is in use');
assert.ok(report.stats.drawn > 0 && report.stats.texels > 0, 'visible fog surfaces get fog maps this frame');
assert.ok(report.differing, 'the fog pass changes the frame');
// A fog map of the frame against the unchanged Render.dll fog loop; false
// without the native probe environment.
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
function equalToOriginal(fogCase, label) {
  if (!existsSync(python)) return false;
  const io = new DataView(new ArrayBuffer(4)), bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));
  const lights = fogCase.lights.map(volumetricLight), order = sortVolumetricLights(lights).map(light => lights.indexOf(light));
  const c = fogCase.coords, g = fogCase.grid;
  const [reference] = JSON.parse(execFileSync(python, ['scripts/native-volumetric-fog-oracle.py', gameDirectory()], { encoding: 'utf8',
    maxBuffer: 1 << 26, input: JSON.stringify([{ coords: [...c.origin, ...c.x, ...c.y, ...c.z].map(bits),
      grid: { base: g.base.map(bits), stepU: g.stepU.map(bits), stepV: g.stepV.map(bits) }, width: fogCase.width, height: fogCase.height,
      missFlag: fogCase.missFlag, order, lights: fogCase.lights.map(l => ({ ...l, location: l.location.map(bits),
        color: l.color.map(bits), brightness: bits(l.brightness) })) }]) }));
  assert.equal(reference.texels.length, fogCase.texels.length, `${label}: the fog map size`);
  for (let i = 0; i < reference.texels.length; i++)
    if (reference.texels[i] !== fogCase.texels[i]) assert.fail(`${label} fog texel byte ${i}: ${fogCase.texels[i]} vs the original's ${reference.texels[i]}`);
  return true;
}
let moverNote = '', mirrorNote = '';
if (report.mover) {
  assert.equal(report.mover.runtimeError, null);
  assert.ok(report.mover.stats.movers > 0, 'drawn mover polygons in the fog zone get fog maps');
  assert.ok(moverCase, 'a mover draw item is fogged');
  // Its fragments map onto its own fog map (light-map texel units, the map
  // spanning 0..width and 0..height).
  const [u0, v0, u1, v1] = moverCase.uvRange;
  assert.ok(u0 >= -0.01 && v0 >= -0.01 && u1 <= moverCase.width + 0.01 && v1 <= moverCase.height + 0.01 && u1 - u0 > 1 && v1 - v0 > 1,
    `the item's fragments lie on its map (${moverCase.uvRange.map(v => v.toFixed(2))} of ${moverCase.width}x${moverCase.height})`);
  moverNote = equalToOriginal(moverCase, 'mover')
    ? `; ${moverCase.mover} polygon ${moverCase.polygon}: ${moverCase.width}x${moverCase.height} fog map equal to Render.dll's loop`
    : `; ${moverCase.mover} polygon ${moverCase.polygon} fogged (no native probe environment for the oracle)`;
}
if (report.mirror) {
  assert.equal(report.mirror.runtimeError, null);
  assert.ok(report.mirror.mirrors.renderedPlanes > 0, 'the club mirrors render');
  assert.ok(report.mirror.stats.frameMaps > 0 && frameCase, 'the mirror frame gets its own fog maps');
  const c = frameCase.coords, det = c.x[0] * (c.y[1] * c.z[2] - c.y[2] * c.z[1]) - c.x[1] * (c.y[0] * c.z[2] - c.y[2] * c.z[0])
    + c.x[2] * (c.y[0] * c.z[1] - c.y[1] * c.z[0]);
  assert.equal(frameCase.kind, 'mirror', 'the most fogged child map is a mirror frame\'s');
  // The root frame's Coords (ViewCoords under the rotation) have
  // determinant -1; a mirror frame's reflect all three axes.
  assert.ok(det > 0, 'its Coords are the reflected ones');
  mirrorNote = equalToOriginal(frameCase, 'mirror frame')
    ? `; 10_Paris_Club mirror frame ${frameCase.frame}: ${report.mirror.stats.frameMaps} child maps, surface ${frameCase.surface}'s ${frameCase.width}x${frameCase.height} map equal to Render.dll's loop`
    : `; mirror frame ${frameCase.frame}: ${report.mirror.stats.frameMaps} maps (no native probe environment for the oracle)`;
}
console.log(`validate-volumetric-fog-play: PASS (${map}${query ? `, ${query}` : ''}: ${report.stats.drawn} of ${report.stats.surfaces} fog surfaces, ${report.stats.texels} texels${moverNote}${mirrorNote}; fog pages equal to their pixels on the GPU: ${report.pages?.filter(page => page.differ === 0).length ?? 0} on the bar, ${report.mirror?.pages?.filter(page => page.differ === 0).length ?? 0} after the mirror)`);
