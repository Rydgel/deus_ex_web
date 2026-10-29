/** ADecal::execAttachDecal and execDetachDecal in the Rust core
 * (native/script-vm/src/decal.rs, src/runtime/decal-kernel.mjs) against the
 * unchanged original under Unicorn (scripts/native-decal-oracle.py attach
 * mode): docs/decals.md.
 *
 * native-decal-cases.py builds the scenarios on the map's real BSP with the
 * original UModel::LineCheck (Shadows under pawns and the player start,
 * blood pools growing through ReattachDecal, scorch marks and bullet holes
 * near polygon edges, non-coplanar neighbours, texture ordering, double
 * attach, degenerate directions, every gate, synthetic PolyFlags and Mover
 * surfaces) and runs them at control word 0x037f. Each scenario then runs
 * through the port on a fresh store, with the oracle's rand() values. After
 * every operation the result word, the exit, SurfList, the rand() calls and
 * every surface's FDecal list (actor, Vertices bits, Nodes, MoverRotation, in
 * TArray order) must match.
 *
 * With --tracker the model is the one the moving brush tracker filtered the
 * map's movers into (brush-tracker.mjs trackedModel; the movers at their
 * placement, then the first two raised 96 units by an Update at 24 bits):
 * every tracker surface's Actor is its Mover, and the scenarios add
 * bullet holes, scorch marks and blood splats on mover fragments (the
 * Mover branch: MoverRotation, SetBase(Owner, 1)). Two checks of Play's
 * plumbing follow (the port against itself, not the original): each
 * scenario's store is laid out for more surfaces after its first operation
 * (decal-kernel.mjs setModel), and a decal model uploaded before three more
 * Updates and synced after them (decal.rs `decal_model_sync`) must equal
 * one uploaded after them.
 *
 *   node scripts/validate-decal-attach.mjs [--map 00_Training] [--compare] [--tracker]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decalModelJson } from './decal-model-export.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { uploadDecalModel, createDecalStore, bitsF32 } from '../src/runtime/decal-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, trackedModel, trackerMoverSpec, trackerTextureFlags, TRACKER } from '../src/runtime/brush-tracker.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { surfaceTextureFlags as textureFlagsOf } from './occlusion-request.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const mapName = flag('map', '00_Training');
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-decal-attach: no native probe environment');
  process.exit(0);
}
const kernel = (await loadScriptVmKernel()).decals;
if (!kernel) throw new Error('The script VM core predates decal.rs (npm run build:wasm)');
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get(mapName), map = decodeMap(asset.bytes);

// --tracker: the model as the moving brush tracker filtered the movers in.
let model = map.model, moverRotation = null, trackerNote = '', tracked = null;
if (argv.includes('--tracker')) {
  const occlusionKernel = (await loadScriptVmKernel()).occlusion;
  const movers = await collectTrackerMovers(assets, asset, map);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const rotations = movers.map(m => (m.values.Rotation ?? [0, 0, 0]).map(v => v | 0));
  const occlusion = createBspOcclusion(occlusionKernel, map.model, { surfaceTextureFlags: await textureFlagsOf(assets, asset, map.model),
    tracker: { movers: movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
      rotation: rotations[i], prePivot: m.values.PrePivot ?? [0, 0, 0] })) } });
  assert.equal(occlusion.tracker.construct({ pc64: true }), 0, 'tracker construction');
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), bitsOf = v => (f32[0] = v, u32[0]);
  for (const i of [0, 1].filter(i => i < movers.length)) {
    occlusion.tracker.setMover(i, { locationBits: (movers[i].values.Location ?? [0, 0, 0]).map((v, k) => bitsOf(Math.fround(v + (k === 2 ? 96 : 0)))),
      rotation: rotations[i] });
    occlusion.tracker.update(i);
  }
  model = trackedModel(occlusion, map.model, occlusionKernel.memory);
  moverRotation = i => rotations[i];
  tracked = { occlusion, occlusionKernel, movers, rotations, bitsOf };
  trackerNote = ` with ${movers.length} tracked movers (${model.nodes.length - model.originalNodes} pool nodes)`;
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'decal-attach-'));
let cases;
try {
  const modelPath = path.join(scratch, 'model.json');
  await writeFile(modelPath, JSON.stringify(decalModelJson(mapName, map, { model, moverRotation })));
  const started = performance.now();
  cases = JSON.parse(execFileSync(python, ['scripts/native-decal-cases.py', root, modelPath,
    ...(argv.includes('--compare') ? ['--compare'] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 }));
  console.log(`oracle: ${cases.request.scenarios.length} scenarios in ${((performance.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const counts = { scenarios: 0, ops: 0, attaches: 0, attached: 0, decals: 0, neighbours: 0, moverBranches: 0, exits: {} };
for (const [index, scenario] of cases.request.scenarios.entries()) {
  const reference = cases.results0x037f[index];
  assert.equal(reference.name, scenario.name);
  assert.ok(!reference.error, `${scenario.name}: oracle error ${reference.error}`);
  const surfaceFlags = scenario.surfaceFlags
    ? Object.fromEntries(Object.entries(scenario.surfaceFlags).map(([k, v]) => [Number(k), v])) : null;
  const movers = new Map(Object.entries(scenario.surfaceActors ?? {})
    .filter(([, actor]) => /mover/i.test(actor.class)).map(([k, actor]) => [Number(k), actor.rotation ?? [0, 0, 0]]));
  const decalModel = uploadDecalModel(kernel, model, { surfaceFlags,
    isMover: s => movers.get(s) ?? (model.surfaces.at(s)?.dynamic ? moverRotation(model.surfaces.at(s).mover) : null) });
  const store = createDecalStore(kernel, decalModel, { capacity: 4 });
  const actors = new Map(), textures = new Map(), touched = new Set();
  const actorOf = name => {
    if (!actors.has(name)) actors.set(name, { id: actors.size + 1, name, surfList: [], texture: 0 });
    return actors.get(name);
  };
  const textureId = name => { if (!textures.has(name)) textures.set(name, textures.size + 1); return textures.get(name); };
  try {
    for (const [k, op] of scenario.ops.entries()) {
      const expected = reference.ops[k], actor = actorOf(op.actor);
      const where = `${scenario.name} op ${k} (${op.op} ${op.actor})`;
      counts.ops++;
      if (op.op === 'attach') {
        counts.attaches++;
        actor.texture = textureId(op.texture.name);
        const rands = [...(op.rand ?? [])];
        const location = op.locationBits ? op.locationBits.map(bitsF32) : op.location.map(Math.fround);
        const drawScale = op.drawScaleBits !== undefined ? bitsF32(op.drawScaleBits) : Math.fround(op.drawScale);
        const level = Math.min(op.multiDecalLevel | 0, 4);
        assert.equal(level, expected.multiDecalLevel, `${where}: clamped MultiDecalLevel`);
        const out = store.attach({ actor: actor.id, location, rotation: op.rotation, traceDistance: Math.fround(op.args[0]),
          decalDir: (op.args[1] ?? [0, 0, 0]).map(Math.fround), drawScale, uSize: op.texture.USize, level,
          texture: actor.texture, surfList: actor.surfList }, {
          rand: () => { if (!rands.length) throw new Error(`${where}: rand() beyond the recorded values`); return rands.shift(); },
          textureOf: id => [...actors.values()].find(a => a.id === id)?.texture ?? 0,
        });
        // The Mover branch: the original called this->SetBase(Owner, 1),
        // which the port leaves to its host.
        const setBases = (expected.events ?? []).filter(event => event.op === 'SetBase');
        assert.equal(out.setBase, setBases.length > 0, `${where}: SetBase(Owner, 1) requested`);
        if (setBases.length) {
          assert.equal(setBases.length, 1, `${where}: one SetBase`);
          assert.equal(setBases[0].notify, 1, `${where}: SetBase's bNotifyActor`);
          assert.equal(setBases[0].newBase, op.owner ?? 0, `${where}: SetBase's NewBase is the decal's Owner`);
          counts.moverBranches++;
        }
        actor.surfList.push(...out.appended);
        for (const s of out.appended) touched.add(s);
        assert.equal(out.result, expected.result, `${where}: result`);
        assert.equal(out.exit, expected.exit, `${where}: exit`);
        assert.equal(out.rands, expected.rand.length, `${where}: rand() calls`);
        counts.exits[out.exit] = (counts.exits[out.exit] ?? 0) + 1;
        if (out.result) { counts.attached++; counts.neighbours += out.appended.length - 1; }
      } else {
        store.detach({ actor: actor.id, surfList: actor.surfList });
        actor.surfList = [];
      }
      // Play's store growing into the tracker's surfaces (setModel).
      if (tracked && k === 0) store.setModel({ ...decalModel, surfaceCount: decalModel.surfaceCount + 7 });
      assert.deepEqual(actor.surfList, expected.surfList, `${where}: SurfList`);
      for (const s of Object.keys(expected.decals)) touched.add(Number(s));
      const got = {};
      for (const s of touched) {
        const list = store.surfaceDecals(s);
        if (list.length) got[s] = list.map(e => ({ actor: [...actors.values()].find(a => a.id === e.actor)?.name ?? e.actor,
          verticesBits: e.verticesBits, nodes: e.nodes, moverRotation: e.moverRotation }));
      }
      const want = Object.fromEntries(Object.entries(expected.decals).map(([s, list]) => [s, list.map(e => ({
        actor: e.actor, verticesBits: e.verticesBits, nodes: e.nodes, moverRotation: e.moverRotation }))]));
      for (const s of new Set([...Object.keys(got), ...Object.keys(want)])) {
        const a = got[s] ?? [], b = want[s] ?? [];
        assert.equal(a.length, b.length, `${where}: surface ${s} FDecal count`);
        for (let e = 0; e < a.length; e++) {
          assert.equal(a[e].actor, b[e].actor, `${where}: surface ${s} entry ${e} actor`);
          for (let v = 0; v < 4; v++) for (let c = 0; c < 3; c++)
            assert.equal(a[e].verticesBits[v][c], b[e].verticesBits[v][c] >>> 0,
              `${where}: surface ${s} entry ${e} vertex ${v}.${'xyz'[c]} ${bitsF32(a[e].verticesBits[v][c])} vs ${bitsF32(b[e].verticesBits[v][c])}`);
          assert.deepEqual(a[e].nodes, b[e].nodes, `${where}: surface ${s} entry ${e} Nodes`);
          assert.deepEqual(a[e].moverRotation, b[e].moverRotation, `${where}: surface ${s} entry ${e} MoverRotation`);
        }
      }
      counts.decals = Math.max(counts.decals, Object.values(got).reduce((n, list) => n + list.length, 0));
    }
  } finally {
    store.dispose();
    decalModel.dispose();
  }
  counts.scenarios++;
}
// Play's decal model following the tracker: upload, three more Updates
// (movers 0 and 1 back to their placement, mover 2 turned), sync, and
// compare with a fresh upload.
if (tracked) {
  const { occlusion, occlusionKernel, movers, rotations, bitsOf } = tracked, t = occlusion.tracker;
  const isMover = m => s => (m.surfaces[s]?.dynamic ? moverRotation(m.surfaces[s].mover) : null);
  const pointCapacity = t.header(TRACKER.POINTS_CAP);
  const before = uploadDecalModel(kernel, model, { pointCapacity, isMover: isMover(model) });
  const generation = t.header(TRACKER.GENERATION);
  for (const i of [0, 1, 2].filter(i => i < movers.length)) {
    const location = (movers[i].values.Location ?? [0, 0, 0]).map(v => bitsOf(Math.fround(v)));
    const rotation = i === 2 ? [rotations[i][0], (rotations[i][1] + 4096) | 0, rotations[i][2]] : rotations[i];
    t.setMover(i, { locationBits: location, rotation });
    t.update(i);
  }
  assert.ok(t.header(TRACKER.GENERATION) !== generation, 'the Updates advance the tracker generation');
  assert.ok(before.sync(), 'decal_model_sync fits');
  const after = trackedModel(occlusion, map.model, occlusionKernel.memory);
  const fresh = uploadDecalModel(kernel, after, { pointCapacity, isMover: isMover(after) });
  const regions = m => {
    const u = new Uint32Array(kernel.memory.buffer), h = i => u[(m.base >>> 2) + i], trace = h(7) >>> 2;
    const at = (ptr, n) => u.subarray(ptr >>> 2, (ptr >>> 2) + n);
    const traceNodes = [];
    for (let i = 0; i < u[trace]; i++) traceNodes.push(...u.subarray(trace + 8 + 16 * i, trace + 8 + 16 * i + 13));
    return { counts: [h(0), h(8), h(9), h(10), h(11), h(12)], nodes: at(h(1), 4 * h(0)), verts: at(h(2), h(9)),
      points: at(h(3), 3 * h(10)), vectors: at(h(4), 3 * h(11)), surfs: at(h(5), 9 * h(8)), lists: at(h(6), h(12)),
      traceHeader: [u[trace], u[trace + 1], u[trace + 3]], traceNodes, hulls: at(u[trace + 2], u[trace + 3]) };
  };
  const a = regions(before), b = regions(fresh);
  for (const key of Object.keys(a)) {
    assert.equal(a[key].length, b[key].length, `synced model ${key} length`);
    for (let i = 0; i < a[key].length; i++) if (a[key][i] !== b[key][i]) assert.fail(`synced model ${key} word ${i}: ${a[key][i]} vs ${b[key][i]}`);
  }
  before.dispose(); fresh.dispose();
  trackerNote += `; store resized per scenario, synced model equal to a fresh upload after ${movers.length > 2 ? 3 : movers.length} Updates`;
}
const exits = Object.entries(counts.exits).map(([exit, n]) => `${exit} ${n}`).join(', ');
console.log(`validate-decal-attach: ${mapName}${trackerNote}: ${counts.scenarios} scenarios, ${counts.ops} operations, ` +
  `${counts.attaches} AttachDecal calls (${exits}), ${counts.neighbours} neighbour FDecals, ` +
  `${counts.moverBranches} Mover branch (MoverRotation, SetBase(Owner, 1)); every FDecal list bit-equal to the original; PASS`);
if (Object.keys(cases.controlWordComparison ?? {}).length)
  console.log(`control words: ${JSON.stringify(cases.controlWordComparison)}`);
