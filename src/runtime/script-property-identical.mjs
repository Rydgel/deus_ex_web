/**
 * Complex UProperty::Identical virtuals (+0x6c) from the installed GOTY
 * Core.dll.
 *
 * The simple bodies (Byte/Int/Float/Bool/Name/Object/Class) are already
 * checked inline by src/runtime/script-tagged-properties.mjs.  This module
 * translates the five complex bodies the tagged-property walker previously
 * reported as an unsupported `+0x6c` boundary:
 *
 * | Body | Address |
 * | --- | --- |
 * | UStrProperty::Identical | 0x101676f0 |
 * | UArrayProperty::Identical | 0x10168480 |
 * | UFixedArrayProperty::Identical | 0x10167d30 |
 * | UMapProperty::Identical | 0x10168d80 |
 * | UStructProperty::Identical | 0x101690d0 |
 *
 * The native signature is `int Identical(const void* A, const void* B)` where
 * `A` is the current value pointer and `B` is the comparison default.  `B`
 * may be null; `A` is always dereferenced.  Each body reads the values through
 * the property's own layout (FString/TArray headers, Inner stride, the inner
 * struct's property tree), so the JavaScript translation works on the runtime's
 * logical values and mirrors the byte walks.
 */

export const SCRIPT_PROPERTY_IDENTICAL = Object.freeze({
  strProperty: Object.freeze({ kind: 'StrProperty', body: 0x101676f0 }),
  arrayProperty: Object.freeze({ kind: 'ArrayProperty', body: 0x10168480 }),
  fixedArrayProperty: Object.freeze({ kind: 'FixedArrayProperty', body: 0x10167d30 }),
  mapProperty: Object.freeze({ kind: 'MapProperty', body: 0x10168d80 }),
  structProperty: Object.freeze({ kind: 'StructProperty', body: 0x101690d0 }),
  // The string-literal addresses used by UStrProperty::Identical.  Both sit in
  // the file-backed zero-filled tail of Core's packed .data, so the installed
  // image provides the empty string at each; the emulator observes zero words.
  // The packed runtime content is unverified.
  literals: Object.freeze({
    empty: Object.freeze({ address: 0x101ef654, text: '' }),
    none: Object.freeze({ address: 0x102a7fe8, text: '' }),
  }),
  offsets: Object.freeze({
    // FString: Data, ArrayMax, ArrayNum.  The bodies test +0x4 (ArrayMax) to
    // detect the empty string.
    fStringData: 0x00, fStringArrayMax: 0x04,
    // TArray: Data, ArrayNum, ArrayMax.  The count read is +0x4 (ArrayNum).
    arrayData: 0x00, arrayNum: 0x04,
    // Fixed array count and the inner property reference.
    arrayCount: 0x60, inner: 0x5c,
    // Struct property inner struct reference.
    struct: 0x5c,
    // UStruct fields used by the struct walker.
    children: 0x38, next: 0x2c, arrayDim: 0x34, elementSize: 0x38, offset: 0x48,
  }),
});

export class UnsupportedScriptPropertyIdenticalError extends Error {
  constructor(message, {
    operation = 'UProperty::Identical', kind = null, property = null, slot = null,
  } = {}) {
    super(message);
    this.name = 'UnsupportedScriptPropertyIdenticalError';
    this.code = 'UNSUPPORTED_SCRIPT_PROPERTY_IDENTICAL';
    this.operation = operation;
    this.kind = kind;
    this.property = property;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptPropertyIdenticalError(message, details);
}

function first(record, names, fallback = undefined) {
  for (const name of names) {
    if (record !== null && record !== undefined && record[name] !== undefined) return record[name];
  }
  return fallback;
}

function kindOf(property) {
  const value = first(property, ['nativeKind', 'kind'], undefined);
  switch (value) {
    case 'UStrProperty': return 'StrProperty';
    case 'UArrayProperty': return 'ArrayProperty';
    case 'UFixedArrayProperty': return 'FixedArrayProperty';
    case 'UMapProperty': return 'MapProperty';
    case 'UStructProperty': return 'StructProperty';
    default: return value;
  }
}

function integer(value, label, { minimum = 0, maximum = 0x7fffffff } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

/** Case-insensitive equality matching the recovered appStricmp usage. */
function appStricmpEqual(a, b) {
  return foldAscii(String(a)) === foldAscii(String(b));
}

function foldAscii(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += String.fromCharCode(code >= 0x61 && code <= 0x7a ? code - 0x20 : code);
  }
  return out;
}

function propertyName(property) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  return String(first(property, ['key', 'name', 'Name', 'propertyName'],
    first(metadata, ['key', 'name', 'Name', 'propertyName'], '<property>')));
}

function arrayDimOf(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.arrayDim ?? services?.propertyArrayDim;
  if (typeof callback === 'function') return integer(callback(property), 'property ArrayDim', { minimum: 0 });
  return integer(first(property, ['arrayDim', 'arrayDimension', 'ArrayDim'],
    first(metadata, ['arrayDim', 'arrayDimension', 'ArrayDim'], 1)), 'property ArrayDim', { minimum: 0 });
}

function arrayCountOf(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.arrayCount ?? services?.propertyArrayCount;
  if (typeof callback === 'function') return integer(callback(property), 'fixed array count', { minimum: 0 });
  return integer(first(property, ['arrayCount', 'fixedArraySize', 'fixedArrayDimension', 'count'],
    first(metadata, ['arrayCount', 'fixedArraySize', 'fixedArrayDimension', 'count'], 0)), 'fixed array count', { minimum: 0 });
}

function innerOf(property, services, label) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.innerProperty;
  if (typeof callback === 'function') {
    const value = callback(property);
    if (value === null || value === undefined) fail(`${label} property Inner (+0x5c) is unresolved`, { kind: kindOf(property), property, slot: '+0x5c' });
    return value;
  }
  const value = first(property, ['inner', 'innerProperty', 'innerMetadata', 'child'],
    first(metadata, ['inner', 'innerProperty', 'innerMetadata', 'child'], null));
  if (value === null || value === undefined) fail(`${label} property Inner (+0x5c) is unresolved`, { kind: kindOf(property), property, slot: '+0x5c' });
  // The inner is a full property record; hosts that store raw metadata instead
  // still carry kind/nativeKind at the top level, so never unwrap `.metadata`.
  return value;
}

function structOf(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.innerStruct;
  if (typeof callback === 'function') {
    const value = callback(property);
    if (value === null || value === undefined) fail('UStructProperty inner Struct (+0x5c) is unresolved', { kind: 'StructProperty', property, slot: '+0x5c' });
    return value;
  }
  const value = first(property, ['struct', 'structObject', 'structClass', 'structRef', 'innerStruct'],
    first(metadata, ['struct', 'structObject', 'structClass', 'structRef', 'innerStruct'], null));
  if (value === null || value === undefined) fail('UStructProperty inner Struct (+0x5c) is unresolved', { kind: 'StructProperty', property, slot: '+0x5c' });
  return value;
}

function requireObject(value, label) {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new TypeError(`Expected ${label} value, got ${String(value)}`);
  }
  return value;
}

/** Logical current/default string pair for UStrProperty::Identical. */
function strPair(value, defaultValue) {
  // Native A is dereferenced unconditionally; B may be null.  A null default
  // compares against the literal at 0x102a7fe8, which the installed file image
  // provides as the empty string (unverified packed runtime content).
  if (value === null || value === undefined) {
    fail('UStrProperty::Identical requires a non-null current FString', { kind: 'StrProperty' });
  }
  const a = String(value);
  const b = defaultValue === null || defaultValue === undefined ? '' : String(defaultValue);
  return { a, b };
}

function arrayShape(value, label) {
  if (value === null || value === undefined) {
    // UArrayProperty::Identical treats a null current array as empty.
    return { data: [], arrayNum: 0 };
  }
  if (Array.isArray(value)) return { data: value, arrayNum: value.length };
  const record = requireObject(value, label);
  const data = Array.isArray(record.data ?? record.Data) ? (record.data ?? record.Data) : null;
  const arrayNum = Number(record.arrayNum ?? record.ArrayNum ?? (data ? data.length : 0));
  if (data === null) fail(`TArray Data (+0x0) is unresolved for ${label}`, { kind: 'ArrayProperty' });
  return { data, arrayNum: integer(arrayNum, `${label} ArrayNum`, { minimum: 0 }) };
}

function requireValueArray(value, label) {
  if (value === null || value === undefined || !Array.isArray(value)) {
    throw new TypeError(`Expected ${label} fixed-array value array, got ${String(value)}`);
  }
  return value;
}

/** UStrProperty::Identical: appStricmp(*A, *B) == 0 with the empty idioms. */
export function identicalStr(value, defaultValue) {
  const { a, b } = strPair(value, defaultValue);
  return appStricmpEqual(a, b);
}

/** UMapProperty::Identical: the body at 0x10168d80 returns 1 unconditionally. */
export function identicalMap() {
  return true;
}

/**
 * UFixedArrayProperty::Identical (0x10167d30): Inner->Identical for each of
 * `count` elements.  A null default passes null element pointers, exactly as
 * the native `B != null ? B + i*size : null` branch does.
 */
export function identicalFixedArray(property, value, defaultValue, services = {}) {
  const count = arrayCountOf(property, services);
  if (count <= 0) return true;
  const inner = innerOf(property, services, 'UFixedArrayProperty');
  const values = requireValueArray(value, 'current');
  const defaults = defaultValue === null || defaultValue === undefined ? null : requireValueArray(defaultValue, 'default');
  for (let i = 0; i < count; i++) {
    const current = values[i];
    const fallback = defaults === null ? null : defaults[i];
    if (!identicalScriptProperty(inner, current, fallback, services)) return false;
  }
  return true;
}

/**
 * UArrayProperty::Identical (0x10168480): equal ArrayNum first, then
 * Inner->Identical for each element.  A null current value is an empty array;
 * the default TArray is dereferenced unconditionally, so a null default is an
 * explicit unsupported error.
 */
export function identicalArray(property, value, defaultValue, services = {}) {
  if (defaultValue === null || defaultValue === undefined) {
    fail('UArrayProperty::Identical requires a non-null default TArray', { kind: 'ArrayProperty' });
  }
  const inner = innerOf(property, services, 'UArrayProperty');
  const current = arrayShape(value, 'current');
  const fallback = arrayShape(defaultValue, 'default');
  if (current.arrayNum !== fallback.arrayNum) return false;
  for (let i = 0; i < current.arrayNum; i++) {
    if (!identicalScriptProperty(inner, current.data[i], fallback.data[i], services)) return false;
  }
  return true;
}

function isUProperty(field, services) {
  if (typeof services.isUProperty === 'function') return services.isUProperty(field) === true;
  if (typeof services.isProperty === 'function') return services.isProperty(field) === true;
  if (field?.isProperty === true) return true;
  const value = String(first(field, ['className', 'kind', 'propertyClassName'],
    first(field?.metadata, ['className', 'kind', 'propertyClassName'], ''))).toLowerCase();
  return value.endsWith('property');
}

function nextOf(field, services) {
  if (typeof services.nextOf === 'function') return services.nextOf(field);
  return first(field, ['next', 'Next', 'nextField', 'nextProperty'], null);
}

function childrenOf(structure, services) {
  if (typeof services.childrenOf === 'function') return services.childrenOf(structure);
  return first(structure, ['children', 'Children', 'firstChild', 'child'], null);
}

function superOf(structure, services) {
  if (typeof services.inheritanceSuper === 'function') return services.inheritanceSuper(structure);
  if (typeof structure?.getInheritanceSuper === 'function') return structure.getInheritanceSuper();
  return first(structure, ['superStruct', 'superClass', 'superclass', 'baseClass', 'super', 'base'], null);
}

/**
 * The native UStructProperty::Identical walker: every UProperty child of the
 * inner struct and its supers (via GetInheritanceSuper, vtable +0x68), with
 * each child's ArrayDim elements compared through the child +0x6c virtual.
 */
export function structProperties(structure, services = {}) {
  if (typeof services.structProperties === 'function') {
    const value = services.structProperties(structure);
    return value === null || value === undefined ? [] : Array.from(value);
  }
  const list = [];
  const seenStructs = new Set();
  for (let current = structure; current !== null && current !== undefined; current = superOf(current, services)) {
    if (seenStructs.has(current)) throw new Error('Cyclic UStruct inheritance chain');
    seenStructs.add(current);
    const seenFields = new Set();
    const fields = childrenOf(current, services);
    if (Array.isArray(fields)) {
      for (const field of fields) {
        if (field === null || field === undefined) continue;
        if (seenFields.has(field)) throw new Error('Cyclic UField Next chain');
        seenFields.add(field);
        if (isUProperty(field, services)) list.push(field);
      }
      continue;
    }
    for (let field = fields; field !== null && field !== undefined; field = nextOf(field, services)) {
      if (seenFields.has(field)) throw new Error('Cyclic UField Next chain');
      seenFields.add(field);
      if (isUProperty(field, services)) list.push(field);
    }
  }
  return list;
}

function memberKey(child, services) {
  const callback = services?.memberKey;
  if (typeof callback === 'function') return String(callback(child));
  const metadata = child?.metadata && typeof child.metadata === 'object' ? child.metadata : child;
  return String(first(child, ['key', 'name', 'Name', 'propertyName'],
    first(metadata, ['key', 'name', 'Name', 'propertyName'], propertyName(child))));
}

function memberValue(structValue, child, i, dim, services) {
  if (structValue === null || structValue === undefined || typeof structValue !== 'object') {
    throw new TypeError('UStructProperty::Identical requires an object current value');
  }
  const key = memberKey(child, services);
  const whole = structValue[key];
  if (whole === undefined) fail(`UStructProperty member ${key} is unresolved in the current value`, {
    kind: 'StructProperty', property: child,
  });
  return dim > 1 ? whole[i] : whole;
}

/** UStructProperty::Identical (0x101690d0). */
export function identicalStruct(property, value, defaultValue, services = {}) {
  const structure = structOf(property, services);
  const fields = structProperties(structure, services);
  for (const child of fields) {
    const dim = arrayDimOf(child, services);
    if (dim <= 0) continue;
    for (let i = 0; i < dim; i++) {
      const current = memberValue(value, child, i, dim, services);
      const fallback = defaultValue === null || defaultValue === undefined
        ? null
        : memberValue(defaultValue, child, i, dim, services);
      if (!identicalScriptProperty(child, current, fallback, services)) return false;
    }
  }
  return true;
}

/**
 * Dispatch the complex property +0x6c virtual by the property's verified kind.
 * Simple kinds are not this module's boundary; a reached scalar/name/object
 * kind is an explicit caller error rather than a silent guess.
 */
export function identicalScriptProperty(property, value, defaultValue, services = {}) {
  switch (kindOf(property)) {
    case 'StrProperty': return identicalStr(value, defaultValue);
    case 'MapProperty': return identicalMap();
    case 'FixedArrayProperty': return identicalFixedArray(property, value, defaultValue, services);
    case 'ArrayProperty': return identicalArray(property, value, defaultValue, services);
    case 'StructProperty': return identicalStruct(property, value, defaultValue, services);
    default:
      fail(`UProperty::Identical (+0x6c) does not dispatch ${String(kindOf(property))}; scalar/name/object kinds are handled by the tagged-property walker`, {
        kind: kindOf(property), property, slot: '+0x6c',
      });
  }
}

export default identicalScriptProperty;