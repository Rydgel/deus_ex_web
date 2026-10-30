/**
 * Service-driven translation of the native USound serializer and destructors.
 *
 * The callbacks in this module are deliberately explicit.  A native call that
 * is reached by the recovered branch is either dispatched to a host service or
 * raises UnsupportedSoundLifecycleError; JavaScript GC is not a substitute for
 * an allocator, archive, UObject or sound-service call.  See
 * docs/script-sound-lifecycle.md for the original instruction contract.
 */

import {NativeSlots} from './native-slots.mjs';

const freeze = value => Object.freeze(value);

export const SOUND_LIFECYCLE_CONTRACT = freeze({
  serializer: freeze({
    thunk: 0x103029fa,
    body: 0x1036f900,
    uobjectSerializeIat: 0x10599b10,
    // Engine IAT slot; it contains a pointer to Core's GLazyLoad DWORD.
    serializationFlagIat: 0x10599cc0,
    serializationFlag: 0x10599cc0,
    serializationFlagName: 'GLazyLoad',
    formatNameOffset: 0x44,
    serializedByteCountOffset: 0x48,
    rawSerializeSlot: 0x04,
    countBytesSlot: 0x14,
    objectReferenceSlot: 0x18,
    nameSlot: 0x1c,
    tellSlot: 0x28,
    seekSlot: 0x34,
    attachLazyLoaderSlot: 0x38,
    helperThunk: 0x103039ef,
    helperBody: 0x10371140,
    genericArrayHelperThunk: 0x103038b9,
    genericArrayHelperBody: 0x1030cca0,
    versionGate: 0x3d,
    loadBody: 0x1036f040,
    loadByteCountCopy: 0x1036f4db,
  }),
  layout: freeze({
    soundData: 0x28,
    // Absolute USound offset for FSoundData+0x04, the retained archive
    // pointer used by DetachLazyLoader during FSoundData destruction.
    archiveOwner: 0x2c,
    arrayData: 0x34,
    arrayNum: 0x38,
    arrayMax: 0x3c,
    owner: 0x40,
    formatName: 0x44,
    serializedByteCount: 0x48,
    durationCache: 0x4c,
    copyField: 0x50,
    size: 0x54,
    soundVtable: 0x10429580,
    soundDataVtable: 0x1042999c,
    soundDataBaseDestructorVtable: 0x104267fc,
  }),
  destructor: freeze({
    soundThunk: 0x10303a5d,
    soundBody: 0x1031cb60,
    soundDataThunk: 0x10301091,
    soundDataBody: 0x1030ca50,
    // FSoundData inherits FLazyLoader.  Its +0x04 field is the FArchive
    // pointer that an archive's AttachLazyLoader implementation may retain;
    // the destructor dispatches that archive's DetachLazyLoader at +0x3c.
    soundDataArchiveOffset: 0x04,
    archiveVtable: 0x10177640,
    archiveBaseVtable: 0x101751f8,
    archiveAttachThunk: 0x10101325,
    archiveAttachBody: 0x10106a40,
    archiveAttachSlot: 0x38,
    archiveDetachThunk: 0x101022d4,
    archiveDetachBody: 0x10106a60,
    archiveDetachSlot: 0x3c,
    conditionalDestroyIat: 0x10599b08,
    baseDestructorIat: 0x10599b04,
    baseDestructorBody: 0x10150040,
    deleteObjectIat: 0x10599ab4,
    deleteObjectBody: 0x1010aae0,
    allocatorGlobalIat: 0x10599a94,
    allocatorGlobalName: 'GMalloc',
    allocatorFreeSlot: 0x08,
    arrayRemoveIat: 0x10599a18,
    arrayReallocIat: 0x10599a20,
    arrayDestructorIat: 0x10599a14,
    arrayElementSize: 1,
    scalarSize: 0x54,
    arrayDestructorHelper: 0x104134d6,
    allocationCookieOffset: -0x04,
  }),
});

export class UnsupportedSoundLifecycleError extends Error {
  constructor(message, {
    operation = 'USound lifecycle',
    branch = null,
    address = null,
    slot = null,
    value = null,
  } = {}) {
    super(message);
    this.name = 'UnsupportedSoundLifecycleError';
    this.code = 'UNSUPPORTED_SOUND_LIFECYCLE';
    this.operation = operation;
    this.branch = branch;
    this.address = address;
    this.slot = slot;
    this.value = value;
  }
}

const MISSING = Symbol('missing-sound-lifecycle-field');

function own(value, key) {
  return value !== null && value !== undefined && Object.hasOwn(value, key);
}

function fieldValue(value) {
  if (value && typeof value === 'object' && own(value, 'value')) return value.value;
  return value;
}

function fail(message, details = {}) {
  throw new UnsupportedSoundLifecycleError(message, details);
}

function integer(value, label, {minimum = Number.MIN_SAFE_INTEGER} = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function dword(value, label) {
  return integer(value, label, {minimum: 0}) >>> 0;
}

function callbackFrom(services, archive, names) {
  for (const source of [services, archive]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) if (typeof source[name] === 'function') return source[name].bind(source);
  }
  return null;
}

function requiredCallback(services, archive, names, {
  operation,
  branch = null,
  address = null,
  slot = null,
} = {}) {
  const callback = callbackFrom(services, archive, names);
  if (!callback) {
    fail(`Reached native ${operation}, but no ${names[0]} service is bound`, {
      operation, branch, address, slot,
    });
  }
  return callback;
}

function emit(run, event) {
  const record = Object.freeze({...event});
  run.operations.push(record);
  if (Array.isArray(run.services?.trace)) run.services.trace.push(record);
  if (typeof run.services?.trace === 'function') run.services.trace(record);
  return record;
}

function runFor(services, existing = null) {
  return existing ?? {services, operations: []};
}

function readNativeField(target, offset, names, services, {
  label = names[0], operation = 'USound lifecycle', required = true,
  context = {},
} = {}) {
  if (!target || typeof target !== 'object') {
    if (required) fail(`${label} (+0x${offset.toString(16)}) requires a sound record`, {
      operation, slot: `+0x${offset.toString(16)}`, ...context,
    });
    return undefined;
  }
  if (typeof services?.readSoundField === 'function') {
    const value = services.readSoundField(target, offset, {
      target, offset, names, operation, ...context,
    });
    if (value !== undefined) return fieldValue(value);
  }
  const slots = target.nativeSlots;
  if (slots instanceof NativeSlots && slots.has(offset)) return slots.value(offset);
  if (slots && typeof slots === 'object' && !(slots instanceof NativeSlots) && own(slots, offset)) return fieldValue(slots[offset]);
  for (const name of names) if (own(target, name)) return fieldValue(target[name]);
  if (required) fail(`${label} (+0x${offset.toString(16)}) is unresolved`, {
    operation, slot: `+0x${offset.toString(16)}`, ...context,
  });
  return MISSING;
}

function writeNativeField(target, offset, names, value, services, {
  label = names[0], operation = 'USound lifecycle', context = {},
} = {}) {
  if (!target || typeof target !== 'object') {
    fail(`${label} (+0x${offset.toString(16)}) cannot be written without a sound record`, {
      operation, slot: `+0x${offset.toString(16)}`, ...context,
    });
  }
  if (typeof services?.writeSoundField === 'function') {
    const result = services.writeSoundField(target, offset, value, {
      target, offset, names, operation, ...context,
    });
    // A write service owns the field; a defined false result is an explicit
    // refusal and must not be papered over by a second storage path.
    if (result !== false) return value;
    fail(`${label} (+0x${offset.toString(16)}) write service refused the field`, {
      operation, slot: `+0x${offset.toString(16)}`, ...context,
    });
  }
  const slots = target.nativeSlots;
  if (slots instanceof NativeSlots && slots.has(offset)) {
    slots.assign(offset, value);
    return value;
  }
  if (slots && typeof slots === 'object' && !(slots instanceof NativeSlots) && own(slots, offset)) {
    const current = slots[offset];
    if (current && typeof current === 'object' && own(current, 'value')) current.value = value;
    else slots[offset] = value;
    return value;
  }
  const name = names.find(candidate => own(target, candidate)) ?? names[0];
  const current = target[name];
  if (current && typeof current === 'object' && own(current, 'value')) current.value = value;
  else target[name] = value;
  return value;
}

/** Return a live cell for a native field passed by reference to an archive. */
function nativeFieldReference(target, offset, names, services, {
  operation = 'USound lifecycle', label = names[0], context = {},
} = {}) {
  const reference = {
    reference: true,
    key: label,
    get: () => readNativeField(target, offset, names, services, {
      operation, label, context,
    }),
    set: value => writeNativeField(target, offset, names, value, services, {
      operation, label, context,
    }),
  };
  // A value accessor keeps the cell convenient for archive adapters while the
  // get/set methods make the native by-reference contract unambiguous.
  Object.defineProperty(reference, 'value', {
    enumerable: true,
    get: reference.get,
    set: reference.set,
  });
  return reference;
}

function resolveSoundData(sound, services, operation) {
  if (typeof services?.soundData === 'function') {
    const resolved = services.soundData(sound, {operation, sound});
    if (resolved !== undefined && resolved !== null) return resolved;
  }
  const direct = sound?.soundData ?? sound?.fsoundData;
  if (direct && typeof direct === 'object') return direct;
  const payload = sound?.payload;
  if (payload?.soundData && typeof payload.soundData === 'object') return payload.soundData;
  fail('USound requires an explicit embedded FSoundData record', {
    operation, slot: '+0x28',
  });
}

function resolveArray(soundData, services, operation) {
  if (typeof services?.soundArray === 'function') {
    const resolved = services.soundArray(soundData, {operation, soundData});
    if (resolved !== undefined && resolved !== null) return resolved;
  }
  const direct = soundData?.array ?? soundData?.tArray;
  if (direct && typeof direct === 'object') return direct;
  // An adapter may expose the embedded TArray fields directly on FSoundData.
  if (soundData && typeof soundData === 'object' && (
    own(soundData, 'arrayData') || own(soundData, 'arrayNum') || own(soundData, 'arrayMax') ||
    own(soundData, 'data') || own(soundData, 'num') || own(soundData, 'max')
  )) return soundData;
  fail('FSoundData requires an explicit embedded TArray record', {
    operation, slot: '+0x0c',
  });
}

function readArchiveWord(archive, offset, names, services, {
  operation, branch = null, required = true,
} = {}) {
  if (typeof services?.readArchiveWord === 'function') {
    const value = services.readArchiveWord(archive, offset, {
      archive, offset, names, operation, branch,
    });
    if (value !== undefined) return fieldValue(value);
  }
  const slots = archive?.nativeSlots;
  if (slots instanceof NativeSlots && slots.has(offset)) return slots.value(offset);
  if (slots && typeof slots === 'object' && !(slots instanceof NativeSlots) && own(slots, offset)) return fieldValue(slots[offset]);
  for (const name of names) if (own(archive, name)) return fieldValue(archive[name]);
  for (const source of [archive?.state, archive?.flags]) {
    for (const name of names) if (own(source, name)) return fieldValue(source[name]);
  }
  if (required) fail(`Archive word +0x${offset.toString(16)} is unresolved`, {
    operation, branch, slot: `+0x${offset.toString(16)}`,
  });
  return MISSING;
}

function requireArchive(archive, operation) {
  if (!archive || typeof archive !== 'object') {
    throw new TypeError(`${operation} requires an explicit FArchive adapter`);
  }
}

function mutableSerializationFlag(archive, services, operation) {
  const getter = services?.getSerializationFlag;
  const setter = services?.setSerializationFlag;
  if (typeof getter === 'function' || typeof setter === 'function') {
    if (typeof getter !== 'function' || typeof setter !== 'function') {
      fail('Serialization flag requires both getSerializationFlag and setSerializationFlag', {
        operation, address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
        symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
      });
    }
    return {
      get: () => getter.call(services, {
        address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
        symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
        operation,
      }),
      set: value => setter.call(services, value, {
        address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
        symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
        operation,
      }),
    };
  }
  const candidate = services?.serializationFlag ?? archive?.serializationFlag;
  if (candidate && typeof candidate === 'object' && (
    own(candidate, 'value') || typeof candidate.get === 'function' || typeof candidate.set === 'function'
  )) {
    if (typeof candidate.get === 'function' || typeof candidate.set === 'function') {
      if (typeof candidate.get !== 'function' || typeof candidate.set !== 'function') {
        fail('Serialization flag cell requires both get and set methods', {
          operation, address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
          symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
        });
      }
      return {get: () => candidate.get(), set: value => candidate.set(value)};
    }
    return {get: () => candidate.value, set: value => { candidate.value = value; }};
  }
  if (own(archive, 'serializationFlag')) {
    return {get: () => archive.serializationFlag, set: value => { archive.serializationFlag = value; }};
  }
  fail('USound::Serialize requires a mutable 0x10599cc0 serialization flag service', {
    operation, address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
    symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
  });
}

function requiredValue(value, label, details) {
  if (value === undefined || value === null || value === MISSING || !Number.isSafeInteger(Number(value))) {
    fail(`${label} did not return a native integer`, details);
  }
  return Number(value);
}

function callbackResult(result, holder, label, details) {
  if (result !== undefined) holder.value = result;
  return requiredValue(holder.value, label, details);
}

function emitCallback(run, callback, operation, args, details) {
  emit(run, {operation, ...details});
  return callback(...args, details);
}

function archiveTell(archive, services, run, details) {
  const callback = requiredCallback(services, archive, ['tell'], {
    operation: 'FArchive::Tell', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.tellSlot,
  });
  const value = emitCallback(run, callback, 'archive-tell', [archive], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.tellSlot,
    ...details,
  });
  return requiredValue(value, 'FArchive::Tell', {
    operation: 'FArchive::Tell', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.tellSlot,
  });
}

function archiveSeek(archive, services, run, offset, details) {
  const value = integer(offset, 'FArchive::Seek offset');
  const callback = requiredCallback(services, archive, ['seek'], {
    operation: 'FArchive::Seek', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.seekSlot,
  });
  emitCallback(run, callback, 'archive-seek', [archive, value], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.seekSlot,
    offset: value,
    ...details,
  });
  return value;
}

function archiveRaw(archive, services, run, holder, width, details) {
  const bytes = integer(width, 'FArchive::Serialize width', {minimum: 0});
  const callback = requiredCallback(services, archive, ['serializeRaw', 'rawSerialize'], {
    operation: 'FArchive::Serialize', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.rawSerializeSlot,
  });
  const result = emitCallback(run, callback, 'archive-serialize-raw', [archive, holder, bytes], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.rawSerializeSlot,
    width: bytes,
    target: holder,
    ...details,
  });
  if (bytes === 4) return callbackResult(result, holder, 'FArchive::Serialize offset', {
    operation: 'FArchive::Serialize', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.rawSerializeSlot,
  });
  return result;
}

function archiveCompact(archive, services, run, holder, details) {
  const callback = requiredCallback(services, archive, ['serializeCompact', 'compactIndex'], {
    operation: 'FArchive compact-index Serialize', branch: details.branch,
    address: 0x10599b18,
  });
  const result = emitCallback(run, callback, 'archive-serialize-compact', [archive, holder], {
    address: 0x10599b18,
    ...details,
  });
  return callbackResult(result, holder, 'FArchive compact-index value', {
    operation: 'FArchive compact-index Serialize', branch: details.branch,
    address: 0x10599b18,
  });
}

function archiveCountBytes(archive, services, run, count, maximum, details) {
  const n = integer(count, 'CountBytes count', {minimum: 0});
  const max = integer(maximum, 'CountBytes maximum', {minimum: 0});
  const callback = requiredCallback(services, archive, ['countBytes'], {
    operation: 'FArchive::CountBytes', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.countBytesSlot,
  });
  emitCallback(run, callback, 'archive-count-bytes', [archive, n, max], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.countBytesSlot,
    count: n,
    maximum: max,
    ...details,
  });
}

function attachLazyLoader(archive, soundData, services, run, details) {
  const callback = requiredCallback(services, archive, ['attachLazyLoader'], {
    operation: 'FArchive::AttachLazyLoader', branch: details.branch,
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.attachLazyLoaderSlot,
  });
  emitCallback(run, callback, 'archive-attach-lazy-loader', [archive, soundData], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.attachLazyLoaderSlot,
    ...details,
  });
}

function arrayField(array, offset, names, services, operation, label) {
  return readNativeField(array, offset, names, services, {operation, label});
}

function setArrayField(array, offset, names, value, services, operation, label) {
  writeNativeField(array, offset, names, value, services, {operation, label});
}

function genericArrayHelper(archive, soundData, services, run, details) {
  const array = resolveArray(soundData, services, 'Engine generic Sound array helper');
  const operation = 'Engine generic Sound array helper';
  emit(run, {
    operation: 'sound-generic-array-helper',
    address: SOUND_LIFECYCLE_CONTRACT.serializer.genericArrayHelperBody,
    thunk: SOUND_LIFECYCLE_CONTRACT.serializer.genericArrayHelperThunk,
    ...details,
  });
  const maximum = arrayField(array, 0x08, ['arrayMax', 'max', 'capacity'], services, operation, 'TArray.Max');
  const num = () => integer(arrayField(array, 0x04, ['arrayNum', 'num', 'count'], services,
    operation, 'TArray.Num'), 'TArray.Num', {minimum: 0});
  let count = num();
  const max = integer(maximum, 'TArray.Max', {minimum: 0});
  archiveCountBytes(archive, services, run, count, max, {
    branch: details.branch,
    helper: 'generic-array',
  });

  // The original passes &ArrayNum, so CountBytes and compact callbacks see
  // the same live field. A temporary captured before CountBytes loses writes.
  const compactHolder = {
    get value() { return num(); },
    set value(value) { setArrayField(array, 0x04, ['arrayNum', 'num', 'count'],
      value, services, operation, 'TArray.Num'); },
  };
  archiveCompact(archive, services, run, compactHolder, {
    branch: details.branch,
    helper: 'generic-array',
    target: 'TArray.Num',
  });
  const loading = readArchiveWord(archive, 0x0c, ['ar0c', 'slot0c'], services, {
    operation, branch: details.branch,
  });
  if (Number(loading) !== 0) {
    count = num();
    setArrayField(array, 0x08, ['arrayMax', 'max', 'capacity'], count, services, operation, 'TArray.Max');
    const callback = requiredCallback(services, archive, ['arrayRealloc'], {
      operation: 'FArray::Realloc', branch: details.branch,
      address: 0x10599a20,
    });
    emitCallback(run, callback, 'array-realloc', [array, 1], {
      address: 0x10599a20,
      elementSize: 1,
      count,
      ...details,
    });
  }

  count = num();
  const data = arrayField(array, 0x00, ['arrayData', 'data', 'pointer'], services, operation, 'TArray.Data');
  const rawHolder = {value: data};
  archiveRaw(archive, services, run, rawHolder, count, {
    branch: details.branch,
    helper: 'generic-array',
    target: 'TArray.Data',
  });
  return {array, count, maximum: max, data};
}

/** Direct generic TArray<BYTE> serialization at Engine1030cca0. */
export function serializeSoundByteArray(soundData, archive, services = {}) {
  requireArchive(archive, 'Generic byte-array serialization');
  genericArrayHelper(archive, soundData, services, runFor(services), {branch: 'generic-array'});
  return archive;
}

function runSoundHelper(sound, soundData, archive, services, run, gates) {
  const branch = gates.ar0c !== 0 ? 'archive+0x0c' : 'archive+0x10';
  const version = integer(readArchiveWord(archive, 0x04, ['version', 'archiveVersion', 'ar04'], services, {
    operation: 'USound helper version gate', branch,
  }), 'FArchive version', {minimum: 0});
  const oldFormat = version <= SOUND_LIFECYCLE_CONTRACT.serializer.versionGate;
  let offset;
  emit(run, {
    operation: 'sound-helper',
    address: SOUND_LIFECYCLE_CONTRACT.serializer.helperBody,
    thunk: SOUND_LIFECYCLE_CONTRACT.serializer.helperThunk,
    branch,
    archive0c: gates.ar0c,
    archive10: gates.ar10,
    version,
  });

  if (gates.ar0c !== 0) {
    if (oldFormat) {
      attachLazyLoader(archive, soundData, services, run, {branch, version});
      const compactHolder = {value: undefined};
      const compact = archiveCompact(archive, services, run, compactHolder, {
        branch, version, target: 'lazy-offset',
      });
      const tell = archiveTell(archive, services, run, {branch, version, target: 'lazy-offset'});
      offset = integer(tell + compact, 'lazy offset', {minimum: 0});
      emit(run, {operation: 'sound-lazy-offset-add', branch, version, tell, compact, offset});
    } else {
      const rawHolder = {value: undefined};
      offset = archiveRaw(archive, services, run, rawHolder, 4, {
        branch, version, target: 'lazy-offset',
      });
      attachLazyLoader(archive, soundData, services, run, {branch, version});
    }
    const flag = mutableSerializationFlag(archive, services, 'USound helper load gate').get();
    if (Number(flag) === 0) {
      const callback = requiredCallback(services, archive, ['loadSoundData'], {
        operation: 'FSoundData::Load', branch,
        address: SOUND_LIFECYCLE_CONTRACT.serializer.loadBody,
      });
      emitCallback(run, callback, 'sound-data-load', [soundData], {
        address: SOUND_LIFECYCLE_CONTRACT.serializer.loadBody,
        branch,
        version,
        owner: sound,
      });
      // The virtual Load owns all of its field writes. This helper proceeds
      // directly to Seek; it does not copy ArrayNum into the owner itself.
    } else {
      emit(run, {
        operation: 'sound-data-load-skipped',
        address: SOUND_LIFECYCLE_CONTRACT.serializer.loadBody,
        branch,
        version,
        serializationFlag: Number(flag),
        reason: 'GLazyLoad != 0 (Engine IAT 0x10599cc0)',
      });
    }
    archiveSeek(archive, services, run, offset, {branch, version, target: 'lazy-offset'});
    return {branch, version, format: oldFormat ? 'compact-offset' : 'raw-offset', offset};
  }

  // The caller only enters this helper after ar0c was observed zero and ar10
  // nonzero.  The generic helper itself reads ar0c for its Realloc gate.
  if (version > SOUND_LIFECYCLE_CONTRACT.serializer.versionGate) {
    const firstTell = archiveTell(archive, services, run, {branch, version, target: 'first-tell'});
    const firstOffset = {value: firstTell};
    archiveRaw(archive, services, run, firstOffset, 4, {
      branch, version, target: 'first-offset',
    });
    genericArrayHelper(archive, soundData, services, run, {branch, version});
    const secondTell = archiveTell(archive, services, run, {branch, version, target: 'second-tell'});
    archiveSeek(archive, services, run, firstTell, {branch, version, target: 'first-tell'});
    const secondOffset = {value: secondTell};
    archiveRaw(archive, services, run, secondOffset, 4, {
      branch, version, target: 'second-offset',
    });
    archiveSeek(archive, services, run, requiredValue(secondOffset.value, 'second offset', {
      operation: 'FArchive::Serialize', branch,
    }), {branch, version, target: 'second-offset'});
    return {
      branch, version, format: 'array-with-two-raw-offsets',
      firstTell, firstOffset: firstOffset.value, secondTell, secondOffset: secondOffset.value,
    };
  }
  genericArrayHelper(archive, soundData, services, run, {branch, version});
  return {branch, version, format: 'array'};
}

/**
 * Translate a direct call to Engine helper 0x10371140.  USound::Serialize
 * normally enters this helper with 0x10599cc0 set to one; this entry point is
 * useful for hosts that bind another native caller and need to exercise the
 * helper's zero-flag FSoundData::Load branch explicitly.
 */
export function serializeSoundHelperLifecycle(sound, archive, services = {}) {
  const operation = 'USound helper';
  requireArchive(archive, operation);
  const soundData = resolveSoundData(sound, services, operation);
  const run = runFor(services);
  const ar0c = dword(readArchiveWord(archive, 0x0c, ['ar0c', 'slot0c'], services, {
    operation, branch: 'gate',
  }), 'FArchive+0x0c');
  // Native code only reads +0x10 after observing +0x0c == 0. This matters
  // for adapters whose readArchiveWord records observable slot accesses.
  const ar10 = ar0c === 0 ? dword(readArchiveWord(archive, 0x10, ['ar10', 'slot10'], services, {
    operation, branch: 'gate',
  }), 'FArchive+0x10') : 0;
  if (ar0c === 0 && ar10 === 0) {
    fail('Direct Sound helper requires archive+0x0c or archive+0x10', {
      operation, address: SOUND_LIFECYCLE_CONTRACT.serializer.helperBody,
    });
  }
  const branch = runSoundHelper(sound, soundData, archive, services, run, {ar0c, ar10});
  return {
    kind: 'Sound',
    nativeBody: SOUND_LIFECYCLE_CONTRACT.serializer.helperBody,
    branch,
    operations: run.operations,
  };
}

/**
 * Translate Engine USound::Serialize (0x1036f900).
 *
 * `archive` must expose `ar0c`, `ar10`, and, on a helper branch, `version`
 * (or provide readArchiveWord).  The mutable serialization flag can be an
 * `archive.serializationFlag` value/cell or getSerializationFlag and
 * setSerializationFlag services.  Required native calls are supplied by
 * `services`; see docs/script-sound-lifecycle.md for callback signatures.
 */
export function serializeSoundLifecycle(sound, archive, services = {}) {
  const operation = 'USound::Serialize';
  requireArchive(archive, operation);
  const soundData = resolveSoundData(sound, services, operation);
  const run = runFor(services);
  const flag = mutableSerializationFlag(archive, services, operation);
  const previous = requiredValue(flag.get(), 'GLazyLoad flag', {
    operation,
    address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
    symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
  });
  flag.set(1);
  emit(run, {
    operation: 'serialization-flag-set',
    address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
    symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
    previous,
    value: 1,
  });
  const uobjectSerialize = requiredCallback(services, archive, ['uobjectSerialize', 'serializeObject'], {
      operation: 'UObject::Serialize',
      address: SOUND_LIFECYCLE_CONTRACT.serializer.uobjectSerializeIat,
    });
  emitCallback(run, uobjectSerialize, 'uobject-serialize', [sound, archive], {
    address: SOUND_LIFECYCLE_CONTRACT.serializer.uobjectSerializeIat,
  });

  const formatName = nativeFieldReference(sound, 0x44, ['formatName', 'format'], services, {
    operation, label: 'USound format FName',
  });
  const serializeName = requiredCallback(services, archive, ['serializeName', 'serializeFName', 'name'], {
      operation: 'FArchive::operator<<(FName&)',
      slot: SOUND_LIFECYCLE_CONTRACT.serializer.nameSlot,
  });
  const nameResult = emitCallback(run, serializeName, 'archive-serialize-name', [formatName, archive], {
    slot: SOUND_LIFECYCLE_CONTRACT.serializer.nameSlot,
    fieldOffset: 0x44,
  });
  // Native operator<< receives FName&. A bound service should mutate the
  // reference; accepting a returned value also lets a simple archive adapter
  // model a loading write without losing the field update.
  if (nameResult !== undefined && nameResult !== archive && nameResult !== formatName) {
    formatName.set(nameResult);
  }

  const ar0c = dword(readArchiveWord(archive, 0x0c, ['ar0c', 'slot0c'], services, {
      operation, branch: 'gate',
  }), 'FArchive+0x0c');
  const ar10 = ar0c === 0 ? dword(readArchiveWord(archive, 0x10, ['ar10', 'slot10'], services, {
    operation, branch: 'gate',
  }), 'FArchive+0x10') : 0;
  emit(run, {operation: 'sound-archive-gates', ar0c, ar10: ar0c === 0 ? ar10 : null});

  let branch;
  if (ar0c !== 0 || ar10 !== 0) {
    branch = runSoundHelper(sound, soundData, archive, services, run, {ar0c, ar10});
  } else {
    const byteCount = integer(readNativeField(sound, 0x48,
      ['serializedByteCount', 'byteCount', 'soundByteCount'], services, {
        operation, label: 'USound serialized byte count',
      }), 'USound serialized byte count', {minimum: 0});
    archiveCountBytes(archive, services, run, byteCount, byteCount, {
      branch: 'count-bytes', fieldOffset: 0x48,
    });
    branch = {branch: 'count-bytes', byteCount};
  }
  // The recovered native normal epilogue writes the saved GLazyLoad value
  // here. Its exception landing path has no visible equivalent write.
  flag.set(previous);
  emit(run, {
    operation: 'serialization-flag-restore',
    address: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagIat,
    symbol: SOUND_LIFECYCLE_CONTRACT.serializer.serializationFlagName,
    value: previous,
  });
  return {
    kind: 'Sound',
    nativeBody: SOUND_LIFECYCLE_CONTRACT.serializer.body,
    previousSerializationFlag: previous,
    branch,
    operations: run.operations,
  };
}

function destroyArrayStorage(soundData, services, run, parent = null) {
  const operation = 'FSoundData::~FSoundData';
  const array = resolveArray(soundData, services, operation);
  const archiveOwner = readNativeField(soundData,
    SOUND_LIFECYCLE_CONTRACT.destructor.soundDataArchiveOffset,
    ['archive', 'lazyLoaderArchive', 'externalService'], services, {
      operation, label: 'FSoundData archive owner',
    });
  const count = integer(readNativeField(array, 0x04,
    ['arrayNum', 'num', 'count'], services, {operation, label: 'TArray.Num'}),
  'TArray.Num', {minimum: 0});

  if (archiveOwner !== null && archiveOwner !== undefined && archiveOwner !== 0) {
    const callback = requiredCallback(services, null, ['detachLazyLoader'], {
      operation: 'FArchive::DetachLazyLoader',
      address: SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachThunk,
      slot: SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachSlot,
    });
    emitCallback(run, callback, 'archive-detach-lazy-loader', [archiveOwner, soundData], {
      address: SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachThunk,
      body: SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachBody,
      slot: SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachSlot,
      parent,
    });
  }

  const remove = requiredCallback(services, null, ['arrayRemove'], {
    operation: 'FArray::Remove',
    address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayRemoveIat,
  });
  emitCallback(run, remove, 'array-remove', [array, 0, count, 1], {
    address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayRemoveIat,
    index: 0,
    count,
    elementSize: 1,
    parent,
  });

  const dataAfterRemove = readNativeField(array, 0x00,
    ['arrayData', 'data', 'pointer'], services, {operation, label: 'TArray.Data'});
  if (dataAfterRemove !== null && dataAfterRemove !== undefined && dataAfterRemove !== 0) {
    const free = requiredCallback(services, null, ['allocatorFree', 'free'], {
      operation: 'FSoundData array allocator free',
      address: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorGlobalIat,
      slot: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorFreeSlot,
    });
    emitCallback(run, free, 'array-allocator-free', [dataAfterRemove], {
      address: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorGlobalIat,
      slot: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorFreeSlot,
      pointer: dataAfterRemove,
      parent,
    });
  }

  // Native order is Data, Max, Num.  FArray::~FArray is not called here.
  setArrayField(array, 0x00, ['arrayData', 'data', 'pointer'], 0,
    services, operation, 'TArray.Data');
  emit(run, {operation: 'array-clear-data', value: 0, parent});
  setArrayField(array, 0x08, ['arrayMax', 'max', 'capacity'], 0,
    services, operation, 'TArray.Max');
  emit(run, {operation: 'array-clear-max', value: 0, parent});
  setArrayField(array, 0x04, ['arrayNum', 'num', 'count'], 0,
    services, operation, 'TArray.Num');
  emit(run, {operation: 'array-clear-num', value: 0, parent});
  return {array, archiveOwner, data: dataAfterRemove, count};
}

/** Translate the complete FSoundData destructor (Engine 0x1030ca50). */
export function destroySoundDataLifecycle(soundData, services = {}, context = {}) {
  const run = runFor(services, context.run ?? null);
  const operation = 'FSoundData::~FSoundData';
  if (!soundData || typeof soundData !== 'object') {
    fail('FSoundData destructor requires an object record', {
      operation, address: SOUND_LIFECYCLE_CONTRACT.destructor.soundDataBody,
    });
  }
  writeNativeField(soundData, 0x00, ['vtable', 'nativeVtable'],
    SOUND_LIFECYCLE_CONTRACT.layout.soundDataBaseDestructorVtable, services, {
      operation, label: 'FSoundData vtable',
    });
  emit(run, {
    operation: 'sound-data-vtable-write',
    address: SOUND_LIFECYCLE_CONTRACT.destructor.soundDataBody,
    value: SOUND_LIFECYCLE_CONTRACT.layout.soundDataBaseDestructorVtable,
    parent: context.parent ?? null,
  });
  const result = destroyArrayStorage(soundData, services, run, context.parent ?? null);
  return {
    kind: 'FSoundData',
    nativeBody: SOUND_LIFECYCLE_CONTRACT.destructor.soundDataBody,
    ...result,
    operations: run.operations,
  };
}

/**
 * Translate the complete USound destructor (Engine 0x1031cb60).
 *
 * The conditional-destroy, lazy-loader detach, FArray, allocator and Core
 * base calls are all required services when their native branches are reached.
 */
export function destroySoundLifecycle(sound, services = {}, context = {}) {
  const operation = 'USound::~USound';
  const soundData = resolveSoundData(sound, services, operation);
  const run = runFor(services, context.run ?? null);
  writeNativeField(sound, 0x00, ['vtable', 'nativeVtable'],
    SOUND_LIFECYCLE_CONTRACT.layout.soundVtable, services, {
      operation, label: 'USound vtable',
    });
  emit(run, {
    operation: 'sound-vtable-write',
    address: SOUND_LIFECYCLE_CONTRACT.destructor.soundBody,
    value: SOUND_LIFECYCLE_CONTRACT.layout.soundVtable,
  });

  const conditionalDestroy = requiredCallback(services, null, ['conditionalDestroy'], {
    operation: 'UObject::ConditionalDestroy',
    address: SOUND_LIFECYCLE_CONTRACT.destructor.conditionalDestroyIat,
  });
  emitCallback(run, conditionalDestroy, 'conditional-destroy', [sound], {
    address: SOUND_LIFECYCLE_CONTRACT.destructor.conditionalDestroyIat,
    argument: 1,
  });

  const soundDataResult = destroySoundDataLifecycle(soundData, services, {run, parent: sound});
  const baseDestructor = requiredCallback(services, null, ['baseDestructor', 'uobjectBaseDestructor'], {
    operation: 'UObject::~UObject',
    address: SOUND_LIFECYCLE_CONTRACT.destructor.baseDestructorIat,
  });
  emitCallback(run, baseDestructor, 'uobject-base-destructor', [sound], {
    address: SOUND_LIFECYCLE_CONTRACT.destructor.baseDestructorIat,
    body: SOUND_LIFECYCLE_CONTRACT.destructor.baseDestructorBody,
    argument: -1,
  });
  return {
    kind: 'Sound',
    nativeBody: SOUND_LIFECYCLE_CONTRACT.destructor.soundBody,
    soundData: soundDataResult,
    operations: run.operations,
  };
}

function allocationHeader(sound, services, operation) {
  if (typeof services?.allocationHeader === 'function') {
    const value = services.allocationHeader(sound, {
      operation, sound,
      address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
    });
    if (value !== undefined) return value;
  }
  for (const name of ['allocationHeader', 'allocationBase', 'nativeAllocationHeader']) {
    if (own(sound, name)) return fieldValue(sound[name]);
  }
  fail('Deleting-wrapper bit 0x2 requires the native allocation header at this-4', {
    operation, address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
    slot: 'this-4',
  });
}

function allocationCount(sound, services, operation) {
  if (typeof services?.allocationCount === 'function') {
    const value = services.allocationCount(sound, {
      operation, sound,
      address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
      slot: 'this-4',
    });
    if (value !== undefined) return integer(value, 'native array allocation count', {minimum: 0});
  }
  for (const name of ['allocationCount', 'arrayCount', 'nativeAllocationCount']) {
    if (own(sound, name)) return integer(fieldValue(sound[name]), 'native array allocation count', {minimum: 0});
  }
  fail('Deleting-wrapper bit 0x2 requires the native array count at this-4', {
    operation, address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
    slot: 'this-4',
  });
}

/**
 * Translate Engine's scalar/array deleting wrapper (0x1031cc00).
 *
 * Bit 0x2 intentionally dispatches the recovered array helper instead of
 * calling the complete destructor.  The helper ABI is unresolved, so a host
 * must bind arrayDestructor; this function never silently runs the scalar
 * path in its place.
 */
export function deleteSoundLifecycle(sound, flags, services = {}) {
  const rawFlags = integer(flags, 'USound deleting-destructor flags', {minimum: 0});
  const byteFlags = rawFlags & 0xff;
  const run = runFor(services);
  if (byteFlags & 0x2) {
    const operation = 'USound deleting destructor array branch';
    const header = allocationHeader(sound, services, operation);
    const count = allocationCount(sound, services, operation);
    const arrayDestructor = requiredCallback(services, null, ['arrayDestructor'], {
      operation: 'Engine array destruction helper',
      address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
    });
    emitCallback(run, arrayDestructor, 'sound-array-destructor-helper',
      [sound, SOUND_LIFECYCLE_CONTRACT.destructor.scalarSize, count,
        SOUND_LIFECYCLE_CONTRACT.destructor.soundThunk], {
        address: SOUND_LIFECYCLE_CONTRACT.destructor.arrayDestructorHelper,
        allocationHeader: header,
        allocationCount: count,
        size: SOUND_LIFECYCLE_CONTRACT.destructor.scalarSize,
        destructorThunk: SOUND_LIFECYCLE_CONTRACT.destructor.soundThunk,
      });
    if (byteFlags & 0x1) {
      const free = requiredCallback(services, null, ['allocatorFree', 'free'], {
        operation: 'Deleting-wrapper allocation-header free',
        address: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorGlobalIat,
        slot: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorFreeSlot,
      });
      emitCallback(run, free, 'sound-array-allocation-free', [header], {
        address: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorGlobalIat,
        slot: SOUND_LIFECYCLE_CONTRACT.destructor.allocatorFreeSlot,
        pointer: header,
      });
    }
    return {
      kind: 'Sound',
      nativeBody: 0x1031cc00,
      flags: byteFlags,
      branch: 'array',
      allocationHeader: header,
      allocationCount: count,
      returnedPointer: header,
      operations: run.operations,
    };
  }

  const complete = destroySoundLifecycle(sound, services, {run});
  if (byteFlags & 0x1) {
    const objectFree = requiredCallback(services, null, ['objectFree', 'deleteObject'], {
      operation: 'Core ??3UObject',
      address: SOUND_LIFECYCLE_CONTRACT.destructor.deleteObjectIat,
    });
    emitCallback(run, objectFree, 'sound-object-free', [sound,
      SOUND_LIFECYCLE_CONTRACT.destructor.scalarSize], {
      address: SOUND_LIFECYCLE_CONTRACT.destructor.deleteObjectIat,
      body: SOUND_LIFECYCLE_CONTRACT.destructor.deleteObjectBody,
      size: SOUND_LIFECYCLE_CONTRACT.destructor.scalarSize,
    });
  }
  return {
    ...complete,
    nativeBody: 0x1031cc00,
    flags: byteFlags,
    branch: 'scalar',
    operations: run.operations,
  };
}
