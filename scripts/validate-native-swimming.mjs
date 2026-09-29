/** Compare src/runtime/swimming.mjs (startSwimming, physSwimming, Swim,
 * findWaterLine) and the walking/falling hand-offs with the original
 * Engine.dll bodies run in Unicorn by scripts/native-swimming-oracle.py.
 * MoveActor, PointRegion, the surface prelude, processHitWall, setPhysics and
 * the physFalling/physFlying continuations are the same controlled doubles on
 * both sides; calcVelocity, stepUp, TwoWallAdjust and Core's FVector helpers
 * execute natively in the oracle. Evidence: docs/swimming.md. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { physSwimming, startSwimming } from '../src/runtime/swimming.mjs';
import { falling } from '../src/runtime/falling.mjs';
import { walking } from '../src/runtime/walking.mjs';
import { safeNormal } from '../src/runtime/steps.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [];
const clear = { time: 1, normal: [0, 0, 0] };
const hit = (time, normal) => ({ time: f(time), normal: normal.map(f) });
const fill = (...first) => [...first, ...Array(24 - first.length).fill(clear)];
const zone = (changes = {}) => ({ gravity: [0, 0, -950], zoneVelocity: [0, 0, 0], fluidFriction: f(1.2), ...changes });
const waterZone = (changes = {}) => zone({ fluidFriction: f(2.4), ...changes });
const swimCase = (entry, changes) => cases.push({ mode: 'swim', entry, position: [0, 0, -200], oldLocation: [0, 0, 0],
  velocity: [0, 0, 0], acceleration: [0, 0, 0], waterSpeed: 300, accelRate: 500, desiredSpeed: 1, mass: 100, buoyancy: 100,
  radius: 20, height: 43, eyeHeight: 38, water: { axis: 2, level: 0 }, zones: { dry: zone(), water: waterZone() },
  responses: fill(), iterations: 0, ...changes });
const swimTick = (velocity, acceleration, dt, changes = {}) => swimCase('physSwimming',
  { velocity: velocity.map(f), acceleration: acceleration.map(f), dt: f(dt), ...changes });
const entering = (changes) => swimCase('startSwimming', { timeTick: f(1 / 60), remaining: 0, oldVelocity: [0, 0, 0], ...changes });

// 1. Deep water: calcVelocity with bFluid/bBuoyant, walking clamp, frame rates.
for (const dt of [.005, 1 / 60, 1 / 30, .1, .2, .4]) for (const walking of [false, true]) {
  for (const velocity of [[0, 0, 0], [100, 0, 50], [0, 0, 150], [0, 0, -150], [300, -200, 120], [-500, 300, -400]]) {
    for (const acceleration of [[0, 0, 0], [500, 0, 0], [0, 300, 800], [-2000, 0, 0]]) swimTick(velocity, acceleration, dt, { walking });
  }
}
// 2. Buoyancy/Mass variants (sinking, neutral, floating; Mass 0).
for (const [mass, buoyancy] of [[100, 0], [100, 50], [100, 99.9], [100, 100], [100, 110], [150, 200], [1, 100], [0, 5], [0, 0]]) {
  for (const velocity of [[0, 0, 0], [50, 20, -30]]) swimTick(velocity, [0, 0, 0], 1 / 30, { mass, buoyancy, nonPlayer: true });
}
// 3. Zone velocity: PlayerPawn always, others above |ZV|^2 > 90000; zone friction.
for (const nonPlayer of [false, true]) for (const zoneVelocity of [[0, 0, 0], [20, -10, 0], [300, 0, 0], [300.0001, 0, 0], [0, 250, -200]]) {
  swimTick([120, 10, -40], [400, 0, 0], .05, { nonPlayer, desiredSpeed: .5, zones: { dry: zone(), water: waterZone({ zoneVelocity }) } });
}
for (const fluidFriction of [0, .5, 1, 1.2, 2.4, 8]) swimTick([220, -40, 90], [300, 300, 0], .05, { zones: { dry: zone(), water: waterZone({ fluidFriction: f(fluidFriction) }) } });
// 4. Head above the water: Velocity.Z > 100 damps by (1 - dt); the prelude.
for (const z of [-20, -37.9, -38, -38.1]) for (const vz of [99, 100, 100.001, 300]) swimTick([0, 0, vz], [0, 0, 0], .05, { position: [0, 0, z] });
swimTick([100, 0, 0], [500, 0, 0], .05, { preludeHandled: 1 });
swimTick([100, 0, 0], [500, 0, 0], .05, { iterations: 7 });
swimTick([100, 0, 0], [500, 0, 0], .05, { justTeleported: true });
// 5. Leaving the water upward: Swim's findWaterLine pull-back and airTime,
// setPhysics(PHYS_Falling), the 40 + Size2D*0.4 exit, the 0.01 continuation.
for (const dt of [1 / 60, .05, .1, .3]) for (const z of [-5, -1, -.4, -30]) for (const velocity of [[0, 0, 300], [200, 0, 60], [-150, 80, 20], [0, 0, 5000]]) {
  swimTick(velocity, [0, 0, 0], dt, { position: [0, 0, z] });
}
for (const zonePhysics of [{ dry: 2 }, { dry: 4 }, { dry: 1 }]) swimTick([0, 0, 300], [0, 0, 0], .1, { position: [0, 0, -5], zonePhysics });
swimTick([0, 0, 300], [0, 0, 0], .1, { position: [0, 0, -5], physics: 4 });
// A horizontal water boundary (x < 0 is water).
for (const velocity of [[300, 0, 0], [250, 90, -30]]) swimTick(velocity, [600, 0, 0], .1, { position: [-4, 0, 0], water: { axis: 0, level: 0 } });
// 6. Blocked moves: stepUp window (|N.Z| < .2, -.2 < UpDown < .5) against wall slides.
for (const normal of [[-1, 0, 0], [-.98, 0, .199], [-.98, 0, .2], [0, 0, 1], [0, 0, -1], [.6, 0, .8], [-.8, .6, 0]]) {
  for (const velocity of [[150, 0, 0], [150, 0, 60], [150, 0, -40], [120, 0, -90], [100, 0, 150]]) {
    for (const time of [0, .3, .9]) {
      swimTick(velocity, [300, 0, 0], .1, { responses: fill(hit(time, normal)) });
      swimTick(velocity, [300, 0, 0], .1, { responses: fill(hit(time, normal), hit(.5, [0, 1, 0])) });
    }
  }
}
// Positive zone gravity flips GravDir; bJustTeleported set during a move;
// a Velocity.Z changed by an event keeps its value; a wall hit near the surface.
for (const gravity of [[0, 0, 950], [0, 0, 0]]) swimTick([150, 0, 20], [300, 0, 0], .1, { zones: { dry: zone(), water: waterZone({ gravity }) }, responses: fill(hit(.4, [-1, 0, 0])) });
for (const teleportAtMove of [0, 1, 2]) swimTick([150, 0, 20], [300, 0, 0], .1, { teleportAtMove, responses: fill(hit(.4, [-1, 0, 0]), hit(.5, [0, -1, 0])) });
for (const index of [0, 1]) swimTick([150, 0, 20], [300, 0, 0], .1, { velocityAtMove: { index, velocity: [10, 20, 30] }, responses: fill(hit(.4, [-1, 0, 0])) });
swimTick([150, 0, 20], [300, 0, 0], .1, { wallVelocityZ: -55, responses: fill(hit(.4, [-1, 0, 0]), hit(.5, [0, -1, 0])) });
for (const normal of [[-1, 0, 0], [0, 0, -1], [-.7, 0, -.7]]) swimTick([100, 0, 300], [0, 0, 0], .1, { position: [0, 0, -4], responses: fill(hit(.5, normal), hit(.5, [0, 1, 0])) });

// 7. Entering the water (startSwimming): water-line search, waterTime refund,
// (Location-OldLocation)/(tick-waterTime), 2V-OldVelocity, the 4000 clamp,
// the -160 < Vz < 0 bobbing and the physSwimming continuation.
for (const tick of [1 / 120, 1 / 60, .05, .1]) for (const remaining of [0, .005, .01, .0100001, .04]) {
  for (const [old, now] of [[[0, 0, 30], [0, 0, -10]], [[0, 0, 5], [0, 0, -5]], [[-40, 12, 60], [-10, 3, -80]], [[0, 0, .5], [0, 0, -.2]]]) {
    entering({ timeTick: f(tick), remaining: f(remaining), oldLocation: old, position: now, oldVelocity: [30, -10, -400], velocity: [30, -10, -420] });
  }
}
for (const oldVelocity of [[0, 0, 0], [0, 0, -300], [2000, 0, -2000], [100, 100, 100]]) {
  for (const now of [[0, 0, -10], [0, 0, -60], [300, 0, -300]]) entering({ oldLocation: [0, 0, 40], position: now, oldVelocity });
}
entering({ oldLocation: [0, 0, -40], position: [0, 0, -10] });           // both points in the water
entering({ oldLocation: [0, 0, -9.5], position: [0, 0, -10] });          // |End - Start| < 1 at once
entering({ oldLocation: [0, 0, 40], position: [0, 0, 20] });             // Region dry while swimming
entering({ oldLocation: [0, 0, 40], position: [0, 0, -10], bounce: true });
entering({ oldLocation: [0, 0, 40], position: [0, 0, -10], justTeleported: true });
entering({ oldLocation: [50, 0, 3], position: [-50, 0, 3], water: { axis: 0, level: 0 }, oldVelocity: [-800, 0, 0] });
entering({ oldLocation: [0, 0, 40], position: [0, 0, -10], remaining: f(.05), responses: fill(clear, hit(.5, [-1, 0, 0])) });

// Huge magnitudes: the speed clamp, a huge zone velocity, the 16000000/4000
// clamp near float max, a long water-line search, large coordinates.
swimTick([1e30, 0, 0], [0, 0, 0], .05);
swimTick([0, 0, 0], [0, 0, 0], .05, { zones: { dry: zone(), water: waterZone({ zoneVelocity: [1e30, 0, 0] }) } });
for (const oldVelocity of [[3e38, 0, 0], [-3.4e38, 1e38, 0], [0, 0, 3e38]]) entering({ oldLocation: [0, 0, 40], position: [0, 0, -10], oldVelocity });
entering({ oldLocation: [0, 0, 1e6], position: [0, 0, -10] });
entering({ oldLocation: [3e7, -2e7, 900], position: [3e7, -2e7, -10] });
swimTick([200, 0, 300], [0, 0, 0], .1, { position: [3e7, -2e7, -3] });

// Seeded broad sample over both entries.
let seed = 71293;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((random() * 2 - 1) * scale));
const randomResponses = () => fill(...Array.from({ length: 5 }, () => random() < .4 ? hit(random() < .15 ? 0 : random(), safeNormal(vector(1))) : clear));
for (let i = 0; i < 300; i++) {
  const common = { nonPlayer: random() < .3, walking: random() < .3, desiredSpeed: f(random()),
    waterSpeed: f(50 + random() * 400), accelRate: f(50 + random() * 2000), mass: f(50 + random() * 200), buoyancy: f(random() * 250),
    zones: { dry: zone(), water: waterZone({ fluidFriction: f(random() * 4), zoneVelocity: random() < .3 ? vector(400) : [0, 0, 0],
      gravity: [0, 0, random() < .1 ? 950 : -950] }) },
    responses: randomResponses() };
  if (random() < .7) swimTick(vector(600), random() < .2 ? [0, 0, 0] : vector(2400), .004 + random() * .3,
    { ...common, position: [f((random() - .5) * 4000), f((random() - .5) * 4000), f(-random() * 120)] });
  else {
    const old = [f((random() - .5) * 4000), f((random() - .5) * 4000), f(random() * 60)];
    entering({ ...common, oldLocation: old, position: old.map((c, a) => a === 2 ? f(-random() * 80) : f(c + (random() - .5) * 60)),
      timeTick: f(.004 + random() * .1), remaining: f(random() * .05), oldVelocity: vector(900), velocity: vector(900) });
  }
}

// 8. Hand-offs: physFalling (0x103d1cb6) and physWalking (0x103cb3fd,
// 0x103cb6d9, 0x103cb97d) call startSwimming after a MoveActor that left
// PHYS_Swimming (a script ZoneChange double). physFalling also writes
// OldLocation at every substep (0x103d0ee2).
const fallingCase = (velocity, acceleration, dt, changes = {}) => cases.push({ mode: 'falling', position: [0, 0, 100],
  velocity: velocity.map(f), acceleration: acceleration.map(f), dt: f(dt), groundSpeed: 320, accelRate: 1000, airControl: f(.05),
  gravity: [0, 0, -950], zoneVelocity: [0, 0, 0], terminalVelocity: 2500, responses: Array(32).fill(clear), airBlocked: false, ...changes });
for (const dt of [1 / 60, .1, .4]) for (const swimAtMove of [undefined, 0, 1, 2, 3]) {
  fallingCase([200, 30, -300], [200, 1000, 0], dt, { swimAtMove });
  fallingCase([200, 30, -300], [200, 1000, 0], dt, { swimAtMove, responses: [hit(.4, [-1, 0, 0]), hit(.6, [0, 0, 1]), ...Array(30).fill(clear)] });
}
for (const swimAtMove of [0, 1]) fallingCase([200, -70, 20], [2400, 200, 0], .1, { swimAtMove, position: [-1149.24, 825.84, -80.2].map(f) });
fallingCase([200, 30, -300], [0, 0, 0], .2, { swimAtMove: 0, nonPawn: true, airControl: 0 });
fallingCase([200, 30, -300], [200, 1000, 0], .1, { swimAtMove: 0, zoneVelocity: [30, -20, 0], responses: [hit(.25, [0, 0, 1]), ...Array(31).fill(clear)] });

const many = x => Array.from({ length: 64 }, () => x), floor = { time: 2 / 27, normal: [0, 0, 1] };
const walkingBase = { mode: 'walking', position: [0, 0, 45], velocity: [100, 0, 7], acceleration: [0, 0, 2], groundSpeed: 320, accelRate: 1024,
  maxStepHeight: 25, friction: 8, gravity: [0, 0, -950], zoneVelocity: [0, 0, 0], dt: .016, moves: many(clear), lines: many(floor) };
const walkingCase = changes => cases.push({ ...walkingBase, ...changes });
for (const dt of [.016, .1]) {
  walkingCase({ dt, swimAtMove: 0 });                                                           // after the move (0x103cb190)
  for (const swimAtMove of [0, 1, 2, 3]) walkingCase({ dt, swimAtMove, moves: [hit(.25, [-1, 0, 0]), clear, clear, floor, ...many(clear)] }); // stepUp
  walkingCase({ dt, swimAtMove: 1, lines: many({ ...floor, time: 2.40001 / 27 }), moves: [clear, floor, ...many(clear)] });       // floor move
  for (const friction of [.5, 2]) walkingCase({ dt, friction, swimAtMove: 1, lines: many({ time: 2 / 27, normal: [.6, 0, .8] }) }); // slope slide
  walkingCase({ dt, swimAtMove: 1, lines: many({ ...floor, time: 1.89999 / 27 }), moves: [clear, floor, ...many(clear)] });       // 2.1 up-move
  walkingCase({ dt, swimAtMove: 2, zoneVelocity: [30, -15, 5] });
}

// ---------------------------------------------------------------------------
function runSwim(input) {
  const events = [];
  let index = 0;
  const inWater = p => p[input.water.axis] < input.water.level;
  const zoneAt = p => inWater(p) ? input.zones.water : input.zones.dry;
  const regions = {};
  const pawn = {
    position: input.position.map(f), oldLocation: input.oldLocation.map(f), velocity: input.velocity.map(f),
    acceleration: input.acceleration.map(f), physics: input.physics ?? 3, justTeleported: Boolean(input.justTeleported),
    bounce: Boolean(input.bounce), isPlayerPawn: !input.nonPlayer, isWalking: Boolean(input.walking), isPlayer: false, netMode: 0,
    waterSpeed: input.waterSpeed, accelRate: input.accelRate, desiredSpeed: input.desiredSpeed, mass: input.mass, buoyancy: input.buoyancy,
    radius: input.radius, height: input.height, eyeHeight: input.eyeHeight, maxStepHeight: 25,
    get regionWater() { return regions.region === input.zones.water; },
    get headWater() { return regions.head === input.zones.water; },
    get gravity() { return regions.region.gravity.map(f); },
    get zoneGravityZ() { return f(regions.region.gravity[2]); },
    get zoneVelocity() { return regions.region.zoneVelocity.map(f); },
    get fluidFriction() { return f(regions.region.fluidFriction); },
    waterAt(p) { events.push({ pointRegion: [...p] }); return inWater(p); },
    move(delta) {
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      if (delta.every(c => !(Math.abs(c) >= 1e-4))) return { time: 1, normal: [0, 0, 0], actor: null };
      const at = index++, response = input.responses[at];
      if (!response) throw new Error('Missing explicit MoveActor response');
      pawn.position = pawn.position.map((value, axis) => f(value + f(delta[axis] * response.time)));
      const before = regions.region;
      update();
      if (input.zonePhysics && (before === input.zones.water) !== (regions.region === input.zones.water)) {
        const next = input.zonePhysics[regions.region === input.zones.water ? 'water' : 'dry'];
        if (next !== undefined) pawn.physics = next;
      }
      if (input.teleportAtMove === at) pawn.justTeleported = true;
      if (input.velocityAtMove?.index === at) pawn.velocity = input.velocityAtMove.velocity.map(f);
      return { time: f(response.time), normal: response.normal.map(f), actor: response.time < 1 ? 'level' : null };
    },
    walkingPrelude(dt, iterations) { events.push({ prelude: dt, iterations }); return Boolean(input.preludeHandled); },
    hitWall(h) { events.push({ wall: [...h.normal] }); if ('wallVelocityZ' in input) pawn.velocity = [pawn.velocity[0], pawn.velocity[1], f(input.wallVelocityZ)]; },
    setPhysics(physics) { events.push({ physics }); pawn.physics = physics; },
    falling(dt, iterations) { events.push({ falling: dt, iterations }); },
    flying(dt, iterations) { events.push({ flying: dt, iterations }); },
  };
  const update = () => {
    const [x, y, z] = pawn.position;
    regions.region = zoneAt(pawn.position); regions.head = zoneAt([x, y, f(z + f(input.eyeHeight))]);
  };
  update();
  if (input.entry === 'startSwimming') startSwimming(pawn, input.oldVelocity, input.timeTick, input.remaining, input.iterations);
  else physSwimming(pawn, input.dt, input.iterations);
  return { position: pawn.position, oldLocation: pawn.oldLocation, velocity: pawn.velocity, acceleration: pawn.acceleration,
    physics: pawn.physics, justTeleported: pawn.justTeleported, events };
}

const recordStart = (events, pawn) => (oldVelocity, timeTick, remaining, iterations) => events.push({ startSwimming: {
  oldVelocity: [...oldVelocity], timeTick, remaining, iterations, position: [...pawn.position], oldLocation: [...pawn.oldLocation], velocity: [...pawn.velocity] } });

function runFalling(input) {
  const events = [];
  let index = 0;
  const pawn = { ...structuredClone(input), physics: 2, oldLocation: [0, 0, 0], airControlBlocked: () => input.airBlocked,
    move(delta) {
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      const at = index++, response = input.responses[at];
      pawn.position = pawn.position.map((value, axis) => f(value + f(delta[axis] * response.time)));
      if (input.swimAtMove === at) pawn.physics = 3;
      return { ...response, actor: response.time < 1 ? 'level' : null };
    },
    hitWall(h) { events.push({ wall: [...h.normal] }); },
    landed(h, remaining, iterations) { events.push({ landed: [...h.normal], remaining, iterations, velocity: [...pawn.velocity] }); pawn.physics = 1; },
  };
  pawn.startSwimming = recordStart(events, pawn);
  falling(pawn, input.dt, 0, { nonPawn: Boolean(input.nonPawn) });
  return { position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration, physics: pawn.physics, events, oldLocation: pawn.oldLocation };
}

function runWalking(c) {
  const events = [];
  let mi = 0, li = 0;
  const actor = {};
  const pawn = { ...structuredClone(c), position: c.position.map(f), velocity: c.velocity.map(f), acceleration: c.acceleration.map(f),
    radius: 20, height: 43, physics: 1, base: actor, canJump: true, isPlayer: true, isWalking: false, hitSlopedWall: false, mass: 150,
    walkingPrelude(dt, iterations) { events.push({ prelude: dt, iterations }); return false; },
    move(delta) {
      events.push({ move: delta, velocity: [...this.velocity] });
      const at = mi++, r = c.moves[at];
      this.position = this.position.map((v, i) => f(v + f(delta[i] * f(r.time))));
      if (c.swimAtMove === at) this.physics = 3;
      return { ...r, time: f(r.time), normal: r.normal.map(f), actor: r.time < 1 ? actor : null };
    },
    lineCheck(start, end, extent, flags) {
      events.push({ line: { start: [...start], end, extent, flags } });
      const r = c.lines[li++]; return { ...r, time: f(r.time), normal: r.normal.map(f), actor: r.time < 1 ? actor : null };
    },
    setSupportBase(a) { this.base = a; events.push({ base: !!a }); }, setPhysics(p) { this.physics = p; events.push({ physics: p }); },
    farMove(pos) { this.position = [...pos]; events.push({ farMove: pos }); }, mayFall() { events.push({ event: 'MayFall' }); },
    fallingEvent() { events.push({ event: 'Falling' }); }, falling(dt, it) { events.push({ falling: dt, iterations: it }); },
    hitWall(h) { events.push({ wall: h.normal }); } };
  pawn.startSwimming = recordStart(events, pawn);
  walking(pawn, c.dt, c.iterations ?? 0);
  return Object.fromEntries(['position', 'velocity', 'acceleration', 'physics', 'hitSlopedWall'].map(k => [k, pawn[k]])
    .concat([['events', events], ['oldLocation', pawn.oldLocation]]));
}

// ---------------------------------------------------------------------------
const directory = path.resolve('reports/movement/native-swimming');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-swimming-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxError = 0;
function compare(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (!(Number.isNaN(actual) && Number.isNaN(expected))) maxError = Math.max(maxError, Math.abs(actual - expected));
    return Object.is(actual, expected);
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => compare(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const runners = { swim: runSwim, falling: runFalling, walking: runWalking }, sites = {};
const comparisons = cases.map((input, i) => {
  let actual;
  try { actual = runners[input.mode](input); } catch (error) { actual = { error: error.message }; }
  const original = native.results[i];
  // physFalling's surface-prelude traces and events run natively with clear
  // results (as in validate-native-falling); they are not part of this slice.
  const { site, ...result } = original;
  const expected = input.mode === 'falling' ? { ...result, events: result.events.filter(e => !e.line && !e.event) } : result;
  for (const name of site ?? []) sites[name] = (sites[name] ?? 0) + 1;
  if (!compare(actual, expected)) mismatches.push({ index: i });
  return { input, actual, expected };
});
const count = test => comparisons.filter(test).length;
const has = key => c => c.expected.events.some(e => key in e);
const summary = { binaryHashes: native.hashes, cases: cases.length,
  groups: { physSwimming: count(c => c.input.entry === 'physSwimming'), startSwimming: count(c => c.input.entry === 'startSwimming'),
    fallingHandoff: count(c => c.input.mode === 'falling'), walkingHandoff: count(c => c.input.mode === 'walking'),
    reachedStartSwimming: count(has('startSwimming')), waterLineSearches: count(has('pointRegion')), exitsToFalling: count(has('falling')),
    exitsToFlying: count(has('flying')), setPhysics: count(c => c.input.mode === 'swim' && has('physics')(c)), walls: count(has('wall')),
    handoffSites: sites },
  scope: 'startSwimming/physSwimming/Swim/findWaterLine with native calcVelocity, stepUp and TwoWallAdjust; physFalling/physWalking hand-offs; controlled MoveActor, PointRegion, prelude, processHitWall, setPhysics and continuations',
  comparison: 'exact float32 components, including signed zero, and movement/query/event sequence',
  // Instructions of the four original bodies that no case executed.
  uncoveredNative: native.uncovered, maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 4).map(({ index }) => ({ index, input: cases[index],
  actual: comparisons[index].actual, expected: comparisons[index].expected })), mismatchCount: mismatches.length }, null, 1).slice(0, 8000));
assert.equal(mismatches.length, 0, 'swimming agrees with the original for all sampled cases');
assert.equal(maxError, 0, 'swimming is bit-exact');
