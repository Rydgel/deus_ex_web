# `USound` serialization and lifetime

This note records the native ownership boundary for `USound` in the installed
Deus Ex GOTY build. The authority is the hash-verified Engine.dll
(`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`) and
Core.dll (`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`),
with instructions in `.cache/reference/Engine.asm` and
`.cache/research/Core.asm`. This is a service-driven Stage 3 translation of
the reached native calls. It does not claim an audio device, a concrete linker
lazy-loader implementation, or a browser allocator equivalent. The
`AttachLazyLoader`/`DetachLazyLoader` archive edges are still represented as
explicit services.

## Native `USound::Serialize`

The exported thunk is Engine `0x103029fa`, which jumps to body `0x1036f900`.
The body executes this order:

1. Read Engine IAT slot `0x10599cc0`, which points to Core's `GLazyLoad` DWORD;
   save that pointed-to value and write `1` through the pointer.
2. Call Core `UObject::Serialize` through Engine IAT `0x10599b10`, passing the
   same `FArchive`.
3. Pass `USound+0x44` to archive vtable slot `+0x1c`, Core's
   `operator<<(FArchive&,FName&)`.
4. Read archive word `+0x0c`. Only when it is zero, read archive word `+0x10`.
   If the first is nonzero, or if the first is zero and the second is nonzero,
   call Engine helper thunk `0x103039ef` (body `0x10371140`) with the archive
   and `USound+0x28`. This short-circuit is observable for archive adapters.
5. When both words are zero, pass `USound+0x48` as both `Count` and `Max` to
   archive slot `+0x14`, Core `FArchive::CountBytes`.
6. On the normal return epilogue, restore the saved `0x10599cc0` value.

The body has compiler exception-cleanup code beginning at `0x1036f9ba` for
temporary archive/name state. That landing path does not contain a second
visible write through the `0x10599cc0` IAT; an exception-unwind restoration is
therefore not established by the recovered instructions. The adapter restores
`GLazyLoad` only after normal completion and leaves the value written by the
native prologue in place when a bound callback raises.

The native method itself does not call archive slot `+0x18`
(`operator<<(UObject*&)`). `UObject::Serialize` remains an explicit service
because its behavior depends on the archive mode and owns any object/name
collector work it reaches.

The Engine helper has two gates and a version split at `0x3d` (61). In the
`archive+0x0c != 0` branch:

* Version `<= 0x3d`: call `AttachLazyLoader(+0x38)` with `FSoundData`, read a
  compact offset through Core's compact-index archive operation, call
  `Tell(+0x28)`, add the two values, then call `Seek(+0x34)` with the sum.
* Version `> 0x3d`: transfer a four-byte offset through `Serialize(+0x04)`,
  call `AttachLazyLoader(+0x38)`, then call `Seek(+0x34)` with that offset.
* After either header form, the helper reads Core `GLazyLoad` through Engine
  IAT `0x10599cc0`. If it is zero it calls the `FSoundData` vtable slot zero
  (`Load`); when called from `USound::Serialize` this flag is one and the
  native call is skipped.

In the `archive+0x0c == 0 && archive+0x10 != 0` branch:

* Version `> 0x3d`: call `Tell`, transfer a four-byte first offset through
  `Serialize(+0x04)`, call the generic array helper `0x103038b9` (body
  `0x1030cca0`), call `Tell` again, seek the first tell value, transfer a
  four-byte second offset through `Serialize(+0x04)`, then seek the second
  offset. The first local is initialized from the first `Tell`, and the second
  local from the second `Tell`; whether each transfer writes or reads is an
  archive-direction concern owned by the bound `Serialize` service. The
  adapter returns both resulting local values.
* Version `<= 0x3d`: call the same generic array helper once.

The generic helper receives the embedded `TArray` at `FSoundData+0x0c`. It
calls `CountBytes(ArrayNum,ArrayMax)`, serializes `ArrayNum` as a compact
index, and, when archive `+0x0c` is nonzero, assigns `ArrayMax=ArrayNum` and
calls Core `FArray::Realloc` with element size one. It then raw-serializes
`ArrayNum` bytes from `Array.Data`. The `FSoundData::Load` body (Engine
`0x1036f040`) conditionally copies `FSoundData+0x10` (`ArrayNum`) to its
owner `USound+0x48` at `0x1036f4db`, only when the initial signed lazy-position
field+08 is positive. That body owns the copy. The enclosing serialization
helper calls the virtual Load and then Seek directly; it must not add an
unconditional byte-count copy after the callback. Every archive virtual or array operation above is
an explicit callback in the adapter; an absent callback raises an
unsupported-lifecycle error at the reached operation.

The relevant archive slots are:

| Slot | Native operation |
| --- | --- |
| `+0x04` | raw `Serialize(void*,INT)` |
| `+0x14` | `CountBytes(DWORD,DWORD)` |
| `+0x18` | `operator<<(UObject*&)` (not directly called by `USound::Serialize`) |
| `+0x1c` | `operator<<(FName&)` |
| `+0x28` | `Tell()` |
| `+0x34` | `Seek(INT)` |
| `+0x38` | `AttachLazyLoader(FLazyLoader*)` |
| `+0x3c` | `DetachLazyLoader(FLazyLoader*)` (used by `FSoundData::~FSoundData`) |

The object fields used by the path are `+0x28` (`FSoundData`), `+0x2c`
(`FSoundData+0x04`, the retained archive pointer used for lazy-loader detach),
`+0x34/+0x38/+0x3c` (array data/count/capacity), `+0x40` (owner), `+0x44`
(format FName), and `+0x48` (serialized byte count). The Engine constructor
`0x1034cb10` initializes `FSoundData+0x04` and `+0x08` to zero. The helper
passes that `FSoundData` to archive `AttachLazyLoader(+0x38)`; the concrete
linker override that may populate the archive pointer is not recovered here.

The archive vtable used by the existing measuring adapter (`0x10177640`) has
`+0x38 = 0x10101325`, Core `FArchive::AttachLazyLoader` (body `0x10106a40`);
its `+0x3c = 0x101022d4`, Core `FArchive::DetachLazyLoader` (body
`0x10106a60`). The exported base `FArchive` vtable at `0x101751f8` carries the
same two entries. This matches the `FSoundData::~FSoundData` indirect call at
Engine `0x1030ca8c–0x1030ca8f`: it reads `FSoundData+0x04`, loads that object's
vtable, and calls `+0x3c` with the `FSoundData` pointer. The lifecycle adapter
therefore names this edge `detachLazyLoader`; it does not treat it as an
audio-device release.

## Native destruction

The complete `USound` destructor is Engine body `0x1031cb60` (thunk
`0x10303a5d`). Its native order is:

1. Write the `USound` vtable `0x10429580`.
2. Call Core `UObject::ConditionalDestroy` through Engine IAT `0x10599b08`
   with argument `1`.
3. Call the `FSoundData` destructor body `0x1030ca50` at `USound+0x28`.
4. Call Core `UObject::~UObject` through Engine IAT `0x10599b04` with
   argument `-1`.

`FSoundData::~FSoundData` first writes base vtable `0x104267fc`. If
`FSoundData+0x04` is non-null, it treats that field as an `FArchive*` and
calls its virtual `DetachLazyLoader(+0x3c)` with the FSoundData pointer. It
then operates on the embedded array at `+0x0c`:

1. Read the current `ArrayNum` and call Core `FArray::Remove(0,ArrayNum,1)`
   through Engine IAT `0x10599a18`.
2. Read `Array.Data`. If non-null, call Core's `GMalloc` object through Engine
   IAT `0x10599a94`, virtual slot `+0x08`, with that data pointer.
3. Write `Array.Data=0`, `Array.Max=0`, and `Array.Num=0`, in that order.

The body does not call `FArray::~FArray`; its reached operation is the
`Remove` call followed by the explicit `GMalloc` free and three stores. The
adapter calls an explicit `allocatorFree` service carrying the observed IAT
and slot. A host must not replace this with JavaScript garbage collection.

The deleting wrapper is Engine body `0x1031cc00` and receives the C++ flags
byte. Its branches are also part of the contract:

* If bit `0x2` is clear, call the complete destructor above. If bit `0x1` is
  set, call Core `??3UObject` through Engine IAT `0x10599ab4` with the Sound
  pointer and size `0x54`.
* If bit `0x2` is set, skip the complete destructor and call Engine array
  destruction helper `0x104134d6`. The wrapper reads the DWORD at `this-4` as
  the array element count, passes `(Sound, 0x54, count, 0x10303a5d)` to that
  helper, and treats `this-4` itself as the allocation-cookie pointer. If bit
  `0x1` is also set, call the same allocator object's `+0x08` on that cookie
  pointer.

The helper body `0x104134d6` multiplies its element size by the count, then
invokes the supplied destructor once per record while walking the array
backwards. The lifecycle API therefore requires explicit `allocationHeader`
(the cookie pointer) and `allocationCount` (the DWORD stored at `this-4`), and
passes the recovered `(Sound,size,count,destructorThunk)` order to
`arrayDestructor`. It reports the branch and does not pretend that a scalar
destructor ran. Missing callbacks or either cookie value fail rather than
silently omitting reached native work.

## Adapter boundary

`src/runtime/script-sound-lifecycle.mjs` exports:

* `serializeSoundLifecycle(sound, archive, services)` for the exact serializer
  order and branch gates;
* `serializeSoundHelperLifecycle(sound, archive, services)` for a direct
  `0x10371140` call, including the zero-serialization-flag Load branch that
  `USound::Serialize` itself suppresses;
* `destroySoundLifecycle(sound, services)` for the complete destructor; and
* `deleteSoundLifecycle(sound, flags, services)` for the deleting-wrapper flag
  branches.

Callbacks are intentionally small and service driven. Required callbacks are
`uobjectSerialize`, `serializeName`, `serializeRaw`, `serializeCompact`,
`countBytes`, `tell`, `seek`, `attachLazyLoader`, `arrayRealloc`,
`conditionalDestroy`, `detachLazyLoader`, `arrayRemove`,
`allocatorFree`, and `baseDestructor` when the corresponding native edge is
reached. `loadSoundData` is required only when the serialization flag is zero;
`arrayDestructor` is required only for deleting-wrapper bit `0x2`. The
serializer restores `GLazyLoad` after normal completion. Native exception
restoration remains unverified because the recovered cleanup path does not
visibly write through the Engine IAT.

The focused test and validator bind every reached callback to an event recorder,
then verify the recovered order, archive offset mutations, Sound vtable writes,
array-word clearing, and explicit unsupported branches. These are contract
checks against disassembly and do not execute the original native audio
service. Playback, `LoadSpecial`, and the concrete linker override that
records lazy loaders remain incomplete boundaries; no external audio service
is inferred from the destructor call.
