import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { performPhysicsTail, physicsRotationGate } from '../src/runtime/actor-rotation.mjs';
import { setScriptRotation } from '../src/runtime/script-set-rotation.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [];
const add = changes => cases.push({ rotation: [0, 0, 0], rotationRate: [0, 0, 0], desiredRotation: [0, 0, 0], fixed: false,
  toDesired: false, dt: f(1 / 60), movable: true, static: false, probing: null, pendingTouch: 0, physics: 0, ...changes });
let seed = 0x5eed1234;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const anyInt = () => int(-0x80000000, 0x7fffffff);
const dts = [0, .005, 1 / 120, 1 / 60, 1 / 30, .1, .2, .4].map(f);
// Fragment spin (Flying.BeginState: RandSpin(125000), |Pitch|,|Roll| >= 10000,
// bFixedRotationDir): continue in the rate's direction every tick.
for (let i = 0; i < 120; i++) {
  const spin = () => int(-125000, 125000), atLeast = v => (v > -10000 && v < 10000 ? 10000 : v);
  add({ fixed: true, rotationRate: [atLeast(spin()), spin(), atLeast(spin())], rotation: [anyInt(), int(-70000, 70000), int(0, 65535)],
    desiredRotation: [int(0, 65535), int(0, 65535), int(0, 65535)], dt: i < 64 ? dts[i % 8] : f(random() * .4) });
}
// After the first HitWall: bRotateToDesired, bFixedRotationDir false, desired
// (0, FRand*65536, 0), RotationRate scaled by 0.75 per bounce (either sign).
for (let i = 0; i < 160; i++) {
  const scale = .75 ** int(1, 6), spin = () => Math.trunc(int(-125000, 125000) * scale);
  add({ toDesired: true, rotationRate: [spin(), spin(), spin()], rotation: [int(-70000, 70000), int(-70000, 140000), int(0, 65535)],
    desiredRotation: [0, int(0, 65536), 0], dt: i < 64 ? dts[i % 8] : f(random() * .4), probing: [null, true, false][i % 3] });
}
// Wrap-around and half-turn boundaries of fixedTurn, both flag combinations.
for (const [current, target] of [[65000, 500], [500, 65000], [0, 32768], [32768, 0], [0, 32767], [32767, 0], [100, 32868], [32868, 100],
  [-1, 1], [65535, 0], [70000, 4464], [4464, 70000], [-16384, 49152], [12345, 12345 + 65536]]) {
  for (const rate of [1, 90, 32767, 32768, 65535, -1, -90, -32768, -70000, 400000, -400000]) for (const fixed of [false, true]) {
    add({ toDesired: true, fixed, rotation: [current, current, current], desiredRotation: [target, target, target], rotationRate: [rate, rate, rate], dt: f(1 / 30) });
    add({ toDesired: true, fixed, rotation: [current, current, current], desiredRotation: [target, target, target], rotationRate: [rate, rate, rate], dt: f(.4) });
  }
}
// Neither flag (no rotation) and already-at-desired (early return, no event).
for (const dt of [f(1 / 60), f(.4)]) {
  add({ rotationRate: [5000, -7000, 9000], rotation: [1, 2, 3], dt });
  add({ toDesired: true, rotationRate: [5000, -7000, 9000], rotation: [1, 70000, -3], desiredRotation: [1, 70000, -3], dt });
  add({ toDesired: true, fixed: true, rotationRate: [5000, -7000, 9000], rotation: [1, 2, 3], desiredRotation: [1, 2, 3], dt });
}
// EndedRotation on arrival, with and without the probe bit; an unmovable or static
// actor's MoveActor refuses the rotation (and the arrival test then fails).
for (const probing of [null, true, false]) for (const movable of [true, false]) for (const isStatic of [false, true]) {
  add({ toDesired: true, rotationRate: [0, 60000, 0], rotation: [0, 1000, 0], desiredRotation: [0, 1500, 0], dt: f(.1), probing, movable, static: isStatic });
  add({ toDesired: true, fixed: true, rotationRate: [-60000, 0, 60000], rotation: [1000, 0, 1000], desiredRotation: [500, 0, 1500], dt: f(.1), probing, movable, static: isStatic });
}
// performPhysics gate: a RotationRate whose components all have a zero low word
// never reaches physicsRotation, even with both flags set.
for (const rate of [[65536, 0, 0], [0, -65536, 131072], [196608, -131072, 0], [65536, 1, 0], [0, 0, 65535], [-65536, 0, -1]]) {
  add({ toDesired: true, fixed: true, rotationRate: rate, rotation: [0, 0, 0], desiredRotation: [30000, 30000, 30000], dt: f(.1) });
}
// PendingTouch: one PostTouch per tick and a one-link unlink.
for (const pendingTouch of [1, 2]) for (const rate of [[0, 0, 0], [0, 20000, 0]]) {
  add({ fixed: true, rotationRate: rate, rotation: [0, 100, 0], dt: f(.05), pendingTouch });
}
// SecurityCamera-style PHYS_Rotating sweep: RotationRate (65535, 65535, 0),
// bRotateToDesired toward a swing target; the Physics switch does nothing for 5.
for (let i = 0; i < 60; i++) {
  const yaw = int(-40000, 100000), pitch = int(-8000, 8000);
  add({ physics: 5, toDesired: true, rotationRate: [65535, 65535, 0], rotation: [pitch, yaw, 0],
    desiredRotation: [int(-4096, 4096), yaw + int(-16384, 16384), i % 7 === 0 ? 0 : int(-10, 10)], dt: i < 32 ? dts[i % 8] : f(random() * .4), probing: [null, true, false][i % 3] });
}
// _ftol exactness: products of large int32 rates and float32 steps that exceed
// binary64 but not the x87 64-bit significand, and near-integer products.
for (const rate of [0x7fffffff, -0x80000000, 0x40000001, -0x3fffffff, 16777217, -16777215, 12345679, 1000001]) {
  for (const dt of [f(.4), f(.005), f(1 / 3), f(.1), f(.0999999940395355), f(1e-6)]) add({ fixed: true, rotationRate: [rate, -rate | 0, rate >> 3], rotation: [7, 8, 9], dt });
}
// Products whose exact value lies within 2^-25 below an integer: a binary64
// product rounds up across it and truncates one higher than the x87 product.
for (const [rate, dt] of [[671088635, .4], [1342177270, .4], [805306365, 1 / 3], [1610612730, 1 / 3], [738197499, .1],
  [1342177270, .1], [671088635, .2], [1342177270, .2], [796917765, .35], [1560281098, .35]]) {
  add({ fixed: true, rotationRate: [rate, rate, 0], rotation: [0, 12345, 0], dt: f(dt) });
}
for (let i = 0; i < 120; i++) add({ fixed: random() < .5, toDesired: random() < .7, rotationRate: [anyInt(), anyInt(), anyInt()],
  rotation: [anyInt(), anyInt(), anyInt()], desiredRotation: [anyInt(), anyInt(), anyInt()], dt: f(random() * .4) });

const directory = path.resolve('reports/movement/native-actor-rotation');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-actor-rotation-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);
await writeFile(path.join(directory, 'original.json'), JSON.stringify(native));

function run(input) {
  const events = [];
  const touches = [{ name: 'touch0', pendingTouch: null }, { name: 'touch1', pendingTouch: null }];
  const actor = { name: 'actor', rotation: [...input.rotation], rotationRate: [...input.rotationRate], desiredRotation: [...input.desiredRotation],
    bFixedRotationDir: input.fixed, bRotateToDesired: input.toDesired, pendingTouch: null };
  const chain = [actor, ...touches.slice(0, input.pendingTouch)];
  chain.forEach((link, index) => { link.pendingTouch = chain[index + 1] ?? null; });
  const values = { bStatic: input.static, bMovable: input.movable, StandingCount: 0, Brush: null };
  performPhysicsTail(actor, input.dt, {
    moveActor(delta, rotation) {
      events.push({ moveActor: { actor: 'actor', delta: [...delta], rotation: [...rotation] } });
      return setScriptRotation(actor, rotation, { levelFor: () => ({ editor: false }),
        read: (target, key) => (key === 'Rotation' ? target.rotation : values[key]),
        write: (target, key, value) => { assert.equal(key, 'Rotation'); target.rotation = value; } });
    },
    isProbing: name => { assert.equal(name, 'EndedRotation'); return input.probing !== false; },
    endedRotation() { events.push({ event: 'EndedRotation', target: 'actor' }); },
    postTouch(target, other) { events.push({ event: 'PostTouch', target: target.name, other: other.name }); },
  });
  return { rotation: actor.rotation, pendingTouch: [actor, ...touches].map(link => link.pendingTouch?.name ?? null), events };
}
let maxError = 0;
function same(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    maxError = Math.max(maxError, Math.abs(actual - expected)); return Object.is(actual, expected);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => same(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const mismatches = [], stats = { gated: 0, moves: 0, ended: 0, refused: 0, postTouch: 0 };
const comparisons = cases.map((input, index) => {
  const original = native.results[index];
  const reached = original.events.filter(event => 'physicsRotation' in event);
  // The gate and the DeltaTime handed to physicsRotation.
  assert.equal(reached.length, physicsRotationGate(input.rotationRate) ? 1 : 0, `case ${index}: performPhysics rotation gate`);
  reached.forEach(event => assert.ok(Object.is(event.physicsRotation, input.dt), `case ${index}: DeltaTime`));
  // Call-site constants of the MoveActor request (FCheckResult(1.0), four zero flags).
  for (const { moveActor } of original.events.filter(event => event.moveActor)) {
    assert.equal(moveActor.hitTime, 1); assert.deepEqual(moveActor.flags, [0, 0, 0, 0]);
  }
  for (const event of original.events.filter(event => event.event === 'EndedRotation')) assert.equal(event.parms, 0);
  const expected = { rotation: original.rotation, pendingTouch: original.pendingTouch,
    events: original.events.filter(event => !('physicsRotation' in event)).map(event => event.moveActor
      ? { moveActor: { actor: event.moveActor.actor, delta: event.moveActor.delta, rotation: event.moveActor.rotation } }
      : event.event === 'EndedRotation' ? { event: 'EndedRotation', target: event.target } : event) };
  const actual = run(input);
  if (!same(actual, expected)) mismatches.push(index);
  if (reached.length) stats.gated++;
  const moved = expected.events.filter(event => event.moveActor);
  stats.moves += moved.length;
  if (moved.length && expected.rotation.every((value, axis) => value === input.rotation[axis])) stats.refused++;
  stats.ended += expected.events.filter(event => event.event === 'EndedRotation').length;
  stats.postTouch += expected.events.filter(event => event.event === 'PostTouch').length;
  return { input, actual, expected };
});
const summary = { binaryHashes: native.hashes, cases: cases.length, stats,
  scope: 'original performPhysics tail (Physics None/Rotating): rotation gate, physicsRotation, fixedTurn, real MoveActor zero-delta short path, EndedRotation probe/event and PendingTouch PostTouch/unlink',
  comparison: 'exact int32 rotator components, MoveActor delta/rotation arguments, event order and PendingTouch links', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'actor rotation agrees with original performPhysics/physicsRotation for all sampled cases');
assert.equal(maxError, 0);
