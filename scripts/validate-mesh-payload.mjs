/** Focused full-payload and vertex-unpack comparisons with the original DLL. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import { readObject, exportAt } from '../src/unreal/objects.mjs';
import {decodeLodMesh} from '../src/runtime/lodmesh.mjs';
import {decodeLodMeshPayload, readLodMeshFrame} from '../src/runtime/lodmesh-payload.mjs';
import {gameDirectory} from './game-directory.mjs';
import {destroyMesh} from '../src/runtime/script-mesh-load.mjs';
import {createLinkerLoadArchive} from '../src/runtime/script-linker-lazy-loader.mjs';
import {LAZY_OFFSETS, MESH_ARRAY_OFFSETS, hex, recordingDestroyServices, destroyedState, nativeDestroyedState} from './mesh-destruction-trace.mjs';

const root = gameDirectory(), rows = [];
for (const [packageName, index, modes, frames] of [
  ['DeusExDeco', 606, [false, true], [0, 1]],
  ['DeusExCharacters', 669, [false, true], [0, 71, 365]],
  ['DeusExDeco', 455, [true], [0]],
  ['DeusExDeco', 399, [true], [0]],
  // The game's five classic UMesh meshes (docs/umesh.md): UMesh::UMesh and UMesh::Serialize alone, no frames to unpack.
  ['DeusExDeco', 397, [false, true], null],
  ['DeusExDeco', 407, [true], null],
  ['DeusExDeco', 408, [false, true], null],
  ['DeusExDeco', 415, [true], null],
  ['DeusExCharacters', 723, [false, true], null],
]) {
  const bytes = await readFile(`${root}/System/${packageName}.u`), pkg = parsePackage(bytes);
  const entry = exportAt(pkg, index);
  for (const lazy of modes) rows.push({pkg, bytes, index, lazy, frames: frames ?? [],
    spec: {name: `${packageName}.${entry.name}:${lazy}`, version: pkg.version,
      start: entry.serialOffset, prefixSize: readObject(pkg, bytes, index).reader.offset,
      payload: bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize).toString('base64'),
      lazy: Number(lazy), loadDeferred: lazy, frames: frames ?? undefined, classic: !frames, destroy: !frames}});
}
// Loading-only remap branch: reverse each of LightSwitch's two 22-vertex frames.
// Original serializer processes the modified payload too; this is not an
// authored game asset and is never written back to the source package.
for (const expanded of [false, true]) {
  const source = rows[0], original = exportAt(source.pkg, source.index).toObject();
  const vertexCount = expanded ? 44 : 22;
  const old = Buffer.from(source.spec.payload, 'base64'), remap = Buffer.alloc(1 + vertexCount * 2);
  remap[0] = vertexCount;
  for (let i = 0; i < vertexCount; i++) remap.writeUInt16LE(21 - i % 22, 1 + i * 2);
  if (expanded) old.writeUInt32LE(vertexCount, 603); // Native +f0 transfer in this source export.
  const payload = Buffer.concat([old.subarray(0, -5), remap, old.subarray(-4)]);
  const entry = {...original, serialSize: payload.length}, bytes = Buffer.alloc(entry.serialOffset + entry.serialSize);
  payload.copy(bytes, entry.serialOffset);
  const pkg = {...source.pkg, exports: source.pkg.exports.with(source.index - 1, {serialSize: payload.length})};
  rows.push({...source, pkg, bytes, lazy: true, spec: {...source.spec,
    name: expanded ? 'LightSwitch-expanded-remap' : 'LightSwitch-remap',
    payload: payload.toString('base64'), lazy: 1, loadDeferred: true}});
}

const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const output = JSON.parse(execFileSync(python, ['scripts/native-mesh-load-oracle.py', root], {
  input: JSON.stringify(rows.map(row => row.spec)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}));
function sameBytes(actual, base64, label) {
  assert.ok(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(base64, 'base64')), label);
}
function compare(mesh, reference, label) {
  assert.equal(mesh.archivePosition - mesh.entry.serialOffset, reference.position, `${label} cursor`);
  for (const [offset, a] of Object.entries(reference.arrays)) {
    const decoded = mesh.arrays.get(Number(offset));
    assert.equal(decoded.num, a.num, `${label} ${offset} count`);
    assert.equal(decoded.max, a.max, `${label} ${offset} capacity`);
    assert.equal(decoded.elementSize, a.elementSize, `${label} ${offset} stride`);
    sameBytes(decoded.data, a.data, `${label} ${offset} all element bytes`);
    for (let i = 0; i < a.notifies.length; i++) {
      const notify = decoded.notifyArrays[i], expected = a.notifies[i];
      assert.equal(notify.num, expected.num); assert.equal(notify.max, expected.max);
      sameBytes(notify.data, expected.data, `${label} notify ${i}`);
    }
  }
  for (const [offset, a] of Object.entries(reference.lazy)) {
    const decoded = mesh.lazyArrays.get(Number(offset));
    assert.equal(decoded.savedPosition, a.savedPosition, `${label} ${offset} lazy sign/offset`);
    assert.equal(decoded.attached, a.attached);
  }
  const image = Buffer.from(reference.object, 'hex');
  for (const [offset, bits] of mesh.scalarBits) assert.equal(bits, image.readUInt32LE(offset), `${label} scalar ${offset}`);
  const float = offset => image.readFloatLE(offset);
  assert.deepEqual(mesh.boundingBox, {min: [0x28, 0x2c, 0x30].map(float),
    max: [0x34, 0x38, 0x3c].map(float), valid: !!image[0x40]});
  assert.deepEqual(mesh.boundingSphere, {center: [0x44, 0x48, 0x4c].map(float), radius: float(0x50)});
}
for (let i = 0; i < rows.length; i++) {
  const row = rows[i], native = output.cases[i];
  const mesh = decodeLodMeshPayload(row.pkg, row.bytes, row.index, {lazy: row.lazy});
  assert.equal(mesh.serializedEnd, mesh.entry.serialSize);
  assert.equal(mesh.payloadStatus, row.spec.classic ? 'decoded-mesh' : 'decoded-lodmesh');
  if (!row.spec.classic) assert.deepEqual(mesh.sequences, decodeLodMesh(row.pkg, row.bytes, row.index).sequences);
  compare(mesh, native, row.spec.name);
  if (native.deferred) {
    for (const a of mesh.lazyArrays.values()) {
      a.load(); const first = a.data; a.load(); assert.equal(a.data, first);
    }
    compare(mesh, native.deferred, `${row.spec.name} deferred`);
  }
  for (const frame of row.frames)
    sameBytes(readLodMeshFrame(mesh, frame), native.frames[frame], `${row.spec.name} original unpack frame ${frame}`);
  if (row.spec.classic) {
    // The collection's ~UMesh (docs/mesh-destruction.md) on the same object, its lazy arrays attached to a linker archive as the
    // original's four Attaches left them (Num 4, Max 33).
    const native = output.cases[i].destroy, values = new Map([[0, native.vtable]]);
    const member = offset => values.get(offset);
    for (const offset of LAZY_OFFSETS) values.set(offset, mesh.lazyArrays.get(offset).lazy);
    for (const offset of MESH_ARRAY_OFFSETS) values.set(offset, mesh.arrays.get(offset).source);
    const archive = createLinkerLoadArchive({linker: {}, reader: {},
      array: {data: Object.assign(LAZY_OFFSETS.map(member), {length: 33}), num: 4, max: 33}});
    for (const offset of LAZY_OFFSETS) member(offset).archive = archive;
    assert.deepEqual(native.before, {num: 4, max: 33, entries: LAZY_OFFSETS.map(hex)});
    const {services, events, loaders} = recordingDestroyServices({member, vtable: () => values.get(0), archive, classic: true,
      read: (_, offset) => values.get(offset), write: (_, offset, value) => values.set(offset, value)});
    values.set(0, 0x104290b8);
    destroyMesh({}, services);
    assert.deepEqual(events, native.events, `${row.spec.name} the original ~UMesh call sequence`);
    assert.equal(events.filter(e => e.op === 'Detach').length, 4);
    assert.deepEqual(destroyedState({member, vtable: () => values.get(0), archive, loaders, classic: true}), nativeDestroyedState(native),
      `${row.spec.name} the state the original ~UMesh leaves`);
    continue;
  }
  assert.throws(() => readLodMeshFrame(mesh, -1), /out of range/);
  assert.throws(() => readLodMeshFrame(mesh, mesh.frameCount), /out of range/);
}
console.log(`${rows.length} original DLL mesh comparisons passed: full arrays/scalars/bounds, deferred loading, remap and signed vertex frames; ` +
  `~UMesh's call order and end state on the ${rows.filter(row => row.spec.classic).length} classic rows.`);
