/**
 * Complex UProperty::SerializeItem virtuals (+0x78) from the installed GOTY
 * Core.dll.
 *
 * The simple bodies (Int/Float/Byte/Name/Object/Class) and the inline
 * object/name/raw branches are owned by src/runtime/script-tagged-properties.mjs.
 * This module translates the complex bodies it previously failed on, all
 * verified against the original Core.dll in the Unicorn x86 emulator
 * (scripts/native-property-serialize-item-oracle.py).  The FString and
 * dynamic-array branches are also exercised against original loading/saving
 * archives; their native heap crossings are explicit services below:
 *
 * | Body | Address | Measure-archive byte count (ar0c == 0, ar10 == 0) |
 * | --- | --- | --- |
 * | UStrProperty::SerializeItem | 0x10167750 | 4 + ArrayNum * (ascii ? 1 : 2) |
 * | UArrayProperty::SerializeItem | 0x10168520 | 4 + sum(inner items) |
 * | UFixedArrayProperty::SerializeItem | 0x10167da0 | sum(inner items) |
 * | UStructProperty::SerializeItem | 0x101691b0 | sum(SerializeBin members) |
 * | UMapProperty::SerializeItem | 0x10168d90 | 0 (immediate `ret`) |
 * | UBoolProperty::SerializeItem | 0x10166550 | 1 |
 *
 * The measure-archive counts were established empirically: a constructed
 * FArchive with vtable 0x10177640 and the constructor words
 * (+04=0x44, +08=0x44c, +0c..+24 = 0,0,0,0,1,1,1,0,0) records the dword
 * counter at +0x2c.  The probe produced str_empty=4,
 * str_allocated_empty=5, str_1=6, str_3=8, str_5=10, str_ascii_233=6,
 * str_unicode_0x100=8, str_unicode_mixed=16, str_cap20_num4=8,
 * array_2_ints=12, array_empty=4, map_any=0, and bool=1 for every value.
 */

import {NativeSlots} from './native-slots.mjs';

function first(record, names, fallback = undefined) {
  for (const name of names) {
    if (record !== null && record !== undefined && record[name] !== undefined) return record[name];
  }
  return fallback;
}

function integer(value, label, { minimum = 0, maximum = 0x7fffffff } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

export const SCRIPT_PROPERTY_SERIALIZE_ITEM = Object.freeze({
  strProperty: Object.freeze({ kind: 'StrProperty', body: 0x10167750 }),
  arrayProperty: Object.freeze({ kind: 'ArrayProperty', body: 0x10168520 }),
  fixedArrayProperty: Object.freeze({ kind: 'FixedArrayProperty', body: 0x10167da0 }),
  structProperty: Object.freeze({ kind: 'StructProperty', body: 0x101691b0 }),
  structSerializeBin: Object.freeze({ kind: 'UStruct::SerializeBin', body: 0x10126610 }),
  mapProperty: Object.freeze({ kind: 'MapProperty', body: 0x10168d90 }),
  boolProperty: Object.freeze({ kind: 'BoolProperty', body: 0x10166550 }),
  offsets: Object.freeze({
    // FString: Data, ArrayNum (including the terminator), ArrayMax.
    fStringArrayNum: 0x04,
    fStringArrayMax: 0x08,
    // TArray: Data, ArrayNum, ArrayMax.  The serialized count is ArrayNum.
    arrayNum: 0x04,
    arrayData: 0x00,
    // UFixedArrayProperty stores its linked Inner and count here.  Its
    // element stride comes from Inner +0x38, while its own +0x38 is the
    // complete inline byte size after Link.
    fixedArrayInner: 0x5c,
    fixedArrayCount: 0x60,
    // UStructProperty stores the linked UStruct at +0x5c.  SerializeItem
    // invokes FArchive::Preload (+0x10), then UStruct::SerializeBin (+0x70).
    struct: 0x5c,
    structSerializeBin: 0x70,
    archivePreload: 0x10,
    // UStruct::SerializeBin reads these UProperty fields for each member.
    propertyFlags: 0x3c,
    arrayDim: 0x34,
    elementSize: 0x38,
    propertyOffset: 0x48,
    // The FCompactIndex marker contributes exactly 4 bytes in the measure
    // archive (ar0c == 0, ar10 == 0 -> raw Serialize(4)).
    compactIndexWidth: 4,
    // FArchive::IsLoading/IsSaving read these native archive words.
    archiveIsLoading: 0x0c,
    archiveIsSaving: 0x10,
    compactIndexBody: 0x10159b50,
    fStringOperatorBody: 0x101459b0,
    fArrayReallocBody: 0x10145440,
    fArrayEmptyBody: 0x10102824,
  }),
});

export class UnsupportedScriptPropertySerializeItemError extends Error {
  constructor(message, {
    operation = 'UProperty::SerializeItem', kind = null, property = null, slot = null,
  } = {}) {
    super(message);
    this.name = 'UnsupportedScriptPropertySerializeItemError';
    this.code = 'UNSUPPORTED_SCRIPT_PROPERTY_SERIALIZE_ITEM';
    this.operation = operation;
    this.kind = kind;
    this.property = property;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptPropertySerializeItemError(message, details);
}

function kindOf(property) {
  const value = first(property, ['nativeKind', 'kind'], undefined);
  switch (value) {
    case 'UStrProperty': return 'StrProperty';
    case 'UArrayProperty': return 'ArrayProperty';
    case 'UFixedArrayProperty': return 'FixedArrayProperty';
    case 'UStructProperty': return 'StructProperty';
    case 'UMapProperty': return 'MapProperty';
    case 'UBoolProperty': return 'BoolProperty';
    default: return value;
  }
}

function propertyName(property) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  return String(first(property, ['key', 'name', 'Name', 'propertyName'],
    first(metadata, ['key', 'name', 'Name', 'propertyName'], '<property>')));
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
  return value;
}

function own(record, key) {
  return record !== null && record !== undefined && Object.hasOwn(record, key);
}

function fieldValue(value) {
  if (value && typeof value === 'object' && own(value, 'value')) return value.value;
  return value;
}

/**
 * The native bodies read FArchive +0x0c first and only inspect +0x10 when it
 * is zero.  Keep that observable order for readArchiveWord adapters.  A
 * collector archive with no explicit words defaults to the constructor's
 * zero/zero state, which preserves the existing measure path.
 */
function archiveWord(archive, services, offset, names, context = {}, fallback = 0) {
  const supplied = services.archiveState ?? archive?.archiveState ?? archive?.state ??
    archive?.flags ?? archive ?? {};
  if (typeof services.readArchiveWord === 'function') {
    const value = services.readArchiveWord(archive, offset, {
      archive, offset, names, operation: context.operation ?? 'SerializeItem', ...context,
    });
    if (value !== undefined) return Number(fieldValue(value));
  }
  const slots = archive?.nativeSlots;
  if (slots instanceof NativeSlots && slots.has(offset)) return Number(slots.value(offset));
  if (slots && typeof slots === 'object' && !(slots instanceof NativeSlots) && own(slots, offset)) return Number(fieldValue(slots[offset]));
  for (const name of names) {
    if (own(supplied, name)) return Number(fieldValue(supplied[name]));
    if (own(archive, name)) return Number(fieldValue(archive[name]));
  }
  return fallback;
}

function archiveMode(archive, services = {}, context = {}) {
  const ar0c = archiveWord(archive, services, 0x0c, ['ar0c', 'slot0c', 'loading', 'isLoading'], context);
  if (!Number.isFinite(ar0c)) fail('FArchive +0x0c (IsLoading) is not numeric', { slot: 'archive +0x0c' });
  if (ar0c !== 0) return { ar0c, ar10: 0, branch: 'loading' };
  const ar10 = archiveWord(archive, services, 0x10, ['ar10', 'slot10', 'saving', 'isSaving'], context);
  if (!Number.isFinite(ar10)) fail('FArchive +0x10 (IsSaving) is not numeric', { slot: 'archive +0x10' });
  return { ar0c: 0, ar10, branch: ar10 !== 0 ? 'saving' : 'collector' };
}

function rawCallback(archive, services = {}) {
  if (typeof services.serializeRaw === 'function') return {callback: services.serializeRaw, owner: services};
  if (typeof services.rawSerialize === 'function') return {callback: services.rawSerialize, owner: services};
  if (typeof archive?.serializeRaw === 'function') return {callback: archive.serializeRaw, owner: archive};
  if (typeof archive?.rawSerialize === 'function') return {callback: archive.rawSerialize, owner: archive};
  return null;
}

function requireArchiveOps(archive, context = {}, services = {}) {
  if (!rawCallback(archive, services)) {
    fail(`SerializeItem requires archive.serializeRaw for ${context.operation ?? 'SerializeItem'}`, { slot: 'archive raw' });
  }
}

function callRaw(archive, reference, width, context = {}, services = {}) {
  const raw = rawCallback(archive, services);
  if (raw) return raw.callback.call(raw.owner, reference, width, context);
  fail(`SerializeItem requires archive.serializeRaw for ${context.operation ?? 'SerializeItem'}`, { slot: 'archive raw' });
}

function callCountBytes(archive, count, maximum, context = {}, services = {}) {
  const callback = typeof services.countBytes === 'function'
    ? {callback: services.countBytes, owner: services}
    : typeof archive?.countBytes === 'function'
      ? {callback: archive.countBytes, owner: archive}
      : typeof archive?.CountBytes === 'function'
        ? {callback: archive.CountBytes, owner: archive}
        : null;
  if (callback) return callback.callback.call(callback.owner, count, maximum, context);
  // Core's base CountBytes body is a no-op.  Absence of a host hook is
  // therefore equivalent to that verified native body.
  return undefined;
}

function callObject(archive, reference, context) {
  if (typeof archive.objectReference === 'function') return archive.objectReference.call(archive, reference, context);
  if (typeof archive.serializeObject === 'function') return archive.serializeObject.call(archive, reference, context);
  fail('SerializeItem requires archive.objectReference/serializeObject for an object/class element', { slot: 'archive object' });
}

function callName(archive, reference, context) {
  if (typeof archive.nameReference === 'function') return archive.nameReference.call(archive, reference, context);
  if (typeof archive.serializeName === 'function') return archive.serializeName.call(archive, reference, context);
  fail('SerializeItem requires archive.nameReference/serializeName for a name element', { slot: 'archive name' });
}

function holder(value, key) {
  if (value && typeof value.get === 'function' && typeof value.set === 'function') return value;
  return {
    reference: true,
    key,
    get: () => value,
    set: next => { value = next; return next; },
  };
}

function compactInteger(value, label) {
  return integer(value, label, {minimum: -0x7fffffff, maximum: 0x7fffffff});
}

/** UE1 FCompactIndex's signed 6 + 7 + 7 + 7 + 5 bit representation. */
function compactEncode(value) {
  const signed = compactInteger(value, 'FCompactIndex value');
  const negative = signed < 0;
  let magnitude = Math.abs(signed);
  let firstByte = magnitude % 0x40;
  magnitude = Math.floor(magnitude / 0x40);
  if (magnitude !== 0) firstByte |= 0x40;
  if (negative) firstByte |= 0x80;
  const result = [firstByte];
  while (magnitude !== 0) {
    let byte = magnitude % 0x80;
    magnitude = Math.floor(magnitude / 0x80);
    if (magnitude !== 0) byte |= 0x80;
    result.push(byte);
  }
  if (result.length > 5 || (result.length === 5 && result[4] > 0x1f)) {
    fail(`FCompactIndex value ${signed} exceeds the UE1 five-byte range`, {
      operation: 'FCompactIndex', slot: 'archive +0x04',
    });
  }
  return result;
}

function compactDecode(bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0 || bytes.length > 5) {
    fail('FCompactIndex archive returned an invalid byte sequence', {
      operation: 'FCompactIndex', slot: 'archive raw',
    });
  }
  const firstByte = bytes[0];
  let magnitude = firstByte & 0x3f;
  let more = (firstByte & 0x40) !== 0;
  for (let index = 1; more; index++) {
    if (index >= bytes.length || index >= 5) {
      fail('FCompactIndex continuation is truncated', { operation: 'FCompactIndex', slot: 'archive raw' });
    }
    const byte = bytes[index];
    if (index === 4 && byte > 0x1f) {
      fail('FCompactIndex final byte overflows the signed range', {
        operation: 'FCompactIndex', slot: 'archive raw',
      });
    }
    // Integer arithmetic (as Reader.compact): a `2 ** n` product is a heap number, which boxes any field it is stored in.
    magnitude += index === 4 ? (byte & 0x1f) * 134217728 : (byte & 0x7f) << (6 + (index - 1) * 7);
    more = index < 4 && (byte & 0x80) !== 0;
  }
  if (more || magnitude > 0x7fffffff) {
    fail('FCompactIndex exceeds the signed 32-bit range', {
      operation: 'FCompactIndex', slot: 'archive raw',
    });
  }
  return (firstByte & 0x80) !== 0 && magnitude !== 0 ? -magnitude : magnitude;
}

/**
 * Call the native FCompactIndex boundary.  Collector mode reaches the raw
 * four-byte archive slot directly.  Save/load use the signed variable-width
 * byte loop, with each byte represented by a mutable FArchive::Serialize
 * holder exactly as in Core's local stack buffers.
 */
function serializeCompactIndex(archive, value, context = {}, services = {}) {
  const mode = archiveMode(archive, services, context);
  const initial = compactInteger(value, 'FCompactIndex value');
  if (mode.branch === 'collector') {
    let compact = initial;
    const target = holder(compact, `${context.key ?? 'compact'}.value`);
    callRaw(archive, target, SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.compactIndexWidth, {
      ...context,
      kind: 'compact-index',
      body: 0x10159b50,
      branch: mode.branch,
    }, services);
    return { ...mode, value: compactInteger(target.get(), 'FCompactIndex value'), width: 4, bytes: 4 };
  }

  const bytes = [];
  if (mode.branch === 'loading') {
    // Loading starts each local stack byte at zero; FArchive::Serialize fills
    // it before FCompactIndex decodes the continuation sequence.
    for (let index = 0; index < 5; index++) {
      const target = holder(0, `${context.key ?? 'compact'}.byte[${index}]`);
      callRaw(archive, target, 1, {
        ...context,
        kind: 'compact-index',
        body: 0x10159b50,
        branch: mode.branch,
        compactIndexByte: index,
      }, services);
      const byte = integer(target.get(), `FCompactIndex byte ${index}`, {minimum: 0, maximum: 0xff});
      bytes.push(byte);
      if (index === 0 && (byte & 0x40) === 0) break;
      if (index > 0 && index < 4 && (byte & 0x80) === 0) break;
      if (index === 4) break;
    }
  } else {
    const encoded = compactEncode(initial);
    for (let index = 0; index < encoded.length; index++) {
      const target = holder(encoded[index], `${context.key ?? 'compact'}.byte[${index}]`);
      callRaw(archive, target, 1, {
        ...context,
        kind: 'compact-index',
        body: 0x10159b50,
        branch: mode.branch,
        compactIndexByte: index,
        compactValue: initial,
      }, services);
      bytes.push(integer(target.get(), `FCompactIndex byte ${index}`, {minimum: 0, maximum: 0xff}));
    }
  }
  const decoded = compactDecode(bytes);
  return { ...mode, value: decoded, width: bytes.length, bytes: bytes.length, encoded: bytes };
}

/**
 * FString layout resolution.  The native byte count uses ArrayNum (+0x4),
 * including the terminating code unit for an allocated nonempty string;
 * ArrayMax (+0x8) is the allocation capacity.  A plain JS string follows the
 * original `FString(const TCHAR*)` constructor: nonempty text has Num=Max=
 * text.length+1, while the logical empty string has Num=Max=0.  A native-shaped
 * record can represent an allocated empty string explicitly with Num=1.
 */
function fStringLayout(property, value, services, context) {
  const hasCapacityService = typeof services.stringCapacity === 'function';
  const serviceCapacity = () => {
    if (!hasCapacityService) return undefined;
    const capacity = services.stringCapacity(value, property, context);
    if (capacity === undefined || capacity === null) {
      fail(`stringCapacity returned no FString ArrayMax for ${propertyName(property)}`, {
        kind: 'StrProperty', property, slot: '+0x8',
      });
    }
    return integer(capacity, 'FString ArrayMax (+0x8)', { minimum: 0 });
  };

  if (typeof value === 'string') {
    const arrayNum = value.length === 0 ? 0 : value.length + 1;
    const suppliedCapacity = serviceCapacity();
    const arrayMax = suppliedCapacity === undefined ? arrayNum : suppliedCapacity;
    if (arrayMax < arrayNum) {
      fail(`FString ArrayMax (+0x8) is smaller than ArrayNum (+0x4) for ${propertyName(property)}`, {
        kind: 'StrProperty', property, slot: '+0x8',
      });
    }
    return { arrayMax, arrayNum, data: value };
  }

  if (value === null || value === undefined) {
    // A null logical value is the JS representation of FString Num=Max=0.
    // Native callers still pass a real FString record; load adapters may use
    // this compact representation before publishing the decoded value.
    return { arrayMax: 0, arrayNum: 0, data: '' };
  }

  if (typeof value === 'object') {
    const data = value.data ?? value.Data;
    const suppliedNum = first(value, ['arrayNum', 'ArrayNum'], undefined);
    const suppliedMax = first(value, ['arrayMax', 'ArrayMax', 'max', 'capacity'], undefined);
    const capacity = suppliedMax === undefined ? serviceCapacity() : suppliedMax;
    // An empty JS payload does not choose between native Num=0 and Num=1;
    // callers must provide arrayNum=1 for an allocated empty FString.
    const inferredNum = typeof data === 'string'
      ? (data.length === 0 ? 0 : data.length + 1)
      : undefined;
    const arrayNum = suppliedNum === undefined ? inferredNum : suppliedNum;
    if (arrayNum === undefined || arrayNum === null) {
      fail(`UStrProperty::SerializeItem requires FString ArrayNum (+0x4) for ${propertyName(property)}`, {
        kind: 'StrProperty', property, slot: '+0x4',
      });
    }
    const num = integer(arrayNum, 'FString ArrayNum (+0x4)', { minimum: 0 });
    const max = capacity === undefined || capacity === null
      ? num : integer(capacity, 'FString ArrayMax (+0x8)', { minimum: 0 });
    if (max < num) {
      fail(`FString ArrayMax (+0x8) is smaller than ArrayNum (+0x4) for ${propertyName(property)}`, {
        kind: 'StrProperty', property, slot: '+0x8',
      });
    }
    return { arrayMax: max, arrayNum: num, data };
  }

  fail(`UStrProperty::SerializeItem requires a string or native FString record for ${propertyName(property)}`, {
    kind: 'StrProperty', property, slot: 'FString',
  });
}

function dataUnits(data, label) {
  if (typeof data === 'string') {
    return Array.from({length: data.length}, (_, index) => data.charCodeAt(index));
  }
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    return Array.from(data, value => integer(value, `${label} code unit`, {minimum: 0, maximum: 0xffff}));
  }
  return null;
}

function stringUnits(property, value, layout, services, context, {required = true} = {}) {
  const label = `${propertyName(property)} FString Data (+0x0)`;
  const supplied = typeof services.stringData === 'function'
    ? services.stringData(value, property, context)
    : typeof services.readStringUnits === 'function'
      ? services.readStringUnits(value, property, context)
      : undefined;
  const data = supplied === undefined ? layout.data : supplied;
  const units = dataUnits(data, label);
  if (units) return units;
  if (!required && layout.arrayNum === 0) return [];
  if (required) {
    fail(`${label} is unresolved; bind stringData/readStringUnits for native heap storage`, {
      kind: 'StrProperty', property, slot: '+0x0',
    });
  }
  return [];
}

function isAllAscii(units) {
  for (const code of units) {
    // The native scanner stops at the first NUL in the Data buffer.
    if (code === 0) return true;
    if (code >= 0x100) return false;
  }
  return true;
}

function readRecordField(record, names, fallback = undefined) {
  return first(record, names, fallback);
}

function writeRecordField(record, names, value) {
  if (!record || typeof record !== 'object') return value;
  const key = names.find(name => own(record, name)) ?? names[0];
  record[key] = value;
  return value;
}

function reallocCallback(archive, services, names = ['reallocateArray', 'arrayRealloc', 'reallocArray']) {
  for (const source of [services, archive]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) if (typeof source[name] === 'function') {
      return {callback: source[name], owner: source};
    }
  }
  return null;
}

function requireRealloc(archive, services, property, kind, context) {
  const callback = reallocCallback(archive, services);
  if (!callback) {
    fail(`${kind} load requires FArray::Realloc host service`, {
      kind, property, slot: 'FArray::Realloc', branch: context.branch,
    });
  }
  return callback;
}

function stringEmptyCallback(archive, services) {
  for (const source of [services, archive]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of ['stringEmpty', 'arrayEmpty', 'emptyArray']) {
      if (typeof source[name] === 'function') return {callback: source[name], owner: source};
    }
  }
  return null;
}

function stringValueFromUnits(units) {
  let end = units.indexOf(0);
  if (end < 0) end = units.length;
  return String.fromCharCode(...units.slice(0, end));
}

function writeStringStorage(property, value, layout, units, reference, archive, services, context) {
  if (typeof value === 'string' || value === null || value === undefined) {
    reference.set(stringValueFromUnits(units));
    return;
  }
  const dataKey = own(value, 'Data') && !own(value, 'data') ? 'Data' : 'data';
  const current = value[dataKey];
  if (Array.isArray(current)) {
    value[dataKey] = units.slice();
    return;
  }
  if (ArrayBuffer.isView(current)) {
    if (current.length >= units.length) {
      current.fill(0);
      current.set(units);
    } else {
      value[dataKey] = Array.from(units);
    }
    return;
  }
  if (typeof current === 'string' || current === undefined || current === null) {
    value[dataKey] = stringValueFromUnits(units);
    return;
  }
  const writer = typeof services.writeStringUnits === 'function'
    ? services.writeStringUnits
    : typeof services.writeString === 'function' ? services.writeString : null;
  if (writer) {
    writer.call(services, value, units, {
      ...context, operation: 'FString::Serialize', elementSize: 2,
      property, body: 0x101459b0,
    });
    return;
  }
  fail(`${propertyName(property)} FString Data (+0x0) is opaque after FArray::Realloc`, {
    kind: 'StrProperty', property, slot: '+0x0', branch: context.branch,
  });
}

function setStringCounts(value, arrayNum, arrayMax) {
  if (!value || typeof value !== 'object') return;
  writeRecordField(value, ['arrayNum', 'ArrayNum'], arrayNum);
  writeRecordField(value, ['arrayMax', 'ArrayMax'], arrayMax);
}

/**
 * UStrProperty::SerializeItem (0x10167750) -> Ar << *(FString*)Data.
 *
 * The FString operator (0x101459b0) writes CompactIndex(marker) then, when
 * ar0c == 0 (measure/collector), ArrayNum (+0x4) code units: one byte per
 * code unit for an ASCII string, two bytes per code unit when any code unit
 * before the terminator is >= 0x100.  The Unicode path writes all code units
 * as 16-bit values; the ASCII path writes the low byte (clamping a code unit
 * >= 0x100 to 0x7f defensively).  Save/load modes use the same raw archive
 * boundary plus explicit host allocation services.
 */
export function serializeStrItem(property, archive, reference, context = {}, services = {}) {
  requireArchiveOps(archive, context, services);
  const value = reference.get();
  const layout = fStringLayout(property, value, services, context);
  callCountBytes(archive, layout.arrayNum * 2, layout.arrayMax * 2, {
    ...context,
    operation: 'FString::Serialize',
    body: 0x101459b0,
    elementSize: 2,
  }, services);
  // FString scans its current TCHAR buffer before invoking FCompactIndex, even
  // on a loading archive.  Keep that read visible to native heap adapters.
  const units = stringUnits(property, value, layout, services, context, {required: layout.arrayNum > 0});
  const scannedUnits = units.slice(0, layout.arrayNum);
  const ascii = isAllAscii(scannedUnits);
  const initialMarker = ascii || layout.arrayNum === 0 ? layout.arrayNum : -layout.arrayNum;
  if (layout.arrayNum > units.length + 1) {
    fail(`FString Data (+0x0) is shorter than ArrayNum (+0x4) for ${propertyName(property)}`, {
      kind: 'StrProperty', property, slot: '+0x0', branch: 'storage',
    });
  }
  const compact = serializeCompactIndex(archive, initialMarker, {
    ...context,
    operation: 'FString::Serialize',
    property,
  }, services);
  // The operator tests FString's +0x0c after CompactIndex.  This second read
  // matters for adapters that expose native archive flag accesses.
  const loadingWord = archiveWord(archive, services, 0x0c, ['ar0c', 'slot0c', 'loading', 'isLoading'], {
    ...context, operation: 'FString::Serialize',
  });
  if (!Number.isFinite(loadingWord)) {
    fail('FArchive +0x0c (IsLoading) is not numeric', { kind: 'StrProperty', property, slot: 'archive +0x0c' });
  }
  const branch = loadingWord !== 0 ? 'loading' : compact.branch;
  const marker = compactInteger(compact.value, 'FString CompactIndex marker');
  const count = Math.abs(marker);
  const unicode = marker < 0;
  const width = unicode ? 2 : 1;
  const bytes = [];

  if (branch === 'loading') {
    if (count > 0x7fffffff) {
      fail(`FString CompactIndex count ${count} is outside the native INT range`, {
        kind: 'StrProperty', property, slot: '+0x4', branch,
      });
    }
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const recordNeedsHeap = record !== null;
    const realloc = recordNeedsHeap ? requireRealloc(archive, services, property, 'StrProperty', { ...context, branch }) : null;
    if (record) setStringCounts(record, count, count);
    if (realloc) {
      realloc.callback.call(realloc.owner, record, 2, {
        ...context,
        operation: 'FArray::Realloc',
        body: 0x10145440,
        branch,
        property,
        elementSize: 2,
        arrayNum: count,
        arrayMax: count,
      });
    }
    const loadedUnits = [];
    for (let index = 0; index < count; index++) {
      const target = holder(0, `${context.key ?? propertyName(property)}[${index}]`);
      callRaw(archive, target, width, {
        ...context,
        operation: 'FString::Serialize',
        body: 0x101459b0,
        branch,
        property,
        stringIndex: index,
        stringMarker: marker,
      }, services);
      const code = integer(target.get(), `FString code unit ${index}`, {minimum: 0, maximum: width === 1 ? 0xff : 0xffff});
      loadedUnits.push(code);
      bytes.push(code);
    }
    if (record) {
      writeStringStorage(property, record, layout, loadedUnits, reference, archive, services, { ...context, branch });
    } else {
      reference.set(stringValueFromUnits(loadedUnits));
    }
    // The native operator calls FString::Empty(2,0) for a loaded terminator
    // that leaves ArrayMax == 1.  Publish the canonical zero-count state and
    // retain the allocator callback as an explicit ownership boundary.
    if (record && count === 1 && loadedUnits[0] === 0) {
      const empty = stringEmptyCallback(archive, services);
      if (empty) empty.callback.call(empty.owner, record, 2, 0, {
        ...context, operation: 'FArray::Empty', body: 0x10102824, branch, property,
      });
      setStringCounts(record, 0, 0);
      writeStringStorage(property, record, layout, [], reference, archive, services, { ...context, branch });
    }
    if (!record && count === 1 && loadedUnits[0] === 0) reference.set('');
    return {
      property, kind: 'StrProperty', marker, arrayNum: count,
      arrayMax: record ? readRecordField(record, ['arrayMax', 'ArrayMax'], count) : count,
      ascii: !unicode, width, branch,
      serializedBytes: compact.bytes + count * width,
      compactIndexBytes: compact.bytes,
    };
  }

  // Collector and saving archives serialize the current ArrayNum code units;
  // a save archive uses variable-width CompactIndex, while the collector's
  // measured archive reaches the four-byte raw fallback in FCompactIndex.
  const serializedMarker = marker;
  const serializedWidth = serializedMarker < 0 ? 2 : 1;
  for (let index = 0; index < layout.arrayNum; index++) {
    let code = index < units.length ? units[index] : 0;
    if (serializedWidth === 1 && code >= 0x100) code = 0x7f;
    const target = holder(code, `${context.key ?? propertyName(property)}[${index}]`);
    callRaw(archive, target, serializedWidth, {
      ...context,
      operation: 'FString::Serialize',
      body: 0x101459b0,
      branch,
      property,
      stringIndex: index,
      stringMarker: serializedMarker,
    }, services);
    bytes.push(serializedWidth);
  }
  const result = {
    property, kind: 'StrProperty', marker: serializedMarker,
    arrayNum: layout.arrayNum, arrayMax: layout.arrayMax,
    ascii: serializedMarker >= 0, width: serializedWidth, branch,
    serializedBytes: compact.bytes + bytes.length * serializedWidth,
    compactIndexBytes: compact.bytes,
  };
  if (branch === 'collector') result.measuredBytes = result.serializedBytes;
  return result;
}

/**
 * UMapProperty::SerializeItem (0x10168d90): `retl $0x8` immediately, no
 * archive operation regardless of the archive state or value.
 */
export function serializeMapItem() {
  return { kind: 'MapProperty' };
}

function arrayShape(value, label) {
  if (value === null || value === undefined) return { data: [], arrayNum: 0, arrayMax: 0, record: null };
  if (Array.isArray(value)) return { data: value, arrayNum: value.length, arrayMax: value.length, record: null };
  if (typeof value === 'object') {
    const data = value.data ?? value.Data;
    const arrayNum = Number(value.arrayNum ?? value.ArrayNum ?? (data && data.length !== undefined ? data.length : 0));
    const arrayMaxValue = value.arrayMax ?? value.ArrayMax ?? value.max ?? value.capacity;
    const num = integer(arrayNum, `${label} TArray ArrayNum (+0x4)`, { minimum: 0 });
    const max = integer(arrayMaxValue === undefined ? num : arrayMaxValue,
      `${label} TArray ArrayMax (+0x8)`, { minimum: 0 });
    if (max < num) {
      fail(`TArray ArrayMax (+0x8) is smaller than ArrayNum (+0x4) for ${label}`, {
        kind: 'ArrayProperty', slot: '+0x8',
      });
    }
    if (Array.isArray(data) || ArrayBuffer.isView(data)) {
      return { data, arrayNum: num, arrayMax: max, record: value };
    }
    // A native pointer may be resolved by an explicit arrayData service on a
    // loading archive.  Keep the record so the loader can publish its new
    // allocation after FArray::Realloc.
    return { data, arrayNum: num, arrayMax: max, record: value };
  }
  fail(`TArray Data (+0x0) is unresolved for ${label}`, { kind: 'ArrayProperty' });
}

function elementHolder(array, index, context) {
  return {
    reference: true,
    key: `${context.key ?? 'array'}[${index}]`,
    get: () => array.data[index],
    set: next => {
      if (!array.data || typeof array.data.length !== 'number') {
        throw new TypeError(`TArray Data (+0x0) is not writable for ${context.key ?? 'array'}[${index}]`);
      }
      array.data[index] = next;
      return next;
    },
  };
}

function setArrayCounts(record, arrayNum, arrayMax) {
  if (!record || typeof record !== 'object') return;
  writeRecordField(record, ['arrayNum', 'ArrayNum', 'num', 'count'], arrayNum);
  writeRecordField(record, ['arrayMax', 'ArrayMax', 'max', 'capacity'], arrayMax);
}

function recordArrayData(record) {
  if (!record || typeof record !== 'object') return undefined;
  return record.data ?? record.Data ?? record.arrayData ?? record.pointer;
}

function writeArrayData(record, data) {
  if (!record || typeof record !== 'object') return;
  const key = own(record, 'data') ? 'data' : own(record, 'Data') ? 'Data' :
    own(record, 'arrayData') ? 'arrayData' : 'data';
  record[key] = data;
}

function ensureArrayStorage(shape, count, property, services, context) {
  if (count === 0) {
    shape.data = [];
    if (shape.record) writeArrayData(shape.record, shape.data);
    return shape.data;
  }
  const current = shape.record ? recordArrayData(shape.record) : shape.data;
  if (Array.isArray(current)) {
    if (current.length < count) current.length = count;
    shape.data = current;
    return current;
  }
  if (ArrayBuffer.isView(current) && current.length >= count) {
    shape.data = current;
    return current;
  }
  const resolver = typeof services.arrayData === 'function'
    ? services.arrayData
    : typeof services.resolveArrayData === 'function' ? services.resolveArrayData : null;
  if (resolver) {
    const resolved = resolver(shape.record ?? shape.data, {
      ...context, operation: 'FArray::Realloc', property, count,
    });
    if (resolved && typeof resolved.length === 'number') {
      shape.data = resolved;
      if (shape.record) writeArrayData(shape.record, resolved);
      return resolved;
    }
  }
  if (shape.record) {
    fail(`${propertyName(property)} TArray Data (+0x0) is opaque after FArray::Realloc`, {
      kind: 'ArrayProperty', property, slot: '+0x0', branch: context.branch,
    });
  }
  shape.data = new Array(count);
  return shape.data;
}

function arrayGrowth(count) {
  const result = count + Math.trunc(3 * count / 8) + 32;
  if (!Number.isSafeInteger(result) || result > 0x7fffffff) {
    fail(`TArray count ${count} overflows the native growth capacity`, {
      operation: 'FArray::Realloc', slot: '+0x8',
    });
  }
  return result;
}

function elementStride(property, services = {}) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const value = typeof services.elementSize === 'function'
    ? services.elementSize(property)
    : first(property, ['elementSize', 'ElementSize'], first(metadata, ['elementSize', 'ElementSize'], undefined));
  if (value === undefined || value === null) {
    fail(`Array Inner ElementSize (+0x38) is unresolved for ${propertyName(property)}`, {
      kind: 'ArrayProperty', property, slot: '+0x38',
    });
  }
  return integer(value, 'Array Inner ElementSize (+0x38)', {minimum: 0});
}

function arrayRealloc(array, callback, elementSize, context, arrayNum, arrayMax) {
  callback.callback.call(callback.owner, array, elementSize, {
    ...context,
    operation: 'FArray::Realloc',
    body: 0x10145440,
    elementSize,
    arrayNum,
    arrayMax,
  });
}

/**
 * UArrayProperty::SerializeItem (0x10168520).
 *
 * Writes CompactIndex(ArrayNum) then calls Inner->SerializeItem(+0x78) for
 * each element.  Loading clears Num/Max, reallocates once, publishes the
 * decoded count, and grows to `count + floor(3*count/8) + 32` before the
 * element recursion.  Saving leaves the current TArray allocation untouched.
 */
export function serializeArrayItem(property, archive, reference, context = {}, services = {}) {
  requireArchiveOps(archive, context, services);
  const inner = innerOf(property, services, 'UArrayProperty');
  const value = reference.get();
  const shape = arrayShape(value, 'current');
  const compact = serializeCompactIndex(archive, shape.arrayNum, {
    ...context,
    operation: 'UArrayProperty::SerializeItem',
    property,
  }, services);
  const loadingWord = archiveWord(archive, services, 0x0c, ['ar0c', 'slot0c', 'loading', 'isLoading'], {
    ...context, operation: 'UArrayProperty::SerializeItem',
  });
  if (!Number.isFinite(loadingWord)) {
    fail('FArchive +0x0c (IsLoading) is not numeric', { kind: 'ArrayProperty', property, slot: 'archive +0x0c' });
  }
  const branch = loadingWord !== 0 ? 'loading' : compact.branch;
  let count = compactInteger(compact.value, 'TArray CompactIndex count');
  if (branch === 'loading' && count < 0) {
    fail(`TArray CompactIndex decoded a negative count ${count}`, {
      kind: 'ArrayProperty', property, slot: '+0x4', branch,
    });
  }
  let max = shape.arrayMax;
  let bytes = compact.bytes;
  let known = true;
  let stride = null;
  if (branch === 'loading') {
    const record = shape.record;
    const realloc = record ? requireRealloc(archive, services, property, 'ArrayProperty', { ...context, branch }) : null;
    stride = elementStride(inner, services);
    if (record) setArrayCounts(record, 0, 0);
    if (realloc) arrayRealloc(record, realloc, stride, { ...context, branch }, 0, 0);
    max = record ? integer(readRecordField(record, ['arrayMax', 'ArrayMax', 'max', 'capacity'], 0),
      'TArray ArrayMax (+0x8)', {minimum: 0}) : 0;
    const baseNum = record ? integer(readRecordField(record, ['arrayNum', 'ArrayNum', 'num', 'count'], 0),
      'TArray ArrayNum (+0x4)', {minimum: 0}) : 0;
    count += baseNum;
    if (record) setArrayCounts(record, count, max);
    if (count > max) {
      max = arrayGrowth(count);
      if (record) setArrayCounts(record, count, max);
      if (realloc) arrayRealloc(record, realloc, stride, { ...context, branch }, count, max);
    }
    if (!record) {
      const next = new Array(count);
      reference.set(next);
      shape.data = next;
    } else {
      ensureArrayStorage(shape, count, property, services, { ...context, branch });
    }
  } else {
    count = shape.arrayNum;
    max = shape.arrayMax;
    if (shape.record && !(Array.isArray(shape.data) || ArrayBuffer.isView(shape.data))) {
      fail(`TArray Data (+0x0) is opaque for ${propertyName(property)}`, {
        kind: 'ArrayProperty', property, slot: '+0x0', branch,
      });
    }
    if (shape.record && shape.data && shape.data.length < count) {
      fail(`TArray Data (+0x0) has fewer elements than ArrayNum for ${propertyName(property)}`, {
        kind: 'ArrayProperty', property, slot: '+0x0', branch,
      });
    }
  }
  for (let i = 0; i < count; i++) {
    const itemContext = { ...context, key: `${context.key ?? propertyName(property)}[${i}]`, arrayIndex: i };
    const item = elementHolder(shape, i, itemContext);
    const result = serializeScriptPropertyItem(inner, archive, item, itemContext, services);
    const childBytes = result && typeof result === 'object'
      ? result.serializedBytes ?? result.measuredBytes ?? result.bytes : result;
    if (Number.isInteger(childBytes) && childBytes >= 0) {
      bytes += childBytes;
    } else {
      known = false;
    }
  }
  const output = {
    property, kind: 'ArrayProperty', inner, arrayNum: count, arrayMax: max,
    branch, compactIndexBytes: compact.bytes,
  };
  if (stride !== null) output.stride = stride;
  if (known) {
    output.serializedBytes = bytes;
    if (branch === 'collector') output.measuredBytes = bytes;
  }
  return output;
}

/** Convert a native signed INT field while retaining the raw dword idiom. */
function signed32(value, label, { minimum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0xffffffff) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  const signed = number >= 0x80000000 ? number - 0x100000000 : number;
  if (minimum !== null && signed < minimum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return signed;
}

function fixedArrayCount(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.fixedArrayCount ?? services?.arrayCount ?? services?.propertyArrayCount;
  const value = typeof callback === 'function'
    ? callback(property)
    : first(property, ['arrayCount', 'fixedArraySize', 'fixedArrayDimension', 'count', 'ArrayCount'],
      first(metadata, ['arrayCount', 'fixedArraySize', 'fixedArrayDimension', 'count', 'ArrayCount'], undefined));
  if (value === undefined || value === null) {
    fail(`UFixedArrayProperty Count (+0x60) is unresolved for ${propertyName(property)}`, {
      kind: 'FixedArrayProperty', property, slot: '+0x60',
    });
  }
  return signed32(value, 'UFixedArrayProperty Count (+0x60)');
}

function propertyArrayDim(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.arrayDim ?? services?.propertyArrayDim;
  const value = typeof callback === 'function'
    ? callback(property)
    : first(property, ['arrayDim', 'arrayDimension', 'ArrayDim'],
      first(metadata, ['arrayDim', 'arrayDimension', 'ArrayDim'], 1));
  return signed32(value, 'UStruct member ArrayDim');
}

function propertyFlagsOf(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.propertyFlags ?? services?.flags;
  const value = typeof callback === 'function'
    ? callback(property)
    : first(property, ['propertyFlags', 'flags', 'PropertyFlags'],
      first(metadata, ['propertyFlags', 'flags', 'PropertyFlags'], 0));
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`Expected UProperty PropertyFlags (+0x3c), got ${String(value)}`);
  }
  return number >>> 0;
}

function structTarget(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.innerStruct ?? services?.structOf;
  if (typeof callback === 'function') {
    const value = callback(property);
    if (value !== null && value !== undefined) return value;
    fail(`UStructProperty Struct (+0x5c) is unresolved for ${propertyName(property)}`, {
      kind: 'StructProperty', property, slot: '+0x5c',
    });
  }
  const value = first(property, ['struct', 'structObject', 'structClass', 'structRef', 'innerStruct'],
    first(metadata, ['struct', 'structObject', 'structClass', 'structRef', 'innerStruct'], undefined));
  // A linked property record has a serialized ref-view at `metadata.struct`
  // and the expanded field tree beside it.  The native pointer is still
  // represented by that ref-view for the optional Preload callback; use the
  // property metadata as the walk source when the ref-view has no fields.
  if (value !== undefined && value !== null) return value;
  if (Array.isArray(metadata.structFields) || metadata.structKey !== undefined ||
      Array.isArray(metadata.children)) return metadata;
  fail(`UStructProperty Struct (+0x5c) is unresolved for ${propertyName(property)}`, {
    kind: 'StructProperty', property, slot: '+0x5c',
  });
}

function structKey(property, structure) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  return String(first(property, ['structKey', 'StructKey'],
    first(metadata, ['structKey', 'StructKey'],
      first(structure, ['structKey', 'StructKey', 'key', 'path', 'name'], '')))).toLowerCase();
}

function inheritanceSuper(structure, services) {
  if (typeof services?.inheritanceSuper === 'function') return services.inheritanceSuper(structure);
  if (typeof structure?.getInheritanceSuper === 'function') return structure.getInheritanceSuper();
  return first(structure, ['superStruct', 'superClass', 'superclass', 'baseClass', 'super', 'base'], null);
}

function nextField(field, services) {
  if (typeof services?.nextOf === 'function') return services.nextOf(field);
  return first(field, ['next', 'Next', 'nextField', 'nextProperty'], null);
}

function isPropertyField(field) {
  if (field?.isProperty === true) return true;
  const kind = String(first(field, ['nativeKind', 'kind', 'className', 'propertyClassName'],
    first(field?.metadata, ['nativeKind', 'kind', 'className', 'propertyClassName'], ''))).toLowerCase();
  return kind.endsWith('property') || Boolean(propertyType(field));
}

function linkedFields(head, services) {
  if (Array.isArray(head)) return head;
  if (head && typeof head[Symbol.iterator] === 'function' && typeof head !== 'string') return [...head];
  const list = [];
  const seen = new Set();
  for (let field = head; field !== null && field !== undefined; field = nextField(field, services)) {
    if (seen.has(field)) throw new Error('Cyclic UStruct Children/Next chain');
    seen.add(field);
    if (isPropertyField(field)) list.push(field);
  }
  return list;
}

function structFieldsOf(property, structure, services) {
  const callback = services?.structProperties ?? services?.structFields;
  if (typeof callback === 'function') {
    const supplied = callback(structure, { property, operation: 'UStruct::SerializeBin' });
    if (supplied !== null && supplied !== undefined) return Array.from(supplied);
  }

  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  // `metadata.structFields` is already the native iterator order produced by
  // ScriptRuntime.structFields: current children, then each inheritance
  // super.  Prefer it over the serialized Struct ref-view.
  for (const source of [structure, metadata, property]) {
    const fields = first(source, ['structFields', 'fields'], undefined);
    if (fields !== undefined && fields !== null) return linkedFields(fields, services);
  }

  const result = [];
  const seenStructs = new Set();
  for (let current = structure; current !== null && current !== undefined; current = inheritanceSuper(current, services)) {
    if (seenStructs.has(current)) throw new Error('Cyclic UStruct inheritance chain');
    seenStructs.add(current);
    const children = typeof services?.childrenOf === 'function'
      ? services.childrenOf(current)
      : first(current, ['children', 'Children', 'firstChild', 'child'], null);
    result.push(...linkedFields(children, services));
  }
  if (result.length || structKey(property, structure).includes('core.object.vector') ||
      structKey(property, structure).includes('core.object.rotator')) return result;
  fail(`UStruct SerializeBin Children (+0x38) are unresolved for ${propertyName(property)}`, {
    kind: 'StructProperty', property, slot: '+0x38',
  });
}

function archiveIsPersistent(archive, services) {
  if (services?.persistent !== undefined) return Boolean(services.persistent);
  if (archive?.persistent !== undefined) return Boolean(archive.persistent);
  if (archive?.isPersistent !== undefined) return Boolean(archive.isPersistent);
  const state = archive?.archiveState ?? archive;
  return Number(state?.ar18 ?? state?.slot18 ?? 0) !== 0;
}

function structMemberKey(field) {
  const metadata = field?.metadata && typeof field.metadata === 'object' ? field.metadata : field;
  return String(first(field, ['key', 'name', 'Name', 'propertyName'],
    first(metadata, ['key', 'name', 'Name', 'propertyName'], '<member>')));
}

function structMemberReference(base, field, context) {
  const key = structMemberKey(field);
  return {
    reference: true,
    key,
    field,
    metadata: field?.metadata ?? field,
    get() {
      const value = base.get();
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`Struct storage is not a keyed value for ${key}`);
      }
      if (!Object.hasOwn(value, key)) throw new TypeError(`Struct member storage is unresolved for ${key}`);
      return value[key];
    },
    set(next) {
      const value = base.get();
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`Struct storage is not a keyed value for ${key}`);
      }
      const copy = { ...value, [key]: next };
      base.set(copy);
      return next;
    },
    parent: base,
    context,
  };
}

function arrayElementReference(base, index, dimension, label) {
  return {
    reference: true,
    key: `${label}[${index}]`,
    get() {
      const value = base.get();
      if (!Array.isArray(value) || value.length < dimension) {
        throw new TypeError(`ArrayDim storage is not an array of ${dimension} for ${label}`);
      }
      return value[index];
    },
    set(next) {
      const value = base.get();
      if (!Array.isArray(value) || value.length < dimension) {
        throw new TypeError(`ArrayDim storage is not an array of ${dimension} for ${label}`);
      }
      const copy = value.slice();
      copy[index] = next;
      base.set(copy);
      return next;
    },
    parent: base,
  };
}

function fixedArrayShape(value, count, label) {
  if (count <= 0) return { data: [], record: null };
  if (Array.isArray(value)) {
    if (value.length < count) throw new TypeError(`${label} requires ${count} inline elements; got ${value.length}`);
    return { data: value, record: null };
  }
  if (value !== null && value !== undefined && typeof value === 'object') {
    const data = value.data ?? value.Data;
    if (Array.isArray(data)) {
      if (data.length < count) throw new TypeError(`${label} requires ${count} inline elements; got ${data.length}`);
      return { data, record: value };
    }
  }
  fail(`${label} inline element storage is unresolved`, { kind: 'FixedArrayProperty', slot: 'value' });
}

function fixedElementReference(root, shape, index, count, label) {
  return {
    reference: true,
    key: `${label}[${index}]`,
    get: () => shape.data[index],
    set(next) {
      shape.data[index] = next;
      // Preserve the outer propertyReference boundary when the host supplied
      // a copy-on-read logical value (the runtime's normal representation).
      if (root && typeof root.get === 'function' && typeof root.set === 'function') {
        const current = root.get();
        if (Array.isArray(current) && current.length >= count) {
          const copy = current.slice();
          copy[index] = next;
          root.set(copy);
        } else if (current && typeof current === 'object' && !Array.isArray(current)) {
          const data = current.data ?? current.Data;
          if (Array.isArray(data) && data.length >= count) {
            const copy = { ...current, data: data.slice() };
            copy.data[index] = next;
            if (Object.hasOwn(current, 'Data') && !Object.hasOwn(current, 'data')) {
              delete copy.data;
              copy.Data = data.slice();
              copy.Data[index] = next;
            }
            root.set(copy);
          }
        }
      }
      return next;
    },
  };
}

function preloadStruct(archive, structure, context, services) {
  const callback = services?.preloadStruct ?? archive?.preloadStruct ?? archive?.preloadObject;
  if (typeof callback !== 'function') return false;
  callback.call(services?.preloadStruct ? services : archive, structure, {
    ...context,
    operation: 'UStructProperty::SerializeItem',
    body: SCRIPT_PROPERTY_SERIALIZE_ITEM.structProperty.body,
    archiveVirtualSlot: SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.archivePreload,
  });
  return true;
}

function childMeasuredBytes(result) {
  if (result && typeof result === 'object') {
    const value = result.measuredBytes ?? result.bytes ?? result.size ?? result.serializedBytes;
    if (Number.isInteger(value) && value >= 0) return value;
  }
  if (Number.isInteger(result) && result >= 0) return result;
  return null;
}

/**
 * UFixedArrayProperty::SerializeItem (0x10167da0).
 *
 * The body has no archive header operation.  For Count (+0x60) > 0 it reads
 * Inner (+0x5c), obtains Inner ElementSize (+0x38), and calls each Inner
 * SerializeItem (+0x78) with `Data + index * ElementSize`.  The count test is
 * signed and occurs before either Inner dereference; Count <= 0 therefore
 * returns without requiring an Inner binding.
 */
export function serializeFixedArrayItem(property, archive, reference, context = {}, services = {}) {
  const count = fixedArrayCount(property, services);
  if (count <= 0) {
    return { property, kind: 'FixedArrayProperty', count, inner: null, measuredBytes: 0 };
  }
  const inner = innerOf(property, services, 'UFixedArrayProperty');
  const metadata = inner?.metadata && typeof inner.metadata === 'object' ? inner.metadata : inner;
  const strideValue = first(inner, ['elementSize', 'ElementSize'],
    first(metadata, ['elementSize', 'ElementSize'], undefined));
  if (strideValue === undefined || strideValue === null) {
    fail(`UFixedArrayProperty Inner ElementSize (+0x38) is unresolved for ${propertyName(property)}`, {
      kind: 'FixedArrayProperty', property, slot: '+0x38',
    });
  }
  const stride = integer(strideValue, 'UFixedArrayProperty Inner ElementSize (+0x38)', { minimum: 0 });
  const value = reference.get();
  const shape = fixedArrayShape(value, count, 'UFixedArrayProperty');
  const label = context.key ?? propertyName(property);
  let bytes = 0;
  let known = true;
  const childResults = [];
  const nestedServices = services;
  for (let index = 0; index < count; index++) {
    const itemContext = {
      ...context,
      key: `${label}[${index}]`,
      arrayIndex: index,
      fixedArrayIndex: index,
      fixedArrayCount: count,
      fixedArrayStride: stride,
    };
    const itemReference = fixedElementReference(reference, shape, index, count, label);
    const result = serializeScriptPropertyItem(inner, archive, itemReference, itemContext, nestedServices);
    childResults.push(result);
    const measured = childMeasuredBytes(result);
    if (measured === null) known = false;
    else bytes += measured;
  }
  const output = {
    property, kind: 'FixedArrayProperty', count, inner, stride,
    elements: childResults,
  };
  if (known) output.measuredBytes = bytes;
  return output;
}

/**
 * UStructProperty::SerializeItem (0x101691b0).
 *
 * The body first calls FArchive::Preload through archive vtable +0x10 with
 * this property's linked Struct (+0x5c), then dispatches that Struct's
 * SerializeBin virtual +0x70.  The translated SerializeBin walk follows
 * Children/Next and inheritance-super order, tests PropertyFlags (+0x3c),
 * and dispatches each ArrayDim element through its +0x78 SerializeItem.
 */
export function serializeStructItem(property, archive, reference, context = {}, services = {}) {
  const structure = structTarget(property, services);
  const preload = preloadStruct(archive, structure, context, services);
  const token = structure && (typeof structure === 'object' || typeof structure === 'function')
    ? structure : property?.metadata ?? property;
  const stack = services.__serializeStructStack ?? new Set();
  if (stack.has(token)) {
    fail(`Cyclic by-value struct SerializeBin reference for ${propertyName(property)}`, {
      kind: 'StructProperty', property, slot: SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.structSerializeBin,
    });
  }
  stack.add(token);
  try {
    const fields = structFieldsOf(property, structure, services);
    const persistent = archiveIsPersistent(archive, services);
    let bytes = 0;
    let known = true;
    const members = [];
    const childServices = { ...services, __serializeStructStack: stack };
    for (const field of fields) {
      const flags = propertyFlagsOf(field, services);
      const key = structMemberKey(field);
      if (flags & 0x1000) {
        members.push({ field, key, skipped: 'native', flags });
        continue;
      }
      if ((flags & 0x2000) && persistent) {
        members.push({ field, key, skipped: 'transient', flags });
        continue;
      }
      const dimension = propertyArrayDim(field, services);
      if (dimension <= 0) {
        members.push({ field, key, skipped: 'array-dim', dimension, flags });
        continue;
      }
      const base = structMemberReference(reference, field, context);
      const fieldResults = [];
      for (let index = 0; index < dimension; index++) {
        const itemReference = dimension === 1 ? base : arrayElementReference(base, index, dimension, key);
        const itemContext = {
          ...context,
          key: dimension === 1 ? key : `${key}[${index}]`,
          memberKey: key,
          arrayIndex: dimension === 1 ? null : index,
          struct: structure,
          structProperty: property,
          property: field,
          structSerializeBin: SCRIPT_PROPERTY_SERIALIZE_ITEM.structSerializeBin.body,
          propertyOffset: first(field, ['offset', 'propertyOffset'],
            first(field?.metadata, ['offset', 'propertyOffset'], undefined)),
        };
        const result = serializeScriptPropertyItem(field, archive, itemReference, itemContext, childServices);
        fieldResults.push(result);
        const measured = childMeasuredBytes(result);
        if (measured === null) known = false;
        else bytes += measured;
      }
      members.push({ field, key, flags, dimension, results: fieldResults });
    }
    const output = {
      property, kind: 'StructProperty', struct: structure, fields, preload,
      serializeBinBody: SCRIPT_PROPERTY_SERIALIZE_ITEM.structSerializeBin.body,
      members,
    };
    if (known) output.measuredBytes = bytes;
    return output;
  } finally {
    stack.delete(token);
  }
}

function boolMaskOf(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  const callback = services?.boolMask;
  if (typeof callback === 'function') {
    const mask = callback(property);
    if (mask === undefined || mask === null || Number(mask) === 0) fail('UBoolProperty mask (+0x5c) is unresolved', { kind: 'BoolProperty', property, slot: '+0x5c' });
    return Number(mask) >>> 0;
  }
  const mask = first(property, ['boolMask', 'bitMask', 'mask', 'BoolMask'],
    first(metadata, ['boolMask', 'bitMask', 'mask', 'BoolMask'], undefined));
  if (mask === undefined || mask === null || Number(mask) === 0) fail('UBoolProperty mask (+0x5c) is unresolved', { kind: 'BoolProperty', property, slot: '+0x5c' });
  return Number(mask) >>> 0;
}

/**
 * UBoolProperty::SerializeItem (0x10166550): writes the bit as one byte via
 * Ar->Serialize(..., 1). This helper represents the collector/measure route;
 * the original also sets/clears its storage bit from the unchanged byte.
 */
export function serializeBoolItem(property, archive, reference, context, services = {}) {
  requireArchiveOps(archive, context, services);
  boolMaskOf(property, services);
  callRaw(archive, reference, 1, context, services);
  return { property, kind: 'BoolProperty', measuredBytes: 1 };
}

function propertyType(property, services) {
  const metadata = property?.metadata && typeof property.metadata === 'object' ? property.metadata : property;
  return String(first(property, ['type', 'valueType'], first(metadata, ['type', 'valueType'], ''))).toLowerCase();
}

/**
 * SerializeItem (+0x78) dispatch used by the Array element loop and by the
 * tagged-property walker.  It routes every property class a complex body can
 * reach: object/name through the archive operators, raw scalars and bool
 * through serializeRaw, Str/Array/Map through this module, and the
 * Struct/FixedArray SerializeBin loops through this module as well.
 */
export function serializeScriptPropertyItem(property, archive, reference, context, services = {}) {
  if (typeof services.serializeItem === 'function') return services.serializeItem(property, archive, reference, context);
  const kind = kindOf(property);
  const type = propertyType(property, services);
  switch (kind) {
    case 'StrProperty': return serializeStrItem(property, archive, reference, context, services);
    case 'MapProperty': return serializeMapItem();
    case 'ArrayProperty': return serializeArrayItem(property, archive, reference, context, services);
    case 'FixedArrayProperty': return serializeFixedArrayItem(property, archive, reference, context, services);
    case 'StructProperty': return serializeStructItem(property, archive, reference, context, services);
    case 'BoolProperty': return serializeBoolItem(property, archive, reference, context, services);
    case 'ObjectProperty': case 'ClassProperty':
      callObject(archive, reference, context);
      return { property, kind, measuredBytes: 4 };
    case 'NameProperty':
      callName(archive, reference, context);
      return { property, kind, measuredBytes: 4 };
    case 'IntProperty': case 'FloatProperty':
      callRaw(archive, reference, 4, context, services);
      return { property, kind, measuredBytes: 4 };
    case 'ByteProperty':
      callRaw(archive, reference, 1, context, services);
      return { property, kind, measuredBytes: 1 };
    default:
      if (type === 'object' || type === 'class') {
        callObject(archive, reference, context);
        return { property, kind: type, measuredBytes: 4 };
      }
      if (type === 'name') {
        callName(archive, reference, context);
        return { property, kind: type, measuredBytes: 4 };
      }
      if (type === 'string') return serializeStrItem(property, archive, reference, context, services);
      if (type === 'array') return serializeArrayItem(property, archive, reference, context, services);
      if (type === 'fixedarray' || type === 'fixed-array' || type === 'fixed_array') {
        return serializeFixedArrayItem(property, archive, reference, context, services);
      }
      if (type === 'struct') return serializeStructItem(property, archive, reference, context, services);
      if (type === 'map') return serializeMapItem();
      if (type === 'bool') return serializeBoolItem(property, archive, reference, context, services);
      if (type === 'int' || type === 'float') {
        callRaw(archive, reference, 4, context, services);
        return { property, kind: type, measuredBytes: 4 };
      }
      if (type === 'byte') {
        callRaw(archive, reference, 1, context, services);
        return { property, kind: type, measuredBytes: 1 };
      }
      fail(`UProperty::SerializeItem (+0x78) does not dispatch ${String(kind)}; this property kind has no recovered serializer`, {
        kind, property, slot: '+0x78',
      });
  }
}

export default serializeScriptPropertyItem;
