import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSlots} from '../src/runtime/native-slots.mjs';
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
