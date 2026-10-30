import { PackageError, Reader } from './package.mjs';
import { nameAt, objectAt, exportAt } from './objects.mjs';
import { skipBytecode } from './classes.mjs';

/**
 * The package linker formats used by the Deus Ex GOTY scripts.  Core.dll's
 * UFunction/UStruct/UProperty serializers have version branches for older
 * packages; this reader deliberately refuses those branches until they have
 * been traced separately.
 */
export const SCRIPT_METADATA_VERSIONS = Object.freeze([68, 69]);

/** UProperty flags observed in the original Core.dll layout. */
export const PROPERTY_FLAGS = Object.freeze({
  OptionalParm: 0x00000010,
  Net: 0x00000020,
  Parm: 0x00000080,
  OutParm: 0x00000100,
  SkipParm: 0x00000200,
  ReturnParm: 0x00000400,
  CoerceParm: 0x00000800,
});

/** UFunction bits needed to interpret its v68/v69 tail. */
export const FUNCTION_FLAGS = Object.freeze({
  Net: 0x00000040,
  Native: 0x00000400,
});

const PROPERTY_TYPES = Object.freeze({
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

/** A version/type branch that has not yet been established from original data. */
export class UnsupportedScriptMetadataError extends Error {
  constructor(message, { version = null, className = null, index = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptMetadataError';
    this.code = 'UNSUPPORTED_SCRIPT_METADATA';
    this.version = version;
    this.className = className;
    this.index = index;
  }
}

function checkVersion(pkg) {
  if (!pkg || !SCRIPT_METADATA_VERSIONS.includes(pkg.version)) {
    throw new UnsupportedScriptMetadataError(
      `Unsupported script metadata package version ${pkg?.version ?? 'unknown'}; ` +
      'only original v68/v69 layouts are established', { version: pkg?.version },
    );
  }
}

function context(asset, index) {
  if (!asset || !asset.pkg || !(asset.bytes instanceof Uint8Array)) {
    throw new TypeError('Expected an asset with pkg and Uint8Array bytes');
  }
  const { pkg, bytes } = asset;
  checkVersion(pkg);
  if (!Number.isInteger(index) || index <= 0) throw new PackageError('Expected positive export index', 0);
  const entry = objectAt(pkg, index);
  if (!entry || !entry.serialSize || entry.serialOffset == null) {
    throw new PackageError(`Expected serialized export ${index}`, 0);
  }
  const end = entry.serialOffset + entry.serialSize;
  if (entry.serialOffset < 0 || end > bytes.length) throw new PackageError('Serialized export outside asset', entry.serialOffset);
  return { asset, pkg, bytes, index, entry, data: bytes.subarray(entry.serialOffset, end) };
}

function readRef(pkg, r) {
  const index = r.compact();
  // Validate both local exports and imports while retaining the encoded index.
  const entry = objectAt(pkg, index);
  return { index, entry };
}

function readNullableRef(pkg, r) {
  const { index, entry } = readRef(pkg, r);
  return index === 0 ? null : { index, entry };
}

function readName(pkg, r) {
  const index = r.compact();
  return { index, name: nameAt(pkg, index) };
}

function refIndex(ref) { return ref ? ref.index : 0; }

function refView(ref) {
  if (!ref) return null;
  return { index: ref.index, name: ref.entry?.name ?? null, path: ref.entry?.path ?? null,
    className: ref.entry?.className ?? null };
}

function copyBytes(bytes) { return bytes.slice(); }

// The UField reference words of a struct prefix, read for their position and checked against the tables, not kept as objects: the
// metadata keeps the indices (baseRef, nextRef, scriptTextRef, childrenRef), and nothing read the {index, entry} objects or the
// marker and name objects (docs/live-heap.md "Steps 2 and 3's results").
function readRefIndex(pkg, r) {
  const index = r.compact();
  objectAt(pkg, index);
  return index;
}

/**
 * Parse the UField + UStruct prefix used by Function and State exports.  A
 * Class export has the same prefix but omits the leading serialized `None`
 * tag, hence the explicit option.
 */
function readStructPrefix(c, { leadingNone = true } = {}) {
  const { pkg, data, entry } = c;
  const r = new Reader(data);
  if (leadingNone) {
    const marker = readName(pkg, r);
    if (marker.name !== 'None') {
      throw new PackageError(`Expected UField None marker, got ${marker.name}`, marker.index);
    }
  }
  const baseRef = readRefIndex(pkg, r);
  const nextRef = readRefIndex(pkg, r);
  const scriptTextRef = readRefIndex(pkg, r);
  const childrenRef = readRefIndex(pkg, r);
  const name = readName(pkg, r).name;
  const line = r.u32();
  const textPosition = r.u32();
  const scriptSize = r.u32();
  const scriptStart = r.offset;
  skipBytecode(pkg, r, scriptSize);
  const scriptEnd = r.offset;
  // A view of the package bytes, not a copy: the package keeps them for the life of the process, and nothing writes the script's bytes.
  const scriptBytes = data.subarray(scriptStart, scriptEnd);
  return {
    reader: r,
    baseRef, nextRef, scriptTextRef, childrenRef,
    name,
    line, textPosition,
    scriptSize,
    size: scriptSize,
    scriptStart,
    scriptEnd,
    serializedScriptSize: scriptEnd - scriptStart,
    scriptBytes,
    bytes: scriptBytes,
    entry,
  };
}

function scriptView(prefix) {
  return {
    expandedSize: prefix.scriptSize,
    size: prefix.scriptSize,
    start: prefix.scriptStart,
    end: prefix.scriptEnd,
    serializedSize: prefix.serializedScriptSize,
    bytes: prefix.scriptBytes,
  };
}

function fieldHeader(c, { leadingNone = true } = {}) {
  const prefix = readStructPrefix(c, { leadingNone });
  return {
    asset: c.asset,
    pkg: c.pkg,
    index: c.index,
    entry: c.entry,
    className: c.entry.className,
    path: c.entry.path,
    ...prefix,
    script: scriptView(prefix),
  };
}

/**
 * Match AssetStore.resolve's stable object identity for a local export.  A
 * short struct name is not sufficient: the original linker keys a struct by
 * its complete package/object path.
 */
function canonicalKey(asset, entry) {
  return `${asset.name}.${entry.path}`.toLowerCase();
}

function fieldLeadingNone(className) {
  if (className === 'Class') return false;
  if (className === 'Function' || className === 'State' || className === 'Enum' ||
      className === 'Struct' || className === 'Const' || className.endsWith('Property')) return true;
  return null;
}

/**
 * Read only the common serialized UField prefix.  This deliberately avoids
 * decoding the child payload, so links for unsupported field subclasses remain
 * usable by a metadata linker.
 */
export function readFieldLinks(asset, index) {
  const c = context(asset, index);
  const { entry, pkg, data } = c;
  const leadingNone = fieldLeadingNone(entry.className);
  if (leadingNone === null) {
    throw new UnsupportedScriptMetadataError(
      `Unsupported UField link layout for ${entry.className}`,
      { version: pkg.version, className: entry.className, index },
    );
  }
  // Serialized metadata fields are never object state frames.  If this flag
  // is present, the payload starts with FStateFrame data and is not a UField
  // prefix; reject it rather than interpreting that data as links.
  if (entry.flags & 0x02000000) {
    throw new PackageError('Unexpected UField state frame', 0);
  }
  const r = new Reader(data);
  if (leadingNone) {
    const marker = readName(pkg, r);
    if (marker.name !== 'None') {
      throw new PackageError(`Expected UField None marker, got ${marker.name}`, 0);
    }
  }
  const base = readNullableRef(pkg, r);
  const next = readNullableRef(pkg, r);
  return { baseRef: refIndex(base), nextRef: refIndex(next) };
}

// One frozen flag-bit table per distinct property flag word (a few dozen), shared by every property that has it.
const flagBitTables = new Map();
function propertyFlags(flags) {
  let bits = flagBitTables.get(flags);
  if (bits === undefined) {
    bits = Object.freeze(Object.fromEntries(Object.entries(PROPERTY_FLAGS).map(([name, bit]) => [name, Boolean(flags & bit)])));
    flagBitTables.set(flags, bits);
  }
  return bits;
}

function propertyType(className) {
  return PROPERTY_TYPES[className] ?? null;
}

function readTypeRef(pkg, r, key) {
  const ref = readNullableRef(pkg, r);
  return { [`${key}Ref`]: refIndex(ref), [key]: refView(ref) };
}

/**
 * Read one UProperty export.  Category is a serialized FName index; RepOffset
 * is present exactly when CPF_Net (0x20) is set.  Type-specific object refs
 * follow the base serializer in the original v68/v69 package stream.
 */
function readPropertyMetadataFull(asset, index) {
  const c = context(asset, index);
  const { entry, pkg, data } = c;
  if (!entry.className.endsWith('Property')) {
    throw new Error(`Expected UProperty export, got ${entry.className}`);
  }
  const r = new Reader(data);
  const marker = readName(pkg, r);
  if (marker.name !== 'None') throw new PackageError(`Expected UProperty None marker, got ${marker.name}`, 0);
  const superField = readNullableRef(pkg, r);
  const next = readNullableRef(pkg, r);
  const arrayDim = r.u32();
  const flags = r.u32();
  const category = readName(pkg, r);
  const net = Boolean(flags & PROPERTY_FLAGS.Net);
  const repOffset = net ? r.u16() : null;
  const classType = propertyType(entry.className);
  const metadata = {
    asset: c.asset,
    pkg,
    index,
    entry,
    className: entry.className,
    path: entry.path,
    name: entry.name,
    superFieldRef: refIndex(superField),
    nextRef: refIndex(next),
    arrayDim,
    arrayDimension: arrayDim,
    propertyFlags: flags,
    flags,
    flagBits: propertyFlags(flags),
    categoryIndex: category.index,
    category: category.name,
    replication: net ? { enabled: true, offset: repOffset } : null,
    repOffset,
    type: classType,
    valueType: classType,
    supported: Boolean(classType),
    elementSize: null,
    defaultValue: null,
    defaultValueSupported: false,
    unsupported: classType ? null : `No original type serializer recorded for ${entry.className}`,
    // (in the literal: fields added after it were an out-of-line property array on every property)
    parameter: Boolean(flags & PROPERTY_FLAGS.Parm),
    out: Boolean(flags & PROPERTY_FLAGS.OutParm),
    return: Boolean(flags & PROPERTY_FLAGS.ReturnParm),
    optional: Boolean(flags & PROPERTY_FLAGS.OptionalParm),
    coerce: Boolean(flags & PROPERTY_FLAGS.CoerceParm),
    skip: Boolean(flags & PROPERTY_FLAGS.SkipParm),
  };

  // The type serializers below are the exact additional fields observed in
  // Core.dll.  A BoolProperty bit mask is omitted by the original package
  // linker while loading (the native serializer only emits it for an archive
  // with neither loading nor saving set), so no value is fabricated here.
  switch (entry.className) {
    case 'ObjectProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'propertyClass'));
      break;
    case 'ClassProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'propertyClass'));
      Object.assign(metadata, readTypeRef(pkg, r, 'metaClass'));
      break;
    case 'StructProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'struct'));
      break;
    case 'ArrayProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'inner'));
      break;
    case 'MapProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'key'));
      Object.assign(metadata, readTypeRef(pkg, r, 'value'));
      break;
    case 'FixedArrayProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'inner'));
      metadata.fixedArraySize = r.u32();
      break;
    case 'ByteProperty':
      Object.assign(metadata, readTypeRef(pkg, r, 'enum'));
      break;
    case 'BoolProperty':
      metadata.bitMask = null;
      metadata.bitMaskSerialized = false;
      break;
    case 'IntProperty': case 'FloatProperty': case 'NameProperty':
    case 'StrProperty': case 'NoProperty':
      break;
    default:
      // Base UProperty fields remain useful even where this type's native
      // serializer has not been recovered. Preserve the unconsumed bytes.
      break;
  }
  // (the export's bytes and this tail were kept as two copies on every property, and nothing read them)
  const extraLength = data.length - r.offset;
  if (extraLength && !metadata.unsupported) {
    metadata.unsupported = `Unconsumed ${extraLength}-byte ${entry.className} serializer tail`;
  }
  return metadata;
}

/** A property's metadata (readPropertyMetadata): the fields that differ from property to property or change, as fields; the rest derived.
 *
 * Host representation only (docs/live-heap.md "Load records and functions"). The object had 31 to 36 keys on each of the Island's 20,000
 * properties, most of them fixed by the export (`className`, `path`, `name`, `valueType`, the six parameter booleans from the flag word,
 * `category`, `flagBits`, the unset `defaultValue`...). Those are prototype getters that return what the key held. The fields keep the
 * values the object had; a key a reader assigns (`arrayDim`, `flags`, `elementSize`, the struct and inner links...) is an own field,
 * and so is `unsupported` when the export has a reason. A copy with other values is `cloneMetadata`, since a spread does not take a
 * prototype's getters. */
const PROPERTY_OWN_KEYS = ['asset', 'index', 'superFieldRef', 'nextRef', 'arrayDim', 'arrayDimension', 'propertyFlags', 'flags',
  'categoryIndex', 'replication', 'repOffset', 'type', 'elementSize'];
const PROPERTY_DERIVED = ['pkg', 'entry', 'className', 'path', 'name', 'flagBits', 'category', 'valueType', 'supported', 'defaultValue',
  'defaultValueSupported', 'unsupported', 'parameter', 'out', 'return', 'optional', 'coerce', 'skip'];

export class PropertyMetadata {
  constructor(full) {
    this.asset = full.asset;
    this.index = full.index;
    this.superFieldRef = full.superFieldRef;
    this.nextRef = full.nextRef;
    this.arrayDim = full.arrayDim;
    this.arrayDimension = full.arrayDimension;
    this.propertyFlags = full.propertyFlags;
    this.flags = full.flags;
    this.categoryIndex = full.categoryIndex;
    this.replication = full.replication;
    this.repOffset = full.repOffset;
    this.type = full.type;
    this.elementSize = full.elementSize;
    // what only some properties have (the type's references, a bool's mask), in the order they were read
    for (const key of Object.keys(full)) if (!PROPERTY_OWN_KEYS.includes(key) && !PROPERTY_DERIVED.includes(key)) this[key] = full[key];
    if (full.unsupported !== null) this.unsupported = full.unsupported;
  }
  get pkg() { return this.asset.pkg; }
  /** The export's entry in the package tables, made when read (package-tables.mjs): nothing keeps one for each property. */
  get entry() { return exportAt(this.asset.pkg, this.index); }
  get className() { return this.entry.className; }
  get path() { return this.entry.path; }
  get name() { return this.entry.name; }
  get flagBits() { return propertyFlags(this.propertyFlags); }
  get category() { return nameAt(this.asset.pkg, this.categoryIndex); }
  get valueType() { return this.type; }
  get supported() { return Boolean(this.type); }
  get defaultValue() { return null; }
  get defaultValueSupported() { return false; }
  get unsupported() { return null; }
  get parameter() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.Parm); }
  get out() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.OutParm); }
  get return() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.ReturnParm); }
  get optional() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.OptionalParm); }
  get coerce() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.CoerceParm); }
  get skip() { return Boolean(this.propertyFlags & PROPERTY_FLAGS.SkipParm); }
}

// A write to a derived key makes it an own property, as an assignment to the old plain object did.
for (const key of PROPERTY_DERIVED) {
  const { get } = Object.getOwnPropertyDescriptor(PropertyMetadata.prototype, key);
  Object.defineProperty(PropertyMetadata.prototype, key, {
    get,
    set(value) { Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true }); },
    enumerable: false, configurable: true,
  });
}

/** Read one UProperty export (see PropertyMetadata). */
export function readPropertyMetadata(asset, index) {
  return new PropertyMetadata(readPropertyMetadataFull(asset, index));
}

function readLinkedChildren(asset, firstRef, { includeFunctionChildren = false } = {}) {
  const children = [];
  const seen = new Set();
  let ref = firstRef;
  while (ref) {
    if (seen.has(ref)) throw new Error(`Cyclic UField child chain at ${ref}`);
    seen.add(ref);
    const entry = objectAt(asset.pkg, ref);
    if (ref < 0) {
      children.push({ index: ref, entry, supported: false,
        unsupported: 'Cross-package linked UField metadata needs AssetStore resolution' });
      break;
    }
    if (entry.className.endsWith('Property')) {
      children.push(readPropertyMetadata(asset, ref));
      ref = children.at(-1).nextRef;
    } else if (entry.className === 'Function') {
      const fn = readFunctionMetadata(asset, ref, { includeChildren: includeFunctionChildren });
      children.push(fn);
      ref = fn.nextRef;
    } else if (entry.className === 'State') {
      const state = readStateMetadata(asset, ref, { includeChildren: includeFunctionChildren });
      children.push(state);
      ref = state.nextRef;
    } else {
      children.push({ index: ref, entry, supported: false,
        unsupported: `Unsupported linked UField class ${entry.className}` });
      break;
    }
  }
  return children;
}

/**
 * Read the property-only child chain of a serialized UStruct.  Structs in the
 * established GOTY data have local UProperty children in their UField.Next
 * order.  An unresolved import, inherited base, or other child kind is
 * rejected so the value layer cannot silently omit a member.
 */
function readStructFields(asset, firstRef, structIndex) {
  const fields = [];
  const seen = new Set();
  let ref = firstRef;
  while (ref) {
    if (seen.has(ref)) throw new Error(`Cyclic struct child chain at ${ref}`);
    seen.add(ref);
    if (ref < 0) {
      throw new UnsupportedScriptMetadataError(
        `Cross-package struct field link is unresolved at ${ref}`,
        { version: asset.pkg.version, className: 'Struct', index: structIndex },
      );
    }
    const entry = objectAt(asset.pkg, ref);
    if (!entry.className.endsWith('Property')) {
      throw new UnsupportedScriptMetadataError(
        `Unsupported linked struct field class ${entry.className}`,
        { version: asset.pkg.version, className: entry.className, index: ref },
      );
    }
    const metadata = readPropertyMetadata(asset, ref);
    fields.push({
      key: canonicalKey(asset, entry),
      name: entry.name,
      metadata,
    });
    ref = metadata.nextRef;
  }
  return fields;
}

/**
 * Read the common serialized UStruct header and its linked property members.
 * PointRegion (Engine export 1075) is the focused real-data case; its local
 * Zone/iLeaf/ZoneNumber chain establishes the returned structFields shape.
 */
export function readStructMetadata(asset, index, { includeChildren = true } = {}) {
  const c = context(asset, index);
  if (c.entry.className !== 'Struct') throw new Error(`Expected Struct export, got ${c.entry.className}`);
  const metadata = fieldHeader(c);
  if (includeChildren && metadata.baseRef) {
    throw new UnsupportedScriptMetadataError(
      `Struct inheritance is not linked for ${metadata.path}`,
      { version: c.pkg.version, className: c.entry.className, index },
    );
  }
  if (metadata.reader.offset !== c.data.length) {
    throw new PackageError('Trailing UStruct metadata', metadata.reader.offset);
  }
  const structFields = includeChildren
    ? readStructFields(asset, metadata.childrenRef, index)
    : [];
  const children = structFields.map(({ metadata: field }) => field);
  delete metadata.reader;
  return {
    ...metadata,
    kind: 'struct',
    structKey: canonicalKey(asset, c.entry),
    structFields,
    children,
    supported: true,
  };
}

// The replication of a function without FUNC_Net, shared by all of them (nothing writes it).
const NO_REPLICATION = Object.freeze({ enabled: false, offset: null });

/** Read UFunction's v68/v69 native/operator/replication tail and parameters. */
function readFunctionMetadataFull(asset, index, { includeChildren = true } = {}) {
  const c = context(asset, index);
  if (c.entry.className !== 'Function') throw new Error(`Expected Function export, got ${c.entry.className}`);
  const metadata = fieldHeader(c);
  const r = metadata.reader;
  // Core.dll serializes NativeIndex first for every v68/v69 function. It is
  // meaningful only for FUNC_Native (0x400); FUNC_Net (0x40) controls the
  // optional RepOffset that follows FunctionFlags.
  const nativeIndexRaw = r.u16();
  const operatorPrecedence = r.u8();
  const functionFlags = r.u32();
  const hasNativeIndex = Boolean(functionFlags & FUNCTION_FLAGS.Native);
  const hasReplication = Boolean(functionFlags & FUNCTION_FLAGS.Net);
  const replicationOffset = hasReplication ? r.u16() : null;
  const nativeIndex = nativeIndexRaw;
  if (r.offset !== c.data.length) throw new PackageError('Trailing UFunction metadata', r.offset);
  delete metadata.reader;
  const children = includeChildren
    ? readLinkedChildren(asset, metadata.childrenRef)
    : [];
  const parameters = children.filter(child => child.className?.endsWith('Property') && child.parameter);
  return {
    ...metadata,
    kind: 'function',
    replicationOffset,
    repOffset: replicationOffset,
    replication: hasReplication ? { enabled: true, offset: replicationOffset } : NO_REPLICATION,
    operatorPrecedence,
    functionFlags,
    flags: functionFlags,
    nativeIndexRaw,
    nativeIndex,
    nativeIndexIfNative: hasNativeIndex ? nativeIndexRaw : null,
    hasNativeIndex,
    native: hasNativeIndex ? { index: nativeIndexRaw } : null,
    hasReplication,
    children,
    parameters,
    supported: true,
  };
}

/** What the simulation keeps of a function's metadata once the function is prepared (`compact`): the fields it reads, as fields.
 *
 * Host representation only (docs/live-heap.md "Load records and functions"). The full object had 37 keys (an out-of-line property array
 * on top of the object), a view object of the script's bytes and a typed-array view of them, for each of the Island's 7,000 functions.
 * A trace over the three maps' benchmarks and the class-graph validators read nine keys: `functionFlags` and `nativeIndex` (on every
 * script event), `size`, `entry`, `name`, `asset`, `pkg`, `bytes` and `children`/`parameters` (written once). The others read the export
 * again on their first use, `bytes` and `pkg` come from the asset, and a reader sees the value the full object held. Until `compact`
 * the object still holds the decoded full metadata, so a caller that reads the result at once (the context results, the validators)
 * decodes the export once, as before. */
const FUNCTION_SOURCE_KEYS = ['className', 'path', 'baseRef', 'nextRef', 'scriptTextRef', 'childrenRef', 'line', 'textPosition',
  'scriptSize', 'scriptStart', 'scriptEnd', 'serializedScriptSize', 'script', 'kind', 'replicationOffset', 'repOffset', 'replication',
  'operatorPrecedence', 'flags', 'nativeIndexRaw', 'nativeIndexIfNative', 'hasNativeIndex', 'native', 'hasReplication', 'supported'];

export class FunctionMetadata {
  constructor(full) {
    this.asset = full.asset;
    this.index = full.index;
    this.name = full.name;
    this.size = full.size;
    this.functionFlags = full.functionFlags;
    this.nativeIndex = full.nativeIndex;
    this.children = full.children;
    this.parameters = full.parameters;
    // the script's bytes in the package: the asset's own array and the range (the full object's `bytes` is a view of it)
    this.base = full.asset.bytes;
    this.start = full.entry.serialOffset + full.scriptStart;
    this.end = full.entry.serialOffset + full.scriptEnd;
    this.sourceDecoded = full;
  }
  /** The full metadata `readFunctionMetadata` used to return, decoded again unless it is still held. */
  source() { return this.sourceDecoded ??= readFunctionMetadataFull(this.asset, this.index, { includeChildren: false }); }
  /** Let go of the decoded full metadata (a prepared function keeps the fields above only). */
  compact() { this.sourceDecoded = null; }
  get pkg() { return this.asset.pkg; }
  get entry() { return exportAt(this.asset.pkg, this.index); }
  get bytes() { return this.sourceDecoded !== null ? this.sourceDecoded.bytes : this.base.subarray(this.start, this.end); }
  get scriptBytes() { return this.sourceDecoded !== null ? this.sourceDecoded.scriptBytes : this.bytes; }
}

for (const key of FUNCTION_SOURCE_KEYS) {
  Object.defineProperty(FunctionMetadata.prototype, key, {
    get() { return this.source()[key]; },
    // a write makes the key an own property, as an assignment to the old plain object did
    set(value) { Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true }); },
    enumerable: false, configurable: true,
  });
}
for (const key of ['pkg', 'entry', 'bytes', 'scriptBytes']) {
  const { get } = Object.getOwnPropertyDescriptor(FunctionMetadata.prototype, key);
  Object.defineProperty(FunctionMetadata.prototype, key, {
    get,
    set(value) { Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true }); },
    enumerable: false, configurable: true,
  });
}

/** Read one UFunction export (see FunctionMetadata for what the result keeps). */
export function readFunctionMetadata(asset, index, options) {
  return new FunctionMetadata(readFunctionMetadataFull(asset, index, options));
}

/** Read UState's probe/ignore masks, label table offset, and state flags. */
export function readStateMetadata(asset, index, { includeChildren = true } = {}) {
  const c = context(asset, index);
  if (c.entry.className !== 'State') throw new Error(`Expected State export, got ${c.entry.className}`);
  const metadata = fieldHeader(c);
  const r = metadata.reader;
  const probeMask = [r.u32(), r.u32()];
  const ignoreMask = [r.u32(), r.u32()];
  const labelTableOffset = r.u16();
  const stateFlags = r.u32();
  if (r.offset !== c.data.length) throw new PackageError('Trailing UState metadata', r.offset);
  delete metadata.reader;
  const children = includeChildren
    ? readLinkedChildren(asset, metadata.childrenRef)
    : [];
  return {
    ...metadata,
    kind: 'state',
    probeMask,
    ignoreMask,
    labelTableOffset,
    stateFlags,
    flags: stateFlags,
    children,
    supported: true,
  };
}

/** Read the common class header and the fields needed by a metadata linker. */
export function readClassMetadata(asset, index, { includeChildren = true } = {}) {
  const c = context(asset, index);
  if (c.entry.className !== 'Class') throw new Error(`Expected Class export, got ${c.entry.className}`);
  const metadata = fieldHeader(c, { leadingNone: false });
  const r = metadata.reader;
  const probeMask = [r.u32(), r.u32()];
  const ignoreMask = [r.u32(), r.u32()];
  const labelTableOffset = r.u16();
  const stateFlags = r.u32();
  const classFlags = r.u32();
  const guid = copyBytes(r.take(16));
  // Class dependency/default tails belong to classes.mjs. Stop at the exact
  // point needed for script linking and leave those bytes available as raw.
  const children = includeChildren ? readLinkedChildren(asset, metadata.childrenRef) : [];
  delete metadata.reader;
  return {
    ...metadata,
    kind: 'class',
    friendlyName: metadata.name,
    probeMask,
    ignoreMask,
    labelTableOffset,
    stateFlags,
    classFlags,
    guid,
    children,
    tailOffset: r.offset,
    tail: copyBytes(c.data.subarray(r.offset)),
    supported: true,
  };
}

/** Dispatch one serialized script field/property/class export. */
export function readScriptMetadata(asset, index, options = {}) {
  const entry = context(asset, index).entry;
  if (entry.className === 'Function') return readFunctionMetadata(asset, index, options);
  if (entry.className === 'State') return readStateMetadata(asset, index, options);
  if (entry.className === 'Struct') return readStructMetadata(asset, index, options);
  if (entry.className === 'Class') return readClassMetadata(asset, index, options);
  if (entry.className.endsWith('Property')) return readPropertyMetadata(asset, index);
  throw new UnsupportedScriptMetadataError(`Unsupported script metadata class ${entry.className}`, {
    version: asset.pkg.version, className: entry.className, index,
  });
}

/** Return the linked UField children for an export without reimplementing a reader. */
export function readFieldChildren(asset, index) {
  const metadata = readScriptMetadata(asset, index, { includeChildren: false });
  return readLinkedChildren(asset, metadata.childrenRef);
}

/**
 * Primitive zero values are the only defaults established here. Authored
 * class defaults live in UClass's tagged default stream and are intentionally
 * left to classes.mjs; this helper only initializes a fresh VM local slot.
 */
export function primitiveDefault(property) {
  switch (property?.type) {
    case 'bool': return false;
    case 'byte': case 'int': case 'float': return 0;
    case 'name': return 'None';
    case 'string': return '';
    case 'object': case 'class': return null;
    default: return undefined;
  }
}
