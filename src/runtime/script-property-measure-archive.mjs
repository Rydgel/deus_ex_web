/**
 * The measuring FArchive used by Core's collector
 * `UStruct::SerializeTaggedProperties` helper.
 *
 * This is a small host adapter for the one archive vtable reached by the
 * tagged-property GC path.  It keeps the native constructor/header words and
 * the counter at +0x2c visible, while the wrapped archive remains responsible
 * for MapObject (+0x24) and MapName (+0x20).
 */

/** Native entry points and fields recovered from the GOTY Core.dll. */
export const PROPERTY_MEASURE_ARCHIVE = Object.freeze({
  constructorThunk: 0x101020d6,
  constructorBody: 0x10106b30,
  vtable: 0x10177640,
  compactIndexThunk: 0x10102950,
  compactIndexBody: 0x10159b50,
  operators: Object.freeze({
    destructor: 0x1012adc0,
    serialize: 0x1012a820,
    object: 0x1012a7a0,
    name: 0x1012a7e0,
    countBytes: 0x10106900,
    tell: 0x101069a0,
    mapName: 0x10106960,
    mapObject: 0x10106980,
  }),
  offsets: Object.freeze({
    archiveState: Object.freeze({
      ar04: 0x04,
      ar08: 0x08,
      ar0c: 0x0c,
      ar10: 0x10,
      ar14: 0x14,
      ar18: 0x18,
      ar1c: 0x1c,
      ar20: 0x20,
      ar24: 0x24,
    }),
    counter: 0x2c,
    wrappedArchive: 0x30,
    copied: Object.freeze([0x10, 0x18]),
  }),
});

/** Words written by FArchive::FArchive at Core 0x10106b30. */
export const PROPERTY_MEASURE_ARCHIVE_STATE = Object.freeze({
  ar04: 0x44,
  ar08: 0x44c,
  ar0c: 0,
  ar10: 0,
  ar14: 0,
  ar18: 0,
  ar1c: 1,
  ar20: 1,
  ar24: 1,
});

export class UnsupportedScriptPropertyMeasureArchiveError extends Error {
  constructor(message, { operation = 'FArchive measure adapter', slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptPropertyMeasureArchiveError';
    this.code = 'UNSUPPORTED_SCRIPT_PROPERTY_MEASURE_ARCHIVE';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptPropertyMeasureArchiveError(message, details);
}

function integer(value, label, { minimum = null, maximum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) ||
      (minimum !== null && number < minimum) ||
      (maximum !== null && number > maximum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function stateSource(archive, options) {
  return options.archiveState ?? archive?.archiveState ?? archive ?? null;
}

function stateWord(source, key, { required = false, fallback = undefined } = {}) {
  if (source && source[key] !== undefined) {
    return integer(source[key], `FArchive ${key}`);
  }
  if (required) {
    throw new TypeError(`Measuring FArchive requires wrapped archive ${key} for copied +${key.slice(2)}`);
  }
  return fallback;
}

function copiedState(archive, options) {
  const source = stateSource(archive, options);
  // Core constructs the object first, then copies only caller +0x10 and +0x18
  // at 0x10126d6b and 0x10126d71.  The constructor values for every other
  // word are therefore fixed and are not inherited from the caller.
  const ar10 = stateWord(source, 'ar10', { required: true });
  const ar18 = stateWord(source, 'ar18', { required: true });
  return { ...PROPERTY_MEASURE_ARCHIVE_STATE, ar10, ar18 };
}

function referenceValue(reference, label) {
  if (reference && typeof reference.get === 'function') return reference.get();
  if (reference && typeof reference === 'object' && Object.hasOwn(reference, 'value')) {
    return reference.value;
  }
  // The native operator accepts a reference, but allowing a direct value is
  // useful for a host-level adapter call and does not alter the native path
  // used by SerializeItem (which always supplies a mutable holder).
  if (reference !== undefined) return reference;
  throw new TypeError(`Missing ${label} passed to measuring FArchive operator`);
}

function mapMethod(archive, options, lower, upper) {
  const supplied = options[lower];
  if (typeof supplied === 'function') return supplied;
  if (typeof archive?.[lower] === 'function') return archive[lower];
  if (typeof archive?.[upper] === 'function') return archive[upper];
  return null;
}

function compactValue(value, label) {
  return integer(value, `${label} Map result`, { minimum: -0x80000000, maximum: 0x7fffffff });
}

function compactIndex(archive, value, context, label) {
  const state = archive.archiveState;
  // FCompactIndex at 0x10159b50 tests its archive +0x0c and +0x10.  The
  // tagged-property collector has zero in both words, so the reached branch
  // calls the measuring archive's raw Serialize with a four-byte INT.  The
  // variable-width branch is a different archive mode and is intentionally a
  // hard boundary here.
  if (state.ar0c !== 0 || state.ar10 !== 0) {
    fail(`FCompactIndex variable-width branch is outside the tagged collector path for ${label}`, {
      operation: 'FCompactIndex',
      slot: 'archive +0x0c/+0x10',
    });
  }
  let compact = value;
  const reference = {
    reference: true,
    key: 'FCompactIndex.value',
    get: () => compact,
    set: next => {
      compact = integer(next, 'FCompactIndex value', { minimum: -0x80000000, maximum: 0x7fffffff });
      return compact;
    },
  };
  archive.serializeRaw(reference, 4, {
    ...context,
    kind: 'compact-index',
    propertyMeasureArchive: true,
    body: PROPERTY_MEASURE_ARCHIVE.compactIndexBody,
  });
}

function notify(archive, operation) {
  archive.operations.push(operation);
  if (typeof archive.onOperation === 'function') archive.onOperation(operation);
}

/**
 * Create the archive installed by Core's tagged-property measuring helper.
 *
 * `wrappedArchive` must expose `archiveState.ar10` and `archiveState.ar18`
 * (or the corresponding direct words), because the native helper copies
 * those two words at +0x10/+0x18.  It must expose `mapObject`/`MapObject` and
 * `mapName`/`MapName` if a measured object/name property is reached.  The map
 * callbacks receive the dereferenced value, matching the native virtual
 * signatures; they return the INT passed to FCompactIndex.
 */
export function createScriptPropertyMeasureArchive(wrappedArchive, options = {}) {
  if (!wrappedArchive || typeof wrappedArchive !== 'object') {
    throw new TypeError('createScriptPropertyMeasureArchive requires the wrapped FArchive record');
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('createScriptPropertyMeasureArchive options must be an object');
  }

  const archiveState = copiedState(wrappedArchive, options);
  const mapObject = mapMethod(wrappedArchive, options, 'mapObject', 'MapObject');
  const mapName = mapMethod(wrappedArchive, options, 'mapName', 'MapName');
  let counter = 0;
  const archive = {
    kind: 'tagged-properties-measure-archive',
    measure: true,
    native: PROPERTY_MEASURE_ARCHIVE,
    constructorThunk: PROPERTY_MEASURE_ARCHIVE.constructorThunk,
    constructorBody: PROPERTY_MEASURE_ARCHIVE.constructorBody,
    vtable: PROPERTY_MEASURE_ARCHIVE.vtable,
    wrappedArchive,
    archiveState,
    copiedOffsets: [...PROPERTY_MEASURE_ARCHIVE.offsets.copied],
    operations: [],
    onOperation: options.onOperation,
  };

  const getBytes = () => counter;
  const setBytes = value => {
    counter = integer(value, 'measuring FArchive counter', { minimum: 0, maximum: 0xffffffff });
    return counter;
  };
  Object.defineProperties(archive, {
    // The native counter is the dword at FArchive +0x2c.  The `size` alias is
    // retained for existing host callers but refers to this same field.
    bytes: { enumerable: true, configurable: false, get: getBytes, set: setBytes },
    size: { enumerable: true, configurable: false, get: getBytes, set: setBytes },
  });

  const serializeRaw = (reference, length, context = {}) => {
    const width = integer(length, 'FArchive::Serialize length', { minimum: 0, maximum: 0x7fffffff });
    counter = (counter + width) >>> 0;
    notify(archive, {
      kind: 'raw',
      address: PROPERTY_MEASURE_ARCHIVE.operators.serialize,
      width,
      reference,
      context,
      bytes: counter,
    });
    return archive;
  };

  const objectReference = (reference, context = {}) => {
    const value = referenceValue(reference, 'UObject*&');
    if (!mapObject) {
      fail('Measured object operator requires wrapped FArchive MapObject (+0x24)', {
        operation: 'FArchive::operator<<(UObject*&)',
        slot: 'wrapped archive vtable +0x24',
      });
    }
    const mapped = compactValue(mapObject.call(wrappedArchive, value, context), 'UObject');
    notify(archive, {
      kind: 'object',
      address: PROPERTY_MEASURE_ARCHIVE.operators.object,
      value,
      mapped,
      context,
    });
    compactIndex(archive, mapped, context, 'UObject');
    return archive;
  };

  const nameReference = (reference, context = {}) => {
    const value = referenceValue(reference, 'FName*');
    if (!mapName) {
      fail('Measured name operator requires wrapped FArchive MapName (+0x20)', {
        operation: 'FArchive::operator<<(FName&)',
        slot: 'wrapped archive vtable +0x20',
      });
    }
    const mapped = compactValue(mapName.call(wrappedArchive, value, context), 'FName');
    notify(archive, {
      kind: 'name',
      address: PROPERTY_MEASURE_ARCHIVE.operators.name,
      value,
      mapped,
      context,
    });
    compactIndex(archive, mapped, context, 'FName');
    return archive;
  };

  const countBytes = (count, maximum, context = {}) => {
    // The installed +0x14 slot is the base FArchive::CountBytes body at
    // 0x10106900, which returns without touching the measuring counter.
    notify(archive, {
      kind: 'countBytes',
      address: PROPERTY_MEASURE_ARCHIVE.operators.countBytes,
      count,
      maximum,
      context,
      bytes: counter,
    });
    return archive;
  };

  const tell = (context = {}) => {
    const result = -1; // FArchive::Tell at 0x101069a0.
    notify(archive, {
      kind: 'tell',
      address: PROPERTY_MEASURE_ARCHIVE.operators.tell,
      result,
      context,
      bytes: counter,
    });
    return result;
  };

  // Keep both the runtime adapter names and the original virtual names.  The
  // local vtable's MapName/MapObject slots are inherited base methods and
  // return zero; object/name serialization above calls the wrapped archive's
  // corresponding slots instead.
  Object.assign(archive, {
    serializeRaw,
    serialize: serializeRaw,
    Serialize: serializeRaw,
    objectReference,
    serializeObject: objectReference,
    nameReference,
    serializeName: nameReference,
    countBytes,
    CountBytes: countBytes,
    tell,
    Tell: tell,
    mapName: () => 0,
    MapName: () => 0,
    mapObject: () => 0,
    MapObject: () => 0,
  });

  if (options.initialBytes !== undefined) setBytes(options.initialBytes);
  return archive;
}

export const makeScriptPropertyMeasureArchive = createScriptPropertyMeasureArchive;
