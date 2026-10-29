/** The Rust core's x87 tails of five JavaScript callers (native/script-vm/src/callers.rs, docs/live-heap.md "Cut: x87 math in
 * Rust") against the BigInt bodies they replace: actor-physics.mjs interpolationVelocity, script-pawn-locomotion.mjs
 * fcoordsAxes, script-pawn-perception.mjs losWorker's sums and products (losReference), move-riders.mjs' rider RotMotion and
 * delta. Random and special float32 words (zeros of both signs, denormals, the largest finite, infinities, NaNs) and rotations
 * over the whole int32 range go to both; the results are compared as float32 words. A NaN matches a NaN: the reference returns
 * its values as JavaScript numbers in an Array, where V8 may canonicalize a NaN's payload (docs/rust-core.md R2b-6). A case on
 * which the BigInt body throws (it cannot take a NaN in an operand it indexes) is counted, not compared.
 *
 *   node scripts/validate-x87-callers-kernel.mjs [--cases N] [--seed S]
 */
import assert from 'node:assert/strict';
import {loadScriptVmKernel, scriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {interpolationVelocityReference} from '../src/runtime/actor-physics.mjs';
import {fcoordsAxesReference} from '../src/runtime/script-pawn-locomotion.mjs';
import {losReference} from '../src/runtime/script-pawn-perception.mjs';
import {riderRotMotionReference, riderDeltaReference} from '../src/runtime/move-riders.mjs';
import {rng} from './galaxy-audio-cases.mjs';

await loadScriptVmKernel();
const kernel = scriptVmKernel;
for (const name of ['interpolationVelocity', 'fcoordsAxes', 'los', 'riders']) assert.ok(kernel[name], `the script VM kernel has no ${name} (npm run build:wasm)`);
const option = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : Number(process.argv[i + 1]); };
const cases = option('cases', 60000);
const random = rng(option('seed', 0x87ca11e5));
const pick = list => list[Math.floor(random() * list.length)];

const view = new DataView(new ArrayBuffer(4));
const bits = v => (view.setFloat32(0, v, true), view.getUint32(0, true));
const number = word => (view.setUint32(0, word >>> 0, true), view.getFloat32(0, true));
const SPECIAL = [0, 0x80000000, 0x3f800000, 0xbf800000, 1, 0x807fffff, 0x007fffff, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000,
  0x7fc00000, 0xffc00000, 0x7f800001, 0x3c23d70a, 0x42c80000, 0x38d1b717, 0x4b189680];
// Mostly finite values of the magnitudes the game holds (a Location, a velocity, a unit vector), some anything.
const value = () => {
  const r = random();
  if (r < 0.12) return number(pick(SPECIAL));
  if (r < 0.2) return number((random() * 2 ** 32) >>> 0);
  return Math.fround((random() - 0.5) * pick([2, 200, 20000, 2e6, 2e9, 1e-6, 1e-20]));
};
const finiteValue = () => { let v; do v = value(); while (!Number.isFinite(v)); return v; };
const vec = () => [value(), value(), value()];
const rotation = () => [pick([0, 0x4000, -0x4000, 65535, 2 ** 31 - 1, -(2 ** 31), (random() * 2 ** 32) | 0]),
  pick([0, 0x4000, -0x4000, 65535, (random() * 2 ** 32) | 0, (random() * 65536) | 0]), (random() * 2 ** 32) | 0];

const same = (a, b) => (a !== a && b !== b) || bits(a) === bits(b);
let compared = 0, thrown = 0, mismatches = 0;
const check = (name, input, reference, actual) => {
  let expected;
  try { expected = reference(); } catch { thrown++; return; }
  const got = actual();
  const list = x => (Array.isArray(x) ? x.flat() : [x]);
  const e = list(expected), g = list(got);
  compared++;
  if (e.length !== g.length || e.some((v, i) => !same(v, g[i]))) {
    if (++mismatches <= 6) console.log(JSON.stringify({name, input: input.map?.(v => v.toString?.(16) ?? v) ?? input, expected: e.map(bits).map(w => w.toString(16)),
      actual: g.map(bits).map(w => w.toString(16))}));
  }
};

for (let i = 0; i < cases; i++) {
  const seconds = pick([value(), Math.fround(1 / 60), Math.fround(0.0166), 1, 1e-9, 0]);
  const location = vec(), old = pick([vec(), location, vec()]);
  check('interpolationVelocity', [location, old, seconds], () => interpolationVelocityReference(location, old, seconds),
    () => kernel.interpolationVelocity(location, old, seconds));
  const r = rotation();
  check('fcoordsAxes', r, () => fcoordsAxesReference(r), () => kernel.fcoordsAxes(r));
  const a = vec(), b = vec(), c = vec();
  check('los.magsq3', a, () => losReference.magsq3(a), () => kernel.los.magsq3(a));
  const p = pick([value(), Math.min((Math.floor(random() * 256) + 16) * 0.015, 1), Math.fround(random())]);
  check('los.squareProduct', [p, b[0]], () => losReference.squareProduct(p, b[0]), () => kernel.los.squareProduct(p, b[0]));
  check('square', [a[0]], () => losReference.squareProduct(a[0], 1), () => kernel.square(a[0]));
  check('los.stimulus', [a, b, c[0]], () => losReference.stimulus(a, b, c[0]), () => kernel.los.stimulus(a, b, c[0]));
  const finite = [finiteValue(), finiteValue(), finiteValue()], pv = Math.fround(random() * 2 - 1);
  const unit = pick([b, finite.map(v => Math.fround(v / (1 + Math.hypot(...finite))))]);
  check('los.stimulus finite', [finite, unit, pv], () => losReference.stimulus(finite, unit, pv), () => kernel.los.stimulus(finite, unit, pv));
  const d = [value(), value(), Math.fround(Math.floor(random() * 6) + 1), value()];
  check('los.scaled', d, () => losReference.scaled(...d), () => kernel.los.scaled(...d));
  const yaw = pick([0, 0x4000, -0x4000, 65532, (random() * 2 ** 32) | 0, ((random() * 65536) | 0) - 32768]);
  check('riders.rotMotion', [a, b, yaw], () => riderRotMotionReference(a, b, yaw), () => kernel.riders.rotMotion(a, b, yaw));
  check('riders.delta', [a, b], () => riderDeltaReference(a, b), () => kernel.riders.delta(a, b));
}
// The calls above never alias the kernel's result: each returns a fresh array.
const first = kernel.interpolationVelocity([1, 2, 3], [0, 0, 0], 0.5), second = kernel.interpolationVelocity([4, 5, 6], [0, 0, 0], 0.5);
assert.notEqual(first, second);
assert.deepEqual(first, [2, 4, 6]);
console.log(JSON.stringify({cases, compared, thrown, mismatches}));
if (mismatches) process.exitCode = 1;
else if (!compared) throw new Error('nothing compared');
