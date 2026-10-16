# Original `DL_Rooftops` DataVaultImage transfer route

This note records the recovered end-to-end route for the one admitted DataLink
`ConEventTransferObject` delivery: `DeusExConText` conversation export 1430
(`DL_Rooftops`), whose `ConEventTransferObject` export 7448 hands
`DeusEx.Image02_NYC_Warehouse` to `JCDenton`. Export numbers here are the
1-based package object references `AssetStore.exportsByPath` returns. It follows the installed
`ConEventTransferObject::BindActor` result through
`ConPlayBase.SetupEventTransferObject`, the `ULevel::SpawnActor`
construction/startup of the shipped image class, `Inventory.SpawnCopy`/`GiveTo`,
`DeusExPlayer.AddImage`, and the received-items host boundary. The script
sources of truth are `.cache/reference/ConPlayBase.uc`, `Inventory.uc`,
`Pawn.uc`, `DeusExPlayer.uc`, `GameInfo.uc`, `HUDReceivedDisplay.uc`, and
`DataLinkPlay.uc`; the native authority is local GOTY `Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`) and `DeusEx.u` (SHA-256
`257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480`). The other
shipped DataLink image transfers share this authored shape and are now admitted
by the same route: spawn admission is the linked
`DataVaultImage -> Engine.Inventory` ancestry
(`inventoryImageChain`, `src/runtime/script-spawn.mjs`) and each class is
constructed through the recovered metaclass branch of
[`ULinkerLoad::CreateExport`](script-create-export.md), so no class name appears
in the runtime. Multiplayer respawn, stack/ammo/weapon sibling branches, and the
third-person conversation window remain outside the accepted path.

## Original route

1. **Actor/class bind.** Native 2053 `Conversation.BindActorEvents` reaches the
   installed `ConEventTransferObject::BindActor` body (ConSys.dll `0x1000bc40`;
   [script-conversation-transfer-object-bind.md](script-conversation-transfer-object-bind.md)).
   The authored event fields are `ObjectName 'Image02_NYC_Warehouse'`,
   `fromName 'AlexJacobson'`, `toName 'JCDenton'`, `transferCount 1`, and no
   `failLabel` (`scripts/validate-conversation-transfer-object-bind.mjs`
   asserts `failLabel` undefined for all ten shipped references at lines
   193-198). Candidate `JCDenton` fails the `fromName` comparison and matches
   `toName`, so `toActor +0x64` is written at `0x1000bd59` while `fromActor`
   stays null — in an InfoLink the remote speaker need not be on the map
   (`ConPlayBase.uc:537-539`). `giveObject +0x4c` then receives
   `StaticLoadObject(UClass::PrivateStaticClass, DeusEx package,
   'Image02_NYC_Warehouse', NULL, 2, NULL)` at `0x1000bd64`–`0x1000bd90`; the
   load runs unconditionally after both name branches.

2. **Event dispatch.** `DataLinkPlay` state `PlayEvent.SetupEvent` switches on
   `currentEvent.EventType`; `ET_TransferObject` calls
   `SetupEventTransferObject(ConEventTransferObject(currentEvent), nextLabel)`
   (`DataLinkPlay.uc:554-629`, case at `:616-617`), then feeds the result to
   `ProcessAction(nextAction, nextLabel)` at `:628`.

3. **`ConPlayBase.SetupEventTransferObject`** (`ConPlayBase.uc:542-826`), in
   order:

   * `itemsTransferred = 1` (`:559`).
   * `failLabel == ""` preselects `nextAction = EA_NextEvent`,
     `nextLabel = ""` (`:566-570`); a nonempty label would preselect
     `EA_JumpToLabel` (`:561-565`). Every early return below keeps this result.
   * `event.toActor == None` logs a warning and returns (`:573-578`); the bound
     player passes.
   * `event.fromActor == None` skips the giver lookup (`:587-588`);
     `invItemTo = Pawn(event.toActor).FindInventoryType(event.giveObject)`
     (`:590`) walks the `Inventory` chain comparing `Inv.class == DesiredClass`
     (`Pawn.uc:664-672`) and returns `None` — the player does not carry the
     image class.
   * `invItemFrom == None` therefore fabricates the giver item:
     `invItemFrom = Spawn(event.giveObject); bSpawnedItem = True`
     (`:599-603`). This is native 278 `Actor.Spawn` (`Actor.uc:869`) through
     `execScriptSpawn` (`src/runtime/script-spawn.mjs:10-35`) into
     `spawnScriptInventoryActor` (`:238-321`); the construction and startup
     sequence is detailed below.
   * With `invItemTo == None` and a `DeusExPlayer` recipient, the room check
     runs `FindInventorySlot(invItemFrom, True)` (`:609-611`).
     `DeusExPlayer.FindInventorySlot` returns `True` early for
     `DataVaultImage`/`NanoKey`/`Credits`/`Ammo` (`DeusExPlayer.uc:5206-5207`),
     so no grid search or placement occurs. A `False` result would destroy a
     spawned `invItemFrom` and return (`:613-617`).
   * The `invItemTo == None` branch (`:726-811`) applies: `invItemFrom` is not
     a multi-copy `DeusExPickup`, so
     `invItemTo = invItemFrom.SpawnCopy(Pawn(event.toActor))` (`:744-747`).
   * `DataVaultImage.SpawnCopy` (`DataVaultImage.uc:41-48`) is the body the
     receiver's class lookup resolves: it shadows the Engine one on this
     chain, calls `Super.SpawnCopy(Other)` and returns the result unchanged.
     Both bodies are prepared by the live world
     (`src/runtime/script-datalink-live.mjs:87-93`).
   * `Inventory.SpawnCopy` (`Inventory.uc:327-344`) then first calls
     `Level.Game.ShouldRespawn(self)` (`:330`). `GameInfo.ShouldRespawn`
     returns `false` when `Level.NetMode == NM_StandAlone`
     (`GameInfo.uc:1343-1348`), so `Copy = self` (`:338`); the live world
     attaches a real `DeusExGameInfo`/`Mutator` pair so this runs the prepared
     original body (`src/runtime/script-datalink-live.mjs:64-72,91-92`). Then
     `Copy.RespawnTime = 0.0`, `Copy.bHeldItem = true`, and `Copy.GiveTo(Other)`
     (`:340-342`).
   * `Inventory.GiveTo` (`Inventory.uc:316-322`): `Instigator = Other`,
     `BecomeItem()`, `Other.AddInventory(Self)`, `GotoState('Idle2')`.
     `BecomeItem` (`:298-311`) writes `RemoteRole = ROLE_SimulatedProxy`,
     `Mesh = PlayerViewMesh`, `DrawScale = PlayerViewScale`,
     `bOnlyOwnerSee = true`, `bHidden = true`, `bCarriedItem = true`,
     `NetPriority = 1.4`, then calls `SetCollision(false,false,false)`
     (native 262, `Actor.uc:695`) and `SetPhysics(PHYS_None)` (native 3970,
     `Actor.uc:776`), and clears `AmbientGlow`. `Other.AddInventory(Self)` reaches
     `DeusExPlayer.AddInventory` (`DeusExPlayer.uc:7219-7252`), which calls
     `super.AddInventory(item)` and then skips its whole object-belt and
     root-window arm because the item `IsA('DataVaultImage')` (`:7231`), so no
     Stage-4 windowing is touched. `Pawn.AddInventory`
     (`Pawn.uc:676-701`) scans the chain for the same item (`:685-687`), then
     — because a fresh spawned image has a null `Owner` — skips the
     `Pawn(NewItem.Owner).DeleteInventory(NewItem)` branch (`:691-692`) and
     prepends: `NewItem.SetOwner(Self)` (native 272, `Actor.uc:707`),
     `NewItem.Inventory = Inventory`, `Inventory = NewItem` (`:695-697`).
     `Idle2` is the empty state (`Inventory.uc:826-828`); the `GotoState`
     transition runs `Pickup.EndState`, which clears `bCollideWorld` and
     `bSleepTouch` (`:743-747`).
   * Back in the event body, `DeusExPlayer(event.toActor).FindInventorySlot(
     invItemTo)` (`:752-753`) hits the same early `True`.
   * `DeusExPlayer(event.fromActor) != None` fails because `fromActor` is
     null, so `RemoveItemFromPlayer` is not called (`:757-758`).
   * `invItemTo.IsA('DataVaultImage') && event.toActor.IsA('DeusExPlayer')`
     (`:762`) calls `DeusExPlayer(event.toActor).AddImage(
     DataVaultImage(invItemTo))` (`:764`). `AddImage`
     (`DeusExPlayer.uc:8686-8714`) rejects a duplicate `imageDescription`
     while walking `FirstImage`/`nextImage` (`:8694-8701`), then prepends:
     `newImage.nextImage = FirstImage`, `newImage.prevImage = None`,
     `FirstImage.prevImage = newImage` when a head exists, and
     `FirstImage = newImage` (`:8705-8711`).
   * `conWinThird == None` on an InfoLink play, so the notification is
     `DeusExRootWindow(player.rootWindow).hud.receivedItems.AddItem(
     invItemTo, 1)` (`:766-769`) — the host boundary below.
   * `invItemFrom = None; invItemTo = None` (`:771-772`). The trailing
     generic received-items gate at `:814` finds `invItemTo == None` and does
     not fire; the body returns `EA_NextEvent` with an empty label
     (`:822-825`).

4. **Continuation.** `ProcessAction(EA_NextEvent)` advances `currentEvent`
   along the authored chain; the Speech/End handling is unchanged from
   [script-datalink-live.md](script-datalink-live.md).

## Native construction

`DataVaultImage` and `Image02_NYC_Warehouse` are script-only classes: they
carry no DeusEx.dll `ClassConstructor` and no native vtable. The recovered
`UClass::Bind` order binds the chain and copies `Engine.AInventory`'s native
constructor pointer down through `DataVaultImage` into `Image02_NYC_Warehouse`
(`src/runtime/script-inventory-construction.mjs:184-211`, bind order at
`:203-209`). The construction contract is therefore the AInventory
registration, not the AActor one:

| evidence | value | source |
| --- | --- | --- |
| `AInventory` registration | `0x1035fff0`, raw flags `0x04084004` | `script-inventory-construction.mjs:57-58` |
| static class / instance size | `0x10576f70` / `0x434` | `:59,63` — doubles as `Engine.Inventory` `PropertiesSize` |
| parent static class | `0x1057cdf0` (`AActor::PrivateStaticClass`) | `:60-62` |
| internal constructor | `0x1030299b` → body `0x10341730` | `:64-65`; host body `constructInventory`, `script-object-construction.mjs:136-145` |
| constructor body order | inlined `AActor` member construction (intermediate `0x104268dc` vtable store at `0x103417c4`), then Inventory members, then final vtable `0x104286f8` at `0x10341851` | `:66-70` |
| inherited slots | `InitExecution` `+0x38` (`0x10302194`→`0x103deb40`), `Spawned` `+0x74` (`0x10303373`→`0x1030d730`), `ProcessEvent` `+0x10` (`0x10302d74`); `AInventory` overrides none of the SpawnActor-used slots | `:71-75` |
| `DataVaultImage` | export 36, `classFlags 0x33` (`abstract`), `Engine.Inventory` super (import ref `-24`), 13 linked fields | `:78-90`, `:28-45`; `PropertiesSize 0x484` |
| `Image02_NYC_Warehouse` | export 10926, `classFlags 0x32` (concrete), `DataVaultImage` super (export ref `36`), no added fields, `PropertiesSize 0x484` | `:92-104`, `:163-165` |
| authored defaults | `CollisionRadius 15`, `CollisionHeight 1.42`, `Physics 2` (Falling), `bCollideActors false`, `bBlockActors true`, `bRotatingPickup false`, `NetPriority 1.4`, `imageDescription 'NYC Warehouse'` | `:105-122`; enum per `Actor.uc:103-116` |

`resolveInheritedInventoryConstructor` requires the exact chain and rejects an
unexpected own-constructor on either script class, so an unrelated native
subclass cannot silently inherit this body
(`script-inventory-construction.mjs:184-211`). The spawn host admits the
selection through `nativeConstructorFor`, which maps `0x1030299b` to
`constructInventory` and rejects anything else
(`script-object-construction.mjs:147-156`; `script-runtime.mjs:942-945`).

## SpawnActor startup sequence

> **2026-09-25:** the per-class spawn entry points named below
> (`spawnScriptDataLinkPlay`, `spawnScriptInventoryActor` and the host
> `resolveConstructor` service) were replaced by the one general
> `ULevel::SpawnActor` body, which reads each class's bound ClassConstructor;
> see [spawn](script-spawn.md) "Native constructor family". The recovered
> sequence recorded here is unchanged.

`spawnScriptInventoryActor` (`src/runtime/script-spawn.mjs:238-321`) runs the
recovered `ULevel::SpawnActor` (`0x10394f60`) order for the single admitted
class key `deusex.image02_nyc_warehouse` (`:243-244`; runtime dispatch at
`script-runtime.mjs:984-986`). `Spawn(event.giveObject)` supplies the
receiver's `Location`/`Rotation`, a null owner, the caller's `Instigator`, and
the `NAME_None` construction name; the script `SpawnTag` write after the whole
body returns is `'None'` (`script-spawn.mjs:10-35`).

1. Prologue gates `0x10394f81`–`0x103950b0` (`spawnActorRejectedByGates`,
   `script-spawn.mjs:93-103`): null class, `Class+0x484` bit `0x1` abstract
   test (`0x10394fc2`) — the `DataVaultImage` parent itself is rejected here,
   only the concrete `Image02` subclass is admitted — the
   `AActor::PrivateStaticClass` ancestry walk, and the non-editor
   `bStatic`/`bNoDelete` default test. See
   [script-spawn.md](script-spawn.md) "Class and placement gates".
2. `level.actors` append slot, then `constructObject` with the
   `constructorSelection` above (`:254-258`; native `0x103951bc`–`0x1039521a`).
3. `ObjectFlags |= 1` (RF_Transactional) and `Tag =` class short name
   (`:259-260`; `0x10395227`–`0x10395236`).
4. `PointRegion = {LevelInfo,-1,0}`, `Level = actors[0]`, native `XLevel`
   binding (`:261-263`; `0x10395286`–`0x10395303`).
5. `bTicked = !level.tickParity`, `Role != 4` warning, `Brush = null`,
   `Location`/`OldLocation`/`Rotation` stores (`:264-269`;
   `0x10395309`–`0x103953b4`).
6. `installCollisionView` installs the field-backed collision surface, then
   the pre-startup hash gate `0x103953b7`–`0x103953cf` evaluates
   `Actor+0x1dc` bit `0x1` (`bCollideActors`) against `XLevel+0xf8`: the
   authored `bCollideActors false` keeps the gate a no-op, but the ordering is
   preserved because the native registration precedes `SetOwner`/`InitExecution`
   (`:271-282`; evidence `script-inventory-construction.mjs:140-144`).
7. `SetOwner(owner)`, `Instigator` store (`:283-284`;
   `0x103954de`–`0x103954f4`).
8. `initExecution` — vtable `+0x38` `InitExecution@AActor`
   (`0x10302194`→`0x103deb40`); the `Spawned` script event — vtable `+0x74` is
   the inherited no-op `Spawned@AActor` (`0x10303373`→`0x1030d730`)
   (`:285-287`; `0x103954f6`–`0x10395500`).
9. `PreBeginPlay`, `BeginPlay` (`:288-289`). The Deus Ex
    `Actor.PreBeginPlay` body (`Actor.uc:1011-1025`) runs its "fake shrink"
    first: `IsA('Decoration') || IsA('Inventory')` with `CollisionHeight >
    0.75` calls `SetCollisionSize(CollisionRadius, CollisionHeight - 0.75)`
    (native 283), so the authored `1.42` becomes `0.67` before step 13's
    encroachment extent is built. `bCollideActors` is still clear at this
    point, so the hash remove/re-add inside `SetCollisionSize` is a no-op.
    The body then runs `Level.Game.IsRelevant(Self)`, whose
    `Mutator.AlwaysKeep`/`IsRelevant`/`CheckReplacement` chain and
    `OddsOfAppearing` `FRand` (native 195) draw one value from the shared
    original RNG stream.
10. Pending-delete check: `Actor+0x28 & 0x80` (`bDeleteMe`) at `0x1039554f`
    returns null (`:290`). This is the only pending-delete test in the body.
11. `SetActorZone(test=(index==0), force=1)` through level vtable `+0xac`
    (`0x10395559`–`0x1039556c`), then `LastRenderTime = -10` (float32
    `0xc1200000` at `Actor+0x34`, `0x10395572`) (`:291-292`).
12. `PostBeginPlay` (`0x10395579`–`0x1039558e`) (`:293`).
13. `CheckEncroachment` unconditionally through level vtable `+0xb8` at
    `0x103955d6` (body `0x1039a350`). Its early return requires
    `Actor+0x1dc & 0x0d == 0` and a null `Brush`; the authored
    `bBlockActors true` makes the general non-player path live rather than the
    bounded early-return case — hash extent query, `IsBlockedBy` both passes,
    `EncroachingOn`/`EncroachedBy` dispatch
    (`check-encroachment.mjs:51-87`). A true result runs `ULevel::DestroyActor`
    (level vtable `+0x94`) and returns null (`:294-301`;
    `0x103955e0`–`0x103955e8`).
14. `SetInitialState` (`0x103955f9`–`0x1039560f`): `InitialState == ''` selects
    `GotoState('Auto')` (`Actor.uc:1075-1078`), which resolves the serialized
    `auto state Pickup` (`Inventory.uc:604`).
    * `BeginState` (`Inventory.uc:727-741`): `BecomePickup()` (`:282-293`) —
      `Mesh = PickupViewMesh`, `DrawScale = PickupViewScale`,
      `bOnlyOwnerSee/bHidden/bCarriedItem` cleared, `NetPriority = 1.4`, and
      `SetCollision(true,true,false)` (native 262), which sets the collide and
      block-actors bits and now performs the hash `AddActor`; the
      `RemoteRole` write is skipped because `Physics == PHYS_Falling`. Then
      `bCollideWorld = true`, and `Level.bStartup` sets `bAlwaysRelevant`.
    The state's `Begin:` and `Dropped:` labels are latent state code, not
    part of `SetInitialState`: `GotoState` only selects the state and label,
    so `BecomePickup` runs exactly once during the spawn (asserted in
    `scripts/validate-inventory-spawn.mjs`). When that code is later executed
    the `Begin:` label (`:749-752`) calls `BecomePickup()` again and its
    `bRotatingPickup && (Physics != PHYS_Falling)` guard is doubly false here
    (`bRotatingPickup` is false and the authored `Physics` is `PHYS_Falling`),
    so `SetPhysics(PHYS_Rotating)` is skipped; the `Dropped:` label
    (`:754-758`) sets `AmbientGlow=255` when `bAmbientGlow` and runs
    `CheckTouching` when `bSleepTouch`, both false on this class. Driving
    that latent code is outside this route.
15. `FindBase` tail (`0x10395612`–`0x1039569c`): requires `Actor+0xc4` (Base)
    null, `+0x1dc` bit `0x2` (`bCollideWorld`, just set by `BeginState`),
    `ADecoration`/`AInventory`/`APawn` ancestry (class objects `0x10578d48`,
    `0x10576f70`, `0x1058c660` at `0x10395629`–`0x1039568d`), and `Actor+0x30`
    Physics in `{0,5}`. `Image02`'s authored `Physics = 2` fails the last
    gate, so the trace does not run at spawn; it runs later inside
    `BecomeItem`'s `SetPhysics(PHYS_None)` during `GiveTo` (`:302-311`;
    evidence `script-inventory-construction.mjs:150-155`).
16. `PostPostBeginPlay` (`0x103956a1`–`0x103956b6`) (`:312`).
17. The `Level+0x108` nonzero spawn-tracking allocation path is not
    implemented; `level.spawnTracking = false` selects the zero branch
    (`:313`). The notifier tail sets the shared reentrancy guard
    `0x10588b48` and reads the `SpawnNotify` head at `LevelInfo+0x590` — a
    null head clears the guard without dispatch (`:314-319`;
    `0x103956f4`–`0x103957d1`).
18. Return the actor (`0x103957d7`). No later pending-delete check exists.

## Collision/base natives

Six recovered `AActor` bodies plus `CheckEncroachment` carry the spawn's
collision behavior. Evidence addresses are recorded in
`src/runtime/script-actor-collision.mjs:12-20`; script dispatch routes natives
262/283/3970 to these bodies only for receivers carrying the installed
collision view (`script-runtime.mjs:1361-1385`).

| routine | native | body (thunk) | recovered semantics |
| --- | --- | --- | --- |
| `execSetCollision`/`SetCollision` | 262 | `0x103e1900` / `0x10369200` (`0x10301a5f`) | skipped optionals fill from the current `+0x1dc` bits; removes the actor from the level hash when the collide bit was set; preserves bit `0x2` (`bCollideWorld`) and all upper bits while replacing `0x1`/`0x4`/`0x8`; re-adds when the new collide bit is set (`script-actor-collision.mjs:27-49`) |
| `SetCollisionSize` | 283 | `0x10369320` (`0x10303d64`) | hash remove → float32 `CollisionRadius`/`CollisionHeight` stores → re-add, keyed on the collide bit both times; returns true (`:51-60`) |
| `SetPhysics` | 3970 | `0x103c95f0` | same-physics early out; for byte values `{0,1,5,7,0xa}` (`PHYS_None`, `PHYS_Walking`, `PHYS_Rotating`, `PHYS_Rolling`, `PHYS_Spider` per `Actor.uc:102-116`) writes the mode then runs `SetSupportBase` for a distinct explicit new base or `FindBase` otherwise; other modes clear an existing `Base` through `SetBase(null)`; velocity (`+0x144`) and acceleration (`+0x150`) are zeroed when the re-read physics is `0` or `5` (`:133-150`) |
| `FindBase` | — | `0x103c9470` (`0x10301749`) | one downward extent trace 8.0 units below `Location` through XLevel vtable `+0xc0` `SingleLineCheck`; extent `(CollisionRadius, CollisionRadius, CollisionHeight)` (X, Y, Z in memory: `fld [+0x1d8]`, `fld [+0x1d4]`, `fstp` to the stack slots at `0x103c94a8`-`0x103c9511`; corrected 2026-10-16, it was written `{R, H, R}`), flags `0x17`; a hit differing from `Base` is `IsBasedOn`-gated before `SetSupportBase`, and a null hit still reaches `SetSupportBase(null)` → `SetBase` (`:69-84`) |
| `IsBasedOn` | — | `0x1034c8d0` (`0x103020db`) | walks the source's own `+0xc4` Base chain (`:62-67`) |
| `SetBase` | 298 | `0x10369c80` (`0x10301285`) | self-base loop guard, `StandingCount` ±1 (uint8) on old/new bases, `Detach`/`Attach` dispatch, `BaseChange` notify (`walking-callbacks.mjs:4-20`) |

`SetSupportBase` (thunk `0x1030146f`, body `0x103c9390`) does not write `Base`:
it dispatches the `SupportActor` event on the target, whose script body calls
`StandingActor.SetBase(self)` (`Actor.uc:823-825`); a null target clears via
`SetBase(null)` (`walking-callbacks.mjs:22-26`).

`CheckEncroachment` `0x1039a350` for a non-player, non-Brush source
(`checkActorEncroachment`, `check-encroachment.mjs:61-87`): the
`+0x1dc & 0x0d` early return comes first, Brush sources route to the mover
helper, both hit passes use full `IsBlockedBy` (`actorBlockedBy`, `:10-28` —
the blocker side picks `bBlockPlayers` for a controlled-player/Projectile
opposite, else `bBlockActors`), loop one dispatches `EncroachingOn` and
rejects on true, loop two dispatches `EncroachedBy` on each blocking actor
or `BeginTouch` on a non-blocking hit when notify is set (`:75-85`). The
mover-push sub-branch (non-static Mover source) is an explicit error, not a
silent skip (`:58-60,71`).

`installActorCollisionView` (`script-actor-collision.mjs:86-131`) makes the
spawned script object the actor view: `flags` and the field-backed
`position`/`radius`/`height`/`base`/`physics`/`velocity`/`acceleration`
accessors read and write the object's real script storage, while host-only
`lineage`, `worldActor`, `movingBrush`, `model`, `projectile`, and
`controlledPlayer` members match the map-actor surface the hash and
encroachment queries consume. The spawn service installs it before the
pre-startup hash gate (`script-runtime.mjs:961-970`).

## Host boundary

`HUDReceivedDisplay.AddItem` (`HUDReceivedDisplay.uc:128-139`) calls
`winTile.NewChild(Class'HUDReceivedDisplayItem')`, `SetItem`, resets
`displayTimer`, `Show()`, `bTickEnabled = True`, and
`AskParentForReconfigure()` — the `winTile.NewChild` windowing lifecycle is
Stage 4 work. The live world keeps a real attached `HUDReceivedDisplay`
instance: the canonical DeusEx class is loaded and `runtime.attach`ed so
`hud.receivedItems` carries genuine field storage
(`src/runtime/script-datalink-live.mjs:262-272`), and the original function
key `deusex.hudreceiveddisplay.additem` is registered as a `boundaryFunctions`
handler that evaluates both arguments and records the `(item, count)` pair
into `receivedItems` (`:273-277`). The boundary is exposed as
`dataLinkReceivedItems` (`src/runtime/script-doors.mjs:944`). It records on
the original function key rather than substituting an `AddItem`
implementation; the recorded call does not claim the original's window
effects. Audio transport and InfoLink presentation already sit behind their
separate established boundaries (`script-datalink-live.md`;
`level.engine.audio = null`, `script-datalink-live.mjs:119`).

## Unresolved branches

* `RemoveItemFromPlayer` (`ConPlayBase.uc:941-945` →
  `player.RemoveItemDuringConversation`) is unreachable on this route:
  `invItemTo` is null at the `:630` call site and `fromActor` is null at
  `:757`.
* `AddTransferCount` (`ConPlayBase.uc:832-933`) and the
  recipient-already-has-item branches — ammo `AddAmmo` (`:635-647`), the
  weapon-to-ammo conversion including the grenade `AmmoType` special cases
  (`:651-697`), and the belt-text updates (`:806-809`) — are not exercised.
* The `DeusExPickup` `bCanHaveMultipleCopies` split (`:734-743`) — fresh
  `Spawn`, `GiveTo`, `NumCopies -= transferCount` — does not apply to a
  `DataVaultImage`.
* The `Credits` sibling branch (`:776-789`): `numCredits` received display,
  `player.Credits +=`, `invItemTo.Destroy()`.
* Multiplayer halves: the non-standalone `ShouldRespawn` respawn path
  (`Inventory.uc:331-336` and the `Sleeping` state `:792-815`) and
  `FindInventorySlot`'s `NetMode != NM_Standalone` branches
  (`DeusExPlayer.uc:5213-5258`) are gated off by `NM_StandAlone`.
* `conWinThird != None` third-person conversation `ShowReceivedItem`
  (`ConPlayBase.uc:766-767,814-819`): InfoLink plays keep `conWinThird` null,
  so only the `hud.receivedItems` arm is taken.
* SpawnNotify notifier bodies: the guard and list walk are recovered
  (`0x103956f4`–`0x103957d1`), but a non-null `SpawnNotify` reaches an
  explicit error because notification return/parameter handling is not
  implemented (`script-spawn.mjs:316-317`).
* bounded: only `deusex.image02_nyc_warehouse` passes the spawn admission
  gate; the other nine shipped DataLink image classes are pinned as authored
  references but are not admitted SpawnActor subclasses
  (`script-spawn.mjs:243-244`, `script-runtime.mjs:984-986`).

## Validation

```text
node scripts/validate-inventory-spawn.mjs
node scripts/validate-datalink-transfer-object.mjs
node scripts/validate-conversation-transfer-object-bind.mjs
```

`validate-inventory-spawn.mjs` covers the admitted `Image02_NYC_Warehouse`
construction and the recovered SpawnActor startup order. On the construction
side it reads the `AInventory` registration, the
thunk -> `InternalConstructor` -> constructor-body chain, both vtable stores
and the three SpawnActor-used vtable slots straight out of the local
`Engine.dll`, checks the three class identities/declarations against
`DeusEx.u`, reproduces `PropertiesSize 0x484` by running this project's
recovered `UStruct::Link` over the real 13-property chain instead of asserting
a constant, and exercises `resolveInheritedInventoryConstructor`'s four
rejection paths. On the startup side it spawns one image into the live
Training world with the level collision hash and the script dispatch
instrumented, so the whole recovered order is asserted as an observed
sequence — the `PreBeginPlay` fake shrink and its `FRand` ahead of a live
`CheckEncroachment`, the pre-startup hash gate contributing no registration,
the single `BecomePickup` `SetCollision` that does register, the
`DataVaultImage.Pickup` auto-state entry and the deferred `FindBase` — and
it pins the prologue gate refusing the abstract `DataVaultImage` parent.
`validate-datalink-transfer-object.mjs` covers the `DL_Rooftops` end-to-end
route: the bound event fields, fabricated giver spawn, `SpawnCopy`/`GiveTo`,
inventory prepend, `AddImage` list insertion, and the recorded
`receivedItems` call. `validate-conversation-transfer-object-bind.mjs` pins
the ConSys package/DLL hashes, class/property/vtable/body/import evidence, all
ten shipped DataLink references, and the `DL_Rooftops` `JCDenton` bind through
native 2053.
