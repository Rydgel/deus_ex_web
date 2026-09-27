/** Compare src/runtime/flying.mjs physFlying/calcVelocity with the original
 * APawn::physFlying (Engine.dll 0x103d3040) run in Unicorn by
 * scripts/native-flying-oracle.py. MoveActor responses and processHitWall are
 * the same controlled callbacks on both sides; stepUp, TwoWallAdjust,
 * SafeNormal and calcVelocity execute natively in the oracle.
 * Evidence: docs/ladder-flying.md. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { physFlying } from '../src/runtime/flying.mjs';
import { safeNormal } from '../src/runtime/steps.mjs';
import { gameDirectory } from './game-directory.mjs';

const cases = [], f = Math.fround, clear = { time: 1, normal: [0, 0, 0] };
const hit = (time, normal) => ({ time: f(time), normal: normal.map(f) });
const fill = (...first) => [...first, ...Array(24 - first.length).fill(clear)];
const addCase = (velocity, acceleration, dt, changes = {}) => cases.push({ position: [0, 0, 100],
  velocity: velocity.map(f), acceleration: acceleration.map(f), dt: f(dt),
  airSpeed: 400, accelRate: 500, desiredSpeed: 1, gravity: [0, 0, -950], zoneVelocity: [0, 0, 0],
  fluidFriction: f(1.2), walking: false, responses: fill(), ...changes });

// Free flight: accel clamp (walking 0.3 / plain), speed clamp, fluid decay.
for (const dt of [.005, 1 / 120, 1 / 30, .1, .2]) for (const walking of [false, true]) {
  for (const velocity of [[0, 0, 0], [100, 0, 50], [30, 40, 110], [400, 0, 0], [-500, 300, 200]]) {
    for (const acceleration of [[0, 0, 0], [500, 0, 0], [150, 0, 0], [0, 2000, 800]]) addCase(velocity, acceleration, dt, { walking });
  }
}
// Friction: max(bFluid, ZoneFluidFriction) for the step, raw value for decay.
for (const fluidFriction of [0, .5, .999999, 1, 1.000001, 1.2, 4, 8]) for (const walking of [false, true]) {
  addCase([220, -40, 90], [300, 300, 0], .05, { fluidFriction: f(fluidFriction), walking });
}
// Non-PlayerPawn: MaxSpeed *= DesiredSpeed and the 90000 zone threshold.
for (const desiredSpeed of [0, .25, 1]) for (const zoneVelocity of [[0, 0, 0], [300, 0, 0], [300.0001, 0, 0], [0, 250, -200]]) {
  addCase([200, 10, -40], [400, 0, 0], .05, { nonPlayer: true, desiredSpeed, zoneVelocity });
}
for (const zoneVelocity of [[20, -10, 0], [300, 0, 0]]) addCase([200, 10, -40], [400, 0, 0], .05, { zoneVelocity });
// Blocked moves: step window (|Nz| < .2, -.2 < UpDown < .5) against wall slides.
for (const normal of [[-1, 0, 0], [-.98, 0, .199], [-.98, 0, .2], [0, 0, 1], [0, 0, -1], [.6, 0, .8], [-.8, .6, 0]]) {
  for (const velocity of [[150, 0, 0], [150, 0, 60], [150, 0, -40], [120, 0, -90], [100, 0, 150]]) {
    for (const time of [0, .3, .9]) {
      addCase(velocity, [300, 0, 0], .1, { responses: fill(hit(time, normal)) });
      addCase(velocity, [300, 0, 0], .1, { responses: fill(hit(time, normal), hit(.5, [0, 1, 0])) });
    }
  }
}
// Positive zone gravity flips GravDir; bJustTeleported set during a move.
for (const gravity of [[0, 0, 950], [0, 0, 0]]) addCase([150, 0, 20], [300, 0, 0], .1, { gravity, responses: fill(hit(.4, [-1, 0, 0])) });
for (const teleportAtMove of [0, 1, 2]) addCase([150, 0, 20], [300, 0, 0], .1, { teleportAtMove, responses: fill(hit(.4, [-1, 0, 0]), hit(.5, [0, -1, 0])) });
addCase([150, 0, 20], [300, 0, 0], .1, { justTeleported: true });
// Seeded broad sample.
let seed = 42017;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((random() * 2 - 1) * scale));
for (let i = 0; i < 300; i++) addCase(vector(600), random() < .2 ? [0, 0, 0] : vector(2400), .004 + random() * .2, {
  position: vector(4000), walking: random() < .5, nonPlayer: random() < .25, desiredSpeed: f(random()),
  airSpeed: f(50 + random() * 600), accelRate: f(50 + random() * 2000), fluidFriction: f(random() * 3),
  zoneVelocity: random() < .3 ? vector(400) : [0, 0, 0], gravity: [0, 0, random() < .1 ? 950 : -950],
  responses: fill(...Array.from({ length: 4 }, () => random() < .45 ? hit(random() < .15 ? 0 : random(), safeNormal(vector(1))) : clear)),
});

function run(input) {
  const events = [];
  let index = 0;
  const pawn = { position: input.position.map(f), velocity: input.velocity.map(f), acceleration: input.acceleration.map(f),
    oldLocation: [0, 0, 0], physics: 4, justTeleported: Boolean(input.justTeleported),
    isPlayerPawn: !input.nonPlayer, isWalking: Boolean(input.walking), isPlayer: false, netMode: 0,
    airSpeed: input.airSpeed, accelRate: input.accelRate, desiredSpeed: input.desiredSpeed,
    fluidFriction: input.fluidFriction, zoneVelocity: input.zoneVelocity, zoneGravityZ: input.gravity[2],
    collideWorld: false, zoneNumber: 1, maxStepHeight: 25, mass: 100,
    move(delta) {
      if (input.teleportAtMove === index) pawn.justTeleported = true;
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      const response = input.responses[index++];
      if (!response) throw new Error('Missing explicit MoveActor response');
      pawn.position = pawn.position.map((value, axis) => f(value + f(delta[axis] * response.time)));
      return { ...response, actor: response.time < 1 ? 'level' : null };
    },
    hitWall(h) { events.push({ wall: [...h.normal] }); },
  };
  physFlying(pawn, input.dt, 0);
  return { position: pawn.position, oldLocation: pawn.oldLocation, velocity: pawn.velocity,
    acceleration: pawn.acceleration, justTeleported: pawn.justTeleported, events };
}

const directory = path.resolve('reports/movement/native-flying');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-flying-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
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
  const actual = run(input), expected = native.results[i];
  if (!compare(actual, expected)) mismatches.push({ index: i });
  return { input, actual, expected };
});
const summary = { binaryHashes: native.hashes, cases: cases.length,
  steps: comparisons.filter(c => c.expected.events.filter(e => e.move).length > 1 && !c.expected.events.some(e => e.wall)).length,
  walls: comparisons.filter(c => c.expected.events.some(e => e.wall)).length,
  scope: 'physFlying with calcVelocity(bFluid=1,bBrake=0,bBuoyant=0), player and non-player ancestry; controlled MoveActor and processHitWall',
  comparison: 'exact float32 components, including signed zero, and movement/event sequence', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10).map(({ index }) => ({ index, input: cases[index],
  actual: comparisons[index].actual, expected: comparisons[index].expected })), mismatchCount: mismatches.length }, null, 1).slice(0, 6000));
assert.equal(mismatches.length, 0, 'physFlying agrees with the original for all sampled cases');
assert.equal(maxError, 0, 'physFlying is bit-exact');
