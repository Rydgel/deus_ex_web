import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { groundVelocity as groundVelocityJs } from '../src/runtime/velocity.mjs';
import { loadWalkKernel } from '../src/runtime/walk-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';

// WALK_KERNEL=rust compares the Rust kernel (walk.rs, R3-b B3) instead.
const groundVelocity = process.env.WALK_KERNEL === 'rust' ? (await loadWalkKernel()).groundVelocity : groundVelocityJs;
const cases = [], f = Math.fround;
const addCase = (velocity, acceleration, dt, walking, friction = 8, maxSpeed = 320, accelRate = 1000) => {
  acceleration = acceleration.map(f);
  const size = Math.hypot(...acceleration);
  cases.push({ velocity: velocity.map(f), acceleration, direction: acceleration.map(v => size ? f(v / size) : 0),
    dt: f(dt), walking, friction: f(friction), maxSpeed: f(maxSpeed), accelRate: f(accelRate) });
};
for (const dt of [.005, 1 / 120, 1 / 60, .03, 1 / 30, .1, .4]) for (const walking of [false, true]) {
  for (const velocity of [[0, 0, 0], [1, 0, 0], [10, 0, 0], [100, 0, 0], [320, 0, 0], [300, -80, 0]]) {
    for (const acceleration of [[0, 0, 0], [1000, 0, 0], [0, 1000, 0], [-1000, 1000, 0], [20, -20, 0]]) {
      addCase(velocity, acceleration, dt, walking);
    }
  }
}
let seed = 7129;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 400; i++) {
  const velocity = [random() * 1000 - 500, random() * 1000 - 500, 0];
  const acceleration = i % 4 ? [random() * 3000 - 1500, random() * 3000 - 1500, 0] : [0, 0, 0];
  addCase(velocity, acceleration, .005 + random() * .395, i % 2 === 0, [0, 4, 8, 64][i % 4], [100, 208, 320][i % 3]);
}
const directory = path.resolve('reports/movement/native-velocity');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-velocity-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxVelocityError = 0, maxAccelerationError = 0;
const comparisons = cases.map((input, i) => {
  const actual = groundVelocity(input), expected = native.results[i];
  const velocityError = Math.max(...actual.velocity.map((v, axis) => Math.abs(v - expected.velocity[axis])));
  const accelerationError = Math.max(...actual.acceleration.map((v, axis) => Math.abs(v - expected.acceleration[axis])));
  maxVelocityError = Math.max(maxVelocityError, velocityError);
  maxAccelerationError = Math.max(maxAccelerationError, accelerationError);
  const exact = ['velocity', 'acceleration'].every(field => actual[field].every((v, axis) => Object.is(v, expected[field][axis])));
  if (!exact) mismatches.push({ index: i, velocityError, accelerationError });
  return { input, actual, expected };
});
const summary = { binaryHashes: native.hashes, cases: cases.length, comparison: 'exact float32 components, including signed zero', maxVelocityError, maxAccelerationError, mismatches };
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
assert.equal(mismatches.length, 0, 'ground velocity agrees with original calcVelocity for all sampled cases');
