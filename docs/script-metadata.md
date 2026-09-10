# Original script metadata

`src/unreal/script-metadata.mjs` reads the serialized `UField`, `UStruct`,
`UFunction`, `UState`, `UProperty`, and `UClass` headers used by the Deus Ex
GOTY packages. It does not execute a script and does not depend on the script
VM. Pass the same asset shape used by the package readers:

```js
const metadata = readScriptMetadata(asset, exportIndex);
```

`readFunctionMetadata`, `readStateMetadata`, `readPropertyMetadata`, and
`readClassMetadata` are also exported. A function or state includes its linked
`children` chain. Function children expose `parameters` (properties carrying
`CPF_Parm`) and each property exposes `nextRef`, so a linker can retain the
original field identity rather than looking up a short name. Property type
references are kept as both `...Ref` indices and small `{index, name, path,
className}` views.

The script header exposes both sizes:

```js
{
  scriptSize: 319,                 // expanded UStruct size from Core.dll
  serializedScriptSize: 253,       // physical package bytes consumed
  scriptBytes: Uint8Array,         // physical bytes for decodeScript
  script: { expandedSize: 319, size: 319, start: 21, end: 274, ... }
}
```

`script.start` and `script.end` are offsets within the serialized export
payload. Compact object/name references in the physical stream count as four
bytes in `scriptSize`; the bytecode decoder owns expanded offset maps and label
records.

The original evidence is local `Core.dll` from the GOTY installation. The
relevant serializer bodies are:

| serializer | body | fields established |
| --- | ---: | --- |
| `UField::Serialize` | `0x10125c70` | `SuperField`, then linked `Next` object refs |
| `UStruct::Serialize` | `0x10126fe0` | script text/children refs, name/line/text position, expanded script stream |
| `UState::Serialize` | `0x10127590` | two probe-mask words, two ignore-mask words, label-table `u16`, state flags `u32` |
| `UFunction::Serialize` | `0x10129010` | v68/v69 native index `u16`, operator precedence `u8`, function flags `u32`, optional replication offset `u16` |
| `UProperty::Serialize` | `0x10165020` | array dimension `u32`, property flags `u32`, category `FName`, optional replication offset `u16` |

Those bodies call the archive virtual slots that read compact object/name
indices. The UProperty type serializers then append these original fields:
`ObjectProperty` class, `ClassProperty` class plus meta-class,
`StructProperty` struct, `ArrayProperty` inner, `MapProperty` key/value,
`FixedArrayProperty` inner plus count, and `ByteProperty` enum. Primitive,
name, string, and bool properties append no package field in the linker load
stream. Core.dll's bool serializer has a separate bit-mask branch for an
archive that is neither loading nor saving; the package linker takes the load
branch, so `bitMask` is explicitly `null` rather than guessed.

The type-specific Core.dll bodies used for that inventory are
`UByteProperty::Serialize 0x10165890`, `UBoolProperty::Serialize 0x10166160`,
`UObjectProperty::Serialize 0x10166bf0`, `UClassProperty::Serialize
0x10167050`, `UStrProperty::Serialize 0x10167770`, `UFixedArrayProperty::Serialize
0x10167df0`, `UArrayProperty::Serialize 0x101685d0`, `UMapProperty::Serialize
0x10168db0`, and `UStructProperty::Serialize 0x101695c0`. No type-specific
serializer override was present for the integer, float, or name properties in
the original export table; they inherit `UProperty::Serialize`.

For v68/v69, the first function tail word is serialized for every function and
is meaningful as `NativeIndex` only when `FUNC_Native` (`0x400`) is set. The
optional word after `FunctionFlags` is `RepOffset` when `FUNC_Net` (`0x40`) is
set. These meanings match the conditional and member offsets in the original
`UFunction::Serialize`; `FUNCTION_FLAGS` exports both bits. `PROPERTY_FLAGS`
exports the bits needed to classify
parameters (`Parm`, `OutParm`, `ReturnParm`, `OptionalParm`, `CoerceParm`),
network replication (`Net`), and skipped parameters. `primitiveDefault`
returns only zero values for primitive VM local slots (`false`, numeric zero,
`None`, empty string, or null object); authored class defaults remain in the
tagged UClass default stream handled by `classes.mjs`.

The reader currently accepts only package versions 68 and 69. Core.dll has
legacy UFunction/UProperty branches for versions at or below 63 (extra old
operator/replication fields); those layouts have not been asserted against
the original package linker and are rejected with
`UnsupportedScriptMetadataError`. Unknown UProperty subclasses retain their
base fields and unconsumed bytes with an explicit `unsupported` string.
Cross-package linked child refs also remain explicit unsupported records until
an AssetStore-aware metadata linker is required.

Reference reads from the installed `Engine.u` (version 68):

```js
readFunctionMetadata(engine, 3093) // PlayerPawn.CheckBob
// scriptSize 319, serializedScriptSize 253, flags 0x2,
// nativeIndexRaw/nativeIndex 0, nativeIndexIfNative null, replicationOffset null
// children: DeltaTime(float, Parm), Speed2D(float, Parm),
//           Y(struct, Parm), OldBobTime(float, local)

readStateMetadata(engine, 3057) // Mover.TriggerToggle
// scriptSize 128, probeMask [0x40, 0], ignoreMask [0xffffffff, 0xffffffff],
// labelTableOffset 104, stateFlags 1

readPropertyMetadata(engine, 8) // Actor.Location
// type struct, arrayDim 1, category Movement, repOffset 208,
// structRef -7 (the package's imported Vector struct)

readClassMetadata(engine, 2) // Actor
// kind class, 132 linked children (functions and properties)
```

These outputs are package metadata observations, not claims that every native
property-link/default/value branch is implemented. `elementSize`, authored
defaults, bool bit masks, and older-version layouts remain explicit future
work.

## Common UField links

`readFieldLinks(asset, index)` reads only the common `UField` prefix and returns
`{ baseRef, nextRef }`. It is intended for walking a class's `childrenRef`
chain in the serialized `Next` order without decoding each child payload:

```js
readFieldLinks(engine, 3100)
// { baseRef: 0, nextRef: 3092 } // Mover.StandOpenTimed
```

The original `UField::Serialize` body at `0x10125c70` calls
`UObject::Serialize`, then archives the object references at `this+0x28`
(`SuperField`, returned as `baseRef`) and `this+0x2c` (`Next`, returned as
`nextRef`). The package linker stores each as a signed compact object index;
the helper validates positive export and negative import references through
`objectAt`, and preserves `0` as null.

The serialized prefix has one established version-dependent framing rule in
the GOTY packages. `Class` exports begin directly with the two object refs;
`Function`, `State`, `Property` subclasses, `Enum`, `Struct`, and `Const`
exports begin with a compact name ref that must resolve to the literal `None`,
followed by the same two object refs. Other export classes are rejected with
`UnsupportedScriptMetadataError`. Package versions outside v68/v69, malformed
or out-of-range exports, a bad `None` marker, invalid object references, and an
unexpected `0x02000000` serialized state-frame flag are rejected rather than
being interpreted as links. No child payload is consumed by this helper.
`UConst::Serialize` at `0x10129680` calls the common `UField::Serialize` body
at `0x10125c70` and then archives its value string at `this+0x34`, establishing
that `Const` exports retain this same prefix before their type-specific tail.

A focused walk of the installed `Engine.u` (v68) confirms the chain on
`Engine.Mover` (class export `37`): `childrenRef` is `3100`, and following
`nextRef` visits 87 linked fields. Seven are direct states, in original link
order: `StandOpenTimed`, `BumpButton`, `BumpOpenTimed`, `TriggerPound`,
`TriggerControl`, `TriggerToggle`, and `TriggerOpenTimed`. The count includes
functions, properties, and enums in the same UField chain.
