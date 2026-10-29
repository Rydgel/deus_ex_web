import test from 'node:test';
import assert from 'node:assert/strict';
import { traceRay } from '../src/runtime/ray.mjs';
import { BspCollider } from '../src/runtime/collision.mjs';
import { modelFromObjects } from '../src/unreal/bsp-model.mjs';

const model = modelFromObjects({ rootOutside: 1, leafHulls: [], nodes: [{ plane: [1, 0, 0, 0],
  front: -1, back: -1, vertexCount: 4, flags: 0, collisionBound: -1 }] });
// Numeric expectations captured from original Engine.dll 0x103f3c20, using
// the one-plane corpus in scripts/validate-native-rays.mjs. No game data needed.
test('compiled world rays use original traversal and half-unit backoff', () => {
  const hit = new BspCollider(model).sweep([10, 0, 0], [-20, 1, 0], [0, 0, 0]);
  assert.equal(hit.time, 0.47503119707107544);
  assert.deepEqual(hit.location, [0.4993762969970703, 0.47503119707107544, 0]);
  assert.deepEqual(hit.normal, [1, 0, 0]);
});

test('original front-side epsilon test takes precedence over the back-side test', () => {
  const below = Math.fround(-.001), above = Math.fround(-.000999);
  assert.equal(traceRay(model, [below, 0, 0], [below, 1, 0]).time, 0);
  assert.equal(traceRay(model, [above, 0, 0], [above, 1, 0]), null);
  const hit = traceRay(model, [.001001, 0, 0], [-.001001, 1, 0]);
  assert.equal(hit.time, 9.834735692493268e-7);
  assert.deepEqual(hit.location, [0.0010009980760514736, 9.834735692493268e-7, 0]);
});

test('initial solid hits preserve the original boundary normal and signed zero', () => {
  const hit = traceRay(model, [-10, 0, 0], [-.000999, 1, 0]);
  assert.equal(hit.time, 0);
  assert.deepEqual(hit.location, [-10, 0, 0]);
  assert.deepEqual(hit.normal, [-1, -0, -0]);
  assert.equal(traceRay(model, [-10, 0, 0], [-10, 1, 0], 0x10), null);
});

test('zero-length rays in solid follow the original unordered clamp', () => {
  const hit = traceRay(model, [-10, 0, 0], [-10, 0, 0]);
  assert.equal(hit.time, 0);
  assert.deepEqual(hit.location, [-10, 0, 0]);
  assert.deepEqual(hit.normal, [1, 0, 0]);
  assert.equal(traceRay(model, [-10, 0, 0], [-10, 0, 0], 0x10), null);
  assert.equal(traceRay(model, [10, 0, 0], [10, 0, 0]), null);
});

test('moving brush rays apply location through original coordinates without shifting endpoints twice', () => {
  // Original native-brush initial capture with Location [100, 20, 30]. The
  // caller reaches that location through a base location and mover offset.
  const collider = new BspCollider(model, p => p, n => n, { Location: [90, 20, 30] });
  collider.offset = [10, 0, 0];
  const hit = collider.sweep([110, 0, 0], [-220, 1, 0], [0, 0, 0]);
  assert.equal(hit.time, 0.04318184405565262);
  assert.deepEqual(hit.location, [100.49999237060547, 0.04318184405565262, 0]);
  assert.deepEqual(hit.normal, [1, 0, 0]);
});
