import test from 'node:test';
import assert from 'node:assert/strict';
import {ObjectArena, RESERVED} from '../src/runtime/script-object-arena.mjs';

test('a level arena reuses a released range for the same size only', () => {
  const arena = new ObjectArena(64);
  const a = arena.alloc(1000);
  arena.release(a, 1000); arena.reclaim();
  assert.notEqual(arena.alloc(2000), a);
  assert.equal(arena.alloc(1000), a);
});

test('a coalescing arena merges freed ranges, takes the best fit and gives the top back', () => {
  const arena = new ObjectArena(64, {coalesce: true});
  const a = arena.alloc(4096), b = arena.alloc(4096), c = arena.alloc(8192);
  assert.deepEqual([a, b, c], [RESERVED, RESERVED + 4096, RESERVED + 8192]);
  arena.bytes.fill(7, a, c + 8192);
  // a and b merge into one free range; a later level's larger model fits it, zeroed
  arena.release(a, 4096); arena.release(b, 4096); arena.reclaim();
  assert.deepEqual(arena.blocks, [{at: a, bytes: 8192}]);
  const d = arena.alloc(6008);
  assert.equal(d, a);
  assert.ok(arena.bytes.subarray(d, d + 6016).every(v => v === 0));
  // the rest of the split range is the best fit for a small request
  assert.equal(arena.alloc(100), a + 6016);
  // freeing the range at the top gives it back, with the free rest below it
  arena.release(c, 8192); arena.reclaim();
  assert.equal(arena.top, a + 6016 + 112);
  assert.deepEqual(arena.blocks, []);
});

test('a coalescing arena frees the whole range it gave, spare tail included', () => {
  const arena = new ObjectArena(64, {coalesce: true});
  const a = arena.alloc(1000), guard = arena.alloc(16);
  arena.release(a, 1000); arena.reclaim();
  // 1000 rounds to 1008; a request of 900 (912) leaves 96 bytes, too few to split, so it takes all 1008
  const b = arena.alloc(900);
  assert.equal(b, a);
  assert.deepEqual(arena.blocks, []);
  arena.release(b, 900); arena.reclaim();
  assert.deepEqual(arena.blocks, [{at: a, bytes: 1008}]);
  assert.equal(guard, a + 1008);
});
