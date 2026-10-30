import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {
  SOUND_NATIVE_CONTRACT,
  decodeSoundResource,
} from '../src/runtime/script-sound-resource.mjs';
import {gameDirectory} from './game-directory.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const file = path.join(root, 'System', 'DeusExSounds.u');
const assets = new AssetStore([{path: file, read: () => readFile(file)}]);
const asset = await assets.get('DeusExSounds');

const expected = {
  'Special.Switch4ClickOn': {
    serialOffset: 11903835,
    serialSize: 11247,
    absoluteEnd: 11915082,
    waveBytes: 11238,
    dataBytes: 11118,
  },
  'Special.Switch4ClickOff': {
    serialOffset: 11959112,
    serialSize: 13375,
    absoluteEnd: 11972487,
    waveBytes: 13366,
    dataBytes: 13246,
  },
};

const sounds = [];
for (const [soundPath, facts] of Object.entries(expected)) {
  const index = asset.exportsByPath.get(soundPath.toLowerCase());
  assert.ok(index, `Missing ${soundPath}`);
  const entry = exportAt(asset.pkg, index);
  assert.equal(entry.className, 'Sound');
  assert.equal(entry.serialOffset, facts.serialOffset);
  assert.equal(entry.serialSize, facts.serialSize);
  const sound = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
  assert.equal(sound.lazy.formatNameIndex, 1);
  assert.equal(sound.lazy.formatName, 'wav');
  assert.equal(sound.lazy.formatNameOffset, 1);
  assert.equal(sound.lazy.headerOffset, 2);
  assert.equal(sound.lazy.absoluteEnd, facts.absoluteEnd);
  assert.equal(sound.lazy.byteCount, facts.waveBytes);
  assert.equal(sound.payloadStatus, 'decoded-wave');
  assert.equal(sound.payloadComplete, false);
  assert.equal(sound.wave.byteLength, facts.waveBytes);
  assert.equal(sound.wave.data.size, facts.dataBytes);
  assert.deepEqual(sound.wave.chunks.map(chunk => chunk.id), ['fmt ', 'data', 'LIST']);
  assert.deepEqual(sound.wave.fmt, {
    audioFormat: 1,
    channels: 1,
    sampleRate: 22050,
    averageBytesPerSecond: 44100,
    blockAlign: 2,
    bitsPerSample: 16,
    extraBytes: 0,
  });
  assert.deepEqual(sound.wave.info.map(item => [item.id, item.value]), [
    ['ICRD', '1999-03-29'],
    ['IENG', 'Stan Neuvo'],
    ['ISFT', 'Sound Forge 4.0'],
  ]);
  assert.deepEqual(sound.references, []);
  assert.deepEqual(sound.nameReferences.map(reference => [reference.index, reference.name]), [[1, 'wav']]);
  assert.equal(sound.archive.formatName.slot, 0x1c);
  assert.equal(sound.archive.formatName.fieldOffset, 0x44);
  assert.equal(sound.archive.countBytes.slot, 0x14);
  assert.equal(sound.archive.countBytes.fieldOffset, 0x48);
  assert.equal(sound.archive.countBytes.count, facts.waveBytes);
  assert.equal(sound.archive.countBytes.maximum, facts.waveBytes);
  assert.equal(sound.archive.objectReference.slot, 0x18);
  assert.equal(sound.archive.objectReference.observedCalls, 0);
  assert.equal(sound.archive.lazyHelper.body, 0x10371140);
  assert.deepEqual(sound.collector.references, []);
  assert.equal(sound.ownership.archive, null);
  assert.equal(sound.ownership.lazyLoader.status, 'unbound');
  sounds.push({
    path: soundPath,
    exportIndex: index,
    serialOffset: entry.serialOffset,
    serialSize: entry.serialSize,
    absoluteEnd: sound.lazy.absoluteEnd,
    formatName: sound.lazy.formatName,
    formatNameIndex: sound.lazy.formatNameIndex,
    waveBytes: sound.wave.byteLength,
    dataBytes: sound.wave.data.size,
    chunks: sound.wave.chunks.map(chunk => chunk.id),
    payloadStatus: sound.payloadStatus,
    payloadComplete: sound.payloadComplete,
    references: sound.references,
    nameReferences: sound.nameReferences,
    archive: sound.archive,
    unsupported: sound.unsupported,
  });
}

console.log(JSON.stringify({
  package: {name: asset.name, version: asset.pkg.version, file},
  native: {
    className: SOUND_NATIVE_CONTRACT.className,
    staticClass: SOUND_NATIVE_CONTRACT.staticClass,
    instanceSize: SOUND_NATIVE_CONTRACT.instanceSize,
    serializer: SOUND_NATIVE_CONTRACT.serializer,
    destructor: SOUND_NATIVE_CONTRACT.destructor,
    archive: SOUND_NATIVE_CONTRACT.archive,
    lazyLoaderDetach: SOUND_NATIVE_CONTRACT.lazyLoaderDetach,
  },
  sounds,
  unsupported: [
    'Native FSoundData external service allocation/release',
    'Audio playback and ClientHearSound',
  ],
}, null, 2));
