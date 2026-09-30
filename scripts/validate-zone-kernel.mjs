/**
 * R3-e (docs/rust-core.md): the Rust PointRegion (native/script-vm/src/
 * zone.rs `point_region`, through `zone_test_point`) against zone.mjs
 * `pointRegion` on the 00_Training and 01_NYC_UNATCOIsland BSPs and on
 * synthetic models: the zone (by handle), leaf and zone number, and the
 * error cases (an invalid child, a cycle), for seeded points around the
 * map's actors, points on node planes, points far outside, and specials.
 * Zone lists include missing entries (pointRegion's `||` fallback), short
 * lists and none. The live calls are checked by ZONE_DIFFERENTIAL=1.
 *
 *   node scripts/validate-zone-kernel.mjs [--scale 1]
 */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {pointRegion} from '../src/runtime/zone.mjs';
import {compileScriptVm} from '../src/runtime/script-vm-kernel.mjs';
import {handleOf} from '../src/runtime/script-object-handles.mjs';
import {zoneModelSize, writeZoneModel} from '../src/runtime/zone-kernel.mjs';
import {gameDirectory} from './game-directory.mjs';

const scaleArg = process.argv.indexOf('--scale');
const SCALE = scaleArg < 0 ? 1 : Number(process.argv[scaleArg + 1]);
const f = Math.fround;

// ZONE_KERNEL_WASM=path: a separately built module (mutation runs).
const module = process.env.ZONE_KERNEL_WASM ? await WebAssembly.compile(await readFile(process.env.ZONE_KERNEL_WASM))
  : await compileScriptVm();
const memory = new WebAssembly.Memory({initial: 64});
const imports = {memory};
for (const {module: from, name, kind} of WebAssembly.Module.imports(module))
  if (from === 'env' && kind === 'function') imports[name] = () => { throw new Error(`unexpected import ${name}`); };
const x = (await WebAssembly.instantiate(module, {env: imports})).exports;
const heap = (x.__heap_base.value + 15) & ~15;
const io = () => new Uint32Array(memory.buffer, x.zone_io_ptr(), 20);
const f32io = new DataView(new ArrayBuffer(4));
const bits = v => (f32io.setFloat32(0, v, true), f32io.getUint32(0, true));

/** The model at `heap` for a source, growing memory as needed. */
function upload(source) {
  const size = zoneModelSize(source), need = heap + size - memory.buffer.byteLength;
  if (need > 0) memory.grow(Math.ceil(need / 65536));
  return writeZoneModel(new DataView(memory.buffer), heap, source) ? heap : 0;
}

let seed = 0x20e0c0de;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const counts = {points: 0, errors: 0, fallback: 0, onPlane: 0, nearOblique: 0};
/** `v` moved by `steps` float32 units in the last place. */
function nudge(v, steps) {
  if (!Number.isFinite(v) || steps === 0) return v;
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, v, true);
  let b = buffer.getInt32(0, true);
  b = v === 0 ? (steps > 0 ? steps : 0x80000000 | -steps) : b + (v > 0 ? steps : -steps);
  buffer.setInt32(0, b, true);
  return buffer.getFloat32(0, true);
}

function check(source, model, point, where) {
  let expected;
  try {
    const r = pointRegion(source.model, point, source.levelInfo, source.zoneActors);
    expected = {zone: handleOf(r.zone), leaf: r.leaf, number: r.zoneNumber};
    if (r.zone === source.levelInfo) counts.fallback++;
  } catch { expected = null; }
  const w = io();
  w[2] = model; w[16] = bits(point[0]); w[17] = bits(point[1]); w[18] = bits(point[2]);
  x.zone_test_point();
  const r = io(), actual = r[19] ? {zone: r[16], leaf: r[17] | 0, number: r[18]} : null;
  counts.points++;
  if (!expected) counts.errors++;
  const same = expected === null ? actual === null
    : actual !== null && actual.zone === expected.zone && actual.leaf === expected.leaf && actual.number === expected.number;
  if (!same) throw new Error(`${where} at ${point}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}

/** Zone lists: every zone, some missing, a short list, none. */
function zoneLists(model, name) {
  const all = model.zones.map((_, i) => ({name: `${name} zone ${i}`}));
  return [all, all.map((zone, i) => i % 3 === 1 ? null : zone), all.slice(0, Math.max(1, all.length >> 1)), []];
}

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const map = decodeMap((await assets.get(name)).bytes), bsp = map.model;
  const anchors = map.actors.map(actor => actor.values.Location).filter(v => Array.isArray(v) && v.length === 3).map(v => v.map(f));
  const levelInfo = {name: `${name} LevelInfo`};
  const oblique = bsp.nodes.filter(node => node.plane.slice(0, 3).filter(v => v !== 0).length > 1);
  for (const zoneActors of zoneLists(bsp, name)) {
    const source = {model: bsp, levelInfo, zoneActors}, model = upload(source);
    if (!model) throw new Error(`${name}: the model does not fit the zone block`);
    const n = Math.round(60_000 * SCALE);
    for (let i = 0; i < n; i++) {
      const r = random();
      let point;
      if (r < 0.6) {
        const a = anchors[Math.floor(random() * anchors.length)], spread = [4, 64, 512, 4096][Math.floor(random() * 4)];
        point = a.map(v => f(v + (random() * 2 - 1) * spread));
      } else if (r < 0.85) {
        // On a node's plane: the point of the plane nearest a random anchor.
        const node = bsp.nodes[Math.floor(random() * bsp.nodes.length)], [nx, ny, nz, w] = node.plane;
        const a = anchors[Math.floor(random() * anchors.length)];
        const d = a[0] * nx + a[1] * ny + a[2] * nz - w;
        point = [f(a[0] - d * nx), f(a[1] - d * ny), f(a[2] - d * nz)];
        counts.onPlane++;
      } else if (r < 0.9) {
        // Within a float32 step of an oblique plane, where the summation
        // order of the side test decides the side.
        const node = oblique[Math.floor(random() * oblique.length)], [nx, ny, nz, w] = node.plane;
        const a = anchors[Math.floor(random() * anchors.length)].map(v => f(v + (random() * 2 - 1) * 256));
        const d = a[0] * nx + a[1] * ny + a[2] * nz - w;
        point = [f(a[0] - d * nx), f(a[1] - d * ny), f(a[2] - d * nz)].map(v => nudge(v, Math.floor(random() * 5) - 2));
        counts.nearOblique++;
      } else if (r < 0.95) {
        point = [f((random() * 2 - 1) * 1e5), f((random() * 2 - 1) * 1e5), f((random() * 2 - 1) * 1e5)];
      } else {
        const specials = [0, -0, NaN, Infinity, -Infinity, 3.4e38, -3.4e38, 1e-45];
        point = [0, 1, 2].map(() => specials[Math.floor(random() * specials.length)]);
      }
      check(source, model, point, name);
    }
  }
}

// Synthetic models: no nodes, an invalid child, a cycle, and zone numbers
// beyond the list.
const plane = [0, 0, 1, 0];
const node = (front, back, zones = [0, 0], leaves = [3, 4]) => ({plane, front, back, zones, leaves});
const levelInfo = {name: 'synthetic LevelInfo'}, zone = {name: 'synthetic zone'};
for (const [label, nodes] of [
  ['empty', []],
  ['leaf', [node(-1, -1, [1, 7], [5, -1])]],
  ['invalid child', [node(5, -1)]],
  ['negative child', [node(-2, -1)]],
  ['cycle', [node(1, 1), node(0, 0)]],
  ['deep', [node(1, -1), node(2, -1), node(-1, -1, [2, 1], [9, 8])]],
]) {
  for (const zoneActors of [[], [zone], [null, zone, zone]]) {
    const source = {model: {nodes, zones: []}, levelInfo, zoneActors}, model = upload(source);
    for (const z of [-1, 0, -0, 1, NaN]) check(source, model, [0, 0, z], `synthetic ${label}`);
  }
}

console.log(`validate-zone-kernel: identical to zone.mjs pointRegion: ${JSON.stringify(counts)}`);
