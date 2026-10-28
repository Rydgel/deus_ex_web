/**
 * UBoolProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * This is the first of the "complex" property Link virtuals: unlike the scalar
 * bodies (which derive from the `ret 8` UProperty::Link base and only write
 * ElementSize/Offset), the bool body packs consecutive bool properties into a
 * single 32-bit DWORD through a shifting bitmask, and it inspects both the
 * PreviousProperty argument and a second Outer virtual, MergeBools (+0x58),
 * that the scalar bodies never touch.
 *
 * Recovered body (thunk 0x10101230 -> body 0x10166060):
 *
 *   Super::Link(Ar, Prev)                    // UProperty::Link @0x10165640 = ret 8, no-op
 *   prevBool = Cast<UBoolProperty>(Prev)     // walk Prev->Class(+0x24)/SuperStruct(+0x28) vs 0x102a6bf0
 *   if (Outer->MergeBools()[+0x58] && prevBool && (prevBool->BitMask & 0x7fffffff)) {
 *       BitMask = prevBool->BitMask << 1;    // share Prev's DWORD, next bit
 *       Offset  = Prev->Offset;
 *   } else {
 *       BitMask = 1;                         // fresh DWORD, first bit
 *       Offset  = Align(Outer->GetPropertiesSize()[+0x64], 4);
 *   }
 *   ElementSize[+0x38] = 4                    // written last, both paths
 *
 * MergeBools is overridden per container (all four bodies verified in Core.dll):
 * UField (0x10125d40) = 1, UState (0x101104e0) = 1, UClass (0x10111560) = 1,
 * UFunction (0x1010fee0) = 0.  UStruct has no override and inherits UField's 1.
 * So class/state/struct bools pack; UFunction bools (parameters and locals)
 * never pack and each take their own DWORD.  The masked test `& 0x7fffffff`
 * is exactly `prevBool->BitMask != 0x80000000`: once bit 31 is taken, the next
 * bool starts a fresh DWORD instead of shifting out of range.
 *
 * The Cast<UBoolProperty> is exact as a leaf-class kind test: UBoolProperty has
 * no subclasses, so an object is-a UBoolProperty iff its exact class is
 * UBoolProperty iff its property kind is `BoolProperty`.  A host may override
 * with `services.isBoolProperty` for a live class-chain walk.
 *
 * Layout uses the same live `nativeSlots` / `readSlot` / `writeSlot` boundary
 * as src/runtime/script-scalar-property-link.mjs and src/runtime/script-struct-link.mjs.
 */

import {NativeSlots} from './native-slots.mjs';

export const SCRIPT_BOOL_PROPERTY_LINK = Object.freeze({
  uProperty: Object.freeze({
    // The base UProperty::Link the derived body chains to is a native `ret 8`;
    // the compiler inlines the empty Super::Link call away in this body.
    linkSlot: 0x68,
    vtable: 0x10175a44,
    linkBody: 0x10165640,
  }),
  boolProperty: Object.freeze({
    kind: 'BoolProperty',
    vtable: 0x10175c84,
    linkThunk: 0x10101230,
    linkBody: 0x10166060,
    // UBoolProperty class object compared by the Cast<UBoolProperty> loop.
    staticClass: 0x102a6bf0,
    elementSize: 4,
    alignment: 4,
  }),
  mergeBools: Object.freeze({
    virtualSlot: 0x58,
    bodies: Object.freeze({
      UField: 0x10125d40, UState: 0x101104e0, UClass: 0x10111560, UFunction: 0x1010fee0,
    }),
  }),
  getPropertiesSize: Object.freeze({
    virtualSlot: 0x64,
    thunk: 0x101026e4,
    body: 0x1010f7c0,
  }),
  offsets: Object.freeze({
    vtable: 0x00,
    class: 0x24,
    superStruct: 0x28,
    outer: 0x18,
    arrayDim: 0x34,
    elementSize: 0x38,
    propertyFlags: 0x3c,
    offset: 0x48,
    bitMask: 0x5c,
  }),
  // Container object vtable -> MergeBools() result.  UStruct (inherits UField),
  // UState and UClass merge; UFunction does not.
  outerMergeBools: Object.freeze(new Map([
    [0x10175698, 1], [0x101757d8, 1], [0x101758f4, 1], [0x10175738, 0],
  ])),
  // Container object vtables whose GetPropertiesSize (+0x64) is the recovered
  // UStruct override reading +0x3c.  UState/UClass/UFunction inherit it; only
  // UField and UStruct define GetPropertiesSize, and every container above is a
  // UStruct.  The scalar module scopes the same fallback to UStruct/UState/UClass;
  // UFunction is added here because function-owned bools always reach the fresh
  // path (MergeBools = 0) and must read the running size.
  outerGetPropertiesSizeVtables: Object.freeze([0x10175698, 0x101757d8, 0x101758f4, 0x10175738]),
});

export class UnsupportedScriptBoolPropertyLinkError extends Error {
  constructor(message, { operation = 'UBoolProperty::Link', kind = null, vtable = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptBoolPropertyLinkError';
    this.code = 'UNSUPPORTED_SCRIPT_BOOL_PROPERTY_LINK';
    this.operation = operation;
    this.kind = kind;
    this.vtable = vtable;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptBoolPropertyLinkError(message, details);
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
      kind: 'bool-property-link-read-slot', offset, ...detail,
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
      kind: 'bool-property-link-write-slot', offset, width, ...detail,
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
    fail(`UBoolProperty::Link has no writable +0x${offset.toString(16)} binding`, {
      slot: `+0x${offset.toString(16)}`,
    });
  }
  return value;
}

function pointer(value) {
  return value === null || value === undefined || value === 0 ? null : value;
}

function alignedOffset(size, alignment) {
  if (alignment === 1) return size;
  // The recovered body uses `(Size + 3) & ~3`; the size bound keeps this within
  // native INT.
  return Math.floor((size + alignment - 1) / alignment) * alignment;
}

/** Package class names omit the C++ `U` prefix; ObjectProperty has an alias. */
function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UBoolProperty' ? 'BoolProperty' : String(value);
}

function propertyKind(property) {
  const kind = normalizeKind(first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    fail('UBoolProperty::Link requires an explicit verified native property kind', {
      slot: '+0x0', field: property,
    });
  }
  return kind;
}

function propertyVtable(property, services) {
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'bool-property-link-vtable', offset: SCRIPT_BOOL_PROPERTY_LINK.offsets.vtable })
    : readSlot(property, SCRIPT_BOOL_PROPERTY_LINK.offsets.vtable, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    fail('UBoolProperty::Link requires the native vtable for BoolProperty', {
      kind: 'BoolProperty', slot: '+0x0', field: property,
    });
  }
  return integer(value, 'BoolProperty native vtable', { minimum: 0, maximum: 0xffffffff }) >>> 0;
}

function requireBoolProperty(property, services) {
  const kind = propertyKind(property);
  if (kind !== 'BoolProperty') {
    fail(`UBoolProperty::Link does not implement ${kind}; use the scalar or dispatching linker`, {
      kind, slot: '+0x0', field: property,
    });
  }
  const vtable = propertyVtable(property, services);
  if (vtable !== SCRIPT_BOOL_PROPERTY_LINK.boolProperty.vtable) {
    fail(`UBoolProperty::Link vtable 0x${vtable.toString(16)} does not match BoolProperty 0x${SCRIPT_BOOL_PROPERTY_LINK.boolProperty.vtable.toString(16)}`, {
      kind, vtable, slot: '+0x0', field: property,
    });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = readSlot(property, SCRIPT_BOOL_PROPERTY_LINK.offsets.outer,
    ['outer', 'outerObject', 'owner'], services, {});
  const outer = pointer(value);
  if (outer === null) {
    fail('UBoolProperty::Link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

/** Outer->MergeBools() (+0x58); native tests the raw int against zero. */
function outerMergeBools(outer, services) {
  const detail = {
    kind: 'bool-property-link-merge-bools',
    outer,
    virtualSlot: SCRIPT_BOOL_PROPERTY_LINK.mergeBools.virtualSlot,
  };
  const getter = services.mergeBools ?? services.getMergeBools;
  if (typeof getter === 'function') {
    const value = getter(outer, detail);
    if (value === undefined || value === null) {
      fail('UBoolProperty::Link requires Outer MergeBools (+0x58)', { slot: '+0x58', field: outer });
    }
    return integer(value, 'Outer MergeBools', { minimum: 0, maximum: 0xffffffff });
  }
  const vtable = readSlot(outer, 0, ['nativeVtable', 'vtable'], services, detail);
  const mapped = vtable === undefined || vtable === null
    ? undefined
    : SCRIPT_BOOL_PROPERTY_LINK.outerMergeBools.get(integer(vtable, 'Outer vtable', { maximum: 0xffffffff }) >>> 0);
  if (mapped === undefined) {
    fail('UBoolProperty::Link requires the Outer MergeBools (+0x58) override', {
      slot: '+0x58', field: outer,
    });
  }
  return mapped;
}

/** Outer->GetPropertiesSize() (+0x64) on the fresh-DWORD path. */
function outerPropertiesSize(outer, services) {
  const detail = {
    kind: 'bool-property-link-get-properties-size',
    outer,
    virtualSlot: SCRIPT_BOOL_PROPERTY_LINK.getPropertiesSize.virtualSlot,
    thunk: SCRIPT_BOOL_PROPERTY_LINK.getPropertiesSize.thunk,
    body: SCRIPT_BOOL_PROPERTY_LINK.getPropertiesSize.body,
  };
  const getter = services.getPropertiesSize ?? services.propertiesSize;
  let value;
  if (typeof getter === 'function') value = getter(outer, detail);
  else {
    const vtable = readSlot(outer, 0, ['nativeVtable', 'vtable'], services, detail);
    if (!SCRIPT_BOOL_PROPERTY_LINK.outerGetPropertiesSizeVtables.includes(
      vtable === undefined || vtable === null ? -1 : integer(vtable, 'Outer vtable', { maximum: 0xffffffff }) >>> 0)) {
      fail('UBoolProperty::Link requires the Outer GetPropertiesSize (+0x64) override', {
        slot: '+0x64', field: outer,
      });
    }
    value = readSlot(outer, 0x3c, ['propertiesSize', 'propertySize'], services, detail);
  }
  if (value === undefined) {
    fail('UBoolProperty::Link requires Outer GetPropertiesSize (+0x64)', { slot: '+0x64', field: outer });
  }
  return integer(value, 'Outer GetPropertiesSize', { minimum: 0 });
}

/** Cast<UBoolProperty>(Prev): exact as a leaf-class kind test. */
function castBoolPrev(previousProperty, services) {
  if (previousProperty === null || previousProperty === undefined) return null;
  if (typeof services.isBoolProperty === 'function') {
    return services.isBoolProperty(previousProperty) ? previousProperty : null;
  }
  const kind = normalizeKind(first(previousProperty, ['nativeKind', 'kind'], undefined));
  return kind === 'BoolProperty' ? previousProperty : null;
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
 * Replay the verified UBoolProperty::Link body.
 *
 * The options form is canonical; `linkBoolProperty` below is the callback shape
 * for UStruct::Link's `(property, archive, previous)` service boundary.
 */
export function linkScriptBoolProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UBoolProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UBoolProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UBoolProperty::Link services must be an object');
  const services = rawServices;
  const O = SCRIPT_BOOL_PROPERTY_LINK.offsets;

  const vtable = requireBoolProperty(property, services);
  const outer = outerOf(property, services);
  const mergeBools = outerMergeBools(outer, services);
  const prevBool = castBoolPrev(previousProperty, services);

  let bitMask;
  let offset;
  let outerSize = null;
  let packed = false;
  let prevBitMask = null;

  if (mergeBools !== 0 && prevBool !== null) {
    prevBitMask = integer(readSlot(prevBool, O.bitMask, ['bitMask', 'bitmask'], services, {}),
      'previous BoolProperty BitMask', { maximum: 0xffffffff }) >>> 0;
    if ((prevBitMask & 0x7fffffff) !== 0) {
      packed = true;
      bitMask = (prevBitMask << 1) >>> 0;
      offset = integer(readSlot(prevBool, O.offset, ['offset'], services, {}), 'previous property Offset');
    }
  }
  if (!packed) {
    outerSize = outerPropertiesSize(outer, services);
    bitMask = 1;
    offset = alignedOffset(outerSize, SCRIPT_BOOL_PROPERTY_LINK.boolProperty.alignment);
  }

  // Native write order (both paths): BitMask (+0x5c), Offset (+0x48), then
  // ElementSize (+0x38) last.
  writeSlot(property, O.bitMask, bitMask, 4, services, { body: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.linkBody });
  writeSlot(property, O.offset, offset, 4, services, { body: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.linkBody });
  writeSlot(property, O.elementSize, SCRIPT_BOOL_PROPERTY_LINK.boolProperty.elementSize, 4, services,
    { body: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.linkBody });

  return {
    property,
    archive,
    previousProperty,
    kind: 'BoolProperty',
    nativeVtable: vtable,
    linkSlot: SCRIPT_BOOL_PROPERTY_LINK.uProperty.linkSlot,
    linkThunk: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.linkThunk,
    linkBody: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.linkBody,
    elementSize: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.elementSize,
    alignment: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.alignment,
    outer,
    mergeBools,
    prevBool,
    prevBitMask,
    packed,
    bitMask,
    offset,
    outerPropertiesSize: outerSize,
    // ArrayDim and PropertyFlags stay owned by UStruct::Link.
    arrayDimOffset: O.arrayDim,
    propertyFlagsOffset: O.propertyFlags,
    bitMaskOffset: O.bitMask,
    operations: [
      { operation: 'merge-bools', virtualSlot: SCRIPT_BOOL_PROPERTY_LINK.mergeBools.virtualSlot, value: mergeBools },
      ...(packed
        ? [{ operation: 'read-previous-bit-mask', offset: O.bitMask, value: prevBitMask }]
        : [{ operation: 'get-properties-size', virtualSlot: SCRIPT_BOOL_PROPERTY_LINK.getPropertiesSize.virtualSlot, value: outerSize }]),
      { operation: 'write-bit-mask', offset: O.bitMask, value: bitMask, width: 4 },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      { operation: 'write-element-size', offset: O.elementSize, value: SCRIPT_BOOL_PROPERTY_LINK.boolProperty.elementSize, width: 4 },
    ],
  };
}

/** Direct callback shape for `linkScriptStruct(... services.linkProperty)`. */
export function linkBoolProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptBoolProperty(property, optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptBoolProperty;
