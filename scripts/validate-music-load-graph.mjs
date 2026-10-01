#!/usr/bin/env node
/** Music packages through the shared graph's original BeginLoad, CreateExport
 * and EndLoad Preload/PostLoad queue (docs/script-music-load.md): every
 * music export of Credits_Music.umx (the endgame credits' DynamicLoadObject)
 * and of two mission packages, compared with an independent parse of the
 * export's bytes: the UMusic registration and constructor, FileType, and the
 * Data lazy array (its bytes, OriginalSize = Num, loaded at Serialize since
 * GLazyLoad is clear). */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {MUSIC_NATIVE} from '../src/runtime/script-music-load.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const PACKAGES = ['Credits_Music', 'Intro_Music', 'LibertyIsland_Music'];
const files = [{path: 'System/Core.u'}, {path: 'System/Engine.u'}, ...PACKAGES.map(name => ({path: `Music/${name}.umx`}))]
  .map(file => ({...file, read: () => readFile(path.join(gameDirectory(), file.path))}));
const assets = new AssetStore(files);
const packageAssets = new Map();
for (const name of ['Core', 'Engine', ...PACKAGES]) packageAssets.set(name.toLowerCase(), await assets.get(name));
assert.equal(packageAssets.get('engine').exportsByPath.has('music'), false, 'Music is native-only in Engine.u');
const natives = JSON.parse(execFileSync(python, ['scripts/native-function-bind-oracle.py', gameDirectory(),
  '--registry-only'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
let lazy = 0;
const graph = createScriptLoadGraph({packageAssets, captureEvents: true, nativeFunctions: {
  readNative: index => natives.numbered[index] ?? natives.defaultHandler,
  getDllExport: (pkg, name) => natives.named[name],
  readPointer: cell => cell.pointer,
}, resourceServices: {
  seconds: () => 0, getLazyLoad: () => lazy, setLazyLoad: value => { lazy = value; },
  mipBias: () => 0,
}, lifecycle: {logReceiver: {name: 'GWarn'}, logEndLoad: () => {}, reallocLoaded: () => {}}});

const musicClass = graph.staticRecords.get('Engine.Music');
assert.equal(graph.slotOf(musicClass, 0x3c), 0x4c, 'UMusic instance size');
assert.equal(graph.slotOf(musicClass, 0x484), 0x52, 'registered class flags');
assert.ok(graph.superOf(musicClass) === graph.staticRecords.get('Core.Object'), 'Music extends Core.Object');

/** The export after its tagged properties: FName FileType, then the lazy
 * array (version > 61: an end offset, a compact count, the bytes). */
function parse(asset, index) {
  const object = readObject(asset.pkg, asset.bytes, index), reader = object.reader;
  const fileType = asset.pkg.names[reader.compact()].name;
  assert.ok(asset.pkg.version > 61, 'lazy arrays carry their end offset');
  // The reader is relative to the export; the stored end offset is the file's.
  const end = reader.u32(), count = reader.compact(), start = asset.pkg.exports[index - 1].serialOffset + reader.offset;
  assert.equal(start + count, end, 'the end offset follows the bytes');
  return {fileType, bytes: asset.bytes.subarray(start, end)};
}

let checked = 0;
for (const name of PACKAGES) {
  const asset = packageAssets.get(name.toLowerCase());
  graph.beginLoad();
  const linker = graph.buildLinker(name);
  const objects = [];
  for (const [exportPath, index] of asset.exportsByPath) {
    if (asset.pkg.exports[index - 1].className !== 'Music') continue;
    objects.push({exportPath, index, object: graph.indexToObject(linker, index)});
  }
  graph.endLoad();
  assert.ok(objects.length > 0, `${name} exports music`);
  for (const {exportPath, index, object} of objects) {
    const label = `${name}.${exportPath}`, expected = parse(asset, index);
    assert.ok(graph.classRecordOf(object) === musicClass, `${label}: native Music class`);
    assert.equal(object.resourceConstructed, 'Engine.Music', `${label}: constructed as Music`);
    assert.equal(graph.slotOf(object, 0), MUSIC_NATIVE.vtable, `${label}: UMusic vtable`);
    const data = object.instanceValues.get(0x28);
    assert.equal(data.vtable, MUSIC_NATIVE.lazyArrayVtable, `${label}: TLazyArray<BYTE> loader`);
    // FileType is an FName: the graph's interned name index.
    assert.equal(graph.nameText(object.instanceValues.get(0x40)).toLowerCase(), expected.fileType.toLowerCase(), `${label}: FileType`);
    assert.equal(data.bytes.num, expected.bytes.length, `${label}: Data.Num`);
    assert.equal(object.instanceValues.get(0x44), expected.bytes.length, `${label}: OriginalSize = Data.Num`);
    const stored = data.bytes.data, got = stored instanceof Uint8Array ? stored.subarray(0, data.bytes.num) : Uint8Array.from(stored.slice(0, data.bytes.num));
    assert.ok(Buffer.from(got).equals(Buffer.from(expected.bytes)), `${label}: Data bytes`);
    assert.equal(object.instanceValues.get(0x48), 0, `${label}: no audio handle`);
    checked++;
  }
}
console.log(`UMusic: ${checked} music exports of ${PACKAGES.join(', ')} loaded through the original queue, equal to their export bytes.`);
