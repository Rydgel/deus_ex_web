import test from 'node:test';
import assert from 'node:assert/strict';
import {copySinglePropertyValue, copyCompletePropertyValue} from '../src/runtime/script-property-copy.mjs';
import {NativeSlots} from '../src/runtime/native-slots.mjs';

test('raw copy dispatch requires an established native class and preserves float bit patterns', () => {
  const source = new Uint8Array([0x01, 0x00, 0x80, 0x7f, 0, 0, 0, 0x80]);
  const destination = new Uint8Array(8);
  // Float Complete copies dwords, without float conversion or an ElementSize
  // read. The input includes a signalling NaN payload and negative zero.
  const property = {nativeSlots: NativeSlots.from([[0, {value: 0x10175d44}], [0x34, {value: 2}]])};
  copyCompletePropertyValue(property, {bytes: destination}, {bytes: source});
  assert.deepEqual(destination, source);
  assert.throws(() => copyCompletePropertyValue({}, {bytes: destination}, {bytes: source}),
    error => error.code === 'UNSUPPORTED_SCRIPT_PROPERTY_COPY');
  assert.throws(() => copyCompletePropertyValue({...property, kind: 'StrProperty'},
    {bytes: destination}, {bytes: source}), /vtable\/class/);
});

test('no-access native branches do not demand storage or allocator services', () => {
  copySinglePropertyValue({kind: 'MapProperty'}, null, null);
  copyCompletePropertyValue({kind: 'IntProperty', arrayDim: 0}, null, null);
  copyCompletePropertyValue({kind: 'Property', arrayDim: -1}, null, null);
  const string = new Uint8Array(12);
  copySinglePropertyValue({kind: 'StrProperty'}, {bytes: string}, {bytes: string.subarray(0)});
  assert.deepEqual(string, new Uint8Array(12));
});

test('owning copy rejects an absent heap service instead of aliasing a native pointer', () => {
  const destination = new Uint8Array(12).fill(0x55), before = destination.slice();
  assert.throws(() => copySinglePropertyValue({kind: 'StrProperty'},
    {bytes: destination}, {bytes: new Uint8Array(12)}),
  error => error.code === 'UNSUPPORTED_SCRIPT_PROPERTY_COPY' && /Realloc/.test(error.message));
  assert.deepEqual(destination, before);
});

test('struct copying requires the inheritance virtual instead of assuming a SuperField layout', () => {
  const structure = {children: null, superStruct: null};
  const property = {kind: 'StructProperty', struct: structure};
  assert.throws(() => copySinglePropertyValue(property, null, null),
    error => error.code === 'UNSUPPORTED_SCRIPT_PROPERTY_COPY' && error.slot === 'GetInheritanceSuper');
  let visited;
  copySinglePropertyValue(property, null, null, {getInheritanceSuper(record) { visited = record; return null; }});
  assert.equal(visited, structure);
});
