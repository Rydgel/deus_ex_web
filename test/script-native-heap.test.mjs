import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';

test('freed ranges are zeroed, merged and reused first-fit', () => {
  const heap = createNativeHeap({capacity: 1 << 12});
  const a = {name: 'a'}, b = {name: 'b'}, c = {name: 'c'};
  heap.allocate(a, 0x40); heap.allocate(b, 0x40); heap.allocate(c, 0x40);
  const high = heap.used, address = heap.objectAddress(a);
  heap.write(a, 0x10, 'u32', 0xdeadbeef);
  heap.write(a, 0x20, 'string', 'text');
  heap.free(a); heap.free(b);
  assert.throws(() => heap.objectAddress(a), /no address/);
  // A freed identity cannot come back as an opaque handle.
  assert.throws(() => heap.addressOf(a), /freed/);
  const d = {name: 'd'};
  heap.allocate(d, 0x70);
  assert.equal(heap.objectAddress(d), address, 'the merged a+b range is reused');
  assert.equal(heap.read(d, 0x10, 'u32'), 0);
  assert.equal(heap.read(d, 0x20, 'string'), '');
  assert.equal(heap.used, high, 'reuse does not raise the high-water mark');
});

test('raw blocks and forgotten handles are released', () => {
  const heap = createNativeHeap({capacity: 1 << 12});
  const block = heap.allocRaw(0x20);
  heap.freeRaw(block);
  assert.throws(() => heap.freeRaw(block), /no allocation/);
  assert.equal(heap.allocRaw(0x10), block);
  const actor = {name: 'Actor'}, handle = heap.addressOf(actor);
  assert.equal(heap.objectAt(handle), actor);
  heap.forget(actor);
  assert.throws(() => heap.objectAt(handle), /no object/);
});
