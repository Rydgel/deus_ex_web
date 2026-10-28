/**
 * Scalar UProperty::Link virtuals from the installed Deus Ex GOTY Core.dll.
 *
 * The derived bodies do not call UProperty::Link: the base body is a native
 * `ret 8`.  Each body writes ElementSize (+0x38), asks its Outer for the
 * current GetPropertiesSize (+0x64), then writes Offset (+0x48).  Archive and
 * PreviousProperty are still part of the native call signature and are kept
 * in the returned record, although these five bodies do not inspect them.
 */

import {NativeSlots} from './native-slots.mjs';

export const SCRIPT_SCALAR_PROPERTY_LINK = Object.freeze({
  uProperty: Object.freeze({
    linkSlot: 0x68,
    vtable: 0x10175a44,
    linkThunk: 0x10102a04,
    linkBody: 0x10165640,
  }),
  getPropertiesSize: Object.freeze({
    virtualSlot: 0x64,
    thunk: 0x101026e4,
    body: 0x1010f7c0,
  }),
  offsets: Object.freeze({
    vtable: 0x00,
    outer: 0x18,
    arrayDim: 0x34,
    elementSize: 0x38,
    propertyFlags: 0x3c,
    offset: 0x48,
  }),
  properties: Object.freeze({
    ByteProperty: Object.freeze({
      vtable: 0x10175b04,
      linkThunk: 0x10102e6e,
      linkBody: 0x101656f0,
      elementSize: 1,
      alignment: 1,
    }),
    IntProperty: Object.freeze({
      vtable: 0x10175bc4,
      linkThunk: 0x10102ba3,
      linkBody: 0x10165c60,
      elementSize: 4,
      alignment: 4,
    }),
    FloatProperty: Object.freeze({
      vtable: 0x10175d44,
      linkThunk: 0x10102c89,
      linkBody: 0x101666a0,
      elementSize: 4,
      alignment: 4,
    }),
    NameProperty: Object.freeze({
      vtable: 0x10175f84,
      linkThunk: 0x10102bb7,
      linkBody: 0x10167250,
      elementSize: 4,
      alignment: 4,
    }),
    ObjectProperty: Object.freeze({
      vtable: 0x10175e04,
      linkThunk: 0x10102efa,
      linkBody: 0x10166a90,
      elementSize: 4,
      alignment: 4,
    }),
    // ClassProperty supplies no separate Link export in this image.  Its
    // vtable uses UObjectProperty's body at +0x68.
    ClassProperty: Object.freeze({
      vtable: 0x10175ec4,
      linkThunk: null,
      linkBody: 0x10166a90,
      inheritedFrom: 'UObjectProperty',
      elementSize: 4,
      alignment: 4,
    }),
  }),
});

export class UnsupportedScriptScalarPropertyLinkError extends Error {
  constructor(message, { operation = 'UProperty::Link', kind = null, vtable = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptScalarPropertyLinkError';
    this.code = 'UNSUPPORTED_SCRIPT_SCALAR_PROPERTY_LINK';
    this.operation = operation;
    this.kind = kind;
    this.vtable = vtable;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptScalarPropertyLinkError(message, details);
}

function own(source, key) {
  return source !== null && source !== undefined && Object.hasOwn(source, key);
}

function first(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (source !== null && source !== undefined && source[key] !== undefined) return source[key];
  }
  return fallback;
}

function integer(value, label, { minimum = 0, maximum = 0x7fffffff } = {}) {
  if (value === null || value === undefined) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function readSlot(object, offset, aliases, services, detail = {}) {
  if (typeof services.readSlot === 'function') {
    const value = services.readSlot(object, offset, {
      kind: 'scalar-property-link-read-slot', offset, ...detail,
    });
    if (value !== undefined) return value;
  }
  if (object?.nativeSlots instanceof NativeSlots && object.nativeSlots.has(offset)) {
    return object.nativeSlots.value(offset);
  }
  return first(object, aliases, undefined);
}

function writeSlot(object, offset, value, width, services, detail = {}) {
  const writer = services.writeSlot ?? services.writeNativeSlot;
  if (typeof writer === 'function') {
    writer(object, offset, value, width, {
      kind: 'scalar-property-link-write-slot', offset, width, ...detail,
    });
  }
  if (object?.nativeSlots instanceof NativeSlots) {
    const prior = object.nativeSlots.width(offset);
    if (prior !== undefined && prior !== width) {
      throw new Error(`Native property slot +0x${offset.toString(16)} is not ${width} bytes`);
    }
    object.nativeSlots.assign(offset, value, width);
    return value;
  }
  if (typeof writer !== 'function') {
    fail(`UProperty::Link has no writable +0x${offset.toString(16)} binding`, {
      slot: `+0x${offset.toString(16)}`,
    });
  }
  return value;
}

function pointer(value) {
  return value === null || value === undefined || value === 0 ? null : value;
}

function propertyKind(property) {
  const value = first(property, ['nativeKind', 'kind'], undefined);
  if (value === undefined || value === null || value === '') {
    fail('UProperty::Link requires an explicit verified native property kind', {
      slot: '+0x0', field: property,
    });
  }
  // Package class names omit the C++ U prefix.
  return value === 'UObjectProperty' ? 'ObjectProperty' : String(value);
}

function propertyVtable(property, kind, services) {
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, {
      kind: 'scalar-property-link-vtable', propertyKind: kind,
      offset: SCRIPT_SCALAR_PROPERTY_LINK.offsets.vtable,
    })
    : readSlot(property, SCRIPT_SCALAR_PROPERTY_LINK.offsets.vtable,
      ['nativeVtable', 'vtable'], services, { propertyKind: kind });
  if (value === undefined || value === null) {
    fail(`UProperty::Link requires the native vtable for ${kind}`, {
      kind, slot: '+0x0', field: property,
    });
  }
  return integer(value, `${kind} native vtable`, { minimum: 0, maximum: 0xffffffff }) >>> 0;
}

function descriptorFor(property, services) {
  const kind = propertyKind(property);
  const descriptor = SCRIPT_SCALAR_PROPERTY_LINK.properties[kind];
  if (!descriptor) {
    fail(`UProperty::Link does not implement ${kind}; Bool/Struct/Array/Map and other property links remain unsupported`, {
      kind, slot: '+0x68', field: property,
    });
  }
  const vtable = propertyVtable(property, kind, services);
  if (vtable !== descriptor.vtable) {
    fail(`UProperty::Link vtable 0x${vtable.toString(16)} does not match ${kind} 0x${descriptor.vtable.toString(16)}`, {
      kind, vtable, slot: '+0x0', field: property,
    });
  }
  return { kind, vtable, descriptor };
}

function outerOf(property, services, kind) {
  const value = readSlot(property, SCRIPT_SCALAR_PROPERTY_LINK.offsets.outer,
    ['outer', 'outerObject', 'owner'], services, { propertyKind: kind });
  const outer = pointer(value);
  if (outer === null) {
    fail(`UProperty::Link requires a non-null Outer for ${kind}`, {
      kind, slot: '+0x18', field: property,
    });
  }
  return outer;
}

function outerPropertiesSize(property, outer, kind, archive, previousProperty, services) {
  const detail = {
    kind: 'scalar-property-link-get-properties-size',
    propertyKind: kind,
    property,
    outer,
    archive,
    previousProperty,
    virtualSlot: SCRIPT_SCALAR_PROPERTY_LINK.getPropertiesSize.virtualSlot,
    thunk: SCRIPT_SCALAR_PROPERTY_LINK.getPropertiesSize.thunk,
    body: SCRIPT_SCALAR_PROPERTY_LINK.getPropertiesSize.body,
  };
  const getter = services.getPropertiesSize ?? services.propertiesSize;
  let value;
  if (typeof getter === 'function') value = getter(outer, detail);
  else {
    const vtable = readSlot(outer, 0, ['nativeVtable', 'vtable'], services, detail);
    // Each of these original vtables points +0x64 at 101026e4 -> 1010f7c0.
    // Other Outer types require their actual virtual binding.
    if (![0x10175698, 0x101757d8, 0x101758f4].includes(vtable)) {
      fail(`UProperty::Link requires the Outer GetPropertiesSize override for ${kind}`, {
        kind, slot: '+0x64', field: outer,
      });
    }
    value = readSlot(outer, 0x3c, ['propertiesSize', 'propertySize'], services, detail);
  }
  if (value === undefined) {
    fail(`UProperty::Link requires Outer GetPropertiesSize (+0x64) for ${kind}`, {
      kind, slot: '+0x64', field: outer,
    });
  }
  return integer(value, 'Outer GetPropertiesSize', { minimum: 0 });
}

function alignedOffset(size, alignment) {
  if (alignment === 1) return size;
  // The recovered scalar bodies use `(Size + 3) & ~3` for their four-byte
  // values.  The size bound above keeps this arithmetic within native INT.
  return Math.floor((size + alignment - 1) / alignment) * alignment;
}

function optionsFor(archiveOrOptions, previousProperty, rawServices) {
  if (archiveOrOptions && typeof archiveOrOptions === 'object' && own(archiveOrOptions, 'archive')) {
    return {
      archive: archiveOrOptions.archive,
      previousProperty: archiveOrOptions.previousProperty ?? archiveOrOptions.previous ?? null,
      services: archiveOrOptions.services ?? {},
    };
  }
  return { archive: archiveOrOptions, previousProperty: previousProperty ?? null, services: rawServices ?? {} };
}

/**
 * Replay one of the verified scalar UProperty Link bodies.
 *
 * The options form is the canonical API.  `linkScalarProperty` below is a
 * callback-shaped alias for UStruct::Link's `(property, archive, previous)`
 * service boundary.
 */
export function linkScriptScalarProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UProperty::Link services must be an object');
  const services = rawServices;
  const { kind, vtable, descriptor } = descriptorFor(property, services);
  const outer = outerOf(property, services, kind);

  // This write precedes the virtual GetPropertiesSize call in every reached
  // body, so a live host observes ElementSize during that callback.
  writeSlot(property, SCRIPT_SCALAR_PROPERTY_LINK.offsets.elementSize,
    descriptor.elementSize, 4, services, { propertyKind: kind, body: descriptor.linkBody });
  const size = outerPropertiesSize(property, outer, kind, archive, previousProperty, services);
  const offset = alignedOffset(size, descriptor.alignment);
  writeSlot(property, SCRIPT_SCALAR_PROPERTY_LINK.offsets.offset, offset, 4, services, {
    propertyKind: kind, body: descriptor.linkBody, alignment: descriptor.alignment,
  });

  return {
    property,
    archive,
    previousProperty,
    kind,
    nativeVtable: vtable,
    linkSlot: SCRIPT_SCALAR_PROPERTY_LINK.uProperty.linkSlot,
    linkThunk: descriptor.linkThunk,
    linkBody: descriptor.linkBody,
    inheritedFrom: descriptor.inheritedFrom ?? null,
    elementSize: descriptor.elementSize,
    alignment: descriptor.alignment,
    outer,
    outerPropertiesSize: size,
    offset,
    // These fields are intentionally untouched by the native scalar body;
    // UStruct::Link owns ArrayDim and PropertyFlags.
    arrayDimOffset: SCRIPT_SCALAR_PROPERTY_LINK.offsets.arrayDim,
    propertyFlagsOffset: SCRIPT_SCALAR_PROPERTY_LINK.offsets.propertyFlags,
    operations: [
      { operation: 'write-element-size', offset: SCRIPT_SCALAR_PROPERTY_LINK.offsets.elementSize, value: descriptor.elementSize, width: 4 },
      { operation: 'get-properties-size', virtualSlot: SCRIPT_SCALAR_PROPERTY_LINK.getPropertiesSize.virtualSlot, value: size },
      { operation: 'write-offset', offset: SCRIPT_SCALAR_PROPERTY_LINK.offsets.offset, value: offset, width: 4 },
    ],
  };
}

/** Direct callback shape for `linkScriptStruct(... services.linkProperty)`. */
export function linkScalarProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptScalarProperty(property, optionsFor(archiveOrOptions, previousProperty, services));
}

export const linkProperty = linkScalarProperty;
export const linkUProperty = linkScalarProperty;
export default linkScriptScalarProperty;
