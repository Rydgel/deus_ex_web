# Loaded script struct layouts

This integration uses the installed Core.dll instructions already recovered in
[UStruct::Link](script-struct-link.md), [scalar property Link](script-scalar-property-link.md),
[BoolProperty::Link](script-bool-property-link.md), and
[complex property Link](script-complex-property-link.md). It supplies their
native slot boundary from original package UField metadata; it does not assign
guessed strides to generic VM struct values.

For a serialized `Struct` export, `Children`/`Next` establishes direct field
order and `SuperStruct` establishes inheritance. `UStruct::Link` at
`10126060` with its nonzero layout argument starts with the aligned superclass
size, calls each direct property's own Link, advances the running size to
`Offset + ElementSize * ArrayDim`, and aligns the final size to four. A struct
uses vtable `10175698`: GetInheritanceSuper returns +28, GetPropertiesSize
returns +3c, and MergeBools returns one. The previously recovered property
constructors establish the property vtables used to dispatch these calls.

Nested structs must finish linking before `UStructProperty::Link` at
`10168ff0` reads their size at +3c and destroy-chain head at +68. Strings take
12 bytes, objects/classes/names/numbers four, bytes one; consecutive bools
share a four-byte slot as determined by the original BoolProperty Link.
Computed NeedCtorLink flags propagate from nested strings/structs. The native
layout is distinct from the VM's keyed logical storage: a native packed bool
mask must not be attached to a separately stored JavaScript boolean.

Original reference cases come from installed DeusEx.u field declarations and
linked Children order. InventoryItem has class Inventory at offset 0 and int
Count at 4, yielding stride 8. S_DataVaultFunction has FString function at 0
and class winClass at 12, yielding stride 16. S_KeyDisplayItem has byte inputKey
at 0 and FString DisplayName at 4, yielding stride 16. InitialAllianceInfo
has name AllianceName at 0, float AllianceLevel at 4 and bool bPermanent at 8,
yielding stride 12. Core.Object.Color has four sequential bytes (stride 4).
These expected layouts follow the original native instructions and original
schema, independently of the serialized value payload's byte count.

The bridge supports the scalar, string, bool and recursively linked struct
members used by this loaded subset. Dynamic containers, native UClass layout,
replication conditions on struct members, malformed foreign-Outer children,
and by-value cycles remain explicit errors. Archive Preload is represented by
checking that the async package/metadata loading phase has already finished
for every object reached by the synchronous linker. No native allocation,
registration order, or full resource lifecycle is claimed by these layouts.
