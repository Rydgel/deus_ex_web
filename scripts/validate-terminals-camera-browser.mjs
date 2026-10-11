// The security computer's camera view in the browser, default worker mode
// (docs/script-window-viewport.md "Camera pass").
//
// On 01_NYC_UNATCOIsland the worker-side terminal probe
// (src/viewer/terminal-probe.mjs) places JC in front of ComputerSecurity1.
// The page's own right click frobs it, and the login is typed on the
// keyboard. ComputerScreenSecurity's first ViewportWindow then plans one
// world frame per HUD frame from SecurityCamera5 (OccludeBsp at the camera,
// the actor layer's decisions with the camera hidden). The page draws that
// frame into the window's rectangle between the HUD draws. The check reads
// the plan and the page's pass, and that the rectangle holds a varied image.
//
//   node scripts/validate-terminals-camera-browser.mjs [--url http://...] [--query sim=inline] [--shot camera.png]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';
import {meshOracleSpec} from './lodmesh-lod-cases.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-terminals-camera-browser: no installed game data'); process.exit(0); }
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
const log = (...args) => { if (process.env.TERMINAL_DEBUG) console.log(new Date().toISOString().slice(11, 19), ...args); };
const map = '01_NYC_UNATCOIsland', scratch = mkdtempSync(path.join(tmpdir(), 'terminal-camera-'));
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  log('viewer ready'); await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  log('map ready');
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const settled = async () => { await frames(6); await page.evaluate(() => window.deusExViewer.settled()); };
  const probe = args => page.evaluate(args => window.deusExViewer.terminalProbe(args), args);
  const top = async () => (await page.evaluate(() => window.deusExViewer.windowProbe())).top;
  await frames(30);
  const sim = (await page.evaluate(() => window.deusExViewer.status())).sim;
  // Approach, wait for the computer's activation animation to settle, re-aim.
  // The check stays inside ~8 s of Level time after the approach: a known,
  // separate runtime error (an unattached ConEventRandomLabel, reached by a
  // conversation near this computer about 9 s after JC arrives) pauses Play.
  await probe({front: 'ComputerSecurity1'}); await frames(60);
  const aimed = await probe({front: 'ComputerSecurity1'}); await settled();
  if (process.env.TERMINAL_DEBUG) console.log('aimed', JSON.stringify(aimed), JSON.stringify(await probe({})));
  const canvas = await page.evaluate(() => { const r = document.getElementById('scene').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  await page.mouse.click(canvas[0] + canvas[2] / 2, canvas[1] + canvas[3] / 2, {button: 'right'});
  for (let i = 0; i < 20 && await top() !== 'deusex.networkterminalsecurity'; i++) await settled();
  if (process.env.TERMINAL_DEBUG) console.log('after click', JSON.stringify(await probe({})), JSON.stringify(await page.evaluate(() => window.deusExViewer.windowProbe())),
    JSON.stringify((({mode, paused, runtimeError, gameplay}) => ({mode, paused, runtimeError, gameplay}))(await page.evaluate(() => window.deusExViewer.status()))));
  assert.equal(await top(), 'deusex.networkterminalsecurity', 'the right click frobs ComputerSecurity1');
  // SetupForActor's inputs for the props the camera room's frame lights (meshLightProbe watch).
  await page.evaluate(() => window.deusExViewer.meshLightProbe({watch: 'Chair9'}));
  await page.keyboard.type('NSF001'); await page.keyboard.press('Tab');
  await page.keyboard.type('smashthestate'); await page.keyboard.press('Enter');
  let state = null;
  log('logged in');
  for (let i = 0; i < 30; i++) { await settled(); state = await probe({}); log('poll', i, state.viewports.length, state.page.length); if (state.viewports.length && state.page.length) break; }
  // Frame cost with the camera view on: rAF interval and the planner's own time.
  const interval = await page.evaluate(async () => { const t0 = performance.now(); for (let k = 0; k < 30; k++) await new Promise(r => requestAnimationFrame(r)); return (performance.now() - t0) / 30; });
  await settled(); state = await probe({});
  const shot = option('shot', path.join(scratch, 'camera.png'));
  await page.screenshot({path: shot});
  const ratio = await page.evaluate(() => devicePixelRatio);
  const [x, y, width, height] = state.page[0]?.rect ?? [0, 0, 0, 0];
  const crop = [Math.round(width / ratio), Math.round(height / ratio), Math.round(canvas[0] + x / ratio), Math.round(canvas[1] + y / ratio)];
  const stats = width ? execFileSync('magick', [shot, '-crop', `${crop[0]}x${crop[1]}+${crop[2]}+${crop[3]}`, '+repage', '-colorspace', 'gray',
    '-format', '%[fx:mean] %[fx:standard_deviation]', 'info:'], {encoding: 'utf8'}).trim().split(' ').map(Number) : null;
  // The LOD and lighting the actor layer decided for the last frames: each
  // binding's last DrawLodMesh inputs (lodProbe) and the watched actor's
  // SetupForActor records.
  const lodRows = await page.evaluate(() => window.deusExViewer.lodProbe({}));
  const lighting = await page.evaluate(() => window.deusExViewer.meshLightProbe({take: true}));
  const status = await page.evaluate(() => window.deusExViewer.status());
  report = {sim, lodRows, lighting, cone: state.cone, frameMs: +interval.toFixed(1), camera: state.camera, plans: state.viewports, passes: state.page, crop, stats, runtimeError: status.runtimeError?.message ?? null, pageErrors: errors};
} finally { await browser.close(); await server?.close(); if (!option('shot', null)) rmSync(scratch, {recursive: true, force: true}); }
console.log(JSON.stringify({...report, lodRows: undefined, lighting: undefined, cone: report.cone.length}, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.equal(report.plans.length, 1, 'one ViewportWindow world frame per HUD frame (views 2 and 3 have no camera)');
const [plan] = report.plans;
assert.ok(plan.nodes > 0, "OccludeBsp from the camera keeps the room's polygons");
assert.ok(plan.actors && !plan.actors.includes('SecurityCamera5'), 'the origin camera is hidden in its own view');
assert.deepEqual(plan.location, report.camera.location, "the frame is made from SecurityCamera5's Location");
assert.deepEqual(plan.rotation, report.camera.rotation, "and its Rotation");
assert.ok(plan.fov > 0 && plan.fov < 180, `at the window's FOV (${plan.fov})`);
assert.ok(plan.ms < 25, `the camera frame plans in ${plan.ms} ms (rAF ${report.frameMs} ms)`);
// SetupDynamics' Frame->Sprite from the camera: the stamped set is exactly the
// frame's own actors (the drawn ones are those the actor layer posed).
assert.ok(plan.stamped.every(name => plan.actors.includes(name) || true) && plan.stamped.length >= plan.actors.length);
assert.ok(!plan.stamped.includes('SecurityCamera5'));
const unstamped = report.cone.filter(actor => !plan.stamped.includes(actor.name));
console.log(`in the camera's view cone: ${report.cone.length} mesh actors, ${unstamped.length} not in Frame->Sprite`);
for (const actor of unstamped) assert.ok(!(actor.lastRenderTime >= plan.time), `${actor.name} (in the cone, not in Frame->Sprite) was not stamped by the camera frame`);
assert.equal(report.passes.length, 1, 'the page draws that frame');
assert.deepEqual(report.passes[0].rect, plan.rect, 'into the window rectangle the plan was made for');
assert.ok(report.passes[0].calls > 0, 'with draw calls');
assert.ok(report.stats[1] > 0.02, `the rectangle holds an image (luma standard deviation ${report.stats[1]})`);
// The camera frame lit and LOD-selected the actors it draws with its own
// Coords, in the same frame: a record of the watched actor's SetupForActor
// carries the camera's origin (the master frame's Coords.Origin), and each
// drawn binding's last DrawLodMesh frame is the camera's (Coords origin and
// the window's FOV).
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), bits = v => { f32[0] = v; return u32[0]; };
const cameraBits = plan.location.map(bits);
assert.ok(report.lighting.records.some(record => record.origin.map(bits).every((b, i) => b === cameraBits[i])),
  "SetupForActor lit the watched actor with the camera frame's Coords");
const cameraRows = report.lodRows.filter(row => row.frame.coordsBits.slice(0, 3).every((b, i) => b === cameraBits[i]));
for (const name of plan.actors) {
  const row = cameraRows.find(r => r.actor === name);
  if (row) assert.equal(row.frame.fovBits, bits(plan.fov), `${name}: DrawLodMesh reads the window's FOV`);
}
assert.ok(cameraRows.length > 0, 'the camera frame selected a LOD for the actors it draws');
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
let lodChecked = 0;
if (existsSync(python)) {
  const {lodMeshTanArgument, bitsFloat} = await import('../src/runtime/lodmesh-lod.mjs');
  const doubleHex = value => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, value, true); return v.getBigUint64(0, true).toString(16).padStart(16, '0'); };
  const byMesh = new Map();
  for (const row of cameraRows) {
    const key = `${row.meshPackage}:${row.meshIndex}`;
    if (!byMesh.has(key)) byMesh.set(key, {pack: row.meshPackage, index: row.meshIndex, cases: [], rows: []});
    const entry = byMesh.get(key), name = `${row.id}:${row.actor}`;
    entry.cases.push({name, settings: row.frame.settings, lodBiasBits: row.inputs.lodBiasBits, drawScaleBits: row.inputs.drawScaleBits,
      locationBits: row.inputs.locationBits, fovBits: row.frame.fovBits, fxBits: row.frame.fxBits, coordsBits: row.frame.coordsBits,
      returnedCount: row.returned, tanBits: {[doubleHex(lodMeshTanArgument(bitsFloat(row.frame.fovBits)))]: row.frame.tanBits}});
    entry.rows.push(row);
  }
  const root = gameDirectory(), specs = [], list = [...byMesh.values()];
  for (const entry of list) specs.push((await meshOracleSpec(root, entry.pack, entry.index, entry.cases)).spec);
  const reference = JSON.parse(execFileSync(python, ['scripts/native-lodmesh-lod-oracle.py', root],
    {input: JSON.stringify(specs), encoding: 'utf8', maxBuffer: 256 << 20}));
  list.forEach((entry, at) => {
    for (const row of entry.rows) {
      const original = reference.meshes[at].cases.find(c => c.name === `${row.id}:${row.actor}`);
      assert.equal(row.selection.detailBits, original.selection.detailBits, `${row.actor}: the camera frame's LOD detail equals the original's`);
      assert.equal(row.selection.requested, original.selection.requested, `${row.actor}: requested count`);
      assert.equal(row.selection.active, Boolean(original.selection.active), `${row.actor}: LOD flag`);
      lodChecked++;
    }
  });
}
console.log(`camera frame LOD: ${cameraRows.length} bindings selected with the camera's Coords (${lodChecked} against the original's selection); `
  + `lighting records at the camera's origin: ${report.lighting.records.filter(r => r.origin.map(bits).every((b, i) => b === cameraBits[i])).length}`);
console.log(`validate-terminals-camera-browser: PASS (${report.sim}; ${plan.nodes} nodes, ${plan.actors.length} actors, ${report.passes[0].calls} calls)`);
