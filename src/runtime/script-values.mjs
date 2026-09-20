/**
 * Typed values used by the script VM.
 *
 * These helpers deliberately operate on an already linked field record.  A
 * record normally has the shape { key, metadata }, but passing the metadata
 * object itself is also supported.  No package or object loader is required
 * here: the getter and setter supplied to propertyReference are the storage
 * boundary.
 */

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

const SUPPORTED_STRUCTS = new Set(['core.object.vector', 'core.object.rotator']);
const REF_STATE = Symbol('script-value-reference');

/** A value/property branch whose original storage contract is not implemented. */
export class UnsupportedScriptValueError extends Error {
  constructor(message, { key = null, type = null, operation = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptValueError';
    this.code = 'UNSUPPORTED_SCRIPT_VALUE';
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

function fail(message, parts, type = null, operation = null) {
  throw new UnsupportedScriptValueError(message, {
    key: parts?.key ?? null, type, operation,
  });
}

function typeOf(metadata) {
  return metadata.type ?? metadata.valueType ?? TYPE_BY_CLASS[metadata.className] ?? null;
}

function integerDimension(value, parts, label) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < 1) {
    fail(`Invalid ${label} ${String(value)} for ${parts.key}`, parts, typeOf(parts.metadata));
  }
  return dimension;
}

function structKey(metadata) {
  // The linker supplies this from the complete package object path.  Do not
  // identify a struct by its short name: Core.Object.Vector and another
  // package's Vector are different native struct identities.
  return metadata.structKey == null ? '' : String(metadata.structKey).toLowerCase();
}

function scalarDescriptor(parts, metadata = parts.metadata) {
  const type = typeOf(metadata);
  if (!type) fail(`Unsupported property type for ${parts.key}`, parts, type);
  if (type === 'array') {
    const inner=innerMetadata(metadata);
    // Core UArrayProperty::CopySingleValue's non-owning int path. Native
    // Decal.SurfList needs whole-value storage, not dynamic indexing opcodes.
    if(!inner||typeOf(inner)!=='int'||(inner.flags&0x400000)||
      (inner.arrayDim??1)!==1)
      fail(`Dynamic array values require a linked non-owning IntProperty for ${parts.key}`,parts,type);
    return {key:parts.key,type,metadata,elementSize:12,inner};
  }
  if (type === 'map') {
    fail(`Dynamic ${type} values are not implemented for ${parts.key}`, parts, type);
  }
  if (type === 'fixedArray') {
    fail(`FixedArrayProperty needs a linked inner property for ${parts.key}`, parts, type);
  }
  if (type === 'struct') {
    const key = structKey(metadata);
    if (SUPPORTED_STRUCTS.has(key)) {
      return { key: parts.key, type, structKey: key, metadata, elementSize: elementSize(metadata, type, parts) };
    }
    if (!key) {
      fail(`Unsupported struct identity ${key || '<unresolved>'} for ${parts.key}; ` +
        'the full original package path is required', parts, type);
    }
    if (!Array.isArray(metadata.structFields)) {
      fail(`Struct fields are unresolved for ${parts.key} (${key})`, parts, type);
    }
    for (const [index, member] of metadata.structFields.entries()) {
      const memberMetadata = member?.metadata ?? member;
      const memberKey = member?.key ?? memberMetadata?.key;
      if (!memberMetadata || typeof memberMetadata !== 'object' || !memberKey || !typeOf(memberMetadata)) {
        fail(`Struct member ${index} is unresolved for ${parts.key}`, parts, type);
      }
    }
    return {
      key: parts.key, type, structKey: key, metadata,
      structFields: metadata.structFields,
      elementSize: elementSize(metadata, type, parts),
    };
  }
  if (!['byte', 'int', 'bool', 'float', 'name', 'string', 'object', 'class'].includes(type)) {
    fail(`Unsupported property type ${type} for ${parts.key}`, parts, type);
  }
  return { key: parts.key, type, metadata, elementSize: elementSize(metadata, type, parts) };
}

function innerMetadata(metadata) {
  // A metadata linker may resolve `innerMetadata`; the raw reader currently
  // retains `inner` as a package reference descriptor.  Do not treat that
  // unresolved descriptor as a guessed property type.
  const candidate = metadata.innerMetadata ?? metadata.innerProperty ??
    (metadata.inner?.metadata ? metadata.inner.metadata :
      (metadata.inner?.type || metadata.inner?.className ? metadata.inner : null));
  return candidate?.metadata ?? candidate;
}

function describe(field) {
  const parts = fieldParts(field);
  const metadata = parts.metadata;
  const type = typeOf(metadata);
  if (!type) fail(`Unsupported property type for ${parts.key}`, parts, type);

  if (type === 'map') {
    fail(`Dynamic ${type} values are not implemented for ${parts.key}`, parts, type);
  }

  if (type === 'fixedArray') {
    const inner = innerMetadata(metadata);
    if (!inner) fail(`FixedArrayProperty inner type is unresolved for ${parts.key}`, parts, type);
    const innerParts = { field: inner, metadata: inner, key: `${parts.key}[]` };
    const innerType = typeOf(inner);
    if (innerType === 'array' || innerType === 'fixedArray' || innerType === 'map') {
      fail(`Nested ${innerType} values are not implemented for ${parts.key}`, parts, type);
    }
    const element = scalarDescriptor(innerParts, inner);
    const count = metadata.fixedArraySize ?? metadata.fixedArrayDimension;
    if (count == null) fail(`FixedArrayProperty size is unresolved for ${parts.key}`, parts, type);
    const dimension = integerDimension(count, parts, 'fixed array size');
    return {
      ...parts, metadata, type, array: true, dimension,
      element, elementMetadata: inner, elementSize: element.elementSize,
    };
  }

  const dimensionValue = metadata.arrayDim ?? metadata.arrayDimension ?? 1;
  const dimension = integerDimension(dimensionValue, parts, 'array dimension');
  const elementMetadata = dimension > 1
    ? { ...metadata, arrayDim: 1, arrayDimension: 1 }
    : metadata;
  const elementParts = { field: elementMetadata, metadata: elementMetadata, key: `${parts.key}[]` };
  const element = scalarDescriptor(elementParts, elementMetadata);
  return {
    ...parts, metadata, type, array: dimension > 1, dimension,
    element, elementMetadata, elementSize: element.elementSize,
  };
}

function suppliedElementSize(metadata) {
  const size = Number(metadata.elementSize);
  return Number.isInteger(size) && size > 0 ? size : null;
}

function elementSize(metadata, type, parts) {
  const supplied = suppliedElementSize(metadata);
  if (supplied !== null) return supplied;
  switch (type) {
    case 'byte': return 1;
    // BoolProperty storage is a dword even though its logical value is one bit.
    case 'bool': case 'int': case 'float': case 'name': case 'object': case 'class': return 4;
    // FString is a three-dword value in this original build.
    case 'string': return 12;
    // Vector and Rotator retain their established 12-byte native layout. A
    // generic UStruct's offsets/padding are not serialized in its UField
    // header; a linker may supply elementSize once that native layout is
    // known, otherwise expose the unresolved stride explicitly.
    case 'struct': return SUPPORTED_STRUCTS.has(structKey(metadata)) ? 12 : null;
    default: fail(`Cannot determine element size for ${parts.key}`, parts, type);
  }
}

function structFields(metadata, descriptor, operation) {
  if (!Array.isArray(metadata.structFields)) {
    throw new UnsupportedScriptValueError(
      `Struct fields are unresolved for ${descriptor.key}`,
      { key: descriptor.key, type: descriptor.type, operation },
    );
  }
  return metadata.structFields.map((member, index) => {
    const memberMetadata = member?.metadata ?? member;
    const memberKey = member?.key ?? memberMetadata?.key;
    if (!memberMetadata || typeof memberMetadata !== 'object' || !memberKey) {
      throw new UnsupportedScriptValueError(
        `Struct member ${index} is unresolved for ${descriptor.key}`,
        { key: descriptor.key, type: descriptor.type, operation },
      );
    }
    return { key: String(memberKey), name: member?.name ?? memberMetadata.name ?? null, metadata: memberMetadata };
  });
}

function zeroGenericStruct(metadata, descriptor) {
  const value = {};
  for (const member of structFields(metadata, descriptor, 'zeroValue')) {
    value[member.key] = zeroValue({ key: member.key, metadata: member.metadata });
  }
  return value;
}

function copyGenericStruct(value, metadata, descriptor, operation) {
  if (value == null) return zeroGenericStruct(metadata, descriptor);
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${operation} requires a keyed object for ${descriptor.key}`);
  }
  const copied = {};
  for (const member of structFields(metadata, descriptor, operation)) {
    if (!Object.prototype.hasOwnProperty.call(value, member.key)) {
      throw new UnsupportedScriptValueError(
        `Missing linked struct member ${member.key} for ${descriptor.key}`,
        { key: descriptor.key, type: descriptor.type, operation },
      );
    }
    copied[member.key] = copyValue({ key: member.key, metadata: member.metadata }, value[member.key]);
  }
  return copied;
}

function arrayValue(value, descriptor, operation) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${operation} requires an Array for ${descriptor.key}`);
  }
  if (value.length !== descriptor.dimension) {
    throw new RangeError(`${operation} requires ${descriptor.dimension} elements for ${descriptor.key}; got ${value.length}`);
  }
  return value.map(item => copyScalar(item, descriptor.element, operation));
}

function copyScalar(value, descriptor, operation = 'copyValue') {
  const { type, metadata } = descriptor;
  switch (type) {
    case 'bool': return Boolean(value);
    case 'byte': return Number(value ?? 0) & 0xff;
    case 'int': return Number(value ?? 0) | 0;
    case 'float': return Math.fround(Number(value ?? 0));
    case 'name':
      if (value == null) return 'None';
      return typeof value === 'object' && value.name != null ? String(value.name) : String(value);
    case 'string': return value == null ? '' : String(value);
    // UObjectProperty/ClassProperty copies the pointer.  Object identity is
    // the value in the original VM; cloning a linked object would be wrong.
    case 'object': case 'class': return value ?? null;
    case 'array':
      if(!Array.isArray(value))throw new TypeError(`${operation} requires an Array for ${descriptor.key}`);
      return value.map(item=>Number(item)|0);
    case 'struct': {
      const key = descriptor.structKey;
      if (!SUPPORTED_STRUCTS.has(key)) return copyGenericStruct(value, metadata, descriptor, operation);
      if (value == null) return [0, 0, 0];
      if (!Array.isArray(value) || value.length !== 3) {
        throw new TypeError(`${operation} requires three components for ${descriptor.key}`);
      }
      return key === 'core.object.rotator'
        ? value.map(component => Number(component ?? 0) | 0)
        : value.map(component => Math.fround(Number(component ?? 0)));
    }
    default:
      // scalarDescriptor catches this; retain an explicit error if a caller
      // passes a hand-built descriptor through an indexed reference.
      throw new UnsupportedScriptValueError(`Unsupported scalar type ${type} for ${descriptor.key}`, {
        key: descriptor.key, type, operation,
      });
  }
}

function bitMask(metadata) {
  const mask = Number(metadata.bitMask);
  return Number.isInteger(mask) && mask !== 0 ? mask | 0 : null;
}

function copyStored(value, descriptor, operation) {
  if (descriptor.array) {
    if (value === undefined) return zeroFromDescriptor(descriptor);
    const copied = arrayValue(value, descriptor, operation);
    const mask = descriptor.element.type === 'bool' ? bitMask(descriptor.element.metadata) : null;
    if (mask === null) return copied;
    return value.map(item => Boolean((Number(item ?? 0) | 0) & mask));
  }
  const mask = descriptor.type === 'bool' ? bitMask(descriptor.metadata) : null;
  if (mask !== null) return Boolean((Number(value ?? 0) | 0) & mask);
  return copyScalar(value, descriptor.element, operation);
}

function zeroScalar(descriptor) {
  switch (descriptor.type) {
    case 'bool': return false;
    case 'byte': case 'int': case 'float': return 0;
    case 'name': return 'None';
    case 'string': return '';
    case 'object': case 'class': return null;
    case 'array': return [];
    case 'struct':
      if (SUPPORTED_STRUCTS.has(descriptor.structKey)) return [0, 0, 0];
      return zeroGenericStruct(descriptor.metadata, descriptor);
    default: throw new UnsupportedScriptValueError(`Unsupported scalar type ${descriptor.type}`, {
      key: descriptor.key, type: descriptor.type, operation: 'zeroValue',
    });
  }
}

function zeroFromDescriptor(descriptor) {
  if (descriptor.array) return Array.from({ length: descriptor.dimension }, () => zeroScalar(descriptor.element));
  return zeroScalar(descriptor.element);
}

function copyFromDescriptor(descriptor, value, operation = 'copyValue') {
  if (descriptor.array) return arrayValue(value, descriptor, operation);
  return copyScalar(value, descriptor.element, operation);
}

function copyToStorage(value, descriptor, rawValue, operation = 'propertyReference') {
  const logical = copyFromDescriptor(descriptor, value, operation);
  const mask = descriptor.type === 'bool' && !descriptor.array ? bitMask(descriptor.metadata) : null;
  if (mask !== null) {
    const current = Number(rawValue ?? 0) | 0;
    return ((current & ~mask) | (logical ? mask : 0)) >>> 0;
  }
  if (descriptor.array && descriptor.element.type === 'bool') {
    const elementMask = bitMask(descriptor.element.metadata);
    if (elementMask !== null) {
      const current = Array.isArray(rawValue) && rawValue.length === descriptor.dimension
        ? rawValue : zeroFromDescriptor(descriptor);
      return logical.map((item, index) => {
        const word = Number(current[index] ?? 0) | 0;
        return ((word & ~elementMask) | (item ? elementMask : 0)) >>> 0;
      });
    }
  }
  return logical;
}

/** Return a fresh zeroed VM value for a linked field or property metadata. */
export function zeroValue(field) {
  const descriptor = describe(field);
  return zeroFromDescriptor(descriptor);
}

/** Copy a typed value using the original property value shape. */
export function copyValue(field, value) {
  const descriptor = describe(field);
  return copyFromDescriptor(descriptor, value);
}

function makeReference(descriptor, parts, state, { index = null, container = null } = {}) {
  const isElement = index !== null;
  const addressOffset = isElement && descriptor.elementSize !== null
    ? index * descriptor.elementSize : isElement ? null : 0;
  const ref = {
    reference: true,
    key: parts.key,
    field: parts.field,
    metadata: parts.metadata,
    property: parts.metadata,
    arrayDimension: descriptor.array ? descriptor.dimension : 1,
    elementSize: descriptor.elementSize,
    arrayIndex: index,
    addressOffset,
    array: null,
  };
  if (descriptor.array) {
    ref.array = {
      dimension: descriptor.dimension,
      elementSize: descriptor.elementSize,
      index,
      addressOffset,
      container: container ?? ref,
    };
  }
  ref.get = () => {
    if (!isElement) return state.readWhole();
    const whole = state.readWhole();
    return copyScalar(whole[index], descriptor.element, 'arrayReference.get');
  };
  ref.set = value => {
    if (!isElement) {
      const raw = state.readRaw();
      const stored = copyToStorage(value, descriptor, raw);
      state.writeRaw(stored);
      return copyFromDescriptor(descriptor, value, 'arrayReference.set');
    }
    const whole = state.readWhole();
    whole[index] = copyScalar(value, descriptor.element, 'arrayReference.set');
    state.writeLogical(whole);
    return copyScalar(whole[index], descriptor.element, 'arrayReference.set');
  };
  Object.defineProperty(ref, REF_STATE, { value: state });
  return ref;
}

/**
 * Create a metadata-carrying lvalue.  A fixed-array field reads and writes
 * the complete ArrayDim value, matching CopyCompleteValue (+0x90).
 */
export function propertyReference(field, get, set) {
  const descriptor = describe(field);
  if (typeof get !== 'function' || typeof set !== 'function') {
    throw new TypeError(`propertyReference requires getter and setter for ${descriptor.key}`);
  }
  const parts = fieldParts(field);
  const state = {
    descriptor,
    readRaw: () => get(),
    writeRaw: value => set(value),
    readWhole: () => copyStored(get(), descriptor, 'propertyReference.get'),
    writeLogical: value => set(copyToStorage(value, descriptor, get(), 'propertyReference.set')),
  };
  return makeReference(descriptor, parts, state);
}

/**
 * Return an indexed lvalue for a fixed array.  The index expression is
 * evaluated before the reference is inspected.  An invalid signed index is
 * reported through warning and clamped exactly as execArrayElement does.
 */
export function arrayReference(index, ref, warning) {
  const evaluated = typeof index === 'function' ? index() : index;
  const numeric = Number(evaluated);
  if (!Number.isFinite(numeric)) throw new TypeError('Array index must be a finite signed integer');
  const signedIndex = numeric | 0;

  let base = ref;
  let state = ref?.[REF_STATE];
  if (!state && ref?.reference && typeof ref.get === 'function' && typeof ref.set === 'function') {
    // Accept an equivalent external lvalue while retaining its metadata.  A
    // plain reference without metadata cannot establish the native stride.
    base = propertyReference(ref.field ?? ref.metadata ?? ref, ref.get, ref.set);
    state = base[REF_STATE];
  }
  if (!state) throw new TypeError('arrayReference requires a propertyReference');
  const descriptor = state.descriptor;
  if (!descriptor.array) {
    throw new UnsupportedScriptValueError(`Array indexing requires a fixed array: ${descriptor.key}`, {
      key: descriptor.key, type: descriptor.type, operation: 'arrayReference',
    });
  }
  if (descriptor.elementSize === null) {
    throw new UnsupportedScriptValueError(
      `Original element stride is unresolved for ${descriptor.key}`,
      { key: descriptor.key, type: descriptor.type, operation: 'arrayReference' },
    );
  }

  let selected = signedIndex;
  if (selected < 0 || selected >= descriptor.dimension) {
    const clampedIndex = selected < 0 ? 0 : descriptor.dimension - 1;
    if (typeof warning === 'function') warning({
      type: 'ArrayIndexOutOfBounds',
      key: descriptor.key,
      index: signedIndex,
      dimension: descriptor.dimension,
      clampedIndex,
      field: base.field,
      metadata: descriptor.metadata,
    });
    selected = clampedIndex;
  }
  return makeReference(descriptor, fieldParts(base.field ?? base.metadata), state, {
    index: selected, container: base,
  });
}
