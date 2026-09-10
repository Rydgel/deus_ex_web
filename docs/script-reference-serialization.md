# UObject reference serialization

This module records the reference walk recovered from the installed GOTY
`System/Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and
implements the typed part needed by the script collector.  The archive owns
marking, recursion and object lifetime.  The module supplies the original
mutable reference lvalues in order and does not replace the archive's policy.

## UObject header and state frame

`UObject::Serialize` is exported at `0x1010178f` and enters `0x10150210`.
The object base layout used by that routine is `StateFrame +0x0c`, `Linker
+0x10`, `Outer +0x18`, `ObjectFlags +0x1c`, `Name +0x20`, and `Class +0x24`.
The routine sets raw `ObjectFlags` bit `0x40000000` before it walks the
object.  `serializeObjectHeaderReferences` is the object-only helper and does
not set that route marker; the complete collector path in
`script-object-serialization.mjs` performs the write.  The collector archive
clears the marker before dispatch and checks that the virtual Serialize path
leaves it set afterward.

The three raw archive words read by the routine are at `FArchive +0x0c`,
`+0x10`, and `+0x14`.  Calling them `ar0c`, `ar10`, and `ar14` keeps the
implementation independent of a guessed SDK name.  The exact branches at
`0x1015025c–0x101502a1` are:

* `Name`, `Outer`, and `Class` are archived when
  `(ar0c == 0 && ar10 == 0) || ar14 != 0`.
* `Linker` is archived when `ar0c == 0 && ar10 == 0`.
* The state-frame path is entered only when `ar14 == 0` and
  `ObjectFlags & 0x02000000` is nonzero.

The name is a value, so it is not sent to the object-reference callback.  If
the archive supplies optional `nameReference(reference, context)`, the helper
visits the Name lvalue first.  That callback is optional only for this
object-only helper; the complete GC serializer requires it because the
collector's vtable `+0x1c` marks the referenced FName entry.
The other three header values are mutable object-reference slots.  The helper
calls `archive.objectReference(reference, context)` (or the GC archive's
`serializeObject(reference)`) for each slot even when
the slot is null, matching the unconditional `FArchive::operator<<(UObject*&)`
call in the native routine.

On the state-frame path, a missing frame is an explicit error unless the
caller supplies `createStateFrame`.  The original allocator writes the frame
vtable, owning class, object, `-1` label/code defaults and zero words before
serialization; the host must provide that allocation boundary when it needs
to reproduce it.  Once a frame exists, the object reference calls are:

1. `FStateFrame +0x04` (`Node`)
2. `FStateFrame +0x18` (`State`, which is the current state/function object)

The probe mask (`+0x1c`), latent/action word (`+0x24`), compact code offset
(`+0x0c`) and raw frame words are not object references.  The native routine
preloads the node and resolves that compact code offset after the two object
calls; those operations remain with the state-frame/runtime boundary.

`serializeObjectHeaderReferences(object, archive, options)` accepts an object
record with `outer`, `classRecord` (or `classRef`/`class`), `linker`,
`objectFlags`, and `stateFrame.{node,state}`.  A `reference(descriptor)`
callback may provide the host's native lvalues instead.  `options.archiveState`
supplies the raw `ar0c/ar10/ar14/ar18` words.  With no archive state, all four
words default to the collector constructor's observed zero state.  The result
reports `{references, identity, linker, stateFrame}`.

The collector archive is the vtable at `0x1017a2f0`.  Its UObject reference
operator is `0x1015ec90` (vtable `+0x18`).  For a non-null slot it first
rejects raw object flag bit `0x00000400` and writes that rejected slot to
null.  It then tests raw object flag bit `0x00000002`; an already-clear bit
returns without changing the slot.  Otherwise it clears `0x00000002` and
`0x40000000` (`flags &= 0xbffffffd`), then, when the resulting flags retain
`0x00000040`, calls the referent's virtual `Serialize` slot `+0x28` with the
collector as the archive.  During that call archive slot `+0x2c` is the
current object and is restored afterward.  A null slot is left null.  The
collector constructor `0x1015eac0` seeds valid objects with raw `0x42` bits;
the driver owns that seed and the global recursion counter.  These rules are
documented here so `script-gc.mjs` can implement the mutable archive callback
without adding another reference policy.

## Typed property walk

`UStruct::SerializeBin` is exported at `0x1010285b` and enters `0x10126610`.
It constructs the native field iterator at `0x10102f9a`, whose sequence is
the current struct/class children followed by each super's children.  This is
the linked `propertyLink`/`TFieldIterator` order supplied to
`serializeScriptReferences(fields, reference, archive, options)`.
The archive may expose the generic `objectReference(reference, context)`
name or the GC driver's `serializeObject(reference)` name; both receive the
same mutable lvalue.

For every field, the native code tests the raw flags at property `+0x3c`:

* bit `0x00001000` skips the property unconditionally;
* bit `0x00002000` skips only when `FArchive +0x18` is nonzero;
* otherwise every `ArrayDim` element is visited in ascending order, at
  `data + property +0x48 + index * property +0x38`, through the property
  vtable's `+0x78` `SerializeItem` slot.

The helper preserves those raw tests.  `options.persistent` (or
`archive.persistent`, `archive.isPersistent`, `archive.ar18`) supplies the
`+0x18` value; it defaults to false, as in the collector constructor.  It
does not invent an omit list.  The return value is
`{references, fields, skipped}`; `references` counts archive callback calls,
including null values.

`UNameProperty::SerializeItem` (`0x10101217` → `0x10167360`) dispatches the
value through archive vtable `+0x1c`; `serializeScriptReferences` exposes that
as the optional `archive.nameReference` callback (or the GC driver's
`serializeName(reference)` alias).
`UObjectProperty::SerializeItem` (`0x10102103` → `0x10166bb0`) simply passes
the element pointer to archive vtable `+0x18`.  `ClassProperty` uses this same
instance path.  Its metadata serializer, `UClassProperty::Serialize`
(`0x101017ee` → `0x10167050`), first calls `UObjectProperty::Serialize` and
then archives the property descriptor's `MetaClass` at `this +0x64`; that
descriptor reference is not an additional per-instance field in
`SerializeBin`.

`UStructProperty::SerializeItem` (`0x10103058` → `0x101691b0`) preloads its
linked struct through archive vtable `+0x10`, then calls that struct's
`SerializeBin` vtable `+0x70` on the element.  The helper calls optional
`archive.preloadStruct(metadata, context)` before recursively walking linked
`metadata.structFields`.  Native Vector and Rotator identities are POD and
produce no object callbacks.  Other structs require complete linked member
metadata; a missing member list is an explicit unsupported error.

Nested struct members run through the same two raw flag tests before their
recursive `SerializeBin` walk.  A fixed-array inner property follows the
native `UFixedArrayProperty::SerializeItem` loop directly; its element
serializer is not a second `SerializeBin` pass.

`UFixedArrayProperty::SerializeItem` (`0x1010148d` → `0x10167da0`) is the
established fixed-array branch: it loops its serialized count at `+0x60` and
dispatches the linked inner property's `+0x78` serializer at the inner stride
(`+0x38`).  The helper supports this when `innerMetadata` and
`fixedArraySize` are linked.  Dynamic `ArrayProperty` and `MapProperty`
serialization changes allocation/count state in their native serializers
(`0x10168520` and `0x10168d90`); they remain explicit unsupported branches
unless the caller supplies `archive.serializeProperty(field, reference,
context)`.

`UStruct::Link` separately builds object and struct cleanup chains at `+0x58`
and `+0x5c`, following property `+0x60`.  Those RefLink chains are used by
`CleanupDestroyed`; they are not the order used by `SerializeBin`, so this
module never rebuilds or substitutes them.  The object-property ancestry
filter at `0x1012b260` recognizes `UObjectProperty` at `0x102a61f0`, and the
struct-property filter at `0x1012b2e0` recognizes `UStructProperty` at
`0x102a3ef0`.  `ClassProperty` is included through the former ancestry.

## Focused real-data boundary

Using the installed Engine package and linked `engine.camerapoint`, the
runtime exposes 241 linked properties.  Selecting its 45 object/class/struct
fields and passing zeroed typed storage to this helper produced:

```text
property fields considered: 45
fields visited:             43
raw fields skipped:          2
object-reference callbacks: 38
first callbacks:             engine.camerapoint.nextpoint,
                             engine.camerapoint.prevpoint,
                             engine.camerapoint.player,
                             engine.camerapoint.continuepoint,
                             engine.actor.owner,
                             engine.actor.level,
                             engine.actor.xlevel
first struct preload:       engine.actor.pointregion
```

`Actor.Region` resolves to `Engine.Actor.PointRegion` and its linked members
are `Zone` (`ObjectProperty`), `iLeaf` (`IntProperty`) and `ZoneNumber`
(`ByteProperty`); the zeroed region therefore emitted one nested object
callback for `Zone`.  The focused test uses the same member shape and also
covers a two-element `ArrayDim`, a `UFixedArrayProperty` inner object, the two
raw flag filters, and explicit dynamic-array failure.
