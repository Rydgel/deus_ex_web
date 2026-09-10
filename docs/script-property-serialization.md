# Collector serialization of property metadata

This is serialization of UProperty objects themselves, distinct from
[walking the values described by a property](script-reference-serialization.md).
The authority is the installed GOTY Core.dll (hash recorded in
[script-object-lifecycle.md](script-object-lifecycle.md)). Its exported instance
vtables select Serialize through slot `+0x28`:

| Class | Instance vtable | Serialize body | After UProperty |
| --- | --- | --- | --- |
| Property | 10175a44 | 10165020 | Base only |
| IntProperty | 10175bc4 | 10165020 | Base only |
| FloatProperty | 10175d44 | 10165020 | Base only |
| NameProperty | 10175f84 | 10165020 | Base only |
| StrProperty | 10176044 | 10167770 | Calls base only |
| ByteProperty | 10175b04 | 10165890 | Object reference at +5c (Enum) |
| BoolProperty | 10175c84 | 10166160 | Raw four bytes at +5c (bit mask) |
| ObjectProperty | 10175e04 | 10166bf0 | Object reference at +5c (PropertyClass) |
| ClassProperty | 10175ec4 | 10167050 | Calls ObjectProperty, then object reference at +64 (MetaClass) |
| FixedArrayProperty | 10176104 | 10167df0 | Object reference at +5c (Inner), then raw four bytes at +60 (Count) |
| ArrayProperty | 101761c4 | 101685d0 | Object reference at +5c (Inner) |
| MapProperty | 10176284 | 10168db0 | Object references at +5c (Key), then +60 (Value) |
| StructProperty | 10176344 | 101695c0 | Object reference at +5c (Struct) |

Addresses and offsets are hexadecimal. UProperty body `10165020` first calls
UField Serialize (`10165051`). It then archives `+34` (ArrayDim, four bytes),
`+3c` (PropertyFlags, four bytes), `+40` (Category FName), and, when the current
flags contain `20`, `+44` (RepOffset, two bytes). The <=61 flag-rewrite branch
and loading-only clears of `+48/+54` are absent for the collector archive.
BoolProperty archives its bit mask precisely when archive `+0c/+10` are both
zero; this includes GC, even though the package-loading reader omits it.

Object/name references use archive `+18/+1c` and remain mutable pointer/value
holders. FixedArrayProperty and MapProperty chain the archive returned by their
first object-reference operator; the concrete Core mark archive returns itself.
The host interface retains that same collector for subsequent operations.

`serializeGcProperty(object, archive, services)` requires a verified instance
vtable, `services.serializeUField`, and `services.slot(object, nativeOffset)`
returning live `{get,set}` storage. The base callback must implement the whole
UField/UObject chain. The archive exposes `objectReference` and `nameReference`
(or its `serializeObject`/`serializeName` equivalents). A raw callback is optional:
the collector inherits FArchive Serialize `10106760`, an exact no-op. Without
that callback, raw values are not read or synthesized; this matters for native
BoolProperty masks that have not yet been linked. Missing object/name storage
or a needed PropertyFlags slot is an error.

This implementation accepts the collector's exact version/flag words only.
It does not implement property linking, native offsets/strides, value-array/map
serialization, class registration, or save/load archive modes. The focused
integration check uses original CameraPoint property metadata and records the
base/native storage boundaries; it is not a complete loaded metadata graph.
