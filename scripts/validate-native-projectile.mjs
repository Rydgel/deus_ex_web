/** Validate src/runtime/projectile.mjs against the original AActor::physProjectile
 * (Engine.dll 0x103d4600) executed by scripts/native-projectile-oracle.py on a
 * controlled floor/wall world (docs/projectile.md). Every float32 is compared
 * as its bit pattern, so NaN and indefinite results count too; the oracle's
 * coverage of the body must be complete. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { projectile } from '../src/runtime/projectile.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround;
const io = new DataView(new ArrayBuffer(4));
const bits = v => (io.setFloat32(0, f(v), true), io.getUint32(0, true));
const num = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
const INF = 0x7f800000, NAN = 0x7fc00001;
const cases = [];
const push = (position, velocity, dt, over = {}) => {
  const { acceleration = [0, 0, 0], maxSpeedValue = 4000, friction = 0, ...rest } = over;
  cases.push({ position: position.map(bits), velocity: velocity.map(v => typeof v === 'object' ? v.bits : bits(v)),
    acceleration: acceleration.map(bits), dt: bits(dt), maxSpeed: bits(maxSpeedValue), fluidFriction: bits(friction), ...rest });
};
const DTS = [1 / 120, 1 / 60, 1 / 30, .05, .1, .25];
// Free flight (a Tracer): displacement velocity, the MaxSpeed clamp and its IsA.
for (const dt of DTS) for (const velocity of [[4000, 0, 0], [2000, 1500, -300], [-3000, 2500, 900], [0, 0, 0], [123.456, -7.25, 0.1]]) {
  push([10, -20, 30], velocity, dt);
  push([10, -20, 30], velocity, dt, { maxSpeedValue: 1000 });
  push([10, -20, 30], velocity, dt, { projectile: false, maxSpeedValue: 1000 });
}
// Acceleration and the fluid friction factor (Region.Zone bWaterZone).
for (const dt of DTS) for (const friction of [0, .3, 1.2, 4, 20]) {
  push([0, 0, 500], [800, -200, 50], dt, { acceleration: [0, 0, -950], water: true, friction });
  push([0, 0, 500], [800, -200, 50], dt, { acceleration: [30, -40, -950], water: friction > 1, friction, maxSpeedValue: 700 });
}
// Walls: HitWall without bBounce ends the loop; with bBounce the refund
// (1 - Time) * timeTick for the first two bounces, the PHYS_Falling hand-off,
// and each script double.
const corridor = [[0, 1, 60], [0, -1, -60]];
for (const dt of [1 / 30, .1, .25]) for (const velocity of [[2000, 300, 0], [900, -900, 20], [-4000, 0, 0]]) {
  push([0, 0, 50], velocity, dt, { walls: corridor });
  push([0, 0, 50], velocity, dt, { walls: [[1, 1, 30]], floorNormal: [0, 0, 1] });
  for (const hitWallMode of ['none', 'reflect', 'stop', 'clearBounce', 'falling', 'destroy', 'teleport'])
    push([0, 0, 50], velocity, dt, { walls: corridor, bounce: true, hitWallMode, elasticity: .6 });
}
// Moves that destroy or teleport the actor, a teleport flag already set, the
// zone-0 destroy, the iteration cap.
push([0, 0, 50], [2000, 300, 0], .1, { walls: corridor, deleteAtMove: 0 });
push([0, 0, 50], [2000, 300, 0], .1, { walls: corridor, teleportAtMove: 0 });
push([0, 0, 50], [2000, 300, 0], .1, { walls: corridor, bounce: true, hitWallMode: 'reflect', elasticity: 1, deleteAtMove: 1 });
push([0, 0, 50], [2000, 300, 0], .1, { justTeleported: true });
push([0, 0, 50], [2000, 300, 0], .1, { zoneNumber: 0 });
for (const iterations of [6, 7, 8]) push([0, 0, 50], [2000, 300, 0], .1, { walls: corridor, bounce: true, hitWallMode: 'reflect', elasticity: 1, iterations });
// Edges: no time (the 0 * inf indefinite velocity), negative time, non-finite
// velocities through the clamp's unordered compare and SafeNormal.
push([0, 0, 50], [100, 0, 0], 0);
push([0, 0, 50], [100, 0, 0], -.1);
push([0, 0, 50], [{ bits: NAN }, 5, 0], .1);
push([0, 0, 50], [{ bits: NAN }, 5, 0], .1, { projectile: false });
push([0, 0, 50], [{ bits: INF }, 5, 0], .1);

function worldHit(start, delta, walls, floor) {
  let time = 1, normal = [0, 0, 0];
  if (floor) {
    const depth = floor[0] * delta[0] + floor[1] * delta[1] + floor[2] * delta[2];
    if (depth < 0) {
      const candidate = -(floor[0] * start[0] + floor[1] * start[1] + floor[2] * start[2]) / depth;
      if (candidate >= 0 && candidate < time) { time = candidate; normal = floor.slice(); }
    }
  }
  for (const [axis, sign, plane] of walls) {
    if (delta[axis] * sign > 0) {
      const candidate = (plane - start[axis]) / delta[axis];
      if (candidate >= 0 && candidate < time) { time = candidate; normal = [0, 0, 0]; normal[axis] = sign; }
    }
  }
  return { time, normal };
}

/** The oracle's script doubles (native-falling-oracle.py hit_wall_script). */
function hitWallScript(actor, mode, normal, elasticity) {
  const stop = () => { actor.physics = 0; actor.velocity = [0, 0, 0]; actor.acceleration = [0, 0, 0]; actor.bBounce = false; };
  if (mode === 'none') return;
  if (mode === 'stop') return stop();
  if (mode === 'clearBounce') { actor.bBounce = false; return; }
  if (mode === 'falling') { actor.physics = 2; return; }
  if (mode === 'destroy') { actor.bDeleteMe = true; return; }
  if (mode === 'teleport') { actor.justTeleported = true; return; }
  if (mode === 'reflect') {
    const e = f(elasticity), v = actor.velocity;
    const d = f((v[0] * normal[0] + v[1] * normal[1]) + v[2] * normal[2]);
    actor.velocity = v.map((a, i) => f(e * f(f(f(d * normal[i]) * -2.0) + a)));
    return;
  }
  throw new Error(`unknown hitWallMode ${mode}`);
}

function run(input) {
  const events = [];
  const actor = {
    position: input.position.map(num), oldPosition: [0, 0, 0].map(() => num(0xa5a5a5a5)),
    velocity: input.velocity.map(num), acceleration: input.acceleration.map(num), physics: 6,
    bBounce: Boolean(input.bounce), justTeleported: Boolean(input.justTeleported), bDeleteMe: false,
    zoneNumber: input.zoneNumber ?? 1, regionWater: Boolean(input.water), fluidFriction: num(input.fluidFriction),
    maxSpeed: input.projectile === false ? null : num(input.maxSpeed),
  };
  let moves = 0;
  projectile(actor, num(input.dt), input.iterations ?? 0, {
    destroy() { events.push({ destroy: 0 }); },
    move(delta) {
      const start = actor.position;
      const { time, normal } = worldHit(start, delta, input.walls ?? [], input.floorNormal);
      actor.position = start.map((value, axis) => f(value + f(delta[axis] * time)));
      events.push({ move: delta.map(bits), time: f(time), normal: normal.map(f) });
      if (input.deleteAtMove === moves) actor.bDeleteMe = true;
      if (input.teleportAtMove === moves) actor.justTeleported = true;
      moves++;
      return { time: f(time), normal: normal.map(f), actor: time < 1 ? 'level' : null };
    },
    hitWall(normal, wall) {
      events.push({ hitWall: normal.map(bits), actor: wall });
      hitWallScript(actor, input.hitWallMode ?? 'none', normal, input.elasticity);
    },
    physFalling(remaining, iterations) { events.push({ physFalling: [bits(remaining), iterations] }); },
  });
  return { position: actor.position.map(bits), oldPosition: actor.oldPosition.map(bits), velocity: actor.velocity.map(bits),
    physics: actor.physics, bounce: actor.bBounce, justTeleported: actor.justTeleported, events };
}

const directory = path.resolve('reports/movement/native-projectile');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-projectile-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);
const mismatches = [];
const comparisons = cases.map((input, index) => {
  const actual = run(input), original = native.results[index];
  try { assert.deepStrictEqual(actual, original); } catch { mismatches.push(index); }
  return { input, actual, original };
});
const counts = { cases: cases.length, bounceCases: cases.filter(c => c.bounce).length, hitWalls: 0, physFalling: 0, destroys: 0, nanVelocities: 0 };
for (const { original } of comparisons) {
  for (const event of original.events) {
    if (event.hitWall) counts.hitWalls++;
    if (event.physFalling) counts.physFalling++;
    if ('destroy' in event) counts.destroys++;
  }
  if (original.velocity.some(b => (b & 0x7fffffff) > 0x7f800000)) counts.nanVelocities++;
}
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ hashes: native.hashes, uncovered: native.uncovered, mismatches, comparisons }, null, 2));
console.log(JSON.stringify({ ...counts, uncovered: native.uncovered, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }));
assert.equal(mismatches.length, 0, 'projectile.mjs agrees bit for bit with the original physProjectile');
assert.deepEqual(native.uncovered, [], 'every physProjectile instruction is executed by some case');
console.log(`physProjectile: ${cases.length} cases bit-exact against Engine.dll 0x103d4600, full instruction coverage.`);
