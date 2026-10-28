/**
 * Shared helper plumbing for the verified complex UProperty Link bodies.
 *
 * The scalar and bool linkers each keep their own copies of these small
 * boundaries.  The five complex bodies (Str/Array/FixedArray/Map/Struct) were
 * translated together, so they share one helper module instead.  See
 * docs/script-complex-property-link.md for the per-body contract.
 */

import {NativeSlots} from './native-slots.mjs';

/** CPF bits consumed by every complex body (`testb $0x10, %ah` and `orl 0x400000`). */
export const LINK_FLAGS = Object.freeze({
  // Skipped-destruction ("atomic") bit: property 0x1000 present -> do not set the
  // need-destruction flag.
  atomic: 0x1000,
  // "Need destruction" bit added by the bodies, and consumed by UStruct::Link
  // when it builds the destroy property chain.
  needDestruction: 0x400000,
});

/** Native property record offsets used by every recovered Link body. */
export const UPROPERTY_OFFSETS = Object.freeze({
  vtable: 0x00, outer: 0x18, arrayDim: 0x34, elementSize: 0x38,
  propertyFlags: 0x3c, offset: 0x48, child: 0x5c, childExt: 0x60,
});

/**
 * Container object vtables whose GetPropertiesSize (+0x64) reads the running
 * size from +0x3c.  UStruct/UState/UClass/UFunction all inherit that
 * implementation; these are the reachable Outer containers for a property.
 */
export const OUTER_GET_PROPERTIES_SIZE_VTABLES = Object.freeze([
  0x10175698, // UStruct
  0x101757d8, // UState
  0x101758f4, // UClass
  0x10175738, // UFunction
]);

/**
 * Build a bound helper set for one complex property Link body.  Every helper
 * closes over the body's verified error identity.
 */
export function linkHelpers(kind, code) {
  const ErrorType = failureConstructor(kind, code);
  const Fail = (message, details = {}) => {
    throw new ErrorType(message, details);
  };
  const own = (source, key) => source !== null && source !== undefined && Object.hasOwn(source, key);
  const first = (source, keys, fallback = undefined) => {
    for (const key of keys) {
      if (source !== null && source !== undefined && source[key] !== undefined) return source[key];
    }
    return fallback;
  };
  const integer = (value, label, { minimum = 0, maximum = 0x7fffffff } = {}) => {
    if (value === null || value === undefined) {
      throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
    }
    return number;
  };
  const readSlot = (object, offset, aliases, services, detail = {}) => {
    if (typeof services.readSlot === 'function') {
      const value = services.readSlot(object, offset, { kind: `${code.toLowerCase()}-read-slot`, offset, ...detail });
      if (value !== undefined) return value;
    }
    if (object?.nativeSlots instanceof NativeSlots && object.nativeSlots.has(offset)) return object.nativeSlots.value(offset);
    return first(object, aliases, undefined);
  };
  const writeSlot = (object, offset, value, width, services, detail = {}) => {
    const writer = services.writeSlot ?? services.writeNativeSlot;
    if (typeof writer === 'function') {
      writer(object, offset, value, width, { kind: `${code.toLowerCase()}-write-slot`, offset, width, ...detail });
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
      Fail(`${kind}::Link has no writable +0x${offset.toString(16)} binding`, { slot: `+0x${offset.toString(16)}` });
    }
    return value;
  };
  const pointer = value => (value === null || value === undefined || value === 0 ? null : value);
  const alignedUp = (size, alignment) => {
    if (alignment === 1) return size;
    // Mask form `(Size + A - 1) & ~(A - 1)`; keeps the result within INT.
    return Math.floor((size + alignment - 1) / alignment) * alignment;
  };
  const optionsFor = (archiveOrOptions, previousProperty, rawServices) => {
    if (archiveOrOptions && typeof archiveOrOptions === 'object' && own(archiveOrOptions, 'archive')) {
      return {
        archive: archiveOrOptions.archive,
        previousProperty: archiveOrOptions.previousProperty ?? archiveOrOptions.previous ?? null,
        services: archiveOrOptions.services ?? {},
      };
    }
    return { archive: archiveOrOptions, previousProperty: previousProperty ?? null, services: rawServices ?? {} };
  };

  /** Outer->GetPropertiesSize() (+0x64) read the recovered bodies use. */
  const readOuterPropertiesSize = (outer, services, detail) => {
    const getter = services.getPropertiesSize ?? services.propertiesSize;
    if (typeof getter === 'function') {
      const value = getter(outer, { kind: `${code.toLowerCase()}-get-properties-size`, outer, virtualSlot: 0x64, ...detail });
      if (value === undefined) Fail(`${kind}::Link requires Outer GetPropertiesSize (+0x64)`, { slot: '+0x64', field: outer });
      return integer(value, 'Outer GetPropertiesSize', { minimum: 0 });
    }
    const vtable = readSlot(outer, 0, ['nativeVtable', 'vtable'], services, detail);
    const normalized = vtable === undefined || vtable === null ? -1 : integer(vtable, 'Outer vtable', { maximum: 0xffffffff }) >>> 0;
    if (!OUTER_GET_PROPERTIES_SIZE_VTABLES.includes(normalized)) {
      Fail(`${kind}::Link requires the Outer GetPropertiesSize (+0x64) override`, { slot: '+0x64', field: outer });
    }
    const value = readSlot(outer, 0x3c, ['propertiesSize', 'propertySize'], services, detail);
    if (value === undefined) Fail(`${kind}::Link requires Outer GetPropertiesSize (+0x64)`, { slot: '+0x64', field: outer });
    return integer(value, 'Outer GetPropertiesSize', { minimum: 0 });
  };

  /** Ar->Preload (+0x10) of a referenced UObject. */
  const preload = (slot, archive, services) => {
    if (services.preload) services.preload(slot, archive);
    else if (typeof archive?.preload === 'function') archive.preload(slot);
    else Fail(`${kind}::Link requires FArchive::Preload (+0x10)`, { slot, archive });
  };

  return {
    ErrorType,
    Fail,
    own,
    first,
    integer,
    readSlot,
    writeSlot,
    pointer,
    alignedUp,
    optionsFor,
    readOuterPropertiesSize,
    preload,
  };
}

/**
 * Inner/Key/Value `->Link(Ar, 0)` virtual call at slot +0x68.  The native body
 * passes a null Prev exactly as UStruct::Link does for a direct child.  The
 * dispatcher route is registered by src/runtime/script-property-link.mjs so
 * the complex body modules do not import the dispatcher directly.
 */
export function linkChildProperty(property, archive, services) {
  if (typeof services.linkProperty === 'function') return services.linkProperty(property, archive, null);
  const route = propertyLinkerRoute;
  if (typeof route !== 'function') {
    throw new TypeError('Complex UProperty::Link requires the linked dispatcher or services.linkProperty');
  }
  return route(property, { archive, previousProperty: null, services: services.complexPropertyLink ?? services });
}

let propertyLinkerRoute = null;
export function setPropertyLinkRouter(route) {
  propertyLinkerRoute = route;
}

function failureConstructor(kind, code) {
  return class UnsupportedScriptComplexPropertyLinkError extends Error {
    constructor(message, {
      operation = `${kind}::Link`, kind: fieldKind = null, vtable = null, slot = null,
    } = {}) {
      super(message);
      this.name = 'UnsupportedScriptComplexPropertyLinkError';
      this.code = code;
      this.operation = operation;
      this.fieldKind = fieldKind ?? kind;
      this.vtable = vtable;
      this.slot = slot;
    }
  };
}