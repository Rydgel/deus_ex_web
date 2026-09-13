import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {loadSoundDataNative} from '../src/runtime/script-sound-load.mjs';
import {
  SOUND_PERIOD_NATIVE_CONTRACT,
  getPeriod,
  readWaveInfo,
} from '../src/runtime/script-sound-period.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const soundFile = path.join(root, 'System', 'DeusExSounds.u');
const assets = new AssetStore([{path: soundFile, read: () => readFile(soundFile)}]);
const asset = await assets.get('DeusExSounds');

const originalFacts = {
  'Special.Switch4ClickOn': {
    serialOffset: 11903835,
    serialSize: 11247,
    waveBytes: 11238,
    dataBytes: 11118,
    period: 0.2521088421344757,
  },
  'Special.Switch4ClickOff': {
    serialOffset: 11959112,
    serialSize: 13375,
    waveBytes: 13366,
    dataBytes: 13246,
    period: 0.30036282539367676,
  },
};

const cases = [];
const expected = new Map();
for (const [soundPath, facts] of Object.entries(originalFacts)) {
  const index = asset.exportsByPath.get(soundPath.toLowerCase());
  assert.ok(index, `Missing ${soundPath}`);
  const entry = asset.pkg.exports[index - 1];
  const sound = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
  assert.equal(entry.serialOffset, facts.serialOffset);
  assert.equal(entry.serialSize, facts.serialSize);
  assert.equal(sound.wave.byteLength, facts.waveBytes);
  assert.equal(sound.wave.data.size, facts.dataBytes);
  assert.equal(sound.wave.fmt.channels, 1);
  assert.equal(sound.wave.fmt.sampleRate, 22050);
  assert.equal(sound.wave.fmt.bitsPerSample, 16);
  const name = soundPath.replace(/^Special\./, 'original-');
  cases.push({
    name,
    bytesBase64: Buffer.from(sound.bytes).toString('base64'),
    lazyPosition: -1,
  });
  expected.set(name, {bytes: sound.bytes, period: facts.period});
}

const zeroRate = makeWave({prefix: 'XXXX', rate: 0, oddJunk: true, smpl: true});
const noWave = makeWave({marker: 'NOPE'});
cases.push(
  {name: 'synthetic-zero-rate-padded-smpl', bytesBase64: Buffer.from(zeroRate).toString('base64'), lazyPosition: -1},
  {name: 'synthetic-no-wave-marker', bytesBase64: Buffer.from(noWave).toString('base64'), lazyPosition: -1},
);
expected.set('synthetic-zero-rate-padded-smpl', {bytes: zeroRate, period: 0});
expected.set('synthetic-no-wave-marker', {bytes: noWave, period: 0});

const work = await mkdtemp(path.join(os.tmpdir(), 'deus-ex-sound-period-'));
const casesFile = path.join(work, 'cases.json');
try {
  await writeFile(casesFile, JSON.stringify(cases));
  const python = process.env.DEUS_EX_NATIVE_PYTHON
    ?? process.env.NATIVE_PROBE_PYTHON
    ?? '.cache/native-probe-env/bin/python';
  const original = JSON.parse(execFileSync(python, [
    path.resolve('scripts/native-sound-period-oracle.py'), root, casesFile,
  ], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000}));
  assert.deepEqual(original.hashes, {
    'Engine.dll': SOUND_PERIOD_NATIVE_CONTRACT.imageSha256,
    'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  });
  assert.deepEqual(original.addresses, {
    getPeriod: SOUND_PERIOD_NATIVE_CONTRACT.getPeriod,
    readWaveInfo: SOUND_PERIOD_NATIVE_CONTRACT.readWaveInfo,
    genericLazyLoad: SOUND_PERIOD_NATIVE_CONTRACT.genericLazyLoad,
    periodConstant: SOUND_PERIOD_NATIVE_CONTRACT.periodConstant,
  });
  assert.equal(original.results.length, cases.length);

  const comparisons = [];
  for (const nativeCase of original.results) {
    const facts = expected.get(nativeCase.name);
    assert.ok(facts, `Unexpected native case ${nativeCase.name}`);
    const bytes = facts.bytes;
    const info = readWaveInfo(bytes);
    const soundData = {
      lazyField08: -1,
      array: {data: bytes, num: bytes.byteLength, max: bytes.byteLength},
    };
    const lazyCalls = [];
    const translatedPeriod = getPeriod(soundData, {
      bytes,
      lazyLoad: value => {
        assert.equal(value, soundData);
        lazyCalls.push('generic-lazy-load');
      },
    });
    assert.deepEqual(lazyCalls, ['generic-lazy-load'], `${nativeCase.name} lazy call order`);
    assert.equal(nativeCase.period, facts.period, `${nativeCase.name} native period fixture`);
    assert.equal(translatedPeriod, nativeCase.period, `${nativeCase.name} period`);
    assert.equal(info.valid, nativeCase.readWaveInfo, `${nativeCase.name} ReadWaveInfo result`);
    assert.equal(info.endOffset, nativeCase.arrayNum);
    if (info.valid) compareInfo(info, nativeCase.info, nativeCase.name);
    if (nativeCase.name.startsWith('original-')) {
      compareSoundLoad(nativeCase.name, bytes, facts.period);
    }
    comparisons.push({name: nativeCase.name, readWaveInfo: nativeCase.readWaveInfo, period: translatedPeriod});
  }

  // A positive saved position cannot be silently parsed without a loader.  A
  // supplied callback can publish the negative sign before parsing, matching
  // the generic helper boundary used by GetPeriod.
  const loaded = {lazyField08: 7, array: {data: zeroRate, num: zeroRate.byteLength, max: zeroRate.byteLength}};
  let callbackCount = 0;
  const loadedPeriod = getPeriod(loaded, {
    bytes: zeroRate,
    lazyLoad: value => {
      assert.equal(value, loaded);
      callbackCount += 1;
      value.lazyField08 = -7;
    },
  });
  assert.equal(callbackCount, 1);
  assert.equal(loadedPeriod, 0);
  assert.throws(() => getPeriod({lazyField08: 7, array: {data: zeroRate, num: zeroRate.length}}, {bytes: zeroRate}), {
    code: 'lazy-loader-unbound',
  });
  assert.throws(() => getPeriod({array: {data: zeroRate, num: zeroRate.length}}, {bytes: zeroRate}), {
    code: 'invalid-lazy-position',
  });
  assert.throws(() => getPeriod({lazyField08: -1, array: {data: zeroRate, num: zeroRate.length}}, {
    bytes: zeroRate,
    lazyLoad: () => Promise.resolve(),
  }), {
    code: 'async-lazy-loader',
  });
  assert.throws(() => readWaveInfo(zeroRate.subarray(0, 12)), {
    code: 'native-memory-read',
  });

  console.log(JSON.stringify({
    cases: comparisons.length,
    native: original.addresses,
    comparisons,
    unsupported: [
      'Positive lazy positions require the caller to bind the generic archive loader.',
      'Malformed/truncated native memory paths are reported unsupported rather than emulated as safe reads.',
    ],
  }, null, 2));
} finally {
  await rm(work, {recursive: true, force: true});
}

function compareInfo(info, nativeInfo, name) {
  assert.equal(nativeInfo.arrayEndOffset, info.endOffset, `${name} array end`);
  assert.equal(nativeInfo.waveHeaderPointerOffset, info.waveHeaderPointer, `${name} wave header pointer`);
  assert.deepEqual(nativeInfo.format, {
    sampleRatePointerOffset: info.fmt.pointers.sampleRate,
    averageBytesPerSecondPointerOffset: info.fmt.pointers.averageBytesPerSecond,
    blockAlignPointerOffset: info.fmt.pointers.blockAlign,
    bitsPerSamplePointerOffset: info.fmt.pointers.bitsPerSample,
    channelsPointerOffset: info.fmt.pointers.channels,
    bitsPerSample: info.fmt.bitsPerSample,
  }, `${name} fmt fields`);
  assert.deepEqual(nativeInfo.data, {
    sizePointerOffset: info.data.pointers.size,
    bytesPointerOffset: info.data.pointers.bytes,
    endOffset: info.data.endOffset,
    size: info.data.size,
    sizeCopy: info.data.size,
  }, `${name} data fields`);
  if (info.smpl) {
    assert.deepEqual(nativeInfo.smpl, {
      loopCount: info.smpl.loopCount,
      firstLoopOffset: info.smpl.firstLoopOffset,
    }, `${name} smpl fields`);
  } else {
    assert.equal(nativeInfo.smpl.loopCount, 0, `${name} no smpl loop count`);
    assert.equal(nativeInfo.smpl.firstLoopOffset, null, `${name} no smpl pointer`);
  }
}

function compareSoundLoad(name, bytes, expectedPeriod) {
  const owner = {durationCache: -1, serializedByteCount: 77};
  const data = {
    lazyField08: 1,
    array: {data: bytes, num: bytes.byteLength, max: bytes.byteLength},
    owner,
  };
  const events = [];
  loadSoundDataNative(data, {
    read: (object, key) => object[key],
    write: (object, key, value) => {
      assert.equal(object, owner, `${name} owner write target`);
      events.push(`write:${key}`);
      object[key] = value;
    },
    loadArray: value => {
      assert.equal(value, data, `${name} lazy array target`);
      events.push('load-array');
      value.lazyField08 = -1;
    },
    getPeriod: value => {
      assert.equal(value, data, `${name} GetPeriod target`);
      events.push('get-period');
      return getPeriod(value, {
        lazyLoad: candidate => {
          assert.equal(candidate, data, `${name} nested lazy target`);
          assert.equal(candidate.lazyField08, -1, `${name} nested lazy position`);
          events.push('period-lazy');
        },
      });
    },
    readAudio: () => {
      events.push('audio');
      return null;
    },
  });
  assert.equal(owner.durationCache, expectedPeriod, `${name} duration cache`);
  assert.equal(owner.serializedByteCount, bytes.byteLength, `${name} serialized count`);
  assert.deepEqual(events, [
    'load-array', 'get-period', 'period-lazy',
    'write:durationCache', 'audio', 'write:serializedByteCount', 'audio',
  ], `${name} Load owner order`);
}

function makeWave({prefix = 'RIFF', marker = 'WAVE', rate = 22050, oddJunk = false, smpl = false} = {}) {
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, 1, true);
  fmtView.setUint32(4, rate, true);
  fmtView.setUint32(8, rate * 2, true);
  fmtView.setUint16(12, 2, true);
  fmtView.setUint16(14, 16, true);
  const chunks = [];
  if (oddJunk) chunks.push(makeChunk('JUNK', Uint8Array.of(0x58)));
  chunks.push(makeChunk('fmt ', fmt));
  chunks.push(makeChunk('data', Uint8Array.of(1, 2, 3, 4)));
  if (smpl) {
    const payload = new Uint8Array(60);
    new DataView(payload.buffer).setUint32(0x1c, 2, true);
    chunks.push(makeChunk('smpl', payload));
  }
  const chunkBytes = concat(chunks);
  return concat([
    ascii(prefix),
    u32(0),
    ascii(marker),
    chunkBytes,
  ]);
}

function makeChunk(id, payload) {
  return concat([ascii(id), u32(payload.byteLength), payload,
    payload.byteLength & 1 ? Uint8Array.of(0) : new Uint8Array(0)]);
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function ascii(value) {
  return Uint8Array.from(value, char => char.charCodeAt(0));
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}
