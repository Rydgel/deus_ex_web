import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { processLanded } from '../src/runtime/landing.mjs';
import { safeNormal } from '../src/runtime/steps.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [];
function add(changes = {}) {
  cases.push({ position: [-1149.24, 825.84, -80.2].map(f), velocity: [100, 20, -300],
    acceleration: [20, -50, 0], radius: 20, height: 43, normal: [0, 0, 1],
    physics: 2, base: null, remaining: f(1 / 120), iterations: 1,
    supportTime: f(.5), fitPosition: null, farSuccess: true,
    eventPhysics: null, randomIntegers: [0, 32767], ...changes });
}
// Normal landings: state/event order, strict remaining-time boundary, tiny
// acceleration normalization, and retained incoming vertical velocity.
for (const remaining of [0, .005, .01, .0100000008, 1 / 60, .1, .4]) {
  for (const acceleration of [[0, 0, 0], [20, -50, 0], [0, 0, 1], [1e-5, -1e-5, 0], [1e-4, 0, 0]]) {
    for (const base of [null, 'floor']) add({ remaining: f(remaining), acceleration: acceleration.map(f), base });
  }
}
for (const physics of [0, 1, 2, 3]) for (const eventPhysics of [null, 0, 1, 2, 3]) {
  add({ physics, eventPhysics, remaining: f(.2), iterations: 7 });
}
// The fit path only runs on an exactly clear reduced-extent trace. Relocation
// success is deliberately varied: processLanded ignores FarMoveActor's result.
for (const supportTime of [0, .99999994, 1]) for (const farSuccess of [false, true]) {
  for (const fitPosition of [null, [-1149.24, 825.84, -80.2].map(f), [1, 2, 3]]) {
    for (const randomIntegers of [[0, 32767], [1, 16384], [30001, 12345]]) {
      add({ supportTime: f(supportTime), farSuccess, fitPosition, randomIntegers });
    }
  }
}
let seed = 20766;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((2 * random() - 1) * scale));
for (let i = 0; i < 150; i++) {
  add({ position: vector(2000), velocity: vector(2500), acceleration: vector(2400),
    radius: f(1 + random() * 60), height: f(1 + random() * 100), normal: safeNormal(vector(1)),
    remaining: f(random() * .4), iterations: Math.floor(random() * 8),
    supportTime: random() < .5 ? 1 : f(random()), fitPosition: random() < .7 ? vector(2000) : null,
    randomIntegers: [Math.floor(random() * 32768), Math.floor(random() * 32768)], farSuccess: random() < .5 });
}

const directory = path.resolve('reports/movement/native-landing');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-landing-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);
// Preserve the original reference corpus before comparing the translation.
await writeFile(path.join(directory, 'original.json'), JSON.stringify(native, null, 2));

function run(input) {
  const events = [];
  let randomIndex = 0;
  const pawn = { ...structuredClone(input),
    lineCheck(start, end, extent, flags, extra) {
      events.push({ line: { start, end, extent, flags, extra } }); return { time: input.supportTime };
    },
    findSpot(position, extent, ...options) { events.push({ fit: { position, extent, options } }); return input.fitPosition; },
    farMove(position, ...options) { events.push({ farMove: position, options }); if (input.farSuccess) pawn.position = position; return input.farSuccess; },
    random() {
      const value = input.randomIntegers[randomIndex++]; events.push({ rand: value });
      // Original Core.appFrand 0x101232e0 returns this product in x87 without
      // a float32 store. The CRT integer sequence itself is a controlled input.
      return value * f(1 / 32767);
    },
    landedEvent(normal) {
      events.push({ landed: normal, velocity: [...pawn.velocity] });
      if (input.eventPhysics !== null) pawn.physics = input.eventPhysics;
    },
    setPhysics(physics, actor) {
      events.push({ setPhysics: physics, actor });
      if (pawn.physics !== physics) {
        pawn.physics = physics;
        if (pawn.base !== actor) { events.push({ supportBase: actor }); pawn.base = actor; }
      }
    },
    walking(remaining, iterations) {
      events.push({ walking: remaining, iterations, acceleration: [...pawn.acceleration], velocity: [...pawn.velocity] });
    },
  };
  processLanded(pawn, { normal: input.normal, actor: 'floor' }, input.remaining, input.iterations);
  return { position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration,
    physics: pawn.physics, base: pawn.base, events };
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
const mismatches = [];
const comparisons = cases.map((input, index) => {
  const actual = run(input), expected = native.results[index];
  if (!same(actual, expected)) mismatches.push(index);
  return { input, actual, expected };
});
const summary = { binaryHashes: native.hashes, cases: cases.length,
  scope: 'dry Pawn landing and original setPhysics with controlled world, Landed, support basing, walking and CRT random callbacks',
  comparison: 'exact state, query parameters, callback order and arguments, including signed zero', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'dry Pawn landing agrees with original processLanded for all sampled cases');
