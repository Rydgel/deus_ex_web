/**
 * UArrayProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * Thunk 0x10101d07 -> body 0x101683b0.  Recovered body:
 *
 *   Ar->Preload(+0x10)[Inner]                  // Inner at +0x5c
 *   Inner->Link(+0x68)[Ar, 0]
 *   ElementSize[+0x38] = 0xc                   // sizeof(TArray): T*, INT, INT
 *   Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
 *   if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
 *
 * The child link passes a null Prev, exactly like UStruct::Link's direct
 * children; TArray's header is the element size of the array property itself.
 */
import {linkHelpers, LINK_FLAGS, UPROPERTY_OFFSETS as O} from './script-property-link-shared.mjs';
import {linkChildProperty} from './script-property-link-shared.mjs';

export const SCRIPT_ARRAY_PROPERTY_LINK = Object.freeze({
  arrayProperty: Object.freeze({
    kind: 'ArrayProperty',
    vtable: 0x101761c4,
    linkThunk: 0x10101d07,
    linkBody: 0x101683b0,
    // sizeof(TArray) on this image: Data pointer, ArrayNum, ArrayMax.
    elementSize: 0xc,
    alignment: 4,
  }),
});

const helpers = linkHelpers('UArrayProperty', 'UNSUPPORTED_SCRIPT_ARRAY_PROPERTY_LINK');

export const UnsupportedScriptArrayPropertyLinkError = helpers.ErrorType;

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UArrayProperty' ? 'ArrayProperty' : String(value);
}

function requireArrayProperty(property, services) {
  const kind = normalizeKind(helpers.first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    helpers.Fail('UArrayProperty::Link requires an explicit verified native property kind', { slot: '+0x0', field: property });
  }
  if (kind !== SCRIPT_ARRAY_PROPERTY_LINK.arrayProperty.kind) {
    helpers.Fail(`UArrayProperty::Link does not implement ${kind}; use the dispatching linker`, { kind, slot: '+0x0', field: property });
  }
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'array-property-link-vtable', propertyKind: kind })
    : helpers.readSlot(property, 0x00, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    helpers.Fail('UArrayProperty::Link requires the native vtable for ArrayProperty', { kind, slot: '+0x0', field: property });
  }
  const vtable = helpers.integer(value, 'ArrayProperty native vtable', { maximum: 0xffffffff }) >>> 0;
  if (vtable !== SCRIPT_ARRAY_PROPERTY_LINK.arrayProperty.vtable) {
    helpers.Fail(`UArrayProperty::Link vtable 0x${vtable.toString(16)} does not match ArrayProperty 0x${SCRIPT_ARRAY_PROPERTY_LINK.arrayProperty.vtable.toString(16)}`, { kind, vtable, slot: '+0x0', field: property });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = helpers.readSlot(property, 0x18, ['outer', 'outerObject', 'owner'], services, {});
  const outer = helpers.pointer(value);
  if (outer === null) {
    helpers.Fail('UArrayProperty::Link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

/** Inner record at +0x5c; the native body dereferences it unconditionally. */
function childOf(property, services) {
  const value = helpers.readSlot(property, O.child, ['inner', 'innerProperty', 'child'], services, {});
  const inner = helpers.pointer(value);
  if (inner === null) {
    helpers.Fail('UArrayProperty::Link requires a non-null Inner property', { slot: '+0x5c', field: property });
  }
  return inner;
}

/**
 * Replay the verified UArrayProperty::Link body.
 *
 * The options form is canonical; `linkArrayProperty` below is the callback
 * shape for UStruct::Link's `(property, archive, previous)` boundary.
 */
export function linkScriptArrayProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UArrayProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UArrayProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UArrayProperty::Link services must be an object');
  const services = rawServices;
  const D = SCRIPT_ARRAY_PROPERTY_LINK.arrayProperty;

  const vtable = requireArrayProperty(property, services);
  const outer = outerOf(property, services);
  const inner = childOf(property, services);

  // Native order in 0x101683b0: Preload(Inner), Inner->Link(Ar, 0),
  // ElementSize, GetPropertiesSize, Offset, flags.
  helpers.preload(inner, archive, services);
  const innerResult = linkChildProperty(inner, archive, services);
  helpers.writeSlot(property, O.elementSize, D.elementSize, 4, services, { body: D.linkBody });
  const outerSize = helpers.readOuterPropertiesSize(outer, services);
  const offset = helpers.alignedUp(outerSize, D.alignment);
  helpers.writeSlot(property, O.offset, offset, 4, services, { body: D.linkBody, alignment: D.alignment });

  const flags = helpers.integer(helpers.readSlot(property, O.propertyFlags, ['flags', 'propertyFlags'], services, {}), 'PropertyFlags', { maximum: 0xffffffff }) >>> 0;
  let resultFlags = flags;
  if ((flags & LINK_FLAGS.atomic) === 0) {
    resultFlags = flags | LINK_FLAGS.needDestruction;
    helpers.writeSlot(property, O.propertyFlags, resultFlags >>> 0, 4, services, { body: D.linkBody });
  }

  return {
    property,
    archive,
    previousProperty,
    kind: D.kind,
    nativeVtable: vtable,
    linkThunk: D.linkThunk,
    linkBody: D.linkBody,
    elementSize: D.elementSize,
    alignment: D.alignment,
    outer,
    inner,
    innerResult: innerResultKind(innerResult),
    outerPropertiesSize: outerSize,
    offset,
    flags: resultFlags >>> 0,
    operations: [
      { operation: 'preload-inner', offset: O.child, object: inner },
      { operation: 'link-inner', offset: O.child, virtualSlot: 0x68, previousProperty: null },
      { operation: 'write-element-size', offset: O.elementSize, value: D.elementSize, width: 4 },
      { operation: 'get-properties-size', virtualSlot: 0x64, value: outerSize },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      ...(resultFlags !== flags
        ? [{ operation: 'write-flags', offset: O.propertyFlags, value: resultFlags >>> 0, width: 4 }]
        : []),
    ],
  };
}

function innerResultKind(result) {
  if (result === null || result === undefined) return null;
  return result.kind ?? result;
}

export function linkArrayProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptArrayProperty(property, helpers.optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptArrayProperty;