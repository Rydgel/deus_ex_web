/**
 * Reference serialization for the original UE1 script object layout.
 *
 * The archive is deliberately a host boundary.  It owns the collector's
 * mark/recursion policy and receives mutable lvalues through
 * `objectReference(reference, context)`.  This module only reproduces the
 * order and filtering performed by Core.dll's UObject/UStruct serializers.
 */
import {cloneMetadata} from './clone-metadata.mjs';

const TYPE_BY_CLASS = Object.freeze({
  ByteProperty: 'byte',
  IntProperty: 'int',
  BoolProperty: 'bool',
  FloatProperty: 'float',
  NameProperty: 'name',
  StrProperty: 'string',
  ObjectProperty: 'object',
  ClassProperty: 'class',
  StructProperty: 'struct',
  ArrayProperty: 'array',
  MapProperty: 'map',
  FixedArrayProperty: 'fixedArray',
});

const TYPE_OBJECT = new Set(['object', 'class']);
const SCALAR_TYPES = new Set(['byte', 'int', 'bool', 'float', 'string']);
const NATIVE_VECTOR = 'core.object.vector';
const NATIVE_ROTATOR = 'core.object.rotator';

/** Raw UProperty flags tested by UStruct::SerializeBin at 1012666f. */
export const REFERENCE_PROPERTY_FLAGS = Object.freeze({
  SkipSerialization: 0x00001000,
  Transient: 0x00002000,
});

/** Raw UObject flag tested before the FStateFrame path in UObject::Serialize. */
export const STATE_FRAME_FLAG = 0x02000000;

/** A native serializer or metadata branch not established by the local evidence. */
export class UnsupportedScriptReferenceSerializationError extends Error {
  constructor(message, { key = null, type = null, operation = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptReferenceSerializationError';
    this.code = 'UNSUPPORTED_SCRIPT_REFERENCE_SERIALIZATION';
    this.key = key;
    this.type = type;
    this.operation = operation;
  }
}

function fieldParts(field) {
  const metadata = field?.metadata ?? field;
  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('Expected a linked field record or property metadata');
  }
  const key = field?.metadata
    ? field.key ?? metadata.path ?? metadata.name ?? '<property>'
    : metadata.key ?? metadata.path ?? metadata.name ?? '<property>';
  return { field, metadata, key: String(key) };
}

function typeOf(metadata) {
  return metadata.type ?? metadata.valueType ?? TYPE_BY_CLASS[metadata.className] ?? null;
}

function fail(message, { key = null, metadata = null, type = null, operation = null } = {}) {
  throw new UnsupportedScriptReferenceSerializationError(message, {
    key, type: type ?? (metadata && typeOf(metadata)), operation,
  });
}

function integer(value, label, parts) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(`Invalid ${label} ${String(value)} for ${parts.key}`, {
      key: parts.key, metadata: parts.metadata, operation: 'serializeScriptReferences',
    });
  }
  return number;
}

function arrayDimension(metadata, parts) {
  return integer(metadata.arrayDim ?? metadata.arrayDimension ?? 1, 'ArrayDim', parts);
}

function propertyFlags(metadata) {
  const value = Number(metadata.propertyFlags ?? metadata.flags ?? 0);
  return Number.isFinite(value) ? value >>> 0 : 0;
}

function shouldSkipProperty(metadata, persistent) {
  const flags = propertyFlags(metadata);
  return Boolean(flags & REFERENCE_PROPERTY_FLAGS.SkipSerialization) ||
    (persistent && Boolean(flags & REFERENCE_PROPERTY_FLAGS.Transient));
}

function isPersistent(archive, options) {
  if (options.persistent !== undefined) return Boolean(options.persistent);
  if (archive?.persistent !== undefined) return Boolean(archive.persistent);
  if (archive?.isPersistent !== undefined) return Boolean(archive.isPersistent);
  if (archive?.ar18 !== undefined) return Boolean(archive.ar18);
  if (archive?.flags?.ar18 !== undefined) return Boolean(archive.flags.ar18);
  return false;
}

function checkArchive(archive) {
  if (!archive || (typeof archive.objectReference !== 'function' &&
      typeof archive.serializeObject !== 'function')) {
    throw new TypeError('Reference serialization requires archive.objectReference(reference, context) or archive.serializeObject(reference)');
  }
}

function callSerializerHook(hook, field, reference, context, operation) {
  if (typeof hook !== 'function') return null;
  const result = hook(field, reference, { ...context, operation });
  if (result === false) return null;
  if (result === undefined || result === true) return 0;
  const count = Number(result);
  if (!Number.isFinite(count) || count < 0) {
    throw new TypeError(`Native serializer hook returned an invalid reference count for ${context.key}`);
  }
  return count;
}

function requireReference(reference, descriptor) {
  const value = typeof reference === 'function' ? reference(descriptor) : reference;
  if (!value || typeof value.get !== 'function' || typeof value.set !== 'function') {
    throw new TypeError(`Reference callback did not return a mutable lvalue for ${descriptor.key}`);
  }
  return value;
}

function emitObjectReference(archive, reference, context) {
  if (typeof archive.objectReference === 'function') archive.objectReference(reference, context);
  else archive.serializeObject(reference, context);
  return 1;
}

function emitNameReference(archive, reference, context) {
  if (typeof archive.nameReference === 'function') archive.nameReference(reference, context);
  else archive.serializeName?.(reference, context);
}

function indexedReference(base, field, index, dimension) {
  const parts = fieldParts(field);
  return {
    reference: true,
    key: `${parts.key}[${index}]`,
    field,
    metadata: parts.metadata,
    arrayDimension: dimension,
    arrayIndex: index,
    get() {
      const value = base.get();
      if (!Array.isArray(value) || value.length !== dimension) {
        throw new TypeError(`Fixed ArrayDim storage is not an array of ${dimension} for ${parts.key}`);
      }
      return value[index];
    },
    set(value) {
      const whole = base.get();
      if (!Array.isArray(whole) || whole.length !== dimension) {
        throw new TypeError(`Fixed ArrayDim storage is not an array of ${dimension} for ${parts.key}`);
      }
      const copied = whole.slice();
      copied[index] = value;
      base.set(copied);
      return value;
    },
  };
}

function memberReference(base, field, member) {
  const memberParts = fieldParts(member);
  return {
    reference: true,
    key: memberParts.key,
    field: member,
    metadata: memberParts.metadata,
    get() {
      const value = base.get();
      if (value === null || value === undefined) return null;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`Struct storage is not a keyed value for ${memberParts.key}`);
      }
      return value[memberParts.key];
    },
    set(value) {
      const current = base.get();
      if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
        throw new TypeError(`Struct storage is not a keyed value for ${memberParts.key}`);
      }
      const copied = { ...current, [memberParts.key]: value };
      base.set(copied);
      return value;
    },
  };
}

function structFields(metadata, parts) {
  if (!Array.isArray(metadata.structFields)) {
    fail(`Struct fields are unresolved for ${parts.key}`, {
      key: parts.key, metadata, operation: 'serializeScriptReferences',
    });
  }
  return metadata.structFields.map((member, index) => {
    const memberMetadata = member?.metadata ?? member;
    const memberKey = member?.key ?? memberMetadata?.key;
    if (!memberMetadata || typeof memberMetadata !== 'object' || !memberKey) {
      fail(`Struct member ${index} is unresolved for ${parts.key}`, {
        key: parts.key, metadata, operation: 'serializeScriptReferences',
      });
    }
    return { ...member, key: String(memberKey), metadata: memberMetadata };
  });
}

function visitValue(field, reference, archive, options, context, stack) {
  const parts = fieldParts(field);
  const metadata = parts.metadata;
  const type = typeOf(metadata);
  const serializerHook = options.serializeProperty ?? archive.serializeProperty;
  if (!type) {
    const handled = callSerializerHook(serializerHook, field, reference, context, 'unknown');
    if (handled !== null) return handled;
    fail(`Property type is unresolved for ${parts.key}`, {
      key: parts.key, metadata, operation: 'serializeScriptReferences',
    });
  }

  if (type === 'array' || type === 'map') {
    const handled = callSerializerHook(serializerHook, field, reference, context, type);
    if (handled !== null) return handled;
    // UArrayProperty::SerializeItem serializes the count, then each item
    // through Inner. For a reference-free Inner (Decal.SurfList's int) every
    // step is a byte serialize the reference archive ignores, exactly like
    // the scalar leaves below, so no reference is visited.
    const inner = metadata.innerMetadata ?? metadata.innerProperty ??
      (metadata.inner?.metadata ? metadata.inner.metadata :
        (metadata.inner?.type || metadata.inner?.className ? metadata.inner : null));
    const innerType = type === 'array' && inner ? typeOf(inner) : null;
    if (innerType && SCALAR_TYPES.has(innerType)) return 0;
    fail(`Dynamic ${type} serialization is unsupported for ${parts.key}`, {
      key: parts.key, metadata, type, operation: 'serializeScriptReferences',
    });
  }

  if (type === 'fixedArray') {
    const inner = metadata.innerMetadata ?? metadata.innerProperty ??
      (metadata.inner?.metadata ? metadata.inner.metadata :
        (metadata.inner?.type || metadata.inner?.className ? metadata.inner : null));
    const fixedSize = metadata.fixedArraySize ?? metadata.fixedArrayDimension;
    if (!inner || fixedSize === undefined) {
      const handled = callSerializerHook(serializerHook, field, reference, context, type);
      if (handled !== null) return handled;
      fail(`FixedArrayProperty layout is unresolved for ${parts.key}`, {
        key: parts.key, metadata, type, operation: 'serializeScriptReferences',
      });
    }
    const dimension = integer(fixedSize, 'fixed-array size', parts);
    const innerField = { key: `${parts.key}[]`, metadata: inner };
    let count = 0;
    for (let index = 0; index < dimension; index++) {
      const indexed = indexedReference(reference, field, index, dimension);
      count += visitValue(innerField, indexed, archive, options, {
        ...context, key: `${parts.key}[${index}]`, field: innerField,
        metadata: inner, arrayIndex: index, reference: indexed,
      }, stack);
    }
    return count;
  }

  const dimension = arrayDimension(metadata, parts);
  const elementMetadata = dimension > 1
    ? cloneMetadata(metadata, { arrayDim: 1, arrayDimension: 1 })
    : metadata;
  const elementField = dimension > 1 ? { ...field, metadata: elementMetadata } : field;

  let count = 0;
  for (let index = 0; index < dimension; index++) {
    const element = dimension > 1 ? indexedReference(reference, field, index, dimension) : reference;
    const elementContext = {
      ...context,
      key: dimension > 1 ? `${parts.key}[${index}]` : (context.key ?? parts.key),
      field: elementField,
      metadata: elementMetadata,
      arrayIndex: index,
      reference: element,
    };

    if (TYPE_OBJECT.has(type)) {
      count += emitObjectReference(archive, element, elementContext);
      continue;
    }
    if (type === 'name') {
      // UNameProperty::SerializeItem (10167360) dispatches FArchive's FName
      // operator at vtable +0x1c.  Names are values, not UObject references;
      // collectors may omit the callback because it has no mark semantics.
      emitNameReference(archive, element, elementContext);
      continue;
    }

    if (type !== 'struct') continue;
    const key = String(metadata.structKey ?? '').toLowerCase();
    if (key === NATIVE_VECTOR || key === NATIVE_ROTATOR) continue;
    if (stack.has(metadata)) {
      fail(`Cyclic by-value struct reference at ${parts.key}`, {
        key: parts.key, metadata, type, operation: 'serializeScriptReferences',
      });
    }
    const members = structFields(metadata, parts);
    if (typeof archive.preloadStruct === 'function') {
      archive.preloadStruct(metadata, elementContext);
    }
    stack.add(metadata);
    try {
      for (const member of members) {
        if (shouldSkipProperty(member.metadata, options.__persistent ?? isPersistent(archive, options))) continue;
        count += visitValue(member, memberReference(element, elementField, member), archive, options, {
          ...elementContext,
          key: member.key,
          field: member,
          metadata: member.metadata,
          arrayIndex: null,
          reference: null,
          parent: elementContext,
        }, stack);
      }
    } finally {
      stack.delete(metadata);
    }
  }
  return count;
}

/**
 * Walk linked fields in the supplied original propertyLink/TFieldIterator
 * order.  The callback receives every ObjectProperty/ClassProperty element,
 * including null elements; this mirrors UObjectProperty::SerializeItem's
 * unconditional `Ar << *(UObject**)Data` call.
 *
 * `reference(field)` must return a mutable `{get,set}` lvalue.  The archive
 * may additionally provide `preloadStruct(metadata, context)` and a
 * `serializeProperty(field, reference, context)` hook for native property
 * serializers whose branches are not represented by the linked metadata.
 */
export function serializeScriptReferences(fields, reference, archive, options = {}) {
  checkArchive(archive);
  if (typeof reference !== 'function') throw new TypeError('serializeScriptReferences requires reference(field)');
  const list = fields == null ? [] : Array.from(fields);
  const persistent = isPersistent(archive, options);
  const visitOptions = options.__persistent === persistent ? options : { ...options, __persistent: persistent };
  const result = { references: 0, fields: 0, skipped: 0 };
  for (const field of list) {
    const parts = fieldParts(field);
    const flags = propertyFlags(parts.metadata);
    // These are the two raw tests in UStruct::SerializeBin.  In particular,
    // the collector archive has Ar+0x18 == 0, so Transient is visited there.
    if (shouldSkipProperty(parts.metadata, persistent)) {
      result.skipped++;
      continue;
    }
    const base = requireReference(reference, {
      key: parts.key, field, metadata: parts.metadata, kind: 'property',
    });
    result.references += visitValue(field, base, archive, visitOptions, {
      key: parts.key, field, metadata: parts.metadata, kind: 'property',
      arrayIndex: null, reference: base,
    }, new Set());
    result.fields++;
  }
  return result;
}

/** Alias used by the GC bridge when it talks about typed property links. */
export const serializePropertyReferences = serializeScriptReferences;

function archiveWord(archive, options, name) {
  const state = options.archiveState ?? archive?.archiveState ?? archive?.flags ?? archive;
  const value = state?.[name];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function headerSlot(object, reference, slot, aliases) {
  const descriptor = { kind: 'uobject-header', key: `header.${slot}`, slot, object };
  if (typeof reference === 'function') return requireReference(reference, descriptor);
  const property = aliases.find(name => Object.hasOwn(object, name));
  if (!property) throw new TypeError(`UObject header slot ${slot} is not linked on the object`);
  return {
    reference: true,
    key: descriptor.key,
    field: descriptor,
    metadata: null,
    get: () => object[property] ?? null,
    set: value => { object[property] = value; return value; },
  };
}

/**
 * Serialize the object/header references reached by UObject::Serialize.
 * Name, flags, linker indices and raw FStateFrame words are not object
 * references and stay with the caller's object serializer.  The returned
 * count is the number of archive `objectReference` calls, including nulls.
 *
 * `archiveState` names the three raw FArchive words read by the original
 * routine (`+0x0c`, `+0x10`, `+0x14`) and its persistence word (`+0x18`).
 * Omitting it selects the collector constructor's observed all-zero state.
 */
export function serializeObjectHeaderReferences(object, archive, {
  reference,
  archiveState,
  createStateFrame,
} = {}) {
  checkArchive(archive);
  if (!object || typeof object !== 'object') throw new TypeError('Expected a UObject record');
  const state = archiveState ?? archive.archiveState;
  const words = { archiveState: state };
  const ar0c = archiveWord(archive, words, 'ar0c');
  const ar10 = archiveWord(archive, words, 'ar10');
  const ar14 = archiveWord(archive, words, 'ar14');
  const result = { references: 0, identity: false, linker: false, stateFrame: false };

  // 1015025c–101502a1: the exact branch conditions before the state frame.
  const identity = (ar0c === 0 && ar10 === 0) || ar14 !== 0;
  if (identity) {
    // UObject::Serialize archives Name through FArchive vtable +0x1c before
    // the Outer/Class object references. This object-only helper allows that
    // callback to be absent; full collector serialization must use the base
    // UObject serializer, which requires the Name operation.
    if (typeof archive.nameReference === 'function' || typeof archive.serializeName === 'function') {
      emitNameReference(archive,
        headerSlot(object, reference && (slot => reference({ kind: 'uobject-header', key: 'header.name', slot: 'Name', object })), 'Name', ['name', 'Name']),
        { kind: 'uobject-header', key: 'header.name', slot: 'Name', object },
      );
    }
    result.references += emitObjectReference(archive,
      headerSlot(object, reference && (slot => reference({ kind: 'uobject-header', key: 'header.outer', slot: 'Outer', object })), 'Outer', ['outer', 'Outer']),
      { kind: 'uobject-header', key: 'header.outer', slot: 'Outer', object });
    result.references += emitObjectReference(archive,
      headerSlot(object, reference && (slot => reference({ kind: 'uobject-header', key: 'header.class', slot: 'Class', object })), 'Class', ['classRecord', 'classRef', 'objectClass', 'class', 'Class']),
      { kind: 'uobject-header', key: 'header.class', slot: 'Class', object });
    result.identity = true;
  }
  if (ar0c === 0 && ar10 === 0) {
    result.references += emitObjectReference(archive,
      headerSlot(object, reference && (slot => reference({ kind: 'uobject-header', key: 'header.linker', slot: 'Linker', object })), 'Linker', ['linker', 'Linker']),
      { kind: 'uobject-header', key: 'header.linker', slot: 'Linker', object });
    result.linker = true;
  }

  const flags = Number(object.objectFlags ?? object.flags ?? object.ObjectFlags ?? 0) >>> 0;
  if ((flags & STATE_FRAME_FLAG) === 0 || ar14 !== 0) return result;
  let frame = object.stateFrame ?? object.StateFrame ?? null;
  if (frame === null && typeof createStateFrame === 'function') {
    frame = createStateFrame(object);
    if (frame !== null && frame !== undefined) object.stateFrame = frame;
  }
  if (!frame || typeof frame !== 'object') {
    throw new UnsupportedScriptReferenceSerializationError(
      'UObject state-frame flag is set but no FStateFrame record is available',
      { key: object.key ?? null, operation: 'serializeObjectHeaderReferences' },
    );
  }
  const node = headerSlot(frame, reference && (slot => reference({
    kind: 'state-frame', key: 'stateFrame.node', slot: 'Node', object, frame,
  })), 'Node', ['node', 'Node']);
  const stateRef = headerSlot(frame, reference && (slot => reference({
    kind: 'state-frame', key: 'stateFrame.state', slot: 'State', object, frame,
  })), 'State', ['state', 'State', 'function', 'Function']);
  result.references += emitObjectReference(archive, node, {
    kind: 'state-frame', key: 'stateFrame.node', slot: 'Node', object, frame,
  });
  result.references += emitObjectReference(archive, stateRef, {
    kind: 'state-frame', key: 'stateFrame.state', slot: 'State', object, frame,
  });
  result.stateFrame = true;
  return result;
}

/** Walk headers and typed fields for one object while retaining both counts. */
export function serializeObjectReferences({
  object,
  fields = [],
  reference,
  archive,
  header = true,
  options = {},
} = {}) {
  const headerResult = header
    ? serializeObjectHeaderReferences(object, archive, options)
    : { references: 0, identity: false, linker: false, stateFrame: false };
  const propertyResult = fields == null || fields.length === 0
    ? { references: 0, fields: 0, skipped: 0 }
    : serializeScriptReferences(fields, reference, archive, options);
  return {
    header: headerResult,
    properties: propertyResult,
    references: headerResult.references + propertyResult.references,
  };
}
