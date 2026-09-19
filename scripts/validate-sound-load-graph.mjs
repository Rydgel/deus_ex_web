#!/usr/bin/env node
/** Real native-only Sound exports through CreateExport/Preload/EndLoad and
 * retained lazy archives. Original resource bodies and CDO initializer provide
 * the references; no invented Engine.u Sound class or predecoded payload. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';

const names = ['Core', 'Engine', 'DeusExSounds', 'DeusExConAudioMission00'];
const assets = new AssetStore((await readdir(path.join(gameDirectory(), 'System'))).map(name => ({path: `System/${name}`,
  read: () => readFile(path.join(gameDirectory(), 'System', name))})));
const packageAssets = new Map();
const pending = [...names];
while (pending.length) {
  const name = pending.pop();
  if (packageAssets.has(name.toLowerCase())) continue;
  const asset = await assets.get(name);
  packageAssets.set(name.toLowerCase(), asset);
  pending.push(...asset.pkg.dependencies);
}
assert.equal(packageAssets.get('engine').exportsByPath.has('sound'), false,
  'Sound really is native-only in the original Engine.u');
const cases = [], graphs = [];
for (const [packageName, key, special] of [
  ['DeusExSounds', 'special.switch4clickon', false],
  ['DeusExConAudioMission00', 'conaudiomission00_79', true],
]) {
  let lazy = 0, audioReads = 0;
  const lifecycle = [];
  const graph = createScriptLoadGraph({packageAssets, captureEvents: true, resourceServices: {
    seconds: () => assert.fail('Sound does not read a texture clock'),
    mipBias: () => assert.fail('Sound does not read texture mip bias'),
    getLazyLoad: () => lazy, setLazyLoad: value => { lazy = value; },
    readAudio: () => { audioReads += 1; return null; },
  }, lifecycle: {
    logReceiver: {name: 'GWarn'}, logEndLoad: () => lifecycle.push('Logf'),
    reallocLoaded: ({array, num, max}) => {
      assert.equal(array, graph.loadedObjects); assert.equal(num, 0); assert.equal(max, 0);
      lifecycle.push('Realloc');
    },
  }});
  const asset = packageAssets.get(packageName.toLowerCase());
  const index = asset.exportsByPath.get(key), decoded = readObject(asset.pkg, asset.bytes, index);
  const entry = decoded.entry, linker = graph.buildLinker(packageName), archive = linker.archive;
  const spec = {name: `${packageName}.${entry.path}`, start: entry.serialOffset,
    prefixSize: decoded.reader.offset, version: asset.pkg.version, nameMap: linker.names,
    payload: Buffer.from(asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize)).toString('base64'),
    special, lazy: 0};
  cases.push(spec);
  assert.equal(graph.superOf(graph.staticRecords.get('Core.Object')), null,
    'native Core.Object self-Super argument is normalized before any class export load');
  graph.beginLoad();
  const sound = graph.indexToObject(linker, index);
  assert.equal(graph.classRecordOf(sound), graph.staticRecords.get('Engine.Sound'));
  assert.equal(graph.slotOf(sound, 0x18), special ? linker.root :
    graph.indexToObject(linker, entry.outer), 'native package/group Outer remains canonical');
  const snapshot = () => ({vtable: sound.nativeVtable, dataVtable: sound.soundData.nativeVtable,
    attached: sound.soundData.archive === archive, savedPosition: sound.soundData.lazyField08,
    ownerIsSelf: sound.soundData.owner === sound, format: sound.formatName,
    byteCount: sound.serializedByteCount, duration: sound.durationCache, tail: sound.copyField,
    num: sound.soundData.array.num, max: sound.soundData.array.max,
    bytes: Array.from(sound.soundData.array.data ?? []), position: archive.tell(), lazyGlobal: lazy});
  archive.seek(entry.serialOffset);
  const constructor = snapshot();
  graph.preload(sound);
  assert.equal(archive.tell(), entry.serialOffset, 'Preload restores its incoming cursor');
  archive.seek(entry.serialOffset + entry.serialSize);
  const serialized = snapshot();
  const queue = [...graph.loadedObjects];
  assert.equal(queue.includes(sound), true);
  graph.endLoad();
  assert.equal(graph.loadedObjects.length, 0);
  assert.equal(graph.loadState.nest, 0);
  assert.equal(graph.importState.importCount, 0);
  assert.deepEqual(lifecycle, ['Logf', 'Realloc']);
  for (const object of queue) {
    assert.equal(graph.slotOf(object, 0x1c) & 0x01000200, 0, `${graph.fullName(object)} completes load/postload`);
    assert.ok(graph.slotOf(object, 0x1c) & 0x20000000, 'base PostLoad reached');
  }
  assert.equal(sound.soundData.array.num, 0, 'Sound PostLoad keeps its payload deferred');
  assert.equal(archive.lazyLoaderArray.data[0], sound.soundData);
  assert.equal(archive.lazyLoaderArray.num, 1);
  graph.loadSoundResource(sound, {special});
  const loaded = snapshot();
  graph.loadSoundResource(sound, {special});
  assert.deepEqual(snapshot(), loaded, 'a second lazy load has no owner or cursor effects');
  assert.equal(audioReads, special ? 0 : 2, 'LoadSpecial never enters sound audio/owner logic');
  assert.equal(graph.loadExport(packageName, index), sound, 'repeated load preserves native identity');
  assert.equal(sound.instanceValues.get(0x44), sound.formatName);
  assert.equal(sound.instanceValues.get(0x48), sound.serializedByteCount);
  assert.equal(sound.instanceValues.get(0x4c), sound.durationCache);
  assert.equal(graph.slotOf(graph.classRecordOf(sound), 0x10), null, 'no fake Engine.u class linker');
  assert.deepEqual(graph.assertions, []);
  assert.deepEqual(graph.warnings.filter(w => w.kind !== 'exists'), []);
  graphs.push({graph, sound, constructor, serialized, loaded, queueSize: queue.length});
}

const native = JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-sound-graph-oracle.py', gameDirectory(), '--stdin'], {
    encoding: 'utf8', input: JSON.stringify(cases), maxBuffer: 4 * 1024 * 1024,
  }));
assert.equal(native.hashes['Engine.dll'], '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
assert.deepEqual(native.classDefaults.registration.slice(0, 9),
  [0, 0x54, 0x40, 0x1029e0d0, 0x1029e0d0, 0, 0, 0, 0]);
assert.deepEqual(native.classDefaults.registration.slice(12), [0x04084004, 0x10303891, 0x10101041]);
for (let i = 0; i < graphs.length; i += 1) {
  const {graph, sound, constructor, serialized, loaded} = graphs[i], reference = native.cases[i];
  const cls = graph.classRecordOf(sound), defaults = native.classDefaults;
  assert.equal(graph.slotOf(cls, 0x3c), defaults.size);
  assert.equal(graph.slotOf(cls, 0x484), defaults.classFlags);
  assert.equal(cls.defaults.num, defaults.num); assert.equal(cls.defaults.max, defaults.max);
  const bytes = new Uint8Array(0x54), view = new DataView(bytes.buffer);
  for (const [offset, value] of cls.defaults.data) view.setUint32(offset, value, true);
  assert.deepEqual([...bytes.subarray(0x28)], defaults.defaultTail, 'all native default tail bytes match');
  assert.deepEqual(constructor, reference.constructor, reference.name + ' constructor');
  assert.deepEqual(serialized, reference.serialized, reference.name + ' serializer');
  assert.deepEqual(loaded, reference.loaded, reference.name + ' lazy byte loading');
  assert.equal(graph.slotOf(sound, 0x1c) & 0x20000000, reference.postFlags & 0x20000000);
}
console.log('PASS Sound shared loader: original native-only class defaults, real WAV/MP3 construction, ' +
  `serialization and PostLoad; complete ${graphs.map(g => g.queueSize).join('/')} object load scopes; ` +
  '11238/43056 lazy bytes, native WAV duration and LoadSpecial owner preservation');
