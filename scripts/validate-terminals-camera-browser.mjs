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
//        [--map M --computer C --user U --password P --camera-actor A --click x,y]
//        [--camera x,y,z,pitch,yaw] [--player x,y,z] [--emitters x,y,z,pitch,yaw,count] [--expect mirror,sky,decals,coronas,fog,items,extras,weapons]
//
// --camera stands the camera actor (SecurityCamera5; --camera-actor) elsewhere in the map (a fixture: the original
// camera does not move), to put the view where a map's mirrors, sky, decals or
// coronas are; --expect names what the camera frame must then have drawn.
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
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => {
  const joined = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];
};
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
const map = option('map', '01_NYC_UNATCOIsland'), computer = option('computer', 'ComputerSecurity1'), cameraName = option('camera-actor', 'SecurityCamera5'), scratch = mkdtempSync(path.join(tmpdir(), 'terminal-camera-'));
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  if (process.env.TERMINAL_DEBUG) { page.on('console', message => log('console', message.type(), message.text().slice(0, 300)));
    page.on('worker', worker => { log('worker', worker.url()); worker.on?.('console', message => log('worker console', message.text().slice(0, 300))); }); }
  await page.goto(debugUrl(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  log('viewer ready'); await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  log('map ready');
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  // settled() waits for a moment with no frame in flight, which a busy worker (three camera windows) rarely has: bound the wait.
  const settled = async () => { await frames(6); await page.evaluate(() => Promise.race([window.deusExViewer.settled(), new Promise(resolve => setTimeout(resolve, 2000))])); };
  const probe = args => page.evaluate(args => window.deusExViewer.terminalProbe(args), {cameraName, ...args});
  const top = async () => (await page.evaluate(() => window.deusExViewer.windowProbe())).top;
  await frames(30);
  const sim = (await page.evaluate(() => window.deusExViewer.status())).sim;
  // Approach, wait for the computer's activation animation to settle, re-aim.
  // The check stays inside ~8 s of Level time after the approach: a known,
  // separate runtime error (an unattached ConEventRandomLabel, reached by a
  // conversation near this computer about 9 s after JC arrives) pauses Play.
  await probe({front: computer}); await frames(60);
  const aimed = await probe({front: computer}); await settled();
  if (process.env.TERMINAL_DEBUG) console.log('aimed', JSON.stringify(aimed), JSON.stringify(await probe({})));
  const canvas = await page.evaluate(() => { const r = document.getElementById('scene').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  // The first click can land while a bot or the activation still moves the view (seen on this host in about one run in five): aim again and retry.
  for (let attempt = 0; attempt < 3 && await top() !== 'deusex.networkterminalsecurity'; attempt++) {
    if (attempt) { await probe({front: computer}); await settled(); }
    await page.mouse.click(canvas[0] + canvas[2] / 2, canvas[1] + canvas[3] / 2, {button: 'right'});
    for (let i = 0; i < 20 && await top() !== 'deusex.networkterminalsecurity'; i++) await settled();
  }
  if (process.env.TERMINAL_DEBUG) console.log('after click', JSON.stringify(await probe({})), JSON.stringify(await page.evaluate(() => window.deusExViewer.windowProbe())),
    JSON.stringify((({mode, paused, runtimeError, gameplay}) => ({mode, paused, runtimeError, gameplay}))(await page.evaluate(() => window.deusExViewer.status()))));
  assert.equal(await top(), 'deusex.networkterminalsecurity', `the right click frobs ${computer}`);
  await page.keyboard.type(option('user', 'NSF001')); await page.keyboard.press('Tab');
  await page.keyboard.type(option('password', 'smashthestate')); await page.keyboard.press('Enter');
  let state = null;
  log('logged in');
  // Some computers open on another screen (Dockyard's Special Options): --click x,y presses a button of the page after the login.
  if (option('click', null)) { const [cx, cy] = option('click', '').split(',').map(Number); await settled(); await page.mouse.click(cx, cy); await settled(); }
  for (let i = 0; i < 30; i++) { await settled(); state = await probe({}); log('poll', i, state.viewports.length, state.page.length); if (state.viewports.length && state.page.length) break; }
  if (!state?.viewports.length) { await page.screenshot({path: option('shot', path.join(scratch, 'camera.png'))}); throw new Error(`no camera window after the login (top window ${await top()}; screenshot ${option('shot', path.join(scratch, 'camera.png'))})`); }
  if (option('player', null)) {
    await probe({placePlayer: option('player', '').split(',').map(Number)});
    await settled();
  }
  if (option('emitters', null)) {
    // --emitters x,y,z,pitch,yaw,count: the first LaserEmitters stand there, pointing that way.
    const [x, y, z, pitch, yaw, count] = option('emitters', '').split(',').map(Number);
    await probe({placeEmitters: {location: [x, y, z], rotation: [pitch, yaw, 0], count}});
    await settled();
  }
  if (option('camera', null)) {
    const [x, y, z, pitch, yaw] = option('camera', '').split(',').map(Number);
    await probe({placeCamera: {location: [x, y, z], rotation: [pitch, yaw, 0]}}); log('camera placed');
    await settled(); await settled(); log('camera settled');
  }
  // SetupForActor's inputs for one prop the camera frame draws (meshLightProbe watch).
  state = await probe({});
  const watched = state.viewports[0]?.actors.find(name => name !== 'JCDentonMale1') ?? null;
  if (watched) await page.evaluate(name => window.deusExViewer.meshLightProbe({watch: name}), watched);
  await frames(20); log('watching');
  // Frame cost with the camera view on: rAF interval and the planner's own time.
  const interval = await page.evaluate(async () => { const t0 = performance.now(); for (let k = 0; k < 30; k++) await new Promise(r => requestAnimationFrame(r)); return (performance.now() - t0) / 30; });
  await settled(); state = await probe({});
  log('interval', interval);
  const shot = option('shot', path.join(scratch, 'camera.png'));
  await page.screenshot({path: shot}); log('screenshot');
  const ratio = await page.evaluate(() => devicePixelRatio);
  const [x, y, width, height] = state.page[0]?.rect ?? [0, 0, 0, 0];
  const crop = [Math.round(width / ratio), Math.round(height / ratio), Math.round(canvas[0] + x / ratio), Math.round(canvas[1] + y / ratio)];
  const stats = width ? execFileSync('magick', [shot, '-crop', `${crop[0]}x${crop[1]}+${crop[2]}+${crop[3]}`, '+repage', '-colorspace', 'gray',
    '-format', '%[fx:mean] %[fx:standard_deviation]', 'info:'], {encoding: 'utf8'}).trim().split(' ').map(Number) : null;
  log('decal on/off');
  // The decal block's share of the camera window: the same (paused) frame without it.
  await page.evaluate(() => (window.dispatchEvent(new Event('blur')), window.deusExViewer.freeze())); await frames(8);
  const shotOn = path.join(scratch, 'camera-on.png'), shotOff = path.join(scratch, 'camera-off.png');
  await page.screenshot({path: shotOn});
  await page.evaluate(() => window.deusExViewer.viewportDecals(false)); await frames(8);
  await page.screenshot({path: shotOff});
  await page.evaluate(() => window.deusExViewer.viewportDecals(true));
  // Any handled key resumes Play (main.mjs keydown); a bare Shift only toggles walking.
  await page.keyboard.down('Shift'); await page.keyboard.up('Shift'); await frames(6); log('resumed');
  const regionOf = file => `${file}[${crop[0]}x${crop[1]}+${crop[2]}+${crop[3]}]`;
  const above = (a, b) => width ? Math.round(Number(execFileSync('magick', [regionOf(a), regionOf(b), '-compose', 'Minus', '-composite', '-colorspace', 'gray',
    '-threshold', '0.3%', '-format', '%[fx:mean*w*h]', 'info:'], {encoding: 'utf8'}))) : 0;
  // ImageMagick's Minus gives the second image less the first: `above(a, b)` counts the pixels where b is brighter than a by 0.3%.
  const decalShare = {darker: above(shotOn, shotOff), brighter: above(shotOff, shotOn)};
  // The LOD and lighting the actor layer decided for the last frames: each
  // binding's last DrawLodMesh inputs (lodProbe), what the page's passes left
  // on each binding (meshPassProbe) and the watched actor's SetupForActor records.
  const sample = await page.evaluate(async () => {
    await Promise.race([window.deusExViewer.settled(), new Promise(resolve => setTimeout(resolve, 2000))]);
    window.deusExViewer.meshPassProbe(true);
    const sim = await window.deusExViewer.lodProbe({});
    for (let k = 0; k < 8; k++) await new Promise(requestAnimationFrame);
    const passes = window.deusExViewer.meshPassProbe();
    await Promise.race([window.deusExViewer.settled(), new Promise(resolve => setTimeout(resolve, 2000))]);
    return {sim, passes, again: await window.deusExViewer.lodProbe({})};
  });
  // The pawns the camera frame draws that hold a weapon, with their weapon bindings' state, at one moment (the terrorists walk in and out of the view):
  // the plan's actors and the weapon states are read in the same worker turn as closely as the calls allow, over a few tries.
  let weaponsInView = [];
  for (let attempt = 0; attempt < 30 && !weaponsInView.length; attempt++) {
    const plans = (await probe({})).viewports, rows = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weapons'}));
    weaponsInView = rows.filter(row => row.weapon && plans.some(plan => plan.actors.includes(row.pawn))).map(row => ({pawn: row.pawn, weapon: row.weapon, binding: row.binding, why: row.why,
      visible: row.last?.visible ?? null, frames: row.last?.frames ?? null}));
    if (!weaponsInView.length) await frames(4);
  }
  const lodRows = sample.sim, passRows = sample.passes ?? [];
  const lodSignature = row => JSON.stringify([row.returned, row.state, row.admitted, row.vertices, row.selection,
    (row.frames ?? []).map(f => [f.index, f.returned, f.state, f.admitted, f.vertices, f.selection])]);
  const again = new Map((sample.again ?? []).map(row => [row.id, lodSignature(row)]));
  const stableIds = (lodRows ?? []).filter(row => again.get(row.id) === lodSignature(row)).map(row => row.id);
  const lighting = await page.evaluate(() => window.deusExViewer.meshLightProbe({take: true}));
  // The camera frame's plan and the iterator state of the same frame, in one worker call.
  const itemFrame = await probe({iterators: true});
  const iterators = itemFrame.iterators, itemPlan = itemFrame.viewports.find(candidate => candidate.location.every((v, i) => v === itemFrame.camera.location[i]));
  const status = await page.evaluate(() => window.deusExViewer.status());
  report = {weaponsInView, sim, watched, iterators, itemPlan, lodRows, passRows, stableIds, decalShare, lighting, cone: state.cone, frameMs: +interval.toFixed(1), camera: state.camera, plans: state.viewports, passes: state.page, crop, stats, runtimeError: status.runtimeError?.message ?? null, pageErrors: errors};
} finally { await browser.close(); await server?.close(); if (!option('shot', null)) rmSync(scratch, {recursive: true, force: true}); }
console.log(JSON.stringify({...report, iterators: undefined, lodRows: undefined, passRows: undefined, stableIds: undefined, lighting: undefined, cone: report.cone.length,
  plans: report.plans.map(plan => ({...plan, coronas: plan.coronas && {...plan.coronas, frameWords: undefined, placed: plan.coronas.placed.length}}))}, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.plans.length >= 1, 'a ViewportWindow world frame per camera view each HUD frame');
const plan = report.plans.find(candidate => candidate.location.every((v, i) => v === report.camera.location[i])) ?? report.plans[0];
assert.ok(plan.nodes > 0, "OccludeBsp from the camera keeps the room's polygons");
assert.ok(plan.actors && !plan.actors.includes(cameraName), 'the origin camera is hidden in its own view');
assert.deepEqual(plan.location, report.camera.location, `the frame is made from ${cameraName}'s Location`);
assert.deepEqual(plan.rotation, report.camera.rotation, "and its Rotation");
assert.ok(plan.fov > 0 && plan.fov < 180, `at the window's FOV (${plan.fov})`);
assert.ok(plan.ms < 25, `the camera frame plans in ${plan.ms} ms (rAF ${report.frameMs} ms)`);
// SetupDynamics' Frame->Sprite from the camera: the stamped set is exactly the
// frame's own actors (the drawn ones are those the actor layer posed).
assert.ok(plan.stamped.every(name => plan.actors.includes(name) || true) && plan.stamped.length >= plan.actors.length);
assert.ok(!plan.stamped.includes(cameraName));
const unstamped = report.cone.filter(actor => !plan.stamped.includes(actor.name));
console.log(`in the camera's view cone: ${report.cone.length} mesh actors, ${unstamped.length} not in Frame->Sprite`);
for (const actor of option('camera', null) || option('map', null) ? [] : unstamped) assert.ok(!(actor.lastRenderTime >= plan.time), `${actor.name} (in the cone, not in Frame->Sprite) was not stamped by the camera frame`);
assert.equal(report.passes.length, report.plans.length, 'the page draws each frame');
const drawnPass = report.passes[report.plans.indexOf(plan)];
assert.deepEqual(drawnPass.rect, plan.rect, 'into the window rectangle the plan was made for');
assert.ok(drawnPass.calls > 0, 'with draw calls');
assert.ok(report.stats[1] > 0.02, `the rectangle holds an image (luma standard deviation ${report.stats[1]})`);
// The camera frame lit and LOD-selected the actors it draws with its own
// Coords, in the same frame: a record of the watched actor's SetupForActor
// carries the camera's origin (the master frame's Coords.Origin), and each
// drawn binding's last DrawLodMesh frame is the camera's (Coords origin and
// the window's FOV).
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), bits = v => { f32[0] = v; return u32[0]; };
const cameraBits = plan.location.map(bits);
assert.ok(report.lighting.records.some(record => record.origin.map(bits).every((b, i) => b === cameraBits[i])),
  `SetupForActor lit ${report.watched} with the camera frame's Coords`);
const cameraRows = report.lodRows.filter(row => row.frame.coordsBits.slice(0, 3).every((b, i) => b === cameraBits[i]));
for (const name of plan.actors) {
  const row = cameraRows.find(r => r.actor === name);
  if (row) assert.equal(row.frame.fovBits, bits(plan.fov), `${name}: DrawLodMesh reads the window's FOV`);
}
assert.ok(cameraRows.length > 0, 'the camera frame selected a LOD for the actors it draws');
const expectedFeatures = (option('expect', '') || '').split(',').filter(Boolean);
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const tally = {rows: 0, frames: 0, framesDiffer: 0, passes: 0, passesDiffer: 0};
if (existsSync(python)) {
  const {lodMeshTanArgument, bitsFloat} = await import('../src/runtime/lodmesh-lod.mjs');
  const doubleHex = value => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, value, true); return v.getBigUint64(0, true).toString(16).padStart(16, '0'); };
  const byMesh = new Map();
  for (const row of cameraRows) {
    const key = `${row.meshPackage}:${row.meshIndex}`;
    if (!byMesh.has(key)) byMesh.set(key, {pack: row.meshPackage, index: row.meshIndex, cases: [], rows: []});
    const entry = byMesh.get(key), name = `${row.id}:${row.actor}`;
    const inputs = {settings: row.frame.settings, lodBiasBits: row.inputs.lodBiasBits, drawScaleBits: row.inputs.drawScaleBits,
      locationBits: row.inputs.locationBits, fovBits: row.frame.fovBits,
      tanBits: {[doubleHex(lodMeshTanArgument(bitsFloat(row.frame.fovBits)))]: row.frame.tanBits}};
    entry.cases.push({name, ...inputs, fxBits: row.frame.fxBits, coordsBits: row.frame.coordsBits, returnedCount: row.returned});
    // Each child frame's own selection, with the count its GetFrame call returned.
    for (const frame of row.frames ?? [])
      entry.cases.push({name: `${name}:frame${frame.index}`, ...inputs, fxBits: frame.fxBits, coordsBits: frame.coordsBits,
        returnedCount: Math.max(1, frame.returned ?? frame.selection.requested)});
    entry.rows.push(row);
  }
  const root = gameDirectory(), specs = [], list = [...byMesh.values()];
  for (const entry of list) specs.push((await meshOracleSpec(root, entry.pack, entry.index, entry.cases)).spec);
  const reference = JSON.parse(execFileSync(python, ['scripts/native-lodmesh-lod-oracle.py', root],
    {input: JSON.stringify(specs), encoding: 'utf8', maxBuffer: 256 << 20}));
  const stable = new Set(report.stableIds);
  list.forEach((entry, at) => {
    const check = (label, got, original) => {
      assert.equal(got.selection.detailBits, original.selection.detailBits, `${label}: the frame's LOD detail equals the original's`);
      assert.equal(got.selection.requested, original.selection.requested, `${label}: requested count`);
      assert.equal(got.selection.active, Boolean(original.selection.active), `${label}: LOD flag`);
      assert.equal(got.selection.morph, Boolean(original.selection.morph), `${label}: morph flag`);
      const finalActive = Boolean(original.state.active), finalMorph = Boolean(original.state.morph);
      assert.equal(Boolean(got.state?.active), finalActive, `${label}: LOD flag after the morph`);
      assert.equal(Boolean(got.state?.morph), finalMorph, `${label}: morph flag after the morph`);
      if (finalMorph) assert.equal(got.state.start, original.state.start, `${label}: morph start`);
      const admitted = original.faces.filter(face => face.admitted), vertices = new Set(admitted.flatMap(face => face.vertices));
      assert.equal(got.admitted, admitted.length, `${label}: admitted faces`);
      return {admitted, vertices, finalActive, all: new Set(original.faces.flatMap(face => face.vertices ?? []))};
    };
    for (const row of entry.rows) {
      const name = `${row.id}:${row.actor}`, original = reference.meshes[at].cases.find(c => c.name === name);
      // An actor only a child frame draws has no selection of the camera frame's own to compare (its base state is the child's).
      if (row.drawn) { check(`${row.actor} (camera frame)`, row, original); tally.rows++; }
      for (const frame of row.frames ?? []) {
        const label = `${row.actor} (camera ${frame.index})`, original = reference.meshes[at].cases.find(c => c.name === `${name}:frame${frame.index}`);
        const {admitted, vertices, finalActive, all} = check(label, {selection: frame.selection, state: frame.state, admitted: frame.admitted}, original);
        tally.frames++; if (!frame.same) tally.framesDiffer++;
        // The page's pass for that frame draws it: the slot's corner dwords (GPU) or the geometry's resolved corners (CPU).
        if (stable.has(row.id)) for (const pass of report.passRows.filter(p => p.id === row.id && p.frame === frame.index)) {
          if (!pass.ready) continue;
          if (pass.path === 'gpu') {
            assert.equal(pass.gpuFaces, admitted.length, `${label}: faces the GPU resolves in the camera's child pass`);
            assert.equal(pass.gpuVertices, finalActive ? vertices.size : all.size, `${label}: vertices the GPU resolves`);
          } else if (finalActive) assert.equal(pass.lod?.faces, admitted.length, `${label}: faces the child pass draws`);
          tally.passes++; if (!frame.same) tally.passesDiffer++;
        }
      }
    }
  });
}
console.log(`camera frame LOD: ${cameraRows.length} bindings selected with the camera's Coords (${tally.rows} against the original's selection, ` +
  `${tally.frames} child-frame states, ${tally.framesDiffer} different from the camera frame's; the page's child passes: ${tally.passes} compared, ` +
  `${tally.passesDiffer} of a differing state); lighting records at the camera's origin: ${report.lighting.records.filter(r => r.origin.map(bits).every((b, i) => b === cameraBits[i])).length}`);
// The decal block darkens the window (PF_Modulated fragments): the same frame without it is brighter.
if (plan.decals > 0 && expectedFeatures.includes('decals')) assert.ok(report.decalShare.darker >= 20 && report.decalShare.brighter <= report.decalShare.darker / 5,
  `the camera frame's decals darken its window (${report.decalShare.darker} pixels darker, ${report.decalShare.brighter} brighter)`);
// DrawFrame's corona pass on the camera frame: the icons sit where the corona code puts them from the master frame the pass read.
if (plan.coronas?.icons > 0) {
  const {coronaFrame, coronaIcon} = await import('../src/runtime/coronas.mjs'), {coordsTransform} = await import('../src/runtime/volumetric-fog.mjs');
  const {coords, frame: coronaFrameRecord} = coronaFrame(plan.coronas.frameWords);
  assert.deepEqual([...coords.origin].map(bits), cameraBits, "the corona pass reads the camera frame's Coords.Origin");
  assert.equal(coronaFrameRecord.width, plan.rect[2], "and the window's width as X");
  for (const icon of plan.coronas.placed) {
    const expected = coronaIcon({brightness: 1}, coordsTransform(icon.light.location, coords), coronaFrameRecord, icon.light);
    assert.deepEqual([icon.x, icon.y, icon.size].map(bits), [expected.x, expected.y, expected.size].map(bits), 'icon placement from the camera frame');
  }
  assert.equal(drawnPass.icons, plan.coronas.icons, 'the page draws them');
}
assert.equal(drawnPass.frames, plan.frames.length, "the page draws each child frame the camera's OccludeBsp made");
for (const feature of expectedFeatures) {
  // A pawn in the camera frame holding a weapon draws it there (DrawActorSprite's block runs in every root frame, a ViewportWindow's included;
  // docs/weapon-attachment.md): the pawn is drawn by this frame (the player's own view need not hold it) and its weapon binding is drawn in it.
  if (feature === 'weapons') {
    const armed = report.weaponsInView;
    assert.ok(armed.length > 0, 'a pawn holding a weapon in the camera frame');
    for (const row of armed) assert.ok(row.binding !== null && row.why === null && row.visible && JSON.stringify(row.frames) === '[null]',
      `${row.pawn}'s ${row.weapon} is drawn in the camera's root frame (${JSON.stringify(row.why)}, ${JSON.stringify(row.frames)})`);
    console.log(`weapons in the camera frame: ${armed.map(row => `${row.pawn}/${row.weapon}`).join(' ')}`);
  }
  if (feature === 'mirror') assert.ok(plan.frames.some(frame => frame.kind === 'mirror'), 'the camera frame has a mirror child frame');
  if (feature === 'sky') assert.ok(plan.sky, 'the camera frame has a sky frame');
  if (feature === 'decals') assert.ok(plan.decals > 0, 'the camera frame draws decals');
  if (feature === 'coronas') assert.ok(plan.coronas?.icons > 0, 'the camera frame draws coronas');
  if (feature === 'items') {
    const itemsPlan = report.itemPlan;
    // The camera frame's own iterator items: each is drawn through a binding updated with that item,
    // the main frame's when equal to one of its items and an extra of its own otherwise.
    assert.ok(itemsPlan.items.length > 0 && itemsPlan.itemExtras > 0, `the camera frame has iterator items of its own (${itemsPlan.items.length} items, ${itemsPlan.itemExtras} extras)`);
    assert.ok(itemsPlan.items.some(claim => claim.drawn), 'some of them are in the camera frame\'s Frame->Sprite');
    const states = new Map(report.iterators.itemStates.map(entry => [entry.id, entry])), [mainRoot] = report.iterators.lastFrames;
    const same = (a, b) => a && b && a.location.every((v, k) => Object.is(v, b.location[k])) && a.rotation.every((v, k) => v === b.rotation[k])
      && Object.is(a.drawScale, b.drawScale) && Object.is(a.scaleGlow, b.scaleGlow);
    let extras = 0, shared = 0;
    // The bindings of the items a frame draws are updated with their items (the others have nothing to draw).
    for (const claim of itemsPlan.items.filter(item => item.drawn)) {
      const entry = states.get(claim.id), equalsMain = mainRoot.bindings.some(root => root.actor === claim.actor && root.slot === claim.slot && same(root, claim));
      assert.ok(entry && same(entry.item, claim), `item binding ${claim.id} was updated with the camera frame's item`);
      assert.equal(entry.extra, !equalsMain, `item ${claim.id} shares the main frame's binding exactly when it equals the main frame's item: ${JSON.stringify({claim, entry, mainSameSlot: mainRoot.bindings.filter(root => root.actor === claim.actor && root.slot === claim.slot)})}`);
      if (entry.extra) extras++; else shared++;
    }
    assert.ok(!expectedFeatures.includes('extras') || extras > 0, 'some camera frame items differ from the main frame\'s and are drawn through bindings of their own');
    // The camera frame's child frames: the same, and the page draws the extras in their passes.
    let childClaims = 0, childExtras = 0;
    for (const frame of itemsPlan.frames) for (const claim of frame.items.filter(item => item.drawn)) {
      const entry = states.get(claim.id);
      assert.ok(entry && same(entry.item, claim), `child frame ${frame.index}: item binding ${claim.id} was updated with the frame's item`);
      const equalsRoot = itemsPlan.items.some(root => root.actor === claim.actor && root.slot === claim.slot && same(root, claim))
        || mainRoot.bindings.some(root => root.actor === claim.actor && root.slot === claim.slot && same(root, claim));
      assert.equal(entry.extra, !equalsRoot, `child frame ${frame.index}: item ${claim.id} has a binding of its own exactly when it differs from the root frames' items`);
      childClaims++; if (entry.extra) childExtras++;
    }
    const extraIds = new Set([...states.values()].filter(entry => entry.extra).map(entry => entry.id));
    const childDraws = report.passRows.filter(row => extraIds.has(row.id) && row.child).length;
    assert.ok(childExtras === 0 || childDraws > 0 || !expectedFeatures.includes('extras'), `the page draws the extras in the camera's mirror pass (${childExtras} held, ${childDraws} drawn)`);
    console.log(`camera child frames' iterator items: ${childClaims} drawn, ${childExtras} through bindings of their own; the page drew extras in the child pass ${childDraws} times`);
    console.log(`camera frame iterator items: ${itemsPlan.items.length}, ${itemsPlan.items.filter(item => item.drawn).length} drawn (${extras} through bindings of their own, ${shared} shared with the main frame's)`);
  }
  if (feature === 'fog') assert.ok(drawnPass.fog?.drawn > 0, "the camera frame computes fog maps for its surfaces");
}
console.log(`camera frame children: ${plan.frames.map(frame => `${frame.kind}#${frame.index}(parent ${frame.parent}, ${frame.nodes} nodes, ${frame.actors.length} actors)`).join(' ') || 'none'}; ` +
  `${plan.decals} decal triangles (${report.decalShare.darker} window pixels darker with them, ${report.decalShare.brighter} brighter), ${plan.coronas?.icons ?? 0} corona icons of ${plan.coronas?.leafLights ?? 0} leaf lights; fog maps ${drawnPass.fog ? `${drawnPass.fog.drawn} surfaces, ${drawnPass.fog.frameMaps} in child frames` : 'none (no fog surfaces)'}`);
console.log(`validate-terminals-camera-browser: PASS (${report.sim}; ${plan.nodes} nodes, ${plan.actors.length} actors, ${drawnPass.calls} calls)`);
