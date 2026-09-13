import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { falling } from '../src/runtime/falling.mjs';
import { safeNormal } from '../src/runtime/steps.mjs';
import { gameDirectory } from './game-directory.mjs';

const cases = [], f = Math.fround, clear = { time: 1, normal: [0, 0, 0] };
const addCase = (velocity, acceleration, dt, changes = {}) => cases.push({ position: [0, 0, 100],
  velocity: velocity.map(f), acceleration: acceleration.map(f), dt: f(dt),
  groundSpeed: 320, accelRate: 1000, airControl: f(.05), gravity: [0, 0, -950],
  zoneVelocity: [0, 0, 0], terminalVelocity: 2500, responses: Array(32).fill(clear), airBlocked: false, ...changes });
for (const dt of [.005, 1 / 120, 1 / 30, .1, .2, .4]) for (const speed of [0, 9.99, 10, 100, 319.99, 320, 500]) {
  for (const acceleration of [[0, 0, 0], [2400, 0, 0], [-2400, 2400, 0]]) addCase([speed, 0, 300], acceleration, dt);
}
for (const airControl of [0, .049999, .05, .050001, .15, .150001, .4, 1]) for (const airBlocked of [false, true]) {
  for (const velocity of [[0, 0, -100], [319, 0, 300], [400, -100, 10]]) addCase(velocity, [2400, -2400, 0], .1, { airControl: f(airControl), airBlocked });
}
// Apex subdivision, vector terminal limit, and position-dependent float stores.
for (const z of [5, 5.001, 20, 100, -100, -2499, -3000]) for (const dt of [1 / 120, .1, .4]) {
  addCase([200, -70, z], [2400, 200, 0], dt, { position: [-1149.24, 825.84, -80.2].map(f) });
}
const hit = (time, normal) => ({ time: f(time), normal: normal.map(f) });
for (const normal of [[0, 0, 1], [0, 0, -1], [-1, 0, 0], [.6, 0, .8], [.8, 0, .6]]) {
  for (const time of [0, .1, .100001, .3, .9]) for (const dt of [.005, 1 / 120, .1]) {
    addCase([200, 30, -300], [200, 1000, 0], dt, { responses: [hit(time, normal), ...Array(31).fill(clear)] });
  }
}
for (const normal of [[0, 0, 1], [0, 1, 0], [.6, 0, .8], [.8, 0, .6]]) {
  addCase([200, 30, -300], [200, 1000, 0], .1, { responses: [hit(.3, [-1, 0, 0]), hit(.4, normal), ...Array(30).fill(clear)] });
}
let seed = 83919;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((random() * 2 - 1) * scale));
for (let i = 0; i < 200; i++) addCase(vector(3000), vector(2400), .005 + random() * .395, {
  position: vector(2000), airControl: f(random()), groundSpeed: f(100 + random() * 400),
  zoneVelocity: vector(30), terminalVelocity: f(500 + random() * 2500),
  responses: [...Array.from({ length: 3 }, () => random() < .3 ? hit(random(), safeNormal(vector(1))) : clear), ...Array(29).fill(clear)],
});
// Non-Pawn decoration falling (a pushed Plant2). Acceleration and air control are
// zero, so the native physFalling skips the Pawn air-control prelude and both
// Pawn-only integration branches (Path A PlayerPawn, and the bounce class), taking
// the general integration Velocity += 0.5*(Gravity+Acceleration)*step. This proves
// falling() is reused verbatim for a decoration cylinder; docs/script-plant-contact.md.
const decoration = { acceleration: [0, 0, 0], airControl: 0, nonPawn: true, position: [-804.27, 1125.16, -84.02].map(f) };
for (const dt of [1 / 120, 1 / 30, .1, .2, .4]) {
  for (const velocity of [[0, 0, 0], [120, -30, 18], [120, -30, -40], [-60, 45, -200], [300, 0, -2600], [0, 0, -950], [5, 0, 9.99]]) {
    addCase(velocity, [0, 0, 0], dt, { ...decoration, gravity: [0, 0, -950], terminalVelocity: 2500 });
  }
  for (const gravity of [[0, 0, -800], [40, -25, -1200]]) addCase([70, -15, -30], [0, 0, 0], dt, { ...decoration, gravity, zoneVelocity: [12, -6, 0], terminalVelocity: 1800 });
}
// Landing (floor normal>0.7), wall (vertical/side normal), and grazing hits during a decoration fall.
for (const normal of [[0, 0, 1], [.2, 0, .98], [-1, 0, 0], [0, 1, 0], [.8, 0, .6]]) {
  for (const time of [0, .15, .5, .9]) for (const dt of [1 / 60, .1]) {
    addCase([90, -20, -120], [0, 0, 0], dt, { ...decoration, gravity: [0, 0, -950], terminalVelocity: 2000, responses: [hit(time, normal), ...Array(31).fill(clear)] });
  }
}
// Two-wall / floor-after-wall sequences on a decoration.
for (const second of [[0, 0, 1], [0, 1, 0], [.8, 0, .6]]) {
  addCase([120, 40, -160], [0, 0, 0], .1, { ...decoration, gravity: [0, 0, -950], terminalVelocity: 2000, responses: [hit(.3, [-1, 0, 0]), hit(.4, second), ...Array(30).fill(clear)] });
}

function run(input) {
  const events = [], pawn = { ...structuredClone(input), physics: 2, airControlBlocked: () => input.airBlocked,
    move(delta) {
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      const response = input.responses[index++];
      if (!response) throw new Error('Missing explicit MoveActor response');
      pawn.position = pawn.position.map((value, axis) => f(value + f(delta[axis] * response.time)));
      return response;
    },
    hitWall(hit) { events.push({ wall: [...hit.normal] }); },
    landed(hit, remaining, iterations) { events.push({ landed: [...hit.normal], remaining, iterations, velocity: [...pawn.velocity] }); pawn.physics = 1; },
  };
  let index = 0;
  falling(pawn, input.dt);
  return { position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration, physics: pawn.physics, events };
}
const directory = path.resolve('reports/movement/native-falling');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-falling-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxError = 0;
function compare(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    maxError = Math.max(maxError, Math.abs(actual - expected)); return Object.is(actual, expected);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => compare(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const comparisons = cases.map((input, i) => {
  const actual = run(input), original = native.results[i];
  // Surface-material/ladder traces execute in the original with clear results.
  // This comparison covers physics and MoveActor/HitWall/Landed requests, not
  // those auxiliary query parameters or the general script event dispatcher.
  const expected = { ...original, events: original.events.filter(e => !e.line && !e.event) };
  if (!compare(actual, expected)) mismatches.push({ index: i });
  return { input, actual, expected, originalEvents: original.events };
});
const summary = { binaryHashes: native.hashes, cases: cases.length,
  scope: 'dry non-bouncing player falling with controlled world, HitWall and Landed callbacks; auxiliary surface queries clear',
  comparison: 'exact float32 components, including signed zero, and movement/event sequence', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'dry player falling agrees with original physFalling for all sampled cases');
