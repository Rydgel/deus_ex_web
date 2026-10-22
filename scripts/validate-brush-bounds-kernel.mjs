/** The Rust twin of a brush's world bounds (native/script-vm/src/bounds.rs, docs/rotating-brushes.md "Rust twin") against its JavaScript reference
 * (src/runtime/brush-bounds.mjs brushCollisionBoundsReference), bit for bit, and against the original.
 *
 *   1  real brushes: every mover of the chosen maps (default: the Training pair, Island, Paris club, 09_NYC_ShipFan, Hong Kong market, Vandenberg command),
 *      at its stored pose, at KeyPos/KeyRot fractions, and under seeded random rotations (any int32, unnormalized included), shears and scales: all six numbers
 *      equal by Object.is;
 *   2  seeded random records (25,000 by default): Location and PrePivot over several magnitudes, any int32 Rotation, scales positive/negative/tiny/huge/zero,
 *      shear axes 0..7 and rates around every ShearSnap threshold, model boxes of every shape (degenerate and empty ones included). A case the reference throws on
 *      must be handed back (undefined); one the kernel answers must equal the reference by Object.is, signed zeros included;
 *   3  the original: validate-native-bounds.mjs compares the same function with the original's UModel::GetCollisionBoundingBox (run it with and without TRACE_KERNEL=js).
 *
 *   node scripts/validate-brush-bounds-kernel.mjs [--maps A,B] [--random N] [--seed S] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
import { brushCollisionBoundsReference } from '../src/runtime/brush-bounds.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const kernel = await loadTraceKernel();
if (!kernel) { console.log('SKIP validate-brush-bounds-kernel: the kernel is not loaded (TRACE_KERNEL=js)'); process.exit(0); }
let root;
try { root = gameDirectory(); } catch { root = null; }
const prng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rand = prng(Number(option('seed', 0xb0d5)));
const f = Math.fround;
// Negative control: the kernel's x87 precision control at 24 bits instead of the 64 the game thread uses must be caught by the comparison.
if (process.argv.includes('--mutate-precision')) kernel.x.set_x87_precision(24);
const stats = { compared: 0, handedBack: 0, throwing: 0, real: 0, random: 0, signedZero: 0 };

function compare(label, model, owner) {
  let expected = null, thrown = null;
  try { expected = brushCollisionBoundsReference(model, owner); } catch (error) { thrown = error; }
  const got = kernel.brushBounds(model, owner);
  if (thrown) {
    stats.throwing++;
    assert.equal(got, undefined, `${label}: the reference throws (${thrown.message}) where the kernel answers ${JSON.stringify(got)}\n${JSON.stringify({ bounds: model.bounds, owner })}`);
    return;
  }
  if (got === undefined) { stats.handedBack++; return; }
  stats.compared++;
  for (const key of ['min', 'max'])
    for (let k = 0; k < 3; k++) {
      if (Object.is(got[key][k], expected[key][k])) { if (Object.is(got[key][k], -0)) stats.signedZero++; continue; }
      assert.fail(`${label}: ${key}[${k}] kernel ${got[key][k]} (${Object.is(got[key][k], -0) ? '-0' : ''}) reference ${expected[key][k]}\n${JSON.stringify({ bounds: model.bounds, owner })}`);
    }
  assert.equal(got.valid, expected.valid);
  assert.deepEqual(Object.keys(got), Object.keys(expected));
}

// ---- 1. real brushes -----------------------------------------------------------------------------------------------------------------------------
if (root) {
  const files = [];
  for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
  const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
  const maps = option('maps', '00_Training,01_NYC_UNATCOIsland,10_Paris_Club,09_NYC_ShipFan,06_HongKong_WanChai_Market,12_Vandenberg_Cmd').split(',');
  const anyInt = () => (rand() * 4294967296 | 0);
  for (const name of maps) {
    const asset = await assets.get(name), map = decodeMap(asset.bytes);
    let movers = 0;
    for (const actor of map.actors) {
      const values = await defaults.forActor(asset, actor);
      if (!values.bIsMover || !(values.Brush > 0)) continue;
      movers++;
      const model = readModel(asset.pkg, asset.bytes, values.Brush);
      const base = (values.Rotation ?? [0, 0, 0]);
      const poses = [values];
      for (const fraction of [.25, .5, 1]) poses.push({ ...values,
        Location: values.Location.map((v, i) => f(v + (values['KeyPos[1]']?.[i] ?? 0) * fraction)),
        Rotation: base.map((v, i) => (v + (values['KeyRot[1]']?.[i] ?? 0) * fraction) | 0) });
      for (let k = 0; k < 6; k++) poses.push({ ...values, Rotation: [anyInt(), anyInt(), anyInt()] });
      for (let k = 0; k < 3; k++) poses.push({ ...values, Rotation: base.map(v => (v + ((rand() * 131072) | 0) - 65536) | 0), Location: values.Location.map(v => f(v + (rand() - .5) * 4096)) });
      for (const axis of [1, 2, 3, 4, 5, 6]) poses.push({ ...values, MainScale: { scale: [f(.5 + rand()), f(.5 + rand()), f(.5 + rand())], shearAxis: axis, shearRate: f((rand() - .5) * 2) },
        PostScale: { scale: [f(.5 + rand() * 2), f(.5 + rand()), f(.5 + rand())], shearAxis: 7 - axis, shearRate: f((rand() - .5) * 2) } });
      poses.forEach((owner, k) => { compare(`${name}/${actor.name}/${k}`, model, owner); stats.real++; });
    }
    console.log(`${name}: ${movers} movers`);
  }
} else console.log('no installed game data: the real brushes are skipped');

// ---- 2. random records ---------------------------------------------------------------------------------------------------------------------------
const magnitude = () => [1e-3, 1, 100, 4096, 32768, 1e6][(rand() * 6) | 0];
const number = () => { const r = rand(); return r < .05 ? 0 : (rand() - .5) * 2 * magnitude(); };
const triple = () => [number(), number(), number()];
const scaleRecord = () => {
  const r = rand();
  if (r < .15) return undefined;
  const pick = () => { const q = rand(); return q < .08 ? 0 : q < .16 ? f(1e-30) : q < .24 ? f(1e30) : q < .4 ? -f(.25 + rand() * 4) : f(.25 + rand() * 4); };
  return { scale: [pick(), pick(), pick()], shearAxis: (rand() * 8) | 0, shearRate: [-.7, -.6, -.55, -.5, -.05, 0, .05, .55, .6, .7, (rand() - .5) * 3][(rand() * 11) | 0] };
};
const boundsRecord = () => {
  const a = triple().map(f), b = rand() < .1 ? a.slice() : triple().map(f);
  return { min: a.map((v, i) => Math.min(v, b[i])), max: a.map((v, i) => Math.max(v, b[i])), valid: true };
};
const N = Number(option('random', 25000));
for (let n = 0; n < N; n++) {
  const owner = {};
  if (rand() > .1) owner.Location = triple();
  if (rand() > .1) owner.Rotation = [(rand() * 4294967296) | 0, (rand() * 4294967296) | 0, (rand() * 4294967296) | 0].map(v => rand() < .3 ? [0, 16384, 32768, -16384, 8192, 49152][(rand() * 6) | 0] : v);
  if (rand() > .5) owner.PrePivot = triple();
  const post = scaleRecord(), main = scaleRecord();
  if (post !== undefined) owner.PostScale = post;
  if (main !== undefined) owner.MainScale = main;
  compare(`random ${n}`, { bounds: boundsRecord() }, owner);
  stats.random++;
}
// A few records the kernel must refuse on its own: non-numbers, a non-integer rotation, a missing triple.
for (const owner of [{ Rotation: [0.5, 0, 0] }, { Location: [1, 2] }, { Location: [NaN, 0, 0] }, { MainScale: null }, { PostScale: { scale: [1, 1] } }, { Rotation: [2 ** 31, 0, 0] }, { PrePivot: ['1', 0, 0] }])
  assert.equal(kernel.brushBounds({ bounds: { min: [0, 0, 0], max: [1, 1, 1], valid: true } }, owner), undefined, `refused: ${JSON.stringify(owner)}`);
console.log(JSON.stringify({ ok: true, ...stats, kernelAnswers: kernel.stats.bounds, kernelHandedBack: kernel.stats.boundsFallback }));
assert.ok(stats.compared > N / 2, 'most random records are answered by the kernel');
