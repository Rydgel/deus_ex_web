/**
 * UProperty::DestroyValue (+0x94) from the installed Deus Ex GOTY Core.dll.
 *
 * The native routines receive a pointer to an already linked property value.
 * This browser boundary deliberately keeps storage and allocator operations
 * behind services.  Logical VM values (strings, arrays and keyed structs) are
 * mutated in place; a native-shaped record (or an adapter returned by a
 * service) must provide the allocator operations that the original routine
 * performed.
 */

export const SCRIPT_PROPERTY_DESTROY = Object.freeze({
  property: Object.freeze({ kind: 'Property', vtable: 0x10175a44, body: 0x10165590 }),
  byteProperty: Object.freeze({ kind: 'ByteProperty', vtable: 0x10175b04, body: 0x10165590 }),
  intProperty: Object.freeze({ kind: 'IntProperty', vtable: 0x10175bc4, body: 0x10165590 }),
  boolProperty: Object.freeze({ kind: 'BoolProperty', vtable: 0x10175c84, body: 0x10165590 }),
  floatProperty: Object.freeze({ kind: 'FloatProperty', vtable: 0x10175d44, body: 0x10165590 }),
  objectProperty: Object.freeze({ kind: 'ObjectProperty', vtable: 0x10175e04, body: 0x10165590 }),
  classProperty: Object.freeze({ kind: 'ClassProperty', vtable: 0x10175ec4, body: 0x10165590 }),
  nameProperty: Object.freeze({ kind: 'NameProperty', vtable: 0x10175f84, body: 0x10165590 }),
  strProperty: Object.freeze({ kind: 'StrProperty', vtable: 0x10176044, body: 0x10167ba0 }),
  fixedArrayProperty: Object.freeze({ kind: 'FixedArrayProperty', vtable: 0x10176104, body: 0x101682e0 }),
  arrayProperty: Object.freeze({ kind: 'ArrayProperty', vtable: 0x101761c4, body: 0x10168bb0 }),
  mapProperty: Object.freeze({ kind: 'MapProperty', vtable: 0x10176284, body: 0x10168f50 }),
  structProperty: Object.freeze({ kind: 'StructProperty', vtable: 0x10176344, body: 0x10169cf0 }),
  offsets: Object.freeze({
    fStringData: 0x00, fStringArrayNum: 0x04, fStringArrayMax: 0x08,
    tArrayData: 0x00, tArrayArrayNum: 0x04, tArrayArrayMax: 0x08,
    propertyArrayDim: 0x34, propertyElementSize: 0x38,
    propertyFlags: 0x3c, propertyOffset: 0x48,
    propertyNext: 0x54, propertyInner: 0x5c,
    fixedArrayCount: 0x60, structDestructorLink: 0x68,
  }),
  flags: Object.freeze({ needDestruction: 0x00400000 }),
  string: Object.freeze({ elementSize: 2, reallocTag: 0x101ab50c }),
});

export class UnsupportedScriptPropertyDestroyError extends Error {
  constructor(message, {
    operation = 'UProperty::DestroyValue', kind = null, property = null,
    slot = null, value = null,
  } = {}) {
    super(message);
    this.name = 'UnsupportedScriptPropertyDestroyError';
    this.code = 'UNSUPPORTED_SCRIPT_PROPERTY_DESTROY';
    this.operation = operation;
    this.kind = kind;
    this.property = property;
    this.slot = slot;
    this.value = value;
  }
}

const O = SCRIPT_PROPERTY_DESTROY.offsets;
const D = SCRIPT_PROPERTY_DESTROY;
const NEED_DESTRUCTION = SCRIPT_PROPERTY_DESTROY.flags.needDestruction;
const UNRESOLVED = Symbol('unresolved-property-destroy-slot');
const NO_VALUE = Symbol('no-property-destroy-value');

const VTABLE_KIND = new Map(Object.values(D)
  .filter(value => value && typeof value === 'object' && value.kind && value.vtable !== undefined)
  .map(value => [value.vtable, value.kind]));

const KIND_BY_TYPE = Object.freeze({
  byte: 'ByteProperty', int: 'IntProperty', integer: 'IntProperty',
  bool: 'BoolProperty', boolean: 'BoolProperty', float: 'FloatProperty',
  name: 'NameProperty', string: 'StrProperty', str: 'StrProperty',
  object: 'ObjectProperty', class: 'ClassProperty', struct: 'StructProperty',
  array: 'ArrayProperty', map: 'MapProperty', fixedarray: 'FixedArrayProperty',
  'fixed-array': 'FixedArrayProperty', fixed_array: 'FixedArrayProperty',
});

const KIND_ALIASES = Object.freeze({
  Property: 'Property', UProperty: 'Property',
  ByteProperty: 'ByteProperty', UByteProperty: 'ByteProperty',
  IntProperty: 'IntProperty', UIntProperty: 'IntProperty', UIntegerProperty: 'IntProperty',
  BoolProperty: 'BoolProperty', UBoolProperty: 'BoolProperty',
  FloatProperty: 'FloatProperty', UFloatProperty: 'FloatProperty',
  ObjectProperty: 'ObjectProperty', UObjectProperty: 'ObjectProperty',
  ClassProperty: 'ClassProperty', UClassProperty: 'ClassProperty',
  NameProperty: 'NameProperty', UNameProperty: 'NameProperty',
  StrProperty: 'StrProperty', FStringProperty: 'StrProperty', UStrProperty: 'StrProperty',
  ArrayProperty: 'ArrayProperty', UArrayProperty: 'ArrayProperty',
  FixedArrayProperty: 'FixedArrayProperty', UFixedArrayProperty: 'FixedArrayProperty',
  MapProperty: 'MapProperty', UMapProperty: 'MapProperty',
  StructProperty: 'StructProperty', UStructProperty: 'StructProperty',
});

function own(record, key) {
  return record !== null && record !== undefined && Object.hasOwn(record, key);
}

function first(record, names, fallback = undefined) {
  for (const name of names) {
    if (record !== null && record !== undefined && record[name] !== undefined) return record[name];
  }
  return fallback;
}

function metadataOf(property) {
  return property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
}

function fail(message, details = {}) {
  throw new UnsupportedScriptPropertyDestroyError(message, details);
}

function integer(value, label, {minimum = 0, maximum = 0x7fffffff} = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function uint32(value, label) {
  return integer(value, label, {minimum: 0, maximum: 0xffffffff}) >>> 0;
}

function nativeSlotValue(value) {
  if (value && typeof value === 'object' && own(value, 'value')) return value.value;
  return value;
}

/** Read a property slot through the host adapter, nativeSlots, or a named field. */
function readSlot(property, offset, aliases, services = {}, context = {}) {
  if (typeof services.readSlot === 'function') {
    const value = services.readSlot(property, offset, {
      kind: 'property-destroy-read-slot', offset, property, ...context,
    });
    if (value !== undefined) return nativeSlotValue(value);
  }
  const slots = property?.nativeSlots;
  if (slots instanceof Map && slots.has(offset)) return nativeSlotValue(slots.get(offset));
  if (slots && typeof slots === 'object' && own(slots, offset)) return nativeSlotValue(slots[offset]);
  for (const source of [property, metadataOf(property)]) {
    const value = first(source, aliases, UNRESOLVED);
    if (value !== UNRESOLVED) return value;
  }
  return UNRESOLVED;
}

function requiredSlot(property, offset, aliases, services, label, context = {}) {
  const value = readSlot(property, offset, aliases, services, context);
  if (value === UNRESOLVED || value === undefined) {
    fail(`${label} (+0x${offset.toString(16)}) is unresolved`, {
      operation: context.operation ?? 'UProperty::DestroyValue',
      kind: context.kind ?? kindOf(property), property, slot: `+0x${offset.toString(16)}`,
    });
  }
  return value;
}

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (KIND_ALIASES[text]) return KIND_ALIASES[text];
  if (KIND_ALIASES[`${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`]) {
    return KIND_ALIASES[`${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`];
  }
  return KIND_BY_TYPE[text.toLowerCase()] ?? text;
}

function kindOf(property, services = {}) {
  const metadata = metadataOf(property);
  let kind = normalizeKind(first(property,
    ['nativeKind', 'kind', 'className', 'propertyClassName'], undefined));
  if (kind === undefined) kind = normalizeKind(first(metadata,
    ['nativeKind', 'kind', 'className', 'propertyClassName', 'type', 'valueType'], undefined));

  let vtable = readSlot(property, 0, ['nativeVtable', 'vtable'], services, {operation: 'UProperty::DestroyValue'});
  if (vtable !== UNRESOLVED && vtable !== undefined && vtable !== null) {
    vtable = uint32(vtable, 'property vtable');
    const vtableKind = VTABLE_KIND.get(vtable);
    if (!vtableKind || (kind !== undefined && kind !== vtableKind)) {
      fail(`Property DestroyValue vtable 0x${vtable.toString(16)} does not match a verified class`, {
        operation: 'UProperty::DestroyValue', kind, property, slot: '+0x0', value: vtable,
      });
    }
    kind ??= vtableKind;
  }
  if (kind === undefined) {
    fail('Property DestroyValue native class is unresolved', {
      operation: 'UProperty::DestroyValue', kind: null, property, slot: '+0x0',
    });
  }
  if (!VTABLE_KIND.has([...VTABLE_KIND.keys()].find(key => VTABLE_KIND.get(key) === kind)) &&
      !Object.values(D).some(value => value?.kind === kind)) {
    fail(`Property DestroyValue does not implement ${kind}`, {
      operation: 'UProperty::DestroyValue', kind, property, slot: '+0x0',
    });
  }
  return kind;
}

function propertyName(property) {
  const metadata = metadataOf(property);
  return String(first(property, ['key', 'name', 'Name', 'propertyName'],
    first(metadata, ['key', 'name', 'Name', 'propertyName'], '<property>')));
}

function arrayDimOf(property, services, context) {
  const value = requiredSlot(property, O.propertyArrayDim,
    ['arrayDim', 'arrayDimension', 'ArrayDim'], services, 'Property ArrayDim', context);
  return integer(value, 'Property ArrayDim', {minimum: 0});
}

function elementSizeOf(property, services, context) {
  const value = requiredSlot(property, O.propertyElementSize,
    ['elementSize', 'element_size', 'ElementSize'], services, 'Property ElementSize', context);
  return integer(value, 'Property ElementSize', {minimum: 0});
}

function flagsOf(property, services, context) {
  const value = requiredSlot(property, O.propertyFlags,
    ['flags', 'propertyFlags', 'PropertyFlags'], services, 'Property PropertyFlags', context);
  return uint32(value, 'Property PropertyFlags');
}

function countOf(property, services, context) {
  const value = requiredSlot(property, O.fixedArrayCount,
    ['arrayCount', 'fixedArraySize', 'fixedArrayDimension', 'count', 'ArrayCount'],
    services, 'FixedArray ArrayCount', context);
  return integer(value, 'FixedArray ArrayCount', {minimum: 0});
}

function innerOf(property, services, context, label) {
  const callback = services.innerProperty ?? services.resolveInnerProperty;
  if (typeof callback === 'function') {
    const value = callback(property, {offset: O.propertyInner, property, ...context});
    if (value !== undefined && value !== null) return value;
  }
  const value = readSlot(property, O.propertyInner,
    ['inner', 'innerProperty', 'innerMetadata', 'child', 'Inner'], services, context);
  if (value === UNRESOLVED || value === undefined || value === null) {
    fail(`${label} property Inner (+0x5c) is unresolved`, {
      operation: context.operation ?? 'UProperty::DestroyValue', kind: context.kind ?? kindOf(property),
      property, slot: '+0x5c',
    });
  }
  return value;
}

function structOf(property, services, context) {
  const callback = services.innerStruct ?? services.resolveInnerStruct;
  if (typeof callback === 'function') {
    const value = callback(property, {offset: O.propertyInner, property, ...context});
    if (value !== undefined && value !== null) return value;
  }
  const value = readSlot(property, O.propertyInner,
    ['struct', 'structObject', 'structClass', 'structRef', 'innerStruct', 'Struct'], services, context);
  if (value === UNRESOLVED || value === undefined || value === null) {
    fail('UStructProperty inner Struct (+0x5c) is unresolved', {
      operation: context.operation ?? 'UStructProperty::DestroyValue', kind: 'StructProperty',
      property, slot: '+0x5c',
    });
  }
  return value;
}

function trace(services, event) {
  if (Array.isArray(services.trace)) services.trace.push(event);
  if (typeof services.trace === 'function') services.trace(event);
}

function makeContext(context, property, kind, extra = {}) {
  return {
    ...context, property, kind,
    operation: context.operation ?? 'UProperty::DestroyValue',
    ...extra,
  };
}

function reference(value, label = '<value>') {
  if (value && typeof value.get === 'function' && typeof value.set === 'function') return value;
  let current = value;
  return {
    reference: true,
    key: label,
    get: () => current,
    set: next => { current = next; return next; },
  };
}

function readReference(ref, details) {
  if (!ref || typeof ref.get !== 'function') {
    throw new TypeError(`DestroyValue requires a readable value reference${details ? ` for ${details}` : ''}`);
  }
  return ref.get();
}

function writeReference(ref, value, details) {
  if (!ref || typeof ref.set !== 'function') {
    throw new TypeError(`DestroyValue requires a writable value reference${details ? ` for ${details}` : ''}`);
  }
  return ref.set(value);
}

function pointerValue(value) {
  if (value === null || value === undefined || value === 0 || value === 0n) return null;
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value !== 'object') return null;
  for (const key of ['pointer', 'ptr', 'nativePointer', 'address', 'nativeAddress', 'dataPointer']) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== 0 && value[key] !== 0n) {
      return value[key];
    }
  }
  return null;
}

function pointerLike(value) {
  const pointer = pointerValue(value);
  return pointer === null ? null : pointer;
}

function nativeMarked(value) {
  return value !== null && typeof value === 'object' &&
    (value.native === true || value.nativeStorage === true || value.nativeRecord === true);
}

function logicalStorage(value) {
  if (value === null || value === undefined || typeof value === 'string' || Array.isArray(value)) return true;
  return typeof value === 'object' && !nativeMarked(value) && pointerLike(value) === null;
}

function optionalElementSize(property, services, context, required) {
  const value = readSlot(property, O.propertyElementSize,
    ['elementSize', 'element_size', 'ElementSize'], services, context);
  if (value === UNRESOLVED || value === undefined || value === null) {
    if (required) return elementSizeOf(property, services, context);
    return null;
  }
  return integer(value, 'Property ElementSize', {minimum: 0});
}

function fieldValue(value, aliases, fallback = UNRESOLVED) {
  if (value === null || value === undefined || typeof value !== 'object') return fallback;
  for (const name of aliases) if (value[name] !== undefined) return value[name];
  return fallback;
}

function setField(value, aliases, next) {
  if (value === null || typeof value !== 'object') return false;
  for (const name of aliases) {
    if (own(value, name)) {
      value[name] = next;
      return true;
    }
  }
  value[aliases[0]] = next;
  return true;
}

function setDataField(value, next) {
  if (value === null || typeof value !== 'object') return false;
  let wrote = false;
  for (const name of ['data', 'Data', 'pointer', 'ptr', 'nativePointer']) {
    if (own(value, name)) {
      value[name] = next;
      wrote = true;
    }
  }
  if (!wrote) value.data = next;
  return true;
}

function zeroPointer(pointer) {
  return typeof pointer === 'bigint' ? 0n : 0;
}

function addressOffset(base, stride, index) {
  if (stride === null || base === null) return null;
  return (base === undefined ? 0 : base) + index * stride;
}

function hasRecordField(value, aliases) {
  return value !== null && typeof value === 'object' && aliases.some(name => own(value, name));
}

function allocatorService(services, operation) {
  const fn = operation === 'realloc'
    ? (services.realloc ?? services.reallocate ?? services.allocator?.realloc)
    : (services.free ?? services.deallocate ?? services.allocator?.free);
  return typeof fn === 'function' ? fn : null;
}

function callRealloc(services, pointer, bytes, details) {
  const fn = allocatorService(services, 'realloc');
  if (!fn) {
    fail('FString destruction requires an explicit realloc service', {
      operation: 'FString::~FString', kind: 'StrProperty', property: details.property,
      slot: 'GMalloc::Realloc', value: pointer,
    });
  }
  const result = fn(pointer, bytes, {
    body: 0x101075a0, elementSize: D.string.elementSize,
    tag: D.string.reallocTag, property: details.property, ...details,
  });
  if (result === undefined) {
    fail('FString realloc service returned no pointer', {
      operation: 'FString::~FString', kind: 'StrProperty', property: details.property,
      slot: 'GMalloc::Realloc', value: pointer,
    });
  }
  trace(services, {...details, operation: 'realloc', pointer, bytes, tag: D.string.reallocTag});
  return result;
}

function callFree(services, pointer, details) {
  const fn = allocatorService(services, 'free');
  if (!fn) {
    fail('Property destruction requires an explicit free service for a native pointer', {
      operation: details.operation ?? 'UProperty::DestroyValue', kind: details.kind,
      property: details.property, slot: 'GMalloc::Free', value: pointer,
    });
  }
  fn(pointer, {body: details.body, property: details.property, ...details});
  trace(services, {...details, operation: 'free', pointer});
}

function logicalString(value) {
  return typeof value === 'string';
}

function stringRecord(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const data = fieldValue(value, ['data', 'Data', 'pointer', 'ptr', 'nativePointer'], UNRESOLVED);
  const hasHeader = hasRecordField(value, ['arrayNum', 'ArrayNum', 'arrayMax', 'ArrayMax', 'capacity']);
  const pointer = pointerLike(data);
  if (nativeMarked(value) || pointer !== null || hasHeader && typeof data !== 'string') {
    return {record: value, data, pointer, native: true};
  }
  if (typeof data === 'string' || hasHeader) return {record: value, data, pointer: null, native: false};
  return null;
}

function stringLayoutFromService(value, property, services, context) {
  const resolver = services.stringStorage ?? services.stringLayout ?? services.resolveStringStorage;
  if (typeof resolver !== 'function') return null;
  const layout = resolver(value, property, context);
  if (layout === undefined || layout === null) return null;
  if (typeof layout !== 'object') {
    return {record: value, data: layout, pointer: pointerLike(layout), native: pointerLike(layout) !== null};
  }
  const record = layout.record ?? layout.value ?? value;
  const data = layout.data ?? layout.Data ?? layout.pointer ?? layout.ptr ?? layout.nativePointer;
  return {
    record, data: data === undefined ? fieldValue(record, ['data', 'Data'], UNRESOLVED) : data,
    pointer: pointerLike(layout.pointer ?? layout.ptr ?? layout.nativePointer ?? data),
    native: layout.native === true || layout.nativeStorage === true || layout.nativeRecord === true ||
      pointerLike(layout.pointer ?? layout.ptr ?? layout.nativePointer ?? data) !== null,
    adapter: layout,
  };
}

function destroyNativeStringRecord(recordInfo, ref, property, context, services) {
  const {record, data} = recordInfo;
  const oldPointer = pointerLike(data);
  const oldData = data === UNRESOLVED ? null : data;
  // Native order: clear count/capacity before Realloc; use the old Data.
  setField(record, ['arrayNum', 'ArrayNum'], 0);
  setField(record, ['arrayMax', 'ArrayMax', 'capacity'], 0);
  trace(services, {...context, operation: 'string-preclear', property, pointer: oldPointer});
  const resultPointer = callRealloc(services, oldPointer, 0, {
    operation: 'FString::~FString', kind: 'StrProperty', property,
    pointer: oldPointer, previousData: oldData, ...context,
  });
  // FArray::Realloc stores its return in Data before the destructor invokes
  // Remove.  A host Remove adapter may change that slot, so Free below reads
  // the record again instead of retaining the return in a local only.
  setDataField(record, resultPointer);
  // The destructor calls Remove(0, 0, 2) after Realloc.  It is a no-op for
  // this path, but a host can observe it when it models FArray explicitly.
  const remove = services.removeArray ?? services.arrayRemove ?? services.remove;
  if (typeof remove === 'function') {
    remove(record, 0, 0, D.string.elementSize, {
      operation: 'FString::~FString-remove', property, ...context,
    });
  }
  trace(services, {...context, operation: 'string-remove', index: 0, count: 0, elementSize: D.string.elementSize});
  const currentData = fieldValue(record, ['data', 'Data', 'pointer', 'ptr', 'nativePointer'], resultPointer);
  const returnedPointer = pointerLike(currentData);
  if (returnedPointer !== null) {
    callFree(services, returnedPointer, {
      operation: 'FString::~FString', kind: 'StrProperty', property, body: 0x101075a0, ...context,
    });
  }
  setDataField(record, zeroPointerLike(currentData));
  setField(record, ['arrayMax', 'ArrayMax', 'capacity'], 0);
  setField(record, ['arrayNum', 'ArrayNum'], 0);
  writeReference(ref, record, propertyName(property));
  return {
    property, kind: 'StrProperty', storage: 'native', pointer: oldPointer,
    returnedPointer, arrayNum: 0, arrayMax: 0,
  };
}

function zeroPointerLike(value) {
  if (value === null || value === undefined || value === UNRESOLVED) return 0;
  if (typeof value === 'bigint') return 0n;
  if (typeof value === 'object') {
    if (own(value, 'pointer')) return {...value, pointer: zeroPointer(value.pointer)};
    if (own(value, 'ptr')) return {...value, ptr: zeroPointer(value.ptr)};
    if (own(value, 'nativePointer')) return {...value, nativePointer: zeroPointer(value.nativePointer)};
  }
  return 0;
}

function destroyStringValue(property, ref, context, services) {
  const dimension = arrayDimOf(property, services, context);
  if (dimension <= 0) {
    return {property, kind: 'StrProperty', storage: 'logical', arrayDim: dimension, elements: []};
  }
  const rootValue = readReference(ref, propertyName(property));
  const serviceLayout = stringLayoutFromService(rootValue, property, services, context);
  const rootRecord = serviceLayout ?? stringRecord(rootValue);
  const stride = optionalElementSize(property, services, context,
    !logicalStorage(rootValue) || rootRecord?.native === true);
  const results = [];

  const elementReference = (index, elementValue) => {
    const details = {
      ...context, property, kind: 'StrProperty', index,
      addressOffset: addressOffset(context.addressOffset, stride, index),
    };
    // ArrayDim == 1 already receives the FString record itself.  Core does
    // not perform an element-cursor callback for that scalar record; keeping
    // this fast path also prevents an outer array adapter from intercepting a
    // nested scalar string at index zero.
    if (dimension === 1 && index === 0) return ref;
    const resolver = services.elementReference ?? services.referenceForElement ?? services.elementRef;
    if (typeof resolver === 'function') {
      const resolved = resolver(ref, index, property, details);
      if (resolved && typeof resolved.get === 'function' && typeof resolved.set === 'function') return resolved;
    }
    if (Array.isArray(rootValue)) {
      return reference({
        get: () => rootValue[index],
        set: next => {
          rootValue[index] = next;
          writeReference(ref, rootValue, `${propertyName(property)}[${index}]`);
          return next;
        },
      }, `${propertyName(property)}[${index}]`);
    }
    if (rootRecord && Array.isArray(rootRecord.data ?? rootRecord.Data)) {
      const dataArray = rootRecord.data ?? rootRecord.Data;
      return reference({
        get: () => dataArray[index],
        set: next => {
          dataArray[index] = next;
          writeReference(ref, rootRecord.record, `${propertyName(property)}[${index}]`);
          return next;
        },
      }, `${propertyName(property)}[${index}]`);
    }
    if (index === 0 && rootRecord && rootRecord.record === rootValue) return ref;
    if (elementValue !== NO_VALUE) return reference(elementValue, `${propertyName(property)}[${index}]`);
    fail(`UStrProperty element ${index} storage is unresolved`, {
      operation: 'UStrProperty::DestroyValue', kind: 'StrProperty', property, slot: 'value', value: index,
    });
  };

  if (rootRecord?.native && dimension > 1) {
    // A raw pointer's individual records require an explicit host cursor.
    const dataArray = fieldValue(rootRecord.record, ['data', 'Data'], UNRESOLVED);
    if (!Array.isArray(dataArray)) {
      const resolver = services.elementReference ?? services.referenceForElement ?? services.elementRef;
      if (typeof resolver !== 'function') {
        fail('UStrProperty native ArrayDim storage requires elementReference', {
          operation: 'UStrProperty::DestroyValue', kind: 'StrProperty', property, slot: 'value',
        });
      }
    }
  }

  for (let index = 0; index < dimension; index++) {
    const itemRef = elementReference(index, rootRecord?.native && index === 0 ? rootRecord.record : NO_VALUE);
    const item = readReference(itemRef, `${propertyName(property)}[${index}]`);
    const layout = stringLayoutFromService(item, property, services, {
      ...context, arrayIndex: index,
      addressOffset: addressOffset(context.addressOffset, stride, index),
    }) ?? stringRecord(item);
    if (typeof item === 'string') {
      writeReference(itemRef, '', `${propertyName(property)}[${index}]`);
      trace(services, {...context, operation: 'string-logical-clear', property, index});
      results.push({index, storage: 'logical'});
    } else if (layout?.native) {
      results.push(destroyNativeStringRecord(layout, itemRef, property, {
        ...context, arrayIndex: index,
        addressOffset: addressOffset(context.addressOffset, stride, index),
      }, services));
    } else if (layout?.record) {
      const record = layout.record;
      setField(record, ['data', 'Data'], typeof layout.data === 'string' ? '' : zeroPointerLike(layout.data));
      setField(record, ['arrayNum', 'ArrayNum'], 0);
      setField(record, ['arrayMax', 'ArrayMax', 'capacity'], 0);
      writeReference(itemRef, record, `${propertyName(property)}[${index}]`);
      trace(services, {...context, operation: 'string-logical-clear', property, index});
      results.push({index, storage: 'logical'});
    } else {
      fail(`UStrProperty element ${index} is not a supported string value`, {
        operation: 'UStrProperty::DestroyValue', kind: 'StrProperty', property, slot: 'value', value: item,
      });
    }
  }
  return {
    property, kind: 'StrProperty', storage: results.some(result => result.storage === 'native') ? 'native' : 'logical',
    arrayDim: dimension, elementSize: stride, elements: results,
  };
}

function arrayRecord(value, label) {
  if (Array.isArray(value)) return {record: null, data: value, arrayNum: value.length, arrayMax: value.length, native: false};
  if (value === null || value === undefined) return {record: null, data: [], arrayNum: 0, arrayMax: 0, native: false};
  if (typeof value !== 'object') {
    fail(`${label} TArray value is not a supported record`, {operation: 'UArrayProperty::DestroyValue', slot: 'value', value});
  }
  const data = fieldValue(value, ['data', 'Data'], UNRESOLVED);
  const pointer = pointerLike(data);
  const native = nativeMarked(value) || pointer !== null || (data !== UNRESOLVED && !Array.isArray(data));
  const arrayNum = fieldValue(value, ['arrayNum', 'ArrayNum', 'count'],
    Array.isArray(data) ? data.length : UNRESOLVED);
  const arrayMax = fieldValue(value, ['arrayMax', 'ArrayMax', 'capacity'],
    arrayNum === UNRESOLVED ? UNRESOLVED : arrayNum);
  if (arrayNum === UNRESOLVED || arrayMax === UNRESOLVED) {
    fail(`${label} TArray header is unresolved`, {operation: 'UArrayProperty::DestroyValue', slot: '+0x4/+0x8', value});
  }
  return {
    record: value, data, pointer, native,
    arrayNum: integer(arrayNum, `${label} TArray ArrayNum (+0x4)`, {minimum: 0}),
    arrayMax: integer(arrayMax, `${label} TArray ArrayMax (+0x8)`, {minimum: 0}),
  };
}

function fixedArrayRecord(value, label) {
  if (Array.isArray(value)) {
    return {record: null, data: value, pointer: null, native: false};
  }
  if (value === null || value === undefined) {
    return {record: null, data: [], pointer: null, native: false};
  }
  if (typeof value !== 'object') {
    fail(`${label} inline storage is not a supported record`, {
      operation: 'UFixedArrayProperty::DestroyValue', slot: 'value', value,
    });
  }
  const data = fieldValue(value, ['data', 'Data', 'pointer', 'ptr', 'nativePointer'], UNRESOLVED);
  const pointer = pointerLike(data);
  const native = nativeMarked(value) || pointer !== null || (data !== UNRESOLVED && !Array.isArray(data));
  if (native) return {record: value, data, pointer, native: true};
  if (Array.isArray(data)) return {record: value, data, pointer: null, native: false};
  fail(`${label} inline elements are unresolved`, {
    operation: 'UFixedArrayProperty::DestroyValue', slot: 'value', value,
  });
}

function logicalElementReference(rootRef, shape, index, property, details) {
  const data = shape.data;
  return {
    reference: true,
    key: `${propertyName(property)}[${index}]`,
    get: () => data[index],
    set: next => {
      data[index] = next;
      writeReference(rootRef, shape.record ?? data, `${propertyName(property)}[${index}]`);
      return next;
    },
    parent: rootRef,
    index,
    property,
    details,
  };
}

function resolveElementReference(rootRef, shape, index, inner, property, details, services) {
  const resolver = services.elementReference ?? services.referenceForElement ?? services.elementRef;
  if (typeof resolver === 'function') {
    const resolved = resolver(rootRef, index, inner, details);
    if (resolved && typeof resolved.get === 'function' && typeof resolved.set === 'function') return resolved;
  }
  if (Array.isArray(shape.data)) return logicalElementReference(rootRef, shape, index, property, details);
  fail(`Native array element ${index} storage is unresolved`, {
    operation: details.operation ?? 'UArrayProperty::DestroyValue', kind: details.kind,
    property, slot: 'value', value: index,
  });
}

function clearArrayRecord(shape, rootRef, property, context, services) {
  if (shape.native) {
    // Core reloads TArray::Data after all Inner destructors.  An adapter may
    // have changed the header while a child was being destroyed, so do not
    // free the pointer cached before that callback pass.
    const currentData = fieldValue(shape.record, ['data', 'Data'], shape.data);
    const currentPointer = pointerLike(currentData);
    if (currentPointer !== null) {
      callFree(services, currentPointer, {
        operation: 'UArrayProperty::DestroyValue', kind: 'ArrayProperty', property,
        body: D.arrayProperty.body, ...context,
      });
    }
    setDataField(shape.record, zeroPointerLike(currentData));
    setField(shape.record, ['arrayMax', 'ArrayMax', 'capacity'], 0);
    setField(shape.record, ['arrayNum', 'ArrayNum', 'count'], 0);
    writeReference(rootRef, shape.record, propertyName(property));
    return 'native';
  }
  if (Array.isArray(shape.data)) shape.data.length = 0;
  if (shape.record) {
    setField(shape.record, ['data', 'Data'], shape.data);
    setField(shape.record, ['arrayMax', 'ArrayMax', 'capacity'], 0);
    setField(shape.record, ['arrayNum', 'ArrayNum', 'count'], 0);
    writeReference(rootRef, shape.record, propertyName(property));
  } else {
    writeReference(rootRef, shape.data, propertyName(property));
  }
  trace(services, {...context, operation: 'array-logical-clear', property});
  return 'logical';
}

function destroyArrayValue(property, ref, context, services) {
  const inner = innerOf(property, services, context, 'UArrayProperty');
  const innerFlags = flagsOf(inner, services, makeContext(context, inner, kindOf(inner, services), {
    operation: 'UArrayProperty::DestroyValue-inner-flags',
  }));
  const shape = arrayRecord(readReference(ref, propertyName(property)), 'UArrayProperty');
  const owned = (innerFlags & NEED_DESTRUCTION) !== 0;
  const results = [];
  if (owned) {
    const stride = optionalElementSize(inner, services, makeContext(context, inner, kindOf(inner, services), {
      operation: 'UArrayProperty::DestroyValue-inner-stride',
    }), shape.native);
    for (let index = 0; index < shape.arrayNum; index++) {
      const itemRef = resolveElementReference(ref, shape, index, inner, property, {
        ...context, operation: 'UArrayProperty::DestroyValue', kind: 'ArrayProperty',
        arrayIndex: index, addressOffset: stride === null ? null : index * stride,
      }, services);
      results.push(destroyScriptProperty(inner, itemRef, services, {
        ...context, operation: 'UArrayProperty::DestroyValue', arrayIndex: index,
        addressOffset: stride === null ? null : index * stride, parentProperty: property,
      }));
    }
  }
  const storage = clearArrayRecord(shape, ref, property, context, services);
  return {
    property, kind: 'ArrayProperty', storage, ownedInner: owned,
    arrayNum: shape.arrayNum, arrayMax: shape.arrayMax, elements: results,
  };
}

function linkedNext(property, services, context) {
  const callback = services.nextProperty ?? services.nextOf ?? services.propertyNext;
  if (typeof callback === 'function') {
    const next = callback(property, {offset: O.propertyNext, property, ...context});
    if (next === undefined) {
      fail('UStructProperty destructor child Next (+0x54) is unresolved', {
        operation: 'UStructProperty::DestroyValue', kind: 'StructProperty',
        property, slot: '+0x54', value: property,
      });
    }
    return next;
  }
  const value = readSlot(property, O.propertyNext,
    ['destructorNext', 'constructorLinkNext', 'nextDestructor', 'nextCtorLink', 'propertyNext'], services, context);
  if (value === UNRESOLVED || value === undefined) {
    fail('UStructProperty destructor child Next (+0x54) is unresolved', {
      operation: 'UStructProperty::DestroyValue', kind: 'StructProperty',
      property, slot: '+0x54', value: property,
    });
  }
  return value;
}

function structChildren(structure, services, context) {
  const callback = services.structFields;
  if (typeof callback === 'function') {
    const value = callback(structure, {offset: O.structDestructorLink, structure, ...context});
    if (value === undefined) {
      fail('UStructProperty destructor/constructor-link head (+0x68) is unresolved', {
        operation: 'UStructProperty::DestroyValue', kind: 'StructProperty',
        property: context.property ?? null, slot: '+0x68', value: structure,
      });
    }
    if (value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value[Symbol.iterator] === 'function') return value;
    if (typeof value === 'object') {
      const nested = first(value, ['structFields', 'fields'], UNRESOLVED);
      if (nested !== UNRESOLVED && nested !== null && nested !== undefined) {
        return Array.isArray(nested) || typeof nested[Symbol.iterator] === 'function'
          ? nested : linkedPropertyList(nested, services, context);
      }
    }
    // A callback may return the native +0x68 head rather than an array.
    return linkedPropertyList(value, services, context);
  }
  const fields = first(structure, ['structFields', 'fields'], UNRESOLVED);
  if (fields !== UNRESOLVED && fields !== null && fields !== undefined) {
    if (Array.isArray(fields) || typeof fields[Symbol.iterator] === 'function') return fields;
    return linkedPropertyList(fields, services, context);
  }
  const head = readSlot(structure, O.structDestructorLink,
    ['destructorLink', 'constructorLink', 'destructorChildren', 'structDestructorLink', 'destroyLink'],
    services, context);
  if (head === UNRESOLVED || head === undefined) {
    fail('UStructProperty destructor/constructor-link head (+0x68) is unresolved', {
      operation: 'UStructProperty::DestroyValue', kind: 'StructProperty',
      property: context.property ?? null, slot: '+0x68', value: structure,
    });
  }
  return head === null ? [] : linkedPropertyList(head, services, context);
}

function* linkedPropertyList(head, services, context) {
  const seen = new Set();
  for (let current = head; current !== null && current !== undefined; current = linkedNext(current, services, context)) {
    if (seen.has(current)) {
      fail('UStructProperty destructor child chain is cyclic', {
        operation: 'UStructProperty::DestroyValue', kind: 'StructProperty', slot: '+0x54', value: current,
      });
    }
    seen.add(current);
    yield current;
  }
}

function memberKey(member) {
  const metadata = metadataOf(member);
  return first(member, ['storageKey', 'key', 'name', 'Name', 'fieldName', 'propertyName'],
    first(metadata, ['storageKey', 'key', 'name', 'Name', 'fieldName', 'propertyName'], undefined));
}

function logicalMemberReference(parentRef, member, index, property, details) {
  const value = readReference(parentRef, propertyName(property));
  const container = index === null || index === undefined
    ? value : (Array.isArray(value) ? value[index] : undefined);
  if (container === null || container === undefined || typeof container !== 'object') return null;
  const key = memberKey(member);
  if (key === undefined || key === null || key === '') return null;
  const candidates = [String(key), String(key).split('.').pop()];
  const storageKey = candidates.find(candidate => own(container, candidate));
  if (storageKey === undefined) return null;
  return {
    reference: true,
    key: `${propertyName(property)}${index === null || index === undefined ? '' : `[${index}]`}.${storageKey}`,
    get: () => container[storageKey],
    set: next => { container[storageKey] = next; writeReference(parentRef, value, propertyName(property)); return next; },
    parent: parentRef,
    member,
    index,
    details,
  };
}

function resolveMemberReference(parentRef, member, index, property, details, services) {
  const rawOffset = Object.hasOwn(details, 'memberOffset')
    ? details.memberOffset
    : readSlot(member, O.propertyOffset,
      ['offset', 'propertyOffset', 'Offset'], services, details);
  const offset = rawOffset === UNRESOLVED || rawOffset === undefined || rawOffset === null
    ? null : integer(rawOffset, 'Struct member Offset', {minimum: 0});
  const resolver = services.memberReference ?? services.referenceForMember ?? services.structMemberReference;
  if (typeof resolver === 'function') {
    const resolved = resolver(parentRef, member, {
      ...details, property, member, index,
      offset,
    });
    if (resolved && typeof resolved.get === 'function' && typeof resolved.set === 'function') return resolved;
  }
  const logical = logicalMemberReference(parentRef, member, index, property, details);
  if (logical) return logical;
  fail(`UStructProperty member ${propertyName(member)} storage is unresolved`, {
    operation: 'UStructProperty::DestroyValue', kind: 'StructProperty', property,
    slot: '+0x48', value: member, offset,
  });
}

function destroyStructValue(property, ref, context, services) {
  const structure = structOf(property, services, context);
  const fields = structChildren(structure, services, context);
  const iterator = fields[Symbol.iterator]();
  let current = iterator.next();
  // Core returns immediately when +68 is null, before touching ArrayDim,
  // ElementSize, or the value pointer.  An explicit empty field array carries
  // the same resolved-null meaning at the logical host boundary.
  if (current.done) {
    return {
      property, kind: 'StructProperty', storage: 'untouched',
      arrayDim: null, elementSize: null, fields: 0, elements: [],
    };
  }
  const dimension = arrayDimOf(property, services, context);
  const rootValue = dimension > 0 ? readReference(ref, propertyName(property)) : null;
  const results = [];
  let lastStride = null;
  let fieldCount = 0;
  // This loop order is material: Core loops every ArrayDim slot for one child,
  // then follows +0x54 to the next child (member-major).
  while (!current.done) {
    const member = current.value;
    if (member === null || member === undefined) {
      current = iterator.next();
      continue;
    }
    fieldCount++;
    if (dimension <= 0) {
      current = iterator.next();
      continue;
    }
    // Core reloads the outer ElementSize once for each child, before that
    // child's ArrayDim loop.  Logical keyed storage may leave this unresolved.
    const stride = optionalElementSize(property, services, context, !logicalStorage(rootValue));
    lastStride = stride;
    for (let index = 0; index < dimension; index++) {
      // The native body reloads child Offset on every ArrayDim iteration.
      // Keyed logical structs may leave it unresolved; raw adapters receive
      // the explicit null and must resolve/decline the address themselves.
      const rawOffset = readSlot(member, O.propertyOffset,
        ['offset', 'propertyOffset', 'Offset'], services,
        { ...context, operation: 'UStructProperty::DestroyValue', kind: 'StructProperty', arrayIndex: index });
      const offset = rawOffset === UNRESOLVED || rawOffset === undefined || rawOffset === null
        ? null : integer(rawOffset, 'Struct member Offset', {minimum: 0});
      const itemRef = resolveMemberReference(ref, member, dimension > 1 ? index : null, property, {
        ...context, operation: 'UStructProperty::DestroyValue', member, arrayIndex: index,
        memberOffset: offset,
        addressOffset: stride === null || offset === null ? null : index * stride + offset,
      }, services);
      results.push({member, index, offset, result: destroyScriptProperty(member, itemRef, services, {
        ...context, operation: 'UStructProperty::DestroyValue', member, arrayIndex: index,
        memberOffset: offset,
        addressOffset: stride === null || offset === null ? null : index * stride + offset,
        parentProperty: property,
      })});
    }
    // Read the linked +0x54 only after this child's complete ArrayDim pass.
    current = iterator.next();
  }
  return {
    property, kind: 'StructProperty', storage: 'inline', arrayDim: dimension,
    elementSize: lastStride, fields: fieldCount, elements: results,
  };
}

function destroyFixedArrayValue(property, ref, context, services) {
  // Core checks ArrayCount first and returns without touching the value or
  // Inner when the count is non-positive.
  const count = countOf(property, services, context);
  if (count <= 0) {
    return {
      property, kind: 'FixedArrayProperty', storage: 'untouched',
      arrayCount: count, elementSize: null, elements: [],
    };
  }
  const inner = innerOf(property, services, context, 'UFixedArrayProperty');
  const rootValue = readReference(ref, propertyName(property));
  const shape = fixedArrayRecord(rootValue, 'UFixedArrayProperty');
  let stride = null;
  if (count > 0) {
    stride = shape.native ? optionalElementSize(inner, services, makeContext(context, inner, kindOf(inner, services), {
      operation: 'UFixedArrayProperty::DestroyValue-inner-stride',
    }), true) : optionalElementSize(inner, services, makeContext(context, inner, kindOf(inner, services), {
      operation: 'UFixedArrayProperty::DestroyValue-inner-stride',
    }), false);
  }
  const results = [];
  for (let index = 0; index < count; index++) {
    // Core reloads Inner->ElementSize (+0x38) inside each fixed-array loop.
    if (shape.native) {
      stride = elementSizeOf(inner, services, makeContext(context, inner, kindOf(inner, services), {
        operation: 'UFixedArrayProperty::DestroyValue-inner-stride', arrayIndex: index,
      }));
    }
    const itemRef = resolveElementReference(ref, shape, index, inner, property, {
      ...context, operation: 'UFixedArrayProperty::DestroyValue', kind: 'FixedArrayProperty',
      arrayIndex: index, addressOffset: stride === null ? null : index * stride,
    }, services);
    results.push(destroyScriptProperty(inner, itemRef, services, {
      ...context, operation: 'UFixedArrayProperty::DestroyValue', arrayIndex: index,
      addressOffset: stride === null ? null : index * stride, parentProperty: property,
    }));
  }
  return {
    property, kind: 'FixedArrayProperty', storage: shape.native ? 'native-inline' : 'logical-inline',
    arrayCount: count, elementSize: stride, elements: results,
  };
}

/**
 * Dispatch a linked property through the recovered DestroyValue body.
 *
 * The `reference` argument is intentionally an lvalue (`{get,set}`) at the
 * storage boundary.  Passing a direct value is useful for focused logical
 * tests; its changes are observable through the returned result and through
 * nested mutable records, while callers that own the slot should pass get/set.
 */
export function destroyScriptProperty(property, referenceValue, services = {}, context = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a linked property record');
  if (services === null || typeof services !== 'object') throw new TypeError('DestroyValue services must be an object');
  const kind = kindOf(property, services);
  const ref = reference(referenceValue, propertyName(property));
  const operationContext = makeContext(context, property, kind);
  trace(services, {...context, operation: 'destroy-dispatch', kind, property});

  switch (kind) {
    case 'Property': case 'ByteProperty': case 'IntProperty': case 'BoolProperty':
    case 'FloatProperty': case 'ObjectProperty': case 'ClassProperty': case 'NameProperty':
    case 'MapProperty':
      // The verified base and Map bodies return immediately.  In particular,
      // DestroyValue does not zero scalar/object/map storage.
      trace(services, {...context, operation: 'destroy-noop', kind, property});
      return {property, kind, storage: 'untouched', body: kind === 'MapProperty' ? D.mapProperty.body : D.property.body};
    case 'StrProperty':
      return destroyStringValue(property, ref, operationContext, services);
    case 'ArrayProperty':
      return destroyArrayValue(property, ref, operationContext, services);
    case 'FixedArrayProperty':
      return destroyFixedArrayValue(property, ref, operationContext, services);
    case 'StructProperty':
      return destroyStructValue(property, ref, operationContext, services);
    default:
      fail(`Property DestroyValue does not implement ${kind}`, {
        operation: 'UProperty::DestroyValue', kind, property, slot: '+0x0',
      });
  }
}

export default destroyScriptProperty;
