import {linkScriptStruct} from './script-struct-link.mjs';
import {NativeSlots} from './native-slots.mjs';

/**
 * The reached UState::Link body from the installed Deus Ex GOTY Core.dll.
 *
 * UClass inherits this virtual, so this adapter is also used for a native
 * UClass record. The inherited UStruct::Link uses the recovered implementation
 * unless the host binds another concrete adapter. This module owns the state hash table and
 * the direct UFunction/UState child links established by UState::Link.
 */

export const SCRIPT_STATE_LINK = Object.freeze({
  uState: Object.freeze({
    linkThunk: 0x1010282e,
    linkBody: 0x10127640,
  }),
  uStruct: Object.freeze({
    linkThunk: 0x10101933,
    linkBody: 0x10126060,
  }),
  iterator: Object.freeze({
    // The helper called by UState::Link is the field iterator constructor/
    // advance body.  Its class test is Core.Struct, not Core.Field.
    thunk: 0x101015a5,
    body: 0x1012b590,
    structClass: 0x101f2618,
    getInheritanceSuperSlot: 0x68,
  }),
  offsets: Object.freeze({
    name: 0x20,
    super: 0x28,
    next: 0x2c,
    hashNext: 0x30,
    children: 0x38,
    hashTable: 0x84,
    hashTableBytes: 0x400,
    hashBucketCount: 0x100,
  }),
  metadata: Object.freeze({
    probeMask: Object.freeze({ offset: 0x6c, width: 8 }),
    ignoreMask: Object.freeze({ offset: 0x74, width: 8 }),
    stateFlags: Object.freeze({ offset: 0x7c, width: 4 }),
    labelTableOffset: Object.freeze({ offset: 0x80, width: 2 }),
  }),
});

export class UnsupportedScriptStateLinkError extends Error {
  constructor(message, { operation = 'UState::Link', slot = null, field = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptStateLinkError';
    this.code = 'UNSUPPORTED_SCRIPT_STATE_LINK';
    this.operation = operation;
    this.slot = slot;
    this.field = field;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptStateLinkError(message, details);
}

function own(source, key) {
  return source !== null && source !== undefined && Object.hasOwn(source, key);
}

function first(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (source !== null && source !== undefined && source[key] !== undefined) return source[key];
  }
  return fallback;
}

function integer(value, label, { minimum = null } = {}) {
  if (value === null || value === undefined) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function traceCall(trace, operation, fields = {}) {
  trace.push({ operation, ...fields });
}

function pointerValue(pointer) {
  // A live nativeSlots record is itself the dereferenceable pointer.  Do not
  // reduce `{nativeAddress, nativeSlots}` to its numeric address here: the
  // next/outer/super walks must retain the record and its mutable slots.
  return pointer === null || pointer === undefined || pointer === 0 ? null : pointer;
}

function pointerIdentity(pointer) {
  const value = pointerValue(pointer);
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  const address = first(value, ['nativeAddress', 'address', 'pointer'], undefined);
  return address === undefined || address === value ? value : pointerIdentity(address);
}

function samePointer(left, right) {
  if (left === right) return true;
  const a = pointerIdentity(left), b = pointerIdentity(right);
  return a !== null && b !== null && a === b;
}

function mapHolder(record, offset) {
  return record?.nativeSlots instanceof NativeSlots ? record.nativeSlots.value(offset) : undefined;
}

function readSlot(record, offset, names, services, detail = {}) {
  if (typeof services.readSlot === 'function') {
    const value = services.readSlot(record, offset, {
      kind: 'ustate-link-read-slot', offset, ...detail,
    });
    if (value !== undefined) return value;
  }
  const raw = mapHolder(record, offset);
  if (raw !== undefined) return raw;
  return first(record, names, undefined);
}

function requireSlot(record, offset, names, services, label, detail = {}) {
  const value = readSlot(record, offset, names, services, detail);
  if (value === undefined) {
    fail(`UState::Link reached an unbound ${label} at +0x${offset.toString(16)}`, {
      operation: 'UState::Link', slot: `+0x${offset.toString(16)}`, field: record,
    });
  }
  return value;
}

function writeSlot(record, offset, value, width, services, detail = {}) {
  const writer = services.writeSlot ?? services.writeNativeSlot;
  if (typeof writer === 'function') {
    writer(record, offset, value, width, {
      kind: 'ustate-link-write-slot', offset, width, ...detail,
    });
  }
  if (record?.nativeSlots instanceof NativeSlots) {
    const prior = record.nativeSlots.width(offset);
    if (prior !== undefined && prior !== width) {
      throw new Error(`Native slot width mismatch at +0x${offset.toString(16)}`);
    }
    record.nativeSlots.assign(offset, value, width);
  }
  return value;
}

function setLogicalHashNext(field, value) {
  // A nativeSlots record may expose a getter/setter alias.  Writing it keeps
  // the logical view live; a raw-only record needs the ordinary field so the
  // result remains inspectable by the caller.
  if (field?.nativeSlots instanceof NativeSlots && !own(field, 'hashNext')) return;
  field.hashNext = value;
}

function readSuper(record, services) {
  const value = requireSlot(record, SCRIPT_STATE_LINK.offsets.super,
    ['superClass', 'superclass', 'superState', 'baseState', 'super', 'base'], services,
    'Super', { semantic: 'super' });
  return pointerValue(value);
}

function readChildren(record, services) {
  const value = requireSlot(record, SCRIPT_STATE_LINK.offsets.children,
    ['children', 'firstChild', 'childFields'], services, 'Children', { semantic: 'children' });
  return pointerValue(value);
}

function readNext(record, services) {
  const value = requireSlot(record, SCRIPT_STATE_LINK.offsets.next,
    ['next', 'nextField', 'nextChild'], services, 'Next', { semantic: 'next' });
  return pointerValue(value);
}

function readOuter(record, services) {
  const value = requireSlot(record, 0x18, ['outer', 'outerObject', 'owner'], services,
    'Outer', { semantic: 'outer' });
  return pointerValue(value);
}

function nameIndex(record, services) {
  const custom = services.getNameIndex ?? services.nameIndex;
  const value = typeof custom === 'function'
    ? custom(record, { kind: 'ustate-link-name', offset: SCRIPT_STATE_LINK.offsets.name })
    : readSlot(record, SCRIPT_STATE_LINK.offsets.name,
      ['nameIndex', 'nameRef', 'name'], services, { semantic: 'name' });
  let index = value;
  if (value && typeof value === 'object') index = first(value, ['index', 'nameIndex', 'value'], undefined);
  return integer(index, 'UField Name (+0x20)', { minimum: 0 }) >>> 0;
}

function classIdentity(field, services) {
  const value = readSlot(field, 0x24,
    ['classIdentity', 'fieldClass', 'classRef', 'objectClass', 'class'], services,
    { semantic: 'class' });
  return value === undefined ? undefined : pointerValue(value);
}

function classSuper(classObject, services, field) {
  const custom = services.getClassSuper ?? services.classSuper;
  if (typeof custom === 'function') {
    const value = custom(classObject, { kind: 'ustate-link-class-super', field });
    return value === undefined ? undefined : pointerValue(value);
  }
  const value = readSlot(classObject, SCRIPT_STATE_LINK.offsets.super,
    ['superClass', 'superclass', 'super', 'base'], services,
    { semantic: 'class-super', field });
  return value === undefined ? undefined : pointerValue(value);
}

function isStruct(field, services) {
  const custom = services.isA;
  if (typeof custom === 'function') {
    const result = custom(field, SCRIPT_STATE_LINK.iterator.structClass, {
      kind: 'ustate-link-struct-is-a',
      target: SCRIPT_STATE_LINK.iterator.structClass,
      body: 0x1010266c,
    });
    if (![true, false, 0, 1].includes(result)) {
      fail('UState::Link class predicate returned no result', {
        operation: 'UState::Link', slot: '+0x24', field,
      });
    }
    return result === true || result === 1;
  }
  if (own(field, 'isStruct')) {
    const result = field.isStruct;
    if (![true, false, 0, 1].includes(result)) {
      fail('UState::Link explicit isStruct predicate returned no native boolean', {
        operation: 'UState::Link', slot: '+0x24', field,
      });
    }
    return result === true || result === 1;
  }

  let current = classIdentity(field, services);
  if (current === undefined) {
    fail('UState::Link reached a child without a Core.Struct class binding', {
      operation: 'UState::Link', slot: '+0x24', field,
    });
  }
  const seen = new Set();
  while (current !== null && current !== undefined) {
    if (samePointer(current, SCRIPT_STATE_LINK.iterator.structClass)) return true;
    const identity = pointerIdentity(current);
    if (seen.has(identity)) throw new Error('Cyclic UState child class ancestry');
    seen.add(identity);
    current = classSuper(current, services, field);
    if (current === undefined) {
      fail('UState::Link class ancestry has no +0x28 Super binding', {
        operation: 'UState::Link', slot: '+0x28', field,
      });
    }
  }
  return false;
}

/**
 * Build a live 256-entry view over the native +0x84 hash table.  The native
 * class constructor leaves this storage uninitialized; callers using
 * nativeSlots therefore provide all 256 word holders before Link.  A logical
 * record may instead provide an explicit array or a storage adapter.
 */
function asHashStorage(value, { kind = 'logical-array', zero = null } = {}) {
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    if (value.length < SCRIPT_STATE_LINK.offsets.hashBucketCount) {
      throw new RangeError('UState hash table needs 256 entries');
    }
    const rawZero = ArrayBuffer.isView(value) ? 0 : zero;
    return {
      kind,
      identity: value,
      zero: rawZero,
      get: index => value[index],
      set: (index, next) => { value[index] = next; },
      snapshot: () => Array.from(value.slice(0, SCRIPT_STATE_LINK.offsets.hashBucketCount)),
    };
  }
  if (value && typeof value === 'object' && typeof value.get === 'function' && typeof value.set === 'function') {
    return {
      kind,
      identity: value.identity ?? value,
      zero: value.zero ?? zero,
      get: index => value.get(index),
      set: (index, next) => value.set(index, next),
      snapshot: () => Array.from({ length: SCRIPT_STATE_LINK.offsets.hashBucketCount }, (_, index) => value.get(index)),
    };
  }
  if (value && typeof value === 'object') {
    const data = value.data ?? value.items ?? value.values;
    if (data !== undefined) return asHashStorage(data, {
      kind: value.kind ?? kind,
      zero: value.zero ?? zero,
    });
  }
  return null;
}

function nativeWordStorage(record, services) {
  const slots = record?.nativeSlots;
  if (!(slots instanceof NativeSlots)) return null;
  const base = SCRIPT_STATE_LINK.offsets.hashTable;
  const arrayStorage = asHashStorage(slots.value(base), { kind: 'native-array', zero: 0 });
  if (arrayStorage) return arrayStorage;

  // Root native class construction allocates these as explicit 4-byte raw
  // holders.  Require the complete region before using it; missing words are
  // not silently treated as zero because the native constructor did not write
  // this block.
  const present = Array.from({ length: SCRIPT_STATE_LINK.offsets.hashBucketCount },
    (_, index) => slots.has(base + index * 4));
  if (present.some(value => !value)) {
    if (present.some(Boolean)) {
      fail('UState::Link has an incomplete native +0x84 hash table', {
        operation: 'UState::Link', slot: '+0x84..+0x483', field: record,
      });
    }
    return null;
  }
  for (let index = 0; index < present.length; index += 1) {
    const width = slots.width(base + index * 4);
    if (width !== undefined && width !== 4) {
      throw new Error(`Native hash-table slot +0x${(base + index * 4).toString(16)} is not 4 bytes`);
    }
  }
  return {
    kind: 'native-words',
    identity: slots,
    zero: 0,
    get: index => mapHolder(record, base + index * 4),
    set: (index, next) => writeSlot(record, base + index * 4, next, 4, services, {
      semantic: 'state-hash-bucket', bucket: index,
    }),
    snapshot: () => Array.from({ length: SCRIPT_STATE_LINK.offsets.hashBucketCount },
      (_, index) => mapHolder(record, base + index * 4)),
  };
}

function hashStorage(record, services, role) {
  const detail = {
    kind: 'ustate-link-hash-table', role,
    offset: SCRIPT_STATE_LINK.offsets.hashTable,
    bytes: SCRIPT_STATE_LINK.offsets.hashTableBytes,
    count: SCRIPT_STATE_LINK.offsets.hashBucketCount,
  };

  const provider = services.getHashBuckets ?? services.getStateHashTable;
  if (typeof provider === 'function') {
    const supplied = provider(record, detail);
    if (supplied !== undefined) {
      const storage = asHashStorage(supplied, { kind: 'adapter', zero: null });
      if (!storage) throw new TypeError('UState hash-table adapter must expose 256 entries and get/set');
      return storage;
    }
  }
  const supplied = services.hashBuckets;
  if (supplied !== undefined && typeof supplied !== 'function') {
    const storage = asHashStorage(supplied, { kind: 'adapter', zero: null });
    if (!storage) throw new TypeError('UState hashBuckets service must expose 256 entries and get/set');
    return storage;
  }

  const direct = first(record, ['hashBuckets', 'stateHashBuckets', 'labelHashBuckets', 'stateHashTable'], undefined);
  if (direct !== undefined) {
    const storage = asHashStorage(direct, { kind: 'logical-array', zero: null });
    if (!storage) throw new TypeError('UState logical hashBuckets must expose 256 entries');
    return storage;
  }

  const raw = nativeWordStorage(record, services);
  if (raw) return raw;

  if (typeof services.getHashBucket === 'function' && typeof services.setHashBucket === 'function') {
    return {
      kind: 'word-adapter',
      identity: record,
      zero: services.hashBucketZero ?? null,
      get: index => services.getHashBucket(record, index, detail),
      set: (index, next) => services.setHashBucket(record, index, next, detail),
      snapshot: () => Array.from({ length: SCRIPT_STATE_LINK.offsets.hashBucketCount },
        (_, index) => services.getHashBucket(record, index, detail)),
    };
  }

  if (typeof services.allocateHashBuckets === 'function') {
    const allocated = services.allocateHashBuckets(record, detail);
    const storage = asHashStorage(allocated, { kind: 'allocated', zero: null });
    if (!storage) throw new TypeError('UState allocateHashBuckets must return 256-entry get/set storage');
    return storage;
  }

  fail(`UState::Link requires explicit +0x84 hash-table storage for ${role}`, {
    operation: 'UState::Link', slot: '+0x84..+0x483', field: record,
  });
}

function readHashSource(storage) {
  const values = [];
  for (let index = 0; index < SCRIPT_STATE_LINK.offsets.hashBucketCount; index += 1) {
    const value = storage.get(index);
    if (value === undefined) {
      fail(`UState::Link source hash bucket ${index} is uninitialized`, {
        operation: 'UState::Link', slot: `+0x${(SCRIPT_STATE_LINK.offsets.hashTable + index * 4).toString(16)}`,
      });
    }
    values.push(value);
  }
  return values;
}

function writeHashTable(storage, values, trace, copied) {
  if (values !== null) {
    if (values.length !== SCRIPT_STATE_LINK.offsets.hashBucketCount) throw new Error('Invalid UState hash-table copy length');
    for (let index = 0; index < values.length; index += 1) storage.set(index, values[index]);
    traceCall(trace, 'copy-state-hash-table', {
      sourceOffset: SCRIPT_STATE_LINK.offsets.hashTable,
      destinationOffset: SCRIPT_STATE_LINK.offsets.hashTable,
      bytes: SCRIPT_STATE_LINK.offsets.hashTableBytes,
      count: SCRIPT_STATE_LINK.offsets.hashBucketCount,
      copied,
    });
    return values;
  }
  const zero = storage.zero;
  for (let index = 0; index < SCRIPT_STATE_LINK.offsets.hashBucketCount; index += 1) storage.set(index, zero);
  traceCall(trace, 'zero-state-hash-table', {
    destinationOffset: SCRIPT_STATE_LINK.offsets.hashTable,
    bytes: SCRIPT_STATE_LINK.offsets.hashTableBytes,
    count: SCRIPT_STATE_LINK.offsets.hashBucketCount,
    value: zero,
  });
  return Array.from({ length: SCRIPT_STATE_LINK.offsets.hashBucketCount }, () => zero);
}

function inheritedSuper(structure, services, trace) {
  const callback = services.getInheritanceSuper ?? services.inheritanceSuper;
  let value;
  if (typeof callback === 'function') {
    value = callback(structure, {
      kind: 'ustate-link-get-inheritance-super',
      thunk: 0x10101681,
      body: 0x10110500,
      slot: SCRIPT_STATE_LINK.iterator.getInheritanceSuperSlot,
    });
  } else {
    // UState::GetInheritanceSuper is a tiny raw +0x28 body in this image.
    value = readSlot(structure, SCRIPT_STATE_LINK.offsets.super,
      ['superClass', 'superclass', 'superState', 'baseState', 'super', 'base'], services,
      { semantic: 'inheritance-super' });
  }
  if (value === undefined) {
    fail('UState::Link iterator reached GetInheritanceSuper without a result', {
      operation: 'GetInheritanceSuper', slot: '+0x68', field: structure,
    });
  }
  value = pointerValue(value);
  traceCall(trace, 'get-inheritance-super', {
    structure,
    result: value,
    thunk: 0x10101681,
    body: 0x10110500,
    slot: SCRIPT_STATE_LINK.iterator.getInheritanceSuperSlot,
  });
  return value;
}

function nextStructCandidate(candidate, services, trace) {
  let current = candidate;
  while (current !== null && current !== undefined) {
    if (isStruct(current, services)) return current;
    traceCall(trace, 'skip-non-struct-child', {
      field: current,
      target: SCRIPT_STATE_LINK.iterator.structClass,
      thunk: SCRIPT_STATE_LINK.iterator.thunk,
      body: SCRIPT_STATE_LINK.iterator.body,
    });
    current = readNext(current, services);
  }
  return null;
}

function serviceHost(options) {
  const services = options?.services;
  if (services === null || (services !== undefined && typeof services !== 'object')) {
    throw new TypeError('UState::Link services must be an object');
  }
  return services ?? {};
}

/**
 * Replay Core's UState::Link (`0x10127640`).
 *
 * `services.linkStruct(record, archive, secondArgument, detail)` may override
 * the recovered inherited linker; services.structLink configures that default.
 * Hash-table storage must be
 * supplied explicitly by a 256-entry record array, nativeSlots words, or a
 * get/set adapter.  The function returns the live bucket snapshot and the
 * direct struct children linked by the native hash-chain writes.
 */
export function linkScriptState(record, {
  archive,
  secondArgument = 0,
  services: rawServices = {},
} = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UState/UClass record');
  if (!archive || typeof archive !== 'object') throw new TypeError('UState::Link requires an FArchive record');
  const second = integer(secondArgument, 'UState::Link second argument');
  const services = serviceHost({ services: rawServices });
  const linkStruct = services.linkStruct ?? services.linkUStruct ??
    ((object, frame, argument) => linkScriptStruct(object, {
      archive: frame, secondArgument: argument, services: services.structLink ?? {},
    }));
  if (typeof linkStruct !== 'function') {
    fail('UState::Link requires the inherited UStruct::Link adapter', {
      operation: 'UStruct::Link', slot: '+0x68', field: record,
    });
  }

  const trace = [];
  const detail = {
    kind: 'ustate-link-struct',
    thunk: SCRIPT_STATE_LINK.uStruct.linkThunk,
    body: SCRIPT_STATE_LINK.uStruct.linkBody,
    receiver: record,
    archive,
    secondArgument: second,
  };
  const structResult = linkStruct(record, archive, second, detail);
  traceCall(trace, 'struct-link', detail);

  // Native reads Super after the inherited call.  A UStruct linker is allowed
  // to resolve or rewrite that live pointer before this branch.
  const superRecord = readSuper(record, services);
  const destination = hashStorage(record, services, 'destination');
  const sourceValues = superRecord === null
    ? null
    : readHashSource(hashStorage(superRecord, services, 'superclass'));
  const buckets = writeHashTable(destination, sourceValues, trace, superRecord !== null);

  const linkedChildren = [];
  const seenStructures = new Set([record]);
  let structure = record;
  let candidate = readChildren(structure, services);
  while (structure !== null && structure !== undefined) {
    candidate = nextStructCandidate(candidate, services, trace);
    if (candidate === null) {
      structure = inheritedSuper(structure, services, trace);
      if (structure === null) break;
      if (seenStructures.has(structure)) throw new Error('Cyclic UState inheritance while linking children');
      seenStructures.add(structure);
      candidate = readChildren(structure, services);
      continue;
    }

    // UState::Link keeps only children whose Outer is this state.  The
    // iterator may have advanced into an inherited struct; the first such
    // candidate ends the caller's loop before its Next is read.
    const outer = readOuter(candidate, services);
    if (!samePointer(outer, record)) {
      traceCall(trace, 'stop-non-direct-child', { field: candidate, outer, receiver: record });
      break;
    }

    const bucket = nameIndex(candidate, services) & 0xff;
    const previous = destination.get(bucket);
    writeSlot(candidate, SCRIPT_STATE_LINK.offsets.hashNext, previous, 4, services, {
      semantic: 'state-hash-next', bucket, receiver: record,
    });
    setLogicalHashNext(candidate, previous);
    traceCall(trace, 'write-hash-next', {
      field: candidate,
      bucket,
      previous,
      offset: SCRIPT_STATE_LINK.offsets.hashNext,
      width: 4,
    });

    destination.set(bucket, candidate);
    traceCall(trace, 'write-hash-head', {
      field: candidate,
      bucket,
      offset: SCRIPT_STATE_LINK.offsets.hashTable + bucket * 4,
      width: 4,
    });
    linkedChildren.push(candidate);

    // The native body loads +0x2c only after both hash writes.
    candidate = readNext(candidate, services);
  }

  return {
    record,
    archive,
    secondArgument: second,
    structResult,
    super: superRecord,
    hashBuckets: destination.snapshot(),
    linkedChildren,
    metadataWrites: [],
    probeMaskWrites: [],
    operations: trace,
  };
}

export const linkUState = linkScriptState;
export default linkScriptState;
