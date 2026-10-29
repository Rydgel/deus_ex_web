/**
 * Typed values used by the script VM.
 *
 * These helpers deliberately operate on an already linked field record.  A
 * record normally has the shape { key, metadata }, but passing the metadata
 * object itself is also supported.  No package or object loader is required
 * here: the getter and setter supplied to propertyReference are the storage
 * boundary.
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

const SUPPORTED_STRUCTS = new Set(['core.object.vector', 'core.object.rotator']);

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
    // Whole-value storage for native-owned dynamic arrays whose script never
    // indexes them: Decal.SurfList (non-owning int, Core UArrayProperty's
    // CopySingleValue int path) and DumpLocation.dumpFileDirectory (owning
    // FString elements, copied/destroyed per element by the recovered
    // UStrProperty bodies) and GameDirectory.loadedSaveInfoPointers (non-owning
    // object pointers, UObjectProperty's pointer copy; docs/save-directory.md).
    // Dynamic indexing opcodes remain unsupported.
    const innerType=inner?typeOf(inner):null;
    if(!inner||(inner.arrayDim??1)!==1||
      !((innerType==='int'||innerType==='object')&&!(inner.flags&0x400000)||innerType==='string'))
      fail(`Dynamic array values require a linked IntProperty, ObjectProperty or StrProperty inner for ${parts.key}`,parts,type);
    return {key:parts.key,type,metadata,elementSize:12,inner,innerType};
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

// A descriptor is a pure function of the property key and linked metadata.
// Linking completes the metadata before synchronous VM work; the cache still
// rebuilds if the linker later rewrites one of the slots it fills in
// (ScriptRuntime.field, the class loader, struct layout). Rebuilding it on
// every property access dominated Play's allocation (docs/play-frame-cost.md).
const descriptorCache = new WeakMap();
// A linked field record ({key, metadata}) resolves straight to its entry,
// without rebuilding the key string or a second map lookup per access.
const fieldDescriptors = new WeakMap();
const DESCRIPTOR_ENTRY = Symbol('property descriptor entry');

const currentFor = (cached, metadata) =>
  cached.arrayDim === metadata.arrayDim && cached.elementSize === metadata.elementSize &&
  cached.structKey === metadata.structKey && cached.structFields === metadata.structFields &&
  cached.innerMetadata === metadata.innerMetadata;

function describe(field) {
  return describeEntry(field)?.descriptor ?? describeUncached(field);
}

/** The cached entry for a property, or null when it has no metadata object
 * to key on (such a caller gets an uncached descriptor). */
function describeEntry(field) {
  const metadata = field?.metadata ?? field;
  if (!metadata || typeof metadata !== 'object') return null;
  const linked = field !== metadata && typeof field.key === 'string';
  if (linked) {
    // The field record's own link (set below) spares the WeakMap lookup; the
    // same metadata/key/currency checks decide whether it is still valid.
    const direct = field[DESCRIPTOR_ENTRY] ?? fieldDescriptors.get(field);
    if (direct && direct.metadata === metadata && direct.key === field.key && currentFor(direct, metadata))
      return direct;
  }
  const key = String(field?.metadata
    ? field.key ?? metadata.path ?? metadata.name ?? '<property>'
    : metadata.key ?? metadata.path ?? metadata.name ?? '<property>');
  let byKey = descriptorCache.get(metadata);
  let cached = byKey?.get(key);
  if (!cached || !currentFor(cached, metadata)) {
    if (!byKey) descriptorCache.set(metadata, byKey = new Map());
    byKey.set(key, cached = { descriptor: describeUncached(field), codec: null, metadata, key,
      arrayDim: metadata.arrayDim, elementSize: metadata.elementSize, structKey: metadata.structKey,
      structFields: metadata.structFields, innerMetadata: metadata.innerMetadata });
  }
  if (linked) {
    fieldDescriptors.set(field, cached);
    if (Object.isExtensible(field))
      Object.defineProperty(field, DESCRIPTOR_ENTRY, {value: cached, writable: true, enumerable: false, configurable: true});
  }
  return cached;
}

function describeUncached(field) {
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
      key: parts.key, metadata, type, array: true, dimension,
      element, elementMetadata: inner, elementSize: element.elementSize,
    };
  }

  const dimensionValue = metadata.arrayDim ?? metadata.arrayDimension ?? 1;
  const dimension = integerDimension(dimensionValue, parts, 'array dimension');
  const elementMetadata = dimension > 1
    ? cloneMetadata(metadata, { arrayDim: 1, arrayDimension: 1 })
    : metadata;
  const elementParts = { field: elementMetadata, metadata: elementMetadata, key: `${parts.key}[]` };
  const element = scalarDescriptor(elementParts, elementMetadata);
  return {
    key: parts.key, metadata, type, array: dimension > 1, dimension,
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

// Normalized members for one linked structFields array; each member also
// serves as the field record for its own value copies.
const structMemberCache = new WeakMap();

function structFields(metadata, descriptor, operation) {
  if (!Array.isArray(metadata.structFields)) {
    throw new UnsupportedScriptValueError(
      `Struct fields are unresolved for ${descriptor.key}`,
      { key: descriptor.key, type: descriptor.type, operation },
    );
  }
  let members = structMemberCache.get(metadata.structFields);
  if (!members) {
    members = normalizedStructFields(metadata, descriptor, operation);
    structMemberCache.set(metadata.structFields, members);
  }
  return members;
}

function normalizedStructFields(metadata, descriptor, operation) {
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
    value[member.key] = zeroValue(member);
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
    copied[member.key] = copyValue(member, value[member.key]);
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

// Logical copies of the simple scalar types, shared by copyScalar and the
// specialized readers of propertyCodec.
const copyBool = value => Boolean(value);
const copyByte = value => Number(value ?? 0) & 0xff;
const copyInt = value => Number(value ?? 0) | 0;
const copyFloat = value => Math.fround(Number(value ?? 0));
const copyName = value => {
  if (value == null) return 'None';
  return typeof value === 'object' && value.name != null ? String(value.name) : String(value);
};
const copyString = value => value == null ? '' : String(value);
// UObjectProperty/ClassProperty copies the pointer.  Object identity is
// the value in the original VM; cloning a linked object would be wrong.
const copyPointer = value => value ?? null;
const copyStringItem = item => item == null ? '' : String(item);
const copyIntItem = item => Number(item) | 0;
const simpleScalarCopies = new Map([['byte', copyByte], ['int', copyInt], ['float', copyFloat],
  ['name', copyName], ['string', copyString], ['object', copyPointer], ['class', copyPointer]]);

function copyScalar(value, descriptor, operation = 'copyValue') {
  const { type, metadata } = descriptor;
  switch (type) {
    case 'bool': return copyBool(value);
    case 'byte': return copyByte(value);
    case 'int': return copyInt(value);
    case 'float': return copyFloat(value);
    case 'name': return copyName(value);
    case 'string': return copyString(value);
    case 'object': case 'class': return copyPointer(value);
    case 'array':
      if(!Array.isArray(value))throw new TypeError(`${operation} requires an Array for ${descriptor.key}`);
      if(descriptor.innerType==='object')return value.map(copyPointer);
      return descriptor.innerType==='string'?value.map(copyStringItem):value.map(copyIntItem);
    case 'struct': {
      const key = descriptor.structKey;
      if (!SUPPORTED_STRUCTS.has(key)) return copyGenericStruct(value, metadata, descriptor, operation);
      if (value == null) return [0, 0, 0];
      if (!Array.isArray(value) || value.length !== 3) {
        throw new TypeError(`${operation} requires three components for ${descriptor.key}`);
      }
      // (the three components in place of a map with a closure: a vector is copied for every write of a Location)
      return key === 'core.object.rotator'
        ? [Number(value[0] ?? 0) | 0, Number(value[1] ?? 0) | 0, Number(value[2] ?? 0) | 0]
        : [Math.fround(Number(value[0] ?? 0)), Math.fround(Number(value[1] ?? 0)), Math.fround(Number(value[2] ?? 0))];
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

// Whether copyToStorage uses the stored raw value: a bool property with a bit mask, and an array of those.
const needsRaw = descriptor => descriptor.array
  ? descriptor.element.type === 'bool' && bitMask(descriptor.element.metadata) !== null
  : descriptor.type === 'bool' && bitMask(descriptor.metadata) !== null;
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

/** The dimension and element stride arrayReference checks for a fixed-array
 * property, or null when arrayReference refuses it (not a fixed array, an
 * unresolved stride, no descriptor). For the Rust interpreter's lowering. */
export function fixedArrayShape(field) {
  let descriptor;
  try { descriptor = describe(field); } catch { return null; }
  return descriptor.array && descriptor.elementSize !== null
    ? {dimension: descriptor.dimension, elementSize: descriptor.elementSize} : null;
}

/** Copy a typed value using the original property value shape. */
export function copyValue(field, value) {
  const descriptor = describe(field);
  return copyFromDescriptor(descriptor, value);
}

/** A storage's readElement(index) result when it cannot read one element
 * of its fixed array on its own; the reference then copies the whole value. */
export const NO_ELEMENT = Symbol('no element');

// Reference backing: the storage getter/setter and the field descriptor.
const readWhole = state => copyStored(state.get(), state.descriptor, 'propertyReference.get');
const writeLogical = (state, value) =>
  state.set(copyToStorage(value, state.descriptor, state.get(), 'propertyReference.set'));

/** A metadata-carrying lvalue. One is made for every variable operand the VM passes by reference, so it holds five fields and the
 * state: the rest of what a reference shows (key, metadata, array shape, address offset) is read from the descriptor when asked, and
 * the `get`/`set` functions callers pass on as detached accessors are made at the first read of those properties. The VM's own
 * reads and writes call getValue/setValue (refValue and assign, script-vm.mjs), which need neither. */
class PropertyReference {
  #state;
  #accessors = null;
  #array = null;
  constructor(descriptor, field, state, index, container) {
    this.field = field;
    this.descriptor = descriptor;
    this.arrayIndex = index;
    this.container = container;
    this.#state = state;
  }
  get key() { return this.descriptor.key; }
  get metadata() { return this.descriptor.metadata; }
  get property() { return this.descriptor.metadata; }
  get arrayDimension() { return this.descriptor.array ? this.descriptor.dimension : 1; }
  get elementSize() { return this.descriptor.elementSize; }
  get addressOffset() {
    const descriptor = this.descriptor, index = this.arrayIndex;
    return index !== null && descriptor.elementSize !== null ? index * descriptor.elementSize : index !== null ? null : 0;
  }
  get array() {
    const descriptor = this.descriptor;
    if (!descriptor.array) return null;
    return this.#array ??= {
      dimension: descriptor.dimension,
      elementSize: descriptor.elementSize,
      index: this.arrayIndex,
      addressOffset: this.addressOffset,
      container: this.container ?? this,
    };
  }
  /** The value: readWhole of the property, or of the one element (copyScalar of the element a storage that reads one cell yields
   * on its own; readWhole copies every element before the index). */
  getValue() {
    const state = this.#state, index = this.arrayIndex;
    if (index === null) return readWhole(state);
    const element = this.descriptor.element;
    if (typeof state.readElement === 'function' && element.type !== 'bool') {
      const one = state.readElement(index);
      return copyScalar(one === NO_ELEMENT ? readWhole(state)[index] : one, element, 'arrayReference.get');
    }
    return copyScalar(readWhole(state)[index], element, 'arrayReference.get');
  }
  /** Store `value` and return the logical copy of what was stored. */
  setValue(value) {
    const state = this.#state, index = this.arrayIndex, descriptor = this.descriptor;
    if (index === null) {
      // The old raw value only matters to a bool in a shared dword and an array of those; a storage whose read has no effect
      // (`pure`: an image cell without a poison entry) is not read for the others.
      state.set(copyToStorage(value, descriptor, needsRaw(descriptor) || state.pure?.() !== true ? state.get() : undefined));
      return copyFromDescriptor(descriptor, value, 'arrayReference.set');
    }
    const element = descriptor.element, whole = readWhole(state);
    whole[index] = copyScalar(value, element, 'arrayReference.set');
    writeLogical(state, whole);
    return copyScalar(whole[index], element, 'arrayReference.set');
  }
  // Own functions of the reference once asked for: callers pass ref.get/ref.set on as detached accessors.
  get get() { return (this.#accessors ??= this.#makeAccessors()).get; }
  get set() { return (this.#accessors ??= this.#makeAccessors()).set; }
  #makeAccessors() { return {get: () => this.getValue(), set: value => this.setValue(value)}; }
  static stateOf(value) {
    return value !== null && typeof value === 'object' && #state in value ? value.#state : undefined;
  }
}
PropertyReference.prototype.reference = true;

/** The declared element type ('object', 'struct', ...) an lvalue reads, or
 * null for a value that is not a metadata-carrying property reference. */
export function referenceElementType(value) {
  return PropertyReference.stateOf(value)?.descriptor.element.type ?? null;
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
  return new PropertyReference(descriptor, field, { descriptor, get, set }, null, null);
}

/** propertyReference over a storage object whose own get()/set(value) methods
 * are called with it as receiver, so the reference needs no accessor closures.
 * The storage's `descriptor` is set here. */
export function storageReference(field, storage) {
  const descriptor = describe(field);
  if (typeof storage?.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError(`storageReference requires get and set methods for ${descriptor.key}`);
  }
  storage.descriptor = descriptor;
  return new PropertyReference(descriptor, field, storage, null, null);
}

/** A property's value operations, specialized once from its descriptor:
 * `read(raw)` is `propertyReference(field, get, set).get()` for a stored raw
 * value, `store(value, raw)` the raw value `.set(value)` stores over `raw`,
 * and `copy(value)` is `copyValue(field, value)`. The codec is cached with the
 * validated descriptor, so it follows a later metadata rewrite the same way. */
export function propertyCodec(field) {
  const entry = describeEntry(field);
  if (!entry) return codecFor(describeUncached(field));
  return entry.codec ??= codecFor(entry.descriptor);
}

function codecFor(descriptor) {
  return {
    read: readerFor(descriptor),
    store: (value, raw) => copyToStorage(value, descriptor, raw),
    copy: value => copyFromDescriptor(descriptor, value),
    // The value a whole-property PropertyReference.set returns.
    assigned: value => copyFromDescriptor(descriptor, value, 'arrayReference.set'),
  };
}

// copyStored without its per-access branches: a single non-bool element is
// copyScalar of that element. Arrays and bools (a live bitMask) stay general.
function readerFor(descriptor) {
  if (descriptor.array || descriptor.type === 'bool')
    return raw => copyStored(raw, descriptor, 'propertyReference.get');
  const element = descriptor.element;
  return simpleScalarCopies.get(element.type) ?? (raw => copyScalar(raw, element, 'propertyReference.get'));
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
  let state = PropertyReference.stateOf(ref);
  if (!state && ref?.reference && typeof ref.get === 'function' && typeof ref.set === 'function') {
    // Accept an equivalent external lvalue while retaining its metadata.  A
    // plain reference without metadata cannot establish the native stride.
    base = propertyReference(ref.field ?? ref.metadata ?? ref, ref.get, ref.set);
    state = PropertyReference.stateOf(base);
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
  return new PropertyReference(descriptor, base.field ?? base.metadata, state, selected, base);
}
