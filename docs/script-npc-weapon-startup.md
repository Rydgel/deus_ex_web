# NPC weapon/ammo startup: original contract and boundary

This note records the original data, embedded script and hash-checked native
evidence behind the armed Training NPCs' inventory startup — the
`ScriptedPawn.InitializeInventory` chain that spawns `WeaponAssaultGun`,
`Ammo762mm`, `WeaponCombatKnife` (UNATCOTroop0/1/3) and `WeaponPistol`,
`Ammo10mm`, `WeaponCombatKnife` (JosephManderley0) — plus the native paths the
attached items make reachable on the very next tick. Authorities: local GOTY
`System/Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`), `System/Core.dll` (`8bf3039e…eba7e4`, base `0x10100000`),
`DeusEx.u` (`257f5c16…b74480`), `Engine.u`, and the embedded `ScriptText`
of the classes named below (extracted to `.cache/research/*.uc`, outside Git).
The implementation section at the end records what the runtime now does.

## Reproduced failure

`node scripts/probe-npc-startup.mjs unatcotroop0 30` (Training, seed 1): the
recovered LoadMap chain completes (`PreBeginPlay … PostPostBeginPlay`, auto
state `ScriptedPawn.StartUp`), then tick 0's `ProcessState` runs the `Begin:`
label → `InitializePawn` → `InitializeInventory` → `spawn(WeaponAssaultGun,
self)` → native 278 → `ScriptRuntime.spawnActor` → no admitted path →
`installSubsystemSpawn`'s lifecycle fallback → `Player startup requested an
unprepared Actor subclass: deusex.weaponassaultgun`. JosephManderley0 fails the
same way on `deusex.weaponpistol`. The live Play host records the same
messages in `npcFailures` after the first `game.tick`.

## Original data

Authored `InitialInventory[8]` (`ScriptedPawn.uc:357`, struct
`InventoryItem {class<Inventory> Inventory; int Count}`), read from the live
Training actors (class defaults merged with map overrides):

| actor | class | `InitialInventory` (Inventory × Count) | `bKeepWeaponDrawn` |
| --- | --- | --- | --- |
| UNATCOTroop0, UNATCOTroop1, UNATCOTroop3 | `DeusEx.UNATCOTroop` | `WeaponAssaultGun`×1, `Ammo762mm`×12, `WeaponCombatKnife`×1 | false |
| UNATCOTroop2 | `DeusEx.UNATCOTroop` | map override: all eight `Inventory=None` (counts 1/12/1/1…) — **unarmed by map data**, never reaches Spawn | false |
| JosephManderley0 | `DeusEx.JosephManderley` | `WeaponPistol`×1, `Ammo10mm`×12, `WeaponCombatKnife`×1 | false |

Class defaults that the path reads (decoded from `DeusEx.u`/`Engine.u` through
the shared loader; these are the expected values, not implementation output):

| class | chain | key defaults |
| --- | --- | --- |
| `WeaponAssaultGun` (export 1103, classFlags `0x36`) | `DeusExWeapon` (4, `0x37`) → `Engine.Weapon` (9, `0x33`, **native**, entry flags `0x40f0004`) → `Engine.Inventory` (6, `0x833`, native) → `Engine.Actor` | `bCollideActors=true bBlockActors=true bBlockPlayers=false bCollideWorld=false Physics=2 CollisionRadius=15 CollisionHeight=1.1 Mass=30 AmmoName=Ammo762mm PickupAmmoCount=30 ReloadCount=30 bInstantHit=true ProjectileClass=None ItemName="Assault Rifle" Mesh=PickupViewMesh=AssaultGunPickup PlayerViewMesh=AssaultGun` |
| `WeaponPistol` (1000, `0x36`) | same | `CollisionRadius=7 CollisionHeight=1 Mass=10 AmmoName=Ammo10mm PickupAmmoCount=6 ReloadCount=6 ItemName="Pistol"` |
| `WeaponCombatKnife` (`0x36`) | same | `CollisionRadius=12.65 CollisionHeight=0.8 AmmoName=AmmoNone PickupAmmoCount=0 ReloadCount=0 bHandToHand=true ItemName="Combat Knife"` |
| `Ammo762mm` (621, `0x32`) | `DeusExAmmo` (56, `0x33`) → `Engine.Ammo` (31, `0x33`, script-only, entry flags `0xf0004`) → `Engine.Pickup` (606, `0x33`, script-only) → `Engine.Inventory` | `bCollideActors=true bBlockActors=true Physics=2 CollisionRadius=6 CollisionHeight=0.75 AmmoAmount=30 MaxAmmo=300` |
| `Ammo10mm` (841, `0x32`) | same | `CollisionRadius=8.5 CollisionHeight=3.77 AmmoAmount=6 MaxAmmo=150` |
| `AmmoNone` (629, `0x32`) | same | referenced only as `Class'AmmoNone'` in the compare; never spawned |

`DeusExWeapon` carries `CLASS_Config` (`0x4`) for `var globalconfig vector
SwingOffset` (`DeusExWeapon.uc:103`). The class loader does not yet apply
`DeusEx.ini` config values to class defaults; `SwingOffset` is not read on this
path. Recorded as an open default-property boundary, not resolved here.

## Embedded script contract

`ScriptedPawn.uc:563-622` (`InitializeInventory`), reached from
`InitializePawn` (`:530-556`, first `StartUp.Begin:` statement, guarded by
`bInitialized`):

1. For each slot with a class and `Count > 0`, `Count` times: if the class is
   an `Ammo` metaclass (`Class<Ammo>(…) != None`), `inv = FindInventoryType(cls)`
   (`Pawn.uc`, `Inv.class == DesiredClass` walk of the `Inventory` chain) and,
   when found, `Ammo(inv).AmmoAmount += cls.default.AmmoAmount` — **no MaxAmmo
   clamp**, so 12×`Ammo762mm` yields `AmmoAmount = 360` and 12×`Ammo10mm`
   yields `72`. Otherwise `inv = spawn(cls, self)` (owner = the pawn, location
   and rotation default-copied from the pawn, SpawnTag `None`), then
   `inv.InitialState = 'Idle2'`, `inv.GiveTo(Self)`, `inv.SetBase(Self)`, and
   the first `Weapon` of the slot is remembered.
2. For each remembered weapon whose `AmmoType == None` and `AmmoName` is set
   and not `Class'AmmoNone'`: `AmmoType = Ammo(FindInventoryType(AmmoName))`;
   only when that misses does it `spawn(AmmoName)` (**no owner**), then
   `InitialState='Idle2'`, `GiveTo(Self)`, `SetBase(Self)`. For the Training
   troops the ammo already exists from step 1, so this spawn branch is not
   reached; the knife's `AmmoNone` compare skips it.
3. `SetupWeapon(false)` (`:2399-2413`): `bKeepWeaponDrawn` is false and
   `ShouldDropWeapon()` (`:6687`, arm health) is false, so `SetWeapon(None)`
   (`:2442-2472`): `Weapon == newWeapon == None` → `Inventory.ChangedWeapon()`
   recursion down the chain, `PendingWeapon = None`. **`Weapon` stays None** —
   the armed Training NPCs never draw at startup, so `Actor.Tick`'s
   `FarMoveActor(Weapon, Location, 0, 0)` tail is not reached by them (see the
   tick section for the recovered contract that is installed anyway).

Resulting inventory chain (prepend order, `Pawn.AddInventory`
`Pawn.uc:676-701`): `WeaponCombatKnife → Ammo762mm|Ammo10mm →
WeaponAssaultGun|WeaponPistol`, each with `Owner = Instigator = Base = pawn`,
and `Weapon.AmmoType` pointing at the ammo item. `AddInventory` scans for a
duplicate, then — because `Spawn(cls, self)` already made the pawn the item's
`Owner` — runs `Pawn(NewItem.Owner).DeleteInventory(NewItem)` (`Pawn.uc`):
the chain walk finds nothing, but the body ends with the unconditional
`Item.SetOwner(None)` (native 272 → `LostChild` on the pawn). `AddInventory`
then calls `NewItem.SetOwner(Self)` (`GainedChild` again), `NewItem.Inventory
= Inventory`, `Inventory = NewItem`. The slot loop spawns every item with
`self` as owner, so all three items' owner links go pawn → None → pawn during
`GiveTo`; only the step-2 ownerless `spawn(AmmoName)` branch (unreached here)
would skip the detour.

Per-item startup bodies reached by `ULevel::SpawnActor`'s event dispatch:

* `DeusExWeapon.PreBeginPlay` (`:304-315`): `Super.PreBeginPlay()` →
  `Weapon`/`Inventory` inherit `Actor.PreBeginPlay` (`Actor.uc:1011-1025`):
  `IsA('Inventory') && CollisionHeight > 0.75` → `SetCollisionSize(Radius,
  Height-0.75)` (native 283; assault gun 1.1→0.35, pistol 1→0.25, knife
  0.8→0.05, `Ammo10mm` 3.77→3.02, `Ammo762mm` 0.75 is **not** > 0.75 so it keeps
  0.75), then `Level.Game.IsRelevant(Self)` (one shared-stream `FRand`). Then
  `if (Default.mpPickupAmmoCount == 0) Default.mpPickupAmmoCount =
  Default.PickupAmmoCount` — a class-default **write** through the VM.
  `WeaponAssaultGun`/`WeaponPistol.PreBeginPlay` add only `NetMode !=
  NM_StandAlone` overrides (skipped). `Ammo10mm.PreBeginPlay` likewise.
* `BeginPlay`: inherited empty `Actor.BeginPlay`.
* `PostBeginPlay`: `Inventory.PostBeginPlay` (`Inventory.uc:141-151`:
  `PickupMessageClass = None`, `ItemName` already localized so `GetItemName`
  is skipped, `PlayerViewOffset = Default.PlayerViewOffset * 100`) →
  `Weapon.PostBeginPlay` (`Weapon.uc:212-226`: `SetWeaponStay()` reads
  `Level.Game.bCoopWeaponMode`, `MaxDesireability = 1.2 * AIRating`, both
  projectile classes None) → `DeusExWeapon.PostBeginPlay` (`:318-330`,
  standalone: nothing). Ammo: `DeusExAmmo.PostBeginPlay` standalone: nothing.
* `SetInitialState` → `InitialState == ''` → `GotoState('Auto')` →
  `auto state Pickup` (`Inventory.uc:604`; `Pickup.uc:105` for ammo;
  `DeusExWeapon.Pickup.BeginState` (`:3304-3313`) first calls
  `AIEndEvent('WeaponDrawn', EAITYPE_Visual)` (native 715 — returns silently
  while no AI event manager exists) then `Super.BeginState()`):
  `BecomePickup()` (`Inventory.uc:282-293`: `Mesh=PickupViewMesh`,
  `DrawScale`, `bOnlyOwnerSee/bHidden/bCarriedItem=false`, `NetPriority=1.4`,
  `SetCollision(true,true,false)` native 262, `RemoteRole` write skipped for
  `PHYS_Falling`), `bCollideWorld = true`, `Level.bStartup` →
  `bAlwaysRelevant`. `Pickup.BeginState` calls `Super.BeginState()` only.
* Back in `InitializeInventory`: `GiveTo` (`Inventory.uc:316-322`):
  `Instigator = Other`, `BecomeItem()` (`:298-311`: `RemoteRole`, `Mesh =
  PlayerViewMesh` (None for ammo), `DrawScale = PlayerViewScale`,
  `bOnlyOwnerSee = bHidden = bCarriedItem = true`, `NetPriority = 1.4`,
  `SetCollision(false,false,false)` — removes the hash registration made by
  `BecomePickup` — `SetPhysics(PHYS_None)` native 3970 → recovered
  `FindBase` trace 8 u below the pawn's centre, `AmbientGlow = 0`;
  `Weapon.BecomeItem` (`Weapon.uc:614-618`) adds `Lifespan = 0`),
  `Other.AddInventory(Self)`, `GotoState('Idle2')` (`Inventory.uc:826`,
  empty; `Pickup.EndState` clears `bCollideWorld`/`bSleepTouch`). Then
  `SetBase(Self)` native 298 → `AActor::SetBase` (`0x10369c80`): pawn
  `StandingCount` +1 (byte), `Attach` on the pawn, `BaseChange` on the item
  (`DeusExWeapon.BaseChange` `:332-339` → `Super` then `base != None` so no
  `SetPhysics(PHYS_Falling)`).

## Native construction

`Engine.Weapon` is registered in `Engine.dll` at `0x1035f110`–`0x1035f150`
(pushes `0x10302ef5` InternalConstructor, raw flags `0x04084004`, name/package
strings, super `0x10576f70` = `AInventory::PrivateStaticClass`, size
`0x504`; static class object `0x1057c3f8`,
`src/runtime/script-native-class-registry.mjs` row `Weapon`). Constructor
chain: thunk `0x10302ef5` (`?InternalConstructor@AWeapon@@SAXPAX@Z`) →
`0x10342a70` (null-`this` guard) → `0x10303fb7` (`??0AWeapon@@IAE@XZ`) →
body `0x10342a90`:

```text
10342aad  call 0x10303431      ??0AActor@@QAE@XZ  (installs 0x104268dc)
10342ab8  push 0 ; call [0x10599b84]  ??0FString@@QAE@W4ENoInit@@@Z   this+0x320
10342ad3.. 7 × call [0x10599b88] ??0FStringNoInit@@QAE@XZ            +0x32c +0x338 +0x3c8 +0x3d4 +0x3e0 +0x41c +0x428
10342b43  mov dword [esi], 0x104287a4                                 final AWeapon vtable
```

The eight member constructions are the `AInventory` FString members with the
`ENoInit`/`FStringNoInit` variants — they do not write member bytes, so the
template-copied defaults survive, exactly as recorded for `AInventory`'s own
body (`docs/script-datavault-image.md`). `AWeapon` adds no member
construction of its own (`0x434`–`0x504` is plain data).

Vtable comparison (`.rdata`, 36 base slots): `AWeapon` `0x104287a4` equals
`AInventory` `0x104286f8` in every slot except `+0x0c` (vector deleting
destructor `0x10303c74` → `0x103172c0`, which calls `??1AWeapon` `0x10301e1a`
and frees `0x504` bytes). Both differ from `AActor` `0x104268dc` only at
`+0x0c`, `+0x54` (`GetOptimizedRepList`) and `+0x58`
(`ShouldDoScriptReplication`). The three slots `ULevel::SpawnActor` uses —
`+0x10` `ProcessEvent` `0x10302d74`, `+0x38` `InitExecution` `0x10302194`,
`+0x74` `Spawned` `0x10303373` — and the `+0x64` Tick slot are identical
across all three classes.

`UClass::Bind` copy-down (`0x10127b5a`–`0x10127b60`, recorded in
`script-inventory-construction.mjs`) therefore gives:

* `WeaponAssaultGun`, `WeaponPistol`, `WeaponCombatKnife` → `DeusExWeapon`
  (script-only, no DeusEx.dll registration) → `Engine.Weapon`'s
  `ClassConstructor` `0x10302ef5`, vtable `0x104287a4`, linked
  `PropertiesSize` reproduced by the recovered `UStruct::Link` over the real
  chain (Weapon `0x504` plus DeusExWeapon's and the leaf's fields).
* `Ammo762mm`, `Ammo10mm`, `AmmoNone` → `DeusExAmmo` → `Engine.Ammo` →
  `Engine.Pickup` (both script-only in this build: export flags `0xf0004`, no
  Engine.dll registration) → `Engine.Inventory`'s `0x1030299b`, vtable
  `0x104286f8`.

Admission is the linked chain: script-only classes (no `RF_Native`
`0x04000000` on the class export) down to the first native class, which must
be `Engine.Weapon` or `Engine.Inventory`. Any other native class on the chain
is an explicit unimplemented constructor family, not an inherited body.

## SpawnActor sequence differences from the image route

> **2026-09-25:** the per-class spawn entry points named below
> (`spawnScriptDataLinkPlay`, `spawnScriptInventoryActor` and the host
> `resolveConstructor` service) were replaced by the one general
> `ULevel::SpawnActor` body, which reads each class's bound ClassConstructor;
> see [spawn](script-spawn.md) "Native constructor family". The recovered
> sequence recorded here is unchanged.

`spawnScriptInventoryActor` (`docs/script-datavault-image.md`) already runs
the recovered `ULevel::SpawnActor` order for `Engine.Inventory` ancestry. The
weapon/ammo classes exercise the branches the image kept dormant:

* `bCollideActors` is authored **true**, so the pre-startup hash gate
  `0x103953b7`–`0x103953cf` registers the item in the XLevel hash before
  `SetOwner`/`InitExecution`.
* `Spawn(cls, self)` supplies the pawn as `SpawnOwner`: `SetOwner` at
  `0x103954de` dispatches `GainedChild` on the pawn before `InitExecution`.
* `CheckEncroachment` (`0x103955d6`, body `0x1039a350`) runs with the item's
  post-shrink cylinder at the pawn's own location, so the general non-player
  path (hash extent query, `IsBlockedBy` both passes, `EncroachingOn` /
  `EncroachedBy` dispatch) is live; the pawn's `EncroachingOn` default returns
  false so the spawn is retained.
* `FindBase` tail is skipped at spawn (`Physics = 2`); `BecomeItem`'s
  `SetPhysics(PHYS_None)` reaches it later.

## Newly reachable tick paths

### `ULevel::MoveActor` based-rider section (`0x103998a0`–`0x10399bb0`)

After `SetBase(Self)` the pawn's `StandingCount` is 3, and its first physics
step (the troops start `PHYS_Falling` and land) enters this section, which the
existing `playerMove` translation rejected as "based passengers unsupported".
Frame: `ebx = Actor`, `[ebp-0x14] = ULevel`, args `+0x8 Actor`, `+0xc..+0x14
Delta`, `+0x18..+0x20 NewRotation`, `+0x24 Hit`, `+0x28 bTest`, `+0x2c
bIgnorePawns`, `+0x30 bIgnoreBases`, `+0x34 bNoFail`; the committed final
delta lives at `[ebp-0x24..-0x1c]`.

```text
103998a0  movzx StandingCount (Actor+0xd8); zero → 10399bb5
103998ae  bTest != 0 → jump straight to the commit at 10399c9a
103998b9  for (i = 0; i < Actors.Num; i++) {                 (Level+0x30 / +0x2c; i kept in [ebp+0x14])
103998cd    Other = Actors[i]; null → next
103998db    Other->Base (+0xc4) != Actor → next
103998e7    [ebp+0x2c] = NewRotation.Yaw - Actor->Rotation.Yaw   (unmasked int32; overwrites bIgnorePawns)
103998fa    RotMotion = (0,0,0)
10399904    if (NewRotation == Actor->Rotation) → 10399a57       (all three ints)
10399930    ReducedRotation = { 0, (NewYaw & 0xfffc) - (ActorYaw & 0xfffc), 0 }
10399939    v = Actor->Location - Other->Location            (x87: 0x114/0x118/0x11c, f32 stores at -0x30..-0x28)
10399978    coords = GMath.UnitCoords (Core GMath+0x18, 12 dwords)
1039999a    coords *= ReducedRotation                        (Core ??XFCoords@@QAEAAV0@ABVFRotator@@@Z, 0x1011ac80)
103999d0    t = v.TransformVectorBy(coords) inline: t_i = (v.x*A_i.x + v.y*A_i.y) + v.z*A_i.z, A = X,Y,Z axes, one f32 store each
10399a27    RotMotion = v - t                                (per component, f32 stores)
10399a57    Hit = FCheckResult(1.0)                          (Time 1.0f, Item -1, zero Location/Normal)
10399aa4    rot = FRotator(Other.Pitch, Other.Yaw + [ebp+0x2c], Other.Roll)
10399ad1    delta = FinalDelta + RotMotion                   (three f32 adds)
10399b51    Level->MoveActor(Other, delta, rot, Hit, bTest=0, bIgnorePawns=0, bIgnoreBases=1, bNoFail=0)   (vtable +0x88)
10399b57    if (Other's class chain reaches APawn 0x1058c660)  Other->ViewRotation (+0x3dc/+0x3e0/+0x3e4) += (0, [ebp+0x2c], 0)
10399bac  }
10399bb5  bTest? → commit. bNoFail? → commit. Actor is APawn? → commit.
10399bf5  else CheckEncroachment(Actor, Location+FinalDelta, NewRotation, 0) via level +0xb8; true → return 0 (no commit)
10399c9a  hash remove → Location += FinalDelta, Rotation = NewRotation → hash add → bump/touch → SetActorZone
```

`FCoords::operator*=(FRotator)` (`0x1011ac80`) applies the yaw pass first
using Core's 16384-entry sine table (`0x101b32a4`, index `(angle >> 2) &
0x3fff`; cosine is the entry at `angle + 0x4000`): temp axes `X = (cos, sin,
0)`, `Y = (-sin, cos, 0)`, `Z = (0, 0, 1)`, then `Origin.TransformPointBy`,
`XAxis/YAxis/ZAxis.TransformVectorBy` (`0x10101bc2` / `0x10102225`, the same
`(a+b)+c` x87 grouping already recovered for `fcoordsAxes`), then the pitch
and roll passes. The reduced rotation has zero pitch and roll, so those passes
multiply by exact identity matrices (`sin 0 = 0`, `cos 0 = table[0x1000] =
1.0f`) and leave the yaw result unchanged. With `UnitCoords`, the yaw pass
yields `XAxis' = (cos, -sin, 0)`, `YAxis' = (sin, cos, 0)`, `ZAxis' = (0,0,1)`,
and the inline row-form transform gives `t = R(+Δyaw)·v`; hence a rider at
offset `d = Other - Actor` ends at `Actor_new + R(+Δyaw)·d`, i.e. it rotates
with its base. Unmasked `Δyaw` (not the `&0xfffc`-reduced value) is what is
added to the rider's own `Rotation.Yaw` and to a pawn rider's
`ViewRotation.Yaw`.

For the held items (`bCollideActors = bCollideWorld = false` after
`BecomeItem`, `StandingCount 0`, `Physics None`) the recursive `MoveActor`
skips the `MultiLineCheck` query, takes the non-pawn `CheckEncroachment`
early return (`+0x1dc & 0x0d == 0`, null Brush), commits `Location +=
delta` / `Rotation = rot`, performs no hash work, dispatches no
bump/touch, and calls `SetActorZone(Other, 0, 0)`. Because the items were
spawned at the pawn's `Location` and `RotMotion` is zero for a zero offset,
they track the pawn's `Location` exactly (same f32 `Location + delta`
arithmetic) — the observable check the validator uses.

The `bTest = 1` moves issued by `AIPickRandomDestination`'s search skip the
section entirely (`0x103998ae`).

### `ULevel::FarMoveActor` with based children (`0x10398ba0`)

Already recovered in `src/runtime/relocation.mjs`: a non-test relocation of an
actor with `StandingCount != 0` walks `Level.Actors` and `SetBase(child, NULL,
1)` for every `child.Base == actor` (detaching the held items), sets
`bJustTeleported` (`Actor.uc:416`; the host's `motionFlags` bit `0x100`), writes
`Location`/`OldLocation`, re-registers the hash entry and calls
`SetActorZone(actor, test, 0)`. Test moves (`bTest = 1`, the navigation
search) do not detach. The pawn view's former "detaching pawn passengers"
refusal is replaced by the recovered detach through `SetBase`.

### `AActor::Tick` pawn tail: `FarMoveActor(Weapon, Location, 0, 0)`

Recorded in `docs/script-actor-tick.md` and translated in
`actor-tick.mjs:96-97`; reached only while `Pawn.Weapon != None`. For a held
weapon the body is: `bStatic` clear and `bMovable` set → no hash removal
(`bCollideActors` clear) → `bNoCheck = 0` but `bCollideWorld` and
`bCollideWhenPlacing` clear so no `FindSpot` → `CheckEncroachment(weapon,
dest, Rotation, 1)` early-returns false → no `StandingCount` children →
`bJustTeleported`, `Location = OldLocation = dest` → `SetActorZone(weapon, 0,
0)` → returns true. The Training NPCs keep `Weapon = None` at startup, so this
slot is now linked to the recovered body but is not exercised by them; a
drawn weapon (a later combat slice) is the first caller.

### Ticking the spawned items

The original `ULevel::Tick` ticks every actor in array order; an item whose
`Owner` has not yet been ticked this frame is deferred (`actor-tick.mjs:32-38`,
`level-tick.mjs:88-96`). The items are appended after their owners, so they
tick after the pawn in the same frame. `DeusExWeapon.Tick` (`:1035-1067`)
calls `Super.Tick` then, because `pawn.Weapon != self`, clears the lock fields
and returns; `Ammo` has no Tick. Their `Physics` is None after `BecomeItem`, so
no physics dispatch follows. `Shadow.Tick` (`Shadow.uc:15-79`: `InStasis`,
`Trace`, `DetachDecal`/`AttachDecal(32, …)`) remains the separate Decal
boundary recorded in `docs/script-decal-startup.md`; spawned Shadows are still
not ticked by the host.

## Reset lifecycle

The original "Player start" reloads the level, so the actors it spawned do
not survive it. They are not destroyed through `DestroyActor` either. The
reload replaces each map export in place, and LoadMap's
`CollectGarbage(RF_Native)` tags every actor of the old package that the new
`Actors` array does not hold with the collector's `0x400` exclusion bit and
purges it, with no script event. The collection is documented in
[Player start collection](script-loadmap-gc.md).

Play reproduces that. `resetNpcs({reload: true})` leaves the Shadows and
inventory items out of the reloaded `Level.Actors`, restores the pawns'
serialized state and runs the collection before the GameInfo spawn. The
collection releases the spawned actors, and the next startup's spawns reuse
their slots. The earlier host policy destroyed them through
`runtime.destroyActor` in reverse spawn order, which ran their
`Destroyed`/`DeleteInventory`/`LostChild` events. That is not the original
behavior and was removed. The browser-side destroyed-actor ledger records
only serialized map exports, so spawned items are never reintroduced. The
Shadow count stays constant across resets.

## Unresolved / deliberately unsupported branches

* `Ammo.SpawnCopy`'s `parentammo` branch, `Weapon.TravelPostAccept`,
  multiplayer `NetMode` overrides, `Pickup.Frob`/`HandlePickupQuery` and
  `DeusExWeapon` firing/reload/lock states: not reached by startup.
* `SetupWeapon(true)` / `SwitchToBestWeapon` / `SetWeapon(newWeapon)` →
  `BringUp`/`PutDown` and the `Weapon != None` tick tail: not reached while
  `bKeepWeaponDrawn` is false and no enemy is set.
* `InitializeInventory`'s ownerless `spawn(AmmoName)` branch: not reached by
  the Training data (ammo already present from the slot loop).
* `MoveActor` rider recursion for a rider that is a map actor (host identity)
  runs the same `playerMove` body on the map actor's native surface
  (`ScriptRuntime.moveMapRider`, [map-actor move](script-map-actor-move.md)):
  the player's picked-up items and a carried decoration. A pawn or brush
  rider still raises the explicit error; spawned collision-view riders take
  the full `playerMove`
  body.
* Non-pawn source `CheckEncroachment` inside `MoveActor` (`0x10399bf5`) is
  now part of the shared move for callers that supply the service; the
  decoration physics callers do not yet, so their behaviour is unchanged and
  the gap is recorded rather than silently closed.
* `Shadow.Tick` remains unsupported. `FindPathToward` is now linked through
  the shared navigation services; Secretary0's two-point patrol now has
  original-backed arrival checks and public-reset coverage (see
  [patrol evidence](script-pawn-locomotion.md#live-patrol-verification--00_training-secretary0)).
  The `Camera4`–`7` exports are refused
  by standalone `ULinkerLoad::CreateExport` admission before construction, so
  their `PlayerReplicationInfo` startup never runs ([map
  actors](script-map-actors.md)); the `rootWindow`/`CanStartConversation` chain
  is linked at load and its checks dispatch to the prepared
  `DeusExRootWindow` body.
* `DeusExWeapon` `globalconfig SwingOffset` (class config) is not loaded from
  `DeusEx.ini` by the class loader.

## Implementation and validation

Implemented 2026-09-20. What landed:

* **Construction admission.** `inventoryConstructorChain`
  (`script-spawn.mjs`) walks a class's linked ancestry to the first
  `RF_Native` (`0x04000000`) node and admits only the `Engine.Weapon` or
  `Engine.Inventory` roots — the two `UClass::Bind` copy-down families with
  recovered registrations (`script-inventory-construction.mjs` `nativeRoots`).
  Any other native class above an `Engine.Inventory` ancestor throws the
  explicit constructor-family error rather than inheriting a body silently.
  `inventorySelection` uses the leaf's own linked `PropertiesSize`
  (`loadRecord.nativeSlots[0x3c]`), so `DeusExWeapon`'s 136 declared fields
  and the leaf's are legal. `nativeConstructorFor` maps `0x10302ef5` to the
  recovered `AWeapon` body (`constructWeapon`: `AActor` base + final vtable
  `0x104287a4`). `Ammo762mm`/`Ammo10mm`/`AmmoNone` resolve to the
  `Engine.Inventory` root because `Engine.Ammo`/`Engine.Pickup` are
  script-only in this build.
* **Spawn.** `ScriptRuntime.spawnActor` routes any admitted chain to
  `spawnScriptInventoryActor` before the lifecycle fallback, so the armed
  NPCs' `Spawn(InitialInventory[i].Inventory, self)` runs the recovered
  `ULevel::SpawnActor` sequence: the authored `bCollideActors` now exercises
  the pre-startup hash gate (`0x103953b7`–`0x103953cf`), `SetOwner` dispatches
  `GainedChild` on the pawn, and the general `CheckEncroachment` runs with
  the item's post-`SetCollisionSize` cylinder at the pawn's location.
  `level.tickParity` is the `npcTickLevel.tickTag` getter. Each product is
  bound to its vtable's Destroy virtual (`AActor::Destroy` for these classes).
  Script `Destroy()` and a Player start's collection reach it through
  `ConditionalDestroy`.
* **VM support.** `execClassContext` (`0x12`) shares `execContext`'s
  null/skip contract so `Class<Ammo>(...).default.AmmoAmount` and the
  `Default.mpPickupAmmoCount = PickupAmmoCount` class-default write run
  (`defaultReference` resolves `Default` on a class receiver). A null class
  context zero-fills the `valueSize` result like an ordinary null Context —
  `prepareContextResults` now prepares `0x12` nodes too, so
  `Class<X>(None).default.Member` returns the typed zero instead of throwing
  ([null contexts](script-null-context.md)).
* **MoveActor rider section.** `move-riders.mjs` translates
  `0x103998a0`–`0x10399bb0` — the `StandingCount`-gated walk of
  `Level.Actors` that recursively `MoveActor`s every based child with
  `FinalDelta + RotMotion` (`UnitCoords *= FRotator(0, yaw&0xfffc-diff, 0)`,
  x87-store granularity) and adds the unmasked yaw difference to each
  rider's `Rotation.Yaw` and pawn riders' `ViewRotation.Yaw`.
  `playerMove` calls it between the move resolution and the hash
  remove/commit, and the non-pawn `CheckEncroachment` tail
  (`0x10399bb5`–`0x10399c8e`) runs for callers that supply the service.
  `ScriptRuntime.moveSpawnedActor` is the recursive rider entry; it runs
  spawned collision views directly and map actors through `moveMapRider`,
  both with the authored `bIgnoreBases=1`, so a
  colliding item is not blocked by the base carrying it.
* **Attachment.** `GiveTo`/`AddInventory`/`SetBase`/`SetPhysics` run through
  the existing recovered bindings; the items land in the pawn's inventory
  chain in head-insert order (knife, ammo, weapon — the reverse of spawn
  order), `Base = Owner = Instigator = pawn`, `StandingCount` 3.
* **Ticking.** The host iterates `Level.Actors` in array order: serialized
  pawns plus every runtime-spawned `Engine.Inventory` actor (Shadows stay
  unticked per the recorded Decal boundary). `Actor.Tick`'s pawn tail
  `FarMoveActor` slot is now linked to `ScriptRuntime.farMoveActor` (the recovered
  `0x10398ba0` body incl. the `child.Base` detach through `SetBase`); the
  Training NPCs' `Weapon = None` leaves it unexercised.
* **Reset lifecycle.** A reload leaves the runtime-spawned actors out of the
  reloaded `Level.Actors`, and LoadMap's collection releases them without
  script events ([Player start collection](script-loadmap-gc.md)). The
  destroyed-actor ledger records only serialized map exports, and the Shadow
  count stays constant (it was 15 → 29 → 52 before the reset handled spawns).
* **Preparation.** `prepareNpcs` links and prepares every
  `InitialInventory` slot's class plus each `AmmoName` class at load,
  before the synchronous first-tick `InitializeInventory`; the player's
  `rootWindow` class chain is prepared for the same reason (`CanStartConversation`
  reaches `GetRootWindow` 1425 through `windowLifecycle.hierarchy`).

Validation: `validate-weapon-construction.mjs` (Engine.dll byte checks for
the AWeapon registration/thunk/vtable, package export flags/classFlags,
recovered `UStruct::Link` PropertiesSize `0x504`, admission/refusal cases,
authored defaults table, two instrumented live spawns pinning the exact
startup trace order). `validate-npc-weapon-startup.mjs` (real Training:
load + two resets × 300 ticks — 12 spawned items per run, exact
classes/fields/links/state per NPC, `AmmoAmount` 360/72, `AmmoType` wired,
`Weapon = None`, `StandingCount` 3, `Physics` 1, prior-run items pending
kill with cleared slots, identical repeated-reset counts, per-NPC next
boundary report). `test/move-riders.test.mjs` (7 cases incl. the `dyaw=3`
unmasked/reduced split and a pawn `ViewRotation` rider). The existing
spawn/inventory/datalink/augmentation/NPC-boundary/play-frame/decal/
plant-push/set-location/world-destroy/native-relocation validators, the
497-test unit suite, the production build and the browser Training
Play/reset spec all pass.

Fresh mission entry now also runs `Mission00.FirstFrame`: the distributor's
`Body_Search_Room` NanoKey starts on `UNATCOTroop2`, then the original knockout
and SpawnCarcass transfer that same item to the unconscious body. The startup
validator checks both owners at their respective stages across resets. See
[Training cadet](script-training-mission-entry.md).
