# Original object memory

Step 1 of the [frame-cost direction](play-frame-cost.md): script objects
should hold their properties the way the original does, in one byte image per
object at the linked UProperty offsets. This note records the original contract
already established by recovered instructions, the storage it replaces, and
the staged plan. Stages 1a to 1d are implemented. Stage 1e is deferred: the
work stopped at basic playability ([frame cost](play-frame-cost.md#direction)).

## Original contract

These facts come from existing recovered sources, not from this note:

* **Header.** A UObject begins with a 0x28-byte native header: vtable, Index
  `+04`, HashNext `+08`, StateFrame `+0c`, `_Linker` `+10`, `_LinkerIndex` `+14`,
  Outer `+18`, ObjectFlags `+1c`, Name `+20`, Class `+24`. This is the SDK
  record layout (`node scripts/sdk-layouts.mjs --class UObject`), and it agrees
  with the offsets InitProperties preserves
  ([object properties](script-object-properties.md)). Core.Object's script
  header properties describe this region; InitProperties starts after it.
* **Property placement.** `UStruct::Link` (Core `10126060`,
  [struct link](script-struct-link.md)) starts from the aligned superclass
  PropertiesSize (`+3c`). It calls each direct property's Link and advances to
  `Offset(+48) + ElementSize(+38) × ArrayDim(+34)`, aligning the final size to
  four. Scalar sizes and the shared bool dword come from the
  [scalar](script-scalar-property-link.md), [bool](script-bool-property-link.md)
  and [complex](script-complex-property-link.md) property Link bodies: FString is
  12 bytes, object/class/name/int/float 4, byte 1. Consecutive bools share one
  dword, each with its mask at `+5c`. The class loader already exposes each
  linked slot: `classLoader.graph.slotOf(field.loadRecord, 0x48)`.
* **Defaults.** A class's default image is `Defaults.Data`/`Num` at
  `Class+4d4`/`+4d8`. `UObject::InitProperties` (Core `101520d0`) copies
  `PropertySize − 0x28` bytes of it after the header and zeroes the suffix. It
  then walks the constructor-linked property list (`Class+68`, Next `+54`) and
  calls CopyCompleteValue (`+90`) for owning properties
  ([object properties](script-object-properties.md)). The class loader holds
  each class's default image keyed by native offset (`loaded.defaults.data`).
* **Construction.** StaticConstructObject → StaticAllocateObject →
  InitProperties → the class native constructor
  ([construction](script-construction.md)). `initializeNativeObjectProperties`
  in `src/runtime/script-object-properties.mjs` is the recovered InitProperties
  body over a byte image.
* **Native members share the image.** Engine and DeusEx natives read the same
  bytes as C++ members, for example AActor's `+0x1dc` collision bool word
  ([fitting](fitting.md)), the `+0x1ec` word ([actor physics](actor-physics.md)),
  `BlendAnimSequence` `FName[4]` at `+0x68` and `Region` at `+0xc8` (SDK
  layouts). A script property's linked offset must equal the C++ member
  offset for every native class. That identity is the cross-check stage 1c
  requires.

## Current storage

Since stage 1d, a script object's own properties live in one byte image at
their linked offsets. Host state still owns some fields through bindings:

1. The object image (`script-object-image.mjs`): a little-endian `DataView` of
   the class's PropertiesSize, plus a reference array for values without a
   byte form yet. Every object of a class the native class loader linked has
   one: map actors, spawned actors, loaded objects, windows and plain objects.
2. `instance.bindings`: getter/setter pairs over host state, which take
   precedence over the image. Map actors bind only the host-owned fields
   through `makeBinding` in `script-doors.mjs` (position, Touching, regions,
   player view state, the player's Physics). A binding whose host state is absent
   falls back to the image. Extension windows bind their native members to the
   native heap (`script-window-host.mjs`). Constructed and loaded objects bind
   their UObject header fields.
3. `instance.slots`: logical values for a property with no image cell. That
   covers a class without linked offsets (the isolated decoded-metadata
   fixtures) and a property kind the image does not store, such as a dynamic
   array whose inner type the VM does not support. Training has one such
   object.
4. The native heap (`script-native-heap.mjs`): one byte-addressed space for
   Extension windows, GC and fonts, already at original offsets, with strings
   and names in a side table.
5. Host actor objects used directly by collision and physics (`position`,
   `radius`, `touching`, …). A map actor's flag words (`flags` for `+0x1dc`,
   `actorFlags` for `+0x28`, `motionFlags` for `+0x1ec`) are accessors over
   its image since stage 1e step 1 ([Rust core](rust-core.md) 1e-1). Its
   `physics`, `velocity`, `acceleration`, `standingCount`, pawn-list and
   navigation pointers and mover replication fields are accessors over their
   cells since step 2 (1e-2), and the Player's `velocity` is its identity's
   Velocity cell.

## Stages

**1a: values without references (implemented).** Host code reads and writes
values instead of allocating an lvalue per access. Details, including the
rejected per-instance reference cache, are in
[frame cost](play-frame-cost.md#stage-1a-value-access-without-references).

**1b: resolved field handles (implemented).** Each class resolves a spelled
property name once, to a handle holding the linked field and its value codec.
Host views keep their names and reach the handle through the instance's class
table, so an access does no member lookup and no descriptor validation. The
binding search stays: bindings can be replaced after attach (the player's
Login rebinding), and it costs one map lookup until 1d/1e remove the bindings
themselves. Details are in
[frame cost](play-frame-cost.md#stage-1b-resolved-field-handles).

**1c: layout tables and the native cross-check (implemented).**
`linkedClassLayout` in `script-object-layout.mjs` reads each loaded class's
table from the linker's own records:

* PropertiesSize `+0x3c`;
* per property, Offset `+0x48`, ElementSize `+0x38`, ArrayDim `+0x34`,
  PropertyFlags `+0x3c`, and the bool mask or struct at `+0x5c`;
* struct member offsets relative to the struct.

The table derives nothing itself. `scripts/validate-object-layout.mjs` checks
it for all 1,474 classes of the installed packages. `Engine.Engine` is the one
exception: it stops at an existing config boundary, ImportText for its
ClassProperty render devices. The checks:

* **Placement replay.** An independent replay of the documented Link bodies
  must give the linker's Offset, ElementSize, BitMask and PropertiesSize. It
  covers UStruct::Link and the scalar, bool, str, array, map and struct
  property bodies ([struct link](script-struct-link.md),
  [scalar](script-scalar-property-link.md), [bool](script-bool-property-link.md),
  [complex](script-complex-property-link.md)). It checks 7,801 direct
  properties of classes and structs.
* **Struct members.** The load graph's 69,182 struct member offsets equal
  the recovered struct Link over package metadata (`script-struct-layout.mjs`).
* **UObject header.** `ObjectInternal[6]` is at `+0x00`, Outer `+0x18`,
  ObjectFlags `+0x1c`, Name `+0x20` and Class `+0x24`. Core.Object's
  PropertiesSize is `0x28`.
* **Retail offsets.** 153 members have native offsets recovered from retail
  instructions, each row citing where. All sit at their linked offset, bool
  masks included. The rows cover the Actor, Pawn, PlayerPawn, LevelInfo,
  ZoneInfo, NavigationPoint, Brush and Decal members the physics, zone,
  perception, navigation and lighting bodies use; the Canvas, GC, DumpLocation
  and DeusExTextParser members; ConSys events; and DeusExPlayer's
  `conHistory +0x9fc`, `FirstLog +0xa50` and `LastLog +0xa54`, the stores of
  `ADeusExPlayer::Destroy` at `0x10014216..0x10014222`.
* **Native Extension windows.** Their C++ layout
  (`script-window-native-layout.mjs`) reproduces all 142 retail-recovered
  window offsets. Its comment cited a validator that was never in Git; this
  one asserts them now. 440 of the 446 native window members sit at their
  linked offset. The other six differ in the original too:
  * `Window.TextColor`, `CheckboxWindow.checkboxColor` and
    `ScaleWindow.scaleColor`, `thumbColor` and `tickColor`: the hand-written
    headers pack FColor at byte alignment, and the struct Link aligns it to
    four. Retail confirms the C++ side in each case: `SetTextColor 0x1004d9e0`
    stores `+0x3d`, the checkbox draw body reads `+0x20d`, and natives
    1632–1634 store `+0x17f/+0x183/+0x187`.
  * `TextLogWindow.bPaused`: the linker gives bit 1 of `+0x184`; retail
    `PauseLog 0x100478f0` writes bit 2, and the SDK header agrees with retail.

  So in the original, script and native access reach different bytes or bits
  for these six members. The window host routes script access to the retail
  C++ offsets. No function or state in Core, Engine, Extension, ConSys, DeusEx
  or DeusExText names any of the six (7,234 bytecode bodies scanned), so the
  difference is not observable from script in these packages.

The SDK 1112f headers remain a research reference. When `.cache/sdk-layouts.json`
exists, the validator compares them: 2,161 of 2,347 members agree. Retail now
decides two of the groups the exploratory comparison left open, both in favor
of the linker, so they are header drift between 1112f and the GOTY 1112fm
runtime:

* **DeusExPlayer.** 150 members from `bInHandTransition` on are 4 bytes later
  than in the SDK. Retail `FirstLog +0xa50` and `LastLog +0xa54` agree with
  the linker.
* **Texture.** 26 members from `BumpMap` on are 4 bytes earlier than in the
  SDK. Retail `LODSet +0x88` agrees with the linker.

Two groups have no retail instruction yet. `ZoneInfo.FogColor` is an FColor
at `+0x390` linked and `+0x38f` in the SDK. ScriptedTexture has three members
8 bytes apart.

The rule stands: a native class's image layout comes from retail instructions
where they exist, the linker supplies script offsets, and SDK headers stay a
research reference.

**1d: byte images for script-owned properties (implemented).** Every object of
a class the native class loader linked keeps its properties in an image at
the linked offsets (`script-object-image.mjs`):

* **Representation.** Bytes, ints, floats and packed bool dwords are stored in
  a little-endian `DataView`. f32 rounding, byte truncation and shared bool
  words follow from the storage. Vectors and rotators are three consecutive
  floats or ints. Structs and fixed arrays place their members at their
  linked offsets. FName, FString, object and class pointers and dynamic
  arrays keep their logical value in a per-object reference array; their
  bytes stay zero (see Unresolved). Since [Rust core](rust-core.md) step
  R1a-2, object and class pointers are handles in their bytes instead.
* **Construction.** Each class has a default image holding every imaged
  property's default value, the block InitProperties copies. It is rebuilt
  when a class default changes, so a new object sees the defaults at its
  construction, as the per-object default snapshot did. Attaching or
  constructing an object copies it. Construction still fails, in link order,
  on a default the loader cannot produce.
* **Map actors.** Map-authored values are written over the defaults when the
  actor attaches. Only host-owned fields keep a binding, and a binding whose
  host state is absent reads the image. The initial image is snapshotted, and
  every reset that used to clear the actor's store restores it.
* **Unproducible values.** A value that cannot be produced is recorded and
  rethrown at the same accesses as before. For a class default, that is
  reference creation, read and write. For a map-authored value, it is read and
  write but not reference creation. A map value the property cannot copy
  throws on read only, and a write replaces it.
* **Access.** A property's cell sits on its class's name handle, so
  `readNamed` makes no further lookup. VM references use a storage object with
  methods instead of per-reference closures (`storageReference`).
* **Records.** Instance records are one class. The per-record `pendingKill`
  accessor had left every actor record in dictionary mode; it is now a
  prototype getter. A record keeps a copy of its class defaults only when
  some property lacks an image cell and may reach the slot fallback. No
  Training object needs one.

Stage 1d changes representation only. `scripts/validate-object-image.mjs`
attaches one object of each of the 1,474 classes and checks:

* 345,358 defaults against the lazy default path, including 11 that throw;
* 1,519,640 probe writes against the value codec;
* 1,343,708 scalar placements at their linked offsets;
* 127,415 bool words that change only their own bit;
* the timing of unproducible-value errors.

A headless Training run reads every property of every object after startup,
after 600 ticks, and after a Player-start reset and 300 more ticks. It gives
identical results on `be02895` and with 1d, error messages included. Measurements are in
[frame cost](play-frame-cost.md#stages-1c-and-1d-layout-tables-and-object-images).

Since [Rust core](rust-core.md) step R0, the images are ranges of one
`WebAssembly.Memory` per runtime rather than per-object buffers.

What 1d does not do: the images are not addresses on the native heap. The Extension windows' native members stay in the native heap
image the window natives address. Sharing one address space is part of 1e.

**1e: host-owned fields move into the image (in progress).** Step 1, the
actor flag words, and step 2, the scalar and vector mirrors, are implemented
([Rust core](rust-core.md) 1e-1, 1e-2). Physics, collision
and presentation read the original offsets directly, and the corresponding
bindings disappear. After this step a Rust kernel can share the image as
`WebAssembly.Memory` with no marshaling. It was deferred until a measured
playability problem called for it. UNATCO Island's frame cost now does, and
the [Rust core](rust-core.md) VM needs `Location`, `Velocity` and the other
bound Actor fields in the image, or every read would cross into
JavaScript.

Each stage keeps the existing native oracle cases green, runs the full sweep
and repeats the paired A/B profile.

## Unresolved

* **Names.** The original stores an FName index into the global name table.
  The image's reference array holds spellings. Identity needs only an intern table; whether original index
  values are observable anywhere in the single-player path (ordering, hashing,
  serialization) is not established.
* **Pointers.** Object and class slots need address ↔ identity mapping. Since
  [Rust core](rust-core.md) step R1a-2, the slot's four bytes hold a host
  handle for the identity and are its only storage; the reference array has
  no pointer entries. A handle is not an address, and the native heap's
  opaque handles provide identity only. The GObjObjects index model
  ([boot replay](boot-replay.md)) is separate and must stay the source of
  object indices.
* **Owning values.** FString and dynamic arrays (`Data`/`Num`/`Max`) keep whole
  logical values in the image's reference array. Their byte form needs the recovered property
  copy/destroy dispatch and allocator services. Map properties remain
  unsupported.
* **Loading.** Map-loaded actors apply serialized tagged properties over the
  defaults; stage 1d writes the adapter's values into the image. The
  original's SerializeTaggedProperties into the object's bytes is not what
  runs. Config and localized properties write through `script-config`.
