# `ConEventCheckObject.BindActor`

This note records the installed `ConSys.ConEventCheckObject` native binder and
the exact runtime boundary used by the browser translation. The sources of
truth are `System/ConSys.u` (SHA-256
`3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada`) and
`System/ConSys.dll` (SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`).
Original assets and binaries remain outside Git.

## Original class and dispatch

`ConSys.u` export 365 is `ConEventCheckObject`, derived from `ConEvent`. Its
TextBuffer is export 319 and declares these fields in order:

```text
var String objectName;
var Class<Inventory> checkObject;
var String failLabel;
```

The installed exported vtable `??_7DConEventCheckObject@@6B@` is at
`0x1001393c`. Slot `+0x58`, the `BindActor` virtual, points to
`0x10007bf0`. The complete 272-byte body occupies
`0x10007bf0..0x10007cff` and has SHA-256
`4f92787311435bab6cf8126bbf6b1b15bae313c40e579064ea6bbf5d45a95a1a`.

The body uses native offsets `objectName +0x40` and `checkObject +0x4c`.
It performs these operations in order:

1. Call `FString::Left(objectName, 3)`.
2. Compare that temporary with UTF-16 literal `NK_` through imported
   `appStricmp`.
3. When they compare equal, write null to `checkObject` and return false.
4. Otherwise call `CreatePackage(NULL, L"DeusEx")`.
5. Call `StaticLoadObject(UClass::PrivateStaticClass, package, objectName,
   NULL, 2, NULL)`.
6. Store the returned pointer in `checkObject` and return false.

The native temporary `FString` is constructed and destroyed before the branch.
It never escapes. The logical translation preserves its text and comparison
semantics; raw heap allocation for that temporary remains part of the broader
native heap boundary.

This method only resolves the authored object name to an Inventory class. The
later Inventory and NanoKey checks belong to the installed UnrealScript
`ConPlayBase.SetupEventCheckObject`, rather than this native body.

## Authored lifecycle reference

`DeusExConText` Conversation export 5 is `MeetKaplan`. It has
`bDataLinkCon=false`; this is an authored generic-conversation reference case,
not a claim that a shipped DataLink uses CheckObject. Its authored
`ConEventCheckObject6` is export 2555 with `EventType=ET_CheckObject`,
`objectName="WeaponRifle"`, `failLabel="NoRifle"`, and `nextEvent` export
2556. The validator first runs the recovered native binder to assign the
canonical `DeusEx.WeaponRifle` class, then uses that original event data to
execute the installed package bytecode for:

```text
DataLinkPlay.PlayEvent.SetupEvent
  -> ConPlayBase.SetupEventCheckObject
  -> Pawn.FindInventoryType
  -> DataLinkPlay.ProcessAction
```

With a WeaponRifle in the player's authored Inventory chain,
`FindInventoryType` returns that same object, SetupEvent emits
`EA_NextEvent, ""`, and the original ProcessAction stores export 2555 as
`lastEvent` and advances `currentEvent` to export 2556. With an empty Inventory
chain, the same installed setup bytecode emits
`EA_JumpToLabel, "NoRifle"`; the installed ProcessAction stores export 2555 as
`lastEvent`, runs `Conversation.GetEventFromLabel`, and selects the authored
`NoRifle` event at export 2559.

A second authored generic-conversation reference covers the NanoKey branch:
`ChadThankful` export 15 has `bDataLinkCon=false` and reaches
`ConEventCheckObject35` export 21066 with
`objectName="NK_Catacombs_Blastdoor02"` and `failLabel="NeedKey"`. The native
binder clears `checkObject`; installed SetupEvent then runs the recovered Core
native 234 `Right`, Extension `StringToName`, and the installed
`NanoKeyRing.HasKey`/`GetPlayer` bytecode over the player's `KeyList`. A matching
`NanoKeyInfo.KeyID` emits `EA_NextEvent, ""` and ProcessAction advances to
export 21067. An empty key list emits `EA_JumpToLabel, "NeedKey"`; installed
GetEventFromLabel selects the authored target at export 21101.

## Runtime boundary

[`script-conversation-check-object-bind.mjs`](../src/runtime/script-conversation-check-object-bind.mjs)
accepts only the exact `ConSys.ConEventCheckObject` class key. It obtains
`objectName` and writes `checkObject` through the runtime's named-property
references. The `NK_` branch needs no loader service. The regular branch
requires synchronous services for the canonical `UClass::PrivateStaticClass`,
`CreatePackage`, and `StaticLoadObject` identities and calls them with the
native argument graph above. A null `StaticLoadObject` result is stored as
null, as in the original body.

`ScriptRuntime` exposes those services at
`conversationLifecycle.checkObject`. A reached regular CheckObject event fails
explicitly if the canonical class/package loader graph has not been supplied;
the runtime does not invent an Inventory class. The returned false value is
passed back to `Conversation.BindEvents`/`BindActorEvents`, whose original
native bodies already ignore or consume it according to their recovered call
sites.

## Validation

Run:

```text
node --test test/script-conversation-check-object.test.mjs
node scripts/validate-conversation-check-object-bind.mjs
```

The validator reads the installed package declaration, parses the PE export
and import tables, checks the vtable slot, hashes the complete native body,
checks its field/literal/call/store/return instructions, and exercises the
translated case-insensitive `NK_` and regular class-load branches. It also
executes the authored MeetKaplan regular Inventory predicate through the
installed SetupEvent bytecode and applies the successful `EA_NextEvent` through
installed ProcessAction. The ChadThankful NanoKey predicate also executes the
installed Right/StringToName/HasKey path for matching and empty key lists. Both
fail results run through installed GetEventFromLabel and select their authored
target exports. Native metaclass class load, a shipped DataLink CheckObject
reference, and general CheckObject routes remain unverified.
