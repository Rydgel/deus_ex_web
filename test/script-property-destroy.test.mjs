import test from 'node:test';
import assert from 'node:assert/strict';
import {
  destroyScriptProperty,
  SCRIPT_PROPERTY_DESTROY,
  UnsupportedScriptPropertyDestroyError,
} from '../src/runtime/script-property-destroy.mjs';
import {NativeSlots} from '../src/runtime/native-slots.mjs';

const NEED = SCRIPT_PROPERTY_DESTROY.flags.needDestruction;

function property(kind, metadata = {}) {
  const type = metadata.type ?? ({
    Property: 'int', ByteProperty: 'byte', IntProperty: 'int', BoolProperty: 'bool',
    FloatProperty: 'float', ObjectProperty: 'object', ClassProperty: 'class',
    NameProperty: 'name', StrProperty: 'string', ArrayProperty: 'array',
    FixedArrayProperty: 'fixedArray', MapProperty: 'map', StructProperty: 'struct',
  }[kind]);
  return {kind, metadata: {type, arrayDim: 1, ...metadata}};
}

function ref(value, key = 'value') {
  let current = value;
  return {
    reference: true,
    key,
    get: () => current,
    set: next => { current = next; return next; },
    value: () => current,
  };
}

function linkedString(extra = {}) {
  return property('StrProperty', {type: 'string', elementSize: 12, ...extra});
}

test('base scalar and map DestroyValue leave their storage untouched', () => {
  const intValue = {sentinel: 0x11111111};
  const mapValue = {sentinel: 0x22222222};
  const intResult = destroyScriptProperty(property('IntProperty'), ref(intValue));
  const mapResult = destroyScriptProperty(property('MapProperty'), ref(mapValue));
  assert.equal(intResult.storage, 'untouched');
  assert.equal(mapResult.storage, 'untouched');
  assert.deepEqual(intValue, {sentinel: 0x11111111});
  assert.deepEqual(mapValue, {sentinel: 0x22222222});
});

test('logical FString destruction clears text without pretending to allocate', () => {
  const value = ref('authored text');
  const trace = [];
  const result = destroyScriptProperty(linkedString(), value, {trace});
  assert.equal(value.value(), '');
  assert.equal(result.storage, 'logical');
  assert.equal(trace.some(event => event.operation === 'realloc'), false);
});

test('native FString destruction pre-clears, reallocates, frees, and resets in order', () => {
  const value = ref({data: 0x1234, arrayNum: 8, arrayMax: 12});
  const calls = [];
  const result = destroyScriptProperty(linkedString(), value, {
    realloc(pointer, bytes, details) {
      calls.push(['realloc', pointer, bytes, details.tag]);
      assert.equal(value.get().arrayNum, 0);
      assert.equal(value.get().arrayMax, 0);
      return 0x5678;
    },
    free(pointer) { calls.push(['free', pointer]); },
  });
  assert.deepEqual(calls, [['realloc', 0x1234, 0, 0x101ab50c], ['free', 0x5678]]);
  assert.deepEqual(value.value(), {data: 0, arrayNum: 0, arrayMax: 0});
  assert.equal(result.storage, 'native');
});

test('UStrProperty visits fixed dimensions in increasing order', () => {
  const values = [
    {data: 0x10, arrayNum: 1, arrayMax: 2},
    {data: 0x20, arrayNum: 3, arrayMax: 4},
  ];
  const calls = [];
  const result = destroyScriptProperty(linkedString({arrayDim: 2}), ref(values), {
    elementReference(root, index) {
      return {
        get: () => root.get()[index],
        set: next => { root.get()[index] = next; return next; },
      };
    },
    realloc(pointer) { calls.push(['realloc', pointer]); return pointer; },
    free(pointer) { calls.push(['free', pointer]); },
  });
  assert.deepEqual(calls, [['realloc', 0x10], ['free', 0x10], ['realloc', 0x20], ['free', 0x20]]);
  assert.deepEqual(values, [{data: 0, arrayNum: 0, arrayMax: 0}, {data: 0, arrayNum: 0, arrayMax: 0}]);
  assert.equal(result.elements.length, 2);
});

test('UArrayProperty only destroys NeedCtorLink elements, then clears its TArray header', () => {
  const scalarInner = property('IntProperty', {flags: 0, elementSize: 4});
  const scalarValue = ref({data: [7, 9], arrayNum: 2, arrayMax: 5});
  destroyScriptProperty(property('ArrayProperty', {inner: scalarInner, elementSize: 12}), scalarValue);
  assert.deepEqual(scalarValue.value(), {data: [], arrayNum: 0, arrayMax: 0});

  const stringInner = linkedString({flags: NEED});
  const strings = [{data: 'first'}, {data: 'second'}];
  const ownedValue = ref({data: strings, arrayNum: 2, arrayMax: 2});
  const nestedClears = [];
  const result = destroyScriptProperty(property('ArrayProperty', {
    inner: stringInner, elementSize: 12,
  }), ownedValue, {trace: event => {
    if (event.operation === 'string-logical-clear') nestedClears.push(event.arrayIndex);
  }});
  assert.deepEqual(nestedClears, [0, 1]);
  assert.deepEqual(ownedValue.value(), {data: [], arrayNum: 0, arrayMax: 0});
  assert.equal(result.ownedInner, true);
});

test('UFixedArrayProperty destroys each inline element and leaves outer storage', () => {
  const values = ['left', 'right'];
  const value = ref(values);
  const result = destroyScriptProperty(property('FixedArrayProperty', {
    inner: linkedString({flags: NEED}), arrayCount: 2,
  }), value);
  assert.deepEqual(values, ['', '']);
  assert.equal(result.storage, 'logical-inline');
});

test('UStructProperty is member-major across outer ArrayDim and keeps scalar members', () => {
  const stringField = {key: 'fixture.name', metadata: {type: 'string', arrayDim: 1, elementSize: 12}};
  const intField = {key: 'fixture.number', metadata: {type: 'int', arrayDim: 1, elementSize: 4}};
  const structure = {fields: [stringField, intField]};
  const values = [
    {'fixture.name': 'one', 'fixture.number': 11},
    {'fixture.name': 'two', 'fixture.number': 22},
  ];
  const order = [];
  const value = ref(values);
  const result = destroyScriptProperty(property('StructProperty', {
    arrayDim: 2, struct: structure,
  }), value, {
    trace(event) {
      if (event.operation === 'destroy-dispatch' && event.kind === 'StrProperty') {
        order.push(event.arrayIndex);
      }
    },
  });
  assert.deepEqual(values, [
    {'fixture.name': '', 'fixture.number': 11},
    {'fixture.name': '', 'fixture.number': 22},
  ]);
  assert.deepEqual(order, [0, 1]);
  assert.equal(result.elementSize, null);
  assert.equal(result.fields, 2);
});

test('linked struct child chain is consumed lazily after each child dimension loop', () => {
  const order = [];
  const first = {key: 'name', metadata: {type: 'string', arrayDim: 1},
    nativeSlots: NativeSlots.from([[0x54, {value: null}]])};
  const second = {key: 'number', metadata: {type: 'int', arrayDim: 1},
    nativeSlots: NativeSlots.from([[0x54, {value: null}]])};
  first.nativeSlots.assign(0x54, second);
  const structure = {nativeSlots: NativeSlots.from([[0x68, {value: first}]])};
  const value = ref({name: 'x', number: 7});
  destroyScriptProperty(property('StructProperty', {struct: structure}), value, {
    readSlot(member, offset) {
      if (offset === 0x54) order.push(member.key);
      return undefined;
    },
  });
  assert.deepEqual(order, ['name', 'number']);
  assert.deepEqual(value.value(), {name: '', number: 7});
});

test('raw owned storage stays explicit when no cursor or allocator adapter exists', () => {
  const nativeArray = ref({native: true, data: 0x7000, arrayNum: 1, arrayMax: 1});
  assert.throws(() => destroyScriptProperty(property('ArrayProperty', {
    inner: linkedString({flags: NEED, elementSize: 12}), elementSize: 12,
  }), nativeArray), error => error instanceof UnsupportedScriptPropertyDestroyError &&
    error.code === 'UNSUPPORTED_SCRIPT_PROPERTY_DESTROY');

  const nativeString = ref({native: true, data: 0x8000, arrayNum: 1, arrayMax: 1});
  assert.throws(() => destroyScriptProperty(linkedString(), nativeString), error =>
    error instanceof UnsupportedScriptPropertyDestroyError && error.slot === 'GMalloc::Realloc');
});

test('ordinary Children and absent destructor-chain slots stay unsupported', () => {
  const missingHead = property('StructProperty', {
    struct: {children: []}, arrayDim: 1, elementSize: 12,
  });
  assert.throws(() => destroyScriptProperty(missingHead, ref({name: 'x'})), error =>
    error instanceof UnsupportedScriptPropertyDestroyError && error.slot === '+0x68');

  const missingNext = {key: 'name', metadata: {type: 'string', arrayDim: 1}, nativeSlots: new NativeSlots()};
  const missingNextProperty = property('StructProperty', {
    struct: {nativeSlots: NativeSlots.from([[0x68, {value: missingNext}]])}, arrayDim: 1, elementSize: 12,
  });
  assert.throws(() => destroyScriptProperty(missingNextProperty, ref({name: 'x'})), error =>
    error instanceof UnsupportedScriptPropertyDestroyError && error.slot === '+0x54');
});
