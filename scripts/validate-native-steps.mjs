import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { twoWallAdjust, safeNormal, stepUp } from '../src/runtime/steps.mjs';
import { gameDirectory } from './game-directory.mjs';

const cases = [], f = Math.fround;
const addCase = (delta, normal, oldNormal, time, desired = safeNormal(delta)) => {
  cases.push({ delta: delta.map(f), normal: normal.map(f), oldNormal: oldNormal.map(f), time: f(time), desired: desired.map(f) });
};
const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [.6, .8, 0], [-.6, .8, 0], [0, .6, .8]];
for (const normal of normals) for (const old of normals) for (const time of [0, .125, .3, .9, 1]) {
  for (const delta of [[4, 2, 0], [2, -4, -1], [0, 0, 0]]) addCase(delta, normal, old, time);
}
// Nearly opposite normals exercise SafeNormal's squared-length threshold.
for (const epsilon of [.000099, .0001, .000101]) addCase([1, 2, 3], [1, 0, 0], safeNormal([-1, epsilon, 0]), .25);
let seed = 9281;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = () => Array.from({ length: 3 }, () => f(random() * 2 - 1));
for (let i = 0; i < 400; i++) addCase(vector().map(v => f(v * 128)), safeNormal(vector()), safeNormal(vector()), random(), safeNormal(vector()));
const twoWallCases = cases.length;
const clear = { time: 1, normal: [0, 0, 0] };
const response = (time, normal, extra = {}) => ({ time: f(time), normal: normal.map(f), ...extra });
const addStep = (delta, responses, changes = {}) => cases.push({ type: 'step', delta: delta.map(f),
  gravity: [0, 0, -1], desired: safeNormal(delta), maxStepHeight: 25,
  isPlayer: true, physics: 1, mass: 150, velocity: [320, -70, 0],
  responses: [...responses, ...Array.from({ length: 20 }, () => clear)], wallPhysics: Array(20).fill(1), ...changes });
addStep([4, 2, 0], [clear, clear, response(.4, [0, 0, 1])]);
// A blocked upward move does not suppress the subsequent horizontal attempt.
addStep([4, 2, 0], [response(0, [0, 0, -1]), clear, response(0, [0, 0, 1])]);
// Recursion boundary is Delta.SizeSquared() * Hit.Time > 144.
for (const distance of [16, Math.sqrt(288), 20]) for (const z of [0, .19999, .2, -.2]) {
  addStep([distance, 0, 0], [clear, response(.5, [-Math.sqrt(1 - z * z), 0, z]), clear, clear, response(.4, [0, 0, 1])]);
}
for (const time of [.249999, .25, .250001]) addStep([24, 0, 0], [clear, response(time, [-1, 0, 0]), clear, clear, response(.4, [0, 0, 1])]);
for (const secondNormal of normals) for (const wallPhysics of [Array(20).fill(1), Array(20).fill(2)]) {
  addStep([4, 2, 1], [clear, response(.2, [-1, 0, 0]), response(.3, secondNormal), clear, response(.4, [0, 0, 1])], { wallPhysics });
}
for (const z of [.49999, .5, .50001, 0, -.5]) addStep([4, 2, 0], [clear, clear, response(.3, safeNormal([Math.sqrt(1 - z * z), 0, z]))]);
for (const isPlayer of [true, false]) for (const mass of [20, 100, 1000]) for (const wallPhysics of [Array(20).fill(1), Array(20).fill(2)]) {
  addStep([4, 0, 0], [clear, response(.2, [-1, 0, 0], { pushableDecoration: true, mass }), response(.4, [0, 0, 1])], { isPlayer, wallPhysics });
}
for (let i = 0; i < 300; i++) {
  const responses = Array.from({ length: 12 }, () => random() < .35 ? clear : response(random(), safeNormal(vector())));
  addStep(vector().map(v => f(v * 64)), responses, { gravity: [0, 0, i % 2 ? -1 : 1], desired: safeNormal(vector()), maxStepHeight: f(10 + random() * 30) });
}

function runStep(input) {
  const events = [], pawn = { ...input, hitWall(hit) { events.push({ wall: [...hit.normal] }); pawn.physics = input.wallPhysics[wall++]; },
    move(delta) {
      events.push({ move: [...delta] });
      const r = input.responses[index++];
      if (!r) throw new Error('Missing explicit MoveActor response');
      return { time: r.time, normal: [...r.normal], actor: { pushableDecoration: r.pushableDecoration, mass: r.mass } };
    } };
  let index = 0, wall = 0;
  const hit = stepUp(pawn, input.gravity, input.desired, input.delta);
  return { events, physics: pawn.physics, velocity: pawn.velocity,
    justTeleported: pawn.justTeleported ?? false, hit: { time: hit.time, normal: hit.normal } };
}
const directory = path.resolve('reports/movement/native-steps');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-steps-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxError = 0;
function compare(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    maxError = Math.max(maxError, Math.abs(actual - expected));
    return Object.is(actual, expected);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => compare(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const comparisons = cases.map((input, i) => {
  const actual = input.type === 'step' ? runStep(input) : twoWallAdjust(input), expected = native.results[i];
  if (!compare(actual, expected)) mismatches.push({ index: i });
  return { input, actual, expected };
});
const summary = { binaryHashes: native.hashes, cases: cases.length, twoWallCases, stepCases: cases.length - twoWallCases,
  stepScope: 'original stepUp with controlled MoveActor and processHitWall callbacks; world/events are not under test',
  comparison: 'exact float32 components, including signed zero, and callback sequence', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'corner/stair routines agree with originals for all sampled cases');
