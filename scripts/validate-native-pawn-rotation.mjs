// APawn::physicsRotation (Engine.dll 0x103c9f30) against the original's unchanged body (native-pawn-rotation-oracle.py):
// the motion word afterwards and the NewRotation of the MoveActor it ends with. Cases: raw map rotations that are not
// canonical (Pitch -4, Yaw -32404 as 06_HongKong_WanChai_Underworld's Hooker0), Rotation already equal to DesiredRotation
// with a nonzero Pitch, one axis equal and the other not, every Physics mode, Pawn / ScriptedPawn-like / PlayerPawn /
// non-Pawn class chains, wrap-around and half-turn boundaries, large rates, and a random sweep.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pawnRotationStep } from '../src/runtime/script-pawn-physics.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [];
const add = changes => cases.push({ class: 'script', physics: 2, rotation: [0, 0, 0], desiredRotation: [0, 0, 0], rotationRate: [4096, 50000, 3072],
  motion: 0, dt: f(1 / 60), ...changes });
let seed = 0x7a31c0de;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const dts = [0, .005, 1 / 120, 1 / 60, 1 / 30, .1, .2, .4].map(f);
// The pilot's case: Rotation == DesiredRotation, raw and non-canonical.
for (const physics of [0, 1, 2, 3, 4, 5, 8]) for (const klass of ['script', 'pawn', 'player', 'other']) {
  add({ class: klass, physics, rotation: [-4, -32404, 0], desiredRotation: [-4, -32404, 0] });
  add({ class: klass, physics, rotation: [-4, -32404, 7], desiredRotation: [-4, -32404, 0] });
  add({ class: klass, physics, rotation: [1000, 2000, 0], desiredRotation: [1000, 2000, 0] });
  add({ class: klass, physics, rotation: [0, 70000, 0], desiredRotation: [0, 70000, 0] });
}
// One axis equal, the other not (the skipped step of the equal one).
for (const physics of [1, 2, 4]) for (const klass of ['script', 'player']) {
  add({ class: klass, physics, rotation: [300, 1000, 0], desiredRotation: [300, 5000, 0] });
  add({ class: klass, physics, rotation: [300, 1000, 0], desiredRotation: [900, 1000, 0] });
  add({ class: klass, physics, rotation: [-300, 1000, 0], desiredRotation: [-300, 1000, 5] });
  add({ class: klass, physics, rotation: [-4, -32404, 0], desiredRotation: [-4, 33132, 0] });
  add({ class: klass, physics, rotation: [-4, -32404, 0], desiredRotation: [0, -32404, 0] });
}
// Wrap-around and half-turn boundaries of fixRotation on both axes.
for (const [current, target] of [[65000, 500], [500, 65000], [0, 32768], [32768, 0], [0, 32767], [32767, 0], [100, 32868], [32868, 100],
  [-1, 1], [65535, 0], [70000, 4464], [4464, 70000], [-16384, 49152], [12345, 12345 + 65536], [-65536, 3]]) {
  for (const rate of [0, 1, 90, 4096, 32767, 32768, 65535, -1, 400000]) for (const physics of [1, 2, 4]) {
    add({ physics, rotation: [current, current, 0], desiredRotation: [target, target, 0], rotationRate: [rate, rate, 3072], dt: f(1 / 30) });
  }
}
// Pitch clamp: a rate below the step, the half-turn side.
for (const limit of [0, 1, 546, 4096, 16384, 32767, 32768, 65535]) for (const physics of [0, 2, 4])
  add({ physics, rotation: [60000, 0, 0], desiredRotation: [20000, 0, 0], rotationRate: [limit, 0, 0], dt: f(.4) });
// Random sweep.
for (let i = 0; i < 700; i++) {
  const equalYaw = random() < .3, equalPitch = random() < .3, raw = () => (random() < .5 ? int(-70000, 140000) : int(0, 65535));
  const rotation = [raw(), raw(), random() < .8 ? 0 : int(-5000, 5000)];
  add({ class: ['script', 'script', 'pawn', 'player', 'other'][i % 5], physics: [1, 2, 3, 4, 5, 0, 8][i % 7], rotation,
    desiredRotation: [equalPitch ? rotation[0] : raw(), equalYaw ? rotation[1] : raw(), random() < .8 ? 0 : int(-5000, 5000)],
    rotationRate: [int(-3000, 70000), int(-125000, 125000), int(-5000, 5000)], motion: [0, 0x20, 0x40, 0x60, 0x100][i % 5],
    dt: i < 80 ? dts[i % 8] : f(random() * .4) });
}
const directory = path.resolve('reports/movement/native-pawn-rotation');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-pawn-rotation-oracle.py', import.meta.url)), gameDirectory(), casesFile], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
const run = c => {
  const step = pawnRotationStep({ rotation: c.rotation, desiredRotation: c.desiredRotation, rotationRate: c.rotationRate, physics: c.physics, motionFlags: c.motion },
    c.dt, { playerPawn: c.class === 'player', pawn: c.class !== 'other' });
  return { motion: step.motionFlags, events: step.rotation ? [{ moveActor: { delta: [0, 0, 0], rotation: step.rotation } }] : [] };
};
cases.forEach((c, i) => { const actual = run(c); if (JSON.stringify(actual) !== JSON.stringify(native.results[i])) mismatches.push({ i, case: c, actual, expected: native.results[i] }); });
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ cases: cases.length, mismatches }, null, 1));
console.log(JSON.stringify({ binaryHashes: native.hashes, cases: cases.length, mismatchCount: mismatches.length, first: mismatches.slice(0, 3) }, null, 1));
assert.equal(mismatches.length, 0, 'APawn::physicsRotation agrees with the original for all cases');
