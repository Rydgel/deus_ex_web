# UClass registration and default-object initialization

This document records the reached UClass registration path in the installed
Deus Ex GOTY `Core.dll`.  The binary is the authority; public engine source is
terminology only.

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
UClass::Register              0x10101e74 -> 0x10127800
UObject::InitClassDefaultObject 0x10101226 -> 0x10152300
UObject::InitProperties       0x1010102d -> 0x101520d0
FArray::Realloc               0x10101753 -> 0x10145440
FArray::Add                   0x10102536 -> 0x10107080
UObject::StaticConstructor     0x10101041 -> 0x1014f690
UObject::LoadConfig            0x101023dd -> 0x10150d60
UObject::LoadLocalized         0x1010306c -> 0x10151390
```

The source is `.cache/reference/Core-rng.asm`.  The complete Register body is
at `0x10127800–0x101279cb` (lines 88094–88235 in that local, ignored capture),
InitClassDefaultObject is at `0x10152300–0x1015236d`, and InitProperties is at
`0x101520d0–0x10152244`.

## Reached Register order

The module exports `registerScriptClass(record, services)` and aliases it as
`registerUClass`.  `record` is a mutable UClass record.  The superclass may be
provided as `superClass`, `superclass`, `super`, `baseClass`, or `base`; the
canonical runtime uses `superClass`.  The properties size, class flags,
ClassConfigName and static-constructor pointer can be supplied directly or in
`record.metadata`.

The callback sequence is source ordered:

1. `services.registerBase(record, detail)` (or `registerStruct`) represents the
   already traced UStruct/UField/UObject Register chain.
2. ClassConfigName is converted through `services.internName` (or
   `resolveName`) with `{ findName: 1 }`; this adapter is mandatory.  A missing config input is rejected;
   the native body does reach the FName constructor even when the value is the
   serialized `None` name.
3. The virtual `+0x64` PropertiesSize is read, Defaults FArray `+0x4d4` is
   initialized with `Num=0`, `Max=PropertiesSize`, and `Realloc(1)` is called.
4. PropertiesSize is read again and passed to `FArray::Add(size, 1)`.  The
   native growth formula is `newMax = Num + trunc(3*Num/8) + 0x20`; `CDQ`
   at `10107099` supplies zero bias for positive Num. The adapter
   retains that formula if a host reports a size larger than the initial
   capacity.
5. The size is checked against Defaults.Num, then
   `initializeClassDefaultObject` runs on `Defaults.Data`.
6. If Super exists and `Super.StaticConstructor != Class.StaticConstructor`,
   the size is checked again and the current static constructor is called with
   `Defaults.Data` as its receiver.  A distinct pointer requires an explicit
   `callStaticConstructor`/`staticConstructor` adapter (or a callable pointer).
7. `Super.ClassFlags & 0x4ec` is ORed into the current ClassFlags.  This is the
   only superclass flag propagation in this body.
8. A local FArchive-shaped frame is passed to virtual slot `+0x6c` with a second argument of
   zero.  The frame words are exported as `CLASS_REGISTER_FRAME`:

   ```text
   vtable = 0x101751f8
   +04 = 0x44, +08 = 0x44c
   +0c/+10/+14/+18 = 0
   +1c/+20/+24 = 1
   cleanupFlag = 1
   ```

   UClass's vtable resolves this slot to `10102f2c ->10127e30`,
   [`UClass::Link`](script-class-link.md). Supplying `services.classLink`
   invokes that recovered adapter with this exact archive and argument zero.
   Its UStruct and UState layers and the verified property `Link` dispatcher are
   connected; raw native pointer/layout storage remains an explicit host
   boundary. Net-field ordering uses the recovered native sort helper.
   An explicit `postRegisterVirtual`, `virtual6c`, or `initializeClassVirtual`
   override takes precedence; absence of both bindings fails explicitly.
9. PropertiesSize is checked again, then `LoadConfig(0, 0, 0)` is called on
   Defaults.Data.  The size is checked again.
10. `LoadLocalized(0, 0)` is called on Defaults.Data.

Step 9 requires `services.loadConfig`, binding the sole
[LoadConfig translation](script-config.md) through the host's graph/GConfig
storage view. Step 10 defaults to the recovered
[LoadLocalized adapter](script-object-config.md), configured through
`services.objectConfig`; an explicit `services.loadLocalized` remains supported.
The class-flag gates are actual source branches: Core.Object's `ClassFlags=0x13`
skips both before resource I/O.

`registerBase` is intentionally the boundary before step 2.  Object queueing,
registry insertion and the parameterized UClass constructor belong to the
native registration/construction adapters. Bind is not called directly by
this body; Link is reached through virtual `+0x6c` in step 8.

When `services.registration` supplies the shared native registration host,
the adapter now calls the recovered `registerScriptStruct` by default and uses
that host's FName table for config-name conversion. Explicit `registerBase` and
`internName` overrides remain available for another concrete storage adapter.
See [UField/UStruct registration](script-struct-registration.md); UField alone
does not perform UStruct's FriendlyName write.

The focused registration check passes through the actual UClass::Link adapter
and connected UState::Link path. It checks that a live global-gate getter is read
after that base call, before config/localization continue. This validates the
composition and ordering; it does not establish a complete native package or
resource loader.

## Default storage and typed initialization

`UClass::Register` stores the default object in an FArray whose fields are
`+0x4d4` (Data), `+0x4d8` (Num) and `+0x4dc` (Max).  The exported result has
the shape `{ data: Uint8Array, size, capacity, header, sourceSize,
copiedProperties }`.  A host can provide `allocateDefaults(size, 1, detail)`
to retain allocator identity and can inspect the `operations` trace returned
by Register.  The module publishes this same buffer through `record.defaultBuffer`
after Realloc with `size=0`, then after Add with the final Num, before
InitClassDefaultObject and all later callbacks.  A raw-slot class record can
therefore observe the native live `+0x4d4/+0x4d8/+0x4dc` values during its
static constructor, virtual +0x6c, config and localization calls.

InitClassDefaultObject (`0x10152300`) first zeroes exactly the 0x28-byte UObject
header.  It then writes `Class` at `+0x24`, `Index=-1` at `+0x04`, and copies
the UClass vtable to `+0x00`.  The other header words, including `+0x14`, stay
zero.  `DEFAULT_OBJECT_HEADER_LAYOUT` exports these offsets.  The logical
header returned by `initializeClassDefaultObject` is:

```text
{ vtable, index: -1, hashNext: null, class: record,
  outer: null, name: 0, flags: 0, stateFrame: null,
  linker: null, linkerIndex: 0 }
```

`services.writeDefaultHeader(data, header, detail)` (or its `writeHeader` alias)
is mandatory for every accepted path.  It is the host storage boundary that
encodes the logical identity fields into the raw CDO bytes used by later
callbacks.  The module always performs the native zeroing before that callback
and has no generic absent-writer path; it never leaves allocator bytes in the
accepted path.

InitClassDefaultObject calls InitProperties with
`(Data, PropertiesSize, Super, null, 0)`.  InitProperties copies the
superclass default tail `[0x28, Super.Defaults.Num)` when a superclass default
buffer exists, then zeroes the remaining derived tail.  It walks only the
linked property chain at `Super+0x68`, following `Property+0x54`.  For each
property whose `Property+0x48` offset is below the source size it zeroes
`ElementSize(+0x38) * ArrayDim(+0x34)` bytes and calls the property's virtual
`+0x90` CopyCompleteValue. The adapter now defaults to the recovered
[property-copy dispatcher](script-property-copy.md). Native heap pointer
resolution and FArray reallocation are supplied through `services.propertyCopy`.
A host may still override the entire copy with `services.copyCompleteValue`
(or `copyProperty`); that override's arguments are:

```text
({ property, destination, source, destinationOffset, sourceOffset,
   elementSize, arrayDim, bytes },
 { kind: 'copy-complete-value', virtualSlot: 0x90, property, classRecord })
```

This is a byte-storage boundary, so a typed property adapter can preserve
object identity or recursively initialize a struct.  It must not be replaced
by a blanket JavaScript reference assignment. Missing or unresolved offset,
ElementSize and ArrayDim bindings fail explicitly; null metadata does not mean
a zero-width property. The actual `UStruct::Link` chain can now be consumed
directly: properties retain their raw `+54` Next and `+48/+38/+34` layout
holders. The raw-chain iterator reads each `Next` after the copy callback
returns, matching `101521f7` (virtual call) followed by `10152200` (Next read);
it does not snapshot the chain before invoking copies.
Fields outside the superclass default range are skipped before reading
stride/dimension, as in the original routine. Ordinary fields that are not
on the linked chain remain in the copied raw tail or in the zeroed tail, just
as in Core.

The constructor's raw input flags are ORed with `0x12` at UClass constructor
body `0x10128630`; that operation is exposed as
`UCLASS_CONSTRUCTOR_FLAG_OR` for the separate constructor adapter.  Register's
superclass propagation uses `0x4ec`, exported as
`UCLASS_SUPERCLASS_FLAG_MASK`, and does not repeat the constructor OR.

## Scope and unsupported cases

The implementation covers the reached GOTY Core registration/default path and
does not claim compatibility with another Core binary or serialized engine
version. The raw CDO header writer, owning-value heap storage and distinct
static constructors require concrete bindings. Property Link and value-copy
bodies are translated and routed; raw native pointer/layout storage and
package/resource loading still require concrete services. The default-copy
integration check covers inherited FString allocation and template preservation;
it does not complete the loaded class/resource graph.
This routine does not supply config/localization resources or a fully loaded
package/object registry. A class whose superclass default storage is
missing is zero initialized only when no linked property call is reached; a
host that has a nonzero native Super Defaults.Num must provide that storage
instead of silently substituting a map or guessed values.

Core.Class's static registration body at `0x10128750` is a concrete reference:
its instance size is `0x4f4`, Super is Core.State, ClassConfigName is the
`System` text pointer, and its static constructor is
`0x10101041` (`UObject::StaticConstructor`, a `ret`).  It therefore exercises
the exact FArray and call-order path above while skipping the distinct-static
constructor branch when its Super uses the same pointer.

The focused native-registration integration also uses Core.Object's original
constructor inputs (`size=0x28`, raw flags `1`, self Super normalized to null).
It now traverses the real registration/default/UStruct/UState/UClass chain and
both config gates, with live FName/hash insertion, native chain heads and all
256 state-hash words. The Core package and Core.Class identity are supplied
explicitly; this case does not claim those have been loaded from a complete
native package catalog.
