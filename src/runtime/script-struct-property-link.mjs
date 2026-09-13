/**
 * UStructProperty::Link from the installed Deus Ex GOTY Core.dll.
 *
 * Thunk 0x1010223e -> body 0x10168ff0.  Recovered body:
 *
 *   Ar->Preload(+0x10)[Struct]           // inner UStruct at +0x5c
 *   ElementSize[+0x38] = Struct->PropertiesSize[+0x3c]
 *   alignment = struct size == 2 ? 2 : (struct size < 4 ? 1 : 4)
 *   Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], alignment)
 *   if (Struct->DestroyProperty head[+0x68] != 0 && !(PropertyFlags[+0x3c] & 0x1000)) {
 *       PropertyFlags |= 0x400000
 *   }
 *
 * The alignment mapping is the disassembled setl/decl sequence: only the exact
 * sizes 0,1,3 (1), 2 (2) and >=4 (4) are representable; the Offset mask uses
 * the same `Align(x, A)` shape as the scalar bodies.  The +0x68 test inspects
 * the inner struct's destroy-property chain (the head UStruct::Link writes at
 * record +0x68), so a struct property needs destruction only when its inner
 * struct actually holds destructible fields.
 */
import {linkHelpers, LINK_FLAGS, UPROPERTY_OFFSETS as O} from './script-property-link-shared.mjs';

export const SCRIPT_STRUCT_PROPERTY_LINK = Object.freeze({
  structProperty: Object.freeze({
    kind: 'StructProperty',
    vtable: 0x10176344,
    linkThunk: 0x1010223e,
    linkBody: 0x10168ff0,
  }),
});

const helpers = linkHelpers('UStructProperty', 'UNSUPPORTED_SCRIPT_STRUCT_PROPERTY_LINK');

export const UnsupportedScriptStructPropertyLinkError = helpers.ErrorType;

function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'UStructProperty' ? 'StructProperty' : String(value);
}

function requireStructProperty(property, services) {
  const kind = normalizeKind(helpers.first(property, ['nativeKind', 'kind'], undefined));
  if (kind === undefined) {
    helpers.Fail('UStructProperty::Link requires an explicit verified native property kind', { slot: '+0x0', field: property });
  }
  if (kind !== SCRIPT_STRUCT_PROPERTY_LINK.structProperty.kind) {
    helpers.Fail(`UStructProperty::Link does not implement ${kind}; use the dispatching linker`, { kind, slot: '+0x0', field: property });
  }
  const getter = services.getNativeVTable ?? services.getPropertyVTable ?? services.getVTable;
  const value = typeof getter === 'function'
    ? getter(property, { kind: 'struct-property-link-vtable', propertyKind: kind })
    : helpers.readSlot(property, 0x00, ['nativeVtable', 'vtable'], services, {});
  if (value === undefined || value === null) {
    helpers.Fail('UStructProperty::Link requires the native vtable for StructProperty', { kind, slot: '+0x0', field: property });
  }
  const vtable = helpers.integer(value, 'StructProperty native vtable', { maximum: 0xffffffff }) >>> 0;
  if (vtable !== SCRIPT_STRUCT_PROPERTY_LINK.structProperty.vtable) {
    helpers.Fail(`UStructProperty::Link vtable 0x${vtable.toString(16)} does not match StructProperty 0x${SCRIPT_STRUCT_PROPERTY_LINK.structProperty.vtable.toString(16)}`, { kind, vtable, slot: '+0x0', field: property });
  }
  return vtable;
}

function outerOf(property, services) {
  const value = helpers.readSlot(property, 0x18, ['outer', 'outerObject', 'owner'], services, {});
  const outer = helpers.pointer(value);
  if (outer === null) {
    helpers.Fail('UStructProperty::Link requires a non-null Outer', { slot: '+0x18', field: property });
  }
  return outer;
}

function structOf(property, services) {
  const value = helpers.readSlot(property, O.child, ['struct', 'innerStruct', 'structure'], services, {});
  const structure = helpers.pointer(value);
  if (structure === null) {
    helpers.Fail('UStructProperty::Link requires a non-null inner Struct', { slot: '+0x5c', field: property });
  }
  return structure;
}

/** The recovered `cmpl/decl/and/incl` sequence: 0,1,3 -> 1; 2 -> 2; >=4 -> 4. */
function structAlignment(size) {
  if (size === 2) return 2;
  return size < 4 ? 1 : 4;
}

/**
 * Replay the verified UStructProperty::Link body.
 *
 * The options form is canonical; `linkStructPropertyValue` below is the
 * callback shape for UStruct::Link's `(property, archive, previous)` boundary.
 */
export function linkScriptStructProperty(property, {
  archive,
  previousProperty = null,
  services: rawServices = {},
} = {}) {
  if (!property || typeof property !== 'object') throw new TypeError('Expected a UStructProperty record');
  if (archive === null || archive === undefined) throw new TypeError('UStructProperty::Link requires an FArchive record');
  if (rawServices === null || typeof rawServices !== 'object') throw new TypeError('UStructProperty::Link services must be an object');
  const services = rawServices;
  const D = SCRIPT_STRUCT_PROPERTY_LINK.structProperty;

  const vtable = requireStructProperty(property, services);
  const outer = outerOf(property, services);
  const structure = structOf(property, services);

  // Native order in 0x10168ff0: Preload(Struct), ElementSize =
  // Struct->PropertiesSize, alignment, GetPropertiesSize, Offset, flags.
  helpers.preload(structure, archive, services);
  const structSize = helpers.integer(helpers.readSlot(structure, O.propertyFlags, ['propertiesSize', 'propertySize', 'structSize'], services, {}), 'Struct PropertiesSize');
  helpers.writeSlot(property, O.elementSize, structSize >>> 0, 4, services, { body: D.linkBody });
  const alignment = structAlignment(structSize);
  const outerSize = helpers.readOuterPropertiesSize(outer, services);
  const offset = helpers.alignedUp(outerSize, alignment);
  helpers.writeSlot(property, O.offset, offset, 4, services, { body: D.linkBody, alignment });

  // Struct->+0x68 is the destroy chain head that UStruct::Link maintains.
  const destroyHead = helpers.pointer(helpers.readSlot(structure, 0x68, ['destroyHead', 'destroyNeeded'], services, {}));
  const flags = helpers.integer(helpers.readSlot(property, O.propertyFlags, ['flags', 'propertyFlags'], services, {}), 'PropertyFlags', { maximum: 0xffffffff }) >>> 0;
  let resultFlags = flags;
  if (destroyHead !== null && (flags & LINK_FLAGS.atomic) === 0) {
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
    elementSize: structSize >>> 0,
    alignment,
    outer,
    structure,
    structSize,
    structAlignment: alignment,
    destroyHead: destroyHead !== null,
    outerPropertiesSize: outerSize,
    offset,
    flags: resultFlags >>> 0,
    operations: [
      { operation: 'preload-struct', offset: O.child, object: structure },
      { operation: 'read-struct-size', offset: O.propertyFlags, value: structSize },
      { operation: 'write-element-size', offset: O.elementSize, value: structSize >>> 0, width: 4 },
      { operation: 'get-properties-size', virtualSlot: 0x64, value: outerSize },
      { operation: 'write-offset', offset: O.offset, value: offset, width: 4 },
      ...(resultFlags !== flags
        ? [{ operation: 'write-flags', offset: O.propertyFlags, value: resultFlags >>> 0, width: 4, fromDestroyHead: destroyHead !== null }]
        : []),
    ],
  };
}

/** Direct callback shape for `linkScriptStruct(... services.linkProperty)`. */
export function linkStructProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  return linkScriptStructProperty(property, helpers.optionsFor(archiveOrOptions, previousProperty, services));
}

export default linkScriptStructProperty;