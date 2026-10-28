import test from 'node:test';
import assert from 'node:assert/strict';
import {linkScriptStruct, SCRIPT_STRUCT_LINK as S} from '../src/runtime/script-struct-link.mjs';
import {NativeSlots} from '../src/runtime/native-slots.mjs';

const raw = object => (offset, value, width = 4) => {
  object.nativeSlots.set(offset, value, width);
  return object;
};
const get = (object, offset) => object.nativeSlots.value(offset);
const record = values => ({nativeSlots: NativeSlots.from(Object.entries(values).map(([offset, value]) =>
  [Number(offset), {value, width: 4}]))});

test('UStruct Link preserves/rebuilds layout, builds inherited chains, and coalesces equal expanded conditions', () => {
  const fieldClass = record({0x28: null}); fieldClass.nativeAddress = 0x101f2b18;
  const propertyClass = record({0x28: fieldClass}); propertyClass.nativeAddress = S.propertyClass;
  const objectClass = record({0x28: propertyClass}); objectClass.nativeAddress = S.objectPropertyClass;
  const structClass = record({0x28: propertyClass}); structClass.nativeAddress = S.structPropertyClass;
  const classClass = {nativeAddress: S.classClass};
  const parent = record({0: 0x101758f4, 0x28: null, 0x38: null, 0x3c: 0x2f});
  const cls = record({0: 0x101758f4, 0x28: parent, 0x38: null, 0x3c: 0x38});
  parent.objectClass = cls.objectClass = classClass;
  const field = (owner, type, offset, flags, repOffset) => {
    const value = record({0x18: owner, 0x2c: null, 0x34: 1, 0x38: 4, 0x3c: flags, 0x48: offset});
    value.objectClass = type;
    raw(value)(0x44, repOffset, 2);
    return value;
  };
  const inherited = field(parent, propertyClass, 0x28, 0x404000, 0);
  const first = field(cls, objectClass, 0x30, 0x4020, 0);
  const second = field(cls, structClass, 0x34, 0x400020, 2);
  raw(parent)(0x38, inherited); raw(cls)(0x38, first); raw(first)(0x2c, second);
  const calls = [], writes = [];
  const archive = {preload() { throw new Error('mode zero must not preload'); }};
  const services = {
    linkProperty(property, seenArchive, previous) {
      assert.equal(seenArchive, archive);
      calls.push([property, previous]);
      raw(property)(0x48, 999);
    },
    writeSlot(object, offset, value) { writes.push([object, offset, value]); },
    readGlobal(address) { assert.equal(address, S.linkGate); return 0; },
    serializeExpression(owner, cursor, ar) {
      assert.equal(owner, cls);
      assert.equal(ar.vtable, 0x101751f8);
      cursor.set(cursor.get() + 2);
    },
    readScriptBytes(owner, start, count) {
      assert.equal(owner, cls);
      return Uint8Array.from([1, 2, 1, 2]).slice(start, start + count);
    },
  };
  linkScriptStruct(cls, {archive, secondArgument: 0, services});
  assert.deepEqual(calls, [[first, null], [second, first]]);
  assert.equal(get(first, 0x48), 0x30); assert.equal(get(second, 0x48), 0x34);
  assert.equal(get(cls, 0x3c), 0x38);
  assert.equal(get(cls, 0x58), first); assert.equal(get(first, 0x60), null);
  assert.equal(get(cls, 0x5c), second); assert.equal(get(second, 0x60), null);
  assert.equal(get(cls, 0x60), first); assert.equal(get(first, 0x4c), second);
  assert.equal(get(second, 0x4c), inherited); assert.equal(get(inherited, 0x4c), null);
  assert.equal(get(cls, 0x64), first); assert.equal(get(first, 0x50), inherited);
  assert.equal(get(cls, 0x68), second); assert.equal(get(second, 0x54), inherited);
  assert.equal(get(inherited, 0x50), null); assert.equal(get(inherited, 0x54), null);
  assert.equal(get(first, 0x58), second); assert.equal(get(second, 0x58), second);
  assert.ok(writes.findIndex(([o, p]) => o === cls && p === 0x58) <
    writes.findIndex(([o, p]) => o === cls && p === 0x5c));

  // Recomputed layout preloads before linking and starts at aligned Super size.
  const preloads = [];
  raw(first)(0x34, 2); raw(second)(0x38, 8);
  linkScriptStruct(cls, {archive, secondArgument: 1, services: {
    ...services,
    readGlobal: () => 1,
    preload(object) { preloads.push(object); },
    linkProperty(property, _archive, previous) {
      assert.equal(previous, property === first ? null : first);
      raw(property)(0x48, get(cls, 0x3c));
    },
  }});
  assert.deepEqual(preloads, [parent, first, second]);
  assert.equal(get(first, 0x48), 0x30); assert.equal(get(second, 0x48), 0x38);
  assert.equal(get(cls, 0x3c), 0x40);
  assert.throws(() => linkScriptStruct(cls, {archive}), /UProperty::Link/);

  // Actual scalar virtuals compose with UStruct's running size: three bytes,
  // an aligned two-int array, then an object reference, with no Link callback.
  const scalarOwner = record({0: 0x101758f4, 0x28: null, 0x38: null, 0x3c: 99});
  const byte = field(scalarOwner, propertyClass, 0, 0, 0);
  const int = field(scalarOwner, propertyClass, 0, 0, 0);
  const object = field(scalarOwner, objectClass, 0, 0, 0);
  for (const [property, kind, vtable, dim, next] of [
    [byte, 'ByteProperty', 0x10175b04, 3, int],
    [int, 'IntProperty', 0x10175bc4, 2, object],
    [object, 'ObjectProperty', 0x10175e04, 1, null],
  ]) {
    property.kind = kind;
    raw(property)(0, vtable); raw(property)(0x34, dim); raw(property)(0x2c, next);
  }
  raw(scalarOwner)(0x38, byte);
  const loaded = [];
  linkScriptStruct(scalarOwner, {archive: {preload(value) { loaded.push(value); }}, secondArgument: 1});
  assert.deepEqual(loaded, [byte, int, object]);
  assert.deepEqual([byte, int, object].map(value => get(value, 0x48)), [0, 4, 12]);
  assert.deepEqual([byte, int, object].map(value => get(value, 0x38)), [1, 4, 4]);
  assert.equal(get(scalarOwner, 0x3c), 16);
  assert.equal(get(scalarOwner, 0x58), object);
  assert.equal(get(byte, 0x4c), int);
  assert.equal(get(int, 0x4c), object);
});
