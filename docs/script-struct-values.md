# Loading authored script struct values

Source: installed GOTY Core.dll, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`,
and the installed v68/v69 packages. Original disassembly remains in the
ignored `.cache/research/Core.asm`.

## Contract established before implementation

`UStructProperty::SerializeItem` (`101691b0–101691d0`) preloads its linked
struct (`property+5c`) then calls that struct's SerializeBin virtual `+70`.
`UStruct::SerializeBin` (`10126610–10126713`) visits the original Children /
Next chain, then inheritance supers, in the same order already established
by [reference serialization](script-reference-serialization.md). This is a
flat stream of member values; it has no nested property tags or raw native
padding. Every field's ArrayDim is visited in ascending order.

Property flag `1000` skips the member. Flag `2000` skips only when the
archive's `+18` is nonzero. Skipped members retain the value already present
in the destination; struct deserialization does not zero the whole struct.
The scoped decoder requires an explicit persistence binding if a transient
member is reached; the selected original defaults below contain no such
branch. Unknown storage/serializer types remain unsupported.

The existing source-backed scalar serializers establish the element stream:
Byte is one byte, Int/Float four bytes, Name and Object/Class go through the
package linker's compact indices, and FString uses the versioned serialized
string already read by the package reader. Bool SerializeItem (`10166550`)
reads one byte through the archive and sets/clears the linked bit according
to whether that byte is nonzero (`10166575–1016658c`); logical values retain
the Boolean result. Native bit packing is separate from serialized width.
Nested structs recursively use the same SerializeBin contract.

The canonical field identity, not a short member name, addresses the loaded
value. Each Object/Class member resolves against the package containing the
value bytes, which can differ from the package declaring the inherited
property. Resolving it through ScriptObjects preserves the same UObject
identity as other class defaults, map fields, and bytecode operands.

## Original reference cases

The installed DeusEx package has 364 opaque type-10 defaults across 14
struct names. The current reader already handles Vector, Rotator, Color and
Scale separately; these 364 are the missing generic records.

- `ScriptedPawn.InitialInventory`: `InventoryItem` declares a Class reference
  then an Int Count. The original base entry is five bytes (null compact
  reference, then int32 1); subclass entries contain their original inventory
  class reference and count.
- `DeusExRootWindow.DataVaultFunctions[0]`: `S_DataVaultFunction` declares a
  String function followed by a Class reference. Its 23 bytes contain the
  string `ShowInventoryWindow` and the class index. All eight entries must
  retain their individual strings and canonical class identities.
- `MenuScreenCustomizeKeys.keyDisplayNames[0]`: `S_KeyDisplayItem` declares
  EInputKey (Byte), then localized String DisplayName. The 20-byte default
  contains key 1 and `Left Mouse Button`.
- `Greasel.InitialAlliances`: `InitialAllianceInfo` contains a Name, Float
  and Bool. This checks the one-byte bool width independently of its native
  DWORD packing. Entry zero names `Karkian`, with value 1 and the Boolean set.

Focused validation will compare these values to the installed embedded
source/defaults and check exact payload consumption. A pass over the 364
payloads checks the new loading boundary, not gameplay/UI execution. Map
overrides must use the map's package provenance and preserve defaults in
unwritten array indices. Full config/localization resources, native raw
layouts, dynamic arrays/maps and save serialization remain separate work.

## Verified integration

`node scripts/validate-script-struct-values.mjs` loads all 364 previously
opaque DeusEx class-default entries (14 struct names) through the runtime,
checking exact byte consumption and the reference cases above. Embedded
source establishes the declarations/member order; the serialized default
payloads supply the authored values (ScriptText does not include default
property assignments). It also verifies Training `UNATCOTroop2` inventory
class references using map import indices, the canonical Region.Zone actor,
and retention of an unwritten inherited array entry.

`node --test test/script-struct-values.test.mjs` checks nested dimensions,
value-package provenance, copied destination preservation for skipped fields,
explicit transient archive state, truncated/extra bytes, and unsupported
member storage. The existing live Frob validator passes with this loader.
