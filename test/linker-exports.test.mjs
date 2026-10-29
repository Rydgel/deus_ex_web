import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamicExportRecord, LinkerExports, exportObject, exportRecord, exportsHaveObject, setExportObject} from '../src/runtime/linker-exports.mjs';
import {buildLinkerExportHash} from '../src/runtime/script-linker-imports.mjs';
import {Reader} from '../src/unreal/package.mjs';

const entries = [
  {classIndex: -1, superIndex: 0, outer: 0, name: 'Alpha', flags: 4, serialSize: 10, serialOffset: 100},
  {classIndex: 1, superIndex: 0, outer: 1, name: 'Beta', flags: 0x80000004, serialSize: 0, serialOffset: null},
  {classIndex: 1, superIndex: 2, outer: 0, name: 'Gamma', flags: 4, serialSize: 7, serialOffset: 200},
];
const names = Int32Array.from([0x400, 0x401, 0x402]);

test('an export record is a live view over the table', () => {
  const table = new LinkerExports(entries, names);
  const view = table.record(1);
  assert.equal(table.length, 3);
  assert.deepEqual([view.classIndex, view.superIndex, view.packageIndex, view.objectName, view.objectFlags, view.serialSize, view.serialOffset],
    [1, 0, 1, 0x401, 0x80000004, 0, null]);
  assert.equal(view.object, null);
  assert.equal(view.hashNext, -1);
  const object = {kind: 'object'};
  table.setObject(1, object);
  assert.equal(view.object, object, 'a view held across the write sees it');
  view.object = null;
  assert.equal(table.object(1), null);
  view.hashNext = 2;
  assert.equal(table.hashNext(1), 2);
  assert.equal(table.record(3), undefined);
  assert.equal(table.record(-1), undefined);
  assert.equal(table.record(1.5), undefined);
  assert.deepEqual([...table].map(record => record.objectName), [0x400, 0x401, 0x402]);
  assert.equal(table.some(record => record.object), false);
  setExportObject(table, 2, object);
  assert.equal(exportsHaveObject(table), true);
  assert.equal(exportObject(table, 2), object);
  assert.equal(exportObject(table, 9), undefined);
});

test('the helpers read plain arrays of records the same way', () => {
  const records = [{object: null}, {object: {}}];
  assert.equal(exportRecord(records, 1), records[1]);
  assert.equal(exportObject(records, 1), records[1].object);
  setExportObject(records, 0, 5);
  assert.equal(records[0].object, 5);
  assert.equal(exportsHaveObject(records), true);
  assert.equal(exportObject(undefined, 0), undefined);
});

test('the dynamic graph view names its fields as FindExportIndex reads them', () => {
  const table = new LinkerExports(entries, names, DynamicExportRecord);
  const view = table.record(2);
  assert.deepEqual([view.classIndex, view.outerIndex, view.nameIndex, view.nextHash, view.object], [1, 0, 0x402, -1, null]);
  view.nextHash = 0;
  assert.equal(table.hashNext(2), 0);
});

test('the export hash over a table equals the hash over plain records', () => {
  const imports = [
    {classPackage: 0x14, className: 0x29b, packageIndex: -2, objectName: 0x600, object: null, sourceLinker: null, sourceIndex: -1},
    {classPackage: 0x14, className: 0x298, packageIndex: 0, objectName: 0x14, object: null, sourceLinker: null, sourceIndex: -1},
  ];
  const root = {name: 0x500};
  const services = {read: (object, field) => object?.[field]};
  const tableLinker = {imports, root, exports: new LinkerExports(entries, names)};
  const plainLinker = {imports, root, exports: entries.map((entry, i) => ({classIndex: entry.classIndex, superIndex: entry.superIndex,
    packageIndex: entry.outer, objectName: names[i], objectFlags: entry.flags, serialSize: entry.serialSize, serialOffset: entry.serialOffset, object: null}))};
  buildLinkerExportHash(tableLinker, services);
  buildLinkerExportHash(plainLinker, services);
  assert.deepEqual([...tableLinker.exportHash], [...plainLinker.exportHash]);
  for (let i = 0; i < entries.length; i++) assert.equal(tableLinker.exports.hashNext(i), plainLinker.exports[i].hashNext);
});

// Reader.compact: the integer arithmetic gives the values of the formula it replaced, for every length, sign and group boundary.
function encode(value) {
  const negative = value < 0;
  let magnitude = Math.abs(value);
  let first = magnitude % 0x40;
  magnitude = Math.floor(magnitude / 0x40);
  if (magnitude !== 0) first |= 0x40;
  if (negative) first |= 0x80;
  const bytes = [first];
  while (magnitude !== 0) {
    let byte = magnitude % 0x80;
    magnitude = Math.floor(magnitude / 0x80);
    if (magnitude !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}
function oldCompact(bytes) {
  let at = 0;
  const first = bytes[at++];
  const negative = (first & 0x80) !== 0;
  let value = first & 0x3f;
  let more = (first & 0x40) !== 0;
  for (let index = 1; more; index++) {
    const byte = bytes[at++];
    value += (byte & (index === 4 ? 0x1f : 0x7f)) * 2 ** (6 + (index - 1) * 7);
    more = index < 4 && (byte & 0x80) !== 0;
  }
  return negative && value !== 0 ? -value : value;
}

test('Reader.compact decodes what the exponent formula decoded', () => {
  const values = [0, 1, 63, 64, 8191, 8192, 1048575, 1048576, 134217727, 134217728, 536870911, 1073741823, 1073741824, 2147483647];
  let seed = 12345;
  for (let i = 0; i < 2000; i++) { seed = (seed * 1103515245 + 12345) >>> 0; values.push((seed >>> (seed & 7)) & 0x7fffffff); }
  for (const value of values) for (const signed of [value, -value]) {
    const bytes = encode(signed);
    const decoded = new Reader(Uint8Array.from(bytes)).compact();
    assert.ok(Object.is(decoded, signed === 0 ? 0 : signed), `${signed}`);
    assert.ok(Object.is(decoded, oldCompact(bytes)), `${signed} against the exponent formula`);
  }
});
