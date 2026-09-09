import test from 'node:test';
import assert from 'node:assert/strict';
import { groundVelocity } from '../src/runtime/velocity.mjs';

const baseline = { velocity: [0, 0, 0], acceleration: [1000, 0, 0], direction: [1, 0, 0],
  dt: 1 / 120, maxSpeed: 320, accelRate: 1000, friction: 8, walking: false };
// Numeric reference results are from direct execution of the hash-gated original
// Engine.dll calcVelocity. The optional validator regenerates broader evidence.
test('native walking limits acceleration and eases down from running speed', () => {
  assert.deepEqual(groundVelocity(baseline).velocity, [8.333333969116211, 0, 0]);
  const walking = groundVelocity({ ...baseline, walking: true });
  assert.deepEqual(walking.acceleration, [300, 0, 0]);
  assert.deepEqual(walking.velocity, [2.500000238418579, 0, 0]);
  const slowing = groundVelocity({ ...baseline, velocity: [320, 0, 0], acceleration: [0, 0, 0], direction: [0, 0, 0], walking: true });
  assert.deepEqual(slowing.velocity, [240.35556030273438, 0, 0]);
});

test('native braking uses substeps, averages the interval, and stops below ten', () => {
  const stoppedInput = { ...baseline, velocity: [320, 0, 0], acceleration: [0, 0, 0], direction: [0, 0, 0] };
  assert.deepEqual(groundVelocity({ ...stoppedInput, dt: .1 }).velocity, [93.15631103515625, 0, 0]);
  assert.deepEqual(groundVelocity({ ...stoppedInput, dt: .4 }).velocity, [25.996078491210938, 0, 0]);
  assert.deepEqual(groundVelocity({ ...stoppedInput, velocity: [10, 0, 0] }).velocity, [0, 0, 0]);
});

test('native turning friction changes direction before acceleration and speed limiting', () => {
  const turning = { ...baseline, velocity: [100, 0, 0], acceleration: [0, 1000, 0], direction: [0, 1, 0] };
  assert.deepEqual(groundVelocity(turning).velocity, [93.33333587646484, 15.000000953674316, 0]);
  assert.deepEqual(groundVelocity({ ...turning, walking: true }).velocity, [93.33333587646484, 9.166666984558105, 0]);
  assert.deepEqual(groundVelocity({ ...turning, dt: .4 }).velocity, [-93.50993347167969, 306.0325012207031, 0]);
});
