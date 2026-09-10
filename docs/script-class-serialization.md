# GC serialization of Core metadata classes

This document records the collector branch of the four Core metadata
serializers.  The authority is the hash-verified GOTY `Core.dll` in
`.cache/reference/Core-rng.asm`:

```
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
collector ctor   0x1015eac0, vtable 0x1017a2f0
```

The constructor writes `FArchive+0x04 = 0x44` and `+0x08 = 0x44c`, then
`+0x0c/+0x10/+0x14/+0x18 = 0` and `+0x1c/+0x20/+0x24 = 1`.  The module
requires these exact words.  The same archive also supplies mutable UObject
and FName reference operations.  Core's `UObject::Serialize` is a separate
mandatory service supplied by `script-object-serialization.mjs`.

## UField and UStruct

The UField virtual table is `0x1017561c`; thunk `0x10101d8e` enters body
`0x10125c70`.  It first calls the UObject serializer.  It then visits the
mutable object slots at `+0x28` and `+0x2c` through archive virtual `+0x18`,
in that order.  These are the UField `BaseField` and `Next` links.  The body
only clears `+0x30` when `FArchive+0x0c` is nonzero, so that write is outside
the collector branch.

The UStruct table is `0x10175698`; thunk `0x10102b5d` enters body
`0x10126fe0`.  After UField, the GC order is:

1. object reference `+0x34` (`ScriptText`);
2. object reference `+0x38` (`Children`);
3. name reference `+0x40` (`FriendlyName`), followed by the native nonzero
   assertion;
4. raw four bytes at `+0x54`;
5. raw four bytes at `+0x50`;
6. raw four bytes at `+0x48`;
7. `SerializeExpr` for every expanded script offset from zero up to the
   value read from `+0x48`.

The source calls the raw fields in that order at `0x10127053–0x1012707d` and
loads the script-size value before entering the loop.  Package readers expose
the corresponding conceptual values as line, text position, and script size,
but the native offsets and order above are the compatibility contract.  A
nonzero `+0x48` requires a concrete `SerializeExpr` adapter; the module does
not silently skip bytecode references.  The adapter receives the mutable
expanded offset, archive, and context and must advance the offset.  A final
offset different from the recorded size is the native warning case.

`SerializeExpr` is virtual slot `UStruct+0x7c`, thunk `0x1010281f`, body
`0x101289c0`, with jump table `0x10128e44`.  Its nested object and name
references use archive `+0x18` and `+0x1c`; the bytecode adapter owns those
token-level details.  The GC path does not allocate the serialized script
array (`+0x0c == 0`) and does not call the post-load hook at `+0x6c`.

## UState

The UState table is `0x101757d8`; thunk `0x10101776` enters body
`0x10127590`.  It calls UStruct first, then uses archive raw `+0x04` in this
exact order:

| native slot | width | metadata commonly exposed by package readers |
| --- | ---: | --- |
| `+0x6c` | 8 | `ProbeMask[2]` |
| `+0x74` | 8 | `IgnoreMask[2]` |
| `+0x80` | 2 | `LabelTableOffset` |
| `+0x7c` | 4 | `StateFlags` |

The collector's base raw serializer is a known no-op in this binary.  The
module still reports each raw operation, and a host can provide
`serializeRaw(reference, width, context)` when it needs the lvalue trace.

## UClass

The UClass table is `0x101758f4`; thunk `0x101011f9` enters body `0x101280d0`.
After UState, the version 68/69 collector path performs the following
operations:

1. raw four bytes at `+0x484` (`ClassFlags`);
2. helper `0x10102ff9 -> 0x1012ae20` on the 16-byte GUID at `+0x48c`.
   The helper performs four raw four-byte calls, one per GUID word;
3. helper `0x1010185c -> 0x1012af20` on the `FClassDependency` array at
   `+0x4bc`.  It calls `CountBytes(count*12, max*12)`, serializes the array
   count once at `+4` through `FCompactIndex` (the collector branch is raw
   four bytes), then for each entry visits the class object at element `+0`,
   raw four bytes at `+4`, and raw four bytes at `+8`;
4. helper `0x10101997 -> 0x1011e120` on the package-import FName array at
   `+0x4c8`.  It calls `CountBytes(count*4, max*4)`, serializes the array
   count once at `+4` through `FCompactIndex` (again raw four bytes in GC),
   then visits each FName through archive `+0x1c`;
5. because archive version `+0x04` is at least `0x3e`, object reference
   `+0x49c` (`ClassWithin`) and name reference `+0x4a0` (`ClassConfigName`);
6. the GC default-data branch described below.

The helper bodies are implemented directly when the host supplies ordinary
array storage.  If a class uses another representation, the module requires
an explicit `serializeDependencies` or `serializePackageImports` adapter.
The compact-index element-array load/save branches are selected only when
`FArchive+0x0c` is nonzero and are outside this collector contract; the GC
path's resolved four-byte `FCompactIndex` count call is included above.

The default-data branch begins at `0x10128305` because `FArchive+0x0c == 0`.
The defaults FArray is at `+0x4d4`, with size/count at `+0x4d8` and capacity
at `+0x4dc` as used by the native body.  If `UClass+0x10` (Linker) is
non-null, the body first calls vtable `+0x64` (`GetPropertiesSize`) and
checks it against `+0x4d8`.  It then calls vtable `+0x74`, whose export is
`SerializeTaggedProperties` (`0x10102108 -> 0x10126730`), with
`(archive, defaults-data, BaseField)`.  After that call it invokes `+0x64`
again and performs the same size assertion regardless of Linker.  Finally it
calls archive `+0x14` (`CountBytes`) with `(size, capacity)` and class vtable
`+0x70`, the exported `SerializeBin` (`0x1010285b -> 0x10126610`), with
`(archive, defaults-data)`.

The GC entry of `SerializeTaggedProperties` is not an early no-op.  At
`0x101267ad`, `FArchive+0x0c == 0` branches to `0x10126c07`, which resolves
the linked UProperty chain (including the `+0x2c` links) and continues through
the property virtuals.  The `FArchive+0x0c != 0` branch is the separate
load/save tagged path.  Both `SerializeTaggedProperties` and `SerializeBin`
are therefore mandatory adapters in the module because their
property/reference walks are separate native routines.  `GetPropertiesSize`
is mandatory for the two size checks.  A
missing raw or CountBytes callback is reported as an explicit skipped call
because the collector inherits Core's known no-op implementations at those
archive slots; missing metadata or property helper adapters raise an
unsupported error instead.

`script-tagged-properties.mjs` now provides the recovered collector traversal
as `serializeTaggedProperties`, matching this module's callback shape. Supply
its remaining bindings through `services.taggedPropertyServices` (or directly
on `services`); the callback context forwards those services explicitly. The
measuring archive and unresolved complex property virtuals remain required
bindings, so selecting this traversal does not claim a complete live class graph.

The old `version <= 0x3d` flags/default branch, compact-index element-array
load/save branch, config loading, localized loading, and save/load property
reconstruction are not reachable with the constructor state above.  They
remain unsupported rather than being approximated.

## Host adapter

`src/runtime/script-class-serialization.mjs` exports
`serializeUField`, `serializeUStruct`, `serializeUState`,
`serializeUClass`, and the kind-dispatching `serializeScriptClass`.  Each
metadata slot may be an explicit `{get,set}` lvalue in `services.layout`, a
raw-offset holder returned by `services.slot(object, offset)`, or the matching
host record field.  Object and name slots stay mutable so the
collector can apply its reference policy.  The class adapter accepts GUID
words or a 16-byte little-endian GUID, FClassDependency/package-import arrays,
and a `{data,size,capacity}` defaults record.

Required callbacks are:

```js
serializeUObject(object, archive)
serializeExpr(object, offsetReference, archive, context) // when script size > 0
serializeTaggedProperties(archive, defaultsData, baseField, context)
serializeBin(archive, defaultsData, context)
getPropertiesSize(object, context)
```

The archive must provide `objectReference`/`serializeObject` and
`nameReference`/`serializeName`.  Raw and CountBytes callbacks are optional
only because their concrete collector implementations are no-ops; every
attempt is retained in the returned `events`, `rawCalls`, or `countCalls`
lists.  Save, replication, and non-GC archive modes are outside this module.
