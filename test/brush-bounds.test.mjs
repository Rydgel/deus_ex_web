import test from 'node:test';
import assert from 'node:assert/strict';
import { brushCollisionBounds, primitiveCollisionBounds } from '../src/runtime/brush-bounds.mjs';

const bounds = { min: [-13.25, -27.5, -3.125], max: [48.75, 56, 18.5], valid: true };

test('native null-owner copy and owned invalid-box expansion', () => {
  const model = { bounds: { ...bounds, valid: false } };
  assert.deepEqual(brushCollisionBounds(model), model.bounds);
  assert.deepEqual(primitiveCollisionBounds(model), model.bounds);
  assert.deepEqual(brushCollisionBounds(model, {}), bounds);
  assert.notEqual(brushCollisionBounds(model).min, model.bounds.min);
});

test('native quarter-turn scale float midpoint retains x87 sine contribution', () => {
  const owner = { Location: [100.25,-32.125,12], PrePivot: [12,13,14], Rotation: [0,16384,0],
    MainScale: { scale: [2,.5,-1], shearAxis: 0, shearRate: 0 },
    PostScale: { scale: [.75,1.5,2], shearAxis: 6, shearRate: 0 } };
  // Native reference case21: ordinary JS double arithmetic loses the max-X ULP.
  assert.deepEqual(brushCollisionBounds({ bounds }, owner), {
    min: [84.125,-107.875,3], max: [115.43750762939453,78.125,46.25], valid: true,
  });
});

test('native shear threshold and nonuniform reflected scale', () => {
  assert.deepEqual(brushCollisionBounds({ bounds }, {
    Location: [100.25,-32.125,12], PrePivot: [12,13,14], Rotation: [0,0,0],
    MainScale: { scale: [2,.5,-1], shearAxis: 1, shearRate: -.05 },
    PostScale: { scale: [.75,1.5,2], shearAxis: 5, shearRate: .05 },
  }), { min: [62.375003814697266,-62.5,3], max: [155.375,.12500086426734924,46.25], valid: true });
});

test('native generic primitive adds one unit to radius and height', () => {
  assert.deepEqual(primitiveCollisionBounds({ bounds }, { CollisionRadius: 0, CollisionHeight: 234.567 }), {
    min: [-1,-1,-235.56700134277344], max: [1,1,235.56700134277344], valid: true,
  });
});

test('unverified degenerate scales remain explicit errors', () => {
  assert.throws(() => brushCollisionBounds({ bounds }, { MainScale: { scale: [1,0,1] } }), /unsupported/);
});
