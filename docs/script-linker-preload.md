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
`src/runtime/script-load-graph.mjs`. The validator and Play's class loader now
share this graph and read real package bytes through the same archive.

## Validation — against the decoded package, not itself

`scripts/validate-linker-preload.mjs` runs the preload closure over the
`DeusEx.u` linker (9,316 serialized / 10,111 constructed, plus 53 static
re-initializations / 412 class exports once the set below is loaded), then
verifies a curated set of class exports
field-for-field against the project's independently decoded package through
one per-class comparator (`verifyClassExport`): children-chain length and each
child's name and class, per-property `ArrayDim`, `PropertyFlags` and linked
`Offset` (offsets strictly increase in link order except where
`UBoolProperty::Link` packs consecutive bools into one dword), `ClassFlags`,
`ClassConfigName`, `FriendlyName`, `Line`/`TextPos`, the dependency count, the
`UStruct::Link` operation order, the `+0x60` chain, and every default tag's
name/type/arrayIndex, its destination (`Offset + ElementSize × arrayIndex`) and
its value. The `PreloadTellExit` record must show the export serial range
consumed exactly, so the parse walks the real bytes end-to-end. `DataVaultImage`
additionally keeps its recorded-layout checks (`INVENTORY_CONSTRUCTION`
property order/kinds/`ElementSize`, `PropertiesSize`, the `Engine.Inventory`
import path and inherited `InternalConstructor`).

Tag values are compared by kind: Byte/Int/Str `deepEqual`; Float within 1e-6;
Bool from the tag's `0x80` bit; Name through the process-wide FName text;
object/class references by resolved full name against the export/import path.
Struct payloads the package oracle decodes (`Vector`, `Rotator`, `Color`) are
compared memberwise positionally; for the DeusEx-declared structs the oracle
does not decode (`InventoryItem`, `S_KeyDisplayItem`, `S_ActionButtonDefault`,
…) the comparator reads the raw tag payload memberwise in `SerializeBin`
order using the decoded package's own struct member table
(`readStructMetadata`) and the oracle's primitive readers, and asserts the
payload is consumed exactly. Struct members of kind Bool/Struct/Array/
FixedArray/Map or with `ArrayDim > 1` are not decoded by the comparator; such
a tag is recorded and the validator fails — none occurs in the set.

### Shipped default-tag shapes (census)

The validator also censuses every serialized `DeusEx.u` class through the
decoded oracle and asserts the package facts: 1158 classes, 13,865 default
tags, types `{Byte 523, Int 1375, Bool 1075, Float 2895, Object 4192, Name 91,
Struct 1483, Str 2231}`, 464 classes with an `arrayIndex > 0` tag, largest
index 70 (`MenuScreenCustomizeKeys`). **No shipped class default is an
`ArrayProperty` tag (type 9) or a type-8 tag**, in `DeusEx.u` or in Core,
Engine, Extension, ConSys, IpDrv, Fire or DeusExText (scanned once; only the
`DeusEx.u` totals are asserted). Class references (`CarcassType`, `AmmoNames`,
`ExplosionDecal`, …) ship as **type 5** on a `UClassProperty` — see the GetID
note below.

### The curated set and why each class is in it

| class | shapes it covers |
| --- | --- |
| `DataVaultImage` | the original slice: Int, Bool, Float, Object, Str, `Color` struct; inherited `Engine.Inventory` properties through an import |
| `DeusExWeapon` | Byte defaults (`ReloadCount`, …), 38 Str, Int/Bool/Float/Object; 257 own children, ~40 consecutive packed bools; `Engine.Weapon` super |
| `WeaponAssaultGun` | `Vector` struct (`FireOffset`); **class reference at `arrayIndex 1–2`** (`AmmoNames[n]`, a `UClassProperty`); a superclass (`DeusExWeapon`) already preloaded by the set |
| `DeusExPlayer` | 10 Name defaults incl. `AugPrefs[0..8]` (NameProperty at `arrayIndex > 0`, stride 4), `Rotator`, Byte/Bool/Int/Float/Str, class reference (`PlayerReplicationInfoClass`); largest export (17,523 bytes); super chain through a third package (`Extension.PlayerPawnExt`) |
| `Gray` | `InventoryItem` struct = class reference + Int nested in a struct, at `arrayIndex 0–2` (stride 8) — the undecoded-struct memberwise path; `CarcassType` class reference; 10 Byte tags; Name |
| `Rocket` | Engine-declared `UClassProperty` default (`Projectile.ExplosionDecal`) resolving to a DeusEx export; `Rotator`; Name; Byte |
| `MenuScreenCustomizeKeys` | largest defaults block (212 tags, 195 at `arrayIndex > 0`, up to 70 — the maximum shipped); `S_KeyDisplayItem` (Byte+Str) ×71 and `S_ActionButtonDefault` (Byte,Byte,Str,Str,Object) — structs with string members at array indices; Str at `arrayIndex > 0` |

### Mutation checks

Each of these, applied temporarily, fails the validator (first failing
assertion in parentheses): forcing `tag.arrayIndex = 0` in the tag read
(`WeaponAssaultGun AmmoNames`: `Ammo20mm !== Ammo762mm` — the clobbered index-0
cell); dropping the `ElementSize × arrayIndex` placement term (same failure);
reverting the `UClassProperty` GetID to 8 (`WeaponAssaultGun applied 57 tags`:
`52 !== 57`); Int read `+1` (`DataVaultImage SizeX 401 !== 400`, and with that
class disabled `Gray InitialInventory[0] member Count 2 !== 1` — the struct
member path bites); Str read dropping the last character (`DataVaultImage
PickupMessage`); Byte read `+1` (`DataVaultImage colNoteTextNormal member R`);
Name read `index + 1` (`DeusExPlayer AugPrefs`: `AlarmLight !== AugVision`).
The earlier checks (2-byte Int/Float read, permuted link order, a class dropped
from the native registry) still fail it.

### `UProperty::GetID` is virtual — `UClassProperty` returns 5

`SerializeTaggedProperties` compares the tag type nibble with the property's
`+0x9c` GetID slot, called virtually (`call dword ptr [eax+0x9c]` at
`0x1012690a`, and at `0x1012682d` for the type-7 string check). Every property
vtable's slot reaches the shared body `0x101655f0` (`mov eax,[ecx+0x24]; mov
al,[eax+0x20]; ret` — the property class's FName low byte) **except
`UClassProperty`** (vtable `0x10175ec4`): its slot is thunk `0x10102ac2` →
`0x10113e20` = `mov al, 5; ret`. So a class-reference default is written and
accepted as type 5. The serializer previously inlined the shared body for every
kind, computed 8, and took the `Type mismatch in %s of %s` warn-and-skip path
for every shipped class-reference default (e.g. `Rat.CarcassType`,
`Rocket.ExplosionDecal`) — a warning the measured original startup log
([`original-startup-log.md`](original-startup-log.md)) never contains.
`serializeTaggedPropertiesLoad` now models the dispatch
(`ClassProperty → 5`, otherwise the name low byte), and the validator asserts
that no tag anywhere in the closure took any warn-and-skip path
(`TagUnmatched`/`TagTypeMismatch`/`TagArrayIndex`/`TagStructMismatch`/
`TagNotSerializable`).

### The two edge paths

- **`FPropertyTag` arrayIndex decode and array placement — exercised.** 3368
  shipped tags carry `arrayIndex > 0`; the set verifies Name (stride 4), Str
  (stride 12), class-reference (stride 4) and struct (stride 8 and 32)
  elements at indices 1–70 against the oracle, and the placement assertion
  ties each destination to `Offset + ElementSize × arrayIndex`. Only the
  single-byte index encoding is exercisable: the largest shipped index is 70,
  so the `0x80`-prefixed word and `0xc0`-prefixed dword forms are read off the
  encoding but **unexercisable with shipped data**.
- **`tag.size` skip-unknown-property — unexercisable with shipped data.** The
  size is consumed only by the warn-and-skip paths, which fire when a
  serialized default names a property the class no longer has (or the wrong
  type/index/struct). A self-consistent shipped package contains none: the
  closure asserts zero such events. This path is a save-game/version-skew
  concern for Stage 6, not a hole in the preload slice.

## Import verification and lazy export creation

The harness now uses the recovered `Verify`, `VerifyImport`, `IndexToObject`
and `CreateImport` bodies, including the native export-hash construction and
registered-object admission flags. See
[`script-linker-imports.md`](script-linker-imports.md) for the original contract
and 30 DLL comparisons. Assertions establish that verification constructs no
exports, including `Engine.Inventory`, and that its first reference creates it
through the selected Engine export before DataVaultImage's super preload.

The previous host path search and fixture-wide eager export construction are
removed. Its 39,414 constructed objects were preparation breadth, not original
`Verify` behavior; the smaller closure above contains the actual dependencies
of the selected loads. File discovery and native service adapters remain local
graph boundaries. Play now consumes it for class loading and serialized defaults
through `ScriptClassLoader`; general native resource serialization and post-load
ownership remain incomplete. See [`script-load-graph.md`](script-load-graph.md).

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

- **Seven classes are verified end-to-end**, chosen to cover every default-tag
  shape the shipped packages contain (census above). The remaining class
  exports run the same serialization path — the closure asserts zero native
  asserts, zero real warnings and zero tag skips for all of them — but are not
  individually value-asserted against the package.
- **`ArrayProperty` (type 9) defaults, type-8 tags, and the multi-byte
  arrayIndex encodings** do not occur in any shipped package, so those branches
  of the tag reader and `serializeArrayItem` remain read off the encoding only.
- **Struct members of kind Bool** are outside this seven-class comparator.
  The separate `validate-class-loader-struct-bools.mjs` now compares the two
  authored `Karkian`/`Greasel` InitialAlliances tags, including
  `InitialAllianceInfo.bPermanent`, with the original member byte streams.
  See [the VM bridge evidence](script-load-graph.md).
- The comparator's placement check uses the linked `ElementSize` the runtime
  itself produced; `ElementSize` is independently asserted only for
  `DataVaultImage` (recorded layout).
- The 78 scan-recovered `InternalConstructor` addresses are verified by the
  scan's cross-check against the hand-recovered tables and by the zero-warning
  bind, but their individual values are not independently asserted by this
  validator (only `DataVaultImage`/`Inventory`/`PlayerPawn` are).
- `SerializeTaggedProperties`' non-stream second phase (`0x10126c07`) is not
  translated; only the linker-stream path runs.
