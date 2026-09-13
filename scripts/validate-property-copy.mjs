/** Compare the translated raw property copies with original Core.dll bodies.
 * The oracle and this check both keep FArray::Realloc as an explicit no-op
 * over preallocated buffers. Allocator behavior is outside this comparison. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {copyGenericCompleteValue, copySinglePropertyValue, copyCompletePropertyValue} from '../src/runtime/script-property-copy.mjs';

const python = process.env.DEUS_EX_NATIVE_PYTHON ?? fileURLToPath(new URL('../.cache/native-probe-env/bin/python', import.meta.url));
const {stdout} = await promisify(execFile)(python,
  [fileURLToPath(new URL('./native-property-copy-oracle.py', import.meta.url)), gameDirectory()],
  {maxBuffer: 4 * 1024 * 1024, timeout: 60000});
const {results} = JSON.parse(stdout);
const p = (kind, extra = {}) => ({kind, arrayDim: 1, elementSize: 4, flags: 0, ...extra});
const cursor = (bytes, offset = 0) => ({bytes, offset});
const bytes = (length, fill = 0) => new Uint8Array(length).fill(fill);
const hexBytes = value => [...value].map(x => `0x${x.toString(16).padStart(2, '0')}`);
const view = c => new DataView(c.bytes.buffer, c.bytes.byteOffset + c.offset, c.bytes.byteLength - c.offset);
const hexWords = (c, count) => Array.from({length: count}, (_, i) => `0x${view(c).getUint32(i * 4, true).toString(16).padStart(8, '0')}`);
const setWords = (c, values) => values.forEach((v, i) => view(c).setUint32(i * 4, v, true));
const equal = (actual, expected, label) => assert.deepEqual(actual, expected, label);
let compared = 0;

const overlap = Uint8Array.from({length: 16}, (_, i) => i + 1);
copySinglePropertyValue(p('Property', {elementSize: 7}), cursor(overlap, 1), cursor(overlap));
equal(hexBytes(overlap), results.generic_single_overlap.buffer, 'generic overlapping dword/byte copy'); compared++;

const generic = p('Property', {arrayDim: 3}), genericDest = cursor(bytes(32, 0xdd)), genericSrc = cursor(bytes(32));
const genericCalls = [];
copyGenericCompleteValue(generic, genericDest, genericSrc, {
  copySingleValue(property, dest, source) {
    genericCalls.push([dest.offset, source.offset]);
    property.arrayDim = 1; property.elementSize = 8;
    setWords(dest, [0xc0c0c0c0]);
  },
});
equal(genericCalls.length, results.generic_complete_live_metadata.calls, 'live generic ArrayDim');
equal(generic.arrayDim, results.generic_complete_live_metadata.postArrayDim, 'post ArrayDim');
equal(generic.elementSize, results.generic_complete_live_metadata.postElementSize, 'post ElementSize');
equal(hexBytes(genericDest.bytes.subarray(0, 12)), results.generic_complete_live_metadata.destination, 'generic callback destination'); compared++;

const byteDest = cursor(bytes(8, 0xdd)), byteSrc = cursor(Uint8Array.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]));
copyCompletePropertyValue(p('ByteProperty', {arrayDim: 5, elementSize: 1}), byteDest, byteSrc);
equal(hexBytes(byteDest.bytes), results.byte_complete_array_dim_5.destination, 'specialized byte complete'); compared++;
const intDest = cursor(bytes(16)), intSrc = cursor(bytes(16));
setWords(intSrc, [0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00]);
copyCompletePropertyValue(p('IntProperty', {arrayDim: 3}), intDest, intSrc);
equal(hexWords(intDest, 4), results.int_complete_array_dim_3.destination, 'specialized integer complete'); compared++;
const boolDest = cursor(bytes(4)), boolSrc = cursor(bytes(4));
setWords(boolDest, [0xa5a5a5a5]); setWords(boolSrc, [0x12345678]);
copySinglePropertyValue(p('BoolProperty', {bitMask: 0xff0000}), boolDest, boolSrc);
equal(hexWords(boolDest, 1), results.bool_single_mask.destination, 'bool mask preservation'); compared++;

const heap = new Map(); let pointer = 0x1000;
function container(values, size, capacity = values.length) {
  const data = cursor(bytes(capacity * size)), header = cursor(bytes(12));
  for (let i = 0; i < values.length; i++) {
    if (size === 2) view(data).setUint16(i * 2, values[i], true);
    else view(data).setUint32(i * size, values[i], true);
  }
  heap.set(pointer, data); setWords(header, [pointer, values.length, capacity]); pointer += 0x100;
  return {header, data};
}
const heapServices = {reallocateArray() {}, resolvePointer: address => heap.get(address)};
const stringSrc = container([0x31, 0x32, 0], 2, 7), stringDest = container([0xdead, 0xdead, 0xdead, 0xdead], 2, 8);
copySinglePropertyValue(p('StrProperty', {elementSize: 12}), stringDest.header, stringSrc.header, heapServices);
equal({arrayNum: view(stringDest.header).getUint32(4, true), arrayMax: view(stringDest.header).getUint32(8, true),
  data: hexWords(stringDest.data, 4)}, results.str_single_count_capacity.destination, 'FString count and data'); compared++;
const originalStringHeader = stringSrc.header.bytes.slice();
copySinglePropertyValue(p('StrProperty', {elementSize: 12}), stringSrc.header, stringSrc.header);
equal(stringSrc.header.bytes, originalStringHeader, 'FString same-address guard');
equal(hexWords(stringSrc.data, 3), results.str_single_alias.data, 'FString native same-address bytes'); compared++;

const arraySrc = container([7, 9, 11], 4, 5), arrayDest = container([0, 0], 4, 6);
copySinglePropertyValue(p('ArrayProperty', {elementSize: 12, inner: p('IntProperty')}), arrayDest.header, arraySrc.header, heapServices);
equal({arrayNum: view(arrayDest.header).getUint32(4, true), arrayMax: view(arrayDest.header).getUint32(8, true),
  data: hexWords(arrayDest.data, 5)}, results.array_single_raw.destination, 'array raw branch'); compared++;

const recursiveSrc = container([1, 2, 3], 4), recursiveDest = container([], 4, 4), recursiveCalls = [];
copySinglePropertyValue(p('ArrayProperty', {elementSize: 12, inner: p('Property', {flags: 0x400000})}),
  recursiveDest.header, recursiveSrc.header, {...heapServices,
    copyCompleteValue(_property, dest, src) { recursiveCalls.push([dest.offset, src.offset]); setWords(dest, [0xa0a0a0a0]); },
  });
equal(recursiveCalls.length, results.array_single_recursive.calls, 'array owning callback count');
equal({arrayNum: view(recursiveDest.header).getUint32(4, true), data: hexWords(recursiveDest.data, 3)},
  results.array_single_recursive.destination, 'array owning element copies');
const offsets = (addresses, n) => addresses.slice(0, n).map(x => Number(x) - Number(addresses[0]));
equal(recursiveCalls.map(x => x[0]), offsets(results.array_single_recursive.destinations, recursiveCalls.length), 'array destination stride');
equal(recursiveCalls.map(x => x[1]), offsets(results.array_single_recursive.sources, recursiveCalls.length), 'array source stride'); compared++;

const fixedDest = cursor(bytes(16, 0xdd)), fixedSrc = cursor(Uint8Array.from({length: 16}, (_, i) => i)), fixedCalls = [];
copySinglePropertyValue(p('FixedArrayProperty', {count: 3, elementSize: 12, inner: p('Property')}), fixedDest, fixedSrc, {
  copyCompleteValue(_property, dest, src) { fixedCalls.push([dest.offset, src.offset]); setWords(dest, [0xf0f0f0f0]); },
});
equal(fixedCalls.length, results.fixed_array_single_recursive.calls, 'fixed-array complete callbacks');
equal(hexBytes(fixedDest.bytes), results.fixed_array_single_recursive.destination, 'fixed-array destination bytes');
equal(fixedCalls.map(x => x[0]), offsets(results.fixed_array_single_recursive.destinations, fixedCalls.length), 'fixed-array stride'); compared++;

const mapDest = cursor(Uint8Array.from({length: 12}, (_, i) => i));
copySinglePropertyValue(p('MapProperty'), mapDest, cursor(bytes(12)));
equal(hexBytes(mapDest.bytes), results.map_single_noop.after, 'original map no-op'); compared++;

const inherited = p('IntProperty', {offset: 8, next: null, id: 3});
const ignored = {kind: 'Function', offset: 4, next: null, id: 99};
const direct = p('IntProperty', {offset: 0, next: ignored, id: 1});
const struct = {children: direct, superStruct: {children: inherited, superStruct: null}};
const structDest = cursor(bytes(32, 0xdd)), visited = [];
copySinglePropertyValue(p('StructProperty', {struct}), structDest, cursor(bytes(32)), {
  getInheritanceSuper: record => record.superStruct,
  copyCompleteValue(field, dest) { visited.push(field.id); setWords(dest, [field.id === 1 ? 0x11111111 : 0x33333333]); },
});
equal(hexBytes(structDest.bytes.subarray(0, 16)), results.struct_single_inheritance_filter.destination, 'struct inheritance/filter/padding');
const nativeOrder = results.struct_single_inheritance_filter.visitOrder;
equal(visited, nativeOrder, 'native struct traversal order');
compared++;
console.log(`Property copying matches ${compared} original Core.dll reference cases; FArray allocation remains an explicit harness boundary.`);
