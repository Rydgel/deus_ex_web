/**
 * UMapProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * Thunk 0x101021d0 -> body 0x10168ca0.  Recovered body:
 *
 *   Ar->Preload(+0x10)[Key]                    // Key at +0x5c
 *   Key->Link(+0x68)[Ar, 0]
 *   Ar->Preload(+0x10)[Value]                  // Value at +0x60
 *   Value->Link(+0x68)[Ar, 0]
 *   ElementSize[+0x38] = 0x14                  // sizeof(TMap): TArray<TMapPair> + hash ptr + hash count
 *   Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
 *   if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
 */
import {linkHelpers, LINK_FLAGS, UPROPERTY_OFFSETS as O} from './script-property-link-shared.mjs';
import {linkChildProperty} from './script-property-link-shared.mjs';

export const SCRIPT_MAP_PROPERTY_LINK = Object.freeze({
  mapProperty: Object.freeze({
    kind: 'MapProperty',
    vtable: 0x10176284,
    linkThunk: 0x101021d0,
    linkBody: 0x10168ca0,
    // sizeof(TMap) on this image: TArray of TPair (0xc) + hash pointer (4) + hash count (4).
    elementSize: 0x14,
    alignment: 4,
  }),
});

const helpers = linkHelpers('UMapProperty', 'UNSUPPORTED_SCRIPT_MAP_PROPERTY_LINK');

export const UnsupportedScriptMapPropertyLinkError = helpers.ErrorType;

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UMapProperty' ? 'MapProperty' : String(value);
}

function requireMapProperty(property, services) {
  const kind = normalizeKind(helpers.first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    helpers.Fail('UMapProperty::Link requires an explicit verified native property kind', { slot: '+0x0', field: property });
  }
  if (kind !== SCRIPT_MAP_PROPERTY_LINK.mapProperty.kind) {
    helpers.Fail(`UMapProperty::Link does not implement ${kind}; use the dispatching linker`, { kind, slot: '+0x0', field: property });
  }
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'map-property-link-vtable', propertyKind: kind })
    : helpers.readSlot(property, 0x00, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    helpers.Fail('UMapProperty::Link requires the native vtable for MapProperty', { kind, slot: '+0x0', field: property });
  }
  const vtable = helpers.integer(value, 'MapProperty native vtable', { maximum: 0xffffffff }) >>> 0;
  if (vtable !== SCRIPT_MAP_PROPERTY_LINK.mapProperty.vtable) {
    helpers.Fail(`UMapProperty::Link vtable 0x${vtable.toString(16)} does not match MapProperty 0x${SCRIPT_MAP_PROPERTY_LINK.mapProperty.vtable.toString(16)}`, { kind, vtable, slot: '+0x0', field: property });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = helpers.readSlot(property, 0x18, ['outer', 'outerObject', 'owner'], services, {});
  const outer = helpers.pointer(value);
  if (outer === null) {
    helpers.Fail('UMapProperty::Link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

function childOf(property, offset, label, services) {
  const value = helpers.readSlot(property, offset, [label, `${label}Property`, label.slice(0, 1).toLowerCase() + label.slice(1)], services, {});
  const child = helpers.pointer(value);
  if (child === null) {
    helpers.Fail(`UMapProperty::Link requires a non-null ${label} property`, { slot: `+0x${offset.toString(16)}`, field: property });
  }
  return child;
}

/**
 * Replay the verified UMapProperty::Link body.
 *
 * The options form is canonical; `linkMapProperty` below is the callback shape
 * for UStruct::Link's `(property, archive, previous)` boundary.
 */
export function linkScriptMapProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UMapProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UMapProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UMapProperty::Link services must be an object');
  const services = rawServices;
  const D = SCRIPT_MAP_PROPERTY_LINK.mapProperty;

  const vtable = requireMapProperty(property, services);
  const outer = outerOf(property, services);
  const key = childOf(property, O.child, 'Key', services);
  const value = childOf(property, O.childExt, 'Value', services);

  // Native order in 0x10168ca0: Preload(Key), Key->Link, Preload(Value),
  // Value->Link, ElementSize, GetPropertiesSize, Offset, flags.
  helpers.preload(key, archive, services);
  const keyResult = linkChildProperty(key, archive, services);
  helpers.preload(value, archive, services);
  const valueResult = linkChildProperty(value, archive, services);
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
    key,
    value,
    keyResult: childResultKind(keyResult),
    valueResult: childResultKind(valueResult),
    outerPropertiesSize: outerSize,
    offset,
    flags: resultFlags >>> 0,
    operations: [
      { operation: 'preload-key', offset: O.child, object: key },
      { operation: 'link-key', offset: O.child, virtualSlot: 0x68, previousProperty: null },
      { operation: 'preload-value', offset: O.childExt, object: value },
      { operation: 'link-value', offset: O.childExt, virtualSlot: 0x68, previousProperty: null },
      { operation: 'write-element-size', offset: O.elementSize, value: D.elementSize, width: 4 },
      { operation: 'get-properties-size', virtualSlot: 0x64, value: outerSize },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      ...(resultFlags !== flags
        ? [{ operation: 'write-flags', offset: O.propertyFlags, value: resultFlags >>> 0, width: 4 }]
        : []),
    ],
  };
}

function childResultKind(result) {
  if (result === null || result === undefined) return null;
  return result.kind ?? result;
}

export function linkMapProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptMapProperty(property, helpers.optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptMapProperty;