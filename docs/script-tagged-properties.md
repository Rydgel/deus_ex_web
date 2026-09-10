# GC tagged-property serialization

This contract covers the collector branch of Core's
`UStruct::SerializeTaggedProperties`.  The source is the hash-verified GOTY
`Core.dll` (`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`),
with the disassembly in `.cache/reference/Core-rng.asm` and
`.cache/research/Core.asm`.

The exported thunk is `0x10102108`; it enters body `0x10126730`.  Its native
arguments are `(UStruct* this, FArchive& ar, BYTE* data, UClass* defaults)`. A
nonzero `ar+0x0c` selects package tagged serialization and is outside this
module.  The GC archive has `ar+0x0c == 0` and follows the body at
`0x10126c07`.

## Archive state and walk

The collector archive constructed by Core body `0x10106b30` has these words:

```text
+04 = 0x44   +08 = 0x44c  +0c = 0  +10 = 0  +14 = 0  +18 = 0
+1c = 1      +20 = 1      +24 = 1
```

The module requires those values.  It walks the current struct's `Children`
field (`UStruct+0x38`), follows `UField+0x2c` (`Next`), and then repeats the
same walk for each inheritance super returned by the struct `+0x68` virtual.
Non-`UProperty` fields are skipped by the native class-chain test.  A property
with `PropertyFlags` bit `0x1000` (native) is skipped.  Bit `0x2000`
(transient) is skipped only when `ar+0x18` is nonzero, so transient properties
are included in this GC path.

For each property, the body reads `ArrayDim` at `+0x34`, `ElementSize` at
`+0x38`, and `Offset` at `+0x48`.  It visits indices from zero through
`ArrayDim-1` in order.  If the incoming `data` pointer is null, each element
is skipped and the loop continues; the `None` terminator is still emitted.

The comparison default pointer is `defaults+0x4d4 + valueOffset` only when
`valueOffset + ElementSize <= defaults+0x4d8`; otherwise native code passes a
null default pointer.  Runtime class records expose that pair as
`defaultsClass.defaultBuffer = { data, size, capacity }`.  The current data
and comparison data are separate storages.

The native `Identical` virtual is called before a tag is built.  The module
contains the simple, source-checked cases:

| Property | Native comparison |
| --- | --- |
| `ByteProperty` | one unsigned byte; null default reads zero |
| `IntProperty` | one dword; null default reads zero |
| `FloatProperty` | x87 `FCOMPS`, `FNSTSW`, then C3 test; equality and unordered (either operand NaN) are identical |
| `BoolProperty` | `(value ^ default) & BoolMask`; null default is zero and mask `+0x5c` is required |
| `ObjectProperty`/`ClassProperty` | pointer identity; null default is a null pointer |
| `NameProperty` | FName identity; null default is the zero FName |

Complex property types require an explicit `services.identical` adapter at
the native `UProperty` `+0x6c` boundary.  A missing adapter is reported as an
unsupported reached branch; it is never treated as equal by default.

## Tag and helper order

For a nonidentical element, `UProperty::GetID` (`+0x9c`) is called twice.  The
two low bytes become tag offsets `+0x00` and `+0x01`.  The remaining local
`FPropertyTag` fields are:

| Tag offset | Value |
| ---: | --- |
| `+0x00` | first `GetID` byte |
| `+0x01` | second `GetID` byte, then size/index/bool flags |
| `+0x04` | property `Name` (`+0x20`) |
| `+0x08` | zero, or `UStructProperty` struct `Name` (`struct+0x20`) |
| `+0x0c` | measured serialized byte count |
| `+0x10` | array index |

The property helper is thunk `0x10102dc9`, body `0x1012aca0`.  Core first
constructs an `FArchive` with body `0x10106b30`, switches its vtable to
`0x10177640` at the measuring call site, and invokes `SerializeItem`
(`UProperty` vtable `+0x78`) on the value.  The local archive copies the
caller's `+0x10` and `+0x18` words after construction; the other constructor
words remain the values listed above.  The native count and object/name width
rules belong to that measured archive vtable.  The runtime therefore requires
`services.makeMeasureArchive`; it does not guess a width or implement a
fallback counter.

After the measured result is read, the second helper call invokes the same
`SerializeItem` on the caller's archive and value.  This order is observable
and preserved by `serializeTaggedPropertiesGc`.  Simple runtime records may
use the built-in byte/int/float raw, object, and name operators, but the
archive operations themselves remain mandatory.  A property-specific
`serializeItem` callback is available for complex or native layouts.

The measured count is encoded into tag byte `+0x01` as follows:

```text
1      -> 0x00       2      -> 0x10       4      -> 0x20
0x0c   -> 0x30       0x10   -> 0x40       other <= 0xff -> 0x50
0x100..0x10000 -> 0x60   greater than 0x10000 -> 0x70
```

The `0x50` case includes zero, 3, 5 through 11, and 13 through 15.  If the
array index is nonzero, bit `0x80` is ORed into the byte.  For a bool property,
the same bit is ORed when `value & BoolMask` is nonzero.  Thus the two reasons
for bit `0x80` are independent and share one tag bit.

The bool branch of `0x1012aca0` validates the nonzero mask and performs no
archive write for this GC state (`ar+0x0c == 0`).  Nonbool branches call the
property's `SerializeItem`; the collector's raw archive implementation may be
a native no-op, but the reached virtual boundary is retained by the adapter.

After all properties, Core creates a mutable zero FName (`NAME_None`) and
calls the caller archive's name virtual `+0x1c` exactly once.  The module
requires `archive.nameReference` or `archive.serializeName` and returns the
terminator holder in its result.  `services.noneName` must identify the real
index-zero name when the host has a name table.

## Runtime boundary

The implementation is in
[`src/runtime/script-tagged-properties.mjs`](../src/runtime/script-tagged-properties.mjs):

```js
serializeTaggedPropertiesGc(structure, archive, data, defaultsClass, services)
```

`services` can supply the field walk, typed `valueReference` and
`defaultReference`, `getPropertyId`, `identical`, `serializeItem`, bool/struct
classification, and the mandatory `makeMeasureArchive`.  The measure factory
receives the caller archive and this descriptor:

```js
{
  kind: 'tagged-properties-measure-archive',
  body: 0x10106b30,
  vtable: 0x10177640,
  archiveState: TAGGED_GC_ARCHIVE_STATE,
  copiedOffsets: [0x10, 0x18],
}
```

It must return a measuring archive exposing its byte count as `bytes`, `size`,
or the measured `SerializeItem` result.  The caller archive must expose the
name operator; object references and raw values are required only when a
reached property uses them.  Reference holders are required for all value
storage so adapters can preserve native pointer semantics.

The module does not implement save/load tagged serialization, property linking,
untraced `SerializeItem` bodies, generic UObject layout discovery, or an
invented archive-size counter.  Those are explicit host boundaries until the
corresponding native virtuals are recovered.
