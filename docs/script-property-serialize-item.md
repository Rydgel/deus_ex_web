# Complex UProperty::SerializeItem virtuals

`src/runtime/script-property-serialize-item.mjs` translates the complex
property `SerializeItem` virtuals (vtable slot `+0x78`) from the installed Deus
Ex GOTY `Core.dll`.  The simple bodies (Int/Float/Byte/Name/Object/Class) and
the inline archive branches remain in `src/runtime/script-tagged-properties.mjs`;
this module owns the complex bodies that walker previously failed on, including
the fixed-array and struct property loops, plus the verified
`UBoolProperty::SerializeItem` body.

All addresses are read directly from `.cache/research/Core.asm`, the disassembly
of the installed GOTY `System/Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`); no public
engine source is the authority.

## Entry points

| Class | Body | Collector (ar0c == 0, ar10 == 0) measure bytes |
| --- | --- | --- |
| `UStrProperty::SerializeItem` | `0x10167750` | `4 + ArrayNum * (ascii ? 1 : 2)` |
| `UArrayProperty::SerializeItem` | `0x10168520` | `4 + sum(inner item bytes)` |
| `UFixedArrayProperty::SerializeItem` | `0x10167da0` | `sum(inner item bytes)` |
| `UStructProperty::SerializeItem` | `0x101691b0` | `UStruct::SerializeBin` member bytes |
| `UMapProperty::SerializeItem` | `0x10168d90` | `0` (immediate `ret`) |
| `UBoolProperty::SerializeItem` | `0x10166550` | `1` |

The measure byte counts were established **empirically** with the Unicorn x86
emulator (`scripts/native-property-serialize-item-oracle.py`).  The probe
constructs an FArchive with vtable `0x10177640` and the collector constructor
words, then reads its dword counter at `+0x2c` after each property's
`SerializeItem`.  It produced `str_empty=4`, `str_allocated_empty=5`,
`str_1=6`, `str_3=8`, `str_5=10`, `str_ascii_233=6`,
`str_unicode_0x100=8`, `str_unicode_0x4e2d=8`, `str_unicode_mixed=16`,
`str_cap20_num4=8` for `{Num:4, Max:20}`, `array_2_ints=12`,
`array_empty=4`, `map_any=0`, and `bool=1` for every value.

## UStrProperty::SerializeItem — `0x10167750`

```
Ar << *(FString*)Data
```

`FArchive::operator<<(FString&)` (`0x101459b0`) runs:

1. `FString->CountBytes(Ar, 2)` — archive `+0x14`; a measure-archive no-op.
2. The FString header is `Data (+0x0), ArrayNum (+0x4), ArrayMax (+0x8)`.
   Scan the data until the first NUL; if every scanned code unit is `< 0x100`,
   `marker = +ArrayNum`; otherwise `marker = -ArrayNum`.  (When `ArrayNum ==
   0`, the operator scans the empty literal at `0x101ef654`.)
3. `Ar << CompactIndex(marker)` — in the collector/measure archive state
   (`ar0c == 0`, `ar10 == 0`) this is raw `Serialize(4)`.
4. `FCompactIndex` reads archive `+0x0c` (`IsLoading`) and only then `+0x10`
   (`IsSaving`).  The FString operator reads `+0x0c` again to select its data
   branch.
5. For `ar0c == 0` (collector or saving), `ArrayNum` values are written:
   * marker `> 0` (ASCII): one byte per code unit, each char `>= 0x100`
     clamped to `0x7f`;
   * marker `< 0` (Unicode): two bytes per code unit.

The byte count therefore uses **`ArrayNum`**, including the terminating code
unit for an allocated nonempty string; `ArrayMax` only describes allocation
capacity.  The `FString(const TCHAR*)` constructor at `0x101073a0` sets both
counts to `text.length + 1` for nonempty text and both to zero for an empty
literal.  A plain JS string follows those constructor counts.  A native-shaped
record (`{data, arrayNum, arrayMax}`) can represent an allocated empty string
explicitly with `arrayNum: 1`; a `services.stringCapacity` callback may supply
extra capacity, which does not change the serialized count.  The valid native
record `{data: 'abc', arrayNum: 4, arrayMax: 20}` therefore measures `8` bytes,
not `24`.

The layout is independently established by `UStrProperty::CopySingleValue` at
`0x10167b30`: it reads the source `+0x4`, stores that count to destination
`+0x8` and then `+0x4`, calls `FArray::Realloc(2)`, and copies `2 * Num` bytes.
`FArray::Realloc` at `0x10145440` reads `+0x8` as the capacity.  These copy and
allocation instructions rule out the TArray order for FString.

### FString loading and saving

The variable-width `FCompactIndex` body at `0x10159b50` is now translated for
the noncollector states.  It uses a sign bit, six first-byte value bits, three
seven-bit continuation bytes, and a final five-bit byte.  Collector mode keeps
the native four-byte raw fallback.  Saving passes each encoded byte to
`serializeRaw` without changing the caller's FString; loading starts each
local byte at zero and takes the value written by `serializeRaw`.

When `ar0c != 0`, the decoded marker's absolute value becomes both FString
`ArrayNum` and `ArrayMax`, followed by `FArray::Realloc(2)`.  The operator then
reads one-byte code units for a positive marker or two-byte code units for a
negative marker.  A loaded one-unit terminator invokes the native
`FArray::Empty(2, 0)` cleanup and publishes `ArrayNum = ArrayMax = 0`.
Loading a native-shaped record therefore requires an explicit
`reallocateArray`/`arrayRealloc` host service; opaque `Data` pointers also
require `stringData`/`readStringUnits` and `writeStringUnits` services.  A
logical JS string can be replaced directly by the decoded text.

## UArrayProperty::SerializeItem — `0x10168520`

```
Inner = this->+0x5c
Ar << CompactIndex(Data->ArrayNum)        // raw 4 in collector, compact bytes otherwise
if (ar0c != 0) { loading: clear, realloc, publish count, grow }
for i in 0 .. decoded-or-current ArrayNum-1:
    Inner->SerializeItem(Ar, Data->Data + i * Inner->ElementSize)
```

A null current value is an empty array.  The element recursion dispatches
through `serializeScriptPropertyItem`, so arrays of object/name/raw/bool/str/
array/map values serialize correctly; struct and fixed-array elements now use
the same recovered `+0x78` dispatcher.

### TArray loading and saving

Saving (`ar0c == 0`, `ar10 != 0`) leaves `Data`, `ArrayNum`, and `ArrayMax`
untouched while serializing the current elements.  Loading (`ar0c != 0`) first
sets `ArrayNum = ArrayMax = 0` and calls `FArray::Realloc(Inner.ElementSize)`.
It then publishes the decoded nonnegative count.  If that count exceeds the
current capacity, native growth is
`count + floor(3 * count / 8) + 32`, followed by a second Realloc with the
same element stride.  Inner `SerializeItem` calls happen only after this
storage mutation and use the decoded count.  A negative compact count,
missing Inner `ElementSize`, missing Realloc service, opaque data pointer, or
short logical storage is reported as an explicit unsupported native boundary.

The native load/save oracle supplies only the archive raw slot and GMalloc
Realloc callback; the property bodies, CompactIndex, and element recursion run
from the hash-pinned Core.dll.

## UFixedArrayProperty::SerializeItem — `0x10167da0`

The installed body is a compact count-and-stride loop:

```
count = this->+0x60
for (i = 0; i < count; ++i) {       // signed count test; Count <= 0 returns
    inner = this->+0x5c
    stride = inner->+0x38
    inner->SerializeItem(Ar, Data + i * stride)  // vtable +0x78
}
```

There is no `FCompactIndex` count and no direct archive call.  The native
property's own `ElementSize` is the total inline storage size established by
`UFixedArrayProperty::Link`; the loop uses the linked Inner property's
`ElementSize` as its per-element stride.  The translated helper therefore
requires the linked count, Inner and Inner `ElementSize` for a positive count,
and visits exactly the first `Count` logical elements.  A nonpositive native
count returns before dereferencing Inner, matching the `jle` at
`0x10167da7`.

The helper accepts a logical JavaScript array or `{data: Array}` inline record.
It does not infer missing elements or silently serialize a dynamic array's
`ArrayNum`; a short value is an explicit storage error.  Inner values recurse
through `serializeScriptPropertyItem`, so nested fixed arrays and structs use
the same recovered dispatch.  The returned `measuredBytes` is the sum of the
inner results and contains no fixed-array header contribution.

## UStructProperty::SerializeItem — `0x101691b0`

The exact body is two virtual calls:

```
Struct = this->+0x5c
Ar.Preload(Struct)                         // archive vtable +0x10
Struct->SerializeBin(Ar, Data)              // UStruct vtable +0x70
```

The `SerializeBin` body is `0x10126610` (export thunk `0x1010285b`).  Its field
iterator visits the current struct's Children/Next chain, then each
`GetInheritanceSuper` chain in order.  For each property it tests
`PropertyFlags (+0x3c)`: `0x1000` skips unconditionally, while `0x2000` skips
only when `FArchive +0x18` is nonzero.  Every remaining `ArrayDim (+0x34)`
element is dispatched through the member property's `SerializeItem` slot
`+0x78` with `Data + PropertyOffset (+0x48) + i * ElementSize (+0x38)`.
The binary stream has no nested property tags and no native padding writes.

`serializeStructItem` follows this order from linked `structFields` or a
Children/Next/super record.  It calls an optional `preloadStruct` archive (or
`preloadObject`) hook with the linked Struct identity before walking members;
the installed collector Preload body is `retl $0x4`, so a missing hook is the
faithful no-op for that archive.  Native Vector and Rotator records with no
children consequently serialize zero bytes.  Generic structs require a
complete member list and keyed logical storage.  Missing member storage,
unknown member serializers, cyclic by-value structs, and raw storage without
an archive adapter remain explicit errors.

Nested struct members use the same `0x1000`/`0x2000` flag tests and recursively
run the linked member serializer.  A fixed-array member follows the direct
fixed loop above; it does not run a second `SerializeBin` pass.

## UMapProperty::SerializeItem — `0x10168d90`

`retl $0x8` immediately: no archive operation for any archive state or value.

## UBoolProperty::SerializeItem — `0x10166550`

```
byte = (value & BitMask) != 0
Ar->Serialize(&byte, 1)                   // +1 in the measure archive
update the bit in the original storage dword from the serialized byte
```

There is no archive-flag gate after Serialize: `10166575–1016658c` tests the
byte and sets/clears the original mask. Collector/measure serialization leaves
the byte unchanged and sees exactly one byte. The earlier loading-only
description was incorrect. This corrects the previous
tagged-property model, which measured a bool as zero bytes.

## API and storage

```js
serializeStrItem(property, archive, reference, context, services)
serializeArrayItem(property, archive, reference, context, services)
serializeFixedArrayItem(property, archive, reference, context, services)
serializeStructItem(property, archive, reference, context, services)
serializeMapItem()
serializeBoolItem(property, archive, reference, context, services)
serializeScriptPropertyItem(property, archive, reference, context, services)
```

The archive must expose `serializeRaw(reference, width, context)` and the
object/name operators for the element kinds that reach them.  Collector mode
uses the raw callback as a byte counter; save/load adapters use it as the
mutable archive boundary.  An optional `countBytes(count, maximum, context)`
receives FString storage bytes (`ArrayNum * 2`, `ArrayMax * 2`).  `services`
may supply `readArchiveWord`, `innerProperty`, `boolMask`, `stringCapacity`
(extra FString capacity), `serializeItem`, `reallocateArray`/`arrayRealloc`,
`stringData`/`readStringUnits`, `writeStringUnits`, `stringEmpty`, and
`arrayData`.  Reallocation callbacks receive `(record, elementSize, details)`
and own native heap storage; they are required for loading native-shaped
FString/TArray records.

## Tagged-property integration

`src/runtime/script-tagged-properties.mjs` `invokeItem` routes Bool, Str,
Array, FixedArray, Struct and Map to this module before its unresolved-`+0x78`
failure.  These paths produce their verified measure sizes and compose
recursively through the shared `serializeScriptPropertyItem` dispatcher with
the same scalar/Name/Object operators.  The bool measure changed from the
previous (incorrect) zero to the emulator-verified one byte, and the tagged
test expectations were updated to match the native counts.

## Evidence and focused validation

`test/script-property-serialize-item.test.mjs` replays the bodies against a
recording archive:

* Str: collector byte counts; variable-width save CompactIndex and CountBytes;
  loading signed Unicode units, `ArrayNum`/`ArrayMax` mutation, Realloc,
  one-unit empty cleanup, native capacity validation, and missing-archive or
  heap-service errors;
* Array: collector byte counts; saving without allocation mutation; loading
  count/growth (`count + floor(3*count/8) + 32`), two Realloc calls, element
  recursion, empty/null-current handling, and native-shaped TArray records;
* FixedArray: exact positive count/stride recursion, zero-count early return,
  and no count-header write;
* Struct: Preload-before-SerializeBin order, direct plus inherited member order,
  ArrayDim expansion, flag gates, nested recursion, and native Vector/Rotator
  empty streams;
* Map: zero bytes;
* Bool: exactly one byte, nonzero mask requirement;
* dispatcher routing for all supported kinds, object/name operator dispatch,
  and Struct/FixedArray recursion;
* byte-count checks matching the native probe (`str_empty = 4`,
  `str_allocated_empty = 5`, CompactIndex width 4).

`scripts/native-property-serialize-item-oracle.py` executes the original
`UStrProperty::SerializeItem`, `UArrayProperty::SerializeItem`,
`UFixedArrayProperty::SerializeItem`, `UStructProperty::SerializeItem`,
`UMapProperty::SerializeItem` and `UBoolProperty::SerializeItem` in the
emulator against the constructed measure archive and the hash-verified GOTY
`Core.dll`.  It also executes original FString/TArray load/save calls with a
raw archive vtable and non-reclaiming GMalloc Realloc service, recording
CompactIndex bytes, UTF-16 units, allocation sizes, count growth, and element
values.  The fixed/struct probes use instrumented native archive/Struct
vtables to record the original call order and pointer arithmetic in addition
to the measure byte counts.

## Boundary

These bodies cover the collector/measure and the recovered FString/TArray
loading/saving branches.  The `CopyCompleteValue` (`+0x90`) and `DestroyValue`
virtuals, full loaded resource graph, generic tagged save serializer, and
other raw native event storage remain separate Stage 3 work. Struct and
fixed-array member streams are covered when their linked logical metadata and
archive adapters are present; native heap byte pointers still require the
explicit services described above.
