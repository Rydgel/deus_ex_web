import test from 'node:test';
import assert from 'node:assert/strict';
import { readObject } from '../src/unreal/objects.mjs';
import { readModel, triangulateModel } from '../src/unreal/model.mjs';

class Writer {
  bytes = [];
  u8(n) { this.bytes.push(n); }
  index(n) {
    // All the hand-authored test indices fit in one byte.
    assert.ok(Math.abs(n) < 64);
    this.u8(Math.abs(n) | (n < 0 ? 128 : 0));
  }
  i32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); this.bytes.push(...b); }
  f32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); this.bytes.push(...b); }
  vector(v) { v.forEach(n => this.f32(n)); }
  data() { return Uint8Array.from(this.bytes); }
}

function pkgFor(bytes, names = ['None'], flags = 0, className = 'Actor') {
  return { version: 68, names: names.map(name => ({ name })), imports: [], exports: [
    { serialOffset: 0, serialSize: bytes.length, flags, name: 'Test', className },
  ] };
}

test('property tags preserve booleans, vectors, indexed values, and opaque structs', () => {
  const w = new Writer();
  const names = ['None', 'Hidden', 'Location', 'Vector', 'Slots', 'Tint', 'UnknownStruct'];
  w.index(1); w.u8(0x83); // true is in tag, with no payload byte.
  w.index(2); w.u8(0x3a); w.index(3); w.vector([1.5, -2, 3]);
  w.index(4); w.u8(0x81); w.u8(0x81); w.u8(0xf4); w.u8(42); // index 500
  w.index(5); w.u8(0x2a); w.index(6); w.i32(0x12345678); // opaque unknown struct
  w.index(0); w.u8(99); // one byte of native payload after None
  const data = w.data(), object = readObject(pkgFor(data, names), data, 1);
  assert.equal(object.values.Hidden, true);
  assert.deepEqual(object.values.Location, [1.5, -2, 3]);
  assert.equal(object.values['Slots[500]'], 42);
  assert.equal(object.properties[3].decoded, false);
  assert.deepEqual([...object.properties[3].data], [0x78, 0x56, 0x34, 0x12]);
  assert.equal(object.reader.u8(), 99);
});

test('Color and Scale structs decode exact channel and transform values', () => {
  const w = new Writer(), names = ['None', 'Tint', 'Color', 'MainScale', 'Scale'];
  w.index(1); w.u8(0x2a); w.index(2); [10, 20, 30, 40].forEach(n => w.u8(n));
  w.index(3); w.u8(0x5a); w.index(4); w.u8(17);
  w.vector([2, -3, .5]); w.f32(.25); w.u8(2); w.index(0);
  const data = w.data(), object = readObject(pkgFor(data, names), data, 1);
  assert.deepEqual(object.values.Tint, [10, 20, 30, 40]);
  assert.deepEqual(object.values.MainScale, { scale: [2, -3, .5], shearRate: .25, shearAxis: 2 });
});

test('object state frames are consumed before property tags', () => {
  const w = new Writer();
  w.index(1); w.index(1); w.i32(-1); w.i32(-1); w.i32(0); w.index(-1); w.index(0);
  const data = w.data(), object = readObject(pkgFor(data, ['None'], 0x02000000), data, 1);
  assert.equal(object.stack.node, 1);
  assert.equal(object.stack.offset, -1);
  assert.equal(object.properties.length, 0);
  assert.equal(object.reader.offset, data.length);
});

test('property parsing rejects out-of-bounds names, sizes, and object references', () => {
  for (const data of [
    Uint8Array.of(9),
    Uint8Array.of(1, 0x24, 0), // truncated float
    Uint8Array.of(1, 0x05, 2), // invalid object ref
  ]) {
    assert.throws(() => readObject(pkgFor(data, ['None', 'Value']), data, 1), /Invalid|Truncated/);
  }
});

function modelFixture({ staleVertex = false, invalidLiveVertex = false, badNode = false } = {}) {
  const w = new Writer();
  w.index(0); // None
  w.vector([0, 0, 0]); w.vector([1, 1, 0]); w.u8(1); // box
  w.vector([0, 0, 0]); w.f32(1); // sphere
  w.index(3); [[0, 0, 1], [1, 0, 0], [0, 1, 0]].forEach(v => w.vector(v));
  w.index(3); [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach(v => w.vector(v));
  w.index(1); // one BSP node
  w.vector([0, 0, 1]); w.f32(0); w.i32(0); w.i32(0); w.u8(0);
  [0, 0, -1, badNode ? 2 : -1, -1, -1, -1, 0, 0].forEach(n => w.index(n));
  w.u8(3); w.i32(-1); w.i32(-1);
  w.index(1); // one surface
  w.index(0); w.i32(0); [0, 0, 1, 2, -1, 0].forEach(n => w.index(n));
  w.i32(0); w.index(0); // two int16 pans, null brush
  w.index(staleVertex ? 4 : 3);
  [invalidLiveVertex ? 3 : 0, 1, 2, ...(staleVertex ? [63] : [])].forEach(n => { w.index(n); w.index(0); });
  w.i32(0); w.i32(0); // shared sides, zones
  for (let i = 0; i < 7; i++) w.index(0); // polys, light maps/bits, bounds, hulls, leaves, lights
  w.i32(1); w.i32(0);
  const data = w.data();
  return { data, pkg: pkgFor(data, ['None'], 0, 'Model') };
}

test('compiled BSP model yields the expected convex polygon triangle', () => {
  const { pkg, data } = modelFixture();
  const m = readModel(pkg, data, 1);
  assert.deepEqual(m.points, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  assert.deepEqual(triangulateModel(m), [{ points: [0, 1, 2], surface: 0, node: 0 }]);
  m.surfaces[0].flags = 1;
  assert.deepEqual(triangulateModel(m), []);
  assert.equal(triangulateModel(m, { includeInvisible: true }).length, 1);
});

test('stale unused pool slots are reported, but invalid referenced geometry is rejected', () => {
  const stale = modelFixture({ staleVertex: true });
  assert.equal(readModel(stale.pkg, stale.data, 1).diagnostics.unusedInvalidVertices, 1);
  for (const options of [{ invalidLiveVertex: true }, { badNode: true }]) {
    const { pkg, data } = modelFixture(options);
    assert.throws(() => readModel(pkg, data, 1), /Invalid .* index/);
  }
  const { data } = modelFixture();
  const truncated = data.subarray(0, data.length - 1);
  assert.throws(() => readModel(pkgFor(truncated, ['None'], 0, 'Model'), truncated, 1), /Truncated/);
});
