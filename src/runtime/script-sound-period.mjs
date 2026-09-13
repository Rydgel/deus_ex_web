/**
 * The bounded Engine FSoundData::GetPeriod / FWaveModInfo::ReadWaveInfo
 * translation.  This module only reads a loaded byte array.  Archive loading,
 * native Sound storage and audio playback stay at their existing boundaries.
 * See docs/script-sound-period.md for the recovered instruction contract.
 */

export class ScriptSoundPeriodError extends Error {
  constructor(message, code = 'sound-period-error', offset = null) {
    super(offset === null ? message : `${message} at byte ${offset}`);
    this.name = 'ScriptSoundPeriodError';
    this.code = code;
    this.offset = offset;
  }
}

/** Addresses and constants recovered from the hash-verified Engine image. */
export const SOUND_PERIOD_NATIVE_CONTRACT = Object.freeze({
  packageName: 'Engine',
  imageSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  getPeriod: Object.freeze({thunk: 0x10303bc5, body: 0x1036f7a0}),
  readWaveInfo: Object.freeze({thunk: 0x10301c67, body: 0x1036fd10}),
  genericLazyLoad: Object.freeze({thunk: 0x10301168, body: 0x1030cbb0}),
  periodConstant: Object.freeze({address: 0x1042b148, value: 8.0}),
  soundData: Object.freeze({
    lazyFieldOffset: 0x08,
    arrayOffset: 0x0c,
  }),
  waveModInfo: Object.freeze({
    sampleRatePointer: 0x00,
    averageBytesPerSecondPointer: 0x04,
    blockAlignPointer: 0x08,
    bitsPerSamplePointer: 0x0c,
    channelsPointer: 0x10,
    bitsPerSample: 0x14,
    dataSizePointer: 0x18,
    waveHeaderPointer: 0x1c,
    dataPointer: 0x20,
    dataEnd: 0x24,
    dataSize: 0x28,
    arrayEnd: 0x2c,
    smplLoopCount: 0x30,
    smplLoopPointer: 0x34,
    dataSizeCopy: 0x38,
  }),
  zeroRateFallback: 22050,
});

/**
 * Parse the bounded FWaveModInfo fields from a loaded FSoundData array.
 *
 * `arrayNum` is the native TArray.Num boundary.  The parser deliberately
 * checks only the native WAVE marker at byte 8; it does not require RIFF or
 * inspect the RIFF size field.  Unknown chunks use native two-byte padding.
 * Native malformed inputs can fault while dereferencing a short header; this
 * host boundary reports those cases as ScriptSoundPeriodError instead.
 */
export function readWaveInfo(bytes, {arrayNum = null} = {}) {
  const input = asBytes(bytes);
  const count = arrayNum === null ? input.byteLength : arrayNum;
  validateArrayNum(count, input.byteLength);
  const end = count;
  if (end < 12) {
    throw new ScriptSoundPeriodError(
      'ReadWaveInfo requires bytes through the WAVE marker at offset 8',
      'truncated-wave-header',
    );
  }

  // Engine 0x1036fd5e compares the tag at data+8 and never checks RIFF.
  if (tagAt(input, 8) !== 'WAVE') {
    return invalidWaveInfo('missing-wave', end);
  }

  const fmtChunk = findChunk(input, 12, end, 'fmt ', 'format');
  if (!fmtChunk) return invalidWaveInfo('missing-format', end);
  const fmtDataEnd = checkedEnd(fmtChunk.dataOffset, fmtChunk.size, end,
    'format chunk', 'format-overrun');
  if (fmtDataEnd - fmtChunk.dataOffset < 16) {
    throw new ScriptSoundPeriodError(
      'ReadWaveInfo would dereference a short fmt chunk',
      'format-overrun', fmtChunk.dataOffset,
    );
  }

  const dataChunk = findChunk(input, 12, end, 'data', 'data');
  if (!dataChunk) return invalidWaveInfo('missing-data', end);
  checkedEnd(dataChunk.dataOffset, dataChunk.size, end,
    'data chunk', 'data-overrun');

  const fmt = Object.freeze({
    offset: fmtChunk.offset,
    dataOffset: fmtChunk.dataOffset,
    size: fmtChunk.size,
    // These fields mirror the locations read by GetPeriod.  The native body
    // does not require PCM (format tag 1) or validate these relationships.
    audioFormat: readU16(input, fmtChunk.dataOffset),
    channels: readU16(input, fmtChunk.dataOffset + 2),
    sampleRate: readU32(input, fmtChunk.dataOffset + 4),
    averageBytesPerSecond: readU32(input, fmtChunk.dataOffset + 8),
    blockAlign: readU16(input, fmtChunk.dataOffset + 12),
    bitsPerSample: readU16(input, fmtChunk.dataOffset + 14),
    pointers: Object.freeze({
      sampleRate: fmtChunk.dataOffset + 4,
      averageBytesPerSecond: fmtChunk.dataOffset + 8,
      blockAlign: fmtChunk.dataOffset + 12,
      bitsPerSample: fmtChunk.dataOffset + 14,
      channels: fmtChunk.dataOffset + 2,
    }),
  });

  const data = Object.freeze({
    offset: dataChunk.offset,
    dataOffset: dataChunk.dataOffset,
    size: dataChunk.size,
    endOffset: dataChunk.dataOffset + dataChunk.size,
    pointers: Object.freeze({
      size: dataChunk.dataOffset - 4,
      bytes: dataChunk.dataOffset,
    }),
  });

  // Native 0x1036feb3 restarts at data+0xc for the optional smpl scan.  A
  // short smpl payload would be an invalid native dereference, so reject it
  // explicitly rather than fabricating loop metadata.
  const smplChunk = findSmplChunk(input, 12, end);
  let smpl = null;
  if (smplChunk) {
    const smplEnd = checkedEnd(smplChunk.dataOffset, smplChunk.size, end,
      'smpl chunk', 'smpl-overrun');
    if (smplEnd - smplChunk.dataOffset < 32) {
      throw new ScriptSoundPeriodError(
        'ReadWaveInfo would dereference a short smpl chunk',
        'smpl-overrun', smplChunk.dataOffset,
      );
    }
    smpl = Object.freeze({
      offset: smplChunk.offset,
      dataOffset: smplChunk.dataOffset,
      size: smplChunk.size,
      loopCount: readU32(input, smplChunk.dataOffset + 0x1c),
      firstLoopOffset: smplChunk.dataOffset + 0x24,
    });
  }

  return Object.freeze({
    valid: true,
    endOffset: end,
    waveHeaderPointer: 4,
    fmt,
    data,
    smpl,
  });
}

/**
 * Translate FSoundData::GetPeriod.
 *
 * `soundData` has the recovered logical shape `{lazyField08, array:{data,
 * num}}`.  `bytes` may supply the host byte view explicitly; otherwise the
 * array's `data` must itself be a byte view.  When supplied, `lazyLoad` is
 * called first, matching the unconditional native generic Load call.  The
 * callback receives the same soundData record and may publish the loaded
 * array before this function reads it.
 */
export function getPeriod(soundData, {bytes = null, lazyLoad = null} = {}) {
  if (!soundData || typeof soundData !== 'object') {
    throw new ScriptSoundPeriodError('GetPeriod requires an FSoundData record', 'invalid-sound-data');
  }
  if (lazyLoad !== null && typeof lazyLoad !== 'function') {
    throw new ScriptSoundPeriodError('GetPeriod lazyLoad must be a function', 'invalid-lazy-loader');
  }

  // Native GetPeriod calls the generic helper before it inspects wave fields.
  // Do not wrap the callback: the native helper has no rollback on failure.
  if (lazyLoad) {
    const result = lazyLoad(soundData);
    if (result && typeof result.then === 'function') {
      throw new ScriptSoundPeriodError(
        'GetPeriod lazyLoad must complete synchronously',
        'async-lazy-loader',
      );
    }
  }

  const position = readSignedField(soundData, 'lazyField08');
  if (position > 0 && !lazyLoad) {
    throw new ScriptSoundPeriodError(
      'GetPeriod reached a positive lazy position without an archive loader',
      'lazy-loader-unbound',
    );
  }

  const array = soundData.array;
  if (!array || typeof array !== 'object') {
    throw new ScriptSoundPeriodError('GetPeriod requires the embedded byte array', 'invalid-array');
  }
  const input = bytes === null ? array.data : bytes;
  const view = asBytes(input);
  if (!Number.isInteger(array.num) || array.num < 0 || array.num > view.byteLength) {
    throw new ScriptSoundPeriodError(
      `GetPeriod array.Num ${array.num} is outside the supplied byte view`,
      'invalid-array-count',
    );
  }

  const info = readWaveInfo(view, {arrayNum: array.num});
  if (!info.valid) return 0;

  // The native imull chain keeps only the signed low 32 bits.
  const denominator = Math.imul(
    Math.imul(info.fmt.bitsPerSample, info.fmt.channels),
    info.fmt.sampleRate,
  );
  if (denominator === 0) return 0;
  return Math.fround((info.data.size * SOUND_PERIOD_NATIVE_CONTRACT.periodConstant.value) / denominator);
}

function invalidWaveInfo(reason, endOffset) {
  return Object.freeze({
    valid: false,
    reason,
    endOffset,
    waveHeaderPointer: null,
    fmt: null,
    data: null,
    smpl: null,
  });
}

function findChunk(input, start, end, wanted, label) {
  let offset = start;
  // The native `cmp cursor+8,end; jae` leaves the loop when the complete
  // eight-byte header reaches or crosses ArrayNum.  It then rereads the tag
  // at the cursor unconditionally.
  while (offset + 8 < end) {
    ensureReadable(input, offset, 8, label);
    const id = tagAt(input, offset);
    const size = readU32(input, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    if (id === wanted) {
      // The caller checks the target's data extent.  Keeping this distinction
      // lets a final odd-sized target be represented exactly as native code
      // does, while unknown overrun chunks are treated as unsafe below.
      return Object.freeze({
        id,
        offset,
        dataOffset,
        size,
        dataEnd,
        alignedEnd: dataEnd + (size & 1),
      });
    }
    offset = dataEnd + (size & 1);
  }

  // The native fmt/data loops unconditionally reread the tag at the cursor
  // after the bounded loop.  If the supplied byte view cannot satisfy that
  // read, this is an unsupported native-memory path rather than a clean
  // "missing chunk" result.  A readable non-target tag is a genuine native
  // false result.  A target still needs its size word for the host descriptor.
  ensureReadable(input, offset, 4, label);
  const id = tagAt(input, offset);
  if (id !== wanted) return null;
  ensureReadable(input, offset, 8, label);
  const size = readU32(input, offset + 4);
  const dataOffset = offset + 8;
  return Object.freeze({
    id,
    offset,
    dataOffset,
    size,
    dataEnd: dataOffset + size,
    alignedEnd: dataOffset + size + (size & 1),
  });
}

function findSmplChunk(input, start, end) {
  let offset = start;
  while (offset + 8 < end) {
    ensureReadable(input, offset, 8, 'smpl');
    const id = tagAt(input, offset);
    const size = readU32(input, offset + 4);
    if (id === 'smpl') {
      const dataOffset = offset + 8;
      return Object.freeze({
        id,
        offset,
        dataOffset,
        size,
        dataEnd: dataOffset + size,
        alignedEnd: dataOffset + size + (size & 1),
      });
    }
    offset = offset + 8 + size + (size & 1);
  }

  // The native smpl path has a separate strict `cur+4 < end` gate before it
  // rereads the tag.  Unlike fmt/data, it performs no read at a cursor whose
  // four-byte gate is already outside ArrayNum.
  if (offset + 4 >= end) return null;
  ensureReadable(input, offset, 4, 'smpl');
  if (tagAt(input, offset) !== 'smpl') return null;
  ensureReadable(input, offset, 8, 'smpl');
  const size = readU32(input, offset + 4);
  const dataOffset = offset + 8;
  return Object.freeze({
    id: 'smpl',
    offset,
    dataOffset,
    size,
    dataEnd: dataOffset + size,
    alignedEnd: dataOffset + size + (size & 1),
  });
}

function ensureReadable(input, offset, width, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + width > input.byteLength) {
    throw new ScriptSoundPeriodError(
      `ReadWaveInfo ${label} scan would read beyond supplied byte capacity`,
      'native-memory-read', offset,
    );
  }
}

function checkedEnd(dataOffset, size, end, label, code) {
  const dataEnd = dataOffset + size;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > end) {
    throw new ScriptSoundPeriodError(
      `ReadWaveInfo ${label} exceeds the array boundary`,
      code, dataOffset,
    );
  }
  return dataEnd;
}

function validateArrayNum(value, capacity) {
  if (!Number.isInteger(value) || value < 0 || value > capacity) {
    throw new ScriptSoundPeriodError(
      `ReadWaveInfo array.Num ${value} is outside the supplied byte view`,
      'invalid-array-count',
    );
  }
}

function readSignedField(object, key) {
  const value = object[key];
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new ScriptSoundPeriodError(`FSoundData ${key} must be a signed 32-bit integer`, 'invalid-lazy-position');
  }
  return value;
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ScriptSoundPeriodError('Sound period input must be a byte view', 'invalid-bytes');
}

function tagAt(input, offset) {
  return String.fromCharCode(
    input[offset], input[offset + 1], input[offset + 2], input[offset + 3],
  );
}

function readU16(input, offset) {
  return input[offset] | (input[offset + 1] << 8);
}

function readU32(input, offset) {
  return (input[offset]
    | (input[offset + 1] << 8)
    | (input[offset + 2] << 16)
    | (input[offset + 3] * 0x1000000)) >>> 0;
}
