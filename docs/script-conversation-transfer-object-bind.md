# ConEventTransferObject actor binding

This note records the installed GOTY `ConEventTransferObject.BindActor` body
and its first shipped DataLink integration. It establishes actor/class binding;
the later inventory transfer in `ConPlayBase.SetupEventTransferObject` remains
separate.

The sources of truth are `ConSys.u` (SHA-256
`3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada`)
and `ConSys.dll` (SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`).
Class export 381 has TextBuffer export 304, `classFlags=0x112`, superclass
export 2, and the source declaration `class ConEventTransferObject extends
ConEvent native noexport`.

Its linked properties are exports 219–226 in this order: `ObjectName`,
`giveObject`, `transferCount`, `fromActor`, `fromName`, `toActor`, `toName`,
and `failLabel`. Native layout places them at `+0x40`, `+0x4c`, `+0x50`,
`+0x54`, `+0x58`, `+0x64`, `+0x68`, and `+0x74`; every `FString` occupies
12 bytes.

The exported vtable `??_7DConEventTransferObject@@6B@` is `0x10013ce8`.
Slot `+0x58` selects `BindActor` at `0x1000bc40`. The complete 352-byte body
ends at `0x1000bda0` and hashes to
`745003622d0c7e1be01dc8e92ade0d049678647351e0434b9f38331e131a3a23`.
The native signature is `BindActor(Actor firstActor, Actor candidateActor,
Conversation conversation)`, and the first actor is not read.

The recovered order is:

1. Call `CreatePackage(NULL, L"DeusEx")` before reading any actor name.
2. Compare candidate `BarkBindName` with event `fromName` using imported
   `appStricmp`. Accept this match only when `conversation.bFirstPerson`
   is mask 4 at `+0x50`. Otherwise reread `fromName`, compare candidate
   `BindName`, and write a match to `fromActor +0x54`.
3. Repeat the same bark/normal checks for `toName`, writing `toActor +0x64`.
4. Read `ObjectName`, call `StaticLoadObject(UClass::PrivateStaticClass,
   deusExPackage, ObjectName, NULL, 2, NULL)`, and write its result to
   `giveObject +0x4c`. This load occurs even if neither actor matched.
5. Return true if either actor field matched. A miss preserves both actor
   fields and returns false. The separate `ClearBindActors` body at
   `0x1000bda0` clears `fromActor`, `toActor`, and `giveObject`.

Zero-length native `FString` values use the mapped zero storage at
`0x1001e1cc`. The translation keeps logical empty strings and the established
ASCII/C-locale case-insensitive comparison. Package creation and class loading
are synchronous host services because the runtime still lacks the complete
native metaclass/null-export construction graph.

## Shipped DataLink references

`DeusExConText` contains exactly ten `bDataLinkCon` conversations with a
`ConEventTransferObject`:

| conversation | event export | object |
| --- | ---: | --- |
| `DL_Rooftops` | 7448 | `Image02_NYC_Warehouse` |
| `DL_LebedevKill` | 11949 | `Image03_NYC_Airfield` |
| `DL_Alleys` | 13046 | `Image02_NYC_Warehouse` |
| `DL_Choice` | 17094 | `Image05_NYC_MJ12Lab` |
| `DL_cathedralfirst` | 26028 | `Image11_Paris_CathedralEntrance` |
| `DL_intro_cathedral` | 26128 | `Image11_Paris_Cathedral` |
| `DL_no_carla` | 27730 | `Image12_Vandenberg_Command` |
| `DL_Downloaded` | 28411 | `Image14_Schematic` |
| `DL_Final_Morgan` | 29362 | `Image15_BlueFusionDevice` |
| `DL_tong1` | 29665 | `Image15_Area51Bunker` |

All ten transfer one image to `JCDenton` and have no fail label. The original
source explicitly permits an absent `fromActor` in InfoLinks because the remote
speaker may not be on the map.

The focused integration prepares canonical `DL_Rooftops` conversation export
1430, event export 7448, the player class, and the
`Image02_NYC_Warehouse` class. It routes the event through installed native
2053 `Conversation.BindActorEvents` and ScriptRuntime's exact event-class
dispatch. Candidate `JCDenton` leaves `fromActor` null, writes the player to
`toActor`, loads the canonical image class into `giveObject`, and produces the
native true result that `BindActorEvents` discards.

The next event action is not claimed yet. `SetupEventTransferObject` reaches
native `Spawn` for a new `DataVaultImage`, its actor constructor/startup,
`Inventory.SpawnCopy`, `DeusExPlayer.AddImage`, and the received-items window.
The current Spawn admission list has no source-backed `DataVaultImage` native
construction path, so the validator stops before that action rather than
substituting a fabricated inventory object.

Validation:

```text
node --test test/script-conversation-transfer-object.test.mjs
node scripts/validate-conversation-transfer-object-bind.mjs
```

The validator parses the installed package and PE export/import tables, pins
the body hash and decisive instruction ranges, verifies all ten authored
DataLink references, and executes the `DL_Rooftops` bind route through the
runtime.
