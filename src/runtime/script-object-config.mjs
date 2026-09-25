/*
 * UObject::LoadLocalized, reached by Core's UClass::Register path.
 * The original DLL's gates and walks are reproduced here; a host binds
 * localization and property virtuals at the reached calls. LoadConfig is
 * translated in script-config.mjs (see docs/script-config.md).
 */

export const SCRIPT_OBJECT_CONFIG = Object.freeze({
  localized: Object.freeze({
    thunk: 0x1010306c,
    body: 0x10151390,
    localize: Object.freeze({thunk: 0x101015b4, body: 0x10148430}),
    linkGate: 0x101e5544,
  }),
  globals: Object.freeze({
    localizationTable: 0x101e5554,
    localizedLinkGate: 0x101e5544,
    names: 0x102961f0,
  }),
  flags: Object.freeze({
    classLocalized: 0x00000020,
    propertyLocalized: 0x00008000,
  }),
  offsets: Object.freeze({
    objectIndex: 0x04,
    objectOuter: 0x18,
    objectName: 0x20,
    objectClass: 0x24,
    classSuper: 0x28,
    classChildren: 0x38,
    classFlags: 0x484,
    propertyName: 0x20,
    propertyArrayDim: 0x34,
    propertyFlags: 0x3c,
    propertyElementSize: 0x38,
    propertyOffset: 0x48,
    propertyImport: 0x84,
    fieldNext: 0x2c,
  }),
  localizedArrayKeyFormat: '%s[%i]',
});

export class UnsupportedScriptObjectConfigError extends Error {
  constructor(message, {operation = null, branch = null, slot = null, property = null} = {}) {
    super(message);
    this.name = 'UnsupportedScriptObjectConfigError';
    this.code = 'UNSUPPORTED_SCRIPT_OBJECT_CONFIG';
    this.operation = operation;
    this.branch = branch;
    this.slot = slot;
    this.property = property;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptObjectConfigError(message, details);
}

function own(value, key) {
  return value !== null && value !== undefined && Object.hasOwn(value, key);
}

function first(value, keys, fallback = undefined) {
  for (const key of keys) {
    if (value !== null && value !== undefined && value[key] !== undefined) return value[key];
  }
  return fallback;
}

function integer(value, label, {minimum = null, maximum = null} = {}) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isInteger(number) ||
      (minimum !== null && number < minimum) ||
      (maximum !== null && number > maximum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function unsigned(value, label) {
  return integer(value, label, {minimum: 0, maximum: 0xffffffff}) >>> 0;
}

function isNullPointer(value) {
  return value === null || value === undefined || value === 0;
}

function nativeText(value) {
  if (typeof value !== 'string') return value;
  const terminator = value.indexOf('\u0000');
  return terminator < 0 ? value : value.slice(0, terminator);
}

function readInt32(buffer, offset) {
  if (buffer instanceof ArrayBuffer) {
    if (buffer.byteLength < offset + 4) return undefined;
    return new DataView(buffer).getInt32(offset, true);
  }
  if (ArrayBuffer.isView(buffer)) {
    if (buffer.byteLength < offset + 4) return undefined;
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(offset, true);
  }
  return undefined;
}

function callback(service, names) {
  for (const name of names) {
    const value = service?.[name];
    if (typeof value === 'function') return value;
  }
  return null;
}

function mapSlot(record, offset) {
  if (!(record?.nativeSlots instanceof Map) || !record.nativeSlots.has(offset)) return undefined;
  const holder = record.nativeSlots.get(offset);
  return holder && typeof holder === 'object' && own(holder, 'value') ? holder.value : holder;
}

function readSlot(record, offset, names, services, detail = {}) {
  const reader = callback(services, ['readSlot', 'readNativeSlot']);
  if (reader) {
    const value = reader(record, offset, {
      kind: 'uobject-config-read-slot', offset, ...detail,
    });
    if (value !== undefined) return value;
  }
  const raw = mapSlot(record, offset);
  if (raw !== undefined) return raw;
  return first(record, names, undefined);
}

function requiredSlot(record, offset, names, services, label, detail = {}) {
  const value = readSlot(record, offset, names, services, detail);
  if (value === undefined) {
    fail(`UObject config path requires ${label} (+0x${offset.toString(16)})`, {
      operation: detail.operation, slot: `+0x${offset.toString(16)}`, property: detail.property,
    });
  }
  return value;
}

function classSuper(record, services, operation) {
  const value = requiredSlot(record, SCRIPT_OBJECT_CONFIG.offsets.classSuper,
    ['superClass', 'Super', 'superclass', 'super'], services, 'UClass Super', {
      kind: 'class-super', operation, semantic: 'super',
    });
  return isNullPointer(value) ? null : value;
}

function resolveClassRecord(defaultObject, classArgument, services, operation) {
  const argument = isNullPointer(classArgument) ? null : classArgument;
  let record;
  if (argument !== null) {
    if (typeof argument === 'object') record = argument;
    else if (typeof services.resolveClassRecord === 'function') {
      record = services.resolveClassRecord(argument, {operation, defaultObject});
    }
    if (typeof record === 'function') record = record(defaultObject, classArgument, {operation});
    if (record === undefined || record === null) {
      fail(`${operation} could not resolve its non-null class argument`, {
        operation, slot: '+0x24', property: classArgument,
      });
    }
  } else {
    record = services.classRecord;
    if (typeof record === 'function') record = record(defaultObject, classArgument, {operation});
    if (record === undefined || record === null) {
      record = first(defaultObject, ['classRecord', 'objectClass', 'Class', 'class'], undefined);
    }
  }
  if (!record || typeof record !== 'object') {
    fail(`${operation} requires the resolved UClass record`, {operation, slot: '+0x24'});
  }
  return record;
}

function resolveObjectClass(defaultObject, fallback, services, operation) {
  let record = first(defaultObject, ['classRecord', 'objectClass', 'Class', 'class'], undefined);
  if (record === undefined || record === null) record = services.defaultObjectClass ?? fallback;
  if (typeof services.resolveObjectClass === 'function') {
    const resolved = services.resolveObjectClass(defaultObject, {operation, fallback, current: record});
    if (resolved !== undefined && resolved !== null) record = resolved;
  }
  return record;
}

function classFlags(record, services, operation) {
  const getter = callback(services, ['readClassFlags', 'getClassFlags']);
  let value = getter?.(record, {kind: 'class-flags', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.classFlags});
  if (value === undefined) value = first(record, ['classFlags', 'ClassFlags', 'flags'],
    first(record?.metadata, ['classFlags', 'ClassFlags', 'flags'], undefined));
  if (value === undefined && typeof services.read === 'function') {
    value = services.read(record, SCRIPT_OBJECT_CONFIG.offsets.classFlags, {
      kind: 'class-flags', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.classFlags,
    });
  }
  if (value === undefined || value === null) {
    fail(`${operation} requires UClass ClassFlags (+0x484)`, {
      operation, slot: '+0x484',
    });
  }
  return unsigned(value, 'UClass ClassFlags');
}

function objectIndex(defaultObject, services, operation, required = true) {
  const getter = callback(services, ['readObjectIndex', 'getObjectIndex', 'readIndex']);
  let value = getter?.(defaultObject, {
    kind: 'object-index', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.objectIndex,
  });
  if (value === undefined) value = first(defaultObject, ['index', 'Index', 'objectIndex'], undefined);
  if (value === undefined) value = readInt32(defaultObject, SCRIPT_OBJECT_CONFIG.offsets.objectIndex);
  if (value === undefined && !required) return undefined;
  if (value === undefined || value === null) {
    fail(`${operation} requires UObject Index (+0x04) for its per-object branch`, {
      operation, slot: '+0x04',
    });
  }
  return integer(value, 'UObject Index');
}

function readGlobal(services, address, operation, fallback = undefined, receiver = undefined) {
  const detail = {kind: 'global-read', operation, address};
  let value;
  const getter = callback(services, ['readGlobal', 'globalValue', 'readRawGlobal']);
  if (getter) value = getter(address, detail);
  else if (services.globals instanceof Map) value = services.globals.get(address);
  else if (services.globals && own(services.globals, address)) value = services.globals[address];
  else if (address === SCRIPT_OBJECT_CONFIG.localized.linkGate) {
    // Read an accessor-backed service once at this native call point.  The
    // original body performs one DWORD load; repeated property reads could
    // observe a host getter changing between the undefined/type/call checks.
    const linkGate = services.globalLinkGate;
    if (linkGate !== undefined) {
      value = typeof linkGate === 'function' ? linkGate(receiver, detail) : linkGate;
    }
  } else if (address === SCRIPT_OBJECT_CONFIG.globals.localizationTable) {
    const localizationTable = services.localizationTable;
    if (localizationTable !== undefined) {
      value = typeof localizationTable === 'function'
        ? localizationTable(detail) : localizationTable;
    }
  } else if (fallback !== undefined) value = fallback;
  if (value === undefined || value === null) {
    fail(`Missing live global 0x${address.toString(16)} for ${operation}`, {
      operation, slot: `[0x${address.toString(16)}]`,
    });
  }
  return unsigned(value, `global 0x${address.toString(16)}`);
}

function resolveText(value, services, detail, label) {
  if (typeof value === 'string') return nativeText(value);
  if (value && typeof value === 'object') {
    const nested = first(value, ['text', 'name', 'Name', 'value'], undefined);
    if (nested !== undefined && nested !== value) return resolveText(nested, services, detail, label);
  }
  const resolver = callback(services, ['resolveNameText', 'nameText', 'resolveText']);
  if (resolver) {
    const resolved = resolver(value, {...detail, label});
    if (resolved !== undefined && resolved !== null) return nativeText(String(resolved));
  }
  fail(`${detail.operation} requires ${label} text at its reached name-table branch`, {
    operation: detail.operation, slot: detail.slot ?? '[0x102961f0]',
  });
}

function fieldList(record, services, operation) {
  const walker = callback(services, ['walkProperties', 'walkFields', 'childrenOf']);
  let value;
  if (walker) value = walker(record, {
    kind: 'field-walk', operation, body: SCRIPT_OBJECT_CONFIG.localized.body,
      offsets: {children: SCRIPT_OBJECT_CONFIG.offsets.classChildren, next: SCRIPT_OBJECT_CONFIG.offsets.fieldNext},
  });
  if (value && !Array.isArray(value) && typeof value[Symbol.iterator] === 'function') value = [...value];
  if (value === undefined || value === null) {
    value = readSlot(record, SCRIPT_OBJECT_CONFIG.offsets.classChildren,
      ['children', 'Children'], services, {
        kind: 'class-children', operation, semantic: 'children',
      });
  }
  if (value === undefined) {
    fail(`${operation} reached UClass without its +0x38 Children binding`, {
      operation, slot: '+0x38', property: record,
    });
  }
  if (isNullPointer(value)) return [];
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') return [...value];

  // The native loop loads UField::Next only after the current field's
  // property work (including ImportText) has returned.  Keep that ordering
  // for the raw +0x38 Children path; callers using an explicit walker retain
  // the walker's existing eager result contract above.
  if (!walker) return liveFieldChain(value, services, operation);

  // A non-iterable result from an explicit walker is already an owned host
  // chain.  Preserve the historical eager conversion for that service path.
  const result = [], seen = new Set();
  for (let field = value; !isNullPointer(field); ) {
    if (seen.has(field)) throw new Error(`Cyclic ${operation} Children chain`);
    seen.add(field); result.push(field);
    field = requiredSlot(field, SCRIPT_OBJECT_CONFIG.offsets.fieldNext,
      ['next', 'Next', 'nextField', 'nextProperty'], services, 'UField Next', {
        kind: 'field-next', operation, semantic: 'next', property: field,
      });
  }
  return result;
}

function* liveFieldChain(head, services, operation) {
  const seen = new Set();
  let field = head;
  while (!isNullPointer(field)) {
    if (seen.has(field)) throw new Error(`Cyclic ${operation} Children chain`);
    seen.add(field);
    yield field;
    field = requiredSlot(field, SCRIPT_OBJECT_CONFIG.offsets.fieldNext,
      ['next', 'Next', 'nextField', 'nextProperty'], services, 'UField Next', {
        kind: 'field-next', operation, semantic: 'next', property: field,
      });
  }
}

function propertyKind(field, services, operation) {
  const detail = {
    kind: 'property-class-ancestry', operation,
    property: field, target: services.propertyClass ?? services.propertyClassRecord ?? services.propertyClassRef,
    offset: 0x24,
  };
  const predicate = callback(services, ['isProperty', 'isAProperty', 'propertyPredicate']);
  if (predicate) {
    const value = predicate(field, detail);
    if (![true, false, 0, 1].includes(value)) {
      fail(`${operation} property ancestry predicate returned no native boolean`, {
        operation, slot: '+0x24', property: field,
      });
    }
    return value === true || value === 1;
  }
  if (own(field, 'isProperty')) {
    if (![true, false, 0, 1].includes(field.isProperty)) {
      fail(`${operation} explicit property predicate returned no native boolean`, {
        operation, slot: '+0x24', property: field,
      });
    }
    return field.isProperty === true || field.isProperty === 1;
  }
  const target = detail.target;
  const isA = callback(services, ['isA', 'classIsA']);
  if (isA && target !== undefined && target !== null) {
    const value = isA(field, target, detail);
    if (![true, false, 0, 1].includes(value)) {
      fail(`${operation} property class ancestry returned no native boolean`, {
        operation, slot: '+0x24', property: field,
      });
    }
    return value === true || value === 1;
  }
  fail(`${operation} reached a field without its original UProperty ancestry binding`, {
    operation, slot: '+0x24', property: field,
  });
}

function propertyFlags(field, services, operation) {
  const property = propertyKind(field, services, operation);
  if (!property) return null;
  const getter = callback(services, ['readPropertyFlags', 'getPropertyFlags']);
  let value = getter?.(field, {
    kind: 'property-flags', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.propertyFlags,
  });
  if (value === undefined) value = first(field, ['propertyFlags', 'PropertyFlags', 'flags'],
    first(field?.metadata, ['propertyFlags', 'PropertyFlags', 'flags'], undefined));
  if (value === undefined && typeof services.read === 'function') {
    value = services.read(field, SCRIPT_OBJECT_CONFIG.offsets.propertyFlags, {
      kind: 'property-flags', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.propertyFlags,
    });
  }
  if (value === undefined || value === null) {
    fail(`${operation} reached a field without PropertyFlags (+0x3c)`, {
      operation, slot: '+0x3c', property: field,
    });
  }
  return unsigned(value, 'UProperty PropertyFlags');
}

function arrayDimension(field, services, operation) {
  const getter = callback(services, ['readArrayDim', 'getArrayDim']);
  let value = getter?.(field, {
    kind: 'property-array-dim', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.propertyArrayDim,
  });
  value ??= first(field, ['arrayDim', 'arrayDimension', 'ArrayDim'],
    first(field?.metadata, ['arrayDim', 'arrayDimension', 'ArrayDim'], undefined));
  if (value === undefined || value === null) {
    fail(`${operation} reached a property without ArrayDim (+0x34)`, {
      operation, slot: '+0x34', property: field,
    });
  }
  return integer(value, 'UProperty ArrayDim', {minimum: 0});
}

function propertyNameValue(field, services, operation) {
  const getter = callback(services, ['readPropertyName', 'getPropertyName']);
  let value = getter?.(field, {kind: 'property-name', operation, offset: SCRIPT_OBJECT_CONFIG.offsets.propertyName});
  if (value === undefined) value = first(field, ['name', 'Name', 'propertyName', 'key'],
    first(field?.metadata, ['name', 'Name', 'propertyName', 'key'], undefined));
  return resolveText(value, services, {operation, slot: '+0x20'}, 'UProperty Name');
}

function classNameValue(record, defaultObject, services, operation, perObject) {
  const resolver = callback(services, ['resolveLocalizedNames', 'localizedNames']);
  let value = resolver?.(record, {
    kind: 'localized-names', operation,
    record, defaultObject, perObject,
    offsets: SCRIPT_OBJECT_CONFIG.offsets,
  });
  if (!value || typeof value !== 'object') value = {};
  return value;
}

function objectOuter(defaultObject) {
  return first(defaultObject, ['outer', 'Outer', 'objectOuter'], undefined);
}

function objectName(defaultObject) {
  return first(defaultObject, ['nameText', 'Name', 'nameIndex', 'nameRef', 'objectName'], undefined);
}

function classOuter(record) {
  return first(record, ['outer', 'Outer', 'package', 'packageObject', 'within'], undefined);
}

function className(record) {
  return first(record, ['nameText', 'Name', 'nameIndex', 'nameRef'], undefined);
}

function resolveLocalizedNames(defaultObject, record, perObject, services) {
  const supplied = classNameValue(record, defaultObject, services, 'LoadLocalized', perObject);
  const detail = {operation: 'LoadLocalized', slot: '[0x102961f0]'};
  let packageValue = first(supplied, ['packageName', 'package', 'outerName'], undefined);
  if (packageValue === undefined) packageValue = first(record, ['packageName', 'outerName'], undefined);
  if (packageValue === undefined) packageValue = perObject ? objectOuter(defaultObject) : classOuter(record);
  let sectionValue = first(supplied, ['sectionName', 'section', 'objectName', 'className'], undefined);
  if (sectionValue === undefined) sectionValue = first(record, ['sectionName', 'section'], undefined);
  if (sectionValue === undefined) sectionValue = perObject ? objectName(defaultObject) : className(record);
  return {
    packageName: resolveText(packageValue, services, detail, 'localized package/outer name'),
    sectionName: resolveText(sectionValue, services, detail, 'localized object/class name'),
    supplied,
  };
}

function destination(defaultObject, field, index, detail, services) {
  const getter = callback(services, [
    'propertyDestination', 'destinationReference', 'propertyReference', 'resolvePropertyReference',
  ]);
  let value = getter?.(defaultObject, field, index, detail);
  if (value === undefined) value = first(field, ['destination', 'destinationReference', 'reference'], undefined);
  if (value === undefined && typeof field?.getReference === 'function') value = field.getReference(defaultObject, index, detail);
  if (value === undefined || value === null) {
    fail(`${detail.operation} reached property import without a mutable destination reference`, {
      operation: detail.operation, slot: '+0x48/+0x38', property: field,
    });
  }
  return value;
}

function callImporter(defaultObject, field, index, value, baseDetail, services) {
  const importer = callback(services, ['importLocalizedProperty', 'importProperty']);
  if (!importer) {
    fail(`${baseDetail.operation} reached UProperty::Import (+0x84) without an adapter`, {
      operation: baseDetail.operation, slot: '+0x84', property: field,
    });
  }
  const target = destination(defaultObject, field, index, baseDetail, services);
  const detail = {
    ...baseDetail,
    kind: 'uobject-import-localized-property',
    property: field,
    arrayIndex: index,
    destination: target,
    arguments: [value, target, 0],
    propertyImportSlot: SCRIPT_OBJECT_CONFIG.offsets.propertyImport,
  };
  const result = importer(detail, detail);
  return {detail, result};
}

function operationResult(operation, defaultObject, classRecord, args) {
  return {
    operation,
    body: SCRIPT_OBJECT_CONFIG.localized.body,
    thunk: SCRIPT_OBJECT_CONFIG.localized.thunk,
    receiver: defaultObject,
    classRecord,
    arguments: args,
    recursive: [],
    properties: [],
    resourceCalls: [],
    imports: [],
    operations: [],
    skipped: null,
  };
}

function markSkip(result, reason, detail = {}) {
  result.skipped = {reason, ...detail};
  result.operations.push({operation: 'skip', reason, ...detail});
  return result;
}

/**
 * Replay Core's UObject::LoadLocalized body (0x10151390). The `localize`
 * service receives the exact Localize argument order `[section,key,package,0,1]`.
 */
export function loadScriptLocalized(defaultObject, firstArgument = 0, classArgument = 0, services = {}) {
  const classRecord = resolveClassRecord(defaultObject, classArgument, services, 'LoadLocalized');
  const result = operationResult('LoadLocalized', defaultObject, classRecord,
    [firstArgument, isNullPointer(classArgument) ? 0 : classArgument]);
  const flags = classFlags(classRecord, services, 'LoadLocalized');
  if ((flags & SCRIPT_OBJECT_CONFIG.flags.classLocalized) === 0) {
    return markSkip(result, 'class-flag', {mask: SCRIPT_OBJECT_CONFIG.flags.classLocalized});
  }
  const linkGate = readGlobal(services, SCRIPT_OBJECT_CONFIG.localized.linkGate, 'LoadLocalized', undefined, classRecord);
  if (linkGate !== 0) return markSkip(result, 'localized-link-gate', {address: SCRIPT_OBJECT_CONFIG.localized.linkGate, value: linkGate});

  if (!isNullPointer(firstArgument)) {
    const parent = classSuper(classRecord, services, 'LoadLocalized');
    if (!isNullPointer(parent)) {
      const child = loadScriptLocalized(defaultObject, firstArgument, parent, services);
      result.recursive.push(child);
      result.operations.push({operation: 'load-localized-super', receiver: defaultObject, classRecord: parent,
        arguments: [firstArgument, parent]});
    }
  }

  const objectClass = resolveObjectClass(defaultObject, classRecord, services, 'LoadLocalized');
  const needsIndex = true;
  const index = objectIndex(defaultObject, services, 'LoadLocalized', needsIndex);
  const perObject = index !== -1;
  const fields = fieldList(classRecord, services, 'LoadLocalized');
  let fieldCount = 0;
  let matchingCount = 0;
  let names = null;
  let localize = null;
  for (const field of fields) {
    fieldCount += 1;
    const flagsValue = propertyFlags(field, services, 'LoadLocalized');
    if (flagsValue === null || (flagsValue & SCRIPT_OBJECT_CONFIG.flags.propertyLocalized) === 0) continue;
    const entry = {field, flags: flagsValue, arrayDim: arrayDimension(field, services, 'LoadLocalized')};
    matchingCount += 1;
    if (names === null) {
      names = resolveLocalizedNames(defaultObject, classRecord, perObject, services);
      localize = callback(services, ['localize', 'localizeResource', 'loadLocalizedProperty']);
      if (!localize) {
        fail('LoadLocalized reached a localized property without an explicit Localize adapter', {
          operation: 'LoadLocalized', slot: '0x10148430', property: entry.field,
        });
      }
    }
    const propertyName = propertyNameValue(entry.field, services, 'LoadLocalized');
    for (let indexValue = 0; indexValue < entry.arrayDim; indexValue++) {
      const key = entry.arrayDim === 1 ? propertyName : `${propertyName}[${indexValue}]`;
      const detail = {
        kind: 'uobject-load-localized-property', operation: 'LoadLocalized',
        body: SCRIPT_OBJECT_CONFIG.localized.body, thunk: SCRIPT_OBJECT_CONFIG.localized.thunk,
        receiver: defaultObject, defaultObject, classRecord, objectClass,
        property: entry.field, propertyFlags: entry.flags, arrayDim: entry.arrayDim,
        arrayIndex: indexValue, propertyName, key,
        sectionName: names.sectionName, packageName: names.packageName,
        localize: {
          thunk: SCRIPT_OBJECT_CONFIG.localized.localize.thunk,
          body: SCRIPT_OBJECT_CONFIG.localized.localize.body,
          arguments: [names.sectionName, key, names.packageName, 0, 1],
        },
        arguments: [names.sectionName, key, names.packageName, 0, 1],
        objectIndex: index, perObject,
      };
      const text = localize(detail, detail);
      result.resourceCalls.push(detail);
      result.operations.push({operation: 'localized-read', detail});
      if (text === undefined || text === null || text === '') continue;
      const imported = callImporter(defaultObject, entry.field, indexValue, text, detail, services);
      result.imports.push(imported.detail);
      result.operations.push({operation: 'localized-import', detail: imported.detail});
      result.properties.push({property: entry.field, arrayIndex: indexValue, value: text,
        read: detail, import: imported.detail});
    }
  }
  if (matchingCount === 0) return markSkip(result, 'empty-localized-properties', {fields: fieldCount});
  return result;
}

export const loadLocalized = loadScriptLocalized;
