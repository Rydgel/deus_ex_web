/** The original's slot allocator continued from a measured state
 * (src/runtime/original-object-index.mjs): AddObject's rule (last freed slot
 * first, else a new slot at the high-water mark), the registry hook that gives
 * a created object its `originalIndex`, and ~UObject's give-back
 * (destructScriptObject). docs/object-index-captures.md "Runtime spawns". */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginalObjectIndexModel } from '../src/runtime/original-object-index.mjs';
import { ScriptObjectRegistry } from '../src/runtime/script-object-construction.mjs';
import { destructScriptObject } from '../src/runtime/script-object-release.mjs';
import { mapRegistrySeed } from '../src/runtime/map-registry-seeds.mjs';

let nextName = 1;
const object = () => ({ index: -1, nameIndex: nextName++, outer: null, hashNext: null, linkerIndex: 0, stateFrame: null });

test('the model takes the last freed slot first, then appends at the high-water mark', () => {
  const model = new OriginalObjectIndexModel({ count: 100, freeIndices: [7, 40] });
  assert.equal(model.allocate(), 40);
  assert.equal(model.allocate(), 7);
  assert.equal(model.allocate(), 100);
  assert.equal(model.allocate(), 101);
  model.release(100); model.release(7);
  assert.equal(model.allocate(), 7);
  assert.equal(model.allocate(), 100);
  assert.equal(model.count, 102);
});

test('the model refuses states the original registry cannot be in', () => {
  assert.throws(() => new OriginalObjectIndexModel({ count: -1 }), /high-water mark/);
  assert.throws(() => new OriginalObjectIndexModel({ count: 5, freeIndices: [5] }), /below 5/);
  assert.throws(() => new OriginalObjectIndexModel({ count: 5, freeIndices: [2, 2] }), /distinct slot/);
  // a release it cannot take back is counted and left out: the model numbers sounds, it never stops the game
  const model = new OriginalObjectIndexModel({ count: 5 });
  assert.equal(model.release(9), false);
  assert.equal(model.release(3), true);
  assert.equal(model.release(3), false);
  assert.equal(model.rejected, 2);
});

test('a seeded registry gives objects created after the seed their original slot, and takes it back on release', () => {
  const registry = new ScriptObjectRegistry();
  const before = object();
  registry.add(before);
  assert.equal(before.originalIndex, undefined, 'an object created before the seed has no original slot');
  registry.original = new OriginalObjectIndexModel({ count: 42167, freeIndices: [42156] });
  const a = object(), b = object(), c = object();
  registry.add(a); registry.add(b); registry.add(c);
  assert.deepEqual([a, b, c].map(o => o.originalIndex), [42156, 42167, 42168]);
  const services = { gates: { [0x102a2644]: 1, [0x101e5550]: 0 }, registry, isValid: () => true, conditionalDestroy: () => {}, freeStateFrame: () => {} };
  destructScriptObject(b, services);
  destructScriptObject(before, services);   // no original slot: nothing to give back, counted
  assert.deepEqual(registry.original.freeIndices, [42167]);
  assert.equal(registry.original.unattributed, 1);
  const d = object();
  registry.add(d);
  assert.equal(d.originalIndex, 42167, 'the slot b gave back is the next one taken');
});

test('the per-map seeds come from the captures: high-water mark, holes and whether the free-list order is known', () => {
  const training = mapRegistrySeed('00_Training');
  assert.deepEqual([training.count, training.freeIndices, training.exact], [42167, [42156], true]);
  const hq = mapRegistrySeed('01_NYC_UNATCOHQ');
  assert.deepEqual([hq.holes, hq.exact], [0, true]);
  const island = mapRegistrySeed('01_NYC_UNATCOIsland');
  assert.equal(island.exact, false, 'a dump lists many holes as a set, not in the order they were freed');
  assert.ok(island.freeIndices.every(index => index < island.count));
  assert.equal(mapRegistrySeed('no_such_map'), null);
});

test('the first load of a native class replaces its placeholder under the same slot, creates its members, and happens once', () => {
  const members = [['Function', 'GetText'], ['StrProperty', 'ReturnValue']];
  const unmeasured = new OriginalObjectIndexModel({ count: 100, freeIndices: [7] });
  assert.equal(unmeasured.loadNativeClass('ExtString', members), false, 'without a measured set of resident packages nothing is modeled');
  const model = new OriginalObjectIndexModel({ count: 100, freeIndices: [7, 8], packages: ['Core'], classSlots: { ExtString: 23 } });
  model.log = [];
  assert.equal(model.loadNativeClass('ExtString', members), true);
  // the placeholder's slot (23) goes back and the loaded class takes it; the members take the free list's tail after it
  assert.deepEqual(model.log.map(row => [row.ev, row.index, row.cls ?? null, row.name ?? null]),
    [['free', 23, null, null], ['add', 23, 'Class', 'ExtString'], ['add', 8, 'Function', 'GetText'], ['add', 7, 'StrProperty', 'ReturnValue']]);
  assert.equal(model.loadNativeClass('extstring', members), false, 'a class already loaded creates nothing again');
  assert.equal(model.log.length, 4);
});
