import { PackageError, Reader } from './package.mjs';
import { nameAt, objectAt } from './objects.mjs';
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
export function readPropertyMetadata(asset, index) {
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
export function readFunctionMetadata(asset, index, { includeChildren = true } = {}) {
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
