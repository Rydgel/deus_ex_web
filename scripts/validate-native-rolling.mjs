import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { rolling } from '../src/runtime/rolling.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround;
const PHYS_ROLLING = 7, PHYS_FALLING = 2;
const cases = [];
const zone = (over = {}) => ({ ZoneGravity: [0, 0, -950], ZoneVelocity: [0, 0, 0], ZoneGroundFriction: 8, ZoneFluidFriction: f(.02), ZoneTerminalVelocity: 2500, ...over });
const addCase = (position, velocity, acceleration, dt, over = {}) => cases.push({
  position: position.map(f), velocity: velocity.map(f), acceleration: acceleration.map(f), dt: f(dt),
  iterations: 0, physics: PHYS_ROLLING, justTeleported: false, base: 0, walls: [], zone: zone(), ...over });

// Sliding on a flat floor: friction decay, substep halving, and the final
// displacement-derived velocity.
for (const dt of [.005, 1 / 120, 1 / 30, .05, .1, .2, .4]) {
  for (const velocity of [[0, 0, 0], [100, 0, 0], [0, 100, 0], [100, 100, 0], [-100, 40, 0], [0, 0, 0]]) {
    addCase([0, 0, 10], velocity, [0, 0, 0], dt);
  }
}
for (const dt of [.1, .2]) {
  for (const groundFriction of [0, .5, 1, 4, 8, 16, 64]) for (const fluidFriction of [0, .02, .5]) {
    addCase([0, 0, 10], [200, -50, 0], [0, 0, 0], dt, { zone: zone({ ZoneGroundFriction: groundFriction, ZoneFluidFriction: fluidFriction }) });
  }
}
for (const dt of [.1, .2]) {
  addCase([0, 0, 10], [100, 0, 0], [400, 0, 0], dt);
  addCase([0, 0, 10], [100, 0, 0], [-400, 300, 0], dt);
  addCase([0, 0, 10], [50, 20, 0], [0, 0, 0], dt, { zone: zone({ ZoneGravity: [40, -25, -1200], ZoneVelocity: [12, -6, 0] }) });
}
// Walls: eventHitWall sliding along an axis wall on the floor.
for (const dt of [.1, .2]) for (const walls of [[[0, 1, 5]], [[1, 1, 5]], [[0, 1, 5], [1, 1, 5]]]) {
  addCase([0, 0, 2], [150, 60, 0], [0, 0, 0], dt, { walls });
}
// bBounce wall contact (thrown objects): the 0x103d4fd3 branch dispatches HitWall,
// refunds (1-Hit.Time)*timeTick for the first two bounces, and skips the slide,
// dropping straight to the floor. Vary approach speed, wall placement and dt so the
// repeated bounces exhaust the two-bounce refund cap and re-enter the move loop.
for (const dt of [.1, .2, .4]) for (const walls of [[[0, 1, 5]], [[1, 1, 5]], [[0, 1, 5], [1, 1, 5]]]) {
  for (const velocity of [[150, 60, 0], [400, 120, 0], [60, 240, 0]]) {
    addCase([0, 0, 2], velocity, [0, 0, 0], dt, { walls, bounce: true });
  }
}
// Sloped floors: the downward probe reports DropHitZ<1, exercising the slope
// slide and the DropHitZ<0.7 falling transition.
for (const floorNormal of [[.6, 0, .8], [0, .6, .8], [.8, 0, .6], [0, 0, 1]]) {
  for (const groundFriction of [.1, 1, 3, 4, 8, 16]) for (const dt of [.1, .2]) {
    for (const velocity of [[120, 0, 0], [0, 80, 0], [60, 40, 0], [0, 0, 0]]) {
      addCase([0, 0, 10], velocity, [0, 0, 0], dt, { floorNormal, zone: zone({ ZoneGroundFriction: groundFriction }) });
    }
  }
}
// Airborne: no floor contact -> Falling transition and physFalling boundary.
for (const dt of [.1, .2]) for (const velocity of [[0, 0, 0], [80, 0, 0], [80, -40, 0]]) {
  addCase([0, 0, 1000], velocity, [0, 0, 0], dt);
}

function worldHit(start, delta, walls, floorNormal) {
  const floor = floorNormal ?? [0, 0, 1];
  let time = 1, normal = [0, 0, 0];
  const depth = floor[0] * delta[0] + floor[1] * delta[1] + floor[2] * delta[2];
  if (depth < 0) {
    const candidate = -(floor[0] * start[0] + floor[1] * start[1] + floor[2] * start[2]) / depth;
    if (candidate >= 0 && candidate < time) { time = candidate; normal = floor.slice(); }
  }
  for (const [axis, sign, plane] of walls) {
    if (delta[axis] * sign > 0) {
      const candidate = (plane - start[axis]) / delta[axis];
      if (candidate >= 0 && candidate < time) { time = candidate; normal = [0, 0, 0]; normal[axis] = sign; }
    }
  }
  return { time, normal };
}

function run(input) {
  const events = [];
  const host = { position: input.position.map(f), velocity: input.velocity.map(f), acceleration: input.acceleration.map(f),
    physics: input.physics, base: input.base ?? null, justTeleported: false, oldLocation: [0, 0, 0] };
  const walls = input.walls ?? [], floorNormal = input.floorNormal;
  const services = {
    zone: input.zone,
    bounce: input.bounce ?? false,
    move(delta) {
      const start = host.position.map(f);
      const { time, normal } = worldHit(start, delta, walls, floorNormal);
      const location = start.map((value, axis) => f(value + f(delta[axis] * time)));
      host.position = location;
      const hit = { time: f(time), normal: normal.map(f), actor: null };
      events.push({ move: delta.map(f), time: hit.time, normal: hit.normal, position: location.slice() });
      return hit;
    },
    eventHitWall(normal, actor) { events.push({ event: 'HitWall' }); },
    eventFalling() { events.push({ event: 'Falling' }); },
    setPhysics(next) { host.physics = next; if (next === PHYS_FALLING) host.base = null; },
    physFalling(remaining, iterations) { events.push({ physFalling: [f(remaining), iterations] }); },
    setBase(actor) { host.base = actor; },
  };
  rolling(host, input.dt, services);
  return { position: host.position, oldLocation: host.oldLocation, velocity: host.velocity, acceleration: host.acceleration,
    physics: host.physics, base: host.base ?? 0, events };
}

const directory = path.resolve('reports/movement/native-rolling');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-rolling-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxError = 0;
// Every float32 component is bit-exact: the friction prelude, per-axis products,
// fluid step, slope slide, wall slide, falling-time refund and both velocity stores
// match the original to the last bit. The earlier sub-ULP residual came from rounding
// four x87-extended intermediates to float32 (the wall-slide 1-Hit.Time, the
// falling-transition divisor, DesiredDist, and the refund accumulation); each now
// keeps the original precision. docs/rolling.md records the exact model.
const TOLERANCE = 0;
function compare(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    maxError = Math.max(maxError, Math.abs(actual - expected)); return Math.abs(actual - expected) <= TOLERANCE;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.map(key => compare(actual[key], expected[key])).every(Boolean);
  }
  return actual === expected;
}
const comparisons = cases.map((input, i) => {
  const actual = run(input), original = native.results[i];
  if (!compare(actual, original)) mismatches.push({ index: i });
  return { input, actual, original };
});
const summary = { binaryHashes: native.hashes, cases: cases.length,
  scope: 'physRolling on a controlled floor/wall world with explicit HitWall/Falling/physFalling boundaries',
  comparison: `event sequence and float32 components within ${TOLERANCE} (exact friction/fluid prelude; sub-ULP sloped-slide residual)`,
  tolerance: TOLERANCE, maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'rolling agrees with original physRolling for all sampled cases');
