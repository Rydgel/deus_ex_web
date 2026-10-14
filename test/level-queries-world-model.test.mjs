import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelQueries } from '../src/runtime/level-queries.mjs';

// lineCheck's `worldModel` stands for Level->Model in the world part of
// SingleLineCheck only (docs/coronas.md "Lights behind a mover's fragments":
// the moving brush tracker's model, bsp-occlusion.mjs lineModel).
const empty = { rootOutside: 1, leafHulls: [], nodes: [] };
const wall = { rootOutside: 1, leafHulls: [], nodes: [{ plane: [1, 0, 0, 0], front: -1, back: -1, vertexCount: 4, flags: 0, collisionBound: -1 }] };
const levelInfo = { id: '$world', name: '$world', lineage: ['engine.levelinfo', 'engine.zoneinfo', 'engine.actor'] };

test('a world model replaces Level->Model for TRACE_Level and leaves the actor checks to the hash', () => {
  const queries = createLevelQueries(empty, [], { kernel: false, levelInfo });
  const through = [[10, 0, 0], [-10, 0, 0]];
  assert.equal(queries.lineCheck(...through, [0, 0, 0], 6, 0, null).outside, true, 'the level\'s own model is empty');
  const hit = queries.lineCheck(...through, [0, 0, 0], 6, 0, null, wall);
  assert.equal(hit.outside, false);
  assert.equal(hit.actor, levelInfo, 'a world hit names the level');
  assert.ok(hit.time > 0 && hit.time < 1);
  // Without TRACE_Level (the helper's second check, 0x11) no world check runs.
  assert.equal(queries.lineCheck(...through, [0, 0, 0], 0x11, 0, null, wall).outside, true);
  // The same answer as the level queries built over that model, bit for bit.
  const own = createLevelQueries(wall, [], { kernel: false, levelInfo }).lineCheck(...through, [0, 0, 0], 6, 0, null);
  assert.equal(own.outside, false);
  assert.equal(own.time, hit.time);
  assert.deepEqual(own.location, hit.location);
  assert.deepEqual(own.normal, hit.normal);
  // A segment on the open side is clear through either.
  assert.equal(queries.lineCheck([10, 0, 0], [20, 0, 0], [0, 0, 0], 6, 0, null, wall).outside, true);
});

test('a world model takes only zero extents', () => {
  const queries = createLevelQueries(empty, [], { kernel: false, levelInfo });
  assert.throws(() => queries.lineCheck([10, 0, 0], [-10, 0, 0], [1, 1, 1], 6, 0, null, wall), /zero extent/);
});
