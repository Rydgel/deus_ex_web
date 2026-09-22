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
// class-gated integration branches (Path A PlayerPawn, and the Decoration bBobbing
// half-gravity branch at 0x103d0f42), taking
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
// Non-Pawn with a nonzero Acceleration: the native skips the whole Pawn
// air-control/clamp block (0x103d0bca -> 0x103d0e0c), keeping Acceleration.Z.
for (const acceleration of [[300, -200, 150], [-2400, 2400, -600], [0, 0, 800]]) for (const dt of [1 / 60, .1, .4]) {
  addCase([90, -20, 40], acceleration, dt, { ...decoration, airControl: f(.9), groundSpeed: 10, gravity: [0, 0, -950], terminalVelocity: 2000,
    responses: [clear, hit(.4, [0, 0, 1]), ...Array(30).fill(clear)] });
}

// bBounce (actor+0x1ec bit 0x10) on a real fragment ancestry (WoodFragment ->
// DeusExFragment -> Fragment -> AProjectile): every blocked move dispatches the
// script HitWall directly, floors included; `hitWallMode` selects the controlled
// script body (hit_wall_script in the oracle, hitWallScript below).
const fragment = { ancestry: 'fragment', nonPawn: true, bounce: true, acceleration: [0, 0, 0], airControl: 0,
  elasticity: f(.4), gravity: [0, 0, -950], terminalVelocity: 2500, position: [-804.27, 1125.16, -84.02].map(f) };
const modes = ['none', 'reflect', 'stop', 'fragment', 'clearBounce'];
for (const hitWallMode of modes) for (const normal of [[0, 0, 1], [.6, 0, .8], [-1, 0, 0], [0, 0, -1], [.8, 0, .6]]) {
  for (const time of [0, .25, .9]) for (const dt of [1 / 60, .1, .4]) {
    addCase([120, -40, -300], [0, 0, 0], dt, { ...fragment, hitWallMode, responses: [hit(time, normal), ...Array(31).fill(clear)] });
  }
}
// Repeated contacts in one call: only the first two bounces refund time; the
// 8-iteration bound still ends the call. A time-0 double contact is "stuck".
const floor = hit(.5, [0, 0, 1]), wall = hit(.3, [-1, 0, 0]), stuck = hit(0, [-1, 0, 0]);
for (const hitWallMode of ['none', 'reflect', 'fragment', 'clearBounce']) for (const dt of [.1, .4]) {
  addCase([200, 60, -500], [0, 0, 0], dt, { ...fragment, hitWallMode, responses: Array(32).fill(floor) });
  addCase([200, 60, -500], [0, 0, 0], dt, { ...fragment, hitWallMode, responses: [wall, floor, wall, clear, floor, ...Array(27).fill(clear)] });
  addCase([200, 60, -500], [0, 0, 0], dt, { ...fragment, hitWallMode, responses: [stuck, stuck, stuck, ...Array(29).fill(clear)] });
}
for (const elasticity of [.2, .5, .8]) for (const velocity of [[40, 0, -30], [0, 0, -61], [500, -300, 900]]) {
  addCase(velocity, [0, 0, 0], .2, { ...fragment, hitWallMode: 'fragment', elasticity: f(elasticity), zoneVelocity: [12, -6, 0],
    responses: [hit(.6, [0, 0, 1]), hit(.2, [0, .6, .8]), hit(.9, [0, 0, 1]), ...Array(29).fill(clear)] });
}
// A bouncing source with nonzero Acceleration, and a bouncing Pawn (the prelude runs).
for (const dt of [1 / 30, .3]) {
  addCase([60, 10, -80], [100, 50, -40], dt, { ...fragment, hitWallMode: 'reflect', responses: [hit(.5, [0, 0, 1]), ...Array(31).fill(clear)] });
  addCase([60, 10, -80], [2400, 0, 0], dt, { bounce: true, hitWallMode: 'reflect', elasticity: f(.5), airControl: f(.3), responses: [hit(.5, [0, 0, 1]), ...Array(31).fill(clear)] });
}
// A touch/bump that destroys the source during MoveActor (bDeleteMe) ends physics.
for (const deleteAtMove of [0, 1]) for (const bounce of [false, true]) {
  addCase([100, 0, -100], [0, 0, 0], .2, { ...fragment, bounce, hitWallMode: 'reflect', deleteAtMove,
    responses: [hit(.5, [-1, 0, 0]), hit(.5, [0, 0, 1]), ...Array(30).fill(clear)] });
}
// Inventory ancestry (Lockpick -> ... -> AInventory): the non-bouncing non-Pawn
// path, landing through processLanded and walls through processHitWall.
const inventory = { ancestry: 'inventory', nonPawn: true, acceleration: [0, 0, 0], airControl: 0, gravity: [0, 0, -950], terminalVelocity: 2500 };
for (const dt of [1 / 60, .1, .4]) for (const velocity of [[0, 0, 0], [150, 20, 200], [-80, 60, -400]]) {
  for (const responses of [Array(32).fill(clear), [hit(.4, [0, 0, 1]), ...Array(31).fill(clear)], [hit(.3, [-1, 0, 0]), hit(.5, [0, 0, 1]), ...Array(30).fill(clear)]]) {
    addCase(velocity, [0, 0, 0], dt, { ...inventory, responses });
  }
}
// Seeded bouncing fragments: random velocities, contacts and script bodies.
for (let i = 0; i < 150; i++) addCase(vector(1500), [0, 0, 0], .005 + random() * .395, { ...fragment,
  position: vector(2000), elasticity: f(.2 + random() * .6), zoneVelocity: vector(20), terminalVelocity: f(500 + random() * 2500),
  hitWallMode: modes[Math.floor(random() * modes.length)],
  responses: [...Array.from({ length: 8 }, () => random() < .5 ? hit(random() < .2 ? 0 : random(), safeNormal(vector(1))) : clear), ...Array(24).fill(clear)] });

/** Controlled script HitWall body, identical to hit_wall_script in the oracle. */
function hitWallScript(pawn, input, normal, state) {
  const mode = input.hitWallMode ?? 'none';
  const reflect = v => {
    const e = f(input.elasticity), d = f((v[0] * normal[0] + v[1] * normal[1]) + v[2] * normal[2]);
    return v.map((a, i) => f(e * f(f(f(d * normal[i]) * -2) + a)));
  };
  const stop = () => { pawn.physics = 0; pawn.velocity = [0, 0, 0]; pawn.acceleration = [0, 0, 0]; pawn.bBounce = false; };
  if (mode === 'none') return;
  if (mode === 'stop') return stop();
  if (mode === 'clearBounce') { pawn.bBounce = false; return; }
  if (mode === 'reflect') { pawn.velocity = reflect(pawn.velocity); return; }
  if (mode !== 'fragment') throw new Error(`Unknown hitWallMode ${mode}`);
  const location = [...pawn.position];
  const v = location.every((c, i) => c === state.lastHit[i]) ? [0, 0, 0] : reflect(pawn.velocity);
  pawn.velocity = v;
  const speed = f(Math.sqrt((v[0] * v[0] + v[1] * v[1]) + v[2] * v[2]));
  if ((speed < 60 && normal[2] > .7) || speed === 0) stop();
  state.lastHit = location;
}

function run(input) {
  const events = [], state = { lastHit: [0, 0, 0] }, pawn = { ...structuredClone(input), physics: 2, airControlBlocked: () => input.airBlocked,
    move(delta) {
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      const response = input.responses[index++];
      if (!response) throw new Error('Missing explicit MoveActor response');
      pawn.position = pawn.position.map((value, axis) => f(value + f(delta[axis] * response.time)));
      if (input.deleteAtMove === index - 1) pawn.bDeleteMe = true;
      return { ...response, actor: response.time < 1 ? 'level' : null };
    },
    hitWall(hit) { events.push({ wall: [...hit.normal] }); },
    landed(hit, remaining, iterations) { events.push({ landed: [...hit.normal], remaining, iterations, velocity: [...pawn.velocity] }); pawn.physics = 1; },
  };
  if (input.bounce) pawn.bBounce = true;
  let index = 0;
  falling(pawn, input.dt, 0, { nonPawn: Boolean(input.nonPawn), bounce: Boolean(input.bounce),
    hitWallEvent(normal, actor) {
      events.push({ hitWallEvent: normal, actor, velocity: [...pawn.velocity] });
      hitWallScript(pawn, input, normal, state);
    } });
  const result = { position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration, physics: pawn.physics, events };
  if (input.bounce || input.ancestry) result.bounce = Boolean(pawn.bBounce);
  return result;
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
const count = test => cases.filter(test).length;
const summary = { binaryHashes: native.hashes, cases: cases.length,
  groups: { pawn: count(c => !c.nonPawn), nonPawn: count(c => c.nonPawn && !c.bounce), bounce: count(c => c.bounce),
    fragmentAncestry: count(c => c.ancestry === 'fragment'), inventoryAncestry: count(c => c.ancestry === 'inventory') },
  scope: 'dry player, non-Pawn (decoration/fragment/inventory ancestry) and bBounce falling with controlled world, processHitWall, processLanded and script HitWall callbacks; auxiliary surface queries clear',
  comparison: 'exact float32 components, including signed zero, and movement/event sequence', maxError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 15), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'falling agrees with original physFalling for all sampled cases');
assert.equal(maxError, 0, 'falling is bit-exact');
