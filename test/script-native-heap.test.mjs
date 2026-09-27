import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';

test('freed ranges are zeroed, merged and reused first-fit', () => {
  const heap = createNativeHeap({capacity: 1 << 12});
  const a = {name: 'a'}, b = {name: 'b'}, c = {name: 'c'};
  heap.allocate(a, 0x40); heap.allocate(b, 0x40); heap.allocate(c, 0x40);
  const address = heap.objectAddress(a);
  heap.write(a, 0x10, 'u32', 0xdeadbeef);
  heap.write(a, 0x20, 'string', 'text');
  const high = heap.used;
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

test('FString slots hold raw Data/Num/Max words', () => {
  const heap = createNativeHeap({capacity: 1 << 12});
  const window = {name: 'window'};
  heap.allocate(window, 0x40);
  heap.write(window, 0x10, 'string', 'ab');
  const data = heap.read(window, 0x10, 'u32');
  // FString::operator=(const TCHAR*): Num = Max = len + 1, Data holds L"ab\0".
  assert.deepEqual([heap.read(window, 0x14, 'i32'), heap.read(window, 0x18, 'i32')], [3, 3]);
  assert.deepEqual([0, 2, 4].map(at => heap.mem.read(data + at, 'u16')), [0x61, 0x62, 0]);
  // A raw body shortening the string in place is what the typed read sees.
  heap.mem.write(data + 2, 'u16', 0);
  assert.equal(heap.read(window, 0x10, 'string'), 'a');
  // Assigning "" reallocates Data to nothing: Num = Max = 0, Data = null.
  heap.write(window, 0x10, 'string', '');
  assert.deepEqual([heap.read(window, 0x10, 'u32'), heap.read(window, 0x14, 'i32')], [0, 0]);
  assert.throws(() => heap.freeRaw(data), /no allocation/, 'the old Data block was released');
  // Freeing the image releases a member's Data (its ~FString).
  heap.write(window, 0x10, 'string', 'text');
  const member = heap.read(window, 0x10, 'u32');
  heap.free(window);
  assert.throws(() => heap.freeRaw(member), /no allocation/);
});
