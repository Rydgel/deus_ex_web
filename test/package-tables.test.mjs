import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackage } from '../src/unreal/package.mjs';
import { NameTable, ImportTable, ExportTable } from '../src/unreal/package-tables.mjs';
import { ExportPaths } from '../src/unreal/export-paths.mjs';
import { exportAt, importAt, nameAt, objectAt, entryOf } from '../src/unreal/objects.mjs';

// The same hand-authored package as package.test.mjs: six names, two imports (Core.Package Core, Core.Class TestActor), one export.
function fixture() {
  const bytes = new Uint8Array(164);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x9e2a83c1, true);
  view.setUint16(4, 69, true);
  view.setInt32(12, 6, true); view.setInt32(16, 56, true);
  view.setInt32(20, 1, true); view.setInt32(24, 146, true);
  view.setInt32(28, 2, true); view.setInt32(32, 132, true);
  let offset = 56;
  for (const name of ['None', 'Core', 'Package', 'Class', 'TestActor', 'TestActor0']) {
    const encoded = new TextEncoder().encode(name);
    bytes[offset++] = encoded.length + 1;
    bytes.set(encoded, offset);
    offset += encoded.length + 5;
  }
  bytes.set([1, 2, 0, 0, 0, 0, 1, 1, 3, 255, 255, 255, 255, 4], 132);
  bytes.set([0x82, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 4, 0x60, 2], 146);
  bytes.set([0xde, 0xad, 0xbe, 0xef], 160);
  return bytes;
}

test('a parsed package holds its tables as columns whose entries read as the objects did', () => {
  const pkg = parsePackage(fixture());
  assert.ok(pkg.names instanceof NameTable && pkg.imports instanceof ImportTable && pkg.exports instanceof ExportTable);
  assert.deepEqual([pkg.names.length, pkg.imports.length, pkg.exports.length], [6, 2, 1]);
  assert.equal(pkg.names.at(4).name, 'TestActor');
  assert.equal(pkg.names.at(4).flags, 0);   // the fixture writes zero flag words
  assert.deepEqual(pkg.names.toObject(1), { name: 'Core', flags: 0 });
  assert.deepEqual(pkg.imports.toObject(1), { classPackage: 'Core', className: 'Class', outer: -1, name: 'TestActor', path: 'Core.TestActor' });
  assert.deepEqual(pkg.exports.toObject(0), { classIndex: -2, superIndex: 0, outer: 0, name: 'TestActor0', flags: 0, serialSize: 4, serialOffset: 160,
    className: 'TestActor', path: 'TestActor0' });
  // an entry out of range, negative or fractional is undefined, as an element of an array was
  for (const index of [-1, 1, 1.5, NaN, undefined, '0']) assert.equal(pkg.exports.at(index), undefined, String(index));
  assert.equal(exportAt(pkg, 0), undefined); assert.equal(exportAt(pkg, -1), undefined); assert.equal(exportAt(pkg, 1).name, 'TestActor0');
  assert.equal(importAt(pkg, 1), undefined); assert.equal(importAt(pkg, -2).path, 'Core.TestActor');
  assert.equal(nameAt(pkg, 3), 'Class');
  assert.throws(() => nameAt(pkg, 6), /Invalid name reference 6/);
  assert.throws(() => objectAt(pkg, 2), /Invalid object reference 2/);
  assert.throws(() => objectAt(pkg, 1.5), /Invalid object reference/);
  assert.equal(objectAt(pkg, 0), null);
});

test('the tables answer the array methods the readers used', () => {
  const pkg = parsePackage(fixture());
  assert.deepEqual([...pkg.names].map(entry => entry.name), ['None', 'Core', 'Package', 'Class', 'TestActor', 'TestActor0']);
  assert.deepEqual(pkg.names.map((entry, index) => `${index}${entry.name[0]}`), ['0N', '1C', '2P', '3C', '4T', '5T']);
  assert.equal(pkg.names.findIndex(entry => entry.name === 'Class'), 3);
  assert.equal(pkg.names.find(entry => entry.name === 'Package').name, 'Package');
  assert.deepEqual(pkg.names.filter(entry => entry.name.startsWith('T')).map(entry => entry.name), ['TestActor', 'TestActor0']);
  assert.deepEqual(pkg.names.slice(-2).map(entry => entry.name), ['TestActor', 'TestActor0']);
  assert.equal(pkg.names.some(entry => entry.name === 'None'), true);
  assert.equal(pkg.names.every(entry => entry.flags === 0), true);
  assert.deepEqual([...pkg.imports.entries()].map(([index, entry]) => `${index}:${entry.path}`), ['0:Core', '1:Core.TestActor']);
  assert.deepEqual(pkg.exports.flatMap((entry, index) => [index, entry.className]), [0, 'TestActor']);
  const seen = []; pkg.names.forEach((entry, index, table) => { if (table === pkg.names) seen.push(index); });
  assert.equal(seen.length, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg)).imports[1], pkg.imports.toObject(1));
});

test('a hand-built package of plain arrays still reads through objectAt, nameAt and entryOf', () => {
  const pkg = { names: [{ name: 'None' }, { name: 'A' }], imports: [{ name: 'I', outer: 0 }], exports: [{ name: 'E', className: 'Class' }] };
  assert.equal(nameAt(pkg, 1), 'A');
  assert.equal(objectAt(pkg, 1).name, 'E'); assert.equal(objectAt(pkg, -1).name, 'I');
  assert.equal(exportAt(pkg, 1).className, 'Class'); assert.equal(exportAt(pkg, 0), undefined);
  assert.throws(() => nameAt(pkg, 2), /Invalid name reference/);
  // entryOf: an own entry wins, else the entry of asset and index
  assert.equal(entryOf({ entry: 'own', asset: { pkg }, index: 1 }), 'own');
  assert.equal(entryOf({ asset: { pkg }, index: 1 }).name, 'E');
  assert.equal(entryOf({ asset: null, index: null }), undefined);
});

const lowerMap = list => new Map(list.map((entry, index) => [entry.path.toLowerCase(), index + 1]));

test('ExportPaths answers the Map it replaced, repeated paths and iteration order included', () => {
  const list = [{ name: 'Foo', path: 'Foo' }, { name: 'foo', path: 'foo' }, { name: 'Bar', path: 'Pkg.Bar' }, { name: 'FOO', path: 'FOO' },
    { name: 'Baz', path: 'Pkg.Baz' }, { name: 'bar', path: 'pkg.BAR' }];
  const table = ExportTable.fromObjects(list), paths = new ExportPaths(table), map = lowerMap(list);
  assert.equal(paths.size, map.size);
  assert.deepEqual([...paths], [...map]);
  assert.deepEqual([...paths.keys()], [...map.keys()]);
  assert.deepEqual([...paths.values()], [...map.values()]);
  for (const key of [...map.keys(), 'FOO', 'Foo', 'nothing', '', 'pkg.', 'pkg.bar ']) assert.equal(paths.get(key), map.get(key), key);
  assert.equal(paths.get('foo'), 4, 'the later export of a repeated path');
  assert.equal(paths.has('pkg.baz'), true); assert.equal(paths.has('PKG.BAZ'), false);
  for (const key of [7, null, undefined, {}]) assert.equal(paths.get(key), undefined);
  const visited = []; paths.forEach((index, key, owner) => visited.push([key, index, owner === paths]));
  assert.deepEqual(visited.map(([key, index]) => [key, index]), [...map]);
});

test('ExportPaths over thousands of exports, with many colliding hashes and repeated paths', () => {
  let seed = 7;
  const next = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const list = Array.from({ length: 6000 }, () => { const name = `N${next(2500)}${'aAbB'[next(4)]}`; return { name, path: next(3) ? name : `P${next(40)}.${name}` }; });
  const table = ExportTable.fromObjects(list), paths = new ExportPaths(table), map = lowerMap(list);
  assert.equal(paths.size, map.size);
  assert.deepEqual([...paths], [...map]);
  for (const [key, index] of map) assert.equal(paths.get(key), index);
  for (let i = 0; i < 2000; i++) { const probe = `n${next(3000)}a`; assert.equal(paths.get(probe), map.get(probe)); }
});
