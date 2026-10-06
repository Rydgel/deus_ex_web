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
 *   node scripts/validate-decal-attach.mjs [--map 00_Training] [--compare]
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
import { uploadDecalModel, createDecalStore, bitsF32, DecalKernelFault } from '../src/runtime/decal-kernel.mjs';

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

const scratch = await mkdtemp(path.join(os.tmpdir(), 'decal-attach-'));
let cases;
try {
  const modelPath = path.join(scratch, 'model.json');
  await writeFile(modelPath, JSON.stringify(decalModelJson(mapName, map)));
  const started = performance.now();
  cases = JSON.parse(execFileSync(python, ['scripts/native-decal-cases.py', root, modelPath,
    ...(argv.includes('--compare') ? ['--compare'] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 }));
  console.log(`oracle: ${cases.request.scenarios.length} scenarios in ${((performance.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const counts = { scenarios: 0, ops: 0, attaches: 0, attached: 0, decals: 0, neighbours: 0, boundaries: 0, exits: {} };
for (const [index, scenario] of cases.request.scenarios.entries()) {
  const reference = cases.results0x037f[index];
  assert.equal(reference.name, scenario.name);
  assert.ok(!reference.error, `${scenario.name}: oracle error ${reference.error}`);
  const surfaceFlags = scenario.surfaceFlags
    ? Object.fromEntries(Object.entries(scenario.surfaceFlags).map(([k, v]) => [Number(k), v])) : null;
  const movers = new Set(Object.entries(scenario.surfaceActors ?? {})
    .filter(([, actor]) => /mover/i.test(actor.class)).map(([k]) => Number(k)));
  const decalModel = uploadDecalModel(kernel, map.model, { surfaceFlags, isMover: s => movers.has(s) });
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
        let out;
        try {
          out = store.attach({ actor: actor.id, location, rotation: op.rotation, traceDistance: Math.fround(op.args[0]),
            decalDir: (op.args[1] ?? [0, 0, 0]).map(Math.fround), drawScale, uSize: op.texture.USize, level,
            texture: actor.texture, surfList: actor.surfList }, {
            rand: () => { if (!rands.length) throw new Error(`${where}: rand() beyond the recorded values`); return rands.shift(); },
            textureOf: id => [...actors.values()].find(a => a.id === id)?.texture ?? 0,
          });
        } catch (error) {
          // The Mover branch (MoverRotation, AActor::SetBase) is a labelled
          // boundary: no shipped level surface belongs to a Mover.
          if (error instanceof DecalKernelFault && error.fault === 6 && movers.size) {
            assert.ok(expected.events.some(event => event.op === 'SetBase'), `${where}: the original reached SetBase`);
            counts.boundaries++;
            break;
          }
          throw error;
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
const exits = Object.entries(counts.exits).map(([exit, n]) => `${exit} ${n}`).join(', ');
console.log(`validate-decal-attach: ${mapName}: ${counts.scenarios} scenarios, ${counts.ops} operations, ` +
  `${counts.attaches} AttachDecal calls (${exits}), ${counts.neighbours} neighbour FDecals, ` +
  `${counts.boundaries} Mover boundary as designed; every FDecal list bit-equal to the original; PASS`);
if (Object.keys(cases.controlWordComparison ?? {}).length)
  console.log(`control words: ${JSON.stringify(cases.controlWordComparison)}`);
