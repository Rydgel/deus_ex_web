/**
 * UProperty::Link dispatcher.
 *
 * UStruct::Link calls each child property's own `Link` virtual (+0x68).  This
 * routes by the property's verified native class to the recovered body for that
 * class: the complex classes (Bool/Str/Array/FixedArray/Map/Struct) reach their
 * translated bodies, and the scalar classes (Byte/Int/Float/Name/Object/Class)
 * reach the `ret 8`-derived scalar bodies.  Unknown or missing kinds fall to
 * the scalar linker so its verified vtable/kind diagnostics are preserved
 * unchanged.
 *
 * Selection is by the property's own class, exactly as the native vtable
 * dispatch is.  The complex bodies register this module as the lazy router for
 * their own Inner/Key/Value +0x68 child links, so recursion always goes back
 * through the same verified dispatch.
 */
import { linkScriptScalarProperty, linkScalarProperty } from './script-scalar-property-link.mjs';
import { linkScriptBoolProperty, linkBoolProperty } from './script-bool-property-link.mjs';
import { linkScriptStrProperty, linkStrProperty } from './script-str-property-link.mjs';
import { linkScriptArrayProperty, linkArrayProperty } from './script-array-property-link.mjs';
import { linkScriptFixedArrayProperty, linkFixedArrayProperty } from './script-fixed-array-property-link.mjs';
import { linkScriptMapProperty, linkMapProperty } from './script-map-property-link.mjs';
import { linkScriptStructProperty, linkStructProperty } from './script-struct-property-link.mjs';
import { setPropertyLinkRouter } from './script-property-link-shared.mjs';

function kindOf(property) {
  const value = property?.nativeKind ?? property?.kind;
  switch (value) {
    case 'UBoolProperty': return 'BoolProperty';
    case 'UStrProperty': return 'StrProperty';
    case 'UArrayProperty': return 'ArrayProperty';
    case 'UFixedArrayProperty': return 'FixedArrayProperty';
    case 'UMapProperty': return 'MapProperty';
    case 'UStructProperty': return 'StructProperty';
    default: return value;
  }
}

/** Options form: `(property, {archive, previousProperty, services})`. */
export function linkScriptProperty(property, options = {}) {
  switch (kindOf(property)) {
    case 'BoolProperty': return linkScriptBoolProperty(property, options);
    case 'StrProperty': return linkScriptStrProperty(property, options);
    case 'ArrayProperty': return linkScriptArrayProperty(property, options);
    case 'FixedArrayProperty': return linkScriptFixedArrayProperty(property, options);
    case 'MapProperty': return linkScriptMapProperty(property, options);
    case 'StructProperty': return linkScriptStructProperty(property, options);
    default: return linkScriptScalarProperty(property, options);
  }
}

/** Callback shape for `linkScriptStruct(... services.linkProperty)`. */
export function linkProperty(property, archiveOrOptions, previousProperty = null, services = {}) {
  switch (kindOf(property)) {
    case 'BoolProperty': return linkBoolProperty(property, archiveOrOptions, previousProperty, services);
    case 'StrProperty': return linkStrProperty(property, archiveOrOptions, previousProperty, services);
    case 'ArrayProperty': return linkArrayProperty(property, archiveOrOptions, previousProperty, services);
    case 'FixedArrayProperty': return linkFixedArrayProperty(property, archiveOrOptions, previousProperty, services);
    case 'MapProperty': return linkMapProperty(property, archiveOrOptions, previousProperty, services);
    case 'StructProperty': return linkStructProperty(property, archiveOrOptions, previousProperty, services);
    default: return linkScalarProperty(property, archiveOrOptions, previousProperty, services);
  }
}

setPropertyLinkRouter(linkScriptProperty);

export default linkScriptProperty;