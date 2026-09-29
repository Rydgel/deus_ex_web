#!/usr/bin/env node
/**
 * Stage 1d of docs/object-memory.md: script-owned properties in a byte image
 * at their linked offsets (script-object-image.mjs), for one object of every
 * class in the installed packages.
 *
 * The contract is the logical storage the image replaced: a property read
 * returns what the value codec returned for the stored logical value, and a
 * write stores the codec's copy.
 *
 * 1. Defaults. An attached object reads each property as the class default
 *    the lazy slot path materialized (`defaultValue`, then the codec's read),
 *    and throws where it threw.
 * 2. Writes. Probe values for every imaged property type (byte wrap, int
 *    truncation, f32 rounding, -0, NaN, bool words, names, strings, pointers,
 *    vectors, rotators, structs, fixed and dynamic arrays) read back as the
 *    codec's copy.
 * 3. Bytes. Scalar properties are stored at their linked Offset, bools under
 *    their linked BitMask; a bool write leaves its dword neighbors intact.
 * 4. Unproducible values. A default or map-authored value that cannot be
 *    produced or copied throws at the same accesses as before.
 * 5. Handles (docs/rust-core.md, R1a and R1a-2). An object or class pointer's
 *    four bytes at its linked Offset are its only storage: they hold the
 *    handle of the class default the lazy path produces and of each written
 *    probe; None is zero. The reference array keeps no pointer.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {propertyCodec, zeroValue} from '../src/runtime/script-values.mjs';
import {linkedClassLayout} from '../src/runtime/script-object-layout.mjs';
import {identityOfHandle} from '../src/runtime/script-object-handles.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['System', 'Maps', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const loader = runtime.classLoader, graph = loader.graph;
const identity = record => loader.identity(record);

const classes = [];
for (const name of ['Core', 'Engine', 'Extension', 'ConSys', 'DeusEx', 'DeusExText', 'IpDrv', 'IpServer', 'UBrowser', 'Fire', 'UWindow']) {
  const pkg = await assets.get(name);
  for (const [index, entry] of pkg.pkg.exports.entries()) {
    if (entry.className !== 'Class') continue;
    try { classes.push(await runtime.loadClass(pkg, index + 1)); } catch { /* validate-object-layout.mjs owns the link set */ }
  }
}

const outcome = thunk => {
  try { return {value: thunk()}; } catch (error) { return {error: `${error.constructor.name}: ${error.message}`}; }
};

// Probe values by VM type; composite values are built from the property's own
// zero value so every linked member is present.
const SCALAR_PROBES = {
  byte: [0, 255, 256, -1, 3.7, true, null],
  int: [0, -1, 2 ** 31, 2 ** 32 + 5, -3.7, -0],
  float: [0.1, -0, 1e40, -1e-50, NaN, 16777217, -Infinity],
  bool: [true, false, 1, 0],
  name: ['Foo', 'None', null],
  string: ['abc', '', null],
  object: [null, 'SELF'],
  class: [null, 'CLASS'],
};
function probesFor(field) {
  const metadata = field.metadata, dim = metadata.arrayDim ?? 1;
  const element = elementProbes(field, metadata);
  if (dim === 1) return element;
  return element.map((probe, i) => Array.from({length: dim}, (_, index) => element[(i + index) % element.length]));
}
function elementProbes(field, metadata) {
  const type = metadata.type;
  if (SCALAR_PROBES[type]) return SCALAR_PROBES[type];
  if (type === 'array') return metadata.innerMetadata?.type === 'string' ? [[], ['a', null, 'b']] : [[], [1, -2.5, 2 ** 32 + 7]];
  if (type === 'struct') {
    if (metadata.structKey === 'core.object.vector') return [[1.1, -0, 1e40], [0, 0, 0]];
    if (metadata.structKey === 'core.object.rotator') return [[65536 + 5, -1, 3.7], [0, 0, 0]];
    const zero = zeroValue({...field, metadata: {...metadata, arrayDim: 1}});
    const filled = {...zero};
    for (const member of metadata.structFields) {
      const probes = probesFor(member);
      filled[member.key] = probes[1] ?? probes[0];
    }
    return [zero, filled];
  }
  return [];
}

// 'SELF' and 'CLASS' stand for the probed object and its class wherever a
// pointer sits: top level, struct members and fixed-array elements.
const substitute = (raw, object, cls) => raw === 'SELF' ? object : raw === 'CLASS' ? cls.record
  : Array.isArray(raw) ? raw.map(value => substitute(value, object, cls))
  : raw !== null && typeof raw === 'object'
    ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, substitute(value, object, cls)])) : raw;

let objects = 0, defaults = 0, defaultErrors = 0, writes = 0, byteChecks = 0, boolNeighbors = 0, handleDefaults = 0;
let pointerRejects = 0;
const pointer = entry => (entry.type === 'object' || entry.type === 'class') && entry.arrayDim === 1;
for (const cls of classes) {
  const layout = linkedClassLayout(cls, {graph, identity});
  const object = {name: `Image${objects}`};
  runtime.attach(object, cls);
  objects++;
  const instance = runtime.instance(object);
  assert.ok(instance.image, `${cls.record.key} has an object image`);
  assert.equal(instance.image.byteLength, layout.size, `${cls.record.key} image is PropertiesSize`);

  // 1. Defaults, against the lazy slot path.
  for (const field of cls.propertyLink) {
    const expected = outcome(() => propertyCodec(field).read(runtime.defaultValue(cls, field)));
    const actual = outcome(() => runtime.readField(object, field));
    assert.deepEqual(actual, expected, `${cls.record.key} default ${field.key}`);
    defaults++;
    if (expected.error) defaultErrors++;
  }

  // 5. Handles of the class defaults, against the lazy default path.
  const cells = instance.cells;
  for (const entry of layout.properties) {
    if (!pointer(entry) || !cells.has(entry.key)) continue;
    const expected = outcome(() => propertyCodec(entry.field).read(runtime.defaultValue(cls, entry.field)));
    if (expected.error) continue;
    const handle = instance.image.getUint32(entry.offset, true);
    assert.ok(identityOfHandle(handle) === (expected.value ?? null) && (handle === 0) === (expected.value == null),
      `${entry.key} default handle at +0x${entry.offset.toString(16)}`);
    handleDefaults++;
  }

  // 2 and 3. Writes, and where their bytes land.
  for (const entry of layout.properties) {
    const field = entry.field;
    if (!cells.has(field.key) || outcome(() => runtime.readField(object, field)).error) continue;
    for (const raw of probesFor(field)) {
      const probe = substitute(raw, object, cls);
      const codec = propertyCodec(field);
      const returned = outcome(() => runtime.writeField(object, field, probe));
      const expected = outcome(() => codec.copy(probe));
      assert.deepEqual(returned, expected, `${field.key} write ${JSON.stringify(raw)}`);
      if (expected.error) continue;
      assert.deepEqual(runtime.readField(object, field), expected.value, `${field.key} read after ${JSON.stringify(raw)}`);
      writes++;
      if (entry.arrayDim !== 1) continue;
      const image = instance.image, at = entry.offset, value = expected.value;
      switch (entry.type) {
        case 'byte': assert.equal(image.getUint8(at), value, `${field.key} byte at +0x${at.toString(16)}`); break;
        case 'int': assert.equal(image.getInt32(at, true), value, `${field.key} int at +0x${at.toString(16)}`); break;
        case 'float': assert.ok(Object.is(image.getFloat32(at, true), value), `${field.key} float at +0x${at.toString(16)}`); break;
        case 'bool': assert.equal((image.getUint32(at, true) & entry.mask) !== 0, value, `${field.key} bit ${entry.mask.toString(16)} at +0x${at.toString(16)}`); break;
        case 'object': case 'class':
          assert.ok(identityOfHandle(image.getUint32(at, true)) === (value ?? null), `${field.key} handle at +0x${at.toString(16)}`);
          assert.equal(image.getUint32(at, true) === 0, value === null, `${field.key} None is a zero pointer`);
          break;
        case 'struct':
          if (field.metadata.structKey === 'core.object.vector')
            for (let i = 0; i < 3; i++) assert.ok(Object.is(image.getFloat32(at + 4 * i, true), value[i]), `${field.key}[${i}] at +0x${(at + 4 * i).toString(16)}`);
          if (field.metadata.structKey === 'core.object.rotator')
            for (let i = 0; i < 3; i++) assert.equal(image.getInt32(at + 4 * i, true), value[i], `${field.key}[${i}] at +0x${(at + 4 * i).toString(16)}`);
          break;
        default: continue;
      }
      byteChecks++;
    }
    // A pointer holds an object or None; any other value has no handle and
    // is rejected before the bytes change (R1a-2).
    if (pointer(entry)) {
      const before = instance.image.getUint32(entry.offset, true);
      const rejected = outcome(() => runtime.writeField(object, field, 'NotAnObject'));
      assert.ok(String(rejected.error).startsWith('TypeError: An object or class property cannot hold a string'),
        `${field.key} rejects a string`);
      assert.ok(instance.image.getUint32(entry.offset, true) === before, `${field.key} keeps its handle after the rejected write`);
      pointerRejects++;
    }
  }
  // The reference array holds names, strings and dynamic arrays, never a
  // pointer (R1a-2), after every probe above.
  for (const value of instance.refs ?? [])
    assert.ok(value == null || typeof value === 'string' || Array.isArray(value), `${cls.record.key} reference array holds a ${typeof value}`);
  // A bool write changes only its own bit of the shared dword.
  const bools = layout.properties.filter(entry => entry.type === 'bool' && cells.has(entry.key));
  for (const entry of bools) {
    const word = instance.image.getUint32(entry.offset, true);
    const value = runtime.readField(object, entry.field);
    runtime.writeField(object, entry.field, !value);
    assert.equal(instance.image.getUint32(entry.offset, true), (word ^ entry.mask) >>> 0, `${entry.key} toggles only its bit`);
    runtime.writeField(object, entry.field, value);
    assert.equal(instance.image.getUint32(entry.offset, true), word, `${entry.key} restores its dword`);
    boolNeighbors++;
  }
}

// 4. Values that cannot be produced. A class default the loader could not
//    decode threw from the lazy slot path when the reference was made, and on
//    every read and write.
const camera = classes.find(cls => cls.record.key === 'engine.camerapoint');
const intField = camera.propertyLink.find(field => field.metadata.type === 'int' && (field.metadata.arrayDim ?? 1) === 1 && !field.key.startsWith('core.'));
const vectorField = camera.propertyLink.find(field => field.metadata.structKey === 'core.object.vector' && (field.metadata.arrayDim ?? 1) === 1);
const savedDefault = camera.defaults.get(intField.key);
camera.defaults.set(intField.key, new Map([[0, {unsupported: 'Undecoded default fixture'}]]));
const poisoned = {name: 'PoisonedDefault'};
runtime.attach(poisoned, camera);
const undecoded = {error: 'Error: Undecoded default fixture'};
assert.deepEqual(outcome(() => runtime.fieldReference(poisoned, intField)), undecoded, 'undecoded default: reference');
assert.deepEqual(outcome(() => runtime.readField(poisoned, intField)), undecoded, 'undecoded default: read');
assert.deepEqual(outcome(() => runtime.writeField(poisoned, intField, 1)), undecoded, 'undecoded default: write');
assert.deepEqual(outcome(() => runtime.readField(poisoned, vectorField)).error, undefined, 'other properties read');
if (savedDefault) camera.defaults.set(intField.key, savedDefault); else camera.defaults.delete(intField.key);

// A map-authored value reached the VM through the actor's binding: making
// the reference succeeded; a value the adapter could not produce threw on
// get and set, and a value its property could not copy threw only on read.
const mapped = {name: 'MappedActor'};
runtime.attach(mapped, camera);
const initial = Object.assign(field => {
  if (field === intField) throw new Error('Undecoded map property fixture');
  if (field === vectorField) return [1, 2];
  throw new Error('unexpected field');
}, {authoredFields: [intField, vectorField]});
runtime.applyInitialProperties(mapped, initial);
const unmapped = {error: 'Error: Undecoded map property fixture'};
const intRef = runtime.fieldReference(mapped, intField);
assert.deepEqual(outcome(() => intRef.get()), unmapped, 'undecoded map value: reference get');
assert.deepEqual(outcome(() => intRef.set(1)), unmapped, 'undecoded map value: reference set');
assert.deepEqual(outcome(() => runtime.readField(mapped, intField)), unmapped, 'undecoded map value: read');
assert.deepEqual(outcome(() => runtime.writeField(mapped, intField, 1)), unmapped, 'undecoded map value: write');
const badCopy = outcome(() => propertyCodec(vectorField).read([1, 2]));
assert.ok(badCopy.error, 'a two-component vector does not copy');
const vectorRef = runtime.fieldReference(mapped, vectorField);
assert.deepEqual(outcome(() => vectorRef.get()), badCopy, 'uncopyable map value: reference get');
assert.deepEqual(outcome(() => runtime.readField(mapped, vectorField)), badCopy, 'uncopyable map value: read');
assert.deepEqual(outcome(() => vectorRef.set([3, 4, 5])), {value: [3, 4, 5]}, 'uncopyable map value: reference set');
assert.deepEqual(runtime.readField(mapped, vectorField), [3, 4, 5], 'the write replaces the uncopyable value');

// A reset restores the snapshot, unproducible values included.
const reset = {name: 'ResetActor'};
runtime.attach(reset, camera);
runtime.applyInitialProperties(reset, initial);
const snapshot = runtime.snapshotStorage(reset);
runtime.writeField(reset, vectorField, [7, 8, 9]);
runtime.restoreStorage(reset, snapshot);
assert.deepEqual(outcome(() => runtime.readField(reset, vectorField)), badCopy, 'reset restores the authored value');
assert.deepEqual(outcome(() => runtime.readField(reset, intField)), unmapped, 'reset keeps the undecoded value');

console.log(`validate-object-image: ${objects} objects, ${defaults} defaults (${defaultErrors} unproducible), ` +
  `${writes} writes, ${byteChecks} byte placements, ${boolNeighbors} bool words, ${handleDefaults} default handles, ` +
  `${pointerRejects} non-object pointer writes rejected: ok`);
