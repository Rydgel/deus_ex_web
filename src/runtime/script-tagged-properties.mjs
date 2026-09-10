import {
  PROPERTY_MEASURE_ARCHIVE,
  PROPERTY_MEASURE_ARCHIVE_STATE,
  createScriptPropertyMeasureArchive,
} from './script-property-measure-archive.mjs';

/**
 * Collector branch of Core's UStruct::SerializeTaggedProperties.
 *
 * This module follows the native walk at Core 0x10126730.  The byte storage
 * and property virtuals are deliberately adapters: a JS object cannot be
 * treated as a native BYTE* without a linked layout.  A host therefore
 * supplies valueReference/defaultReference (or the property records expose
 * those adapters) when it has that layout.  The walk, default filtering,
 * FPropertyTag construction and the two SerializeItem calls remain here.
 */

export const SCRIPT_TAGGED_PROPERTIES = Object.freeze({
  thunk: 0x10102108,
  body: 0x10126730,
  helper: Object.freeze({ thunk: 0x10102dc9, body: 0x1012aca0 }),
  measureArchive: PROPERTY_MEASURE_ARCHIVE,
  offsets: Object.freeze({
    next: 0x2c,
    children: 0x38,
    name: 0x20,
    propertyFlags: 0x3c,
    arrayDimension: 0x34,
    elementSize: 0x38,
    offset: 0x48,
    propertyClass: 0x24,
    struct: 0x5c,
    boolMask: 0x5c,
    getId: 0x9c,
    identical: 0x6c,
    serializeItem: 0x78,
  }),
  flags: Object.freeze({
    native: 0x00001000,
    transient: 0x00002000,
  }),
  propertyClasses: Object.freeze({
    structProperty: 0x102a3ef0,
    boolProperty: 0x102a6bf0,
  }),
  propertyVtables: Object.freeze({
    BoolProperty: 0x10175c84,
  }),
  tag: Object.freeze({
    type: 0x00,
    typeFlags: 0x01,
    name: 0x04,
    structName: 0x08,
    size: 0x0c,
    arrayIndex: 0x10,
  }),
});

/** Core's collector archive constructor words (FArchive +0x04..+0x24). */
export const TAGGED_GC_ARCHIVE_STATE = PROPERTY_MEASURE_ARCHIVE_STATE;

export class UnsupportedScriptTaggedPropertiesError extends Error {
  constructor(message, { operation = 'UStruct::SerializeTaggedProperties', property = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptTaggedPropertiesError';
    this.code = 'UNSUPPORTED_SCRIPT_TAGGED_PROPERTIES';
    this.operation = operation;
    this.property = property;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptTaggedPropertiesError(message, details);
}

function integer(value, label, { minimum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function first(record, names, fallback = undefined) {
  for (const name of names) {
    if (record !== null && record !== undefined && record[name] !== undefined) return record[name];
  }
  return fallback;
}

function own(record, key) {
  return record !== null && record !== undefined && Object.hasOwn(record, key);
}

function unsigned(value) {
  return Number(value) >>> 0;
}

function archiveState(archive) {
  const state = archive?.archiveState ?? archive;
  for (const key of Object.keys(TAGGED_GC_ARCHIVE_STATE)) {
    if (Number(state?.[key]) !== TAGGED_GC_ARCHIVE_STATE[key]) {
      fail(`Collector SerializeTaggedProperties requires FArchive ${key} == ${TAGGED_GC_ARCHIVE_STATE[key]}`, {
        slot: key,
      });
    }
  }
  return state;
}

function requireArchive(archive) {
  if (!archive || typeof archive !== 'object') {
    throw new TypeError('SerializeTaggedProperties requires an FArchive record');
  }
  if (typeof archive.nameReference !== 'function' && typeof archive.serializeName !== 'function') {
    throw new TypeError('SerializeTaggedProperties requires archive.nameReference/serializeName for NAME_None');
  }
}

function callObjectArchive(archive, reference, context) {
  if (typeof archive.objectReference === 'function') return archive.objectReference.call(archive, reference, context);
  if (typeof archive.serializeObject === 'function') return archive.serializeObject.call(archive, reference, context);
  throw new TypeError('SerializeItem requires archive.objectReference/serializeObject');
}

function callNameArchive(archive, reference, context) {
  if (typeof archive.nameReference === 'function') return archive.nameReference.call(archive, reference, context);
  return archive.serializeName.call(archive, reference, context);
}

function holder(value, label) {
  if (value && typeof value.get === 'function' && typeof value.set === 'function') return value;
  if (value && typeof value === 'object' && own(value, 'value')) {
    return {
      reference: true,
      key: label,
      get: () => value.value,
      set: next => { value.value = next; return next; },
    };
  }
  throw new TypeError(`Expected mutable reference holder for ${label}`);
}

function propertyMetadata(property) {
  return property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
}

function propertyName(property) {
  const metadata = propertyMetadata(property);
  const name = first(property, ['name', 'Name', 'propertyName'],
    first(metadata, ['name', 'Name', 'propertyName'], undefined));
  if (name === undefined) fail('UProperty name (+0x20) is unresolved', { property, slot: '+0x20' });
  return name;
}

function propertyClassName(property) {
  const metadata = propertyMetadata(property);
  return String(first(property, ['className', 'kind', 'propertyClassName'],
    first(metadata, ['className', 'kind', 'propertyClassName'], '')));
}

function propertyType(property) {
  const metadata = propertyMetadata(property);
  return String(first(property, ['type', 'valueType'], first(metadata, ['type', 'valueType'], ''))).toLowerCase();
}

function propertyFlags(property) {
  const metadata = propertyMetadata(property);
  const value = first(property, ['propertyFlags', 'flags', 'PropertyFlags'],
    first(metadata, ['propertyFlags', 'flags', 'PropertyFlags'], undefined));
  if (value === undefined) fail(`PropertyFlags (+0x3c) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x3c',
  });
  return unsigned(value);
}

function propertyLayout(property, services) {
  const metadata = propertyMetadata(property);
  const offsetValue = first(property, ['offset', 'propertyOffset'],
    first(metadata, ['offset', 'propertyOffset'], undefined));
  const sizeValue = first(property, ['elementSize', 'ElementSize'],
    first(metadata, ['elementSize', 'ElementSize'], undefined));
  const dimensionValue = first(property, ['arrayDim', 'arrayDimension', 'ArrayDim'],
    first(metadata, ['arrayDim', 'arrayDimension', 'ArrayDim'], 1));
  const offset = offsetValue == null && typeof services.propertyOffset === 'function'
    ? services.propertyOffset(property) : offsetValue;
  const elementSize = sizeValue == null && typeof services.elementSize === 'function'
    ? services.elementSize(property) : sizeValue;
  if (offset == null) fail(`Property offset (+0x48) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x48',
  });
  if (elementSize == null) fail(`Property ElementSize (+0x38) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x38',
  });
  return {
    offset: integer(offset, 'UProperty offset', { minimum: 0 }),
    elementSize: integer(elementSize, 'UProperty ElementSize', { minimum: 0 }),
    arrayDimension: integer(dimensionValue, 'UProperty ArrayDim', { minimum: 0 }),
  };
}

function isBoolProperty(property, services) {
  if (typeof services.isBoolProperty === 'function') return services.isBoolProperty(property) === true;
  const name = propertyClassName(property).toLowerCase();
  if (name === 'boolproperty' || name === 'bool') return true;
  return Number(property?.nativeVtable) === SCRIPT_TAGGED_PROPERTIES.propertyVtables.BoolProperty;
}

function isStructProperty(property, services) {
  if (typeof services.isStructProperty === 'function') return services.isStructProperty(property) === true;
  const name = propertyClassName(property).toLowerCase();
  return name === 'structproperty' || name === 'struct';
}

function propertyId(property, services) {
  const metadata = propertyMetadata(property);
  const callback = services.getPropertyId ?? services.getID ?? property?.getPropertyId ?? property?.getID ?? property?.getId;
  const supplied = first(property, ['id', 'nativeId', 'typeId', 'propertyId'],
    first(metadata, ['id', 'nativeId', 'typeId', 'propertyId'], undefined));
  const get = () => {
    if (typeof callback === 'function') return callback(property);
    if (supplied !== undefined) return supplied;
    fail(`UProperty GetID (+0x9c) is unresolved for ${String(propertyName(property))}`, {
      property, slot: '+0x9c',
    });
  };
  // Core calls GetID twice while constructing each tag. Keep both calls
  // observable: a host that models the virtual can return different values,
  // although the original classes return the same byte.
  return { first: unsigned(get()) & 0xff, second: unsigned(get()) & 0xff };
}

function propertyStructName(property, services) {
  const metadata = propertyMetadata(property);
  const value = first(property, ['structName', 'StructName'],
    first(metadata, ['structName', 'StructName'], undefined));
  if (value !== undefined) return value;
  const struct = first(property, ['struct', 'structObject', 'structClass', 'structRef'],
    first(metadata, ['struct', 'structObject', 'structClass', 'structRef'], undefined));
  // Core 0x10126d40-0x10126d43 unconditionally dereferences the struct
  // pointer's +0x20 Name after the UStructProperty ancestry check.  A
  // reached UStructProperty therefore needs a valid struct/name binding;
  // an omitted pointer is not the same thing as a real NAME_None index.
  if (struct === undefined || struct === null) {
    fail(`UStructProperty struct (+0x5c) is unresolved for ${String(propertyName(property))}`, {
      property, slot: '+0x5c',
    });
  }
  const name = first(struct, ['name', 'Name', 'friendlyName'], undefined);
  if (name !== undefined) return name;
  if (typeof services.structName === 'function') {
    const resolved = services.structName(struct, property);
    if (resolved !== undefined && resolved !== null) return resolved;
  }
  fail(`UStructProperty struct Name (+0x20) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x20',
  });
}

function defaultStorage(defaultsClass, context) {
  // Native SerializeTaggedProperties reads the comparison buffer from the
  // third argument's +0x4d4/+0x4d8.  The caller's current data is a separate
  // byte storage and must never shadow that buffer.  Runtime class records
  // expose this native pair as defaultBuffer {data,size,capacity}.
  const supplied = defaultsClass?.defaultBuffer ?? defaultsClass?.defaultsBuffer ??
    defaultsClass?.defaults ?? defaultsClass?.Defaults ?? context?.comparisonDefaults ?? null;
  if (supplied && typeof supplied === 'object' &&
      (own(supplied, 'data') || own(supplied, 'size') || own(supplied, 'capacity'))) {
    return {
      data: supplied.data ?? supplied.Data ?? supplied.bytes ?? null,
      size: integer(supplied.size ?? supplied.count ?? supplied.num ?? 0, 'defaults size', { minimum: 0 }),
      capacity: supplied.capacity ?? supplied.max ?? null,
    };
  }
  const data = first(defaultsClass, ['defaultsData', 'defaultData', 'data', 'DefaultsData'], undefined);
  const size = first(defaultsClass, ['defaultsSize', 'defaultSize', 'size', 'DefaultsSize'], undefined);
  if (data !== undefined || size !== undefined) {
    return { data: data ?? null, size: integer(size ?? 0, 'defaults size', { minimum: 0 }), capacity: null };
  }
  return { data: null, size: 0, capacity: null };
}

function storageFallback(data, property, index, label) {
  if (data === null || data === undefined) return null;
  if (data instanceof Map) {
    const key = first(property, ['key', 'name', 'propertyName'], propertyName(property));
    if (!data.has(key)) throw new TypeError(`Missing ${label} storage for ${String(key)}`);
    const value = data.get(key);
    if (Array.isArray(value)) {
      if (index >= value.length) throw new RangeError(`Missing ${label}[${index}] storage for ${String(key)}`);
      return { reference: true, key: `${String(key)}[${index}]`, get: () => value[index], set: next => { value[index] = next; return next; } };
    }
    if (index !== 0) throw new RangeError(`Missing ${label}[${index}] storage for ${String(key)}`);
    return { reference: true, key: String(key), get: () => data.get(key), set: next => { data.set(key, next); return next; } };
  }
  if (typeof data !== 'object') throw new TypeError(`Unsupported ${label} storage representation`);
  const key = first(property, ['key', 'name', 'propertyName'], propertyName(property));
  if (!own(data, key)) throw new TypeError(`Missing ${label} storage for ${String(key)}`);
  const value = data[key];
  if (Array.isArray(value)) {
    if (index >= value.length) throw new RangeError(`Missing ${label}[${index}] storage for ${String(key)}`);
    return { reference: true, key: `${String(key)}[${index}]`, get: () => value[index], set: next => { value[index] = next; return next; } };
  }
  if (index !== 0) throw new RangeError(`Missing ${label}[${index}] storage for ${String(key)}`);
  return { reference: true, key: String(key), get: () => data[key], set: next => { data[key] = next; return next; } };
}

function valueReference(property, data, offset, index, context, services) {
  const callback = services.valueReference ?? services.propertyValueReference ?? property?.valueReference;
  if (typeof callback === 'function') {
    return holder(callback.call(services, property, data, offset, index, context), context.key);
  }
  return holder(storageFallback(data, property, index, 'value'), context.key);
}

function defaultReference(property, defaults, offset, index, context, services) {
  const callback = services.defaultReference ?? services.propertyDefaultReference ?? property?.defaultReference;
  if (typeof callback === 'function') {
    const result = callback.call(services, property, defaults.data, offset, index, context);
    return result === null || result === undefined ? null : holder(result, context.key);
  }
  return storageFallback(defaults.data, property, index, 'default');
}

function directValue(property, reference) {
  return reference === null ? null : reference.get();
}

function defaultComparison(property, value, defaultRef, services, context) {
  const callback = services.identical ?? property?.identical ?? property?.identicalValue;
  if (typeof callback === 'function') {
    return Boolean(callback.call(services, property, value, defaultRef, context));
  }

  const kind = propertyClassName(property).toLowerCase();
  const type = propertyType(property);
  const left = directValue(property, value);
  const right = directValue(property, defaultRef);
  // Pointer Identical implementations compare against a null pointer when
  // the default BYTE* is null.  Numeric properties instead read their native
  // zero value from that null pointer branch.
  const pointerType = kind === 'objectproperty' || kind === 'classproperty' ||
    type === 'object' || type === 'class';
  const zero = right === null ? (pointerType ? null : 0) : right;
  if (kind === 'byteproperty' || type === 'byte') return (Number(left) & 0xff) === (Number(zero) & 0xff);
  if (kind === 'intproperty' || type === 'int') return (Number(left) | 0) === (Number(zero) | 0);
  if (kind === 'floatproperty' || type === 'float') {
    // FFloatProperty::Identical uses x87 FCOMPS and tests C3, making unordered
    // NaNs compare as identical as well as ordinary equal values. FCOMPS sets
    // C3 for unordered when either operand is NaN, including a NaN current
    // value against the null-default zero.
    return Number.isNaN(Number(left)) || Number.isNaN(Number(zero)) || Number(left) === Number(zero);
  }
  if (kind === 'objectproperty' || kind === 'classproperty' || type === 'object' || type === 'class') {
    return left === zero;
  }
  if (kind === 'boolproperty' || type === 'bool') {
    const mask = boolMask(property, services);
    return (unsigned(left) & mask) === (unsigned(zero) & mask);
  }
  if (kind === 'nameproperty' || type === 'name') {
    // FName::Identical compares the name index; a null second pointer is the
    // zero FName. Host names should therefore be canonical numeric/name
    // identities, not merely equal display strings.
    return left === zero;
  }
  fail(`UProperty Identical (+0x6c) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x6c',
  });
}

function boolMask(property, services) {
  const metadata = propertyMetadata(property);
  const mask = first(property, ['boolMask', 'bitMask', 'mask', 'BoolMask'],
    first(metadata, ['boolMask', 'bitMask', 'mask', 'BoolMask'], undefined));
  const value = mask === undefined && typeof services.boolMask === 'function'
    ? services.boolMask(property) : mask;
  if (value === undefined || value === null || unsigned(value) === 0) {
    fail(`UBoolProperty mask (+0x5c) is unresolved for ${String(propertyName(property))}`, {
      property, slot: '+0x5c',
    });
  }
  return unsigned(value);
}

function isBoolSet(property, value, services) {
  const mask = boolMask(property, services);
  const raw = value?.get();
  if (typeof raw === 'boolean') return raw;
  return (unsigned(raw) & mask) !== 0;
}

function sizeClass(size) {
  const count = integer(size, 'measured property size', { minimum: 0 });
  if (count === 1) return 0x00;
  if (count === 2) return 0x10;
  if (count === 4) return 0x20;
  if (count === 0x0c) return 0x30;
  if (count === 0x10) return 0x40;
  if (count <= 0xff) return 0x50;
  if (count <= 0x10000) return 0x60;
  return 0x70;
}

function makeMeasureArchive(archive, services) {
  if (typeof services.makeMeasureArchive === 'function') {
    const result = services.makeMeasureArchive(archive, {
      kind: 'tagged-properties-measure-archive',
      body: SCRIPT_TAGGED_PROPERTIES.measureArchive.constructorBody,
      vtable: SCRIPT_TAGGED_PROPERTIES.measureArchive.vtable,
      archiveState: TAGGED_GC_ARCHIVE_STATE,
      copiedOffsets: [0x10, 0x18],
    });
    if (!result || typeof result !== 'object') throw new TypeError('makeMeasureArchive must return an archive record');
    if (result.bytes === undefined && result.size === undefined) result.bytes = 0;
    return result;
  }
  // Core constructs FArchive (0x10106b30), copies only the caller's +0x10
  // and +0x18 words, and then switches to vtable 0x10177640.  The default
  // adapter follows those exact virtuals; hosts can still override it above
  // when their wrapped archive has a different native representation.
  return createScriptPropertyMeasureArchive(archive);
}

function measuredSize(measureArchive, result, property, reference, context, services) {
  const value = typeof measureArchive.bytes === 'number' ? measureArchive.bytes :
    (typeof measureArchive.size === 'number' ? measureArchive.size : undefined);
  if (value !== undefined) return integer(value, 'measured property size', { minimum: 0 });
  if (typeof result === 'number') return integer(result, 'measured property size', { minimum: 0 });
  if (result && typeof result === 'object') {
    const candidate = result.bytes ?? result.size ?? result.serializedBytes;
    if (candidate !== undefined) return integer(candidate, 'measured property size', { minimum: 0 });
  }
  const callback = services.measurePropertyItem;
  if (typeof callback === 'function') return integer(callback(property, reference, context), 'measured property size', { minimum: 0 });
  fail(`SerializeItem did not expose measured byte count for ${String(propertyName(property))}`, {
    property, slot: 'measure archive Serialize',
  });
}

function invokeItem(property, archive, reference, tag, context, services) {
  const bool = isBoolProperty(property, services);
  const baseContext = {
    ...context,
    body: SCRIPT_TAGGED_PROPERTIES.helper.body,
    helperBody: SCRIPT_TAGGED_PROPERTIES.helper.body,
    property,
    reference,
    tag,
  };
  if (bool) {
    // 0x1012aca0's UBoolProperty branch only updates the value for a loading
    // archive. ar0c is zero here, so it performs no archive operation after
    // asserting the nonzero mask. Keep the helper call visible to callers.
    boolMask(property, services);
    context.helperCalls.push({ kind: 'bool', phase: context.phase, property, tag });
    return archive;
  }

  const callback = services.serializeItem ?? property?.serializeItem ?? property?.serializeValue;
  if (typeof callback === 'function') {
    context.helperCalls.push({ kind: 'serialize-item', phase: context.phase, property, tag });
    return callback.call(services, property, archive, reference, baseContext);
  }

  const kind = propertyClassName(property).toLowerCase();
  const type = propertyType(property);
  if (kind === 'objectproperty' || kind === 'classproperty' || type === 'object' || type === 'class') {
    context.helperCalls.push({ kind: 'serialize-item', phase: context.phase, property, tag, builtin: 'object' });
    return callObjectArchive(archive, reference, baseContext);
  }
  if (kind === 'nameproperty' || type === 'name') {
    context.helperCalls.push({ kind: 'serialize-item', phase: context.phase, property, tag, builtin: 'name' });
    return callNameArchive(archive, reference, baseContext);
  }
  const width = kind === 'byteproperty' || type === 'byte' ? 1 : 4;
  if (kind === 'intproperty' || kind === 'floatproperty' || kind === 'byteproperty' ||
      type === 'int' || type === 'float' || type === 'byte') {
    const raw = archive.serializeRaw;
    context.helperCalls.push({ kind: 'serialize-item', phase: context.phase, property, tag, builtin: 'raw', width });
    if (typeof raw === 'function') return raw.call(archive, reference, width, baseContext);
    // FArchive::Serialize at 0x10106760 is an intentional collector no-op;
    // record the reached raw boundary instead of silently dropping it.
    context.rawCalls.push({ kind: 'raw', phase: context.phase, property, width, skipped: true, tag });
    return archive;
  }
  fail(`UProperty SerializeItem (+0x78) is unresolved for ${String(propertyName(property))}`, {
    property, slot: '+0x78',
  });
}

function childList(current, services) {
  if (typeof services.childrenOf === 'function') {
    const value = services.childrenOf(current);
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (typeof value[Symbol.iterator] === 'function') return [...value];
    return linkedList(value, services, 'children');
  }
  const value = first(current, ['children', 'Children', 'firstChild', 'child'], undefined);
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value[Symbol.iterator] === 'function') return [...value];
  return linkedList(value, services, 'children');
}

function nextField(field, services) {
  if (typeof services.nextOf === 'function') return services.nextOf(field);
  return first(field, ['next', 'Next', 'nextField', 'nextProperty'], null);
}

function linkedList(head, services, label) {
  const list = [];
  const seen = new Set();
  for (let field = head; field !== null && field !== undefined; field = nextField(field, services)) {
    if (seen.has(field)) throw new Error(`Cyclic UField ${label} chain`);
    seen.add(field);
    list.push(field);
  }
  return list;
}

function inheritanceSuper(current, services) {
  if (typeof services.inheritanceSuper === 'function') return services.inheritanceSuper(current);
  if (typeof current?.getInheritanceSuper === 'function') return current.getInheritanceSuper();
  return first(current, ['superStruct', 'superClass', 'superclass', 'baseClass', 'super', 'base'], null);
}

function isProperty(field, services) {
  if (typeof services.isProperty === 'function') return services.isProperty(field) === true;
  if (field?.isProperty === true) return true;
  const name = propertyClassName(field).toLowerCase();
  return name.endsWith('property') || field?.kind === 'property';
}

function walkProperties(structure, services) {
  if (typeof services.walkProperties === 'function') {
    const value = services.walkProperties(structure, {
      body: SCRIPT_TAGGED_PROPERTIES.body,
      operation: 'UStruct::SerializeTaggedProperties',
    });
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [...value];
  }
  if (!structure || typeof structure !== 'object') throw new TypeError('Expected current UStruct record');
  const result = [];
  const seenStructs = new Set();
  for (let current = structure; current !== null && current !== undefined; current = inheritanceSuper(current, services)) {
    if (seenStructs.has(current)) throw new Error('Cyclic UStruct inheritance chain');
    seenStructs.add(current);
    for (const field of childList(current, services)) if (isProperty(field, services)) result.push(field);
  }
  return result;
}

function currentDefaultsClass(defaultsClass, context) {
  if (defaultsClass !== undefined && defaultsClass !== null) return defaultsClass;
  return context?.defaultsClass ?? context?.superClass ?? context?.baseClass ?? null;
}

function emitTerminator(archive, services, context) {
  const none = services.noneName ?? archive.noneName ?? 0;
  const reference = holder({ value: none }, 'SerializeTaggedProperties.None');
  const descriptor = {
    kind: 'tagged-properties-terminator',
    key: 'None',
    body: SCRIPT_TAGGED_PROPERTIES.body,
    reference,
  };
  context.events.push(descriptor);
  callNameArchive(archive, reference, descriptor);
  return reference;
}

/**
 * Replays the collector branch of Core's 0x10126730 body.
 *
 * `structure` is the UStruct whose Children chain is walked. `data` is the
 * current defaults byte storage in the native call. `defaultsClass` is the
 * third native argument (normally the superclass UClass), whose +0x4d4/+0x4d8
 * storage supplies comparison defaults. `services` may provide:
 *
 * - `walkProperties(structure)` or `childrenOf`, `nextOf`,
 *   `inheritanceSuper` to bind the native field graph;
 * - `valueReference(property,data,offset,index,context)` and
 *   `defaultReference(property,defaultsData,offset,index,context)`;
 * - `getPropertyId`, `identical`, `serializeItem`, and optionally
 *   `makeMeasureArchive` (the source-backed FArchive measure adapter is used
 *   when no override is supplied);
 * - `noneName` for the registry's actual FName index-zero entry.
 */
export function serializeTaggedPropertiesGc(structure, archive, data, defaultsClass = null, services = {}) {
  requireArchive(archive);
  const state = archiveState(archive);
  if (!structure || typeof structure !== 'object') throw new TypeError('Expected a UStruct record');
  const defaults = defaultStorage(defaultsClass, services);
  const properties = walkProperties(structure, services);
  const context = {
    operation: 'UStruct::SerializeTaggedProperties',
    body: SCRIPT_TAGGED_PROPERTIES.body,
    archive,
    archiveState: state,
    structure,
    data,
    defaultsClass,
    defaults,
    events: [],
    helperCalls: [],
    rawCalls: [],
    identicalCalls: [],
    properties: [],
    skipped: [],
  };

  for (const property of properties) {
    const flags = propertyFlags(property);
    if ((flags & SCRIPT_TAGGED_PROPERTIES.flags.native) !== 0) {
      context.skipped.push({ property, reason: 'native', flags });
      continue;
    }
    if ((flags & SCRIPT_TAGGED_PROPERTIES.flags.transient) !== 0 && Number(state.ar18) !== 0) {
      context.skipped.push({ property, reason: 'transient', flags });
      continue;
    }
    const layout = propertyLayout(property, services);
    const name = propertyName(property);
    const bool = isBoolProperty(property, services);
    const type = propertyType(property);
    for (let index = 0; index < layout.arrayDimension; index++) {
      const valueOffset = layout.offset + layout.elementSize * index;
      // Native tests the current data pointer after computing the offset; a
      // null BYTE* skips the element and proceeds to the next ArrayDim slot.
      if (data === null || data === undefined) {
        context.skipped.push({ property, index, reason: 'null-data', offset: valueOffset });
        continue;
      }
      const itemContext = {
        ...context,
        property,
        name,
        type,
        flags,
        arrayIndex: index,
        offset: valueOffset,
        key: `${String(name)}[${index}]`,
      };
      const value = valueReference(property, data, valueOffset, index, itemContext, services);
      const defaultInRange = defaults.data !== null && defaults.data !== undefined &&
        valueOffset + layout.elementSize <= defaults.size;
      const comparison = defaultInRange
        ? defaultReference(property, defaults, valueOffset, index, itemContext, services)
        : null;
      const identical = defaultComparison(property, value, comparison, services, itemContext);
      context.identicalCalls.push({ property, index, offset: valueOffset, value, defaultReference: comparison, identical });
      if (identical) {
        context.skipped.push({ property, index, reason: 'identical', offset: valueOffset });
        continue;
      }

      const ids = propertyId(property, services);
      const tag = {
        type: ids.first,
        typeFlags: ids.second,
        name,
        structName: isStructProperty(property, services) ? propertyStructName(property, services) : 0,
        size: 0,
        arrayIndex: index,
        // Native local record fields are retained under both names so a host
        // can inspect the exact FPropertyTag layout without byte packing.
        bytes: new Uint8Array(0x14),
      };
      context.events.push({ kind: 'tag', property, index, offset: valueOffset, tag });

      const measureArchive = makeMeasureArchive(archive, services);
      const measureContext = { ...itemContext, phase: 'measure', tag, measureArchive };
      const measureResult = invokeItem(property, measureArchive, value, tag, {
        ...context,
        helperCalls: context.helperCalls,
        rawCalls: context.rawCalls,
        phase: 'measure',
      }, services);
      tag.size = measuredSize(measureArchive, measureResult, property, value, measureContext, services);
      tag.typeFlags = (tag.typeFlags | sizeClass(tag.size)) & 0xff;
      if (bool && isBoolSet(property, value, services)) tag.typeFlags |= 0x80;
      if (index !== 0) tag.typeFlags |= 0x80;

      const realContext = { ...itemContext, phase: 'collector', tag, measureArchive };
      invokeItem(property, archive, value, tag, {
        ...context,
        helperCalls: context.helperCalls,
        rawCalls: context.rawCalls,
        phase: 'collector',
      }, services);
      context.properties.push({ property, index, offset: valueOffset, value, defaultReference: comparison, tag });
    }
  }

  const terminator = emitTerminator(archive, services, context);
  return {
    body: SCRIPT_TAGGED_PROPERTIES.body,
    archiveState: state,
    structure,
    defaultsClass,
    defaults,
    properties: context.properties,
    skipped: context.skipped,
    identicalCalls: context.identicalCalls,
    events: context.events,
    helperCalls: context.helperCalls,
    rawCalls: context.rawCalls,
    terminator,
  };
}

/** Adapter matching UClass::Serialize's callback shape. */
export function serializeTaggedProperties(archive, data, defaultsClass, context = {}) {
  const structure = context.object ?? context.structure ?? context.struct;
  const services = context.services ?? {};
  return serializeTaggedPropertiesGc(structure, archive, data, defaultsClass ?? context.defaultsClass, services);
}

export const serializeUStructTaggedProperties = serializeTaggedPropertiesGc;
