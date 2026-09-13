/**
 * UFixedArrayProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * Thunk 0x101026cb -> body 0x10167c60.  Recovered body:
 *
 *   Ar->Preload(+0x10)[Inner]                    // Inner at +0x5c
 *   Inner->Link(+0x68)[Ar, 0]
 *   ElementSize[+0x38] = Inner->ElementSize[+0x38] * ArrayCount[+0x60]
 *   Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
 *   if (!(PropertyFlags[+0x3c] & 0x1000)) {
 *       PropertyFlags |= (Inner->PropertyFlags[+0x3c] & 0x400000)
 *   }
 *
 * The fixed array itself needs destruction only when its Inner does: the flag
 * is copied from the inner property bit rather than set unconditionally as in
 * the Str/Array/Map bodies.  Inner ElementSize and PropertyFlags are read
 * after the child +0x68 Link, so recursion is already linked.
 */
import {linkHelpers, LINK_FLAGS, UPROPERTY_OFFSETS as O} from './script-property-link-shared.mjs';
import {linkChildProperty} from './script-property-link-shared.mjs';

export const SCRIPT_FIXED_ARRAY_PROPERTY_LINK = Object.freeze({
  fixedArrayProperty: Object.freeze({
    kind: 'FixedArrayProperty',
    vtable: 0x10176104,
    linkThunk: 0x101026cb,
    linkBody: 0x10167c60,
  }),
});

const helpers = linkHelpers('UFixedArrayProperty', 'UNSUPPORTED_SCRIPT_FIXED_ARRAY_PROPERTY_LINK');

export const UnsupportedScriptFixedArrayPropertyLinkError = helpers.ErrorType;

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UFixedArrayProperty' ? 'FixedArrayProperty' : String(value);
}

function requireFixedArrayProperty(property, services) {
  const kind = normalizeKind(helpers.first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    helpers.Fail('UFixedArrayProperty::Link requires an explicit verified native property kind', { slot: '+0x0', field: property });
  }
  if (kind !== SCRIPT_FIXED_ARRAY_PROPERTY_LINK.fixedArrayProperty.kind) {
    helpers.Fail(`UFixedArrayProperty::Link does not implement ${kind}; use the dispatching linker`, { kind, slot: '+0x0', field: property });
  }
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'fixed-array-property-link-vtable', propertyKind: kind })
    : helpers.readSlot(property, 0x00, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    helpers.Fail('UFixedArrayProperty::link requires the native vtable for FixedArrayProperty', { kind, slot: '+0x0', field: property });
  }
  const vtable = helpers.integer(value, 'FixedArrayProperty native vtable', { maximum: 0xffffffff }) >>> 0;
  if (vtable !== SCRIPT_FIXED_ARRAY_PROPERTY_LINK.fixedArrayProperty.vtable) {
    helpers.Fail(`UFixedArrayProperty::link vtable 0x${vtable.toString(16)} does not match FixedArrayProperty 0x${SCRIPT_FIXED_ARRAY_PROPERTY_LINK.fixedArrayProperty.vtable.toString(16)}`, { kind, vtable, slot: '+0x0', field: property });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = helpers.readSlot(property, 0x18, ['outer', 'outerObject', 'owner'], services, {});
  const outer = helpers.pointer(value);
  if (outer === null) {
    helpers.Fail('FixedArrayProperty::link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

function childOf(property, services) {
  const value = helpers.readSlot(property, O.child, ['inner', 'innerProperty', 'child'], services, {});
  const inner = helpers.pointer(value);
  if (inner === null) {
    helpers.Fail('FixedArrayProperty::link requires a non-null Inner property', { slot: '+0x5c', field: property });
  }
  return inner;
}

/**
 * Replay the verified UFixedArrayProperty::Link body.
 *
 * The options form is canonical; `linkFixedArrayProperty` below is the
 * callback shape for UStruct::Link's `(property, archive, previous)` boundary.
 */
export function linkScriptFixedArrayProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UFixedArrayProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UFixedArrayProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UFixedArrayProperty::Link services must be an object');
  const services = rawServices;
  const D = SCRIPT_FIXED_ARRAY_PROPERTY_LINK.fixedArrayProperty;

  const vtable = requireFixedArrayProperty(property, services);
  const outer = outerOf(property, services);
  const inner = childOf(property, services);

  // Native order in 0x10167c60: Preload(Inner), Inner->Link(Ar, 0),
  // ElementSize = Inner.Size * Count, GetPropertiesSize, Offset, flags.
  helpers.preload(inner, archive, services);
  const innerResult = linkChildProperty(inner, archive, services);
  const innerSize = helpers.integer(helpers.readSlot(inner, O.elementSize, ['elementSize', 'element_size'], services, {}), 'Inner ElementSize');
  const arrayCount = helpers.integer(helpers.readSlot(property, O.childExt, ['arrayCount', 'count', 'arrayExtent'], services, {}), 'ArrayCount');
  const elementSize = (innerSize * arrayCount) | 0;
  helpers.writeSlot(property, O.elementSize, elementSize >>> 0, 4, services, { body: D.linkBody });

  const outerSize = helpers.readOuterPropertiesSize(outer, services);
  const offset = helpers.alignedUp(outerSize, 4);
  helpers.writeSlot(property, O.offset, offset, 4, services, { body: D.linkBody, alignment: 4 });

  const flags = helpers.integer(helpers.readSlot(property, O.propertyFlags, ['flags', 'propertyFlags'], services, {}), 'PropertyFlags', { maximum: 0xffffffff }) >>> 0;
  let resultFlags = flags;
  if ((flags & LINK_FLAGS.atomic) === 0) {
    const innerFlags = helpers.integer(helpers.readSlot(inner, O.propertyFlags, ['flags', 'propertyFlags'], services, {}), 'Inner PropertyFlags', { maximum: 0xffffffff }) >>> 0;
    resultFlags = flags | (innerFlags & LINK_FLAGS.needDestruction);
    if (resultFlags !== flags) {
      helpers.writeSlot(property, O.propertyFlags, resultFlags >>> 0, 4, services, { body: D.linkBody });
    }
  }

  return {
    property,
    archive,
    previousProperty,
    kind: D.kind,
    nativeVtable: vtable,
    linkThunk: D.linkThunk,
    linkBody: D.linkBody,
    elementSize,
    alignment: 4,
    outer,
    inner,
    innerResult: innerResultKind(innerResult),
    innerSize,
    arrayCount,
    outerPropertiesSize: outerSize,
    offset,
    flags: resultFlags >>> 0,
    operations: [
      { operation: 'preload-inner', offset: O.child, object: inner },
      { operation: 'link-inner', offset: O.child, virtualSlot: 0x68, previousProperty: null },
      { operation: 'read-inner-element-size', offset: O.elementSize, value: innerSize },
      { operation: 'read-array-count', offset: O.childExt, value: arrayCount },
      { operation: 'write-element-size', offset: O.elementSize, value: elementSize >>> 0, width: 4 },
      { operation: 'get-properties-size', virtualSlot: 0x64, value: outerSize },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      ...(resultFlags !== flags
        ? [{ operation: 'write-flags', offset: O.propertyFlags, value: resultFlags >>> 0, width: 4, propagatedFrom: 'inner' }]
        : []),
    ],
  };
}

function innerResultKind(result) {
  if (result === null || result === undefined) return null;
  return result.kind ?? result;
}

export function linkFixedArrayProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptFixedArrayProperty(property, helpers.optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptFixedArrayProperty;