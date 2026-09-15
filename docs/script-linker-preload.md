# `ULinkerLoad::Preload` and export serialization

This note records the recovered linker-preload path — the routine that
serializes a constructed export's own bytes after
[`CreateExport`](script-create-export.md) leaves it `RF_NeedLoad` — and the
completion of the native class-registration registry that the preload closure
needs in order to bind every export the way the shipped game does.

It is slice 2 of the linker track named in
[the completion audit](stage-3-completion-audit.md): "recover
`ULinkerLoad::Preload` and serialize one constructed class export's own bytes."

## Authority

Installed GOTY `Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, image base
`0x10100000`. `ULinkerLoad::Preload` (thunk `0x101011cc`) has its body at
`0x10162000`; it is the head of the serialize tree, ~688 bytes and ~27 calls,
and reaches the per-kind serializers and linkers below.

| routine | body | role |
| --- | --- | --- |
| `ULinkerLoad::Preload` | `0x10162000` | drives the export's own serialization |
| `UField::Serialize` | `0x10125c70` | field-record read |
| `UStruct::Serialize` | `0x10126fe0` | struct/children read |
| `UStruct::SerializeTaggedProperties` | `0x10126730` | tagged-defaults loop (stream path) |
| `UClass::Serialize` | `0x101280d0` | class flags/config/dependencies |
| `FPropertyTag` stream read | `0x1012a840` | one tagged-property header |
| `FPropertyTag::SerializeTaggedProperty` | `0x1012aca0` | one property value into the defaults |
| `UStruct::Link` / `UClass::Link` | `0x10126060` / `0x10127e30` | offset/link ordering |

`src/runtime/script-linker-preload.mjs` owns the closure order and the
byte-consuming serialization; `src/runtime/script-property-serialize-item.mjs`
owns the per-property value read; the archive's raw 4-byte read and the
object/name references remain the host-archive boundary supplied by
`scripts/validate-linker-preload.mjs`, which reads the real package bytes.

## Validation — against the decoded package, not itself

`scripts/validate-linker-preload.mjs` runs the whole preload closure over the
`DeusEx.u` linker (1721 serialized / 39,414 constructed / 1494 class exports),
then verifies **one class — `DataVaultImage`** field-for-field against the
project's independently decoded package: children-chain length and each child's
name and class, the linked property order, per-property `ArrayDim`,
`ElementSize`, `PropertyFlags` and `Offset`, `PropertiesSize`, `ClassFlags`,
`ClassConfigName`, `FriendlyName`, `Line`/`TextPos`, the dependency count, and
every default tag's name/type/arrayIndex/value (including struct and array
recursion). It also asserts `Preload consumed exactly the export serial range`,
so the parse must walk the real bytes end-to-end.

The value path is genuinely exercised: the scalar reads come from the real
`DeusEx.u` bytes through `serializeRaw`, and the results are compared against
the decoded oracle — not pulled from it. Mutation checks that fail the
validator: corrupting the scalar value read (`value + 1`), reading an
`IntProperty`/`FloatProperty` as 2 bytes instead of 4, permuting a linked
property's order, and dropping a class from the native registry.

## Native class-registration registry

`CreateExport`/`Preload` reach `UClass::Bind` (`0x10127a20`), which for an
`RF_Native` class looks its name up in the outer package's autoclass registry
and copies the record's `+0x4e0` `ClassConstructor`. Missing record →
`GWarn('Can't bind to native class %s')` then superclass inherit. The shipped
game logs **zero** such warnings (see
[`original-startup-log.md`](original-startup-log.md)), so every `RF_Native`
class the closure binds must resolve.

`src/runtime/script-native-class-registry.mjs` previously covered only Core,
Engine and DeusEx, leaving 81 classes across Extension, ConSys, Fire, IpDrv,
DeusEx, DeusExText, Core and Engine unresolved. `tools/class-registration-scan.py`
decodes each DLL's registration bodies (`static, internalCtor` per class); it
was cross-checked against the hand-recovered Engine table (Actor, Inventory,
Pawn, PlayerPawn, Texture match exactly). 78 of the 81 resolve to a concrete
`InternalConstructor`; the tables now carry them, keyed by the outer package
name the autoclass lookup uses.

### The three inherited-constructor classes

`Engine.Player`, `Fire.FractalTexture` and `Fire.WaterTexture` have an
autoclass record but **no distinct C++ constructor**: their DLLs emit no own
`InternalConstructor` thunk (Fire ships four thunks for its six textures;
`Player`'s registration threads no immediate). For such a class, `UClass::Bind`
copies a record whose `+0x4e0` is the superclass's constructor — identical to
the fall-through path `Super->Bind(); this->ClassConstructor =
Super->ClassConstructor`. The registry marks these `dynamicConstructor: true`
and `bindScriptClassConstructor` inherits the super constructor for them
without warning. This is **bit-for-bit what the original `Bind` produces**, not
an approximation — the class has no other constructor to differ from, and the
zero-warning startup confirms the record exists.

## Unverified scope

- **One class is verified end-to-end.** `DataVaultImage`'s serialization is
  proven field-for-field; the other 1493 class exports are constructed and
  bound by the closure but not individually asserted against the package.
  Widening to a second class (e.g. one with an owning string/array default) is
  the next step.
- **No default with a nonzero `arrayIndex` or an array-property tag** is
  exercised by `DataVaultImage`, so the `FPropertyTag` arrayIndex varint decode
  and the array-placement offset are read off the encodings but not
  test-distinguished.
- **No unknown/mismatched-property default** is exercised, so `tag.size`
  (used only to skip an unknown property) is likewise unverified.
- The 78 scan-recovered `InternalConstructor` addresses are verified by the
  scan's cross-check against the hand-recovered tables and by the zero-warning
  bind, but their individual values are not independently asserted by this
  validator (only `DataVaultImage`/`Inventory`/`PlayerPawn` are).
- `SerializeTaggedProperties`' non-stream second phase (`0x10126c07`) is not
  translated; only the linker-stream path runs.
