/**
 * GC-mode serializers for Core's UField -> UStruct -> UState -> UClass chain.
 *
 * These functions are storage adapters around the original Core.dll bodies.
 * The object/name archive and the Core UObject serializer stay at explicit
 * host boundaries; this file owns the native order, raw widths, version gates,
 * and the GC branches of the four metadata serializers.
 */

export const SCRIPT_CLASS_SERIALIZE = Object.freeze({
  archiveConstructor: 0x1015eac0,
  archiveVtable: 0x1017a2f0,
  uField: Object.freeze({ vtable: 0x1017561c, thunk: 0x10101d8e, body: 0x10125c70 }),
  uStruct: Object.freeze({ vtable: 0x10175698, thunk: 0x10102b5d, body: 0x10126fe0 }),
  uState: Object.freeze({ vtable: 0x101757d8, thunk: 0x10101776, body: 0x10127590 }),
  uClass: Object.freeze({ vtable: 0x101758f4, thunk: 0x101011f9, body: 0x101280d0 }),
  serializeExpr: Object.freeze({ thunk: 0x1010281f, body: 0x101289c0 }),
  serializeTaggedProperties: Object.freeze({ thunk: 0x10102108, body: 0x10126730 }),
  serializeBin: Object.freeze({ thunk: 0x1010285b, body: 0x10126610 }),
  serializeGuid: Object.freeze({ thunk: 0x10102ff9, body: 0x1012ae20 }),
  serializeDependencies: Object.freeze({ thunk: 0x1010185c, body: 0x1012af20 }),
  serializePackageImports: Object.freeze({ thunk: 0x10101997, body: 0x1011e120 }),
  getPropertiesSize: Object.freeze({ thunk: 0x101026e4, body: 0x1010f7c0 }),
});

/** Raw words written by Core's collector archive constructor. */
export const SCRIPT_CLASS_GC_ARCHIVE_STATE = Object.freeze({
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

export class UnsupportedScriptClassSerializationError extends Error {
  constructor(message, { operation = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptClassSerializationError';
    this.code = 'UNSUPPORTED_SCRIPT_CLASS_SERIALIZATION';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptClassSerializationError(message, details);
}

function integer(value, label, { minimum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sourceState(archive, options) {
  const supplied = options.archiveState ?? archive.archiveState ?? archive;
  const read = (key, aliases, fallback) => {
    for (const alias of [key, ...aliases]) {
      if (supplied && supplied[alias] !== undefined) return numberOr(supplied[alias], fallback);
    }
    return fallback;
  };
  return {
    ar04: read('ar04', ['version'], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar04),
    ar08: read('ar08', ['licenseeVersion'], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar08),
    ar0c: read('ar0c', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar0c),
    ar10: read('ar10', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar10),
    ar14: read('ar14', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar14),
    ar18: read('ar18', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar18),
    ar1c: read('ar1c', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar1c),
    ar20: read('ar20', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar20),
    ar24: read('ar24', [], SCRIPT_CLASS_GC_ARCHIVE_STATE.ar24),
  };
}

function requireArchive(archive) {
  if (!archive || typeof archive !== 'object') {
    throw new TypeError('Core metadata Serialize requires an FArchive record');
  }
  if (typeof archive.objectReference !== 'function' &&
      typeof archive.serializeObject !== 'function') {
    throw new TypeError(
      'Core metadata Serialize requires archive.objectReference(reference) or archive.serializeObject(reference)',
    );
  }
  if (typeof archive.nameReference !== 'function' &&
      typeof archive.serializeName !== 'function') {
    throw new TypeError(
      'Core metadata Serialize requires archive.nameReference(reference) or archive.serializeName(reference)',
    );
  }
}

function archiveStateOf(archive, options) {
  const state = sourceState(archive, options);
  for (const key of ['ar04', 'ar08', 'ar0c', 'ar10', 'ar14', 'ar18', 'ar1c', 'ar20', 'ar24']) {
    if (state[key] !== SCRIPT_CLASS_GC_ARCHIVE_STATE[key]) {
      fail(`Core metadata GC Serialize requires FArchive ${key} == ${SCRIPT_CLASS_GC_ARCHIVE_STATE[key]}`, {
        operation: 'serializeScriptClass', slot: key,
      });
    }
  }
  return state;
}

function asHolder(value, object, aliases, descriptor, { optional = false } = {}) {
  const resolved = typeof value === 'function' ? value(object, descriptor) : value;
  if (resolved && typeof resolved.get === 'function' && typeof resolved.set === 'function') {
    return resolved;
  }
  if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
    return {
      reference: true,
      key: descriptor.key,
      get: () => resolved.value,
      set: next => { resolved.value = next; return next; },
    };
  }
  if (typeof resolved === 'string' && object && Object.hasOwn(object, resolved)) {
    return {
      reference: true,
      key: descriptor.key,
      get: () => object[resolved],
      set: next => { object[resolved] = next; return next; },
    };
  }
  if (resolved === undefined && object) {
    const key = aliases.find(name => Object.hasOwn(object, name));
    if (key) {
      return {
        reference: true,
        key: descriptor.key,
        get: () => object[key],
        set: next => { object[key] = next; return next; },
      };
    }
  }
  if (optional) return null;
  throw new TypeError(`Missing mutable Core metadata slot ${descriptor.key}`);
}

function layoutFor(context) {
  return context.services.layout ?? context.services.objectLayout ?? context.services.slots ?? {};
}

function slot(context, object, key, aliases = [], { optional = false, fallback = undefined } = {}) {
  const layout = layoutFor(context);
  const descriptor = {
    kind: 'script-metadata',
    key: `metadata.${key}`,
    slot: key,
    offset: context.offsets?.[key] ?? null,
    object,
  };
  const explicit = layout[key] ?? layout[aliases.find(alias => layout[alias] !== undefined)];
  if (explicit === undefined && typeof context.services.slot === 'function' && descriptor.offset !== null) {
    const byOffset = context.services.slot(object, descriptor.offset, descriptor);
    if (byOffset !== undefined) return asHolder(byOffset, object, [key, ...aliases], descriptor, { optional });
  }
  const value = explicit === undefined ? fallback : explicit;
  return asHolder(value, object, [key, ...aliases], descriptor, { optional });
}

function emitObject(context, reference, descriptor) {
  context.references += 1;
  context.events.push({ kind: 'object-reference', ...descriptor, value: reference.get() });
  if (typeof context.archive.objectReference === 'function') {
    return context.archive.objectReference(reference, descriptor);
  }
  return context.archive.serializeObject(reference, descriptor);
}

function emitName(context, reference, descriptor) {
  context.nameReferences += 1;
  context.events.push({ kind: 'name-reference', ...descriptor, value: reference.get() });
  if (typeof context.archive.nameReference === 'function') {
    return context.archive.nameReference(reference, descriptor);
  }
  return context.archive.serializeName(reference, descriptor);
}

function emitRaw(context, reference, size, descriptor) {
  const callback = context.services.serializeRaw ?? context.archive.serializeRaw;
  const event = { kind: 'raw', ...descriptor, size, value: reference.get(), skipped: typeof callback !== 'function' };
  context.rawCalls.push(event);
  context.events.push(event);
  if (typeof callback === 'function') return callback(reference, size, descriptor);
  // The collector inherits FArchive::Serialize's no-op implementation at
  // Core 0x10106760.  Keep this as an explicit reported boundary, not a
  // silent omission, when a host has no raw observer.
  return undefined;
}

function emitCountBytes(context, first, second, descriptor) {
  const callback = context.services.countBytes ?? context.archive.countBytes;
  const event = { kind: 'count-bytes', ...descriptor, first, second, skipped: typeof callback !== 'function' };
  context.countCalls.push(event);
  context.events.push(event);
  if (typeof callback !== 'function') return { called: false, skipped: true };
  return { called: true, skipped: false, value: callback(first, second, descriptor) };
}

function requireService(context, name, operation, slotName) {
  const callback = context.services[name] ?? context.archive[name];
  if (typeof callback !== 'function') {
    const displayName = {
      serializeExpr: 'SerializeExpr',
      serializeTaggedProperties: 'SerializeTaggedProperties',
      serializeBin: 'SerializeBin',
      serializeDependencies: 'SerializeDependencies',
      serializePackageImports: 'SerializePackageImports',
      getPropertiesSize: 'GetPropertiesSize',
    }[name] ?? name;
    fail(`${operation} requires the original ${displayName} adapter`, { operation, slot: slotName });
  }
  return callback;
}

function makeContext(object, archive, services) {
  if (!object || typeof object !== 'object') throw new TypeError('Expected a Core metadata object record');
  requireArchive(archive);
  const state = archiveStateOf(archive, services);
  return {
    object,
    archive,
    services,
    state,
    offsets: {
      baseField: 0x28, next: 0x2c, scriptText: 0x34, children: 0x38, friendlyName: 0x40,
      line: 0x54, textPosition: 0x50, scriptSize: 0x48,
      probeMask: 0x6c, ignoreMask: 0x74, labelTableOffset: 0x80, stateFlags: 0x7c,
      classFlags: 0x484, guid: 0x48c, dependencies: 0x4bc, packageImports: 0x4c8,
      classWithin: 0x49c, classConfigName: 0x4a0, defaults: 0x4d4, defaultsSize: 0x4d8,
      defaultsCapacity: 0x4dc, linker: 0x10,
    },
    events: [],
    rawCalls: [],
    countCalls: [],
    references: 0,
    nameReferences: 0,
    helperCalls: [],
    baseResults: [],
  };
}

function baseSerialize(context, object) {
  const callback = context.services.serializeUObject ?? context.archive.serializeUObject;
  if (typeof callback !== 'function') {
    fail('UField::Serialize requires the verified UObject::Serialize base service', {
      operation: 'UField::Serialize', slot: 'serializeUObject',
    });
  }
  const result = callback(object, context.archive, { kind: 'uobject-base', body: 0x10150210 });
  context.baseResults.push(result);
  context.events.push({ kind: 'serialize-uobject', body: 0x10150210 });
  return result;
}

function fieldSlots(context, object) {
  return {
    baseField: slot(context, object, 'baseField', ['BaseField', 'base', 'baseRef']),
    next: slot(context, object, 'next', ['Next', 'nextRef']),
  };
}

function serializeUFieldInternal(context, object) {
  const baseResult = baseSerialize(context, object);
  const fields = fieldSlots(context, object);
  emitObject(context, fields.baseField, {
    kind: 'u-field', key: 'UField.BaseField', slot: 'BaseField', offset: 0x28, object,
  });
  emitObject(context, fields.next, {
    kind: 'u-field', key: 'UField.Next', slot: 'Next', offset: 0x2c, object,
  });
  return { kind: 'UField', baseResult, baseField: fields.baseField.get(), next: fields.next.get() };
}

function serializeExpr(context, object, scriptSize) {
  if (scriptSize === 0) return { called: false, start: 0, end: 0, warnings: [] };
  const callback = requireService(context, 'serializeExpr', 'UStruct::Serialize', 'SerializeExpr');
  let offset = 0;
  const warnings = [];
  let calls = 0;
  while (offset < scriptSize) {
    const before = offset;
    const offsetReference = {
      reference: true,
      key: 'UStruct.ScriptExprOffset',
      get: () => offset,
      set: next => { offset = integer(next, 'SerializeExpr offset', { minimum: 0 }); return offset; },
    };
    const result = callback(object, offsetReference, context.archive, {
      kind: 'serialize-expr', body: SCRIPT_CLASS_SERIALIZE.serializeExpr.body,
      offset: before, scriptSize, object,
    });
    const returned = typeof result === 'number' ? result : result?.nextOffset;
    if (returned !== undefined) offsetReference.set(returned);
    if (offset <= before) {
      fail(`SerializeExpr did not advance the script offset at ${before}`, {
        operation: 'UStruct::Serialize', slot: 'SerializeExpr',
      });
    }
    context.events.push({ kind: 'serialize-expr', offset: before, nextOffset: offset });
    calls += 1;
    if (calls > scriptSize + 1) {
      fail('SerializeExpr exceeded the native script-size progress bound', {
        operation: 'UStruct::Serialize', slot: 'SerializeExpr',
      });
    }
  }
  if (offset !== scriptSize) {
    const warning = { object, scriptSize, offset };
    warnings.push(warning);
    context.services.onScriptSizeWarning?.(warning);
    context.events.push({ kind: 'script-size-warning', ...warning });
  }
  return { called: true, start: 0, end: offset, calls, warnings };
}

function serializeUStructInternal(context, object) {
  const fieldResult = serializeUFieldInternal(context, object);
  const links = {
    scriptText: slot(context, object, 'scriptText', ['ScriptText', 'scriptTextRef']),
    children: slot(context, object, 'children', ['Children', 'childrenRef']),
  };
  emitObject(context, links.scriptText, {
    kind: 'u-struct', key: 'UStruct.ScriptText', slot: 'ScriptText', offset: 0x34, object,
  });
  emitObject(context, links.children, {
    kind: 'u-struct', key: 'UStruct.Children', slot: 'Children', offset: 0x38, object,
  });

  const friendlyName = slot(context, object, 'friendlyName', ['FriendlyName', 'name', 'Name']);
  emitName(context, friendlyName, {
    kind: 'u-struct', key: 'UStruct.FriendlyName', slot: 'FriendlyName', offset: 0x40, object,
  });
  if (friendlyName.get() === null || friendlyName.get() === undefined || friendlyName.get() === 0) {
    fail('UStruct::Serialize rejected a null FriendlyName after archive +0x1c', {
      operation: 'UStruct::Serialize', slot: '+0x40',
    });
  }

  const line = slot(context, object, 'line', ['Line']);
  const textPosition = slot(context, object, 'textPosition', ['TextPos', 'textPos']);
  const scriptSizeSlot = slot(context, object, 'scriptSize', ['ScriptSize', 'size']);
  const scriptSize = integer(scriptSizeSlot.get(), 'UStruct script size', { minimum: 0 });
  emitRaw(context, line, 4, {
    kind: 'u-struct', key: 'UStruct.Line', slot: 'Line', offset: 0x54, object,
  });
  emitRaw(context, textPosition, 4, {
    kind: 'u-struct', key: 'UStruct.TextPos', slot: 'TextPos', offset: 0x50, object,
  });
  emitRaw(context, scriptSizeSlot, 4, {
    kind: 'u-struct', key: 'UStruct.ScriptSize', slot: 'ScriptSize', offset: 0x48, object,
  });
  const script = serializeExpr(context, object, scriptSize);
  return {
    kind: 'UStruct', field: fieldResult,
    scriptText: links.scriptText.get(), children: links.children.get(), friendlyName: friendlyName.get(),
    line: line.get(), textPosition: textPosition.get(), scriptSize,
    script,
  };
}

function serializeUStateInternal(context, object) {
  const structResult = serializeUStructInternal(context, object);
  const probeMask = slot(context, object, 'probeMask', ['ProbeMask']);
  const ignoreMask = slot(context, object, 'ignoreMask', ['IgnoreMask']);
  const labelTableOffset = slot(context, object, 'labelTableOffset', ['LabelTableOffset']);
  const stateFlags = slot(context, object, 'stateFlags', ['StateFlags']);
  emitRaw(context, probeMask, 8, {
    kind: 'u-state', key: 'UState.ProbeMask', slot: 'ProbeMask', offset: 0x6c, object,
  });
  emitRaw(context, ignoreMask, 8, {
    kind: 'u-state', key: 'UState.IgnoreMask', slot: 'IgnoreMask', offset: 0x74, object,
  });
  emitRaw(context, labelTableOffset, 2, {
    kind: 'u-state', key: 'UState.LabelTableOffset', slot: 'LabelTableOffset', offset: 0x80, object,
  });
  emitRaw(context, stateFlags, 4, {
    kind: 'u-state', key: 'UState.StateFlags', slot: 'StateFlags', offset: 0x7c, object,
  });
  return {
    kind: 'UState', struct: structResult,
    probeMask: probeMask.get(), ignoreMask: ignoreMask.get(),
    labelTableOffset: labelTableOffset.get(), stateFlags: stateFlags.get(),
  };
}

function indexedHolder(array, index, descriptor) {
  return {
    reference: true,
    key: descriptor.key,
    get: () => array[index],
    set: value => { array[index] = value; return value; },
  };
}

function arrayInfo(context, object, key, aliases, descriptor) {
  const layout = layoutFor(context);
  const explicit = layout[key] ?? layout[aliases.find(alias => layout[alias] !== undefined)];
  const source = explicit === undefined ? undefined : explicit;
  let value = source;
  if (value === undefined) {
    for (const alias of aliases) {
      if (Object.hasOwn(object, alias)) { value = object[alias]; break; }
    }
  }
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return {
      items: value, count: value.length, max: value.length, source: value,
      countReference: { reference: true, key: `${descriptor.key}.Count`, get: () => value.length,
        set: next => { if (Number(next) !== value.length) value.length = integer(next, `${key} count`, { minimum: 0 }); return next; } },
    };
  }
  if (value && typeof value === 'object' && Array.isArray(value.data)) {
    const count = integer(value.count ?? value.num ?? value.length ?? value.data.length, `${key} count`, { minimum: 0 });
    const max = integer(value.max ?? value.capacity ?? value.data.length, `${key} max`, { minimum: count });
    return {
      items: value.data, count, max, source: value,
      countReference: { reference: true, key: `${descriptor.key}.Count`, get: () => Number(value.count ?? value.num ?? value.data.length),
        set: next => { value.count = integer(next, `${key} count`, { minimum: 0 }); return next; } },
    };
  }
  if (value && typeof value === 'object' && Array.isArray(value.items)) {
    const count = integer(value.count ?? value.items.length, `${key} count`, { minimum: 0 });
    const max = integer(value.max ?? value.capacity ?? value.items.length, `${key} max`, { minimum: count });
    return {
      items: value.items, count, max, source: value,
      countReference: { reference: true, key: `${descriptor.key}.Count`, get: () => Number(value.count ?? value.items.length),
        set: next => { value.count = integer(next, `${key} count`, { minimum: 0 }); return next; } },
    };
  }
  fail(`Unresolved ${key} array layout`, { operation: 'UClass::Serialize', slot: descriptor.slot });
}

function itemHolder(item, key, descriptor) {
  if (item && typeof item.get === 'function' && typeof item.set === 'function' && key === null) return item;
  if (!item || typeof item !== 'object') {
    throw new TypeError(`Expected ${descriptor.key} record`);
  }
  const aliases = key === 'class' ? ['class', 'Class', 'object', 'value'] :
    key === 'deep' ? ['deep', 'Deep'] : ['scriptTextCRC', 'scriptCRC', 'crc', 'ScriptTextCRC'];
  const actual = aliases.find(name => Object.hasOwn(item, name));
  if (!actual) throw new TypeError(`Missing ${descriptor.key} slot`);
  return {
    reference: true,
    key: descriptor.key,
    get: () => item[actual],
    set: value => { item[actual] = value; return value; },
  };
}

function serializeDependencies(context, object) {
  const info = arrayInfo(context, object, 'dependencies', ['dependencies', 'Dependencies'], {
    kind: 'u-class', slot: 'Dependencies', key: 'UClass.Dependencies', object,
  });
  if (!info) {
    const callback = requireService(context, 'serializeDependencies', 'UClass::Serialize', 'Dependencies');
    context.helperCalls.push({ kind: 'dependencies', body: SCRIPT_CLASS_SERIALIZE.serializeDependencies.body });
    return { called: true, adapter: true, result: callback(object, context.archive, {
      kind: 'class-dependencies', body: SCRIPT_CLASS_SERIALIZE.serializeDependencies.body, object,
    }) };
  }
  const bytes = emitCountBytes(context, info.count * 12, info.max * 12, {
    kind: 'u-class', key: 'UClass.Dependencies.CountBytes', slot: 'Dependencies', stride: 12, count: info.count, max: info.max,
  });
  // The helper calls FCompactIndex on FArray::Num even in the collector
  // branch.  FCompactIndex itself takes the GC raw four-byte route.
  emitRaw(context, info.countReference, 4, {
    kind: 'u-class-dependency', key: 'UClass.Dependencies.Count', slot: 'Count', offset: 4, object,
  });
  const count = integer(info.countReference.get(), 'Dependencies count after FCompactIndex', { minimum: 0 });
  const entries = [];
  for (let index = 0; index < count; index++) {
    const item = info.items[index];
    const prefix = `UClass.Dependencies[${index}]`;
    const classReference = itemHolder(item, 'class', { key: `${prefix}.Class`, slot: 'Dependencies.Class' });
    emitObject(context, classReference, {
      kind: 'u-class-dependency', key: `${prefix}.Class`, slot: 'Class', offset: 0, index, object,
    });
    const deep = itemHolder(item, 'deep', { key: `${prefix}.Deep`, slot: 'Dependencies.Deep' });
    const crc = itemHolder(item, 'scriptTextCRC', { key: `${prefix}.ScriptTextCRC`, slot: 'Dependencies.ScriptTextCRC' });
    emitRaw(context, deep, 4, {
      kind: 'u-class-dependency', key: `${prefix}.Deep`, slot: 'Deep', offset: 4, index, object,
    });
    emitRaw(context, crc, 4, {
      kind: 'u-class-dependency', key: `${prefix}.ScriptTextCRC`, slot: 'ScriptTextCRC', offset: 8, index, object,
    });
    entries.push({ class: classReference.get(), deep: deep.get(), scriptTextCRC: crc.get() });
  }
  return { called: true, adapter: false, count, max: info.max, bytes, entries };
}

function serializePackageImports(context, object) {
  const info = arrayInfo(context, object, 'packageImports', ['packageImports', 'PackageImports'], {
    kind: 'u-class', slot: 'PackageImports', key: 'UClass.PackageImports', object,
  });
  if (!info) {
    const callback = requireService(context, 'serializePackageImports', 'UClass::Serialize', 'PackageImports');
    context.helperCalls.push({ kind: 'package-imports', body: SCRIPT_CLASS_SERIALIZE.serializePackageImports.body });
    return { called: true, adapter: true, result: callback(object, context.archive, {
      kind: 'class-package-imports', body: SCRIPT_CLASS_SERIALIZE.serializePackageImports.body, object,
    }) };
  }
  const bytes = emitCountBytes(context, info.count * 4, info.max * 4, {
    kind: 'u-class', key: 'UClass.PackageImports.CountBytes', slot: 'PackageImports', stride: 4, count: info.count, max: info.max,
  });
  // As in the dependency helper, this is a resolved FCompactIndex call whose
  // collector implementation serializes the mutable count as four raw bytes.
  emitRaw(context, info.countReference, 4, {
    kind: 'u-class-package-import', key: 'UClass.PackageImports.Count', slot: 'Count', offset: 4, object,
  });
  const count = integer(info.countReference.get(), 'PackageImports count after FCompactIndex', { minimum: 0 });
  const entries = [];
  for (let index = 0; index < count; index++) {
    const reference = indexedHolder(info.items, index, {
      key: `UClass.PackageImports[${index}]`, slot: 'PackageImports',
    });
    emitName(context, reference, {
      kind: 'u-class-package-import', key: `UClass.PackageImports[${index}]`, slot: 'PackageImports', offset: index * 4, index, object,
    });
    entries.push(reference.get());
  }
  return { called: true, adapter: false, count, max: info.max, bytes, entries };
}

function guidStorage(context, object) {
  const layout = layoutFor(context);
  let source = layout.guidWords ?? layout.guid;
  if (source === undefined) source = object.guidWords ?? object.guid ?? object.ClassGuid;
  if (source === undefined || source === null) {
    throw new TypeError('Missing mutable UClass +0x48c GUID storage');
  }
  const base = source && (Array.isArray(source) || ArrayBuffer.isView(source) || Array.isArray(source.words))
    ? { get: () => source, set: next => next }
    : asHolder(source, object, [], { key: 'UClass.ClassGuid', slot: 'ClassGuid' });
  const readWord = index => {
    const value = base.get();
    if (value && Array.isArray(value.words)) return Number(value.words[index]) >>> 0;
    if (Array.isArray(value)) {
      if (value.length === 4) return Number(value[index]) >>> 0;
      if (value.length === 16) {
        return (Number(value[index * 4]) |
          (Number(value[index * 4 + 1]) << 8) |
          (Number(value[index * 4 + 2]) << 16) |
          (Number(value[index * 4 + 3]) << 24)) >>> 0;
      }
    }
    if (ArrayBuffer.isView(value) && value.byteLength === 16) {
      return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(index * 4, true);
    }
    throw new TypeError('UClass ClassGuid must expose four words or sixteen bytes');
  };
  const writeWord = (index, next) => {
    const value = base.get();
    const word = Number(next) >>> 0;
    if (value && Array.isArray(value.words)) { value.words[index] = word; return word; }
    if (Array.isArray(value)) {
      if (value.length === 4) { value[index] = word; return word; }
      if (value.length === 16) {
        for (let byte = 0; byte < 4; byte++) value[index * 4 + byte] = (word >>> (byte * 8)) & 0xff;
        return word;
      }
    }
    if (ArrayBuffer.isView(value) && value.byteLength === 16) {
      new DataView(value.buffer, value.byteOffset, value.byteLength).setUint32(index * 4, word, true);
      return word;
    }
    throw new TypeError('UClass ClassGuid must expose four words or sixteen bytes');
  };
  return index => ({
    reference: true,
    key: `UClass.ClassGuid[${index}]`,
    get: () => readWord(index),
    set: next => writeWord(index, next),
  });
}

function defaultsStorage(context, object) {
  const layout = layoutFor(context);
  let source = layout.defaults;
  if (source === undefined) source = object.defaults ?? object.Defaults;
  if (source && typeof source.get === 'function' && typeof source.set === 'function') source = source.get();
  if (source === undefined) {
    if (Object.hasOwn(object, 'defaultsData') || Object.hasOwn(object, 'defaultsSize') || Object.hasOwn(object, 'defaultsMax')) {
      source = {
        data: object.defaultsData,
        size: object.defaultsSize,
        capacity: object.defaultsMax,
      };
    } else {
      fail('UClass::Serialize requires the +0x4d4 Defaults FArray adapter', {
        operation: 'UClass::Serialize', slot: 'Defaults',
      });
    }
  }
  if (ArrayBuffer.isView(source) || Array.isArray(source)) {
    return { data: source, size: source.length, capacity: source.length };
  }
  if (!source || typeof source !== 'object') throw new TypeError('Invalid UClass Defaults FArray');
  const data = source.data ?? source.Data ?? source.bytes ?? null;
  const size = integer(source.size ?? source.count ?? source.num ?? 0, 'UClass Defaults size', { minimum: 0 });
  const capacity = integer(source.capacity ?? source.max ?? size, 'UClass Defaults capacity', { minimum: size });
  return { data, size, capacity, source };
}

function propertiesSize(context, object) {
  const callback = requireService(context, 'getPropertiesSize', 'UClass::Serialize', 'GetPropertiesSize');
  const value = callback(object, { kind: 'get-properties-size', body: SCRIPT_CLASS_SERIALIZE.getPropertiesSize.body, object });
  return integer(value, 'UClass serialized property size', { minimum: 0 });
}

function checkPropertiesSize(context, object, expected, phase) {
  const actual = propertiesSize(context, object);
  context.events.push({ kind: 'properties-size', phase, expected, actual, object });
  if (actual !== expected) {
    const mismatch = { object, expected, actual, phase };
    context.services.onPropertiesSizeMismatch?.(mismatch);
    fail(`UClass::Serialize property size mismatch during ${phase}: expected ${expected}, got ${actual}`, {
      operation: 'UClass::Serialize', slot: '+0x4d8',
    });
  }
  return actual;
}

function serializeDefaults(context, object, fieldResult) {
  const defaults = defaultsStorage(context, object);
  const linker = slot(context, object, 'linker', ['Linker'], { optional: true });
  const linkerValue = linker?.get() ?? null;
  if (linkerValue !== null && linkerValue !== undefined) {
    checkPropertiesSize(context, object, defaults.size, 'linker');
  }

  const tagged = requireService(context, 'serializeTaggedProperties', 'UClass::Serialize', 'SerializeTaggedProperties');
  const baseField = fieldResult.baseField ?? fieldResult.field?.baseField;
  context.helperCalls.push({ kind: 'tagged-properties', body: SCRIPT_CLASS_SERIALIZE.serializeTaggedProperties.body });
  const taggedResult = tagged(context.archive, defaults.data, baseField, {
    kind: 'serialize-tagged-properties', body: SCRIPT_CLASS_SERIALIZE.serializeTaggedProperties.body,
    object, baseField, defaults,
    services: context.services.taggedPropertyServices ?? context.services,
  });
  context.events.push({ kind: 'serialize-tagged-properties', object });

  // 0x1012835a calls UClass vtable +0x64 after +0x74 regardless of Linker.
  const size = checkPropertiesSize(context, object, defaults.size, 'post-tagged-properties');
  const countBytes = emitCountBytes(context, defaults.size, defaults.capacity, {
    kind: 'u-class', key: 'UClass.Defaults.CountBytes', slot: 'Defaults',
    offset: 0x4d4, size: defaults.size, capacity: defaults.capacity, object,
  });
  const bin = requireService(context, 'serializeBin', 'UClass::Serialize', 'SerializeBin');
  context.helperCalls.push({ kind: 'serialize-bin', body: SCRIPT_CLASS_SERIALIZE.serializeBin.body });
  const binResult = bin(context.archive, defaults.data, {
    kind: 'serialize-bin', body: SCRIPT_CLASS_SERIALIZE.serializeBin.body, object, defaults,
  });
  context.events.push({ kind: 'serialize-bin', object });
  return { defaults, linker: linkerValue, taggedResult, size, countBytes, binResult };
}

function serializeUClassInternal(context, object) {
  const stateResult = serializeUStateInternal(context, object);
  const classFlags = slot(context, object, 'classFlags', ['ClassFlags', 'clsFlags']);
  emitRaw(context, classFlags, 4, {
    kind: 'u-class', key: 'UClass.ClassFlags', slot: 'ClassFlags', offset: 0x484, object,
  });

  const guidWord = guidStorage(context, object);
  for (let index = 0; index < 4; index++) {
    emitRaw(context, guidWord(index), 4, {
      kind: 'u-class-guid', key: `UClass.ClassGuid[${index}]`, slot: 'ClassGuid', offset: 0x48c + index * 4, index, object,
    });
  }

  const dependencies = serializeDependencies(context, object);
  const packageImports = serializePackageImports(context, object);

  // Version 68/69 takes the >=62 branch at 0x10128166.
  const classWithin = slot(context, object, 'classWithin', ['ClassWithin', 'within']);
  const classConfigName = slot(context, object, 'classConfigName', ['ClassConfigName', 'configName']);
  emitObject(context, classWithin, {
    kind: 'u-class', key: 'UClass.ClassWithin', slot: 'ClassWithin', offset: 0x49c, object,
  });
  emitName(context, classConfigName, {
    kind: 'u-class', key: 'UClass.ClassConfigName', slot: 'ClassConfigName', offset: 0x4a0, object,
  });

  // FArchive+0x0c is zero in the collector constructor, so the save/load,
  // Config, Localized, and old-default reconstruction branches are not taken.
  const defaults = serializeDefaults(context, object, stateResult.struct.field);
  return {
    kind: 'UClass', state: stateResult,
    classFlags: classFlags.get(), guid: [0, 1, 2, 3].map(index => guidWord(index).get()),
    dependencies, packageImports,
    classWithin: classWithin.get(), classConfigName: classConfigName.get(),
    defaults,
  };
}

function finish(context, result) {
  return {
    ...result,
    archiveState: context.state,
    events: context.events,
    rawCalls: context.rawCalls,
    countCalls: context.countCalls,
    references: context.references,
    nameReferences: context.nameReferences,
    helperCalls: context.helperCalls,
  };
}

export function serializeUField(object, archive, services = {}) {
  const context = makeContext(object, archive, services);
  return finish(context, serializeUFieldInternal(context, object));
}

export function serializeUStruct(object, archive, services = {}) {
  const context = makeContext(object, archive, services);
  return finish(context, serializeUStructInternal(context, object));
}

export function serializeUState(object, archive, services = {}) {
  const context = makeContext(object, archive, services);
  return finish(context, serializeUStateInternal(context, object));
}

export function serializeUClass(object, archive, services = {}) {
  const context = makeContext(object, archive, services);
  return finish(context, serializeUClassInternal(context, object));
}

export function serializeScriptClass(object, archive, services = {}) {
  const kind = String(services.kind ?? object?.metadataKind ?? object?.kind ?? object?.className ?? '').toLowerCase();
  if (kind === 'ufield' || kind === 'field') return serializeUField(object, archive, services);
  if (kind === 'ustruct' || kind === 'struct') return serializeUStruct(object, archive, services);
  if (kind === 'ustate' || kind === 'state') return serializeUState(object, archive, services);
  if (kind === 'uclass' || kind === 'class') return serializeUClass(object, archive, services);
  const vtable = Number(object?.nativeVtable);
  if (vtable === SCRIPT_CLASS_SERIALIZE.uClass.vtable) return serializeUClass(object, archive, services);
  if (vtable === SCRIPT_CLASS_SERIALIZE.uState.vtable) return serializeUState(object, archive, services);
  if (vtable === SCRIPT_CLASS_SERIALIZE.uStruct.vtable) return serializeUStruct(object, archive, services);
  if (vtable === SCRIPT_CLASS_SERIALIZE.uField.vtable) return serializeUField(object, archive, services);
  throw new TypeError(`Unknown Core metadata serializer kind ${kind || '<missing>'}`);
}

export const serializeClassMetadata = serializeScriptClass;
