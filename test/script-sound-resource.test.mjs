import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import { exportAt } from '../src/unreal/objects.mjs';
import {
  SOUND_NATIVE_CONTRACT,
  ScriptSoundResourceError,
  decodeSoundPayload,
  decodeSoundResource,
} from '../src/runtime/script-sound-resource.mjs';

const ROOT = 'Deus Ex GOTY Edition';

async function fixture() {
  const assets = new AssetStore([{
    path: 'System/DeusExSounds.u',
    read: () => fs.readFile(`${ROOT}/System/DeusExSounds.u`),
  }]);
  return assets.get('DeusExSounds');
}

test('USound native contract pins recovered registration, layout and teardown gate', () => {
  assert.equal(SOUND_NATIVE_CONTRACT.staticClass, 0x10580868);
  assert.equal(SOUND_NATIVE_CONTRACT.instanceSize, 0x54);
  assert.deepEqual(SOUND_NATIVE_CONTRACT.serializer, {thunk: 0x103029fa, body: 0x1036f900});
  assert.deepEqual(SOUND_NATIVE_CONTRACT.destructor, {thunk: 0x10303a5d, body: 0x1031cb60});
  assert.equal(SOUND_NATIVE_CONTRACT.soundData.objectOffset, 0x28);
  assert.equal(SOUND_NATIVE_CONTRACT.soundData.archiveOffset, 0x2c);
  assert.equal(SOUND_NATIVE_CONTRACT.serializerFields.formatNameOffset, 0x44);
  assert.equal(SOUND_NATIVE_CONTRACT.serializerFields.serializedByteCountOffset, 0x48);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.nameSlot, 0x1c);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.countBytesSlot, 0x14);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.objectReferenceSlot, 0x18);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.helperBody, 0x10371140);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.seekSlot, 0x34);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.attachLazyLoaderSlot, 0x38);
  assert.equal(SOUND_NATIVE_CONTRACT.archive.versionGate, 0x3d);
  assert.equal(SOUND_NATIVE_CONTRACT.lazyLoaderDetach.soundDataDestructorBody, 0x1030ca50);
  assert.equal(SOUND_NATIVE_CONTRACT.lazyLoaderDetach.virtualSlot, 0x3c);
  assert.equal(SOUND_NATIVE_CONTRACT.lazyLoaderDetach.status, 'unsupported');
});

test('Switch4ClickOn and Switch4ClickOff decode the original lazy header and RIFF payload', async () => {
  const asset = await fixture();
  const expected = {
    'Special.Switch4ClickOn': {
      serialOffset: 11903835,
      serialSize: 11247,
      end: 11915082,
      waveBytes: 11238,
      dataBytes: 11118,
    },
    'Special.Switch4ClickOff': {
      serialOffset: 11959112,
      serialSize: 13375,
      end: 11972487,
      waveBytes: 13366,
      dataBytes: 13246,
    },
  };
  for (const [path, facts] of Object.entries(expected)) {
    const index = asset.exportsByPath.get(path.toLowerCase());
    const entry = exportAt(asset.pkg, index);
    const sound = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
    assert.equal(sound.kind, 'Sound');
    assert.equal(sound.packageVersion, 68);
    assert.equal(sound.serialOffset, facts.serialOffset);
    assert.equal(sound.serialSize, facts.serialSize);
    assert.equal(sound.payloadStatus, 'decoded-wave');
    assert.equal(sound.payloadComplete, false);
    assert.equal(sound.lazy.formatNameIndex, 1);
    assert.equal(sound.lazy.formatName, 'wav');
    assert.equal(sound.lazy.formatNameOffset, 1);
    assert.equal(sound.lazy.headerOffset, 2);
    assert.equal(sound.lazy.loaded, true);
    assert.equal(sound.lazy.absoluteEnd, facts.end);
    assert.equal(sound.lazy.inlineOffset, 9);
    assert.equal(sound.lazy.byteCount, facts.waveBytes);
    assert.equal(sound.wave.byteLength, facts.waveBytes);
    assert.equal(sound.wave.riffSize + 8, facts.waveBytes);
    assert.equal(sound.wave.riffType, 'WAVE');
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
    assert.equal(sound.wave.data.size, facts.dataBytes);
    assert.equal(sound.wave.data.bytes.length, facts.dataBytes);
    assert.deepEqual(sound.wave.info.map(item => [item.id, item.value]), [
      ['ICRD', '1999-03-29'],
      ['IENG', 'Stan Neuvo'],
      ['ISFT', 'Sound Forge 4.0'],
    ]);
    assert.deepEqual(sound.references, []);
    assert.deepEqual(sound.nameReferences.map(reference => [reference.index, reference.name]), [[1, 'wav']]);
    assert.deepEqual(sound.collector.references, []);
    assert.equal(sound.archive.formatName.slot, 0x1c);
    assert.equal(sound.archive.formatName.fieldOffset, 0x44);
    assert.equal(sound.archive.formatName.name, 'wav');
    assert.equal(sound.archive.countBytes.slot, 0x14);
    assert.equal(sound.archive.countBytes.fieldOffset, 0x48);
    assert.equal(sound.archive.countBytes.count, facts.waveBytes);
    assert.equal(sound.archive.countBytes.maximum, facts.waveBytes);
    assert.equal(sound.archive.objectReference.slot, 0x18);
    assert.equal(sound.archive.objectReference.observedCalls, 0);
    assert.match(sound.collector.unsupported[0], /FName/);
    assert.match(sound.collector.unsupported[1], /UObject/);
    assert.match(sound.collector.unsupported[2], /AttachLazyLoader/);
    assert.equal(sound.ownership.archive, null);
    assert.equal(sound.ownership.lazyLoader.status, 'unbound');
    assert.match(sound.unsupported[0], /lazy Sound loading/);
    assert.match(sound.unsupported[1], /archive detachment and allocation teardown/);
    assert.match(sound.unsupported[2], /Audio playback/);
  }
});

test('decoded Sound bytes are an owned host copy and preserve collector boundaries', async () => {
  const asset = await fixture();
  const index = asset.exportsByPath.get('special.switch4clickon');
  const entry = exportAt(asset.pkg, index);
  const sound = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
  const original = sound.bytes[0];
  sound.bytes[0] ^= 0xff;
  assert.notEqual(sound.bytes[0], original);
  assert.equal(asset.bytes[entry.serialOffset + sound.lazy.inlineOffset], original);
  assert.equal(sound.collector.references.length, 0);
  assert.equal(sound.ownership.hostStorage, 'owned-byte-copy');
  assert.equal(sound.payloadComplete, false);
});

test('Sound decoder rejects non-None properties, count mismatches, malformed RIFF and lazy extent drift', async () => {
  const asset = await fixture();
  const index = asset.exportsByPath.get('special.switch4clickon');
  const entry = exportAt(asset.pkg, index);
  const source = Uint8Array.from(asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize));

  const badProperties = source.slice();
  badProperties[0] = 1;
  assert.throws(() => decodeSoundPayload(badProperties), error => {
    assert.ok(error instanceof ScriptSoundResourceError);
    assert.equal(error.code, 'properties-not-terminated');
    return true;
  });

  const badCount = source.slice();
  badCount[6] = 0x67;
  assert.throws(() => decodeSoundPayload(badCount), error => {
    assert.ok(error instanceof ScriptSoundResourceError);
    assert.equal(error.code, 'byte-count-overrun');
    return true;
  });

  const badRiff = source.slice();
  badRiff[9] = 'R'.charCodeAt(0);
  badRiff[10] = 'I'.charCodeAt(0);
  badRiff[11] = 'F'.charCodeAt(0);
  badRiff[12] = 'X'.charCodeAt(0);
  assert.throws(() => decodeSoundPayload(badRiff), error => {
    assert.ok(error instanceof ScriptSoundResourceError);
    assert.equal(error.code, 'missing-riff');
    return true;
  });

  const badExtent = source.slice();
  badExtent[2] ^= 1;
  assert.throws(() => decodeSoundPayload(badExtent, {
    serialOffset: entry.serialOffset,
    serialSize: entry.serialSize,
    verifyPackageExtent: true,
  }), error => {
    assert.ok(error instanceof ScriptSoundResourceError);
    assert.equal(error.code, 'lazy-end-mismatch');
    return true;
  });
});

test('an empty lazy header keeps the FName metadata explicit and has no fabricated resource references', () => {
  const payload = Uint8Array.from([0, 0, 0, 0, 0, 0, 0]);
  const sound = decodeSoundPayload(payload);
  assert.equal(sound.payloadStatus, 'lazy-header-only');
  assert.equal(sound.lazy.formatNameIndex, 0);
  assert.equal(sound.lazy.formatName, null);
  assert.equal(sound.lazy.headerOffset, 2);
  assert.equal(sound.lazy.loaded, false);
  assert.equal(sound.lazy.byteCount, 0);
  assert.equal(sound.wave, null);
  assert.deepEqual(sound.references, []);
  assert.match(sound.unsupported[0], /lazy Sound loading/);
});

test('known non-WAV format names remain an explicit unsupported branch', () => {
  const payload = Uint8Array.from([0, 3, 0, 0, 0, 0, 1, 0xab]);
  const sound = decodeSoundPayload(payload, {
    nameTable: [{name: 'None'}, {name: 'wav'}, {name: 'Core'}, {name: 'mp3'}],
  });
  assert.equal(sound.lazy.formatNameIndex, 3);
  assert.equal(sound.lazy.formatName, 'mp3');
  assert.equal(sound.payloadStatus, 'unsupported-format');
  assert.equal(sound.wave, null);
  assert.equal(sound.bytes, null);
  assert.match(sound.unsupported[0], /not WAV/);
});
