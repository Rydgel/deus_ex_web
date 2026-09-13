# Native UProperty offset provenance

This is a bounded evidence note for native reflected properties in the
installed Deus Ex GOTY binaries.  The Core authority is `Core.dll` SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`; the
Extension authority used for the class case is `Extension.dll` SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.  Image
addresses below use the original preferred bases (`Core 0x10100000`,
`Extension 0x10000000`).

## Established write

The raw native `UProperty::Offset` field is at property `+0x48`.  It is
populated by the native-property constructor, not by package property
metadata.  In Core `UProperty` constructor body `0x10164fa0`:

```text
0x10164fe9  mov  ecx,[esi+0x18]       ; Outer
0x10164ff0  push esi
0x10164ff1  mov  [esi+0x48],edx       ; Offset = constructor argument
0x10164ff4  mov  eax,[ecx]
0x10164ff6  mov  [esi],0x10175a44     ; UProperty vtable
```

The body has signature `UProperty(ECppProperty, INT, TCHAR*, DWORD)` in the
export/thunk at `0x1010276b`; the stored `edx` value is the `ECppProperty`
native byte offset supplied by the caller.  The no-argument/default
constructor body `0x10164f80` only calls `UField` construction, sets
`ArrayDim=1` at `0x10164f8a`, and installs the vtable; it does not establish
`+0x48`.  Therefore a native class's generated static constructor must pass
the C++ member offset into the typed property constructor.  This is the
source of a native field's raw offset.

This path is distinct from script properties.  The recovered scalar and
complex `Link` bodies write `+0x48` from `Outer->GetPropertiesSize()` while
linking package-defined fields (see `script-complex-property-link.md` and
`script-class-link.md`).  `readPropertyMetadata()` only reads serialized
`ArrayDim`, flags, category, replication, and type references; it has no
serialized native offset and must not derive one from the Children order.

## Default application boundary

Core `UObject::InitProperties` body `0x101520d0` consumes the linked offset:

```text
0x101521b8  mov  eax,[esi+0x48]       ; linked/native property Offset
0x101521c2  mov  ecx,[esi+0x38]       ; ElementSize
0x101521c7  imul ecx,[esi+0x34]       ; ElementSize * ArrayDim
0x101521ce  mov  [ebp+0xc],ecx
0x101521f3  push ecx
0x101521f5  call dword ptr [property-vtable+0x90]
```

Before that loop, the function either copies the superclass default tail or
zeros the destination tail (`0x10152164..0x101521a7`).  It then walks the
class's linked property chain from the class `+0x68` head (`0x101521b1`),
zeroes each destination slot, and invokes that property's
`CopyCompleteValue` at `+0x90`.  Thus the native offset constructor write is
consumed only after class linking, by `InitProperties`; a typed
`ObjectProperty`/`Texture` copy callback is the mechanism that can install an
authored object reference into a native slot.

## GC / `underlineTexture` checkpoint

Extension GC registration body `0x10026730` passes total native class size
`0xb8` to the Core `UClass` constructor at `0x100590f4`, with GC's internal
constructor `0x10002ce0` and static class global `0x100a28c8`.  Existing native
layout evidence establishes `GC.underlineTexture` at `this+0x84`; the GC
constructor does not write that slot, while `CopyGC` at Core/Extension body
`0x10027760` copies source `+0x84` to destination `+0x84`.

The authored class-default tag is the GC default reference 20, resolving to
`Texture Extension.Solid` (recorded in `script-window-layout.md`).  The
remaining exact branch is the Extension generated native static constructor:
the call site that constructs GC's `ObjectProperty` for `underlineTexture`
must be recovered to show the literal `ECppProperty` argument that reaches
`0x10164ff1`, and the original tagged class-default load must be traced through
object-reference deserialization to prove when reference 20 is
written to `GC-defaults+0x84`.  Current evidence proves the destination slot
and the consumer path, but does not prove that static-constructor call site or
whether untouched class-default storage is allocator-zeroed before that tag
is copied.  Keep those two branches explicit; do not infer `+0x84` from
Children order or from serialized metadata.

## Next implementation boundary

The adapter should model two separate verified inputs: (1) native property
registration supplies `Offset` directly from the C++ offset argument to the
typed Core property constructor, and (2) tagged default loading resolves and
stores the authored object reference at the property offset. Ordinary object
references are subsequently preserved by InitProperties' raw byte copy;
its CopyCompleteValue pass is only for the constructor-linked subset and
must not be assumed to include underlineTexture. For the GC case,
the implementation remains blocked on the exact Extension registration call
and the original tagged-default load/reference-resolution trace described
above.
