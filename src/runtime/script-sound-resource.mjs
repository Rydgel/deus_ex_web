/**
 * Decode the evidence-backed serialized part of an Engine USound export.
 *
 * This adapter stops at the lazy-data header and RIFF/WAVE byte payload. It
 * deliberately does not allocate a native FSoundData service, play audio, or
 * bind a concrete archive for FSoundData's lazy-loader detach operation.
 * See docs/script-sound-resource.md for the recovered contract.
 */
import {Reader} from '../unreal/package.mjs';

export class ScriptSoundResourceError extends Error {
  constructor(message, code = 'sound-resource-error', offset = null) {
    super(offset === null ? message : `${message} at payload byte ${offset}`);
    this.name = 'ScriptSoundResourceError';
    this.code = code;
    this.offset = offset;
  }
}

/** Metadata recovered from the original Engine.dll. Addresses are descriptive. */
export const SOUND_NATIVE_CONTRACT = Object.freeze({
  packageName: 'Engine',
  className: 'Sound',
  staticClass: 0x10580868,
  instanceSize: 0x54,
  internalConstructor: 0x10303891,
  constructor: {thunk: 0x10303af3, body: 0x1034cdc0},
  serializer: {thunk: 0x103029fa, body: 0x1036f900},
  destructor: {thunk: 0x10303a5d, body: 0x1031cb60},
  soundData: {
    objectOffset: 0x28,
    archiveOffset: 0x2c,
    arrayDataOffset: 0x34,
    arrayNumOffset: 0x38,
    arrayMaxOffset: 0x3c,
    ownerOffset: 0x40,
  },
  serializerFields: {
    formatNameOffset: 0x44,
    serializedByteCountOffset: 0x48,
    durationCacheOffset: 0x4c,
    copyFieldOffset: 0x50,
  },
  archive: {
    rawSerializeSlot: 0x04,
    objectReferenceSlot: 0x18,
    nameSlot: 0x1c,
    countBytesSlot: 0x14,
    tellSlot: 0x28,
    seekSlot: 0x34,
    attachLazyLoaderSlot: 0x38,
    helperThunk: 0x103039ef,
    helperBody: 0x10371140,
    genericLazyArrayHelper: 0x103038b9,
    versionGate: 0x3d,
  },
  lazyLoaderDetach: {
    soundDataDestructorBody: 0x1030ca50,
    virtualSlot: 0x3c,
    status: 'unsupported',
  },
});

/**
 * Decode a Sound export from a loaded AssetStore package.
 *
 * `entry` should be the parsed package export. When it is supplied, the
 * package serial extent and the lazy header's absolute end are checked against
 * one another. `bytes` contains the complete package; `serialOffset` and
 * `serialSize` select its extent. Use decodeSoundPayload for a sliced payload
 * that retains a nonzero absolute package offset.
 */
export function decodeSoundResource({pkg = null, bytes, entry = null,
  serialOffset = entry?.serialOffset ?? 0,
  serialSize = entry?.serialSize ?? null} = {}) {
  const packageVersion = pkg?.version ?? null;
  const input = asBytes(bytes);
  const extent = resolveExtent(input, serialOffset, serialSize, entry);
  const payload = input.subarray(extent.offset, extent.offset + extent.size);
  return decodeSoundPayload(payload, {
    packageVersion,
    serialOffset: extent.offset,
    serialSize: extent.size,
    verifyPackageExtent: extent.verifyPackageExtent,
    entry,
    nameTable: pkg?.names ?? null,
  });
}

/**
 * Decode an already sliced serialized Sound payload. `serialOffset` and
 * `serialSize` are package coordinates only when `verifyPackageExtent` is
 * true; otherwise a synthetic payload can use zero-based coordinates.
 */
export function decodeSoundPayload(bytes, {
  packageVersion = null,
  serialOffset = 0,
  serialSize = null,
  verifyPackageExtent = false,
  entry = null,
  nameTable = null,
} = {}) {
  const input = asBytes(bytes);
  if(packageVersion!==null&&![68,69].includes(packageVersion))
    throw new ScriptSoundResourceError(`Sound package version ${packageVersion} is outside the recovered 68/69 payload path`, 'unsupported-version');
  const size = serialSize ?? input.byteLength;
  if (!Number.isSafeInteger(size) || size !== input.byteLength) {
    throw new ScriptSoundResourceError(
      `Serialized Sound size ${size} does not match supplied bytes ${input.byteLength}`,
      'serial-size-mismatch',
    );
  }
  if (!Number.isSafeInteger(serialOffset) || serialOffset < 0) {
    throw new ScriptSoundResourceError(`Invalid serialized Sound offset ${serialOffset}`, 'serial-offset');
  }

  const reader = new Reader(input);
  let noneIndex;
  try {
    noneIndex = reader.compact();
  } catch (error) {
    throw wrapReaderError(error, 'Unable to read Sound property terminator');
  }
  const terminator=nameTable?resolveName(nameTable,noneIndex):noneIndex===0?'None':null;
  if (terminator !== 'None') {
    throw new ScriptSoundResourceError(
      `Sound payload begins with property index ${noneIndex}; expected the resolved None name`,
      'properties-not-terminated', 0,
    );
  }

  const formatNameOffset = reader.offset;
  let formatNameIndex;
  let lazyHeaderOffset;
  let absoluteEnd;
  let byteCount;
  try {
    formatNameIndex = reader.compact();
    lazyHeaderOffset = reader.offset;
    absoluteEnd = reader.u32();
    byteCount = reader.compact();
  } catch (error) {
    throw wrapReaderError(error, 'Truncated Sound lazy-data header');
  }
  if (formatNameIndex < 0) {
    throw new ScriptSoundResourceError(
      `Negative Sound format name index ${formatNameIndex}`,
      'invalid-format-name', formatNameOffset,
    );
  }
  const formatName = resolveName(nameTable, formatNameIndex);
  if (byteCount < 0) {
    throw new ScriptSoundResourceError(`Negative Sound byte count ${byteCount}`, 'invalid-byte-count', reader.offset);
  }
  if (verifyPackageExtent) {
    const expectedEnd = serialOffset + size;
    if (absoluteEnd !== expectedEnd) {
      throw new ScriptSoundResourceError(
        `Sound lazy end ${absoluteEnd} does not equal package serial end ${expectedEnd}`,
        'lazy-end-mismatch', lazyHeaderOffset,
      );
    }
  }

  const inlineOffset = reader.offset;
  if (byteCount > input.length - inlineOffset) {
    throw new ScriptSoundResourceError(
      `Sound byte count ${byteCount} exceeds ${input.length - inlineOffset} remaining bytes`,
      'byte-count-overrun', inlineOffset,
    );
  }
  const inlineEnd = inlineOffset + byteCount;
  if (inlineEnd !== input.length) {
    throw new ScriptSoundResourceError(
      `Sound byte count ends at ${inlineEnd}, but serialized payload ends at ${input.length}`,
      'byte-count-mismatch', inlineOffset,
    );
  }

  const unsupported = [];
  const isWave=formatName===null||formatName.toLowerCase()==='wav';
  if (!isWave) {
    unsupported.push(
      `Sound format name ${formatName} (index ${formatNameIndex}) is not WAV; the RIFF decoder does not cover this format`,
    );
  }
  const lazy = Object.freeze({
    formatNameIndex,
    formatName,
    formatNameOffset,
    headerOffset: lazyHeaderOffset,
    absoluteEnd,
    inlineOffset,
    byteCount,
    hasInlineBytes: byteCount > 0,
    // This is a derived inline-byte fact, not the native FSoundData service state.
    loaded: byteCount > 0,
    packageVersion,
  });

  let wave = null;
  if (byteCount > 0 && isWave) {
    try {
      wave = decodeWave(input.subarray(inlineOffset, inlineEnd), inlineOffset);
    } catch (error) {
      if (error instanceof ScriptSoundResourceError) throw error;
      throw new ScriptSoundResourceError(`Unable to decode Sound RIFF payload: ${error.message}`, 'wave-decode');
    }
  }
  if (wave?.trailingBytes) {
    unsupported.push(`RIFF payload leaves ${wave.trailingBytes} unparsed trailing bytes`);
  }
  unsupported.push(
    'Native lazy Sound loading uses FArchive Seek(+0x34) and AttachLazyLoader(+0x38); loader binding and ownership remain unsupported',
  );
  unsupported.push('Native FSoundData archive detachment and allocation teardown are not bound to this decoded resource');
  unsupported.push('Audio playback, LoadSpecial and ClientHearSound remain outside the Stage 3 resource boundary');

  const references = Object.freeze([]);
  const nameReferences = Object.freeze([Object.freeze({
    field: 'formatName',
    index: formatNameIndex,
    name: formatName,
    nativeOffset: SOUND_NATIVE_CONTRACT.serializerFields.formatNameOffset,
    archiveSlot: SOUND_NATIVE_CONTRACT.archive.nameSlot,
    kind: 'FName',
  })]);
  const collector = Object.freeze({
    references,
    nameReferences,
    unsupported: Object.freeze([
      'USound::Serialize serializes formatName through FArchive operator<<(FName&) at +0x1c; this name-table value is not a UObject collector edge',
      'USound::Serialize and helper 0x10371140 do not call FArchive operator<<(UObject*&) at +0x18; package Outer/Class edges stay with the resource registry',
      'The lazy-array helper calls FArchive AttachLazyLoader(+0x38) and Seek(+0x34); its loader/service ownership is not bound here',
    ]),
  });
  const archive = Object.freeze({
    formatName: Object.freeze({
      fieldOffset: SOUND_NATIVE_CONTRACT.serializerFields.formatNameOffset,
      slot: SOUND_NATIVE_CONTRACT.archive.nameSlot,
      index: formatNameIndex,
      name: formatName,
    }),
    countBytes: Object.freeze({
      fieldOffset: SOUND_NATIVE_CONTRACT.serializerFields.serializedByteCountOffset,
      slot: SOUND_NATIVE_CONTRACT.archive.countBytesSlot,
      count: byteCount,
      maximum: byteCount,
      branch: 'archive+0x0c == 0 && archive+0x10 == 0',
    }),
    objectReference: Object.freeze({
      slot: SOUND_NATIVE_CONTRACT.archive.objectReferenceSlot,
      observedCalls: 0,
      evidence: 'No UObject archive call occurs in the recovered USound serializer/helper path',
    }),
    lazyHelper: Object.freeze({
      thunk: SOUND_NATIVE_CONTRACT.archive.helperThunk,
      body: SOUND_NATIVE_CONTRACT.archive.helperBody,
      genericArrayHelper: SOUND_NATIVE_CONTRACT.archive.genericLazyArrayHelper,
      rawSerializeSlot: SOUND_NATIVE_CONTRACT.archive.rawSerializeSlot,
      tellSlot: SOUND_NATIVE_CONTRACT.archive.tellSlot,
      seekSlot: SOUND_NATIVE_CONTRACT.archive.seekSlot,
      attachLazyLoaderSlot: SOUND_NATIVE_CONTRACT.archive.attachLazyLoaderSlot,
      versionGate: SOUND_NATIVE_CONTRACT.archive.versionGate,
    }),
  });
  const payloadStatus = wave
    ? 'decoded-wave'
    : (byteCount > 0 && !isWave
      ? 'unsupported-format' : 'lazy-header-only');
  return {
    kind: 'Sound',
    resourceKind: 'Sound',
    entry,
    packageVersion,
    serialOffset,
    serialSize: size,
    propertyOffset: formatNameOffset,
    formatName: Object.freeze({index: formatNameIndex, name: formatName}),
    lazy,
    wave,
    bytes: wave?.bytes ?? null,
    references,
    nameReferences,
    collector,
    archive,
    ownership: Object.freeze({
      nativeClass: 'USound',
      instanceSize: SOUND_NATIVE_CONTRACT.instanceSize,
      soundDataOffset: SOUND_NATIVE_CONTRACT.soundData.objectOffset,
      archiveOffset: SOUND_NATIVE_CONTRACT.soundData.archiveOffset,
      hostStorage: 'owned-byte-copy',
      archive: null,
      lazyLoaderDetach: SOUND_NATIVE_CONTRACT.lazyLoaderDetach,
      lazyLoader: Object.freeze({
        status: 'unbound',
        seekSlot: SOUND_NATIVE_CONTRACT.archive.seekSlot,
        attachSlot: SOUND_NATIVE_CONTRACT.archive.attachLazyLoaderSlot,
        helperBody: SOUND_NATIVE_CONTRACT.archive.helperBody,
      }),
    }),
    payloadStatus,
    // Native service lifetime and playback are not translated, even when the
    // complete inline RIFF byte range was parsed.
    payloadComplete: false,
    unsupported: Object.freeze(unsupported),
  };
}

function resolveExtent(input, serialOffset, serialSize, entry) {
  if (!Number.isSafeInteger(serialOffset) || serialOffset < 0 || serialOffset > input.length) {
    throw new ScriptSoundResourceError(`Invalid serialized Sound offset ${serialOffset}`, 'serial-offset');
  }
  const size = serialSize ?? input.length - serialOffset;
  if (!Number.isSafeInteger(size) || size <= 0 || serialOffset + size > input.length) {
    throw new ScriptSoundResourceError(`Invalid serialized Sound size ${size}`, 'serial-size');
  }
  return {
    offset: serialOffset,
    size,
    verifyPackageExtent: Boolean(entry || serialSize !== null),
  };
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // AssetStore may retain Node's Buffer subclass. Construct a plain
  // Uint8Array view so later `.slice()` calls produce an owned copy rather
  // than Buffer's legacy view semantics.
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Sound bytes as Uint8Array or ArrayBuffer');
}

function resolveName(nameTable, index) {
  if (!Array.isArray(nameTable)) return null;
  const entry = nameTable[index];
  if(typeof entry?.name!=='string')throw new ScriptSoundResourceError(`Invalid Sound package FName index ${index}`, 'invalid-format-name');
  return entry.name;
}

function decodeWave(waveBytes, baseOffset) {
  const reader = new Reader(waveBytes);
  const riffOffset = 0;
  if (readTag(reader) !== 'RIFF') {
    throw new ScriptSoundResourceError('Sound bytes do not begin with RIFF', 'missing-riff', baseOffset);
  }
  let riffSize;
  try {
    riffSize = reader.u32();
  } catch (error) {
    throw wrapReaderError(error, 'Truncated RIFF size', baseOffset + reader.offset);
  }
  const riffType = readTag(reader);
  if (riffType !== 'WAVE') {
    throw new ScriptSoundResourceError(`RIFF form ${riffType} is not WAVE`, 'wrong-wave-form', baseOffset + 8);
  }
  const riffEnd = 8 + riffSize;
  if (riffEnd > waveBytes.length) {
    throw new ScriptSoundResourceError(
      `RIFF size ${riffSize} exceeds ${waveBytes.length - 8} available bytes`,
      'riff-overrun', baseOffset + 4,
    );
  }
  if (riffEnd < 12) {
    throw new ScriptSoundResourceError('RIFF size is smaller than the WAVE header', 'riff-size', baseOffset + 4);
  }

  const chunks = [];
  while (reader.offset < riffEnd) {
    const chunkOffset = reader.offset;
    if (riffEnd - reader.offset < 8) {
      throw new ScriptSoundResourceError('RIFF chunk header is truncated', 'chunk-header', baseOffset + reader.offset);
    }
    const id = readTag(reader);
    let size;
    try {
      size = reader.u32();
    } catch (error) {
      throw wrapReaderError(error, `Truncated ${id} chunk size`, baseOffset + reader.offset);
    }
    const dataOffset = reader.offset;
    const dataEnd = dataOffset + size;
    const alignedEnd = dataEnd + (size & 1);
    if (dataEnd > riffEnd || alignedEnd > riffEnd) {
      throw new ScriptSoundResourceError(
        `${id} chunk of ${size} bytes exceeds RIFF boundary`,
        'chunk-overrun', baseOffset + chunkOffset,
      );
    }
    reader.seek(alignedEnd);
    chunks.push(Object.freeze({
      id,
      offset: chunkOffset,
      dataOffset,
      size,
      end: alignedEnd,
      padded: Boolean(size & 1),
    }));
  }
  if (reader.offset !== riffEnd) {
    throw new ScriptSoundResourceError('RIFF chunk scan did not reach its declared end', 'chunk-end', baseOffset + reader.offset);
  }

  const fmtChunk = chunks.find(chunk => chunk.id === 'fmt ');
  const dataChunk = chunks.find(chunk => chunk.id === 'data');
  if (!fmtChunk) throw new ScriptSoundResourceError('RIFF payload has no fmt chunk', 'missing-format', baseOffset);
  if (!dataChunk) throw new ScriptSoundResourceError('RIFF payload has no data chunk', 'missing-data', baseOffset);
  if (fmtChunk.size < 16) {
    throw new ScriptSoundResourceError('WAVE fmt chunk is shorter than the PCM header', 'format-size', baseOffset + fmtChunk.dataOffset);
  }

  const view = new DataView(waveBytes.buffer, waveBytes.byteOffset, waveBytes.byteLength);
  const fmt = Object.freeze({
    audioFormat: view.getUint16(fmtChunk.dataOffset, true),
    channels: view.getUint16(fmtChunk.dataOffset + 2, true),
    sampleRate: view.getUint32(fmtChunk.dataOffset + 4, true),
    averageBytesPerSecond: view.getUint32(fmtChunk.dataOffset + 8, true),
    blockAlign: view.getUint16(fmtChunk.dataOffset + 12, true),
    bitsPerSample: view.getUint16(fmtChunk.dataOffset + 14, true),
    extraBytes: fmtChunk.size - 16,
  });

  const list = chunks.filter(chunk => chunk.id === 'LIST').map(chunk => decodeList(waveBytes, chunk, baseOffset));
  const info = Object.freeze(list.flatMap(item => item.entries));
  const waveCopy = waveBytes.slice();
  const dataStart = dataChunk.dataOffset - riffOffset;
  const dataBytes = waveCopy.slice(dataStart, dataStart + dataChunk.size);
  return {
    offset: baseOffset,
    byteLength: waveBytes.length,
    riffSize,
    riffType,
    chunks: Object.freeze(chunks),
    fmt,
    data: Object.freeze({offset: dataChunk.dataOffset, size: dataChunk.size, bytes: dataBytes}),
    lists: Object.freeze(list),
    info,
    bytes: waveCopy,
    trailingBytes: waveBytes.length - riffEnd,
  };
}

function decodeList(bytes, chunk, baseOffset) {
  if (chunk.size < 4) {
    throw new ScriptSoundResourceError('LIST chunk is shorter than its list type', 'list-size', baseOffset + chunk.dataOffset);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = readTagAt(bytes, chunk.dataOffset);
  const entries = [];
  let offset = chunk.dataOffset + 4;
  const end = chunk.dataOffset + chunk.size;
  while (offset < end) {
    if (end - offset < 8) {
      throw new ScriptSoundResourceError('LIST entry header is truncated', 'list-entry-header', baseOffset + offset);
    }
    const id = readTagAt(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    const alignedEnd = dataEnd + (size & 1);
    if (dataEnd > end || alignedEnd > end) {
      throw new ScriptSoundResourceError(`LIST entry ${id} exceeds LIST boundary`, 'list-entry-overrun', baseOffset + offset);
    }
    const valueBytes = bytes.subarray(dataOffset, dataEnd);
    entries.push(Object.freeze({
      id,
      offset,
      dataOffset,
      size,
      value: decodeInfoText(valueBytes),
    }));
    offset = alignedEnd;
  }
  if (offset !== end) {
    throw new ScriptSoundResourceError('LIST scan did not reach its declared end', 'list-end', baseOffset + offset);
  }
  return Object.freeze({id: chunk.id, offset: chunk.offset, dataOffset: chunk.dataOffset, size: chunk.size, type, entries: Object.freeze(entries)});
}

function readTag(reader) {
  return readTagBytes(reader.take(4));
}

function readTagAt(bytes, offset) {
  return readTagBytes(bytes.subarray(offset, offset + 4));
}

function readTagBytes(bytes) {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

function decodeInfoText(bytes) {
  const end = bytes.indexOf(0);
  const value = end >= 0 ? bytes.subarray(0, end) : bytes;
  return new TextDecoder('windows-1252').decode(value);
}

function wrapReaderError(error, message, offset = null) {
  if (error instanceof ScriptSoundResourceError) return error;
  const at = offset ?? error?.offset ?? null;
  return new ScriptSoundResourceError(message, 'truncated-payload', at);
}
