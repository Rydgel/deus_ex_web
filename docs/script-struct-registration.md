# UField and UStruct registration

This note records the narrow registration prefix reached by UClass.Register in
the installed Deus Ex GOTY `Core.dll`.  The binary is the authority; public
engine source is terminology only.

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
UField::Register      0x1010183e -> 0x10125dd0
UStruct::Register     0x10103076 -> 0x10125fe0
UObject::Register     0x101020ae -> 0x10152550
ConditionalRegister   0x101022ac -> 0x1014fea0
```

The disassembly is `.cache/reference/Core-rng.asm`: UField.Register is at
lines 85769–85795 and UStruct.Register at lines 85964–85988.  The common
UField/UStruct offsets used by these bodies are:

| offset | field | reached behavior |
| ---: | --- | --- |
| `+0x20` | UObject Name | resolved by UObject.Register; source for FriendlyName |
| `+0x28` | UField BaseField / UStruct Super | tested after base registration; conditionally registered when non-null |
| `+0x2c` | UField Next | not changed by either Register body |
| `+0x38` | UStruct Children | not changed by either Register body |
| `+0x40` | UStruct FriendlyName | assigned from `+0x20` after UField.Register returns |

## Exact call and mutation order

`registerScriptField(record, { registration, ... })` in
`src/runtime/script-struct-registration.mjs` replays the UField prefix.  The
`registerScriptStruct`/`registerUStruct` entry point runs that prefix and then
the UStruct FriendlyName step.  The reached operations are:

1. `registration.registerUObject(record)` (or its `register` alias) performs
   the already traced UObject identity path: package/name resolution, object
   array insertion and hash linking.
2. UField.Register reads `record+0x28`.  For a non-null value,
   `registration.conditionalRegister(baseField)` is called.  The shared host
   owns the original unregistered-index and temporary-registrant checks and
   dispatches virtual `+0x4c`; no second UObject.Register call is made here.
   A `registrants` option is passed as the host's second argument when the
   caller has one.  When `+0x28` is null, this conditional call is not reached
   and its adapter is not required.
3. Only UStruct.Register reads the resolved FName at `record+0x20` and writes
   the same value to `record+0x40` (`FriendlyName`).  `registerScriptField`
   stops after step 2, leaving its `+0x40` field (Category for UProperty)
   untouched.  For an offset `nativeSlots` Map, the struct entry exposes a
   live `record.friendlyName` accessor backed by the four-byte `+0x40` holder;
   it does not create a copied second value.

The returned value is:

```text
{
  record,
  baseResult,       // result from shared UObject.Register host
  baseField,        // the value observed at +0x28, or null
  friendlyName,     // exact value copied from +0x20
  operations        // source-ordered trace
}
```

The field-only return has the same `record`, `baseResult`, `baseField` and
`operations` members and omits `friendlyName`.

The trace records `uobject-register`, an optional
`conditional-register-base-field`, and `friendly-name`, including the native
body and field offsets.  The `writeSlot`/`writeNativeSlot` option can observe
the exact FriendlyName write with `(record, 0x40, value, 4, detail)`; a raw
`nativeSlots` Map is updated directly when that callback is absent.

For a UClass record, `+0x28` is the UClass Super pointer, so this same body
conditionally registers the Super before UStruct copies FriendlyName.  For a
UField-derived property, the slot is BaseField.  The offset is shared by the
native layouts; the caller's record kind determines the semantic label.

## Boundaries and unsupported work

The shared `registration.registerUObject` and conditional host are mandatory
when their native calls are reached.  This module does not replace the
UObject.Register implementation, invent object identities, or fabricate a
registrant list.  It does not execute the virtual `+0x4c` target; the shared
ConditionalRegister host must dispatch that target.  For a UClass target that
dispatch continues into `script-class-registration.mjs` and its explicit
post-registration adapters.

The body does not call Bind, Link, PostLoad, Serialize, class default
initialization, config or localization.  It does not mutate BaseField, Next,
Children or Super; only the observed FriendlyName `+0x40` assignment is made.
The contract is verified only for this hash-matched GOTY Core.dll and does not
claim another engine binary or an untraced native registration version.
