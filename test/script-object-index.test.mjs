/** The global UObject index model: a registry seeded at a measured GObjObjects
 * state, then allocating forward by the recovered Core AddObject rule (append at
 * the high-water count, else reuse the last freed slot LIFO) with the UObject
 * destructor's free-list append. This is the "general index model" that covers
 * runtime spawns the load-time capture cannot: docs/boot-replay.md and
 * docs/script-object-release.md. The 00_Training seed values (count 42167, one
 * freed slot 42156) are cross-checked against the live capture by
 * scripts/validate-object-index-model.mjs; here the rule is exercised in the pure
 * form so it runs without the game install. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptObjectRegistry, seedScriptObjectRegistry } from '../src/runtime/script-object-construction.mjs';

// Minimal unregistered object accepted by ScriptObjectRegistry.add (a resolved
// FName index and an unassigned slot are the only real preconditions here).
let nextName = 1;
const object = (outer = null) => ({ index: -1, nameIndex: nextName++, outer, hashNext: null });

// The UObject destructor's registry step (docs/script-object-release.md step 6-7):
// null the slot without shortening the array, then append the freed index to the
// LIFO free list. Kept local so the test states the rule it validates.
function destroy(registry, obj) {
  registry.objects[obj.index] = null;
  registry.freeIndices.push(obj.index);
}

test('seedScriptObjectRegistry establishes the measured high-water mark and free list', () => {
  const registry = seedScriptObjectRegistry({ count: 42167, freeIndices: [42156] });
  assert.ok(registry instanceof ScriptObjectRegistry);
  assert.equal(registry.objects.length, 42167); // GObjObjects count (Core.dll +0x19e62c)
  assert.deepEqual(registry.freeIndices, [42156]);
  // The seeded array is sparse: only the freed hole and the high-water tail are
  // "empty"; no dense 42167-element allocation is materialised.
  assert.equal(42156 in registry.objects, false);
  assert.equal(0 in registry.objects, false);
});

test('a seeded registry reuses the freed slot LIFO, then appends at the high-water count', () => {
  const registry = seedScriptObjectRegistry({ count: 42167, freeIndices: [42156] });
  // The single freed slot is reused before any append (Core AddObject reads the
  // last GObjAvailable entry first).
  assert.equal(registry.add(object()), 42156);
  assert.equal(registry.freeIndices.length, 0);
  // With the free list drained, the next spawns append at the count and grow it.
  assert.equal(registry.add(object()), 42167);
  assert.equal(registry.add(object()), 42168);
  assert.equal(registry.objects.length, 42169);
});

test('the runtime-spawn tail of the capture is reproduced: consecutive appends from the count', () => {
  // 00_Training's capture ends with runtime spawns (GC/AIReceiverEvent/Carcass)
  // at 42157..42166 -- the highest slots precisely because they were appended
  // last. Model that: after the freed 42156 is reused, ten spawns land on
  // 42167..42176 in creation order, mirroring the capture's contiguous tail.
  const registry = seedScriptObjectRegistry({ count: 42167, freeIndices: [42156] });
  const assigned = [registry.add(object())]; // 42156 (reuse)
  for (let i = 0; i < 10; i++) assigned.push(registry.add(object()));
  assert.deepEqual(assigned, [42156, 42167, 42168, 42169, 42170, 42171, 42172, 42173, 42174, 42175, 42176]);
});

test('destroy appends to the free list and the next allocation reuses it LIFO', () => {
  const registry = seedScriptObjectRegistry({ count: 10, freeIndices: [] });
  const a = object(), b = object(), c = object();
  assert.equal(registry.add(a), 10);
  assert.equal(registry.add(b), 11);
  assert.equal(registry.add(c), 12);
  // Free two out of creation order; the free list is LIFO, so the most recently
  // freed slot is handed back first.
  destroy(registry, a); // free 10
  destroy(registry, c); // free 12
  assert.deepEqual(registry.freeIndices, [10, 12]);
  assert.equal(registry.add(object()), 12); // last freed, first reused
  assert.equal(registry.add(object()), 10);
  assert.equal(registry.add(object()), 13); // free list empty -> append
});

test('seedScriptObjectRegistry rejects impossible measured states', () => {
  assert.throws(() => seedScriptObjectRegistry({ count: -1 }), /non-negative object count/);
  assert.throws(() => seedScriptObjectRegistry({ count: 5, freeIndices: [5] }), /outside 0\.\.4/);
  assert.throws(() => seedScriptObjectRegistry({ count: 5, freeIndices: [-1] }), /outside 0\.\.4/);
  assert.throws(() => seedScriptObjectRegistry({ count: 3, freeIndices: 3 }), /freeIndices array/);
});

test('a duplicated freed slot in the seed is rejected rather than double-allocated', () => {
  // Two identical holes would let AddObject hand the same slot to two objects.
  assert.throws(() => seedScriptObjectRegistry({ count: 10, freeIndices: [4, 4] }), /occupied/);
});
