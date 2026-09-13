# Native reflected Window and GC layout

This is the layout contract for the installed Deus Ex GOTY Edition binaries.
It records native evidence before any allocation adapter is added.  The
authoritative binaries are `Extension.dll` (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`) and
`Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).
Addresses below use the original preferred image base `0x10000000`.

## Contract

The first `0x28` bytes are the inherited Core `UObject` prefix.  The native
registration calls pass these total class sizes to the original `UClass`
constructor:

| class | registration body | internal constructor | total native size | static class global |
| --- | ---: | ---: | ---: | ---: |
| `ExtensionObject` | `0x100378b0` | `0x10002770` | `0x28` | `0x100a7868` |
| `Window` | `0x1004ba40` | `0x10003120` | `0x14c` | `0x100ae5b8` |
| `GC` | `0x10026730` | `0x10002ce0` | `0xb8` | `0x100a28c8` |

The size immediates are at `0x100378ec` (`push 0x28`), `0x1004ba80`
(`push 0x14c`), and `0x10026770` (`push 0xb8`).  Each registration then
calls the Core `UClass` constructor through `0x100590f4`. Window and GC use
the ExtensionObject superclass at `0x100a7868`; ExtensionObject itself loads
its Core.Object base through IAT `0x10059004` (`0x100378e1..0x100378e7`).
Thus `ExtensionObject` adds
no bytes beyond the Core prefix; Window storage ends at `+0x148` and GC
storage ends at `+0xb4`, with the sizes above as exclusive bounds.

This is native storage, not the VM's keyed JavaScript value object.  A
reflected bool below is a bit in the indicated native byte/dword; it must not
be represented by assigning a VM property a native address.  Fields and
gaps for which no instruction has been recovered remain unresolved.

## Window

`XWindow::Init` at `0x1004bb30` is the primary offset evidence.  Its two GC
allocations store the first result at `+0x130` and the second at `+0x134`, then
clear the hierarchy pointers at `+0x138..+0x148`.  The recovered reflected
members and packed masks are:

| reflected member | native offset | width/mask | evidence |
| --- | ---: | --- | --- |
| `windowType` | `+0x28` | byte | Init byte store at `0x1004bb56`; original Window declaration |
| `bIsVisible` | `+0x30` | bit `0x01` | getter body `0x100031eb` |
| `bIsSensitive` | `+0x30` | bit `0x02` | getter body `0x1000324b` |
| `bIsSelectable` | `+0x30` | bit `0x04` | getter body `0x10003260` |
| `bIsInitialized` | `+0x30` | bit `0x08` | `test byte [esi+0x30],8` at `0x10050d9a` |
| `bBeingDestroyed` | `+0x30` | bit `0x10` | `test byte [edi+0x30],0x10` at `0x1005136a` |
| `lockCount` | `+0x34` | 32-bit count | Init and `LockWindow` increment |
| `bDrawRawBackground` | `+0x38` | bit `0x01` | Init mask/or sequence at `0x1004bb70` |
| `bStretchBackground` | `+0x38` | bit `0x02` | `GetBackgroundStretching` at `0x100032b0` |
| `bSmoothBackground` | `+0x38` | bit `0x04` | `GetBackgroundSmoothing` at `0x100032c0` |
| `backgroundStyle` | `+0x3c` | byte | getter body `0x10003280` |
| `normalFont` | `+0x54` | pointer | `SetFonts` store at `0x1004d7d6`; Init inheritance |
| `boldFont` | `+0x58` | pointer | `SetFonts` store at `0x1004d7db`; Init inheritance |
| `bSpecialText` | `+0x74` | bit `0x01` | getter/Init at `0x100032e0`/`0x1004bc00` |
| `bTextTranslucent` | `+0x74` | bit `0x02` | getter body `0x100032d0` |
| `gGc` | `+0x130` | pointer | `SetFonts` and `GetGC` source |
| `wGc` | `+0x134` | pointer | `GetGC` return/working GC |
| `winParent` | `+0x138` | pointer | `GetRootWindow` and AddChild |
| `firstChild` | `+0x13c` | pointer | AddChild parent endpoint |
| `lastChild` | `+0x140` | pointer | AddChild parent endpoint |
| `prevSibling` | `+0x144` | pointer | AddChild child link |
| `nextSibling` | `+0x148` | pointer | AddChild child link |

The hierarchy mapping is recovered from `XWindow::AddChild` at `0x10050a80`
and is also recorded in [script-window-hierarchy.md](script-window-hierarchy.md).
The native field order for the two GC pointers is significant: package
Children metadata lists `wGc` before `gGc`, while the native Init and accessors
prove that `+0x130` is `gGc` and `+0x134` is `wGc`.  `XWindow::GetGC` at
`0x1004ddc0` reads `+0x134`, calls `PushGC`, then reads `+0x130` and calls
`CopyGC` at `0x10027760`; this establishes the template/working direction.

Window's native constructor at `0x10003130` only adds its own vtable and
zeroes a later constructor region (`+0xd4..+0xe8`) after the Core UObject
constructor.  `Init`, rather than that constructor, establishes the fields
listed above.  The reflected members in the unlisted interval between
`+0x3c` and `+0x130`, and any unused bits in the documented packed words, are
not assigned an offset by this contract until their native access is recovered.

## GC

The `GC` registration size is `0xb8`.  The constructor body at `0x10026ad0`
writes the native members through `+0xb4`; `CopyGC` at `0x10027760` copies
the same regions and, in particular, directly copies source `+0x84` to
destination `+0x84` at `0x10027834`/`0x1002783a`.  The resulting native map is:

| reflected member | native offset | width/mask |
| --- | ---: | --- |
| `Canvas` | `+0x28` | pointer |
| `gcClipRect` | `+0x2c` | 24 bytes |
| `Style` | `+0x44` | byte |
| `bSmoothed` | `+0x48` | bit `0x01` |
| `bDrawEnabled` | `+0x48` | bit `0x02` |
| `bMasked` | `+0x48` | bit `0x04` |
| `bTranslucent` | `+0x48` | bit `0x08` |
| `bModulated` | `+0x48` | bit `0x10` |
| `bTextTranslucent` | `+0x48` | bit `0x20` |
| `PolyFlags` | `+0x4c` | 32-bit flags |
| `textPolyFlags` | `+0x50` | 32-bit flags |
| `tileColor` | `+0x54` | `Core.Object.Color`, 4 bytes |
| `tilePlane` | `+0x58` | `Core.Object.Plane`, 16 bytes |
| `TextColor` | `+0x68` | `Core.Object.Color`, 4 bytes |
| `textPlane` | `+0x6c` | `Core.Object.Plane`, 16 bytes |
| `normalFont` | `+0x7c` | pointer |
| `boldFont` | `+0x80` | pointer |
| `underlineTexture` | `+0x84` | pointer |
| `underlineHeight` | `+0x88` | 32-bit float |
| `baselineOffset` | `+0x8c` | 32-bit float |
| `textVSpacing` | `+0x90` | 32-bit float |
| `HAlign` | `+0x94` | byte |
| `VAlign` | `+0x95` | byte |
| `bWordWrap` | `+0x98` | bit `0x01` |
| `bParseMetachars` | `+0x98` | bit `0x02` |
| `hMultiplier` | `+0x9c` | 32-bit float |
| `vMultiplier` | `+0xa0` | 32-bit float |
| `bFree` | `+0xa4` | bit `0x01` |
| `gcCount` | `+0xa8` | 32-bit count |
| `gcStack` | `+0xac` | pointer |
| `gcFree` | `+0xb0` | pointer |
| `gcOwner` | `+0xb4` | pointer |

The six `+0x48` masks are independently read by the native GC predicate
bodies (`0x10002d20..0x10002db0`).  `HAlign`/`VAlign` are read at
`0x10002e00`/`0x10002e10`, and the `+0x98` masks at `0x10002e20`/`0x10002e30`.
The constructor does not write `+0x84`; its offset is nevertheless established
by the `CopyGC` source/destination pair above. The original GC class-default
tag assigns `underlineTexture` reference 20, the Texture `Extension.Solid`.
Loading that resource into the class-default native slot and the allocator's
treatment of untouched bytes remain unresolved.

## Color size and padding

The existing Core `UStruct::Link` translation (`0x10126060`), driven by the
original `Core.Object.Color` Children/Next chain and property Link bodies,
produces `PropertiesSize = 4` with these byte members:

| member | offset | element size |
| --- | ---: | ---: |
| `R` | `0` | `1` |
| `G` | `1` | `1` |
| `B` | `2` | `1` |
| `A` | `3` | `1` |

This is four sequential bytes and has no inferred padding.  The native GC
constructor and `CopyGC` also move `tileColor` and `TextColor` as one 32-bit
aggregate at `+0x54` and `+0x68`, corroborating the four-byte boundary.  A
serialized/tagged Color payload length is not used as a native-size claim;
the linked Core layout is the authority.  The logical VM value remains a
keyed Color object, separate from this native slot.

The Core prefix/link setup is the same recovered contract exercised by
`conversationPrefixLayout()` in
`scripts/native-conversation-action-bind-oracle.py`; the Color-specific
boundary is supplied by `src/runtime/script-struct-layout.mjs` and
`src/runtime/script-struct-link.mjs`.

## Remaining native dependency

These offsets and total sizes are sufficient to name the requested Window/GC
slots, but they do not by themselves prove authentic default allocation.  The
remaining dependency is the original Core `UClass` allocation/
`InitProperties` path for these native classes: it must establish whether
unwritten constructor bytes are allocator-zeroed or copied from a class
template, and must supply the unlisted Window members in the `+0x3c..+0x12f`
region.  `underlineTexture` is the concrete known case where the GC
constructor leaves its slot untouched.  No default value or zeroing policy is
invented here; until that path is recovered, an allocation adapter must keep
those branches explicit.
