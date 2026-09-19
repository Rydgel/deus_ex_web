/** Original native-only mesh defaults/constructor and full shared load scopes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {readLodMeshFrame} from '../src/runtime/lodmesh-payload.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const binding = JSON.parse(execFileSync(python, ['scripts/native-function-bind-oracle.py', root, '--registry-only'], {encoding: 'utf8'}));
const files = [];
for (const dir of ['System', 'Maps', 'Textures', 'Sounds', 'Music']) for (const name of await readdir(`${root}/${dir}`))
  files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), packageAssets = new Map(), pending = ['Core', 'Engine', 'DeusExDeco', 'DeusExCharacters'];
while (pending.length) {
  const name = pending.pop(); if (packageAssets.has(name.toLowerCase())) continue;
  const asset = await assets.get(name); packageAssets.set(name.toLowerCase(), asset); pending.push(...asset.pkg.dependencies);
}
const lifecycle = [];
const graph = createScriptLoadGraph({packageAssets, captureEvents: true,
  resourceServices: {seconds: () => 12.5, getLazyLoad: () => 1,
    setLazyLoad: value => assert.equal(value, 1), mipBias: () => 0},
  nativeFunctions: {
    readNative: index => binding.numbered[index] ?? binding.defaultHandler,
    getDllExport(pkg, name, checked) {
      assert.equal(graph.fullName(pkg), 'Core'); assert.equal(checked, 1);
      assert.ok(binding.named[name], `original exported binding ${name}`); return binding.named[name];
    }, readPointer: cell => cell.pointer,
  }, lifecycle: {logReceiver: {}, logEndLoad: () => lifecycle.push('Logf'),
    reallocLoaded: ({array, num, max}) => {
      assert.equal(array, graph.loadedObjects); assert.equal(num, 0); assert.equal(max, 0);
      lifecycle.push('Realloc');
    }},
});
for (const name of ['Primitive', 'Mesh', 'LodMesh'])
  assert.equal(packageAssets.get('engine').exportsByPath.has(name.toLowerCase()), false);

function constructorImage(object) {
  const out = Buffer.alloc(0x1b0); out.writeUInt32LE(graph.slotOf(object, 0), 0);
  for (const [offset, value] of object.instanceValues) {
    if (typeof value === 'number') out.writeUInt32LE(value >>> 0, offset);
    else if (value?.vtable) out.writeUInt32LE(value.vtable, offset);
    else if (value?.elementSize) {
      out.writeUInt32LE(value.num, offset + 4); out.writeUInt32LE(value.max, offset + 8);
    }
  }
  return out;
}
const rows = [];
for (const [packageName, index, frames] of [['DeusExCharacters', 669, [0, 71, 365]], ['DeusExDeco', 606, [0, 1]]]) {
  const asset = packageAssets.get(packageName.toLowerCase()), stored = readObject(asset.pkg, asset.bytes, index);
  const {entry} = stored, linker = graph.buildLinker(packageName), archive = linker.archive;
  graph.beginLoad();
  const begin = graph.events.length, object = graph.indexToObject(linker, index);
  const constructor = constructorImage(object);
  const constructorEvents = graph.events.slice(begin).filter(e => e.op === 'MeshRealloc')
    .map(({elementSize, num, max}) => ({op: 'Realloc', elementSize, num, max}));
  assert.equal(graph.classRecordOf(object), graph.staticRecords.get('Engine.LodMesh'));
  assert.equal(graph.isA(object, graph.staticRecords.get('Core.Object')), true);
  archive.seek(entry.serialOffset);
  graph.preload(object);
  assert.equal(archive.tell(), entry.serialOffset, 'Preload restores its incoming shared cursor');
  const mesh = object.meshPayload;
  assert.equal(mesh.serializedEnd, entry.serialSize);
  assert.equal(mesh.arrays.get(0x60).num, 0, 'GetFrame data stays deferred through Preload');
  const objectMap = {'0': 0};
  for (const ref of mesh.objectReferences) {
    const canonical = graph.indexToObject(linker, ref.index);
    assert.equal(ref.object, canonical); objectMap[ref.index] = graph.addr(canonical) ?? 0;
  }
  const queued = [...graph.loadedObjects];
  graph.endLoad();
  assert.equal(graph.loadedObjects.length, 0); assert.equal(graph.loadState.nest, 0);
  assert.equal(graph.importState.importCount, 0);
  for (const record of queued) {
    const flags = graph.slotOf(record, 0x1c);
    assert.equal(flags & 0x01000200, 0, `${graph.fullName(record)} is fully loaded/postloaded`);
    assert.ok(flags & 0x20000000, `${graph.fullName(record)} reached base PostLoad`);
  }
  for (const offset of [0x54, 0x6c, 0x90, 0xc0]) {
    const lazy = object.instanceValues.get(offset);
    assert.equal(lazy.archive, archive);
    assert.ok(archive.lazyLoaderArray.data.slice(0, archive.lazyLoaderArray.num).includes(lazy));
  }
  assert.equal(mesh.arrays.get(0x60).num, 0, 'PostLoad also preserves deferred mesh vertices');
  rows.push({object, mesh, constructor, constructorEvents, queued: queued.length, frames,
    spec: {name: `${packageName}.${entry.name}`, start: entry.serialOffset, version: asset.pkg.version,
      prefixSize: stored.reader.offset, nameMap: linker.names, objectMap, lazy: 1, loadDeferred: true, frames,
      payload: Buffer.from(asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize)).toString('base64')}});
}
assert.deepEqual(lifecycle, ['Logf', 'Realloc', 'Logf', 'Realloc']);
// Host admission must not consume the native load flag for unsupported data.
{
  const source = packageAssets.get('deusexcharacters'), unsupportedAssets = new Map(packageAssets);
  unsupportedAssets.set('deusexcharacters', {...source, pkg: {...source.pkg, version: 69}});
  const unsupported = createScriptLoadGraph({packageAssets: unsupportedAssets, resourceServices: {
    seconds: () => 0, mipBias: () => 0, getLazyLoad: () => 1, setLazyLoad() {},
  }});
  const object = unsupported.indexToObject(unsupported.buildLinker('DeusExCharacters'), 669);
  const flags = unsupported.slotOf(object, 0x1c);
  assert.throws(() => unsupported.preload(object), /No recovered LodMesh load archive version/);
  assert.equal(unsupported.slotOf(object, 0x1c), flags);
  assert.ok(flags & 0x200);
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-mesh-graph-oracle.py', root], {
  input: JSON.stringify(rows.map(row => row.spec)), encoding: 'utf8', maxBuffer: 48 * 1024 * 1024,
}));
for (const defaults of reference.classDefaults) {
  const cls = graph.staticRecords.get(`Engine.${defaults.name}`);
  assert.equal(graph.slotOf(cls, 0x3c), defaults.size); assert.equal(graph.slotOf(cls, 0x484), defaults.classFlags);
  assert.equal(graph.addr(graph.superOf(cls)), defaults.registration[3]);
  assert.equal(graph.addr(graph.slotOf(cls, 0x49c)), defaults.registration[4]);
  assert.equal(graph.slotOf(cls, 0x4e4), defaults.registration[14]);
  assert.equal(cls.defaults.num, defaults.num); assert.equal(cls.defaults.max, defaults.max);
  const bytes = Buffer.alloc(defaults.size);
  for (const [offset, value] of cls.defaults.data) bytes.writeUInt32LE(value, offset);
  assert.equal(bytes.subarray(0x28).toString('hex'), defaults.defaultTail);
}
const bytesEqual = (a, b, label) => assert.ok(Buffer.from(a).equals(Buffer.from(b, 'base64')), label);
function compare(mesh, native) {
  for (const [offset, a] of Object.entries(native.arrays)) {
    const result = mesh.arrays.get(Number(offset));
    assert.equal(result.num, a.num); assert.equal(result.max, a.max);
    bytesEqual(result.data, a.data, `all bytes at native mesh +${offset}`);
    for (let i = 0; i < a.notifies.length; i++) bytesEqual(result.notifyArrays[i].data, a.notifies[i].data, 'global notify names');
  }
  const image = Buffer.from(native.object, 'hex');
  for (const [offset, value] of mesh.scalarBits) assert.equal(value, image.readUInt32LE(offset));
  for (const [offset, lazy] of mesh.lazyArrays) {
    assert.equal(lazy.savedPosition, native.lazy[`0x${offset.toString(16)}`].savedPosition);
    assert.equal(lazy.attached, true);
  }
}
for (let i = 0; i < rows.length; i++) {
  const row = rows[i], native = reference.cases[i], original = Buffer.from(native.constructor, 'hex');
  assert.ok(row.constructor.subarray(0x28).equals(original.subarray(0x28)), 'complete original constructor tail');
  assert.equal(row.constructor.readUInt32LE(0), original.readUInt32LE(0));
  assert.deepEqual(row.constructorEvents, native.constructorEvents.filter(e => e.op === 'Realloc'));
  assert.equal(native.postLoadVirtual, 0x1040c72e);
  assert.equal(graph.slotOf(row.object, 0x1c) & 0x20000000, native.postFlags & 0x20000000);
  compare(row.mesh, native);
  const before = row.mesh.archivePosition;
  for (const offset of [0x54, 0x6c, 0x90, 0xc0]) {
    const lazy = row.object.instanceValues.get(offset); graph.loadMeshArray(lazy); graph.loadMeshArray(lazy);
  }
  assert.equal(row.mesh.archivePosition, before);
  compare(row.mesh, native.deferred);
  for (const frame of row.frames) bytesEqual(new Uint8Array(readLodMeshFrame(row.mesh, frame).buffer), native.frames[frame], 'original GetFrame unpack');
  assert.equal(graph.loadExport(row.spec.name.split('.')[0], graph.slotOf(row.object, 0x14) + 1), row.object);
  assert.equal(row.object.meshPayload, row.mesh, 'repeated load preserves the same mesh view');
}
assert.deepEqual(graph.assertions, []);
assert.deepEqual(graph.warnings.filter(w => w.kind !== 'exists'), []);
console.log(`PASS native mesh load graph: 3 original class default images, full constructor/array data, ` +
  `${rows.map(row => row.queued).join('/')} objects through complete EndLoad scopes, canonical textures and retained lazy archives.`);
