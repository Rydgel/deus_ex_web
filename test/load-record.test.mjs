import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSlots, slotValue} from '../src/runtime/native-slots.mjs';
import {LoadRecord} from '../src/runtime/load-record.mjs';

test('a LoadRecord is its own slot store and records written alike share one slot shape', () => {
  const a = new LoadRecord('A', 'Class'), b = new LoadRecord('B', 'Function'), c = new LoadRecord('C', 'Function');
  for (const record of [a, b, c]) {
    record.set(0x00, 0x1234, 4);
    record.set(0x04, -1, 4);
    record.assign(0x24, record === a ? null : a, 4);
  }
  c.set(0x08, 7, 2);
  assert.equal(a.nativeSlots, a);
  assert.ok(a instanceof NativeSlots);
  assert.equal(slotValue(b, 0x24), a);
  assert.equal(slotValue(a, 0x24), null);
  assert.equal(b.shape, a.shape);          // the same writes in the same order
  assert.notEqual(c.shape, a.shape);
  assert.equal(c.width(0x08), 2);
  assert.equal(b.has(0x08), false);
  assert.equal(b.value(0x08), undefined);
  // the slot words are the record's elements: its own named fields and the slots never meet
  assert.equal(b.name, 'B');
  assert.equal(b.kind, 'Function');
  assert.deepEqual(Object.keys(b).filter(key => !/^\d+$/.test(key)).includes('nativeSlots'), false);
  assert.equal(b.size, 3);
});

test('NativeSlots.forEach visits a slot added during the walk, and a width change keeps the position', () => {
  const slots = new NativeSlots();
  slots.set(0x10, 'a', 4);
  slots.set(0x14, 'b', 4);
  const seen = [];
  slots.forEach((value, offset, width) => {
    seen.push([offset, value, width]);
    if (offset === 0x10) slots.set(0x18, 'c', 8);
    if (offset === 0x14) slots.set(0x10, 'a2', 2);
  });
  assert.deepEqual(seen, [[0x10, 'a', 4], [0x14, 'b', 4], [0x18, 'c', 8]]);
  assert.deepEqual([slots.value(0x10), slots.width(0x10)], ['a2', 2]);
  const order = [];
  slots.forEach((value, offset) => order.push(offset));
  assert.deepEqual(order, [0x10, 0x14, 0x18]);
});

test('a LoadRecord\'s named fields and the store\'s own fields are different properties', () => {
  // `base` is the record's superclass link; the store's int block is intWords/intBase/intRoom (a store field named like a record field
  // would be overwritten by the record's constructor, which runs after the store's)
  const record = new LoadRecord('A', 'Class');
  assert.ok(record.intWords instanceof Int32Array);
  assert.deepEqual([record.intBase, record.intRoom, record.base], [0, 0, null]);
  for (let at = 0; at < 40; at++) record.set(0x10 + at * 4, at === 3 ? null : at * 3 - 7, 4);   // grows past the first block
  record.base = {};
  assert.equal(record.value(0x10 + 5 * 4), 8);
  assert.equal(record.value(0x10 + 3 * 4), null);
  assert.equal(record.value(0x10 + 39 * 4), 110);
  assert.ok(record.intRoom >= 32 && typeof record.base === 'object');
});
