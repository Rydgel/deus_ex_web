import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSlots, OffsetMap} from '../src/runtime/native-slots.mjs';
import {LoadEdges} from '../src/runtime/script-load-edges.mjs';

// A small deterministic generator, so a failure replays.
const random = seed => () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

test('NativeSlots behaves as the Map of {value, width} cells it replaced', () => {
  for (const [seed, offsets] of [[1, 24], [2, 40], [3, 300]]) {   // 300 crosses the offset index
    const next = random(seed), store = new NativeSlots(), model = new Map();
    for (let step = 0; step < 4000; step++) {
      const offset = Math.floor(next() * offsets) * (next() < 0.8 ? 4 : 1);
      const width = next() < 0.1 ? undefined : [1, 2, 4, 8, 16][Math.floor(next() * 5)];
      const value = [null, undefined, step, -step, step + 0.5, 0x90000000 + step, {step}][Math.floor(next() * 7)];
      const action = next();
      if (action < 0.4) { store.set(offset, value, width); model.set(offset, {value, width}); }
      else if (action < 0.8) {
        store.assign(offset, value, width);
        const cell = model.get(offset);
        if (cell) cell.value = value; else model.set(offset, {value, width});
      }
      assert.equal(store.has(offset), model.has(offset));
      assert.equal(store.value(offset), model.get(offset)?.value);
      assert.equal(store.width(offset), model.get(offset)?.width);
    }
    const seen = [];
    store.forEach((value, offset, width) => seen.push([offset, value, width]));
    assert.deepEqual(seen, [...model].map(([offset, {value, width}]) => [offset, value, width]));
    assert.equal(store.size, model.size);
  }
  assert.throws(() => new NativeSlots().set(-4, 0, 4), /offset/);
  assert.throws(() => new NativeSlots().set(0x24, 0, 255), /width/);
});

test('LoadEdges keeps the order, contents and lifetimes of the Map of Sets it replaced', () => {
  const next = random(7), records = Array.from({length: 120}, (_, id) => ({id, loadOrdinal: -1}));
  const edges = new LoadEdges(), model = new Map();
  const pick = () => records[Math.floor(next() * records.length)];
  const compare = () => {
    const froms = [];
    edges.forEachFrom(from => {
      const targets = [];
      edges.forEachTarget(from, target => targets.push(target.id));
      froms.push([from.id, targets]);
    });
    assert.deepEqual(froms, [...model].map(([from, targets]) => [from.id, [...targets].map(target => target.id)]));
    for (const record of records) assert.equal(edges.has(record), model.has(record));
    // A record is held exactly while the model's Map or one of its Sets holds it.
    const held = new Set([...model.keys(), ...[...model.values()].flatMap(targets => [...targets])]);
    for (const record of records) assert.equal(edges.records[record.loadOrdinal] === record, held.has(record));
  };
  for (let step = 0; step < 3000; step++) {
    const action = next();
    if (action < 0.85) {
      const from = pick(), to = pick();
      if (from === to) continue;
      edges.add(from, to);
      if (!model.has(from)) model.set(from, new Set());
      model.get(from).add(to);
    } else if (action < 0.95) {
      const from = pick();
      assert.equal(edges.delete(from), model.delete(from));
    } else {
      const purged = new Set(Array.from({length: 8}, pick));
      edges.deleteTargets(purged);
      for (const targets of model.values()) for (const target of targets) if (purged.has(target)) targets.delete(target);
    }
    if (step % 50 === 0) compare();
  }
  compare();
  const other = new LoadEdges();
  assert.throws(() => other.add(records[1], {loadOrdinal: -1}), /another graph/);
});

test('NativeSlots keeps int32 words in a typed array and every other value exactly, wherever it moves', () => {
  const values = [0, 1, -1, 0x7fffffff, -0x80000000, 0x80000000, 0xffffffff, 2 ** 40, -0, NaN, Infinity, -Infinity, 0.5, 1e300,
    null, undefined, true, false, 'text', 10n, 2n ** 70n, {a: 1}, [1, 2], new Uint8Array(3), Symbol.for('s')];
  const slots = new NativeSlots();
  const same = (a, b) => Object.is(a, b);
  // every value in its own slot, first written as an int, then rewritten through the whole list (an int slot moves to the elements on the
  // first value that is not an int32 and stays there)
  for (let at = 0; at < 40; at++) slots.set(at * 4, at, 4);
  assert.ok(slots.intWords instanceof Int32Array);
  for (const value of values) {
    for (let at = 0; at < 40; at++) {
      slots.set(at * 4, value, at % 2 ? 4 : 2);
      assert.ok(same(slots.value(at * 4), value), `slot ${at} reads ${String(value)}`);
      assert.equal(slots.width(at * 4), at % 2 ? 4 : 2);
      for (const other of [0, 7, 39]) if (other !== at) assert.ok(slots.has(other * 4));
    }
  }
  // the order and the other slots are untouched by a move
  const next = new NativeSlots(), order = [];
  for (let at = 0; at < 24; at++) { next.set(0x10 + at * 4, at); order.push([0x10 + at * 4, at]); }
  next.set(0x10 + 4 * 5, null); order[5][1] = null;
  next.set(0x10 + 4 * 9, 'x'); order[9][1] = 'x';
  next.set(0x10 + 4 * 5, 5); order[5][1] = 5;           // an element slot given an int keeps its value as an element
  const seen = [];
  next.forEach((value, offset) => seen.push([offset, value]));
  assert.deepEqual(seen, order);
  assert.ok(next.intRoom >= 16 && next.size === 24);
  // two stores written alike share a shape, whatever values they hold: where a slot lives is the store's, not the shape's
  const a = new NativeSlots(), b = new NativeSlots(), c = new NativeSlots();
  for (const store of [a, b, c]) { store.set(0, 1, 4); store.set(4, null, 4); store.set(8, 3, 4); }
  assert.ok(a.shape === b.shape);
  c.set(8, null, 4);    // the same width: the same key
  assert.ok(c.shape === a.shape);
  assert.equal(a.value(8), 3);
  assert.equal(c.value(8), null);
  assert.equal(Object.is(new NativeSlots().assign(0, -0), -0), true);
});

test('OffsetMap answers as the Map it stands for', () => {
  for (const [seed, offsets] of [[11, 30], [12, 200]]) {
    const next = random(seed), store = new OffsetMap(), model = new Map();
    assert.ok(store instanceof Map);
    for (let step = 0; step < 3000; step++) {
      const offset = Math.floor(next() * offsets) * 4;
      const value = [null, undefined, step, -step, step + 0.5, 0x90000000 + step, {step}, 'text', 5n, -0][Math.floor(next() * 10)];
      const action = next();
      if (action < 0.9 || seed === 12) { assert.equal(store.set(offset, value), store); model.set(offset, value); }
      else if (action < 0.95) assert.equal(store.delete(offset), model.delete(offset));
      else if (action < 0.96 && step > 2500) { store.clear(); model.clear(); }
      assert.equal(store.has(offset), model.has(offset));
      assert.ok(Object.is(store.get(offset), model.get(offset)));
      assert.equal(store.size, model.size);
    }
    assert.deepEqual([...store], [...model]);
    assert.deepEqual([...store.keys()], [...model.keys()]);
    assert.deepEqual([...store.values()], [...model.values()]);
    const viaForEach = []; store.forEach((value, offset, map) => { assert.equal(map, store); viaForEach.push([offset, value]); });
    assert.deepEqual(viaForEach, [...model]);
    assert.deepEqual([...new Map(store)], [...model]);
    assert.equal(store.plain, seed === 11);   // the second run never deletes: it stays typed throughout
  }
  // the plain offsets stay typed; any other key makes the store a Map, entries kept in order
  const typed = new OffsetMap([[0x28, 1], [0x2c, null], [0x30, 'a']]);
  assert.equal(typed.plain, false);
  assert.deepEqual([...typed], [[0x28, 1], [0x2c, null], [0x30, 'a']]);
  typed.set('name', 7); typed.set(0x28, 2);
  assert.equal(typed.plain, true);
  assert.deepEqual([...typed], [[0x28, 2], [0x2c, null], [0x30, 'a'], ['name', 7]]);
  // an entry added during a walk is visited, as a Map's iterator visits it
  const live = new OffsetMap([[0, 1]]), walked = [];
  for (const [offset] of live) { walked.push(offset); if (offset < 12) live.set(offset + 4, 0); }
  assert.deepEqual(walked, [0, 4, 8, 12]);
});

test('stores sharing an int chunk keep their own words while they grow in turn, past the chunk and the own-array size', () => {
  const stores = Array.from({length: 60}, () => new NativeSlots()), maps = Array.from({length: 60}, () => new OffsetMap());
  const model = stores.map(() => new Map());
  const wordOf = (which, slot) => (which * 7919 + slot * 104729) % 4294967296 - 2147483648;
  // a few stores grow to thousands of slots (their own array), the others stay small (blocks of the shared chunks); they grow in turn
  for (let slot = 0; slot < 3000; slot++) for (let which = 0; which < stores.length; which++) {
    if (slot >= (which % 20 === 0 ? 3000 : 20 + which)) continue;
    const offset = slot * 4, value = wordOf(which, slot);
    stores[which].set(offset, value, 4);
    maps[which].set(offset, value);
    model[which].set(offset, value);
    if (slot % 331 === 0) for (const [at, expected] of model[which]) {
      assert.equal(stores[which].value(at), expected);
      assert.equal(maps[which].get(at), expected);
    }
  }
  for (let which = 0; which < stores.length; which++) {
    assert.equal(stores[which].size, model[which].size);
    for (const [offset, expected] of model[which]) {
      assert.equal(stores[which].value(offset), expected);
      assert.equal(maps[which].get(offset), expected);
    }
    assert.deepEqual([...maps[which]], [...model[which]]);
  }
  assert.ok(stores[0].intRoom >= 1024 && stores[1].intRoom >= 16 && stores[1].intRoom < 1024);
  assert.equal(stores[0].intBase, 0);   // a block this large has an array of its own
});
