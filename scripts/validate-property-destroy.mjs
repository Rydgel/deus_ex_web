/** Compare the logical/native-shaped DestroyValue translation with Core.dll. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {destroyScriptProperty, SCRIPT_PROPERTY_DESTROY} from '../src/runtime/script-property-destroy.mjs';

const python = process.env.DEUS_EX_NATIVE_PYTHON ??
  fileURLToPath(new URL('../.cache/native-probe-env/bin/python', import.meta.url));
const {stdout} = await promisify(execFile)(python, [
  fileURLToPath(new URL('./native-property-destroy-oracle.py', import.meta.url)), gameDirectory(),
], {maxBuffer: 4 * 1024 * 1024, timeout: 60000});
const {results: native} = JSON.parse(stdout);
const NEED = SCRIPT_PROPERTY_DESTROY.flags.needDestruction;

const property = (kind, metadata = {}) => ({kind, metadata: {
  type: ({IntProperty: 'int', StrProperty: 'string', ArrayProperty: 'array',
    FixedArrayProperty: 'fixedArray', StructProperty: 'struct'}[kind] ?? kind),
  arrayDim: 1, ...metadata,
}});
const reference = value => ({get: () => value, set: next => next});
const nativeString = (arrayDim = 1) => property('StrProperty', {
  arrayDim, elementSize: 12,
});
const wordRecords = records => records.map(record => [record.data, record.arrayNum, record.arrayMax]);

function allocator(events) {
  return {
    realloc(pointer, bytes, details) {
      events.push({op: 'realloc', pointer, bytes, tag: details.tag});
      return pointer;
    },
    free(pointer) { events.push({op: 'free', pointer}); },
  };
}

function eventShape(events, pointers) {
  const roles = Array.isArray(pointers)
    ? Object.fromEntries(pointers.map((pointer, index) => [`element${index}`, pointer]))
    : pointers;
  const roleOf = pointer => Object.entries(roles).find(([, value]) => value === pointer)?.[0] ??
    `unknown:${String(pointer)}`;
  return events.map(event => {
    const shaped = {op: event.op, pointer: roleOf(event.pointer)};
    if (Object.hasOwn(event, 'bytes')) shaped.bytes = event.bytes;
    if (Object.hasOwn(event, 'tag')) shaped.tag = event.tag;
    return shaped;
  });
}

function destroyStringArrayCase() {
  const records = [
    {data: 0x1100, arrayNum: 2, arrayMax: 4},
    {data: 0x1120, arrayNum: 3, arrayMax: 6},
  ];
  const events = [];
  const root = reference(records);
  destroyScriptProperty(nativeString(2), root, {
    ...allocator(events),
    elementReference(parent, index) {
      return {
        get: () => parent.get()[index],
        set: next => { parent.get()[index] = next; return next; },
      };
    },
  });
  return {records, events, pointers: {element0: 0x1100, element1: 0x1120}};
}

function destroyArrayStringCase() {
  const inner = nativeString();
  inner.metadata.flags = NEED;
  const records = [{data: 0x2100, arrayNum: 2, arrayMax: 2}, {data: 0x2120, arrayNum: 2, arrayMax: 2}];
  const array = {native: true, data: 0x2200, arrayNum: 2, arrayMax: 2};
  const events = [];
  const root = reference(array);
  destroyScriptProperty(property('ArrayProperty', {inner, elementSize: 12}), root, {
    ...allocator(events),
    elementReference(parent, index) {
      return {get: () => records[index], set: next => { records[index] = next; return next; }};
    },
  });
  return {array, records, events, pointers: {element0: 0x2100, element1: 0x2120, container: 0x2200}};
}

function destroyFixedStringCase() {
  const records = [{data: 0x3100, arrayNum: 2, arrayMax: 2}, {data: 0x3120, arrayNum: 2, arrayMax: 2}];
  const events = [];
  const root = reference({native: true, data: 0x3200});
  destroyScriptProperty(property('FixedArrayProperty', {
    inner: nativeString(), arrayCount: 2,
  }), root, {
    ...allocator(events),
    elementReference(_parent, index) {
      return {get: () => records[index], set: next => { records[index] = next; return next; }};
    },
  });
  return {records, events, pointers: {element0: 0x3100, element1: 0x3120}};
}

function destroyStructStringCase() {
  const member = {kind: 'StrProperty', offset: 4, metadata: {
    type: 'string', arrayDim: 1, elementSize: 12,
  }};
  const records = [{data: 0x4100, arrayNum: 2, arrayMax: 2}, {data: 0x4120, arrayNum: 2, arrayMax: 2}];
  const events = [];
  const root = reference({native: true, data: 0x4200});
  destroyScriptProperty(property('StructProperty', {
    struct: {fields: [member]}, arrayDim: 2, elementSize: 0x20,
  }), root, {
    ...allocator(events),
    memberReference(_parent, _member, details) {
      return {get: () => records[details.index], set: next => { records[details.index] = next; return next; }};
    },
  });
  return {records, events, pointers: {element0: 0x4100, element1: 0x4120}};
}

const primitiveValue = {words: [0x11111111, 0x22222222, 0x33333333]};
destroyScriptProperty(property('IntProperty'), reference(primitiveValue));
assert.deepEqual(primitiveValue.words, native.primitive, 'base scalar no-op');

const mapValue = {words: [0x44444444, 0x55555555, 0x66666666]};
destroyScriptProperty(property('MapProperty'), reference(mapValue));
assert.deepEqual(mapValue.words, native.map, 'map no-op');

const strings = destroyStringArrayCase();
assert.deepEqual(wordRecords(strings.records), native.str.records, 'FString record reset');
assert.deepEqual(eventShape(strings.events, strings.pointers), eventShape(native.str.events, native.str.pointers), 'FString free order');

const scalarInner = property('IntProperty', {flags: 0, elementSize: 4});
const scalarArray = {native: true, data: 0x5100, arrayNum: 2, arrayMax: 2};
const scalarPointers = {container: scalarArray.data};
const scalarEvents = [];
destroyScriptProperty(property('ArrayProperty', {inner: scalarInner, elementSize: 12}), reference(scalarArray), {
  ...allocator(scalarEvents),
});
assert.deepEqual(eventShape(scalarEvents, scalarPointers),
  eventShape(native.array_scalar_inner.events, native.array_scalar_inner.pointers), 'scalar TArray free');
assert.deepEqual([scalarArray.data, scalarArray.arrayNum, scalarArray.arrayMax], native.array_scalar_inner.header, 'scalar TArray header');

const arrayStrings = destroyArrayStringCase();
assert.deepEqual(wordRecords(arrayStrings.records), native.array_string_inner.elements, 'owned TArray elements');
assert.deepEqual(eventShape(arrayStrings.events, arrayStrings.pointers),
  eventShape(native.array_string_inner.events, native.array_string_inner.pointers), 'owned TArray free order');
assert.deepEqual([arrayStrings.array.data, arrayStrings.array.arrayNum, arrayStrings.array.arrayMax], native.array_string_inner.header, 'owned TArray header');

const fixedStrings = destroyFixedStringCase();
assert.deepEqual(wordRecords(fixedStrings.records), native.fixed_string_inner.elements, 'fixed FString elements');
assert.deepEqual(eventShape(fixedStrings.events, fixedStrings.pointers),
  eventShape(native.fixed_string_inner.events, native.fixed_string_inner.pointers), 'fixed FString free order');

const structStrings = destroyStructStringCase();
assert.deepEqual(wordRecords(structStrings.records), native.struct_string_member.elements, 'struct FString elements');
assert.deepEqual(eventShape(structStrings.events, structStrings.pointers),
  eventShape(native.struct_string_member.events, native.struct_string_member.pointers), 'struct FString free order');

console.log('Property destruction matches the bounded original Core.dll reference cases; logical values and unresolved storage remain explicit host boundaries.');
