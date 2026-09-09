import test from 'node:test';
import assert from 'node:assert/strict';
import { twoWallAdjust, stepUp } from '../src/runtime/steps.mjs';

// Small fixed regressions for the original-DLL comparisons in
// scripts/validate-native-steps.mjs. The full native check needs local assets.
test('original corner response follows the crease and prevents reversed wall sliding', () => {
  assert.deepEqual(twoWallAdjust({ desired: [1, 1, 1], delta: [4, 2, 3], normal: [1, 0, 0], oldNormal: [0, 1, 0], time: .5 }), [0, 0, 1.5]);
  assert.deepEqual(twoWallAdjust({ desired: [0, -1, 0], delta: [4, 2, 0], normal: [1, 0, 0], oldNormal: [1, 0, 0], time: .5 }), [0, 0, 0]);
  assert.deepEqual(twoWallAdjust({ desired: [1, 1, 1], delta: [4, 2, 3], normal: [1, 0, 0], oldNormal: [-1, 0, 0], time: .5 }), [0, 0, 0]);
});

function controlledPawn(responses) {
  const moves = [], walls = [];
  return { maxStepHeight: 25, isPlayer: true, mass: 150, velocity: [320, -70, 0], physics: 1, moves, walls,
    move(delta) { moves.push(delta.map(v => v === 0 ? 0 : v)); return responses.shift() ?? { time: 1, normal: [0, 0, 0] }; },
    hitWall(hit) { walls.push([...hit.normal]); } };
}
const clear = { time: 1, normal: [0, 0, 0] };

test('original stair sequence keeps its horizontal attempt after blocked headroom and uses exactly MaxStepHeight down', () => {
  const pawn = controlledPawn([{ time: 0, normal: [0, 0, -1] }, clear, { time: 0, normal: [0, 0, 1] }]);
  stepUp(pawn, [0, 0, -1], [1, 0, 0], [4, 2, 0]);
  assert.deepEqual(pawn.moves, [[0, 0, 25], [4, 2, 0], [0, 0, -25]]);
  assert.deepEqual(pawn.walls, []);
});

test('original stairs recurse after sufficient impact progress, retaining the remaining displacement', () => {
  const pawn = controlledPawn([clear, { time: .5, normal: [-1, 0, 0] }, clear, clear, { time: .4, normal: [0, 0, 1] }]);
  stepUp(pawn, [0, 0, -1], [1, 0, 0], [20, 0, 0]);
  assert.deepEqual(pawn.moves, [[0, 0, 25], [20, 0, 0], [0, 0, 25], [10, 0, 0], [0, 0, -25], [0, 0, -25]]);
  assert.deepEqual(pawn.walls, []);
});

test('pushable-decoration branch uses original mass damping and exits when the hit event starts falling', () => {
  const pawn = controlledPawn([clear, { time: .2, normal: [-1, 0, 0], actor: { pushableDecoration: true, mass: 100 } }]);
  pawn.hitWall = () => { pawn.physics = 2; };
  stepUp(pawn, [0, 0, -1], [1, 0, 0], [4, 0, 0]);
  assert.deepEqual(pawn.velocity, [192, -42, 0]);
  assert.equal(pawn.justTeleported, true);
  assert.deepEqual(pawn.moves, [[0, 0, 25], [4, 0, 0]]);
});
