# Tagged-property measuring archive

This contract covers the temporary `FArchive` that Core creates while
measuring one `UProperty::SerializeItem` call in the collector branch of
`UStruct::SerializeTaggedProperties`.  The authority is the hash-verified GOTY
`Core.dll` (`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`),
with disassembly in `.cache/research/Core.asm` and
`.cache/reference/Core-rng.asm`.

The constructor thunk is `0x101020d6`, entering `FArchive::FArchive` at
`0x10106b30`.  Its object writes are:

```text
FArchive +04 = 0x44       +08 = 0x44c      +0c = 0
         +10 = 0          +14 = 0          +18 = 0
         +1c = 1          +20 = 1          +24 = 1
         +28 = 0          +2c = 0
vtable   = 0x101751f8
```

At the measuring call site in `UStruct::SerializeTaggedProperties` body
`0x10126730`, Core constructs that local object, stores the caller `FArchive*`
at local `+0x30`, copies caller `+0x10` to local `+0x10` and caller `+0x18` to
local `+0x18`, then switches the local vtable to `0x10177640`.  No other
caller archive words are copied.  The browser adapter is
`createScriptPropertyMeasureArchive(wrappedArchive, options?)` in
[`src/runtime/script-property-measure-archive.mjs`](../src/runtime/script-property-measure-archive.mjs).
Its `archiveState` exposes the constructor words, `wrappedArchive` models the
native `+0x30` pointer, `copiedOffsets` is `[0x10, 0x18]`, and `bytes`/`size`
are the dword counter at `+0x2c`.

## Reached vtable operators

The installed vtable is `0x10177640`.  The following entries are the ones
relevant to the measuring archive and the tagged-property path:

| slot | vtable target | recovered behavior |
| ---: | ---: | --- |
| `+0x04` | `0x10101712` → `0x1012a820` | `Serialize(void*,INT)` adds its second argument to local `+0x2c`, then returns the archive. |
| `+0x14` | `0x10101186` → `0x10106900` | `CountBytes(count,max)` returns without changing any field. |
| `+0x18` | `0x10103350` → `0x1012a7a0` | Reads the `UObject*` from the reference argument, calls wrapped archive `MapObject` at slot `+0x24`, then sends the returned `INT` through `FCompactIndex`. |
| `+0x1c` | `0x101030bc` → `0x1012a7e0` | Reads the `FName*` reference, calls wrapped archive `MapName` at slot `+0x20`, then sends the returned `INT` through `FCompactIndex`. |
| `+0x28` | `0x1010128a` → `0x101069a0` | Returns `-1` (`Tell`) without changing the counter. |

The specialized object and name bodies call the **wrapped** archive's map
virtuals.  They do not call the wrapped archive's object/name serialization
operators.  The host callbacks therefore have the form
`mapObject(value, context) -> INT` and `mapName(value, context) -> INT`, where
`value` is the dereferenced native pointer/name value.  A missing map callback
is an unsupported reached branch; returning a made-up index would change the
source call path.

The local vtable's `MapName` (`+0x20`, body `0x10106960`) and `MapObject`
(`+0x24`, body `0x10106980`) are inherited base methods that return zero.  The
adapter exposes these names for inspection, while its object/name operators
still dispatch to the wrapped archive's methods as the specialized native
bodies do.

## FCompactIndex width in this collector

The object/name bodies call `FCompactIndex` through thunk `0x10102950`, body
`0x10159b50`.  Its first branch tests the archive words at `+0x0c` and
`+0x10`.  The measuring object always has `+0x0c == 0`; the tagged collector
copies caller `+0x10`, and the collector archive state is zero there.  That
reached branch calls the measuring archive's raw `Serialize` with a literal
length of `4`.  Every measured object/name map therefore contributes exactly
four bytes, regardless of the mapped integer.

If copied `+0x10` is nonzero, the original code enters the variable-width
`FCompactIndex` branch.  That is a different archive mode and remains an
explicit unsupported boundary in this adapter.  The adapter validates mapped
results as signed 32-bit `INT`s and keeps the native counter as an unsigned
dword; `Serialize` increments it by the supplied nonnegative length.

## Runtime boundary

The tagged-property walker imports this adapter and uses it by default when a
caller does not provide `services.makeMeasureArchive`.  A caller may still
provide that factory to bind a different native archive representation.  The
default archive exposes these host names and native aliases:

```js
const measure = createScriptPropertyMeasureArchive(archive);
measure.serializeRaw(reference, length, context); // vtable +0x04
measure.objectReference(reference, context);      // vtable +0x18
measure.nameReference(reference, context);        // vtable +0x1c
measure.countBytes(count, maximum, context);     // vtable +0x14, no-op
measure.tell(context);                            // vtable +0x28, -1
```

`serialize`, `Serialize`, `serializeObject`, `serializeName`, `CountBytes`,
and `Tell` aliases are provided for native-shaped callers.  `operations`
records the reached operator bodies and `onOperation` is an optional host
observation hook; neither changes the counter.  The archive's `measure` flag
is true so existing property adapters can distinguish the first measuring
call from the subsequent caller-archive call.

This adapter does not implement save/load archive modes, variable-width
`FCompactIndex`, object/name table mapping, or property `SerializeItem` bodies.
Those remain explicit caller bindings at their recovered native boundaries.
