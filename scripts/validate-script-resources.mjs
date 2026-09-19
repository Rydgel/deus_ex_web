import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptResourceRegistry} from '../src/runtime/script-resources.mjs';
import {loadOriginalGObjects} from './original-gobjects.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const system = path.join(root, 'System');
const names = (await readdir(system)).filter(name => /\.(u|utx|dx|unr|uax|umx)$/i.test(name)).sort();
const files = names.map(name => ({path: `System/${name}`, read: () => readFile(path.join(system, name))}));
const assets = new AssetStore(files);

let indexProvider = null;
const capture = path.resolve('.cache/original-gobjects.txt');
if (existsSync(capture)) indexProvider = (await loadOriginalGObjects(capture)).provider();
const registry = new ScriptResourceRegistry({assets, indexProvider});

function exportIndex(asset, exportPath) {
  const index = asset.exportsByPath.get(exportPath.toLowerCase());
  if (!index) throw new Error(`Missing ${asset.name}.${exportPath}`);
  return index;
}

const deco = await assets.get('DeusExDeco');
const sounds = await assets.get('DeusExSounds');
const lightIndex = exportIndex(deco, 'LightSwitch');
const light = await registry.materialize(deco, lightIndex);
assert.equal(light.kind, 'LodMesh');
assert.equal(light.nativeClass.path, 'Engine.LodMesh');
assert.equal(light.outer.kind, 'Package');
assert.equal(light.payloadStatus, 'decoded-lodmesh');
assert.equal(light.payloadComplete, false);
assert.deepEqual(light.payload.sequences.map(sequence => sequence.name), ['All', 'Still', 'Off', 'On']);
assert.deepEqual(light.payload.boundingBox.min, [-960, -162, -1600]);
assert.deepEqual(light.payload.boundingBox.max, [960, 162, 1600]);

const texture = await registry.materialize(deco, exportIndex(deco, 'Skins.LightSwitchTex1'));
assert.equal(texture.kind, 'Texture');
assert.equal(texture.nativeClass.fullPath, 'Engine.Texture');
assert.equal(texture.nativeClass.nativeRegistration.path, 'Engine.Texture');
assert.equal(texture.payloadStatus, 'opaque');

const soundRecords = [];
for (const soundPath of ['Special.Switch4ClickOn', 'Special.Switch4ClickOff']) {
  const record = await registry.materialize(sounds, exportIndex(sounds, soundPath));
  assert.equal(record.kind, 'Sound');
  assert.equal(record.nativeClass.path, 'Engine.Sound');
  assert.equal(record.payloadStatus, 'decoded-wave');
  assert.equal(record.payload.formatName.name,'wav');
  assert.equal(record.payload.wave.fmt.sampleRate,22050);
  assert.deepEqual(registry.collectReferences(record).nameReferences.map(ref=>ref.name),['wav']);
  soundRecords.push({path: soundPath, serialSize: record.entry.serialSize, status: record.payloadStatus});
}

const references = registry.references(light).map(reference => ({slot: reference.slot, target: reference.target.key}));
const report = {
  packageFiles: names.length,
  lightSwitch: {
    exportIndex: lightIndex,
    key: light.key,
    outer: light.outer.key,
    class: light.nativeClass.key,
    globalIndex: light.globalIndex,
    serialSize: light.entry.serialSize,
    sequences: light.payload.sequences.map(sequence => sequence.name),
    references,
    unsupported: light.unsupported,
  },
  texture: {key: texture.key, payloadStatus: texture.payloadStatus, unsupported: texture.unsupported},
  sounds: soundRecords,
  originalGlobalCapture: Boolean(indexProvider),
  unsupported: [
    'Sound native lazy loading and audio ownership',
    'Texture bulk-data decode and native ownership',
    'ULodMesh renderer, native load-graph lifecycle and final release',
  ],
};
console.log(JSON.stringify(report, null, 2));
