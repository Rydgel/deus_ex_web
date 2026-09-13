/**
 * UStrProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * Thunk 0x101011c2 -> body 0x10167640.  Recovered body:
 *
 *   ElementSize[+0x38] = 0xc                        // sizeof(FString): TCHAR*, INT, INT
 *   Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
 *   if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
 *
 * The 0x400000 flag is the same bit UStruct::Link uses to build its destroy
 * property chain: a string always needs its FString destructor, unless the
 * property is explicitly atomic (bit 0x1000).  Unlike the array bodies this
 * body has no child property; it only touches the property's own record.
 */
import {linkHelpers, LINK_FLAGS, UPROPERTY_OFFSETS as O} from './script-property-link-shared.mjs';

export const SCRIPT_STR_PROPERTY_LINK = Object.freeze({
  strProperty: Object.freeze({
    kind: 'StrProperty',
    vtable: 0x10176044,
    linkThunk: 0x101011c2,
    linkBody: 0x10167640,
    elementSize: 0xc,
    alignment: 4,
  }),
});

const helpers = linkHelpers('UStrProperty', 'UNSUPPORTED_SCRIPT_STR_PROPERTY_LINK');

export const UnsupportedScriptStrPropertyLinkError = helpers.ErrorType;

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UStrProperty' ? 'StrProperty' : String(value);
}

function requireStrProperty(property, services) {
  const kind = normalizeKind(helpers.first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    helpers.Fail('UStrProperty::Link requires an explicit verified native property kind', { slot: '+0x0', field: property });
  }
  if (kind !== SCRIPT_STR_PROPERTY_LINK.strProperty.kind) {
    helpers.Fail(`UStrProperty::Link does not implement ${kind}; use the dispatching linker`, { kind, slot: '+0x0', field: property });
  }
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'str-property-link-vtable', propertyKind: kind })
    : helpers.readSlot(property, 0x00, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    helpers.Fail('UStrProperty::Link requires the native vtable for StrProperty', { kind, slot: '+0x0', field: property });
  }
  const vtable = helpers.integer(value, 'StrProperty native vtable', { maximum: 0xffffffff }) >>> 0;
  if (vtable !== SCRIPT_STR_PROPERTY_LINK.strProperty.vtable) {
    helpers.Fail(`UStrProperty::Link vtable 0x${vtable.toString(16)} does not match StrProperty 0x${SCRIPT_STR_PROPERTY_LINK.strProperty.vtable.toString(16)}`, { kind, vtable, slot: '+0x0', field: property });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = helpers.readSlot(property, 0x18, ['outer', 'outerObject', 'owner'], services, {});
  const outer = helpers.pointer(value);
  if (outer === null) {
    helpers.Fail('UStrProperty::Link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

/**
 * Replay the verified UStrProperty::Link body.
 *
 * The options form is canonical; `linkStrProperty` below is the callback shape
 * for UStruct::Link's `(property, archive, previous)` service boundary.
 */
export function linkScriptStrProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UStrProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UStrProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UStrProperty::Link services must be an object');
  const services = rawServices;
  const D = SCRIPT_STR_PROPERTY_LINK.strProperty;

  const vtable = requireStrProperty(property, services);
  const outer = outerOf(property, services);

  // Native order in 0x10167640: ElementSize, GetPropertiesSize, Offset, flags.
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
    outerPropertiesSize: outerSize,
    offset,
    flags: resultFlags >>> 0,
    operations: [
      { operation: 'write-element-size', offset: O.elementSize, value: D.elementSize, width: 4 },
      { operation: 'get-properties-size', virtualSlot: 0x64, value: outerSize },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      ...(resultFlags !== flags
        ? [{ operation: 'write-flags', offset: O.propertyFlags, value: resultFlags >>> 0, width: 4 }]
        : []),
    ],
  };
}

/** Direct callback shape for `linkScriptStruct(... services.linkProperty)`. */
export function linkStrProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptStrProperty(property, helpers.optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptStrProperty;