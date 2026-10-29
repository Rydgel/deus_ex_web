import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_HEADER_BINDINGS, LOADED_HEADER_BINDINGS, NO_BINDINGS, SharedBindings, setBindingOf, deleteBindingOf }
  from '../src/runtime/script-bindings.mjs';

// docs/live-heap.md, "Actor hosts and mesh bindings": an object's binding table starts as a shared immutable header prefix and
// becomes a Map of its own at the first binding that is not the next header binding. Against a plain Map it must hold the same
// entries in the same order after every operation.
const NATIVE_ORDER = ['ObjectFlags', 'Outer', 'Name', 'Class', 'ObjectInternal'];
const LOADED_ORDER = ['Name', 'Class', 'Outer', 'ObjectFlags', 'ObjectInternal'];
const key = name => `core.object.${name.toLowerCase()}`;
const native = name => [key(name), NATIVE_HEADER_BINDINGS[name]];
const loaded = name => [key(name), LOADED_HEADER_BINDINGS[name]];

const same = (owner, reference, note) => {
  assert.deepEqual([...owner.bindings], [...reference], `${note}: entries and order`);
  assert.equal(owner.bindings.size, reference.size, `${note}: size`);
  for (const [k, v] of reference) { assert.equal(owner.bindings.has(k), true); assert.equal(owner.bindings.get(k), v); }
  assert.equal(owner.bindings.has('engine.actor.base'), reference.has('engine.actor.base'));
  assert.deepEqual([...owner.bindings.keys()], [...reference.keys()]);
  assert.deepEqual([...owner.bindings.values()], [...reference.values()]);
};
const bind = (owner, reference, k, v, note) => { setBindingOf(owner, k, v); reference.set(k, v); same(owner, reference, note); };

test('a header-only object keeps the shared tables and no Map of its own', () => {
  for (const [order, pair] of [[NATIVE_ORDER, native], [LOADED_ORDER, loaded]]) {
    const owner = { bindings: NO_BINDINGS }, reference = new Map(), seen = [];
    for (const name of order) { bind(owner, reference, ...pair(name), name); assert.ok(owner.bindings instanceof SharedBindings); seen.push(owner.bindings); }
    const again = { bindings: NO_BINDINGS };
    for (const name of order) setBindingOf(again, ...pair(name));
    assert.equal(again.bindings, owner.bindings, 'two objects end at the same table');
    // binding the same header bindings again changes nothing
    for (const name of order) bind(owner, reference, ...pair(name), `${name} again`);
    assert.equal(owner.bindings, seen.at(-1));
  }
});

test('the shared tables cannot be changed, and an object that diverges gets a Map', () => {
  const owner = { bindings: NO_BINDINGS };
  for (const name of NATIVE_ORDER) setBindingOf(owner, ...native(name));
  const shared = owner.bindings;
  assert.throws(() => shared.set('x', {}), TypeError);
  assert.throws(() => shared.delete(key('Name')), TypeError);
  assert.throws(() => shared.clear(), TypeError);
  const other = { bindings: NO_BINDINGS }, reference = new Map();
  for (const name of NATIVE_ORDER) { setBindingOf(other, ...native(name)); reference.set(...native(name)); }
  const extra = { get() {}, set() {} };
  bind(other, reference, 'engine.actor.base', extra, 'extra');
  assert.ok(other.bindings instanceof Map && !(other.bindings instanceof SharedBindings));
  assert.equal(shared.size, 5, 'the shared table is unchanged');
  assert.equal(shared.has('engine.actor.base'), false);
  assert.equal(owner.bindings, shared);
});

test('random sequences give the same table as a Map', () => {
  let seed = 12345;
  const rand = n => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  const extras = Array.from({ length: 6 }, (_, i) => [`engine.actor.f${i}`, { get() {}, set() {}, i }]);
  const pool = [...NATIVE_ORDER.map(native), ...LOADED_ORDER.map(loaded), ...extras];
  for (let run = 0; run < 400; run++) {
    const owner = { bindings: NO_BINDINGS }, reference = new Map();
    // half the runs follow a header sequence for a while
    if (run % 2) {
      const order = run % 4 === 1 ? NATIVE_ORDER : LOADED_ORDER, pair = run % 4 === 1 ? native : loaded;
      for (const name of order.slice(0, rand(6))) bind(owner, reference, ...pair(name), name);
    }
    for (let step = 0; step < 12; step++) {
      if (rand(5) === 0) {
        const [k] = pool[rand(pool.length)];
        assert.equal(deleteBindingOf(owner, k), reference.delete(k)); same(owner, reference, `delete ${k}`);
      } else {
        const [k, v] = pool[rand(pool.length)];
        bind(owner, reference, k, v, `run ${run} step ${step}`);
      }
    }
  }
});

test('deleting from a shared table copies it first; deleting a missing key leaves it shared', () => {
  const owner = { bindings: NO_BINDINGS }, reference = new Map();
  for (const name of NATIVE_ORDER) bind(owner, reference, ...native(name), name);
  const shared = owner.bindings;
  assert.equal(deleteBindingOf(owner, 'engine.actor.base'), false);
  assert.equal(owner.bindings, shared);
  assert.equal(deleteBindingOf(owner, key('Name')), true);
  reference.delete(key('Name'));
  same(owner, reference, 'after delete');
  assert.equal(shared.has(key('Name')), true);
});
