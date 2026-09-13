# Complex UProperty::Identical virtuals

`src/runtime/script-property-identical.mjs` translates the five remaining
*complex* property `Identical` virtuals (vtable slot `+0x6c`) from the
installed Deus Ex GOTY `Core.dll`.  Together with the simple inline bodies in
`src/runtime/script-tagged-properties.mjs` (Byte/Int/Float/Bool/Name/Object/
Class) this completes the `Identical` set used by the collector branch of
`UStruct::SerializeTaggedProperties`, which previously failed on complex kinds
with "UProperty Identical (+0x6c) is unresolved".

All addresses are read directly from `.cache/research/Core.asm`; no public
engine source is the authority.

## Entry points

| Class | Body | Behavior |
| --- | --- | --- |
| `UStrProperty::Identical` | `0x101676f0` | Case-insensitive FString compare; empty/null default idioms |
| `UArrayProperty::Identical` | `0x10168480` | TArray count equality then element compare |
| `UFixedArrayProperty::Identical` | `0x10167d30` | Inner compare per `+0x60` count |
| `UMapProperty::Identical` | `0x10168d80` | Returns `1` unconditionally |
| `UStructProperty::Identical` | `0x101690d0` | Inner struct property-tree walk with the `+0x68` super |

The native signature is `int Identical(const void* A, const void* B)` where `A`
is the current value pointer and `B` the comparison default.  `B` may be null;
`A` is always dereferenced.  The tagged-property walker calls the virtual once
per element with `A` at the element and `B` at the default element (or null
when the default is out of range).

## UStrProperty::Identical — `0x101676f0`

```
B_text = B == null        ? literal@0x102a7fe8
       : B->ArrayMax[+4]==0 ? literal@0x101ef654        (empty)
       :                     B->Data[+0]
A_text = A->ArrayMax[+4]==0 ? literal@0x101ef654        (empty)
       :                      A->Data[+0]
return appStricmp(A_text, B_text) == 0
```

The two `+0x4` tests are the FString `ArrayMax` field; UE1 keeps `Data == null`
exactly when `ArrayMax == 0`, so a zero `+0x4` selects the empty string.
`appStricmp` is byte-wise ASCII case-insensitive, so `Identical('Hello',
'HELLO')` is true.

**Literal evidence:** both literal addresses sit in the zero-filled tail of
Core's packed `.data` section (beyond the file-backed bytes), so the installed
file image provides the empty string at each.  A Unicorn probe
(`scripts/native-property-identical-oracle.py`) confirms both read as zero
words and that the null-default branch compares the current string against the
empty string.  The packed runtime content is **unverified**; the module records
the two addresses and treats them as `''` per the file image.

## UArrayProperty::Identical — `0x10168480`

```
if (A != null ? A->ArrayNum[+4] : 0) != B->ArrayNum[+4]: return 0
inner = this->Inner[+0x5c]
for i in 0 .. count-1:
    A_elem = (A != null) ? A->Data[+0] + i*inner->ElementSize : (null path)
    B_elem = B->Data[+0] + i*inner->ElementSize
    if !inner->Identical(A_elem, B_elem): return 0
return 1
```

The native dereferences `B` unconditionally, so a null default is an explicit
error in the translation.  A null current value is an empty array (count `0`).

## UFixedArrayProperty::Identical — `0x10167d30`

```
count = this->ArrayCount[+0x60]
if count <= 0: return 1
inner = this->Inner[+0x5c]
for i in 0 .. count-1:
    A_elem = A + i*inner->ElementSize
    B_elem = (B != null) ? B + i*inner->ElementSize : null
    if !inner->Identical(A_elem, B_elem): return 0
return 1
```

A null default passes null element pointers to every inner compare, matching
the native `B != null ? B + i*size : null` branch.

## UMapProperty::Identical — `0x10168d80`

The body is `movl $1, %eax; retl $0x8`: always identical, no value reads.

## UStructProperty::Identical — `0x101690d0`

```
for each struct in inner Struct's inheritance chain (via GetInheritanceSuper,
    the vtable +0x68 slot; children at UStruct +0x38, Next at UField +0x2c):
    for each child that IsA(UProperty, class 0x102a7af0):
        for i in 0 .. child->ArrayDim[+0x34]-1:
            A_elem = A + child->Offset[+0x48] + i*child->ElementSize[+0x38]
            B_elem = (B != null) ? B + child->Offset + i*child->ElementSize : null
            if !child->Identical(A_elem, B_elem): return 0
return 1
```

A null default passes null element pointers to every child compare.  The
inheritance walk uses the same `+0x68` `GetInheritanceSuper` virtual the struct
linker and the tagged-property walker already rely on; the `UProperty` class
object is `0x102a7af0`.

## API and storage

```js
identicalScriptProperty(property, value, defaultValue, services)
identicalStr(value, defaultValue)
identicalMap()
identicalFixedArray(property, value, defaultValue, services)
identicalArray(property, value, defaultValue, services)
identicalStruct(property, value, defaultValue, services)
structProperties(structure, services)
```

The JavaScript values are the runtime's logical shapes: strings for Str,
arrays for Array/FixedArray, and objects keyed by member key for Struct.
`services` supplies `innerProperty`, `innerStruct`, `arrayDim`, `arrayCount`,
`structProperties`, `isUProperty`, `childrenOf`/`nextOf`/`inheritanceSuper`,
and `memberKey` overrides for hosts whose linked property/struct metadata uses
a different representation.  The default walks read the linked `metadata`
fields.  A reached non-complex kind (Int/Byte/...) is an explicit
`UnsupportedScriptPropertyIdenticalError`; the tagged-property walker's inline
simple bodies own those kinds.

## Tagged-property integration

`src/runtime/script-tagged-properties.mjs` `defaultComparison` now routes the
five complex kinds to `identicalScriptProperty` before its unresolved-`+0x6c`
failure.  Identical complex properties are therefore skipped without emitting a
tag, matching the native gate at `0x10126cd7`.  Non-identical complex
properties now reach the translated `+0x78` `SerializeItem` bodies for the
collector/measure path (Str/Array/FixedArray/Struct/Map/Bool); the FString and
dynamic-array loading/saving branches remain explicit Stage 3 work.

## Evidence and focused validation

`test/script-property-identical.test.mjs` covers the five bodies, the
dispatcher, and the tagged-property integration:

* Str case-insensitive equality, the empty and null-default literal branches,
  and the non-null current requirement;
* Map unconditional true;
* FixedArray per-element inner recursion, count zero, and null-default element
  passing;
* Array count equality, null-current-as-empty, native-shaped TArray records,
  and the null-default error;
* Struct member comparison, the `+0x68` inheritance walk, null-default passing,
  `ArrayDim > 1` members, first-mismatch stop, and the property-filtered
  walker order;
* dispatch rejection of non-complex kinds;
* a tagged-property integration run where an identical Str property is skipped
  without a tag.

`scripts/native-property-identical-oracle.py` executes the original
`UStrProperty::Identical` (`0x101676f0`) and `UMapProperty::Identical`
(`0x10168d80`) in the Unicorn x86 emulator against the hash-verified GOTY
`Core.dll`, bridging the `_wcsicmp` import with an ASCII case-insensitive
stub.  It produced the expected table (`hello/HELLO` identical,
`hello/world` different, empty/null-default cases) and confirmed both literal
addresses hold the empty string in the file image.

## Boundary

These five bodies complete the complex `Identical` set.  The collector/measure
`SerializeItem` bodies (`UStrProperty` `0x10167750`, `UArrayProperty`
`0x10168520`, `UMapProperty` `0x10168d90` which is an immediate `ret`, and
`UBoolProperty` `0x10166550`) are translated separately; their loading/saving
branches remain Stage 3 work. The recovered [copy](script-property-copy.md)
and [destruction](script-property-destroy.md) dispatchers now provide those
value virtuals, with class-default copying and logical object ExitProperties
integration. Native heap services and general VM temporary ownership remain
explicit dependencies.
