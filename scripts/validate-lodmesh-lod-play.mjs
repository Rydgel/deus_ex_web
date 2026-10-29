// DrawLodMesh's distance LOD in Play (docs/script-lodmesh-lod.md "Play"):
// the map runs in the default worker mode; after it settles, from several
// view directions, lod-probe.mjs reports every drawn actor mesh's LOD inputs
// and results on the simulation side and deusExViewer.meshLod() what the
// page's geometry draws. The same inputs (Frame->Coords, FX, the FovAngle
// tangent float, Location, DrawScale, LODBias and GetFrame's returned count)
// then run through the original Render.dll ranges
// (scripts/native-lodmesh-lod-oracle.py, control word 0x007f), which must
// give the same detail bits, requested count, flags and morph start, and
// the same admitted faces and distinct vertices as the page draws.
//
// Child frames (docs/script-lodmesh-lod.md "Child frames"): each mirror or sky
// frame that draws a binding reports that frame's own selection (its Coords and
// FX) and the state its GetFrame call and the LOD give (count, flags, start,
// admitted faces and vertices); both go through the oracle with the count the
// call returned. The page's pass for that frame (actor-mesh-draw.mjs
// setPassProbe: what the slot's corner dwords or the geometry's resolved
// corners hold once the pass's lighting run is done) must draw that state,
// also when it differs from the main frame's. --mirrors views the map's mirror
// polygons from in front instead of the far actors, at several MLODs.
//
// --weapon (Training): the player first takes the crowbar and equips it (renderPassProbe), so the
// first-person weapon's binding joins the rows: Canvas.DrawActor draws it in the master frame
// (docs/script-lodmesh-lod.md "The first-person weapon"), and its selection, with the master
// frame's Coords and FX and the weapon's own Location, DrawScale and LODBias, goes through the
// original ranges like any other row.
//
//   node scripts/validate-lodmesh-lod-play.mjs [--map M] [--query gpuMesh=0] [--mirrors] [--weapon] [--mlod 0.25,3] [--url http://...]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {meshOracleSpec} from './lodmesh-lod-cases.mjs';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {surfaceTextureFlags} from './occlusion-request.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-lodmesh-lod-play: no installed game data'); process.exit(0); }
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-lodmesh-lod-play: no native probe environment'); process.exit(0); }
const map = option('map', '01_NYC_UNATCOIsland'), query = option('query', '');
const mirrorViews = process.argv.includes('--mirrors'), weaponView = process.argv.includes('--weapon');
// --mlod a,b,c: URender's MLOD (shape LOD distance) for each sampling of a view
// (shipped: 0.25; sim-side setLodSettings through lodProbe). With --mirrors the
// default samples each mirror view at 0.25, 1, 3 and 10, so that frames whose
// LOD choice differs from the main frame's (a reflection twice as far, a larger
// MLOD) are among the child passes compared.
const mlods = option('mlod', mirrorViews ? '0.25,1,3,10' : '').split(',').filter(Boolean).map(Number);
/** Cameras in front of the map's mirror polygons (PF_Mirrored, surface or
 * texture flags), at 160 and 420 units along the normal, eye height above. */
async function mirrorCameras() {
  const files = [];
  for (const dir of ['Maps', 'System', 'Textures'])
    for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
  const assets = new AssetStore(files), asset = await assets.get(map), model = decodeMap(asset.bytes).model;
  const flags = await surfaceTextureFlags(assets, asset, model), seen = new Set(), cameras = [];
  model.nodes.forEach(n => {
    if (n.vertexCount < 3 || !(((model.surfaces.at(n.surface).flags | flags[n.surface]) >>> 0) & 0x08000000)) return;
    const c = [0, 0, 0];
    for (let k = 0; k < n.vertexCount; k++) { const p = model.points.at(model.vertices.at(n.vertexPool + k).point); for (let j = 0; j < 3; j++) c[j] += p[j] / n.vertexCount; }
    const key = c.map(v => Math.round(v / 64)).join(',');
    if (seen.has(key)) return; seen.add(key);
    for (const d of [160, 420]) {
      const eye = c.map((v, j) => v + n.plane[j] * d + (j === 2 ? (Math.abs(n.plane[2]) > 0.7 ? 0 : 0) : 0));
      if (Math.abs(n.plane[2]) > 0.7) eye[2] = c[2] + 120 * Math.sign(n.plane[2]);
      cameras.push({eye, at: c});
    }
  });
  return cameras.slice(0, Number(option('mirror-views', 16)));
}
let server = null, url = option('url', null);
if (!url) {
  const tree = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && tree.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && tree.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root: tree, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const samples = [], pageErrors = [];
let runtimeError = null;
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(debugUrl(`${url}/${query ? `?${query}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(60);
  await page.evaluate(() => window.deusExViewer.meshPassProbe(true));
  // Views: the start, four directions, and the farthest actor meshes (the
  // ones the LOD reduces most), looked at from the start.
  // --from x,y,z: start from another place (an open area of the map).
  const from = option('from', null);
  if (from) { await page.evaluate(location => window.deusExViewer.placeProbe({location}), from.split(',').map(Number)); await frames(30); }
  if (weaponView) {
    assert.equal(map, '00_Training', '--weapon takes the Training crowbar');
    const at = await page.evaluate(() => window.deusExViewer.renderPassProbe({locate: 'WeaponCrowbar1'}));
    await page.evaluate(location => window.deusExViewer.placeProbe({location, lookAt: 'WeaponCrowbar1'}), [at[0] - 48, at[1], at[2] + 20]);
    await frames(20);
    await page.evaluate(() => window.deusExViewer.placeProbe({lookAt: 'WeaponCrowbar1'}));
    await frames(10);
    const taken = await page.evaluate(() => window.deusExViewer.renderPassProbe({take: 'WeaponCrowbar1'}));
    assert.ok(taken.equipped, `the crowbar is equipped (${JSON.stringify(taken)})`);
    await frames(60);
  }
  const listed = await page.evaluate(() => window.deusExViewer.lodProbe({list: true}));
  const eye = await page.evaluate(() => window.deusExViewer.placeProbe({}));
  // The farthest are often behind walls: take the farthest few and others
  // spread over the actors beyond 1,500 units.
  const ranked = (listed ?? []).filter(entry => entry.location && entry.actor)
    .map(entry => ({...entry, distance: Math.hypot(...entry.location.map((v, i) => v - eye.location[i]))}))
    .filter(entry => entry.distance > 1500).sort((a, b) => b.distance - a.distance);
  const count = Number(option('far', 12)), far = [...ranked.slice(0, count >> 1)];
  for (let k = 1; far.length < count && k <= count; k++) {
    const entry = ranked[Math.floor(k * ranked.length / (count + 1))];
    if (entry && !far.includes(entry)) far.push(entry);
  }
  const units = r => Math.round(r * 32768 / Math.PI);
  const views = mirrorViews ? (await mirrorCameras()).map(({eye, at}, k) => {
    const d = at.map((v, j) => v - eye[j]);
    return {name: `mirror view ${k}`, location: eye, rotation: [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) % 65536,
      (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0]};
  }) : [{name: 'start'}, ...[0, 16384, 32768, 49152].map(yaw => ({name: `yaw ${yaw}`, rotation: [65000, yaw, 0]})),
    ...far.map(entry => ({name: `look at ${entry.actor} (${Math.round(entry.distance)})`, lookAt: entry.actor}))];
  for (const view of views) for (const mlod of mlods.length ? mlods : [null]) {
    await page.evaluate(settings => window.deusExViewer.lodProbe({settings}), mlod === null ? false : {shapeLOD: mlod});
    if (view.location) { await page.evaluate(args => window.deusExViewer.placeProbe(args), {location: view.location, rotation: view.rotation}); await frames(10); }
    if (view.rotation || view.lookAt) await page.evaluate(args => window.deusExViewer.placeProbe(args), {rotation: view.rotation ?? null, lookAt: view.lookAt ?? null});
    await frames(30);
    // Two probes around the page's read, with drawn frames in between (the
    // GPU passes run when the page draws): a binding whose rows agree was
    // drawn by the page from the state the probe reports.
    const sample = await page.evaluate(async () => {
      await window.deusExViewer.settled();
      window.deusExViewer.meshPassProbe();
      const sim = await window.deusExViewer.lodProbe({});
      for (let k = 0; k < 2; k++) await new Promise(requestAnimationFrame);
      const drawn = window.deusExViewer.meshLod();
      for (let k = 0; k < 2; k++) await new Promise(requestAnimationFrame);
      const passes = window.deusExViewer.meshPassProbe();
      await window.deusExViewer.settled();
      return {sim, drawn, passes, again: await window.deusExViewer.lodProbe({})};
    });
    // A row is stable when the LOD state it reports (selections, counts, flags,
    // admitted faces, each child frame's) is the same in both probes; the
    // camera may drift by an ulp between them.
    const signature = row => JSON.stringify([row.returned, row.state, row.admitted, row.vertices, row.selection,
      (row.frames ?? []).map(f => [f.index, f.returned, f.state, f.admitted, f.vertices, f.selection])]);
    const again = new Map((sample.again ?? []).map(row => [row.id, signature(row)]));
    samples.push({yaw: mlod === null ? view.name : `${view.name} @MLOD ${mlod}`, sim: sample.sim, drawn: sample.drawn, passes: sample.passes ?? [],
      stable: new Set((sample.sim ?? []).filter(row => again.get(row.id) === signature(row)).map(row => row.id))});
    const drawnRows = (sample.sim ?? []).filter(row => row.drawn || row.frames?.length);
    console.error(`${mlod === null ? view.name : `${view.name} @MLOD ${mlod}`}${view.location ? ` at ${view.location.map(Math.round)} rot ${view.rotation}` : ''}: ${drawnRows.length} drawn, ${drawnRows.filter(row => row.state?.active).length} reduced, ` +
      `${drawnRows.reduce((n, row) => n + (row.frames?.length ?? 0), 0)} child-frame draws` +
      ` [${drawnRows.map(row => `${row.actor}:${row.returned}${row.frames?.length ? `+${row.frames.length}f` : ''}`).join(' ')}]`);
  }
  console.error(`eye ${eye.location.map(Math.round)}; far: ${far.map(entry => `${entry.actor}@${entry.location.map(Math.round)}`).join(' ')}`);
  runtimeError = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
} finally { await browser.close(); await server?.close(); }
assert.deepEqual(pageErrors, [], 'no page errors');
assert.equal(runtimeError, null, 'no runtime error');
assert.ok(samples.length >= 5, 'samples from the views');

// The oracle cases: one per drawn row with the LOD on, grouped by mesh.
const byMesh = new Map(), checks = [], frameChecks = [];
for (const sample of samples) {
  const drawn = new Map((sample.drawn ?? []).map(entry => [entry.id, entry]));
  for (const row of sample.sim ?? []) {
    if (!row.drawn && !row.frames?.length) continue;
    const key = `${row.meshPackage}:${row.meshIndex}`;
    if (!byMesh.has(key)) byMesh.set(key, {pack: row.meshPackage, index: row.meshIndex, cases: []});
    const entry = byMesh.get(key), name = `${sample.yaw}:${row.id}:${row.actor}`;
    const inputs = {settings: row.frame.settings, lodBiasBits: row.inputs.lodBiasBits, drawScaleBits: row.inputs.drawScaleBits,
      locationBits: row.inputs.locationBits, fovBits: row.frame.fovBits, tanBits: null};
    if (row.drawn) {
      entry.cases.push({name, ...inputs, fxBits: row.frame.fxBits, coordsBits: row.frame.coordsBits, returnedCount: row.returned});
      checks.push({key, name, row, tanBits: row.frame.tanBits, page: sample.stable.has(row.id) ? drawn.get(row.id) ?? null : null});
    }
    // Each child frame's own selection, with the count its GetFrame call returned.
    for (const [k, frame] of (row.frames ?? []).entries()) {
      const frameName = `${name}:frame${frame.index ?? k}`;
      entry.cases.push({name: frameName, ...inputs, fxBits: frame.fxBits, coordsBits: frame.coordsBits,
        returnedCount: Math.max(1, frame.returned ?? frame.selection.requested)});
      frameChecks.push({key, name: frameName, row, frame, tanBits: row.frame.tanBits, sample,
        page: sample.stable.has(row.id) ? (sample.passes ?? []).filter(p => p.id === row.id && p.frame === frame.index) : []});
    }
  }
}
assert.ok(checks.length + frameChecks.length > 0, 'drawn actor meshes with the LOD');
const allChecks = [...checks, ...frameChecks];
const doubleHex = value => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, value, true); return v.getBigUint64(0, true).toString(16).padStart(16, '0'); };
const {lodMeshTanArgument, bitsFloat} = await import('../src/runtime/lodmesh-lod.mjs');
const specs = [], meshes = new Map();
for (const [key, entry] of byMesh) {
  for (const c of entry.cases) c.tanBits = {[doubleHex(lodMeshTanArgument(bitsFloat(c.fovBits)))]: allChecks.find(k => k.name === c.name).tanBits};
  const {spec, topology} = await meshOracleSpec(root, entry.pack, entry.index, entry.cases);
  specs.push(spec); meshes.set(key, {topology, at: specs.length - 1});
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-lodmesh-lod-oracle.py', root],
  {input: JSON.stringify(specs), encoding: 'utf8', maxBuffer: 256 << 20}));
const weaponRows = checks.filter(check => check.row.weapon);
if (weaponView) assert.ok(weaponRows.length > 0, 'the first-person weapon is among the drawn rows');
const tally = {rows: checks.length, active: 0, morph: 0, reduced: 0, minCount: Infinity, meshes: byMesh.size, pageCompared: 0,
  frames: frameChecks.length, framesSame: 0, framesDiffer: [], passes: 0, passesDiffer: 0};
for (const check of frameChecks) {
  const {at} = meshes.get(check.key), original = reference.meshes[at].cases.find(c => c.name === check.name);
  const {frame} = check, label = `${check.name} (${specs[at].name})`;
  assert.equal(frame.selection.detailBits, original.selection.detailBits, `${label}: child frame detail bits`);
  assert.equal(frame.selection.requested, original.selection.requested, `${label}: child frame requested count`);
  assert.equal(frame.selection.active, Boolean(original.selection.active), `${label}: child frame LOD flag`);
  assert.equal(frame.selection.morph, Boolean(original.selection.morph), `${label}: child frame morph flag`);
  // The frame's own final flags, start, admitted faces and vertices.
  const finalActive = Boolean(original.state.active), finalMorph = Boolean(original.state.morph);
  assert.equal(Boolean(frame.state?.active), finalActive, `${label}: child frame LOD flag after the morph`);
  assert.equal(Boolean(frame.state?.morph), finalMorph, `${label}: child frame morph flag after the morph`);
  if (finalMorph) assert.equal(frame.state.start, original.state.start, `${label}: child frame morph start`);
  const admitted = original.faces.filter(face => face.admitted), vertices = new Set(admitted.flatMap(face => face.vertices));
  assert.equal(frame.admitted, admitted.length, `${label}: child frame admitted faces`);
  if (finalActive && frame.vertices !== null) assert.equal(frame.vertices, vertices.size, `${label}: child frame distinct vertices`);
  if (frame.same) tally.framesSame++; else tally.framesDiffer.push(`${check.name}: main ${frame.main}, frame ${frame.here}`);
  // The page's pass for that frame draws it: the slot's corner dwords (GPU) or
  // the geometry's resolved corners (CPU) hold this frame's state.
  const all = new Set(original.faces.flatMap(face => face.vertices ?? []));
  for (const pass of check.page) {
    if (!pass.ready) continue;
    if (pass.path === 'gpu') {
      assert.equal(pass.gpuFaces, admitted.length, `${label}: faces the GPU resolves in the child pass`);
      assert.equal(pass.gpuVertices, finalActive ? vertices.size : all.size, `${label}: vertices the GPU resolves in the child pass`);
    } else if (finalActive) {
      assert.ok(pass.lod, `${label}: the child pass draws the reduced faces`);
      assert.equal(pass.lod.faces, admitted.length, `${label}: faces the child pass draws`);
      assert.equal(pass.lod.vertices, vertices.size, `${label}: vertices the child pass draws`);
    } else assert.equal(pass.lod, null, `${label}: the child pass draws every face`);
    tally.passes++;
    if (!frame.same) tally.passesDiffer++;
  }
}
for (const check of checks) {
  const {at, topology} = meshes.get(check.key), original = reference.meshes[at].cases.find(c => c.name === check.name);
  const {row, page} = check, label = `${check.name} (${specs[at].name})`;
  assert.equal(row.selection.detailBits, original.selection.detailBits, `${label}: detail bits`);
  assert.equal(row.selection.requested, original.selection.requested, `${label}: requested count`);
  assert.equal(row.selection.active, Boolean(original.selection.active), `${label}: LOD flag`);
  assert.equal(row.selection.morph, Boolean(original.selection.morph), `${label}: morph flag`);
  const finalActive = Boolean(original.state.active), finalMorph = Boolean(original.state.morph);
  assert.equal(Boolean(row.state?.active), finalActive, `${label}: LOD flag after the morph`);
  assert.equal(Boolean(row.state?.morph), finalMorph, `${label}: morph flag after the morph`);
  if (finalMorph) assert.equal(row.state.start, original.state.start, `${label}: morph start`);
  const admitted = original.faces.filter(face => face.admitted), vertices = new Set(admitted.flatMap(face => face.vertices));
  assert.equal(row.admitted, admitted.length, `${label}: admitted faces`);
  if (finalActive && row.path === 'cpu') assert.equal(row.vertices, vertices.size, `${label}: distinct vertices`);
  if (page?.ready && row.path === 'gpu') {
    // The GPU path: the corner pass's resolved dwords (every face's own at
    // full detail).
    const all = new Set(original.faces.flatMap(face => face.vertices ?? []));
    assert.equal(page.gpuFaces, admitted.length, `${label}: faces the GPU resolves`);
    assert.equal(page.gpuVertices, finalActive ? vertices.size : all.size, `${label}: vertices the GPU resolves`);
    tally.pageCompared++; tally.gpu = (tally.gpu ?? 0) + 1;
  } else if (page?.ready) {
    if (finalActive) {
      assert.ok(page.lod, `${label}: the page draws the reduced faces`);
      assert.equal(page.lod.faces, admitted.length, `${label}: faces the page draws`);
      assert.equal(page.lod.vertices, vertices.size, `${label}: vertices the page draws`);
    } else assert.equal(page.lod, null, `${label}: the page draws every face`);
    tally.pageCompared++;
  }
  tally.active += finalActive ? 1 : 0; tally.morph += finalMorph ? 1 : 0;
  if (row.returned < topology.modelVerts) { tally.reduced++; tally.minCount = Math.min(tally.minCount, row.returned); }
}
console.log(`validate-lodmesh-lod-play: PASS (${map}${query ? `, ${query}` : ''}${weaponView ? `, first-person weapon: ${weaponRows.length} rows (${[...new Set(weaponRows.map(check => `${check.row.actor}: GetFrame returned ${check.row.returned}, LOD flag ${Boolean(check.row.state?.active)}`))].join('; ')})` : ''}: ${tally.rows} drawn LOD rows over ${samples.length} views, ` +
  `${tally.meshes} meshes; ${tally.active} with reduced topology, ${tally.morph} morphing, ${tally.reduced} below ModelVerts ` +
  `(down to ${tally.minCount === Infinity ? '-' : tally.minCount}); the selection, flags, start, admitted faces and vertices equal ` +
  `the original's, and the page draws them (${tally.pageCompared} compared, ${tally.gpu ?? 0} on the GPU path); ` +
  `${tally.frames} child-frame states equal the original's, ${tally.framesSame} the main frame's own and ` +
  `${tally.framesDiffer.length} different (${tally.framesDiffer.slice(0, 3).join('; ')}); the page's child passes drew them: ` +
  `${tally.passes} compared, ${tally.passesDiffer} of a frame whose state differs from the main frame's)`);
