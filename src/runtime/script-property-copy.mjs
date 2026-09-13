/** Original Core.dll property value copies; see docs/script-property-copy.md.
 * Cursors address native byte storage. Heap ownership requires explicit services;
 * logical VM strings/objects are not treated as native pointers. */

export class UnsupportedScriptPropertyCopyError extends Error {
  constructor(message, {property = null, slot = null} = {}) {
    super(message);
    this.name = 'UnsupportedScriptPropertyCopyError';
    this.code = 'UNSUPPORTED_SCRIPT_PROPERTY_COPY';
    this.property = property;
    this.slot = slot;
  }
}

const fail = (message, property, slot) => {
  throw new UnsupportedScriptPropertyCopyError(message, {property, slot});
};

function slot(property, offset, aliases, services) {
  if (services.readSlot) {
    const value = services.readSlot(property, offset);
    if (value !== undefined) return value;
  }
  if (property?.nativeSlots?.has(offset)) {
    const value = property.nativeSlots.get(offset);
    return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
  }
  for (const source of [property, property?.metadata]) {
    for (const name of aliases) if (source?.[name] !== undefined) return source[name];
  }
  fail(`Property copy requires linked +0x${offset.toString(16)}`, property, offset);
}

function count(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw new RangeError(`Invalid property copy ${label}: ${String(value)}`);
  return value;
}

const dimension = (property, services) => {
  const value = slot(property, 0x34, ['arrayDim', 'arrayDimension'], services);
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw new RangeError('Property copy ArrayDim is not an INT');
  return value;
};
const stride = (property, services) => count(slot(property, 0x38, ['elementSize'], services), 'ElementSize');
const at = (cursor, offset) => cursor == null && offset === 0 ? null
  : ({bytes: cursor?.bytes, offset: (cursor?.offset ?? 0) + offset});

function view(cursor, size) {
  const bytes = cursor?.bytes, offset = cursor?.offset ?? 0;
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.byteLength)
    throw new RangeError('Property copy cursor exceeds its native byte storage');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
}

/** Forward x86 rep movsl/movsb; preserve word-at-a-time overlapping copies. */
function copyBytes(destination, source, bytes) {
  if (!bytes) return;
  const from = view(source, bytes), to = view(destination, bytes);
  let i = 0;
  for (; i + 4 <= bytes; i += 4) to.setUint32(i, from.getUint32(i, true), true);
  for (; i < bytes; i++) to.setUint8(i, from.getUint8(i));
}

/** UProperty::CopySingleValue, 0x10165560. */
export function copyGenericSingleValue(property, destination, source, services = {}) {
  copyBytes(destination, source, stride(property, services));
}

/** UProperty::CopyCompleteValue, 0x10165600; each +0x8c call can mutate metadata. */
export function copyGenericCompleteValue(property, destination, source, services = {}) {
  for (let i = 0; i < dimension(property, services); i++) {
    const offset = i * stride(property, services);
    const copy = services.copySingleValue ?? copySinglePropertyValue;
    copy(property, at(destination, offset), at(source, offset), services);
  }
}

export const SCRIPT_PROPERTY_COPY = Object.freeze({
  Property: {vtable: 0x10175a44, single: 0x10165560, complete: 0x10165600},
  ByteProperty: {vtable: 0x10175b04, single: 0x10165790, complete: 0x101657a0},
  IntProperty: {vtable: 0x10175bc4, single: 0x10165d00, complete: 0x10165d10},
  BoolProperty: {vtable: 0x10175c84, single: 0x101665f0, complete: 0x10165600},
  FloatProperty: {vtable: 0x10175d44, single: 0x10166740, complete: 0x10166750},
  ObjectProperty: {vtable: 0x10175e04, single: 0x10166b30, complete: 0x10166b40},
  ClassProperty: {vtable: 0x10175ec4, single: 0x10166b30, complete: 0x10166b40},
  NameProperty: {vtable: 0x10175f84, single: 0x101672f0, complete: 0x10167300},
  StrProperty: {vtable: 0x10176044, single: 0x10167b30, complete: 0x10165600},
  FixedArrayProperty: {vtable: 0x10176104, single: 0x10168290, complete: 0x10165600},
  ArrayProperty: {vtable: 0x101761c4, single: 0x10168a70, complete: 0x10165600},
  MapProperty: {vtable: 0x10176284, single: 0x10168f40, complete: 0x10165600},
  StructProperty: {vtable: 0x10176344, single: 0x10169c40, complete: 0x10165600},
});
const DWORD_KINDS = new Set(['IntProperty', 'FloatProperty', 'ObjectProperty', 'ClassProperty', 'NameProperty']);

function propertyKind(property, services) {
  const supplied = property?.nativeKind ?? property?.kind ?? property?.metadata?.className;
  const kind = supplied?.startsWith('U') ? supplied.slice(1) : supplied;
  const raw = property?.nativeSlots?.get(0);
  const vtable = services.readSlot?.(property, 0) ?? raw?.value ?? raw ?? property?.nativeVtable ?? property?.vtable;
  if (vtable !== undefined && vtable !== null) {
    const entry = Object.entries(SCRIPT_PROPERTY_COPY).find(([, record]) => record.vtable === vtable);
    if (!entry || (kind && kind !== entry[0])) fail('Property copy has an unverified native vtable/class', property, 0);
    return entry[0];
  }
  if (!SCRIPT_PROPERTY_COPY[kind]) fail('Property copy native class is not bound', property, 0);
  return kind;
}

const word = cursor => view(cursor, 4).getUint32(0, true);
const putWord = (cursor, value) => view(cursor, 4).setUint32(0, value, true);
const sameAddress = (a, b) => a?.bytes?.buffer === b?.bytes?.buffer &&
  a?.bytes && b?.bytes && a.bytes.byteOffset + (a.offset ?? 0) === b.bytes.byteOffset + (b.offset ?? 0);

function pointed(cursor, bytes, services, property) {
  const pointer = word(cursor);
  if (!services.resolvePointer) fail('Property copy requires native heap pointer resolution', property, 'heap');
  const result = services.resolvePointer(pointer, bytes);
  view(result, bytes);
  return result;
}

/** UStrProperty::CopySingleValue, 0x10167b30 (inlined FString assignment). */
function copyString(property, destination, source, services) {
  if (sameAddress(destination, source)) return;
  if (!services.reallocateArray) fail('FString copy requires FArray::Realloc', property, 'FArray::Realloc');
  const sourceCount = word(at(source, 4));
  putWord(at(destination, 8), sourceCount);
  putWord(at(destination, 4), sourceCount);
  services.reallocateArray(destination, 2);
  const bytes = word(at(destination, 4)) * 2;
  if (!bytes) return;
  const from = sourceCount ? pointed(source, bytes, services, property)
    : services.resolvePointer?.(0x101ef654, bytes);
  if (!from) fail('FString copy requires the native empty literal', property, 0x101ef654);
  copyBytes(pointed(destination, bytes, services, property), from, bytes);
}

const innerProperty = (property, services) => slot(property, 0x5c,
  ['inner', 'innerProperty', 'innerMetadata'], services);
const copyCompleteChild = (property, destination, source, services) =>
  (services.copyCompleteValue ?? copyCompletePropertyValue)(property, destination, source, services);

/** UFixedArrayProperty::CopySingleValue 10168290 caches Count and Inner. */
function copyFixedArray(property, destination, source, services) {
  const length = slot(property, 0x60, ['count', 'arrayCount', 'fixedArraySize', 'fixedArrayDimension'], services);
  if (length <= 0) return;
  count(length, 'fixed-array count');
  const inner = innerProperty(property, services);
  for (let i = 0; i < length; i++) {
    const from = source == null ? null : at(source, i * stride(inner, services));
    const to = at(destination, i * stride(inner, services));
    copyCompleteChild(inner, to, from, services);
  }
}

/** UArrayProperty::CopySingleValue 10168a70. This body has no self-copy guard
 * and does not destroy old elements before its FArray resize. */
function copyArray(property, destination, source, services) {
  const inner = innerProperty(property, services), size = stride(inner, services);
  const length = count(word(at(source, 4)), 'source TArray Num');
  if (!services.reallocateArray) fail('Array copy requires FArray::Realloc', property, 'FArray::Realloc');
  putWord(at(destination, 4), 0);
  putWord(at(destination, 8), length);
  services.reallocateArray(destination, size);
  const owning = Boolean(slot(inner, 0x3c, ['propertyFlags', 'flags'], services) & 0x400000);
  const start = word(at(destination, 4)), total = start + length;
  putWord(at(destination, 4), total);
  if (total > word(at(destination, 8))) {
    putWord(at(destination, 8), total + Math.trunc(3 * total / 8) + 32);
    services.reallocateArray(destination, size);
  }
  if (!owning) {
    if (length) copyBytes(pointed(destination, length * size, services, property),
      pointed(source, length * size, services, property), length * size);
    return;
  }
  if (length * size) {
    const zero = at(pointed(destination, total * size, services, property), start * size);
    view(zero, length * size);
    zero.bytes.fill(0, zero.offset, zero.offset + length * size);
  }
  const iterations = word(at(destination, 4));
  if (!iterations) return;
  const to = pointed(destination, iterations * size, services, property);
  const from = pointed(source, iterations * size, services, property);
  const currentInner = innerProperty(property, services);
  for (let i = 0; i < iterations; i++) copyCompleteChild(currentInner, at(to, i * size), at(from, i * size), services);
}

/** Original TFieldIterator<UProperty> traversal: children first, then Super;
 * Next is read only after the copy callback has returned. */
function* structProperties(struct, services) {
  const seen = new Set();
  while (struct) {
    if (seen.has(struct)) throw new Error('Cyclic native struct inheritance');
    seen.add(struct);
    let field = slot(struct, 0x38, ['children'], services);
    const fields = new Set();
    while (field) {
      if (fields.has(field)) throw new Error('Cyclic native struct child chain');
      fields.add(field);
      let isProperty;
      if (services.isProperty) isProperty = services.isProperty(field);
      else {
        const kind = field?.nativeKind ?? field?.kind ?? field?.metadata?.className;
        if (['Function', 'State', 'Enum', 'Const', 'Class', 'Struct'].includes(kind)) isProperty = false;
        else { propertyKind(field, services); isProperty = true; }
      }
      if (isProperty) yield field;
      field = slot(field, 0x2c, ['next', 'nextField'], services);
    }
    const getSuper = services.getInheritanceSuper ?? services.getSuperStruct;
    if (!getSuper) fail('Struct copy requires native GetInheritanceSuper dispatch', struct, 'GetInheritanceSuper');
    struct = getSuper(struct);
  }
}

/** UStructProperty::CopySingleValue 10169c40 copies fields, leaving padding. */
function copyStruct(property, destination, source, services) {
  const struct = slot(property, 0x5c, ['struct', 'innerStruct'], services);
  if (!struct) return;
  const fields = services.structProperties ? services.structProperties(struct) : structProperties(struct, services);
  for (const field of fields) {
    const from = at(source, count(slot(field, 0x48, ['offset', 'propertyOffset'], services), 'member offset'));
    const to = at(destination, count(slot(field, 0x48, ['offset', 'propertyOffset'], services), 'member offset'));
    copyCompleteChild(field, to, from, services);
  }
}

export function copySinglePropertyValue(property, destination, source, services = {}) {
  const kind = propertyKind(property, services);
  if (kind === 'Property') return copyGenericSingleValue(property, destination, source, services);
  if (kind === 'ByteProperty') return copyBytes(destination, source, 1);
  if (DWORD_KINDS.has(kind)) return copyBytes(destination, source, 4);
  if (kind === 'BoolProperty') {
    const mask = slot(property, 0x5c, ['bitMask', 'boolMask'], services);
    const previous = word(destination), incoming = word(source);
    putWord(destination, (previous & ~mask) | (incoming & mask));
    return;
  }
  if (kind === 'StrProperty') return copyString(property, destination, source, services);
  if (kind === 'FixedArrayProperty') return copyFixedArray(property, destination, source, services);
  if (kind === 'ArrayProperty') return copyArray(property, destination, source, services);
  if (kind === 'StructProperty') return copyStruct(property, destination, source, services);
  if (kind === 'MapProperty') return; // 10168f40: ret 8, including nonempty maps
  fail(`Property CopySingleValue body is not bound: ${kind}`, property, 0x8c);
}

export function copyCompletePropertyValue(property, destination, source, services = {}) {
  const kind = propertyKind(property, services);
  if (kind === 'ByteProperty') return copyBytes(destination, source, count(dimension(property, services), 'byte ArrayDim'));
  if (DWORD_KINDS.has(kind)) {
    const length = dimension(property, services);
    if (length > 0) copyBytes(destination, source, length * 4);
    return;
  }
  return copyGenericCompleteValue(property, destination, source, services);
}
