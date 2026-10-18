import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { processLanded, decorationLanded, actorLanded } from '../src/runtime/landing.mjs';
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

// Non-Pawn decoration landings (a settled Plant2). With a spent landing counter
// (numLandings >= 5) the footprint block is skipped: the counter is reset, the
// script Landed runs and — only while still PHYS_Falling — setPhysics(PHYS_None)
// rebases onto the floor and zeroes velocity/acceleration.
for (const velocity of [[0, 0, 0], [80, -20, -120], [120, -30, 18], [-60, 45, -260], [0, 0, -950], [300, 0, -2600]]) {
  for (const base of [null, 'floor']) for (const eventPhysics of [null, 0, 2, 3]) {
    add({ decoration: true, landingCounter: 5, physics: 2, base, velocity, eventPhysics,
      acceleration: [0, 0, 0], position: [-804.27, 1125.16, -84.02].map(f), radius: 23.26, height: 43.88 });
  }
}
// A decoration that is no longer PHYS_Falling when its Landed event returns (e.g.
// already resting, or a script GotoState) must not be re-set to PHYS_None.
for (const physics of [0, 3, 7]) for (const eventPhysics of [null, 3]) {
  add({ decoration: true, landingCounter: 5, physics, eventPhysics, base: 'floor', velocity: [10, 0, 0],
    acceleration: [0, 0, 0], radius: 23.26, height: 43.88 });
}
// The footprint block (numLandings < 5, 0x103cf5f7): the centre probe, then four
// corner probes whose UBOOL returns (1: clear) decide a push off the edge that
// skips Landed and setPhysics. `lines` gives each SingleLineCheck call its
// Hit.Actor and return value, in call order. The fall speeds cover the clamp to
// [30, 30 + CollisionRadius] (exp1: CrateExplosiveSmall4, R 22.5, landing half
// off another crate at -142.5 with corners (−,−) and (+,−) clear).
const corners = n => [0, 1, 2, 3].map(i => [0, (n >> i) & 1]);
for (const counter of [0, 4]) for (const fall of [-10, -30, -40, -142.5, -500, 0, 12]) for (let n = 0; n < 16; n++) {
  add({ decoration: true, landingCounter: counter, physics: 2, base: null, velocity: [7, -3, fall], acceleration: [0, 0, 0],
    position: [3174.76611, -1099.12695, -189.557312].map(f), radius: 22.5, height: 16, lines: [[0, 1], ...corners(n)] });
}
for (const [radius, height, position] of [[23.26, 43.88, [-804.27, 1125.16, -84.02]], [f(1.6), f(2.15), [0, 0, 0]], [40, f(17.5), [-1e-3, 3e4, 0]]]) {
  for (const n of [0, 3, 5, 6, 9, 10, 12, 15]) for (const fall of [-31, -200]) {
    add({ decoration: true, landingCounter: 0, physics: 2, base: null, velocity: [0, 0, fall], acceleration: [0, 0, 0],
      position: position.map(f), radius, height, lines: [[0, 1], ...corners(n)] });
  }
  // A supported centre (Hit.Actor set) skips the corners.
  add({ decoration: true, landingCounter: 0, physics: 2, base: null, velocity: [0, 0, -200], acceleration: [0, 0, 0],
    position: position.map(f), radius, height, lines: [[1, 0]] });
}
// The Carcass slide (0x103d0159): a Carcass with bSlidingCarcass landing on a
// normal whose Z is below 0.9 (double) draws appFrand, counts the landing when it
// is below 0.2, and gets Velocity = HitNormal·120 with Z = 70. Reached after a
// supported centre or a footprint that does not push.
for (const slidingCarcass of [false, true]) for (const normal of [[0, 0, 1], [.43588989, 0, .9], [0, .43588992, .89999998], [.6, 0, .8], [-.71, .1, .69695067]]) {
  for (const randomIntegers of [[0], [6553], [6554], [32767]]) for (const lines of [[[1, 0]], [[0, 1], ...corners(1)]]) {
    add({ carcass: true, slidingCarcass, landingCounter: 0, physics: 2, base: null, normal: normal.map(f), velocity: [5, -6, -240],
      acceleration: [0, 0, 0], position: [-804.27, 1125.16, -84.02].map(f), radius: 40, height: f(9.6), randomIntegers, lines });
  }
}

// Non-Decoration non-Pawn landings: an Inventory (dropped Lockpick) and a
// Projectile (fragment) ancestry. Only Landed and, while still falling,
// setPhysics(PHYS_None) run; actor+0x324 is a subclass field and must stay intact.
for (const ancestry of ['inventory', 'projectile']) {
  for (const velocity of [[0, 0, 0], [80, -20, -120], [-60, 45, -260], [0, 0, -950]]) {
    for (const base of [null, 'floor']) for (const eventPhysics of [null, 0, 1, 2, 3]) {
      add({ ancestry, landingCounter: 0x5a5a5a5a, physics: 2, base, velocity, eventPhysics, acceleration: [3, -4, 5],
        position: [-804.27, 1125.16, -84.02].map(f), radius: ancestry === 'inventory' ? 11.75 : 6, height: ancestry === 'inventory' ? f(1.9) : 1,
        remaining: f(.2), iterations: 3 });
    }
  }
  for (const physics of [0, 1, 3, 7]) add({ ancestry, landingCounter: 7, physics, base: 'floor', velocity: [10, 0, -5], acceleration: [0, 0, 0] });
  for (const normal of [[0, 0, 1], [.6, 0, .8], [0, -.71, .70420164]]) add({ ancestry, landingCounter: 0, normal: normal.map(f), velocity: [1, 2, -300], acceleration: [0, 0, 0] });
}
// processLanded's first branch: a non-Pawn (bIsPawn clear) in a bBounceVelocity
// zone with a nonzero ZoneVelocity is bounced (Velocity = ZoneVelocity + 80 Z) and
// nothing else happens; -0 components compare equal to zero. A Pawn (bIsPawn set)
// skips it. '-0' encodes a negative zero through JSON.
for (const zoneVelocity of [[0, 0, 0], ['-0', 0, '-0'], [30, 0, 0], ['-0', 0, 5], [-200, 50, -10], [0, f(1e-30), 0], [0, 0, -80]]) {
  for (const bBounceVelocity of [false, true]) {
    const zone = { bBounceVelocity, velocity: zoneVelocity };
    for (const ancestry of ['inventory', 'projectile']) add({ ancestry, zone, landingCounter: 0x5a5a5a5a, velocity: [80, -20, -120], acceleration: [0, 0, 0] });
    // A spent counter (5) skips the footprint block; the bounce path
    // leaves it at 5 while the ordinary decoration landing resets it to 0.
    add({ decoration: true, zone, landingCounter: 5, velocity: [80, -20, -120], acceleration: [0, 0, 0],
      radius: 23.26, height: 43.88, position: [-804.27, 1125.16, -84.02].map(f) });
    add({ bIsPawn: true, zone, remaining: f(.2), iterations: 2 });
  }
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
  let randomIndex = 0, lineIndex = 0;
  const pawn = { ...structuredClone(input),
    lineCheck(start, end, extent, flags, extra) {
      events.push({ line: { start, end, extent, flags, extra } });
      if (!input.lines) return { time: input.supportTime };
      const [actor, clear] = input.lines[lineIndex++];
      return { time: input.supportTime, actor: actor ? 'floor' : null, outside: Boolean(clear) };
    },
    isCarcass: Boolean(input.carcass), slidingCarcass: Boolean(input.slidingCarcass),
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
        // Original setPhysics (0x103c9676) zeroes Velocity and Acceleration when it
        // switches into PHYS_None (0) or PHYS_Interpolating (5).
        if (physics === 0 || physics === 5) { pawn.velocity = [0, 0, 0]; pawn.acceleration = [0, 0, 0]; }
      }
    },
    walking(remaining, iterations) {
      events.push({ walking: remaining, iterations, acceleration: [...pawn.acceleration], velocity: [...pawn.velocity] });
    },
  };
  pawn.landingCounter = input.landingCounter ?? 0;
  const zone = input.zone && { bBounceVelocity: input.zone.bBounceVelocity,
    ZoneVelocity: input.zone.velocity.map(value => (value === '-0' ? -0 : value)) };
  const hit = { normal: input.normal, actor: 'floor' };
  if (input.ancestry) actorLanded(pawn, hit, { zone });
  else if (input.decoration || input.carcass) decorationLanded(pawn, hit, { zone });
  // The Pawn path never reads the zone: bIsPawn skips the bBounceVelocity branch.
  else processLanded(pawn, hit, input.remaining, input.iterations);
  return { position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration,
    physics: pawn.physics, landingCounter: pawn.landingCounter, base: pawn.base, events };
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
  scope: 'dry Pawn, non-Pawn decoration (the footprint push and the Carcass slide) and non-Decoration (inventory/projectile ancestry) landing, including the bBounceVelocity zone branch, with original setPhysics and controlled world, Landed, support basing, walking and CRT random callbacks',
  comparison: 'exact state, query parameters, callback order and arguments, including signed zero', maxError, mismatches};
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'dry Pawn and decoration landing agree with original processLanded for all sampled cases');
