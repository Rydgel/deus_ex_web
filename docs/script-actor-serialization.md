# Native `AActor::Serialize` contract

This contract is from the hash-verified GOTY `Engine.dll` and `Core.dll` in
`.cache/reference/Engine.asm` and `.cache/reference/Core-rng.asm`.  It covers
the GC/archive call made by the concrete `Engine.CameraPoint` native class.
Save, network, and untraced native-subclass serializers remain outside this
boundary.

The analyzed files are `Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`) and
`Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).

## Vtable and import evidence

The CameraPoint class vtable is `0x10427178`.  Its `+0x28` virtual slot
contains the Engine thunk `0x1030166d`, which jumps to body `0x10369ad0`.
The same thunk is selected by the recovered AKeypoint table `0x10427020` and
AActor table `0x104268dc`; this is the known common AActor implementation, not
a general rule for every native subclass.

The body at `0x10369ad0` has one observable operation:

```text
UObject::Serialize(this, archive);  // Engine IAT 0x10599b10
return;
```

The Engine import at `0x10599b10` resolves to Core's
`?Serialize@UObject@@UAEXAAVFArchive@@@Z` thunk `0x1010178f`, whose body is
`0x10150210`.  The Engine body leaves `ECX=this`, pushes the incoming archive,
performs that virtual base call, and returns with `ret 4`.  There is no
CameraPoint member callback, field walk, flag mutation, or second archive call
in this body.

`src/runtime/script-actor-serialization.mjs` reproduces this exact boundary:
it requires `services.serializeUObject(object, archive)`, returns that call's
value, and does not provide a no-op fallback.  The CameraPoint entry checks
`object.nativeVtable === 0x10427178`; the generic AActor entry accepts only the
three vtables above.  A different native table is an explicit unsupported
class rather than an inferred AActor serializer.

## Collector archive state and delegated Core branches

Core's collector archive is constructed by `0x1015eac0` with vtable
`0x1017a2f0`.  In the GC invocation used for a CameraPoint object, the raw
archive words are:

```text
FArchive +0x0c = 0     FArchive +0x10 = 0     FArchive +0x14 = 0
FArchive +0x18 = 0     FArchive +0x1c = 1     FArchive +0x20 = 1
FArchive +0x24 = 1
```

The wrapper passes this archive through untouched.  The base callback owns
every branch reached from Core body `0x10150210`:

1. Core ORs object flags bit `0x40000000` (the route marker) and, because the
   CameraPoint class is `0x10579240` rather than the special sentinel
   `0x101f1c18`, calls archive vtable `+0x10` (`Preload`) for the class.
   The collector's `Preload` body `0x101068e0` is a `ret 4` operation.
2. With `+0x0c/+0x10/+0x14` all zero, Core archives the object `Name` through
   archive `+0x1c`, then `Outer` and `Class` through archive `+0x18`, and then
   `Linker` through archive `+0x18`.  The order is Name, Outer, Class, Linker.
3. `+0x14 == 0` and CameraPoint after `InitExecution` has object-flags bit
   `0x02000000`, so Core follows its state-frame branch.  A missing frame is
   allocated as a 0x28-byte `FStateFrame`; an existing frame is reused.  Core
   then archives frame `+0x04` (Node) and `+0x18` (StateNode), serializes the
   probe-mask words at `+0x1c`/`+0x20` as eight raw bytes, and serializes the
   latent/action word at `+0x24` as four raw bytes.  It preloads the frame
   Node/class code and resolves the compact code offset according to the base
   frame implementation.
4. Core then executes the linked `SerializeBin` property chain for the class
   and its supers.  That path owns all reflected Actor and CameraPoint fields,
   including native properties whose linked metadata marks them for archive;
   AActor's Engine body adds no member-specific work.

These branches are intentionally not replayed by the wrapper.  The Core base
serializer and the archive's mutable reference services are the required
implementation boundary.  In particular, the wrapper must not clear the
route marker, manufacture a state frame, or call an optional native-member
hook before or after `serializeUObject`.

## Host API and limits

```js
serializeCameraPointActor(object, archive, {
  serializeUObject(object, archive),
});
```

The `object` must expose the verified `nativeVtable` value and the `archive`
must be the caller-owned FArchive adapter.  The callback is mandatory because
the original body always calls the Core base routine.  Its return value is
returned unchanged; native Core uses a void result, while a host implementation
may return a bookkeeping record.

The wrapper does not assert or rewrite the raw archive words, because the
collector constructor owns them and the same base routine also serves other
archive modes.  It records the observed GC state as
`CAMERA_POINT_GC_ARCHIVE_STATE` for adapters that need to identify that mode.
Typed object/name reference holders, state-frame allocation, linked property
metadata, and final destruction remain services of their respective Core
boundaries.  No guessed native-member branch is supported.
