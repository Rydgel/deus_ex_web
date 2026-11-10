import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_HEADER_BINDINGS, LOADED_HEADER_BINDINGS, MirroredBinding, BindingStorage, RecordLevelBinding, RecordNetModeBinding}
  from '../src/runtime/script-bindings.mjs';
import {entryAccessor, defineEntryAccessor} from '../src/runtime/host-accessors.mjs';

// Live-heap step 5 (docs/live-heap.md "Step 5's results"): a binding is called as a method with its instance, and the header
// bindings of every native object are the same objects.

const instance = (nativeObject, extra = {}) => ({nativeObject, cls: {record: {name: 'Class record'}}, ...extra});

test('native header bindings read and write the instance\'s native object', () => {
  const outer = {identity: {name: 'outer'}};
  const native = {flags: 5, outer, name: 'Foo1'}, i = instance(native);
  assert.equal(NATIVE_HEADER_BINDINGS.ObjectFlags.get(i), 5);
  NATIVE_HEADER_BINDINGS.ObjectFlags.set(-1, i);
  assert.equal(native.flags, 0xffffffff, 'the flag word is stored as an unsigned 32-bit value');
  assert.equal(NATIVE_HEADER_BINDINGS.Outer.get(i), outer.identity);
  assert.equal(NATIVE_HEADER_BINDINGS.Outer.get(instance({outer: null})), null);
  assert.equal(NATIVE_HEADER_BINDINGS.Name.get(i), 'Foo1');
  assert.equal(NATIVE_HEADER_BINDINGS.Class.get(i), i.cls.record);
  assert.throws(() => NATIVE_HEADER_BINDINGS.Outer.set(null, i), /Changing native Outer requires object rename support/);
  assert.throws(() => NATIVE_HEADER_BINDINGS.Name.set('x', i), /Changing native Name requires object rename support/);
  assert.throws(() => NATIVE_HEADER_BINDINGS.Class.set(null, i), /Changing native Class is unsupported/);
  assert.throws(() => NATIVE_HEADER_BINDINGS.ObjectInternal.get(i), /Raw native ObjectInternal pointers are not represented/);
  assert.throws(() => NATIVE_HEADER_BINDINGS.ObjectInternal.set(0, i), /Writing native ObjectInternal is unsupported/);
});

test('two instances share one header binding and read their own native objects', () => {
  const a = instance({flags: 1}), b = instance({flags: 2});
  assert.equal(NATIVE_HEADER_BINDINGS.ObjectFlags.get(a), 1);
  assert.equal(NATIVE_HEADER_BINDINGS.ObjectFlags.get(b), 2);
  NATIVE_HEADER_BINDINGS.ObjectFlags.set(7, a);
  assert.equal(b.nativeObject.flags, 2);
});

test('loaded header bindings read the instance\'s receiver and resource and refuse writes', () => {
  const resource = {outer: {object: {name: 'pkg'}}}, i = instance(undefined, {receiver: {name: 'ConEvent0'}, loadedResource: resource});
  assert.equal(LOADED_HEADER_BINDINGS.Name.get(i), 'ConEvent0');
  assert.equal(LOADED_HEADER_BINDINGS.Class.get(i), i.cls.record);
  assert.equal(LOADED_HEADER_BINDINGS.Outer.get(i), resource.outer.object);
  resource.outer = {name: 'bare'};
  assert.equal(LOADED_HEADER_BINDINGS.Outer.get(i), resource.outer, 'an outer without an object is itself');
  resource.outer = null;
  assert.equal(LOADED_HEADER_BINDINGS.Outer.get(i), null);
  assert.throws(() => LOADED_HEADER_BINDINGS.Name.set('x', i), /Loaded Name mutation requires its native lifecycle service/);
  assert.throws(() => LOADED_HEADER_BINDINGS.ObjectFlags.get(i), /Loaded ObjectFlags requires the live native object lifecycle/);
  assert.throws(() => LOADED_HEADER_BINDINGS.ObjectInternal.set(0, i), /Loaded ObjectInternal mutation requires its native lifecycle service/);
});

test('a binding storage forwards get and set with its instance', () => {
  const calls = [], i = instance({});
  const binding = {get(instance) { calls.push(['get', instance]); return 3; }, set(value, instance) { calls.push(['set', value, instance]); }};
  const storage = new BindingStorage(binding, i);
  assert.equal(storage.get(), 3);
  storage.set(9);
  assert.deepEqual(calls, [['get', i], ['set', 9, i]]);
});

test('a mirrored binding writes its cell after binding and after every set', () => {
  const writes = [];
  const bytes = new DataView(new ArrayBuffer(16));
  const i = {arena: {view: bytes}, refs: [], base: 0};
  // an image cell of a bool word: tag 3 (BOOL) with mask 0x80000000, as scalarCell reads it
  const cell = {tag: 3, offset: 4, mask: -0x80000000, ref: 0, refCount: 0, members: null, element: null, dim: 0, stride: 0, key: null, actorBase: false, handle: false};
  let value = false;
  const inner = {get() { return value; }, set(v) { writes.push(v); value = v; }, mirror: true};
  const mirrored = new MirroredBinding(inner, i, cell, {copy: v => Boolean(v)});
  assert.equal(mirrored.mirrored, true);
  mirrored.write();
  assert.equal(bytes.getUint32(4, true), 0);
  mirrored.set(true, i);
  assert.deepEqual(writes, [true]);
  assert.equal(bytes.getUint32(4, true), 0x80000000);
  assert.equal(mirrored.get(i), true);
});

test('record level bindings are mirrored and read the record', () => {
  const record = {levelInfo: 'info', level: {netMode: 2}};
  const level = new RecordLevelBinding(record), net = new RecordNetModeBinding(record);
  assert.equal(level.mirror, true);
  assert.equal(net.mirror, true);
  assert.equal(level.get(), 'info');
  level.set('other');
  assert.equal(record.levelInfo, 'other');
  assert.equal(net.get(), 2);
  net.set(3.7);
  assert.equal(record.level.netMode, 3);
  record.level = undefined;
  assert.equal(net.get(), 0);
  net.set(1);
});

test('entry accessors are shared pairs that find each host\'s own state', () => {
  const SLOT = Symbol('slot');
  assert.equal(entryAccessor(SLOT, 2), entryAccessor(SLOT, 2));
  assert.notEqual(entryAccessor(SLOT, 1), entryAccessor(SLOT, 2));
  // A state answers for member `index`: this one stores twice the value it is given.
  const state = (a, b) => ({values: [a, b], get(index) { return this.values[index]; }, set(index, v) { this.values[index] = v * 2; }});
  const make = (a, b) => {
    const host = {name: 'h', position: [9, 9, 9]};
    Object.defineProperty(host, SLOT, {value: state(a, b)});
    defineEntryAccessor(host, 'position', SLOT, 0);
    defineEntryAccessor(host, 'rotation', SLOT, 1);
    return host;
  };
  const one = make(1, 2), two = make(10, 20);
  assert.equal(one.position, 1);
  assert.equal(two.rotation, 20);
  one.position = 5;
  assert.equal(one.position, 10);
  assert.equal(two.position, 10, 'the other host\'s state is its own');
  two.position = 4;
  assert.equal(one.position, 10);
  assert.equal(two.position, 8);
  const descriptor = Object.getOwnPropertyDescriptor(one, 'position');
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, false);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(Object.getOwnPropertyDescriptor(two, 'position').get, descriptor.get, 'every host shares the function');
  assert.deepEqual(Object.keys(one), ['name', 'position', 'rotation']);
  assert.deepEqual({...one}, {name: 'h', position: 10, rotation: 2});
  assert.throws(() => { delete one.position; }, TypeError);
});
