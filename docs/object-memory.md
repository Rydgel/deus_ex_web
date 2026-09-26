# Original object memory

Step 1 of the [frame-cost direction](play-frame-cost.md): script objects
should hold their properties the way the original does, in one byte image per
object at the linked UProperty offsets. This note records the original contract
already established by recovered instructions, the storage it would replace, and
the staged plan. Stages 1a and 1b are implemented. Everything after them is
design and stays unsupported until its own evidence and validation land.

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

The same original field can live in several places, joined by per-field
bindings. Each access translates between them:

1. `instance.slots`: a `Map` from field key to a logical JavaScript value,
   filled from the class defaults on first access.
2. `instance.bindings`: getter/setter pairs over host state. Map actors bind
   through `makeBinding` in `script-doors.mjs` (position, collision word,
   Touching, regions, player view state). Extension windows bind to the native
   heap (`script-window-host.mjs`). Loaded objects bind their immutable
   header fields.
3. A map actor's `record.store` over `initialProperty`
   (`script-map-properties.mjs`): the serialized tagged properties over its
   class defaults.
4. The native heap (`script-native-heap.mjs`): one byte-addressed space for
   Extension windows, GC and fonts, already at original offsets, with strings
   and names in a side table.
5. Host actor objects used directly by collision and physics (`position`,
   `flags` for `+0x1dc`, `motionFlags` for `+0x1ec`, …).

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

**1c: layout tables and the native cross-check.** Build each loaded class's
table of (offset, element size, dimension, kind, bool mask) from the linker's
slots. Check it against the retail-evidenced native offsets. Script-only
classes rely on the recovered UStruct::Link cases already in
[struct link](script-struct-link.md).

An exploratory comparison was run on September 26, 2026, not yet a validator.
It covered the 909 classes Training links, 81 of which have SDK records, and
compared their direct members with the SDK C++ layouts. Bools were compared as
absolute bit positions, because clang reports a byte and bit where the linker
reports a dword and mask. 2,109 of 2,292 members agree. The disagreements fall
into five groups, each needing retail evidence before any image uses it:

* `Window.TextColor`, `CheckboxWindow.checkboxColor`, `ScaleWindow.scaleColor`
  and `ZoneInfo.FogColor`: the linker aligns FColor to four bytes, while C++
  packs it at byte alignment. For the windows, retail confirms the C++
  placement (`SetTextColor 0x1004d9e0` stores `+0x3d`, not the linked `+0x40`;
  [window native layout](script-window-native-layout.md)). Script access and
  native access therefore touch different bytes. A byte image reproduces that
  quirk by construction, where logical storage has to special-case it.
* `DeusExPlayer`: every member from `bInHandTransition` on is 4 bytes later
  in the linked layout than in the SDK (150 members). The SDK headers are
  1112f and the runtime GOTY 1112fm, so this may be header drift. It is
  unconfirmed until a DeusEx.dll instruction touches one of these members.
* `Texture`: members from `BumpMap` on are 4 bytes earlier than in the SDK
  (26 members). Unconfirmed in the same way.
* `TextLogWindow.bPaused`: one bit apart. Unconfirmed.

The rule this sets: a native class's image layout comes from retail
instructions where they exist, the linker supplies script offsets, and SDK
headers stay a research reference.

**1d: byte images for script-owned properties.** Construction allocates the
object's image on the native heap and runs the recovered InitProperties over
it. `fieldReference`/`readField` for unbound fields then load from and store to
the image. f32 storage, byte truncation and bool masks follow from the
representation instead of per-access emulation.

**1e: host-owned fields move into the image.** Physics, collision and
presentation read the original offsets directly, and the corresponding
bindings disappear. After this step a Rust kernel can share the image as
`WebAssembly.Memory` with no marshaling.

Each stage keeps the existing native oracle cases green, runs the full sweep
and repeats the paired A/B profile.

## Unresolved

* **Names.** The original stores an FName index into the global name table.
  We use spellings. Identity needs only an intern table; whether original index
  values are observable anywhere in the single-player path (ordering, hashing,
  serialization) is not established.
* **Pointers.** Object and class slots need address ↔ identity mapping. The
  native heap's opaque handles provide identity only. The GObjObjects index
  model ([boot replay](boot-replay.md)) is separate and must stay the source of
  object indices.
* **Owning values.** FString and dynamic arrays (`Data`/`Num`/`Max`) currently
  keep whole logical values. Their byte form needs the recovered property
  copy/destroy dispatch and allocator services. Map properties remain
  unsupported.
* **Loading.** Map-loaded actors apply serialized tagged properties over the
  defaults. Writing those into an image needs the same ordering the current
  `script-map-properties.mjs` adapter enforces. Config and localized
  properties write through `script-config`.
