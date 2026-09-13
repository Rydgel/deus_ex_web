/** Compare the Struct/FixedArray SerializeItem translations with the original
 * Core.dll virtual call probes.  The native oracle installs tiny callback
 * vtables in its private emulator heap; it never replaces a Core.dll body. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {
  SCRIPT_PROPERTY_SERIALIZE_ITEM,
  serializeStrItem,
  serializeArrayItem,
  serializeFixedArrayItem,
  serializeStructItem,
} from '../src/runtime/script-property-serialize-item.mjs';

const python = process.env.DEUS_EX_NATIVE_PYTHON ??
  fileURLToPath(new URL('../.cache/native-probe-env/bin/python', import.meta.url));
const oracle = fileURLToPath(new URL('./native-property-serialize-item-oracle.py', import.meta.url));
const {stdout} = await promisify(execFile)(python, [oracle, gameDirectory()], {
  maxBuffer: 4 * 1024 * 1024,
  timeout: 60000,
});
const nativePayload = JSON.parse(stdout);
assert.deepEqual(nativePayload.hashes, {
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});
const native = nativePayload.results;

assert.equal(native.fixed_array.count, 3);
assert.deepEqual(native.fixed_array.innerDataOffsets, [0, 4, 8]);
assert.equal(native.struct.preloadCount, 1);
assert.equal(native.struct.preloadIsStruct, true);
assert.equal(native.struct.serializeBinCount, 1);
assert.equal(native.struct.serializeBinArgsMatch, true);
assert.deepEqual(native.str_load_save.load.value, {data: [104, 256, 0], arrayNum: 3, arrayMax: 3});
assert.deepEqual(native.str_load_save.save.raw.map(event => [event.width, event.bytes]), [
  [1, [0x83]], [2, [0x68, 0]], [2, [0, 1]], [2, [0, 0]],
]);
assert.deepEqual(native.str_load_save.load.realloc.map(event => [event.bytes, event.tag]), [[6, 0x101ab50c]]);
assert.deepEqual(native.array_load_save.load.data, [7, 9]);
assert.equal(native.array_load_save.load.arrayMax, 34);
assert.deepEqual(native.array_load_save.load.realloc.map(event => event.bytes), [0, 136]);

const holder = value => ({
  get: () => value,
  set: next => { value = next; return next; },
});
const property = (kind, metadata = {}) => ({kind, metadata: {kind, ...metadata}});
const archive = {
  bytes: 0,
  operations: [],
  serializeRaw(_reference, width) { this.bytes += width; this.operations.push(['raw', width]); },
  preloadStruct(structure, context) { this.operations.push(['preload', structure.key, context.archiveVirtualSlot]); },
};

const inner = property('IntProperty', {elementSize: 4});
const fixed = property('FixedArrayProperty', {inner, fixedArraySize: 3});
const fixedResult = serializeFixedArrayItem(fixed, archive, holder([1, 2, 3]), {key: 'fixture.fixed'});
assert.equal(fixedResult.measuredBytes, native.fixed_array.count * native.fixed_array.innerElementSize);
assert.deepEqual(archive.operations, [['raw', 4], ['raw', 4], ['raw', 4]]);

const direct = property('ByteProperty', {name: 'direct', elementSize: 1});
const inherited = property('IntProperty', {name: 'inherited', elementSize: 4});
const structure = {key: 'fixture.Struct', fields: [direct, inherited]};
const struct = property('StructProperty', {struct: structure});
archive.bytes = 0;
archive.operations.length = 0;
const structResult = serializeStructItem(struct, archive,
  holder({direct: 7, inherited: 8}), {key: 'fixture.struct'});
assert.equal(structResult.measuredBytes, 5);
assert.deepEqual(archive.operations, [
  ['preload', 'fixture.Struct', 0x10],
  ['raw', 1],
  ['raw', 4],
]);

const bytesArchive = (input = [], state = {ar0c: 0, ar10: 0}) => ({
  archiveState: state,
  bytes: [],
  serializeRaw(reference, width) {
    if (state.ar0c) {
      let value = 0;
      for (let index = 0; index < width; index++) value |= (input.shift() ?? 0) << (index * 8);
      reference.set(value >>> 0);
      return this;
    }
    this.bytes.push([width, reference.get()]);
    return this;
  },
});
const strProperty = property('StrProperty');
const loadedString = {data: 'old', arrayNum: 4, arrayMax: 4};
const loadedStringArchive = bytesArchive([0x83, 0x68, 0, 0, 1, 0, 0], {ar0c: 1, ar10: 0});
const loadedStringResult = serializeStrItem(strProperty, loadedStringArchive, holder(loadedString), {key: 'fixture.str'}, {
  reallocateArray(record, _elementSize, details) { record.data = new Array(details.arrayMax); },
});
assert.deepEqual(loadedString, {data: [104, 256, 0], arrayNum: 3, arrayMax: 3});
assert.equal(loadedStringResult.serializedBytes, native.str_load_save.load.raw.reduce((sum, event) => sum + event.width, 0));

const loadedArray = {data: [0], arrayNum: 1, arrayMax: 1};
const arrayProperty = property('ArrayProperty', {inner: property('IntProperty', {elementSize: 4})});
serializeArrayItem(arrayProperty, bytesArchive([2, 7, 0, 0, 0, 9, 0, 0, 0], {ar0c: 1, ar10: 0}),
  holder(loadedArray), {key: 'fixture.array'}, {
    reallocateArray(record, _elementSize, details) { record.data = new Array(details.arrayMax); },
  });
assert.deepEqual(loadedArray.data.slice(0, 2), native.array_load_save.load.data);
assert.equal(loadedArray.arrayMax, native.array_load_save.load.arrayMax);

assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.fixedArrayProperty.body, 0x10167da0);
assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.structProperty.body, 0x101691b0);
assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.structSerializeBin.body, 0x10126610);
console.log('Str/Array/FixedArray/Struct SerializeItem translations match the hash-pinned Core.dll probes, including loading/saving flags, CompactIndex bytes, reallocation, and element recursion.');
