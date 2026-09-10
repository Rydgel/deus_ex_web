import {sortScriptNetFields} from './script-net-field-sort.mjs';
import {linkScriptState} from './script-state-link.mjs';

/**
 * The reached UClass::Link body from the installed Deus Ex GOTY Core.dll.
 *
 * This is the class-side link adapter used by UClass::Register's virtual
 * +0x6c call.  FArchive construction, UState::Link, the class-replication
 * arrays, the UField walk, and the native field predicates are kept in the
 * native order.  A JavaScript metadata record is not a native UObject, so
 * the lower-level virtual calls are explicit services rather than guessed
 * no-ops.
 */

export const SCRIPT_CLASS_LINK = Object.freeze({
  uClass: Object.freeze({
    vtable: 0x101758f4,
    linkThunk: 0x10102f2c,
    linkBody: 0x10127e30,
  }),
  uState: Object.freeze({
    linkThunk: 0x1010282e,
    linkBody: 0x10127640,
  }),
  archive: Object.freeze({
    vtable: 0x101751f8,
    constructorVersion: 0x44,
    constructorSize: 0x44c,
  }),
  helpers: Object.freeze({
    empty: Object.freeze({ thunk: 0x10102824, body: 0x10107190 }),
    reservePairs: Object.freeze({ thunk: 0x10102f40, body: 0x1012b1b0 }),
    appendPairs: Object.freeze({ body: 0x10111c80 }),
    add: Object.freeze({ thunk: 0x10102536, body: 0x10107080 }),
    enumerateFields: Object.freeze({ body: 0x1012b610 }),
    ownerClass: Object.freeze({ thunk: 0x10101a5f, body: 0x10125bc0, slot: 0x60 }),
    sortNetFields: Object.freeze({ thunk: 0x101012bc, body: 0x1012b690 }),
  }),
  offsets: Object.freeze({
    objectClass: 0x24,
    outer: 0x18,
    super: 0x28,
    next: 0x2c,
    children: 0x38,
    arrayDim: 0x34,
    propertyFlags: 0x3c,
    rawRepIndex: 0x46,
    specialFlags: 0x6c,
    classReps: Object.freeze({ data: 0x4a4, num: 0x4a8, max: 0x4ac }),
    netFields: Object.freeze({ data: 0x4b0, num: 0x4b4, max: 0x4b8 }),
  }),
  identities: Object.freeze({
    // 0x101018c5 -> 0x1010f250 returns Core.Field.
    fieldClass: 0x101f2b18,
    // 0x101019fb -> 0x1010fcd0 returns Core.Function.
    functionClass: 0x101f1718,
    // 0x10101f0a -> 0x10112670 returns Core.Property.
    propertyClass: 0x102a7af0,
    // UField::GetOwnerClass compares Class against UClass's class identity.
    uClassClass: 0x101f1c18,
  }),
  flags: Object.freeze({
    netProperty: 0x20,
    specialFunction: 0x40,
  }),
  globals: Object.freeze({
    linkGate: 0x101e5544,
  }),
});

/** Exact words written by UClass::Register before its virtual +0x6c call. */
export const CLASS_LINK_ARCHIVE_STATE = Object.freeze({
  vtable: SCRIPT_CLASS_LINK.archive.vtable,
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

export class UnsupportedScriptClassLinkError extends Error {
  constructor(message, { operation = 'UClass::Link', slot = null, field = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptClassLinkError';
    this.code = 'UNSUPPORTED_SCRIPT_CLASS_LINK';
    this.operation = operation;
    this.slot = slot;
    this.field = field;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptClassLinkError(message, details);
}

function own(source, key) {
  return source !== null && source !== undefined && Object.hasOwn(source, key);
}

function first(source, names, fallback = undefined) {
  for (const name of names) {
    if (source !== null && source !== undefined && source[name] !== undefined) return source[name];
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

function pointerValue(pointer) {
  if (pointer === null || pointer === undefined || pointer === 0) return null;
  if (typeof pointer === 'number' || typeof pointer === 'string' || typeof pointer === 'function') return pointer;
  if (typeof pointer === 'object') {
    const nested = first(pointer, ['nativeAddress', 'address', 'pointer', 'value'], pointer);
    return nested === pointer ? pointer : pointerValue(nested);
  }
  return pointer;
}

function samePointer(left, right) {
  if (left === right) return true;
  const a = pointerValue(left), b = pointerValue(right);
  return a !== null && b !== null && a === b;
}

function traceCall(trace, operation, fields = {}) {
  trace.push({ operation, ...fields });
}

function nativeSlot(record, offset) {
  if (!(record?.nativeSlots instanceof Map)) return undefined;
  const holder = record.nativeSlots.get(offset);
  return holder === undefined ? undefined : holder?.value;
}

function hasNativeSlot(record, offset) {
  return record?.nativeSlots instanceof Map && record.nativeSlots.has(offset);
}

function readSlot(record, offset, names, fallback, services, detail = {}) {
  if (typeof services.readSlot === 'function') {
    const resolved = services.readSlot(record, offset, {
      kind: 'class-link-read-slot', offset, ...detail,
    });
    if (resolved !== undefined) return resolved;
  }
  const raw = nativeSlot(record, offset);
  if (raw !== undefined) return raw;
  return first(record, names, fallback);
}

function writeSlot(record, offset, value, width, services, detail = {}) {
  if (typeof services.writeSlot === 'function') {
    services.writeSlot(record, offset, value, width, {
      kind: 'class-link-write-slot', offset, width, ...detail,
    });
  } else if (typeof services.writeNativeSlot === 'function') {
    services.writeNativeSlot(record, offset, value, width, {
      kind: 'class-link-write-slot', offset, width, ...detail,
    });
  }
  if (record?.nativeSlots instanceof Map) {
    const holder = record.nativeSlots.get(offset);
    if (holder && holder.width !== undefined && holder.width !== width) {
      throw new Error(`Native slot width mismatch at +0x${offset.toString(16)}`);
    }
    if (holder) holder.value = value;
    else record.nativeSlots.set(offset, { value, width });
  }
  return value;
}

function archiveState(archive) {
  if (!archive || typeof archive !== 'object') {
    throw new TypeError('UClass::Link requires an FArchive record');
  }
  const nested = archive.archiveState;
  for (const [key, expected] of Object.entries(CLASS_LINK_ARCHIVE_STATE)) {
    const actual = nested?.[key] ?? archive[key];
    if (actual !== expected) {
      fail(`UClass::Link requires local FArchive ${key} == ${expected}`, {
        operation: 'UClass::Link', slot: key,
      });
    }
  }
  return nested ?? archive;
}

function callStateLink(record, archive, secondArgument, services, trace) {
  const callback = services.linkState ?? services.linkUState ??
    ((object, frame, argument) => linkScriptState(object, {
      archive: frame, secondArgument: argument, services: services.stateLink ?? {},
    }));
  const detail = {
    kind: 'uclass-link-state',
    thunk: SCRIPT_CLASS_LINK.uState.linkThunk,
    body: SCRIPT_CLASS_LINK.uState.linkBody,
    receiver: record,
    archive,
    secondArgument,
  };
  const result = callback(record, archive, secondArgument, detail);
  traceCall(trace, 'state-link', detail);
  return result;
}

function readGlobalLinkGate(record, services) {
  const detail = { kind: 'uclass-link-gate', address: SCRIPT_CLASS_LINK.globals.linkGate };
  let value;
  const readGlobal = services.readGlobal;
  if (typeof readGlobal === 'function') value = readGlobal(SCRIPT_CLASS_LINK.globals.linkGate, detail);
  else {
    const gate = services.globalLinkGate;
    if (typeof gate === 'function') value = gate(record, detail);
    else if (gate !== undefined) value = gate;
    else if (own(record, 'globalLinkGate')) value = record.globalLinkGate;
    else {
      fail('UClass::Link requires the live global link-gate value after UState::Link', {
        operation: 'UClass::Link', slot: '[0x101e5544]',
      });
    }
  }
  return integer(value, 'global link gate', { minimum: 0 });
}

function mutableArray(value, label) {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  throw new TypeError(`Expected ${label} to expose a mutable array`);
}

function arrayShape(raw, owner, offset, aliases, elementSize, services) {
  if (raw === null || raw === undefined) {
    fail(`FArray +0x${offset.toString(16)} needs an explicit logical array or storage adapter`, {
      operation: 'UClass::Link', slot: `+0x${offset.toString(16)}`,
    });
  }

  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    let data = mutableArray(raw, `+0x${offset.toString(16)} FArray`);
    let capacity = data.length;
    return {
      identity: raw,
      getData: () => data,
      setData: next => { data = next; owner[aliases[0]] = next; return next; },
      getNum: () => data.length,
      setNum: value => {
        if (value < data.length) data.length = value;
        while (data.length < value) data.push(undefined);
      },
      getCapacity: () => capacity,
      setCapacity: value => { capacity = integer(value, 'logical FArray.Max', {minimum: 0}); },
      kind: 'logical-array',
    };
  }

  if (typeof raw !== 'object') throw new TypeError(`Expected +0x${offset.toString(16)} FArray record`);
  let data = mutableArray(first(raw, ['data', 'items', 'values'], undefined),
    `+0x${offset.toString(16)} FArray.data`);
  const numKey = own(raw, 'num') ? 'num' : own(raw, 'size') ? 'size' : own(raw, 'count') ? 'count' : null;
  const capacityKey = own(raw, 'capacity') ? 'capacity' : own(raw, 'max') ? 'max' : null;
  let num = integer(numKey ? raw[numKey] : data.length, `+0x${offset.toString(16)} FArray.Num`, { minimum: 0 });
  let capacity = integer(capacityKey ? raw[capacityKey] : data.length,
    `+0x${offset.toString(16)} FArray.Max`, { minimum: num });
  if (data.length < num) throw new RangeError(`+0x${offset.toString(16)} FArray data is smaller than Num`);
  return {
    identity: raw,
    getData: () => data,
    setData: next => {
      data = mutableArray(next, `+0x${offset.toString(16)} FArray.data`);
      raw.data = data;
      return data;
    },
    getNum: () => num,
    setNum: value => {
      num = integer(value, `+0x${offset.toString(16)} FArray.Num`, { minimum: 0 });
      if (numKey) raw[numKey] = num;
      if (num < data.length) data.length = num;
      while (data.length < num) data.push(undefined);
    },
    getCapacity: () => capacity,
    setCapacity: value => {
      capacity = integer(value, `+0x${offset.toString(16)} FArray.Max`, { minimum: 0 });
      if (capacity < num) throw new RangeError(`+0x${offset.toString(16)} FArray Max is smaller than Num`);
      if (capacityKey) raw[capacityKey] = capacity;
    },
    kind: 'logical-farray',
  };
}

function makeArrayState(record, offset, aliases, elementSize, services) {
  const detail = { offset, elementSize, aliases };
  const custom = services.getArrayStorage ?? services.arrayStorage;
  if (typeof custom === 'function') {
    const supplied = custom(record, offset, detail);
    if (supplied !== undefined) {
      if (!supplied || typeof supplied !== 'object' || typeof supplied.getData !== 'function' ||
          typeof supplied.getNum !== 'function' || typeof supplied.setNum !== 'function') {
        throw new TypeError(`Array storage adapter for +0x${offset.toString(16)} is incomplete`);
      }
      return {
        ...supplied,
        identity: supplied.identity ?? supplied,
        getCapacity: supplied.getCapacity ?? (() => supplied.getNum()),
        setCapacity: supplied.setCapacity ?? (() => {}),
        kind: supplied.kind ?? 'adapter-farray',
      };
    }
  }

  const mapBacked = record?.nativeSlots instanceof Map &&
    (hasNativeSlot(record, offset) || hasNativeSlot(record, offset + 4) || hasNativeSlot(record, offset + 8));
  if (mapBacked) {
    if (!hasNativeSlot(record, offset) || !hasNativeSlot(record, offset + 4) || !hasNativeSlot(record, offset + 8)) {
      fail(`FArray +0x${offset.toString(16)} has an incomplete native header`, {
        operation: 'UClass::Link', slot: `+0x${offset.toString(16)}/+0x${(offset + 4).toString(16)}/+0x${(offset + 8).toString(16)}`,
      });
    }
    const dataPointer = nativeSlot(record, offset);
    const numHolder = nativeSlot(record, offset + 4);
    const maxHolder = nativeSlot(record, offset + 8);
    let data;
    if (dataPointer === undefined || dataPointer === null || dataPointer === 0) {
      data = [];
    } else if (Array.isArray(dataPointer) || ArrayBuffer.isView(dataPointer)) {
      data = mutableArray(dataPointer, `+0x${offset.toString(16)} FArray`);
    } else if (typeof services.readArray === 'function') {
      data = mutableArray(services.readArray(record, offset, dataPointer, numHolder ?? 0, maxHolder ?? 0, detail),
        `+0x${offset.toString(16)} FArray adapter result`);
    } else {
      fail(`FArray +0x${offset.toString(16)} has a native pointer without an array storage adapter`, {
        operation: 'UClass::Link', slot: `+0x${offset.toString(16)}`,
      });
    }
    let num = integer(numHolder ?? data.length, `+0x${offset.toString(16)} FArray.Num`, { minimum: 0 });
    let capacity = integer(maxHolder ?? data.length, `+0x${offset.toString(16)} FArray.Max`, { minimum: num });
    if (data.length < num) throw new RangeError(`FArray +0x${offset.toString(16)} data is smaller than Num`);
    const identity = record.nativeSlots;
    return {
      identity,
      getData: () => data,
      setData: next => {
        data = mutableArray(next, `+0x${offset.toString(16)} FArray`);
        writeSlot(record, offset, data, 4, services, detail);
        services.writeArray?.(record, offset, data, detail);
        return data;
      },
      getNum: () => num,
      setNum: value => {
        num = integer(value, `+0x${offset.toString(16)} FArray.Num`, { minimum: 0 });
        writeSlot(record, offset + 4, num, 4, services, detail);
        if (num < data.length) data.length = num;
        while (data.length < num) data.push(undefined);
      },
      getCapacity: () => capacity,
      setCapacity: value => {
        capacity = integer(value, `+0x${offset.toString(16)} FArray.Max`, { minimum: 0 });
        if (capacity < num) throw new RangeError(`FArray +0x${offset.toString(16)} Max is smaller than Num`);
        writeSlot(record, offset + 8, capacity, 4, services, detail);
      },
      kind: 'native-farray',
    };
  }

  const key = aliases.find(name => own(record, name) && record[name] !== undefined) ?? aliases[0];
  const raw = own(record, key) ? record[key] : undefined;
  if (raw === undefined || raw === null) {
    fail(`FArray +0x${offset.toString(16)} needs an explicit ${key} array/storage binding`, {
      operation: 'UClass::Link', slot: `+0x${offset.toString(16)}`,
    });
  }
  return arrayShape(raw, record, offset, [key], elementSize, services);
}

function nativeGrowth(count) {
  // 10107096–101070a2: CDQ biases only negative values before SAR; for
  // positive counts this is floor(3*count/8), not a round-up operation.
  return count + Math.trunc(3 * count / 8) + 0x20;
}

function farrayEmpty(state, elementSize, trace) {
  // Core 0x10107190 is Empty(ElementSize,Slack), with (4,0) here.
  state.setNum(0);
  state.setCapacity(0);
  state.setData([]);
  traceCall(trace, 'empty-array', {
    offset: state.offset,
    elementSize,
    slack: 0,
    body: SCRIPT_CLASS_LINK.helpers.empty.body,
  });
}

function farrayReserve(state, count, elementSize, trace) {
  integer(count, 'FArray reserve count', { minimum: 0 });
  state.setNum(0);
  state.setCapacity(count);
  state.setData([]);
  traceCall(trace, 'reserve-array', {
    offset: state.offset,
    count,
    elementSize,
    body: SCRIPT_CLASS_LINK.helpers.reservePairs.body,
  });
}

function farrayAppend(state, value, elementSize, trace, body, operation = 'append-array') {
  const index = state.getNum();
  const count = index + 1;
  const oldCapacity = state.getCapacity();
  // FArray::Add publishes Num before testing/growing Max (10107091).
  state.setNum(count);
  if (count > oldCapacity) {
    const capacity = nativeGrowth(count);
    state.setCapacity(capacity);
    traceCall(trace, 'grow-array', {
      offset: state.offset,
      count,
      capacity,
      elementSize,
      body,
    });
  }
  const data = state.getData();
  data[index] = value;
  // A storage adapter may replace the backing data when Num is written.
  if (state.getData() !== data) state.getData()[index] = value;
  traceCall(trace, operation, { offset: state.offset, index, elementSize, body });
  return index;
}

function classIdentity(field, services) {
  if (typeof services.getFieldClass === 'function') {
    const result = services.getFieldClass(field, {
    kind: 'field-class', offset: SCRIPT_CLASS_LINK.offsets.objectClass,
    });
    if (result === undefined) {
      fail('UClass::Link field-class adapter returned no +0x24 value', {
        operation: 'field-class', slot: '+0x24', field,
      });
    }
    return result === 0 ? null : result;
  }
  const result = readSlot(field, SCRIPT_CLASS_LINK.offsets.objectClass,
    ['classIdentity', 'fieldClass', 'classRef', 'class'], undefined, services);
  if (result === undefined) {
    fail('UClass::Link reached a UField without its +0x24 Class binding', {
      operation: 'field-class', slot: '+0x24', field,
    });
  }
  return result === 0 ? null : result;
}

function classSuper(classObject, services, field) {
  if (typeof services.getClassSuper === 'function') return services.getClassSuper(classObject, {
    kind: 'class-super', field,
  });
  const value = readSlot(classObject, SCRIPT_CLASS_LINK.offsets.super,
    ['superClass', 'superclass', 'baseClass', 'base', 'super'], undefined, services);
  if (value !== undefined) return value === 0 ? null : value;
  fail('UClass::Link reached a class identity without its +0x28 Super binding', {
    operation: 'field-class-ancestry', slot: '+0x28', field,
  });
}

function classAncestryContains(field, target, services, operation = 'field-class-filter') {
  let current = classIdentity(field, services);
  if (current === undefined || current === null || current === 0) return false;
  const seen = new Set();
  while (current !== null && current !== undefined && current !== 0) {
    if (samePointer(current, target)) return true;
    if (seen.has(current)) throw new Error('Cyclic field class ancestry');
    seen.add(current);
    current = classSuper(current, services, field);
  }
  return false;
}

function childrenOf(structure, services) {
  const value = readSlot(structure, SCRIPT_CLASS_LINK.offsets.children,
    ['children', 'firstChild', 'fields'], undefined, services);
  if (value === undefined) {
    fail('UClass::Link reached a struct without its +0x38 Children binding', {
      operation: 'field-enumeration', slot: '+0x38', field: structure,
    });
  }
  return value === 0 ? null : value;
}

function nextField(field, services) {
  const value = readSlot(field, SCRIPT_CLASS_LINK.offsets.next,
    ['next', 'nextField', 'nextProperty'], undefined, services);
  if (value === undefined) {
    fail('UClass::Link reached a UField without its +0x2c Next binding', {
      operation: 'field-enumeration', slot: '+0x2c', field,
    });
  }
  return value === 0 ? null : value;
}

function inheritanceSuper(structure, services) {
  if (typeof services.getInheritanceSuper === 'function') {
    const result = services.getInheritanceSuper(structure, {
      kind: 'get-inheritance-super', body: 0x10103337, slot: 0x68,
    });
    if (result === undefined) {
      fail('GetInheritanceSuper adapter returned no +0x68 value', {
        operation: 'field-enumeration', slot: '+0x68', field: structure,
      });
    }
    return result === 0 ? null : result;
  }
  const value = first(structure, ['inheritanceSuper', 'superStruct', 'baseStruct'], undefined);
  if (value !== undefined) return value === 0 ? null : value;
  // UClass's +0x68 implementation is the ordinary class Super chain.  A
  // class record already exposes that field under the same native +0x28
  // slot, so this fallback remains an explicit layout binding.
  const superClass = readSlot(structure, SCRIPT_CLASS_LINK.offsets.super,
    ['superClass', 'superclass', 'super'], undefined, services);
  if (superClass !== undefined) return superClass === 0 ? null : superClass;
  fail('UClass::Link field enumeration reached +0x68 without an inheritance-super binding', {
    operation: 'field-enumeration', slot: '+0x68', field: structure,
  });
}

function enumerateNext(record, services, state) {
  let structure = state.structure;
  let candidate = state.candidate;
  while (structure !== null && structure !== undefined) {
    while (candidate !== null && candidate !== undefined) {
      const isField = classAncestryContains(candidate, SCRIPT_CLASS_LINK.identities.fieldClass, services);
      if (isField) {
        state.structure = structure;
        state.candidate = candidate;
        return candidate;
      }
      candidate = nextField(candidate, services);
    }
    structure = inheritanceSuper(structure, services);
    if (structure === null || structure === undefined) break;
    candidate = childrenOf(structure, services);
  }
  state.structure = structure;
  state.candidate = null;
  return null;
}

function ownerClass(field, services) {
  const callback = services.getOwnerClass ?? services.ownerClass;
  if (typeof callback === 'function') {
    const result = callback(field, {
      kind: 'field-owner-class',
      body: SCRIPT_CLASS_LINK.helpers.ownerClass.body,
      slot: SCRIPT_CLASS_LINK.helpers.ownerClass.slot,
    });
    if (result === undefined) {
      fail('UField::GetOwnerClass adapter returned no owner', {
        operation: 'UField::GetOwnerClass', slot: '+0x60', field,
      });
    }
    return result === 0 ? null : result;
  }
  const explicit = first(field, ['ownerClass', 'declaringClass'], undefined);
  if (explicit !== undefined) return explicit;
  let current = field;
  const seen = new Set();
  while (current !== null && current !== undefined) {
    if (seen.has(current)) throw new Error('Cyclic UField outer chain');
    seen.add(current);
    const currentClass = classIdentity(current, services);
    if (samePointer(currentClass, SCRIPT_CLASS_LINK.identities.uClassClass)) return current;
    const outer = readSlot(current, SCRIPT_CLASS_LINK.offsets.outer,
      ['outer', 'outerObject'], undefined, services);
    if (outer === undefined) {
      fail('UField::GetOwnerClass reached an outer chain without +0x18 binding', {
        operation: 'UField::GetOwnerClass', slot: '+0x18', field,
      });
    }
    current = outer === 0 ? null : outer;
  }
  fail('UField::GetOwnerClass reached a null owner', {
    operation: 'UField::GetOwnerClass', slot: '+0x18', field,
  });
}

function isProperty(field, services, trace) {
  let result;
  if (typeof services.isA === 'function') {
    result = services.isA(field, SCRIPT_CLASS_LINK.identities.propertyClass, {
      kind: 'property-is-a', body: 0x1010266c, target: SCRIPT_CLASS_LINK.identities.propertyClass,
    });
  } else if (typeof services.isProperty === 'function') {
    result = services.isProperty(field, {
      kind: 'property-is-a', body: 0x1010266c, target: SCRIPT_CLASS_LINK.identities.propertyClass,
    });
  } else if (own(field, 'isProperty')) {
    result = field.isProperty;
  } else {
    result = classAncestryContains(field, SCRIPT_CLASS_LINK.identities.propertyClass, services, 'property-is-a');
  }
  const accepted = result === true || result === 1;
  traceCall(trace, 'property-is-a', {
    field,
    target: SCRIPT_CLASS_LINK.identities.propertyClass,
    result: accepted,
    body: 0x1010266c,
  });
  return accepted;
}

function fieldFlags(field, services) {
  return integer(readSlot(field, SCRIPT_CLASS_LINK.offsets.propertyFlags,
    ['propertyFlags', 'flags', 'PropertyFlags'], undefined, services),
    'UProperty PropertyFlags (+0x3c)', { minimum: 0 }) >>> 0;
}

function arrayDimension(field, services) {
  return integer(readSlot(field, SCRIPT_CLASS_LINK.offsets.arrayDim,
    ['arrayDim', 'arrayDimension', 'ArrayDim'], undefined, services),
    'UProperty ArrayDim (+0x34)', { minimum: 0 });
}

function fieldOuter(field, services) {
  const outer = readSlot(field, SCRIPT_CLASS_LINK.offsets.outer,
    ['outer', 'outerObject'], undefined, services);
  if (outer === undefined) {
    fail('UClass::Link reached a property without its +0x18 Outer binding', {
      operation: 'UClass::Link', slot: '+0x18', field,
    });
  }
  return outer === 0 ? null : outer;
}

function writeRepIndex(field, value, services, trace) {
  const raw = value & 0xffff;
  writeSlot(field, SCRIPT_CLASS_LINK.offsets.rawRepIndex, raw, 2, services, {
    kind: 'raw-rep-index', field,
  });
  if (!(field.nativeSlots instanceof Map)) {
    field.repIndex = raw;
  } else if (own(field, 'repIndex')) {
    field.repIndex = raw;
  }
  traceCall(trace, 'write-raw-rep-index', {
    field, offset: SCRIPT_CLASS_LINK.offsets.rawRepIndex, value: raw, width: 2,
  });
  return raw;
}

function specialFunction(field, services) {
  if (!classAncestryContains(field, SCRIPT_CLASS_LINK.identities.functionClass, services, 'special-function-class')) {
    return false;
  }
  const flags = integer(readSlot(field, SCRIPT_CLASS_LINK.offsets.specialFlags,
    ['specialFlags', 'functionFlags', 'fieldFlags', 'flags2'], undefined, services),
    'UFunction flags (+0x6c)', { minimum: 0 }) >>> 0;
  if ((flags & SCRIPT_CLASS_LINK.flags.specialFunction) === 0) return false;
  const superFunction = readSlot(field, SCRIPT_CLASS_LINK.offsets.super,
    ['superFunction', 'super'], undefined, services);
  if (superFunction === undefined) {
    fail('UClass::Link reached a UFunction without its +0x28 SuperFunction binding', {
      operation: 'special-function', slot: '+0x28', field,
    });
  }
  return superFunction === null || superFunction === undefined || superFunction === 0;
}

export function nativeNetFieldCompare(left, right, services = {}) {
  const leftPresent = readSlot(left, 0x10, ['sortPresent', 'linker', 'sortOwner'], undefined, services);
  const rightPresent = readSlot(right, 0x10, ['sortPresent', 'linker', 'sortOwner'], undefined, services);
  if (leftPresent === undefined || rightPresent === undefined) {
    fail('UClass::Link net-field sort reached an unbound +0x10 word', {
      operation: 'sort-net-fields', slot: '+0x10', field: leftPresent === undefined ? left : right,
    });
  }
  if (!leftPresent || !rightPresent) return 0;
  const leftRaw = readSlot(left, 0x14, ['sortValue', 'linkerIndex', 'sortIndex'], undefined, services);
  const rightRaw = readSlot(right, 0x14, ['sortValue', 'linkerIndex', 'sortIndex'], undefined, services);
  if (leftRaw === undefined || rightRaw === undefined) {
    fail('UClass::Link net-field sort reached an unbound +0x14 word', {
      operation: 'sort-net-fields', slot: '+0x14', field: leftRaw === undefined ? left : right,
    });
  }
  const leftValue = integer(leftRaw,
    'net-field sort value', { minimum: -0x80000000 });
  const rightValue = integer(rightRaw,
    'net-field sort value', { minimum: -0x80000000 });
  return (leftValue - rightValue) | 0;
}

function sortNetFields(state, record, services, trace) {
  const count = state.getNum();
  const data = state.getData();
  const detail = {
    kind: 'sort-net-fields',
    body: SCRIPT_CLASS_LINK.helpers.sortNetFields.body,
    thunk: SCRIPT_CLASS_LINK.helpers.sortNetFields.thunk,
    receiver: record,
    count,
    comparator: (left, right) => nativeNetFieldCompare(left, right, services),
  };
  if (count >= 2) {
    const callback = services.sortNetFields ?? services.sortFieldArray ?? sortScriptNetFields;
    const sorted = callback(data, detail);
    if (sorted !== undefined && sorted !== data) {
      // Native sorting never reallocates the backing store. An explicit host
      // override may return values, but they must be copied into that store.
      const result = mutableArray(sorted, 'sorted net-field array');
      if (result.length < count) throw new RangeError('Sorted net-field array is too short');
      for (let i = 0; i < count; i += 1) data[i] = result[i];
    }
  }
  traceCall(trace, 'sort-net-fields', { count, body: detail.body, usedAdapter: count >= 2 });
}

const SERVICE_NAMES = Object.freeze([
  'linkState', 'linkUState', 'stateLink', 'readGlobal', 'globalLinkGate',
  'getFieldClass', 'getClassSuper', 'getInheritanceSuper', 'readSlot',
  'writeSlot', 'writeNativeSlot', 'getOwnerClass', 'ownerClass',
  'isA', 'isProperty', 'getArrayStorage', 'arrayStorage', 'readArray',
  'writeArray', 'sortNetFields', 'sortFieldArray',
]);

function serviceHost(options, nested) {
  if (nested !== null && typeof nested !== 'object') {
    throw new TypeError('UClass::Link services must be an object');
  }
  const host = {};
  // Accessors avoid reading a live globalLinkGate getter while the options are
  // assembled, before the native UState::Link call has happened.
  for (const name of SERVICE_NAMES) {
    Object.defineProperty(host, name, {
      configurable: true,
      enumerable: false,
      get: () => {
        const value = nested?.[name];
        return value === undefined ? options[name] : value;
      },
    });
  }
  return host;
}

/**
 * Replays Core's UClass::Link (`10127e30`) for a logical or nativeSlots
 * UClass record.  `archive` defaults to the exact local FArchive words used
 * by Register; callers should pass the frame object when retaining the
 * Register trace. The inherited state linker and field predicates use
 * recovered defaults or explicit host bindings. Multi-entry sorting
 * uses the recovered native helper unless explicitly overridden by the host.
 */
export function linkScriptClass(record, options = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UClass record');
  if (options === null || typeof options !== 'object') {
    throw new TypeError('UClass::Link options must be an object');
  }
  const archive = options.archive === undefined ? { ...CLASS_LINK_ARCHIVE_STATE } : options.archive;
  const secondArgument = options.secondArgument === undefined ? 0 : options.secondArgument;
  const nested = options.services === undefined ? {} : options.services;
  if (secondArgument !== 0) {
    throw new RangeError(`UClass::Link only has a verified second argument of 0, got ${String(secondArgument)}`);
  }
  const frame = archiveState(archive);
  // Accept both the nested `services` form and the flat classLink object
  // used by Register integration.  The latter keeps `linkState`, field
  // predicates, and the sort adapter alongside the archive options.
  const host = serviceHost(options, nested);
  const trace = [];

  callStateLink(record, frame, secondArgument, host, trace);
  const gate = readGlobalLinkGate(record, host);
  traceCall(trace, 'link-gate', { address: SCRIPT_CLASS_LINK.globals.linkGate, value: gate });
  if (gate !== 0) {
    traceCall(trace, 'link-gate-skip', { address: SCRIPT_CLASS_LINK.globals.linkGate, value: gate });
    return {
      record,
      archive: frame,
      secondArgument,
      skipped: true,
      globalLinkGate: gate,
      classReps: null,
      netFields: null,
      operations: trace,
    };
  }

  const reps = makeArrayState(record,
    SCRIPT_CLASS_LINK.offsets.classReps.data,
    ['classReps', 'replicationRecords', 'repRecords', 'fieldNetCache'], 8, host);
  reps.offset = SCRIPT_CLASS_LINK.offsets.classReps.data;
  const netFields = makeArrayState(record,
    SCRIPT_CLASS_LINK.offsets.netFields.data,
    ['netFields', 'netProperties', 'replicatedProperties'], 4, host);
  netFields.offset = SCRIPT_CLASS_LINK.offsets.netFields.data;
  farrayEmpty(netFields, 4, trace);

  const superRaw = readSlot(record, SCRIPT_CLASS_LINK.offsets.super,
    ['superClass', 'superclass', 'super'], undefined, host);
  if (superRaw === undefined) {
    fail('UClass::Link reached +0x28 without a Super binding', {
      operation: 'UClass::Link', slot: '+0x28', field: record,
    });
  }
  const superClass = superRaw === 0 ? null : superRaw;
  let source;
  if (superClass !== null) {
    source = makeArrayState(superClass,
      SCRIPT_CLASS_LINK.offsets.classReps.data,
      ['classReps', 'replicationRecords', 'repRecords', 'fieldNetCache'], 8, host);
    source.offset = SCRIPT_CLASS_LINK.offsets.classReps.data;
  } else {
    // 0x10127ea0 calls the FArray constructor (0x101071c0) and then uses
    // that empty local as the source before destroying it after the copy.
    const empty = [];
    source = {
      identity: empty,
      offset: null,
      getData: () => empty,
      getNum: () => 0,
      getCapacity: () => 0,
      setNum: () => {},
      setCapacity: () => {},
      setData: () => empty,
    };
    traceCall(trace, 'construct-empty-super-reps', { body: 0x101071c0, elementSize: 8 });
  }
  if (reps.identity !== source.identity) {
    const sourceCount = source.getNum();
    farrayReserve(reps, sourceCount, 8, trace);
    const sourceData = source.getData();
    for (let index = 0; index < sourceCount; index += 1) {
      const pair = sourceData[index];
      const normalized = Array.isArray(pair)
        ? [pair[0], pair[1]]
        : { field: pair?.field ?? pair?.property ?? pair?.Field ?? pair?.[0],
          index: pair?.index ?? pair?.arrayIndex ?? pair?.Index ?? pair?.[1] };
      farrayAppend(reps, normalized, 8, trace,
        SCRIPT_CLASS_LINK.helpers.appendPairs.body, 'copy-class-rep');
    }
  } else {
    traceCall(trace, 'skip-class-rep-copy-same-storage', { offset: reps.offset });
  }
  if (superClass === null) {
    traceCall(trace, 'destroy-empty-super-reps', { body: 0x10102df1, elementSize: 8 });
  }

  const walk = {
    structure: record,
    candidate: childrenOf(record, host),
  };
  let candidate = enumerateNext(record, host, walk);
  while (candidate !== null && candidate !== undefined) {
    const owner = ownerClass(candidate, host);
    traceCall(trace, 'field-owner-class', {
      field: candidate,
      owner,
      body: SCRIPT_CLASS_LINK.helpers.ownerClass.body,
      slot: SCRIPT_CLASS_LINK.helpers.ownerClass.slot,
    });
    if (!samePointer(owner, record)) {
      traceCall(trace, 'field-owner-stop', { field: candidate, owner, receiver: record });
      break;
    }

    if (isProperty(candidate, host, trace)) {
      const flags = fieldFlags(candidate, host);
      if ((flags & SCRIPT_CLASS_LINK.flags.netProperty) !== 0) {
        farrayAppend(netFields, candidate, 4, trace,
          SCRIPT_CLASS_LINK.helpers.add.body, 'append-net-field');
        const repIndex = reps.getNum();
        const directOuter = samePointer(fieldOuter(candidate, host), record);
        let dimension = null;
        if (directOuter) {
          writeRepIndex(candidate, repIndex, host, trace);
          dimension = arrayDimension(candidate, host);
          for (let index = 0; index < dimension; index += 1) {
            farrayAppend(reps, { field: candidate, index }, 8, trace,
              SCRIPT_CLASS_LINK.helpers.add.body, 'append-class-rep');
          }
        }
        traceCall(trace, 'net-property', { field: candidate, flags, directOuter, arrayDim: dimension });
      }
    } else if (specialFunction(candidate, host)) {
      farrayAppend(netFields, candidate, 4, trace,
        SCRIPT_CLASS_LINK.helpers.add.body, 'append-special-function');
    }

    walk.candidate = nextField(candidate, host);
    candidate = enumerateNext(record, host, walk);
  }

  const finalCount = netFields.getNum();
  netFields.setCapacity(finalCount);
  traceCall(trace, 'shrink-net-fields', {
    count: finalCount,
    offset: netFields.offset,
    body: 0x10145440,
  });
  sortNetFields(netFields, record, host, trace);
  return {
    record,
    archive: frame,
    secondArgument,
    skipped: false,
    globalLinkGate: gate,
    classReps: reps.getData().slice(0, reps.getNum()),
    netFields: netFields.getData().slice(0, netFields.getNum()),
    operations: trace,
  };
}

export const linkUClass = linkScriptClass;
export default linkScriptClass;
