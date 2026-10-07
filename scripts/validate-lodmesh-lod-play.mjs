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
//   node scripts/validate-lodmesh-lod-play.mjs [--map M] [--query gpuMesh=0] [--url http://...]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {meshOracleSpec} from './lodmesh-lod-cases.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-lodmesh-lod-play: no installed game data'); process.exit(0); }
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-lodmesh-lod-play: no native probe environment'); process.exit(0); }
const map = option('map', '01_NYC_UNATCOIsland'), query = option('query', '');
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
  await page.goto(`${url}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(60);
  // Views: the start, four directions, and the farthest actor meshes (the
  // ones the LOD reduces most), looked at from the start.
  // --from x,y,z: start from another place (an open area of the map).
  const from = option('from', null);
  if (from) { await page.evaluate(location => window.deusExViewer.placeProbe({location}), from.split(',').map(Number)); await frames(30); }
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
  const views = [{name: 'start'}, ...[0, 16384, 32768, 49152].map(yaw => ({name: `yaw ${yaw}`, rotation: [65000, yaw, 0]})),
    ...far.map(entry => ({name: `look at ${entry.actor} (${Math.round(entry.distance)})`, lookAt: entry.actor}))];
  for (const view of views) {
    if (view.rotation || view.lookAt) await page.evaluate(args => window.deusExViewer.placeProbe(args), {rotation: view.rotation ?? null, lookAt: view.lookAt ?? null});
    await frames(30);
    // Two probes around the page's read: a binding whose rows agree was
    // drawn by the page from the frame the probe reports.
    const sample = await page.evaluate(async () => {
      await window.deusExViewer.settled();
      const sim = await window.deusExViewer.lodProbe({}), drawn = window.deusExViewer.meshLod();
      await window.deusExViewer.settled();
      return {sim, drawn, again: await window.deusExViewer.lodProbe({})};
    });
    const again = new Map((sample.again ?? []).map(row => [row.id, JSON.stringify(row)]));
    samples.push({yaw: view.name, sim: sample.sim, drawn: sample.drawn,
      stable: new Set((sample.sim ?? []).filter(row => again.get(row.id) === JSON.stringify(row)).map(row => row.id))});
    const drawnRows = (sample.sim ?? []).filter(row => row.drawn);
    console.error(`${view.name}: ${drawnRows.length} drawn, ${drawnRows.filter(row => row.state?.active).length} reduced` +
      ` [${drawnRows.map(row => `${row.actor}:${row.returned}`).join(' ')}]`);
  }
  console.error(`eye ${eye.location.map(Math.round)}; far: ${far.map(entry => `${entry.actor}@${entry.location.map(Math.round)}`).join(' ')}`);
  runtimeError = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
} finally { await browser.close(); await server?.close(); }
assert.deepEqual(pageErrors, [], 'no page errors');
assert.equal(runtimeError, null, 'no runtime error');
assert.ok(samples.length >= 5, 'samples from the views');

// The oracle cases: one per drawn row with the LOD on, grouped by mesh.
const byMesh = new Map(), checks = [];
for (const sample of samples) {
  const drawn = new Map((sample.drawn ?? []).map(entry => [entry.id, entry]));
  for (const row of sample.sim ?? []) {
    if (!row.drawn) continue;
    const key = `${row.meshPackage}:${row.meshIndex}`;
    if (!byMesh.has(key)) byMesh.set(key, {pack: row.meshPackage, index: row.meshIndex, cases: []});
    const entry = byMesh.get(key), name = `${sample.yaw}:${row.id}:${row.actor}`;
    entry.cases.push({name, settings: row.frame.settings, lodBiasBits: row.inputs.lodBiasBits, drawScaleBits: row.inputs.drawScaleBits,
      locationBits: row.inputs.locationBits, fovBits: row.frame.fovBits, fxBits: row.frame.fxBits, coordsBits: row.frame.coordsBits,
      tanBits: null, returnedCount: row.returned});
    checks.push({key, name, row, page: sample.stable.has(row.id) ? drawn.get(row.id) ?? null : null});
  }
}
assert.ok(checks.length > 0, 'drawn actor meshes with the LOD');
const doubleHex = value => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, value, true); return v.getBigUint64(0, true).toString(16).padStart(16, '0'); };
const {lodMeshTanArgument, bitsFloat} = await import('../src/runtime/lodmesh-lod.mjs');
const specs = [], meshes = new Map();
for (const [key, entry] of byMesh) {
  for (const c of entry.cases) c.tanBits = {[doubleHex(lodMeshTanArgument(bitsFloat(c.fovBits)))]: checks.find(k => k.name === c.name).row.frame.tanBits};
  const {spec, topology} = await meshOracleSpec(root, entry.pack, entry.index, entry.cases);
  specs.push(spec); meshes.set(key, {topology, at: specs.length - 1});
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-lodmesh-lod-oracle.py', root],
  {input: JSON.stringify(specs), encoding: 'utf8', maxBuffer: 256 << 20}));
const tally = {rows: checks.length, active: 0, morph: 0, reduced: 0, minCount: Infinity, meshes: byMesh.size, pageCompared: 0};
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
console.log(`validate-lodmesh-lod-play: PASS (${map}${query ? `, ${query}` : ''}: ${tally.rows} drawn LOD rows over ${samples.length} views, ` +
  `${tally.meshes} meshes; ${tally.active} with reduced topology, ${tally.morph} morphing, ${tally.reduced} below ModelVerts ` +
  `(down to ${tally.minCount === Infinity ? '-' : tally.minCount}); the selection, flags, start, admitted faces and vertices equal ` +
  `the original's, and the page draws them (${tally.pageCompared} compared, ${tally.gpu ?? 0} on the GPU path))`);
