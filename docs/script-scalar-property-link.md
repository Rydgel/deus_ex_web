# Scalar UProperty::Link

`src/runtime/script-scalar-property-link.mjs` translates the five scalar
property Link virtuals needed by the Stage 3 class linker.  The authority is
the installed Deus Ex GOTY `Core.dll`; its SHA-256 is
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.

## Original entry points

The native call is `UProperty::Link(FArchive&, UProperty*)`, reached through
virtual slot `+0x68`.  The base `UProperty::Link` thunk `0x10102a04` enters
body `0x10165640`, which is only `ret 8`; it writes no layout fields.  The
derived scalar bodies do not call that base body.  Their exported thunks,
instance vtables, bodies, and recovered layouts are:

| class | Link thunk | instance vtable | Link body | ElementSize `+0x38` | Offset alignment |
| --- | ---: | ---: | ---: | ---: | ---: |
| `UByteProperty` | `0x10102e6e` | `0x10175b04` | `0x101656f0` | `1` | 1-byte |
| `UIntProperty` | `0x10102ba3` | `0x10175bc4` | `0x10165c60` | `4` | 4-byte |
| `UFloatProperty` | `0x10102c89` | `0x10175d44` | `0x101666a0` | `4` | 4-byte |
| `UNameProperty` | `0x10102bb7` | `0x10175f84` | `0x10167250` | `4` | 4-byte |
| `UObjectProperty` | `0x10102efa` | `0x10175e04` | `0x10166a90` | `4` | 4-byte |
| `UClassProperty` | inherited | `0x10175ec4` | `0x10166a90` | `4` | 4-byte |

`UClassProperty` has no separate Link export in this image.  Its vtable uses
the `UObjectProperty` body, so the adapter accepts it only with the verified
ClassProperty vtable and reports `inheritedFrom: 'UObjectProperty'`.

## Body order and layout

Every reached body first loads `this+0x18` (`Outer`).  A null Outer would make
the native virtual call invalid, so the adapter rejects it before mutating the
property.  It then writes the fixed ElementSize to `+0x38`, dispatches
`Outer`'s virtual `GetPropertiesSize` at slot `+0x64`, and writes the returned
size to `+0x48`:

```text
ByteProperty:  ElementSize = 1; Offset = Outer.GetPropertiesSize()
other scalar: ElementSize = 4; Offset = (Outer.GetPropertiesSize() + 3) & ~3
```

The GOTY `UStruct::GetPropertiesSize` thunk `0x101026e4` enters
`0x1010f7c0`, which reads `+0x3c`.  The adapter first accepts an explicit
`services.getPropertiesSize(outer, detail)` callback, then can read a live
Outer `+0x3c` slot through `readSlot` for verified UStruct/UState/UClass vtables
`10175698`, `101757d8`, and `101758f4`. Each vtable's `+0x64` points to that
same thunk/body in the original PE. Other virtual overrides need a service;
no synthetic size is supplied. The
callback runs after the ElementSize write, matching the instruction order.

The `FArchive&` and `PreviousProperty*` arguments are present in the native
signature (the thunks return with `ret 8`) but are not read by any of these
five bodies.  The adapter preserves both in its result and in the size-call
detail.  `ArrayDim` (`+0x34`) and `PropertyFlags` (`+0x3c`) are also untouched;
`UStruct::Link` owns those fields and later computes
`PropertiesSize = Offset + ElementSize * ArrayDim`.  Mode-zero
`UStruct::Link` saves and restores the property Offset around this call, and
this adapter does not override that behavior.

## API and storage

The canonical call is:

```js
linkScriptScalarProperty(property, {
  archive,
  previousProperty,
  services: {
    getPropertiesSize(outer, detail) { return /* live native size */; },
    readSlot, writeSlot,
  },
});
```

`linkScalarProperty(property, archive, previousProperty, services)` is the
callback-shaped form for `linkScriptStruct(... services.linkProperty)`.  Both
forms require an explicit exact `kind` (`ByteProperty`, `IntProperty`,
`FloatProperty`, `NameProperty`, `ObjectProperty`, or `ClassProperty`) and its
matching native vtable at `+0x0`, `nativeVtable`, or `vtable`.  A kind alone,
an unverified vtable, and all other property classes fail explicitly.
The C++ spelling `UObjectProperty` is accepted as an alias for `ObjectProperty`.
`linkScriptStruct` uses this dispatcher when no explicit property Link callback
is supplied, with its live slot services or `services.scalarPropertyLink`.
The focused composition check rebuilds a byte array, aligned int array, and
object-reference layout through both actual linkers.

Layout writes use the same live `nativeSlots` Map / `readSlot` /
`writeSlot` boundary as `src/runtime/script-struct-link.mjs`.  Raw slots are
`+0x38` and `+0x48`, four bytes each.  Missing Outer, size, kind, vtable, or
writable layout storage is an unsupported native boundary; Bool, Struct,
Array, FixedArray, Map, String, and other property Link bodies remain outside
this module.
