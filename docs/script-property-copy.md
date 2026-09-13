# Native property value copying

This document is the source contract for the Stage 3 raw property-copy
adapter. It describes the installed Deus Ex GOTY `System/Core.dll`, rather
than the logical value copies in `script-values.md`. The binary used for the
measurements has SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The companion oracle also records the loaded `Engine.dll` hash
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.

The evidence is the native disassembly in `.cache/research/Core.asm`, with
the vtable entries checked against the installed PE `.rdata`. The thunk at a
vtable slot is listed separately from the body it jumps to. A slot address is
therefore not interchangeable with a body address.

## Virtual slots and bodies

Every copy virtual has the x86 member-call shape
`Copy*(void* Destination, void* Source)`: `ECX` is the property object,
`[ESP+4]` is the destination, `[ESP+8]` is the source, and the callee returns
with `ret 8`. The slots are `+0x8c` (`CopySingleValue`) and `+0x90`
(`CopyCompleteValue`).

| Class | vtable | `+0x8c` thunk → body | `+0x90` thunk → body |
| --- | --- | --- | --- |
| `UProperty` | `0x10175a44` | `0x101017b2` → `0x10165560` | `0x10101820` → `0x10165600` |
| `UByteProperty` | `0x10175b04` | `0x10101523` → `0x10165790` | `0x10101857` → `0x101657a0` |
| `UIntProperty` | `0x10175bc4` | `0x1010206d` → `0x10165d00` | `0x10101735` → `0x10165d10` |
| `UBoolProperty` | `0x10175c84` | `0x101026b2` → `0x101665f0` | `0x10101820` → `0x10165600` (inherited) |
| `UFloatProperty` | `0x10175d44` | `0x1010338c` → `0x10166740` | `0x1010100f` → `0x10166750` |
| `UObjectProperty` | `0x10175e04` | `0x10102937` → `0x10166b30` | `0x101033eb` → `0x10166b40` |
| `UClassProperty` | `0x10175ec4` | `0x10102937` → `0x10166b30` | `0x101033eb` → `0x10166b40` |
| `UNameProperty` | `0x10175f84` | `0x101020fe` → `0x101672f0` | `0x10101fb4` → `0x10167300` |
| `UStrProperty` | `0x10176044` | `0x1010174e` → `0x10167b30` | `0x10101820` → `0x10165600` (inherited) |
| `UFixedArrayProperty` | `0x10176104` | `0x10102856` → `0x10168290` | `0x10101820` → `0x10165600` (inherited) |
| `UArrayProperty` | `0x101761c4` | `0x1010115e` → `0x10168a70` | `0x10101820` → `0x10165600` (inherited) |
| `UMapProperty` | `0x10176284` | `0x10101d9d` → `0x10168f40` | `0x10101820` → `0x10165600` (inherited) |
| `UStructProperty` | `0x10176344` | `0x10101037` → `0x10169c40` | `0x10101820` → `0x10165600` (inherited) |

The property fields used by these bodies are:

| Offset | Meaning |
| --- | --- |
| `+0x00` | property vtable pointer |
| `+0x34` | signed `ArrayDim` (`INT`) |
| `+0x38` | `ElementSize` (`INT`) |
| `+0x3c` | `PropertyFlags`; `0x400000` is `CPF_NeedCtorLink`/the owning-array branch bit |
| `+0x48` | member byte offset, used by `UStructProperty` |
| `+0x5c` | `Inner` for array properties, `Struct` for a struct property |
| `+0x60` | fixed-array element count |

The inline `FString` and `TArray` records in this build are both three
dwords: `Data` at `+0x0`, `ArrayNum` at `+0x4`, and `ArrayMax` (capacity) at
`+0x8`. `FArray::Realloc` multiplies `ArrayMax` by the supplied element size.
Some older serialize/identical notes label the FString words as
`ArrayMax,+0x4` and `ArrayNum,+0x8`; that labeling is stale for this copy
contract. The native copy body reads `Source+0x4` as the number of UTF-16 code
units and writes that number to both destination counters.

## Generic `UProperty` copies

`UProperty::CopySingleValue` (`0x10165560`) reads `ElementSize` once. It
copies `ElementSize >> 2` dwords with forward `rep movsl`, then
`ElementSize & 3` bytes with forward `rep movsb`. It does not call a virtual,
check either pointer, or use an overlap-safe memmove. A non-multiple-of-four
size therefore has a dword prefix followed by a byte suffix. Overlapping
source and destination ranges have the normal forward-copy corruption.

`UProperty::CopyCompleteValue` (`0x10165600`) first reads `ArrayDim`; a value
less than or equal to zero returns without a callback. For each `i` it reads
`ElementSize` and the property vtable again, computes

```text
Destination + i * ElementSize
Source      + i * ElementSize
```

and calls the current vtable `+0x8c` entry. After the callback it rereads
`ArrayDim`, increments `i`, and continues while `i < ArrayDim`. Thus a
callback can shrink or expand the remaining number of iterations, change the
next stride, or replace the next dispatch table. The base source and
destination arguments are the values saved on entry. No allocation or
destruction occurs in this generic body.

## Scalar and boolean bodies

The scalar single-value bodies ignore `ElementSize` and copy one storage unit:

* `UByteProperty` (`0x10165790`) copies one byte.
* `UIntProperty` (`0x10165d00`), `UFloatProperty` (`0x10166740`),
  `UObjectProperty`/`UClassProperty` (`0x10166b30`), and `UNameProperty`
  (`0x101672f0`) copy one dword.

Their specialized complete bodies also ignore `ElementSize` and do not call
`+0x8c`. For the dword classes (`UInt`, `Float`, `Object`, `Class`, `Name`),
`ArrayDim == 1` copies one dword, `ArrayDim <= 0` does nothing, and a positive
larger value copies that many dwords with forward `rep movsl`. For
`UByteProperty`, `ArrayDim == 1` copies one byte; any other value enters the
raw byte-count path (`rep movsl` followed by `rep movsb`). Zero is a no-op in
that path. The native byte body does not explicitly guard a negative value,
so a negative `ArrayDim` becomes an enormous unsigned repeat count; valid
linked properties use nonnegative dimensions.

`UBoolProperty::CopySingleValue` (`0x101665f0`) reads its bit mask from
`+0x5c` and updates only those bits in the destination dword:

```text
Destination = (Destination & ~BitMask) | (Source & BitMask)
```

Bool complete copy is inherited generic `0x10165600`, so it applies that
masking callback once per outer `ArrayDim`, using the property `ElementSize`
as the stride. A bool's complete operation can therefore preserve unrelated
bits separately in every element.

## FString copy

`UStrProperty::CopySingleValue` (`0x10167b30`) is an inline FString
assignment:

1. If `Destination == Source`, return immediately without reading or writing.
2. Read `Source+0x4` (`sourceCount`). Write `Destination+0x8 = sourceCount`,
   then `Destination+0x4 = sourceCount`.
3. Call `FArray::Realloc` on the destination with element size `2`.
4. Reread `Destination+0x4`. If it is zero, return. Otherwise select
   `Source+0x0` when the cached source count was nonzero, or the static empty
   literal at `0x101ef654` when it was zero, then copy `2 * Destination+0x4`
   bytes forward into `Destination+0x0` using dword/byte groups.

The normal path writes `ArrayNum == ArrayMax == sourceCount`; `Realloc` uses
the new capacity. The empty-literal branch is present in the body but the
ordinary writes above make the post-Realloc zero-count return occur first.
The source record and nonzero data pointer must still be valid for the
nonempty path. There is no ownership transfer or logical-string conversion.
The inherited complete body applies this operation at outer
`ArrayDim * ElementSize` strides.

## Dynamic `TArray` copy

`UArrayProperty::CopySingleValue` (`0x10168a70`) reads `Inner` once and reads
`Inner+0x38` (`size`) once. It reads `Source+0x4` (`sourceCount`), clears
`Destination+0x4`, stores `Destination+0x8 = sourceCount`, and calls
`FArray::Realloc(Destination, size)`.

The inner `PropertyFlags & 0x400000` branch then selects the storage copy:

* With the bit clear, it sets the destination count to the old destination
  count plus `sourceCount` (the body has already cleared the count, so this is
  normally `sourceCount`). If the count exceeds capacity, it sets
  `ArrayMax = count + floor(3 * count / 8) + 32` and calls `Realloc` again. It
  then copies `sourceCount * size` bytes forward from source data to
  destination data. No inner virtual is called.
* With the bit set, it performs the same count/capacity calculation, zeroes
  the destination range for the incoming elements, rereads the inner vtable
  for each element, and calls its `+0x90` complete-value entry in ascending
  order. The callback pointers are `DestinationData + i * size` and
  `SourceData + i * size`. Existing destination elements are not destroyed
  by this body.

The initial count clear happens before the first `Realloc`. In the recursive
branch the zeroing also happens before the source data pointer is read for the
callbacks. Consequently a same-header self-copy in the raw branch copies the
same data forward and remains unchanged, while a same-header self-copy in the
owning/recursive branch zeroes the data and callbacks observe the zeroed
source. A null source record is dereferenced at `+0x4` and is invalid. The
inherited complete body wraps this single-value operation over outer
`ArrayDim` and `ElementSize` strides.

## Fixed array copy

`UFixedArrayProperty::CopySingleValue` (`0x10168290`) reads the fixed count
from `+0x60`; a count less than or equal to zero returns. It caches `Inner`,
then for each index reads the current inner `ElementSize`, reads the current
inner vtable, and calls inner `+0x90` with:

```text
Destination + i * Inner.ElementSize
Source      ? Source + i * Inner.ElementSize : null
```

There is no allocation, byte-copy fallback, or fixed-array self-copy guard.
If the source base is null, null is passed to every callback; the callback is
responsible for whether that is valid. A null inner object or destination is
not guarded by the native body. Its inherited complete operation is the
generic outer `ArrayDim` loop.

## Map copy

`UMapProperty::CopySingleValue` (`0x10168f40`) is exactly `ret 8`: it reads
and writes no map storage. Its inherited complete operation still invokes
that no-op once per outer `ArrayDim`, through the generic loop.

## Struct copy and callback order

`UStructProperty::CopySingleValue` (`0x10169c40`) reads `Struct` from `+0x5c`;
a null struct returns. It walks the current struct's `Children` at struct
`+0x38` through each `UField.Next` at field `+0x2c`. Each candidate is
filtered by `UObject::IsA` against the native `UProperty` class at
`0x102a7af0`. For each property that passes, it reads the field's member
offset at `+0x48`, reads that field's vtable, and calls the field's `+0x90`
complete value with the base pointers plus that offset. It reads `Next` after
the callback returns.

After the current `Children` chain ends, it calls the current struct vtable
`+0x68` (`GetInheritanceSuper`) and repeats the same child walk for the
superclass. The order is therefore all direct children in `Next` order,
then the inheritance super's children, continuing toward the root. A child
that is not a `UProperty` is skipped. Struct copy leaves padding bytes alone,
allocates nothing, and delegates each member's own complete-copy semantics.
The default adapter requires `services.getInheritanceSuper` (or
`getSuperStruct`) for that virtual call; reading `+0x28` is only valid for a
verified implementation of the virtual. A host may alternatively supply the
whole original ordering through `services.structProperties`. Known property
classes/vtables supply the default field filter; other class hierarchies need
`services.isProperty` to establish the native IsA result.
The inherited generic complete body applies this whole struct walk once per
outer `ArrayDim`, with the struct property's `ElementSize` stride.

The oracle records this traversal in one shared callback count/order/pointer
buffer. The focused inheritance case visits property identifiers `[1, 3]`
and member offsets `[0, 8]`; the intervening non-property field identifier 99
is not visited.

## Allocator and pointer boundary

`FArray::Realloc` (`0x10145440`) computes `ArrayMax * ElementSize`, calls the
global `GMalloc` object at `0x101a7c44` through its `+0x4` allocator method
with the old data pointer and allocation tag `0x101ab50c`, and stores the
returned pointer at record `+0x0`. The exact allocator relocation, free,
failure, and ownership behavior is outside this focused copy contract.

`scripts/native-property-copy-oracle.py` patches `0x10145440` to `ret 4` and
preallocates every record and data buffer. Its results therefore establish
the native counts, strides, branch selection, callback order, and bytes while
leaving allocator/storage ownership explicit. A raw runtime adapter must
provide pointer resolution and a real `reallocateArray` service before it can
claim native heap fidelity.

## Focused native oracle

Run the exact installed-image probe with:

```sh
.cache/native-probe-env/bin/python scripts/native-property-copy-oracle.py 'Deus Ex GOTY Edition'
```

The JSON object contains `hashes`, the resolved `vtables`, body constants, and
these twelve focused `results` cases. The pointer arrays are emulator
addresses; subtracting the first pointer (or using the recorded base buffers)
gives the stable offsets shown below.

| Case | Native input and observed result |
| --- | --- |
| `generic_single_overlap` | `UProperty`, `ArrayDim=1`, `ElementSize=7`, destination offset 1/source offset 0; final bytes `01 01 02 03 04 04 04 04 09 0a 0b 0c 0d 0e 0f 10` |
| `generic_complete_live_metadata` | starts `ArrayDim=3`, `ElementSize=4`; one callback writes `0xc0c0c0c0`, changes metadata to `ArrayDim=1`, `ElementSize=8`; calls `1`, order `[0xc0]`, destination/source offsets `[0]`, post metadata `1/8`, destination begins `c0 c0 c0 c0 dd dd dd dd dd dd dd dd` |
| `byte_complete_array_dim_5` | `UByteProperty`, byte `ArrayDim=5`; destination becomes `10 20 30 40 50 dd dd dd` |
| `int_complete_array_dim_3` | `UIntProperty`, dword `ArrayDim=3`; destination words `0x11223344, 0x55667788, 0x99aabbcc, 0` |
| `bool_single_mask` | mask `0x00ff0000`, destination `0xa534a5a5` from `0xa5a5a5a5` and `0x12345678` |
| `str_single_count_capacity` | source `ArrayNum=3`, `ArrayMax=7`; destination ends `ArrayNum=3`, `ArrayMax=3`, UTF-16 words `0x00320031, 0xdead0000, 0, 0` |
| `str_single_alias` | same record is unchanged: counters `3,7`, data words `0x00320031,0,0` |
| `array_single_raw` | `UArrayProperty` with scalar inner and flags clear; source count 3; destination count/capacity `3/3`, words `7,9,11,0,0` |
| `array_single_recursive` | inner flags `0x400000`, source count 3; three callbacks in order `[0xa0,0xa0,0xa0]`, destination/source offsets `[0,4,8]`, destination words all `0xa0a0a0a0` |
| `fixed_array_single_recursive` | fixed count 3; three callbacks in order `[0xf0,0xf0,0xf0]`, destination/source offsets `[0,4,8]`, first 12 destination bytes are `f0` and the final four remain `dd` |
| `map_single_noop` | destination bytes before and after are identical `00 01 02 03 04 05 06 07 08 09 0a 0b` |
| `struct_single_inheritance_filter` | direct property 1 then inherited property 3; shared `visitOrder=[1,3]`, destination/source offsets `[0,8]`, destination first 16 bytes `11 11 11 11 dd dd dd dd 33 33 33 33 dd dd dd dd` |

The oracle output was rerun after enabling the shared struct trace. The
translation comparison is intentionally narrow:

```sh
node scripts/validate-property-copy.mjs
```

It reports `Property copying matches 12 original Core.dll reference cases;
FArray allocation remains an explicit harness boundary.`
