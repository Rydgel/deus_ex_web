/**
 * Service boundary for Core's concrete ULinkerLoad archive.
 *
 * This module covers only FArchive::AttachLazyLoader and
 * FArchive::DetachLazyLoader on the archive vtable at 0x1017a430.  The
 * archive reader, allocator and FArray helpers remain explicit host services;
 * a browser array or file reader is never invented here.  See
 * docs/script-linker-lazy-loader.md for the original instruction evidence.
 */

const freeze = Object.freeze;
const ARCHIVE_BRAND = Symbol('verified ULinkerLoad archive');

export const LINKER_LAZY_LOADER_CONTRACT = freeze({
  class: freeze({
    name: 'LinkerLoad',
    constructorBody: 0x10160000,
    archiveOffset: 0xa4,
    propertiesSize: 0x4e8,
    classRecord: 0x1029ccd0,
    autoClass: 0x1029cccc,
  }),
  archive: freeze({
    nativeVtable: 0x1017a430,
    readerOffset: 0x440,
    outerReaderOffset: 0x4e4,
    lazyLoaderArrayOffset: 0x434,
    outerLazyLoaderArrayOffset: 0x4d8,
    attach: freeze({ thunk: 0x101017d0, body: 0x10162bf0, slot: 0x38 }),
    detach: freeze({ thunk: 0x10101a5a, body: 0x10162dd0, slot: 0x3c }),
  }),
  lazyLoader: freeze({ archiveOffset: 0x04, savedPositionOffset: 0x08 }),
  array: freeze({
    elementSize: 4,
    dataOffset: 0x00,
    numOffset: 0x04,
    maxOffset: 0x08,
    reallocThunk: 0x10101753,
    reallocBody: 0x10145440,
    removeThunk: 0x10101573,
    removeBody: 0x101454f0,
    growthNumerator: 3,
    growthDenominator: 8,
    growthSlack: 0x20,
    removeShrinkNumerator: 3,
    removeShrinkDenominator: 2,
    removeShrinkBytes: 0x4000,
    removeShrinkElements: 0x40,
  }),
  reader: freeze({ tellSlot: 0x28 }),
  log: freeze({ global: 0x101a7c38, format: 0x101b0f44, fallbackName: 0x101ef654 }),
});

export class UnsupportedLinkerLazyLoaderError extends Error {
  constructor(message, {
    operation = 'ULinkerLoad lazy-loader archive',
    address = null,
    slot = null,
    branch = null,
    value = null,
  } = {}) {
    super(message);
    this.name = 'UnsupportedLinkerLazyLoaderError';
    this.code = 'UNSUPPORTED_LINKER_LAZY_LOADER';
    this.operation = operation;
    this.address = address;
    this.slot = slot;
    this.branch = branch;
    this.value = value;
  }
}

const own = (value, key) => value !== null && value !== undefined && Object.hasOwn(value, key);

function fail(message, details = {}) {
  throw new UnsupportedLinkerLazyLoaderError(message, details);
}

function integer(value, label, {minimum = 0, maximum = Number.MAX_SAFE_INTEGER} = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function dword(value, label) {
  return integer(value, label, {minimum: 0, maximum: 0xffffffff}) >>> 0;
}

function field(object, names, fallback = undefined) {
  if (object === null || object === undefined) return fallback;
  for (const name of names) if (own(object, name)) return object[name];
  return fallback;
}

function fieldName(object, names) {
  return names.find(name => own(object, name)) ?? names[0];
}

function putField(object, names, value) {
  const name = fieldName(object, names);
  const current = object?.[name];
  if (current && typeof current === 'object' && own(current, 'value')) current.value = value;
  else object[name] = value;
  return value;
}

function valueOf(value) {
  if (value && typeof value === 'object' && own(value, 'value')) return value.value;
  return value;
}

function serviceSet(archive, services) {
  return {
    ...(archive?.services && typeof archive.services === 'object' ? archive.services : {}),
    ...(services && typeof services === 'object' ? services : {}),
  };
}

function emit(run, event) {
  const record = freeze({...event});
  run.operations.push(record);
  if (Array.isArray(run.services?.trace)) run.services.trace.push(record);
  if (typeof run.services?.trace === 'function') run.services.trace(record);
  return record;
}

function runFor(services, existing = null) {
  return existing ?? {services, operations: []};
}

function callback(services, archive, names) {
  for (const source of [services, archive]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) if (typeof source[name] === 'function') return source[name].bind(source);
  }
  return null;
}

function requiredCallback(services, archive, names, details) {
  const result = callback(services, archive, names);
  if (!result) fail(`Reached native ${details.operation}, but no ${names[0]} service is bound`, details);
  return result;
}

function requireArchive(archive) {
  if (!archive || archive[ARCHIVE_BRAND] !== true ||
      archive.nativeVtable !== LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable) {
    fail('AttachLazyLoader/DetachLazyLoader requires the canonical ULinkerLoad embedded archive identity', {
      operation: 'ULinkerLoad archive identity',
      address: LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable,
      value: archive,
    });
  }
  if (!own(archive, 'linker') || archive.linker === null || archive.linker === undefined) {
    fail('The canonical ULinkerLoad archive has no enclosing linker identity', {
      operation: 'ULinkerLoad archive identity',
      address: LINKER_LAZY_LOADER_CONTRACT.class.constructorBody,
    });
  }
  if (!own(archive, 'reader') || archive.reader === null || archive.reader === undefined) {
    fail('The canonical ULinkerLoad archive has no concrete reader identity', {
      operation: 'ULinkerLoad archive reader',
      slot: '+0x440',
    });
  }
  if (!archive.lazyLoaderArray || typeof archive.lazyLoaderArray !== 'object') {
    fail('The canonical ULinkerLoad archive has no +0x434 lazy-loader FArray', {
      operation: 'ULinkerLoad archive array',
      slot: '+0x434',
    });
  }
  return archive;
}

const ARRAY_DATA_NAMES = Object.freeze(['data', 'Data', 'arrayData']);
const ARRAY_NUM_NAMES = Object.freeze(['num', 'Num', 'count', 'ArrayNum']);
const ARRAY_MAX_NAMES = Object.freeze(['max', 'Max', 'capacity', 'ArrayMax']);

function arrayRead(array, offset, names, services, label) {
  const reader = services.readArrayField ?? services.readFArrayField;
  if (typeof reader === 'function') {
    const result = reader(array, offset, {array, offset, names, label});
    if (result !== undefined) return valueOf(result);
  }
  return valueOf(field(array, names));
}

function arrayWrite(array, offset, names, value, services, label) {
  const writer = services.writeArrayField ?? services.writeFArrayField;
  if (typeof writer === 'function') {
    const result = writer(array, offset, value, {array, offset, names, label});
    if (result === false) {
      fail(`${label} write service refused the native field`, {
        operation: 'FArray field write', slot: `+0x${offset.toString(16)}`,
      });
    }
  } else if (!array || typeof array !== 'object') {
    fail(`${label} requires a writable FArray object`, {
      operation: 'FArray field write', slot: `+0x${offset.toString(16)}`,
    });
  }
  if (typeof writer !== 'function' || field(array, names) !== value) {
    // The service may own a native slot without mirroring a JS alias.  A
    // supplied writer is authoritative; otherwise this is the concrete host
    // storage used by the focused browser binding.
    if (typeof writer !== 'function') putField(array, names, value);
  }
  return value;
}

function arrayData(array, services, {required = false} = {}) {
  const reader = services.readArrayData;
  let data;
  if (typeof reader === 'function') data = reader(array, {
    array, offset: LINKER_LAZY_LOADER_CONTRACT.archive.lazyLoaderArrayOffset,
  });
  if (data === undefined) data = valueOf(field(array, ARRAY_DATA_NAMES));
  if ((data === null || data === undefined || data === 0) && required) {
    fail('ULinkerLoad lazy-loader FArray has no readable Data storage', {
      operation: 'FArray Data access', slot: '+0x434', value: data,
    });
  }
  return data;
}

function arrayElement(array, index, services) {
  const reader = services.readArrayElement;
  if (typeof reader === 'function') {
    const result = reader(array, index, {array, index, elementSize: 4});
    if (result !== undefined) return valueOf(result);
  }
  const data = arrayData(array, services, {required: true});
  if (Array.isArray(data) || ArrayBuffer.isView(data)) return data[index];
  if (typeof data?.get === 'function') return data.get(index);
  fail('ULinkerLoad lazy-loader FArray needs an explicit element read service', {
    operation: 'FArray element read', slot: '+0x434', value: data,
  });
}

function writeArrayElement(array, index, value, services) {
  const writer = services.writeArrayElement;
  if (typeof writer === 'function') {
    const result = writer(array, index, value, {array, index, elementSize: 4});
    if (result === false) {
      fail('FArray element write service refused the native Data slot', {
        operation: 'FArray element write', slot: '+0x434', value,
      });
    }
    return value;
  }
  const data = arrayData(array, services, {required: true});
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    data[index] = value;
    return value;
  }
  if (typeof data?.set === 'function') {
    data.set(index, value);
    return value;
  }
  fail('ULinkerLoad lazy-loader FArray needs an explicit element write service', {
    operation: 'FArray element write', slot: '+0x434', value,
  });
}

function loaderWrite(loader, offset, names, value, services, run, label, address = null) {
  const writer = services.writeLazyLoaderField ?? services.writeFLazyLoaderField;
  if (typeof writer === 'function') {
    const result = writer(loader, offset, value, {loader, offset, names, label});
    if (result === false) {
      fail(`${label} write service refused the native field`, {
        operation: 'FLazyLoader field write', slot: `+0x${offset.toString(16)}`,
      });
    }
  } else if (!loader || typeof loader !== 'object') {
    fail(`${label} requires an explicit FLazyLoader field service`, {
      operation: 'FLazyLoader field write', slot: `+0x${offset.toString(16)}`,
    });
  } else {
    putField(loader, names, value);
  }
  emit(run, {
    operation: 'lazy-loader-field-write',
    address: address ?? LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
    offset,
    field: label,
    value,
  });
  return value;
}

function nativeGrowth(count) {
  const value = integer(count, 'FArray new Num', {minimum: 1, maximum: 0x7fffffff});
  return value + Math.trunc(3 * value / 8) + 0x20;
}

function readArrayHeader(array, services) {
  const num = integer(arrayRead(array, LINKER_LAZY_LOADER_CONTRACT.array.numOffset,
    ARRAY_NUM_NAMES, services, 'FArray.Num'), 'FArray.Num', {minimum: 0, maximum: 0x7fffffff});
  const max = integer(arrayRead(array, LINKER_LAZY_LOADER_CONTRACT.array.maxOffset,
    ARRAY_MAX_NAMES, services, 'FArray.Max'), 'FArray.Max', {minimum: 0, maximum: 0x7fffffff});
  if (max < num) {
    throw new RangeError(`ULinkerLoad lazy-loader FArray Max ${max} is smaller than Num ${num}`);
  }
  return {num, max};
}

function tellArchive(archive, services, run, details) {
  const readerTell = services.readerTell;
  let result;
  if (typeof readerTell === 'function') {
    result = readerTell(archive.reader, {
      archive, reader: archive.reader,
      slot: LINKER_LAZY_LOADER_CONTRACT.reader.tellSlot,
      ...details,
    });
  } else {
    const tell = services.tell ?? archive.reader?.tell;
    if (typeof tell !== 'function') {
      fail('ULinkerLoad AttachLazyLoader requires the concrete reader Tell service', {
        operation: 'FArchive::Tell',
        address: 0x10163110,
        slot: '+0x28',
      });
    }
    result = tell === archive.reader?.tell
      ? tell.call(archive.reader, {archive, reader: archive.reader, ...details})
      : tell(archive, {archive, reader: archive.reader, ...details});
  }
  const position = dword(valueOf(result), 'reader Tell position');
  emit(run, {
    operation: 'archive-tell',
    address: 0x10163110,
    slot: LINKER_LAZY_LOADER_CONTRACT.reader.tellSlot,
    value: position,
    ...details,
  });
  return position;
}

function validateArchiveArray(archive, services) {
  const array = archive.lazyLoaderArray;
  const {num, max} = readArrayHeader(array, services);
  const data = arrayData(array, services);
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    if (data.length < num) {
      throw new RangeError(`ULinkerLoad lazy-loader FArray Data length ${data.length} is smaller than Num ${num}`);
    }
  } else if (data !== null && data !== undefined && data !== 0 && typeof services.readArrayElement !== 'function') {
    fail('ULinkerLoad lazy-loader FArray has opaque Data without an element reader', {
      operation: 'FArray Data access', slot: '+0x434', value: data,
    });
  }
  return {array, num, max};
}

/** Native growth arithmetic used by AttachLazyLoader's inline branch. */
export function linkerLazyLoaderGrowth(count) {
  return nativeGrowth(count);
}

/**
 * Create the one canonical embedded archive identity reached by ULinkerLoad.
 * `reader` is retained as an opaque concrete reader; its Tell method is never
 * guessed.  `array` is the FArray at archive+0x434, initialized only when the
 * caller omits it to the zeroed native shape.
 */
export function createLinkerLoadArchive({linker, reader, array = null, logName = null, services = {}} = {}) {
  if (linker === null || linker === undefined) {
    throw new TypeError('ULinkerLoad archive requires its enclosing linker identity');
  }
  if (reader === null || reader === undefined) {
    throw new TypeError('ULinkerLoad archive requires its concrete reader identity');
  }
  const lazyLoaderArray = array ?? {data: null, num: 0, max: 0};
  if (!lazyLoaderArray || typeof lazyLoaderArray !== 'object') {
    throw new TypeError('ULinkerLoad archive requires an FArray object');
  }
  const archive = {
    kind: 'ULinkerLoadArchive',
    nativeVtable: LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable,
    linker,
    reader,
    lazyLoaderArray,
    logName,
    services,
  };
  Object.defineProperty(archive, ARCHIVE_BRAND, {value: true});
  Object.defineProperty(archive, 'embeddedOffset', {
    value: LINKER_LAZY_LOADER_CONTRACT.class.archiveOffset,
    enumerable: true,
  });
  return archive;
}

export const createULinkerLoadArchive = createLinkerLoadArchive;

/** Return whether a value is the branded ULinkerLoad embedded archive. */
export function isLinkerLoadArchive(value) {
  return Boolean(value && value[ARCHIVE_BRAND] === true &&
    value.nativeVtable === LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable);
}

/** Execute Core's ULinkerLoad::AttachLazyLoader body at 0x10162bf0. */
export function attachLinkerLazyLoader(archive, loader, services = {}, context = {}) {
  requireArchive(archive);
  if (loader === null || loader === undefined) {
    throw new TypeError('ULinkerLoad AttachLazyLoader requires an FLazyLoader identity');
  }
  const bound = serviceSet(archive, services);
  const run = runFor(bound, context.run ?? null);
  const {array, num: oldNum, max: oldMax} = validateArchiveArray(archive, bound);
  const newNum = integer(oldNum + 1, 'FArray new Num', {minimum: 1, maximum: 0x7fffffff});

  // 0x10162c31 publishes Num before testing Max and before Realloc.
  arrayWrite(array, LINKER_LAZY_LOADER_CONTRACT.array.numOffset, ARRAY_NUM_NAMES,
    newNum, bound, 'FArray.Num');
  emit(run, {
    operation: 'array-num-write',
    address: LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
    offset: LINKER_LAZY_LOADER_CONTRACT.array.numOffset,
    value: newNum,
  });

  let newMax = oldMax;
  if (newNum > oldMax) {
    newMax = nativeGrowth(newNum);
    // 0x10162c4a publishes Max before entering FArray::Realloc.
    arrayWrite(array, LINKER_LAZY_LOADER_CONTRACT.array.maxOffset, ARRAY_MAX_NAMES,
      newMax, bound, 'FArray.Max');
    emit(run, {
      operation: 'array-max-write',
      address: LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
      offset: LINKER_LAZY_LOADER_CONTRACT.array.maxOffset,
      value: newMax,
    });
    const realloc = requiredCallback(bound, archive, ['arrayRealloc', 'reallocateArray'], {
      operation: 'FArray::Realloc',
      address: LINKER_LAZY_LOADER_CONTRACT.array.reallocThunk,
      branch: 'attach-growth',
    });
    emit(run, {
      operation: 'array-realloc',
      address: LINKER_LAZY_LOADER_CONTRACT.array.reallocThunk,
      body: LINKER_LAZY_LOADER_CONTRACT.array.reallocBody,
      elementSize: LINKER_LAZY_LOADER_CONTRACT.array.elementSize,
      num: newNum,
      max: newMax,
      branch: 'attach-growth',
    });
    realloc(array, LINKER_LAZY_LOADER_CONTRACT.array.elementSize, {
      archive, loader, oldNum, oldMax, newNum, newMax,
      body: LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
    });
    const after = readArrayHeader(array, bound);
    if (after.num !== newNum || after.max !== newMax) {
      fail('FArray::Realloc service did not preserve Attach Num/Max writes', {
        operation: 'FArray::Realloc', address: LINKER_LAZY_LOADER_CONTRACT.array.reallocThunk,
        value: after,
      });
    }
  }

  // 0x10162c63 writes Data[oldNum] after the optional Realloc call.
  writeArrayElement(array, oldNum, loader, bound);
  emit(run, {
    operation: 'array-element-write',
    address: LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
    offset: LINKER_LAZY_LOADER_CONTRACT.array.dataOffset,
    index: oldNum,
    value: loader,
  });
  loaderWrite(loader, LINKER_LAZY_LOADER_CONTRACT.lazyLoader.archiveOffset,
    ['archive', 'lazyLoaderArchive', 'externalService'], archive, bound, run,
    'FLazyLoader archive');
  const position = tellArchive(archive, bound, run, {branch: 'attach', loader});
  loaderWrite(loader, LINKER_LAZY_LOADER_CONTRACT.lazyLoader.savedPositionOffset,
    ['savedPosition', 'lazyField08', 'savedPos'], position, bound, run,
    'FLazyLoader saved position');

  return {
    kind: 'ULinkerLoad.AttachLazyLoader',
    nativeBody: LINKER_LAZY_LOADER_CONTRACT.archive.attach.body,
    archive,
    loader,
    array,
    oldNum,
    newNum,
    oldMax,
    newMax,
    position,
    operations: run.operations,
  };
}

/** Execute Core's ULinkerLoad::DetachLazyLoader body at 0x10162dd0. */
export function detachLinkerLazyLoader(archive, loader, services = {}, context = {}) {
  requireArchive(archive);
  if (loader === null || loader === undefined) {
    throw new TypeError('ULinkerLoad DetachLazyLoader requires an FLazyLoader identity');
  }
  const bound = serviceSet(archive, services);
  const run = runFor(bound, context.run ?? null);
  const {array, num: initialNum, max: initialMax} = validateArchiveArray(archive, bound);
  let index = 0;
  let removed = 0;

  // 0x10162e08 rechecks the same index after Remove, thereby removing every
  // duplicate pointer while the FArray helper shifts later entries left.
  while (index < readArrayHeader(array, bound).num) {
    if (arrayElement(array, index, bound) !== loader) {
      index += 1;
      continue;
    }
    const before = readArrayHeader(array, bound);
    const remove = requiredCallback(bound, archive, ['arrayRemove', 'removeArray'], {
      operation: 'FArray::Remove',
      address: LINKER_LAZY_LOADER_CONTRACT.array.removeThunk,
      branch: 'detach-match',
    });
    emit(run, {
      operation: 'array-remove',
      address: LINKER_LAZY_LOADER_CONTRACT.array.removeThunk,
      body: LINKER_LAZY_LOADER_CONTRACT.array.removeBody,
      index,
      count: 1,
      elementSize: LINKER_LAZY_LOADER_CONTRACT.array.elementSize,
      num: before.num,
      max: before.max,
      branch: 'detach-match',
    });
    remove(array, index, 1, LINKER_LAZY_LOADER_CONTRACT.array.elementSize, {
      archive, loader, index, count: 1, elementSize: 4,
      body: LINKER_LAZY_LOADER_CONTRACT.archive.detach.body,
    });
    const after = readArrayHeader(array, bound);
    if (after.num !== before.num - 1) {
      fail('FArray::Remove service did not publish the native Num decrement', {
        operation: 'FArray::Remove', address: LINKER_LAZY_LOADER_CONTRACT.array.removeThunk,
        value: {before: before.num, after: after.num},
      });
    }
    removed += 1;
    // Keep index unchanged, matching EBX-- followed by the loop increment.
  }

  if (removed !== 1) {
    const log = requiredCallback(bound, archive, ['log', 'logf'], {
      operation: 'FOutputDevice::Logf',
      address: LINKER_LAZY_LOADER_CONTRACT.log.format,
      branch: 'detach-mismatch',
    });
    const name = own(archive, 'logName') ? archive.logName : null;
    const logDetails = {
      archive,
      loader,
      removed,
      format: 'Detachment inconsistency: %i (%s)',
      formatAddress: LINKER_LAZY_LOADER_CONTRACT.log.format,
      globalAddress: LINKER_LAZY_LOADER_CONTRACT.log.global,
      name,
      fallbackNameAddress: LINKER_LAZY_LOADER_CONTRACT.log.fallbackName,
      // Detach does not call UObject::GetFullName.  Keep a supplied service
      // visible for diagnostics without executing an unobserved call.
      getFullNameService: typeof bound.getFullName === 'function',
    };
    emit(run, {operation: 'detach-log', ...logDetails});
    log(archive, logDetails);
  }

  // 0x10162ecf/0x10162ed2 clear both fields even after a mismatch.
  loaderWrite(loader, LINKER_LAZY_LOADER_CONTRACT.lazyLoader.archiveOffset,
    ['archive', 'lazyLoaderArchive', 'externalService'], 0, bound, run,
    'FLazyLoader archive', LINKER_LAZY_LOADER_CONTRACT.archive.detach.body);
  loaderWrite(loader, LINKER_LAZY_LOADER_CONTRACT.lazyLoader.savedPositionOffset,
    ['savedPosition', 'lazyField08', 'savedPos'], 0, bound, run,
    'FLazyLoader saved position', LINKER_LAZY_LOADER_CONTRACT.archive.detach.body);

  return {
    kind: 'ULinkerLoad.DetachLazyLoader',
    nativeBody: LINKER_LAZY_LOADER_CONTRACT.archive.detach.body,
    archive,
    loader,
    array,
    initialNum,
    initialMax,
    removed,
    final: readArrayHeader(array, bound),
    operations: run.operations,
  };
}

export const attachLazyLoader = attachLinkerLazyLoader;
export const detachLazyLoader = detachLinkerLazyLoader;

export default createLinkerLoadArchive;
