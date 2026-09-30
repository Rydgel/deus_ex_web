/**
 * R3-b stage B3 (docs/rust-core.md): the Rust walking kernels
 * (native/script-vm/src/walk.rs, hosted by src/runtime/walk-kernel.mjs)
 * against their JavaScript references on seeded and edge inputs:
 *   Math.hypot (two arguments) against V8's own, in a hot loop;
 *   safeNormal, twoWallAdjust and groundVelocity (steps.mjs, velocity.mjs),
 *   every component by Object.is and every error;
 *   stepUp against a scripted pawn, comparing every view access in order
 *   (arguments by Object.is), the returned hit, the pawn's final state and
 *   errors, including the recursion budget.
 * The native oracles (validate-native-velocity, validate-native-steps) run
 * the kernel with WALK_KERNEL=rust.
 *
 *   node scripts/validate-walk-kernel.mjs [--scale 1]
 */
import assert from 'node:assert/strict';
import {groundVelocity} from '../src/runtime/velocity.mjs';
import {safeNormal, twoWallAdjust, stepUp} from '../src/runtime/steps.mjs';
import {loadWalkKernel} from '../src/runtime/walk-kernel.mjs';

const scaleArg = process.argv.indexOf('--scale');
const SCALE = scaleArg < 0 ? 1 : Number(process.argv[scaleArg + 1]);
const kernel = await loadWalkKernel();
const f = Math.fround;

let seed = 0x5eed1234;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(random() * list.length)];
const f64io = new DataView(new ArrayBuffer(8));
const bitsOf = x => { f64io.setFloat64(0, x, true); return f64io.getBigUint64(0, true); };
const fromBits = b => { f64io.setBigUint64(0, b, true); return f64io.getFloat64(0, true); };
const SPECIAL = [0, -0, NaN, Infinity, -Infinity, 1, -1, 5e-324, -5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, -1.7976931348623157e308, 1e-8, 1e-4, 0.0001, 0.03, 0.4, f(0.4), f(0.03), 144, 12];
/** A double of a random kind: a float32 in a game range, a tiny, a huge,
 * a subnormal, a random bit pattern, or a special. */
function number(range = 1000) {
  const r = random();
  if (r < 0.55) return f((random() * 2 - 1) * range);
  if (r < 0.65) return f((random() * 2 - 1) * 1e-3);
  if (r < 0.72) return (random() * 2 - 1) * 10 ** Math.floor(random() * 600 - 300);
  if (r < 0.77) return fromBits(BigInt(Math.floor(random() * 2 ** 32)) << 20n | BigInt(Math.floor(random() * 2 ** 20)));
  if (r < 0.85) return pick(SPECIAL) * (random() < 0.5 ? 1 : -1);
  return (random() * 2 - 1) * range;
}
const vector = (range = 1000) => [number(range), number(range), number(range)];
const unit = () => {
  const v = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
  return safeNormal(v);
};

const counts = {};
const count = key => { counts[key] = (counts[key] ?? 0) + 1; };
function same(actual, expected, where) {
  if (typeof expected === 'number') {
    if (!Object.is(actual, expected)) throw new Error(`${where}: ${actual} (0x${bitsOf(actual).toString(16)}) vs ${expected} (0x${bitsOf(expected).toString(16)})`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${where}: shape ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
    expected.forEach((value, i) => same(actual[i], value, `${where}[${i}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    const keys = Object.keys(expected);
    if (!actual || Object.keys(actual).join() !== keys.join()) throw new Error(`${where}: keys ${Object.keys(actual ?? {})} vs ${keys}`);
    for (const key of keys) same(actual[key], expected[key], `${where}.${key}`);
    return;
  }
  if (actual !== expected) throw new Error(`${where}: ${actual} vs ${expected}`);
}
const outcome = fn => { try { return {value: fn()}; } catch (error) { return {error: String(error.message)}; } };

// ---- Math.hypot -------------------------------------------------------------
{
  const n = Math.round(3_000_000 * SCALE);
  const as = new Float64Array(n), bs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = random();
    if (r < 0.5) { as[i] = number(); bs[i] = number(); }
    else if (r < 0.8) { as[i] = number(1e3); bs[i] = as[i] * (random() * 2e-8); }
    else { const e = Math.floor(random() * 2000 - 1000); as[i] = (random() * 2 - 1) * 2 ** e; bs[i] = (random() * 2 - 1) * 2 ** (e + Math.floor(random() * 60 - 30)); }
  }
  let checked = 0;
  // A hot loop, so V8 runs Math.hypot in its optimized tiers too.
  for (let round = 0; round < 2; round++) for (let i = 0; i < n; i++) {
    const expected = Math.hypot(as[i], bs[i]), actual = kernel.hypot(as[i], bs[i]);
    if (!Object.is(actual, expected)) throw new Error(`hypot(${as[i]}, ${bs[i]}): ${actual} vs ${expected}`);
    checked++;
  }
  for (const a of SPECIAL) for (const b of SPECIAL) for (const [x, y] of [[a, b], [-a, b], [a, -b]])
    same(kernel.hypot(x, y), Math.hypot(x, y), `hypot(${x}, ${y})`), checked++;
  counts.hypot = checked;
}

// ---- safeNormal and twoWallAdjust ------------------------------------------
{
  const n = Math.round(1_000_000 * SCALE);
  for (let i = 0; i < n; i++) {
    const r = random();
    const v = r < 0.3 ? vector(1e-4) : r < 0.4 ? unit().map(x => f(x * 1e-4 * (0.99 + random() * 0.02))) : vector();
    same(kernel.safeNormal(v), safeNormal(v), `safeNormal(${v})`);
  }
  counts.safeNormal = n;
  for (let i = 0; i < n; i++) {
    const normal = random() < 0.7 ? unit() : vector(2), oldNormal = random() < 0.2 ? normal.map(x => -x) : random() < 0.7 ? unit() : vector(2);
    const input = {desired: random() < 0.7 ? unit() : vector(2), delta: vector(128), normal, oldNormal,
      time: random() < 0.8 ? f(random()) : number(2)};
    same(kernel.twoWallAdjust(input), twoWallAdjust(input), `twoWallAdjust(${JSON.stringify(input)})`);
  }
  counts.twoWallAdjust = n;
}

// ---- groundVelocity --------------------------------------------------------
{
  const n = Math.round(1_000_000 * SCALE);
  for (let i = 0; i < n; i++) {
    const r = random();
    const rate = random() < 0.9 ? pick([500, 1000, 2048, f(random() * 4000)]) : number();
    // Accelerations at the walking and running limits (|a| = accelRate * 0.3
    // or accelRate), and a float32 step either side.
    const along = unit(), limit = f(rate * pick([0.3, 1])), nudge = pick([1, 1 + 2 ** -23, 1 - 2 ** -24]);
    const acceleration = r < 0.3 ? [0, pick([0, -0]), pick([0, -0])] : r < 0.45 ? along.map(v => f(v * limit * nudge))
      : r < 0.9 ? [number(3000), number(3000), random() < 0.8 ? 0 : number(100)] : vector();
    const size = Math.hypot(...acceleration);
    const input = {
      velocity: random() < 0.9 ? [number(600), number(600), random() < 0.7 ? 0 : number(600)] : vector(1e6),
      acceleration,
      direction: random() < 0.85 ? acceleration.map(v => size ? f(v / size) : 0) : vector(2),
      dt: random() < 0.9 ? f(0.001 + random() * 0.399) : pick([0, -0, NaN, 0.4, f(0.4), 0.4000001, -0.1, 1, 0.03, f(0.03), 0.06, 5e-324, Infinity]),
      maxSpeed: random() < 0.9 ? pick([100, 208, 320, 600, f(random() * 1000)]) : number(),
      accelRate: rate,
      friction: random() < 0.9 ? pick([0, 4, 8, 64, f(random() * 20)]) : number(100),
      walking: random() < 0.5,
    };
    const expected = outcome(() => groundVelocity(input)), actual = outcome(() => kernel.groundVelocity(input));
    same(actual, expected, `groundVelocity(${JSON.stringify(input)})`);
    count(expected.error ? 'groundVelocity error' : 'groundVelocity');
  }
}

// ---- stepUp ------------------------------------------------------------------
/** A scripted pawn: every view access is logged; moves answer from a seeded
 * script. The same seed gives the same answers to the same accesses, so the
 * two implementations see the same world exactly when they access it the
 * same way. */
function scriptedPawn(caseSeed, config) {
  let s = caseSeed;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  const log = [], moves = [];
  const actorOf = kind => {
    if (kind === 0) return null;
    const actor = {};
    Object.defineProperty(actor, 'pushableDecoration', {get() { log.push(['pushable', moves.length]); return kind === 2 || (kind === 3 ? 1 : kind === 4 ? 0 : undefined); }});
    Object.defineProperty(actor, 'mass', {get() { log.push(['actorMass', moves.length]); return config.actorMass; }});
    return actor;
  };
  let physics = config.physics, velocity = config.velocity, justTeleported = undefined;
  const pawn = {
    get maxStepHeight() { log.push(['maxStepHeight']); return config.maxStepHeight; },
    get physics() { log.push(['physics']); return physics; },
    set physics(v) { physics = v; },
    get isPlayer() { log.push(['isPlayer']); return config.isPlayer; },
    get mass() { log.push(['mass']); return config.mass; },
    get velocity() { log.push(['velocity']); return velocity; },
    set velocity(v) { log.push(['setVelocity', ...v]); velocity = v; },
    get justTeleported() { return justTeleported; },
    set justTeleported(v) { log.push(['justTeleported', v]); justTeleported = v; },
    hitWall(hit) {
      log.push(['hitWall', moves.indexOf(hit)]);
      if (config.throwAt === log.length) throw new Error('scripted HitWall error');
      if (rnd() < config.wallFalls) physics = 2;
    },
    move(delta) {
      log.push(['move', ...delta]);
      if (config.throwAt === log.length) throw new Error('scripted MoveActor error');
      const r = rnd();
      const time = r < config.clear ? 1 : r < 0.93 ? f(rnd()) : pick2(rnd, [0, 1, -0, NaN, 1.0000001, -0.5, 0.99999994, 2]);
      const nr = rnd();
      const normal = nr < 0.25 ? [0, 0, pick2(rnd, [1, -1])] : nr < 0.5 ? steepish(rnd) : nr < 0.9 ? rndUnit(rnd) : [rndNum(rnd), rndNum(rnd), rndNum(rnd)];
      const hit = {time, normal, actor: actorOf(Math.floor(rnd() * 5 * config.actors))};
      moves.push(hit);
      return hit;
    },
  };
  return {pawn, log, moves, state: () => ({physics, velocity: velocity.slice(), justTeleported})};
}
const pick2 = (rnd, list) => list[Math.floor(rnd() * list.length)];
const rndNum = rnd => { const r = rnd(); return r < 0.2 ? pick2(rnd, [0, -0, NaN, Infinity, -Infinity, 1e-30, 1e30]) : f(rnd() * 4 - 2); };
const rndUnit = rnd => safeNormal([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
/** Normals near stepUp's thresholds: |z| around 0.2 and z around 0.5. */
const steepish = rnd => {
  const z = pick2(rnd, [0.2, -0.2, 0.19999, 0.20001, 0.5, 0.49999, 0.50001, 0, f(rnd() * 0.6 - 0.3)]);
  const h = Math.sqrt(Math.max(0, 1 - z * z)), a = rnd() * 2 * Math.PI;
  // Hosts may hand back unrounded normals: keep z exact half the time.
  return [f(h * Math.cos(a)), f(h * Math.sin(a)), rnd() < 0.5 ? z : f(z)];
};
{
  const n = Math.round(200_000 * SCALE);
  for (let i = 0; i < n; i++) {
    const caseSeed = Math.floor(random() * 2 ** 32);
    const config = {
      physics: 1, maxStepHeight: random() < 0.9 ? pick([25, 24, 16, f(random() * 40)]) : number(100),
      isPlayer: random() < 0.6, mass: pick([150, 100, 20, number(1000)]), actorMass: pick([20, 100, 1000, 0, number(500)]),
      velocity: [number(600), number(600), number(100)], clear: pick([0.2, 0.4, 0.6]), wallFalls: pick([0, 0.1, 0.5]),
      actors: pick([0, 1, 1]), throwAt: random() < 0.02 ? 1 + Math.floor(random() * 40) : -1,
    };
    const gravity = random() < 0.9 ? [0, 0, pick([-1, 1])] : vector(2);
    const delta = random() < 0.85 ? unit().map(v => f(v * (random() < 0.5 ? 64 : random() * 30))) : vector(200);
    const desired = random() < 0.8 ? safeNormal(delta) : unit();
    const js = scriptedPawn(caseSeed, config), rust = scriptedPawn(caseSeed, config);
    const expected = outcome(() => js.moves.indexOf(stepUp(js.pawn, gravity, desired, delta)));
    const actual = outcome(() => rust.moves.indexOf(kernel.stepUp(rust.pawn, gravity, desired, delta)));
    const where = `stepUp case ${i} (seed ${caseSeed})`;
    same(actual, expected, `${where} result`);
    same(rust.log, js.log, `${where} accesses`);
    same(rust.state(), js.state(), `${where} final state`);
    count(expected.error ? `stepUp error: ${expected.error}` : 'stepUp');
    counts.stepUpAccesses = (counts.stepUpAccesses ?? 0) + js.log.length;
  }
  // The recursion budget: a pawn whose every forward move hits a vertical
  // wall far enough away to recurse again.
  const deep = {time: 0.001, normal: [-1, 0, 0], actor: null}, flat = {time: 1, normal: [0, 0, 1], actor: null};
  const budgetPawn = () => {
    let n = 0;
    return {maxStepHeight: 25, physics: 1, isPlayer: false, mass: 1, velocity: [0, 0, 0],
      hitWall() {}, move() { n++; return n % 2 ? flat : deep; }, get n() { return n; }};
  };
  const a = budgetPawn(), b = budgetPawn();
  const expected = outcome(() => stepUp(a, [0, 0, -1], [1, 0, 0], [1e6, 0, 0]));
  const actual = outcome(() => kernel.stepUp(b, [0, 0, -1], [1, 0, 0], [1e6, 0, 0]));
  same(actual, expected, 'stepUp recursion budget');
  same(b.n, a.n, 'stepUp recursion budget moves');
  assert.match(expected.error ?? '', /recursion budget/);
  counts.budget = a.n;
}

console.log(`validate-walk-kernel: identical to the JavaScript references: ${JSON.stringify(counts)}`);
