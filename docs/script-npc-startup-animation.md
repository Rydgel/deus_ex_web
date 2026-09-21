# NPC startup to animation: integration boundary

This milestone is **not complete**. The real Play host now runs the original
startup chain for every pawn-ancestry Training map actor and ticks them
through the recovered `ULevel::Tick` path; Jaime lands, enters `Standing` and
loops `BreatheLight` under the shared clock, and the MIB enters `Wandering`
through the now-implemented `AIPickRandomDestination` native. The armed
NPCs, cameras, the remaining `FindPathToward` AI native, the root-window
conversation path and renderer lighting remain explicit boundaries below.
The following contract comes from the installed
GOTY packages, not a replacement startup routine.

## Original startup prerequisites

The loaded-level ordering is recorded in [PawnList linkage](pawn-list.md).
`UGameEngine::LoadMap` initializes script execution, sets the startup flags,
runs `Game.InitGame`, and dispatches separate actor-array passes for
`PreBeginPlay` and `BeginPlay`. Running the complete spawn sequence separately
for each existing NPC is not equivalent. The current Play host has already
built a PawnList for collision and perception: running `Pawn.PreBeginPlay` on
that list would prepend duplicate identities. Startup must own the list from
the original empty initial state before it can be admitted into Play.

The embedded source and bytecode establish the following shared path:

* Training Jaime inherits `HumanCivilian -> ScriptedPawn -> Pawn -> Actor`.
  `HumanCivilian` does not override PreBeginPlay. The separate player-side
  `Human -> DeusExPlayer` class is not an NPC ancestor.
* `ScriptedPawn.PreBeginPlay` saves BaseEyeHeight, calls `Pawn.PreBeginPlay`,
  restores BaseEyeHeight, calls `CreateShadow`, then sets alliance and reaction
  callbacks.
* `Pawn.PreBeginPlay` calls AddPawn before `Actor.PreBeginPlay`. The actor body
  shrinks a pawn's collision height by 4.5 when it exceeds 9, otherwise halves
  it, using SetCollisionSize. It then calls Game.IsRelevant. The remaining pawn
  body initializes angular size, Instigator, DesiredRotation, SightCounter and
  Skill, then movement and appearance fields. RNG calls and order matter.
* `ScriptedPawn.CreateShadow` spawns `DeusEx.Shadow` when bHasShadow and bInWorld
  are true and Shadow is None. This branch is reached by authored Training
  Jaime; it cannot be discarded as an optional visual effect.
* `Shadow` derives from native `Engine.Decal`. Its inherited `Decal.BeginPlay`
  executes `if (!AttachDecal(100)) Destroy()`. Thus the native return value
  affects actor lifetime and the value returned by Spawn.

Shadow construction now uses the recovered native Decal constructor, linked
integer-array SurfList storage and shared SpawnActor startup. AttachDecal's
argument handling, null-client/disabled-decals/missing-texture returns and
depth clamp are translated and compared with original DLL execution. The
client check is **Client.Decals**, not a render-device pointer; the Play host
supplies `Engine.Client.Decals = true` matching the original `UClient` config
default. The positive BSP surface sweep (ray, coplanar-chain iterator,
polygon containment and surface gates) is translated from
`0x103e734b`-`0x103e898e`; only the MultiDecalLevel^2 footprint grid's extra
SurfList entries and software-renderer facet geometry remain unimplemented.
See [Decal startup evidence and checks](script-decal-startup.md).

After lifecycle completion, the actual auto state is `ScriptedPawn.StartUp`.
Its BeginState sets movement physics (Walking then Falling for these humans),
blocks reactions and resets its destination. Its Begin label calls
InitializePawn, sleeps `FRand()+0.2`, waits for landing and calls FollowOrders.
Its Tick also has a LastRendered-dependent route through PlayWaiting,
InitializePawn and FollowOrders. Setting an idle animation directly does not
establish any of these prerequisites.

The Play host now runs that whole chain at load: each pawn's class methods and
states are prepared before dispatch (the VM advances a state cursor before a
call, so prepare-on-demand inside a state body would permanently skip
statements), then `PreBeginPlay -> BeginPlay -> PostBeginPlay ->
SetInitialState -> PostPostBeginPlay` runs in serialized actor order, and
`Actor.Tick` advances animation, `ProcessState` and `APawn::performPhysics`
each frame. `Pawn.PreBeginPlay`'s own `AddPawn` owns `Level.PawnList`
membership — the host evicts its pre-built collidable entry before startup so
the list is never double-inserted (a second head-insert self-cycles the list
`MakeNoise` walks). On player reset the serialized state is restored between
collision-hash removal and re-registration (the hash requires the registered
transform to still be live at removal), then the same chain re-runs.

Current explicit boundaries, all recorded rather than substituted:

* ~~`ScriptedPawn.InitializeInventory` calls `Spawn(Weapon..., self)`~~ —
  **implemented 2026-09-20.** `UNATCOTroop0`/`1`/`3` and `JosephManderley0`
  now run the authored body through original bytecode on their first
  `ProcessState` tick: the `Engine.Weapon`/`Engine.Inventory` constructor
  copy-down families, the recovered `ULevel::SpawnActor` order (including
  the pre-startup hash gate the weapons' authored `bCollideActors` sets),
  `GiveTo`/`AddInventory`/`SetBase` attachment, `AmmoName` ammo wiring and
  `SetupWeapon(false)`'s `Weapon = None` outcome, the `MoveActor` based-rider
  section as the items ride the landing pawn (`StandingCount` 3), per-item
  ticking, and `ULevel::DestroyActor` cleanup on Player reset. See
  [NPC weapon startup](script-npc-weapon-startup.md) and
  `validate-npc-weapon-startup.mjs` / `validate-weapon-construction.mjs`.
* ~~`engine.PlayerReplicationInfo` startup is unprepared; reached by
  `Camera4`-`7` (`Camera` has PlayerPawn ancestry) during `PostBeginPlay`~~ —
  **resolved by admission, not construction.** Those four exports are the
  UnrealEd viewport cameras serialized into the map; the standalone linker's
  `ULinkerLoad::CreateExport` refuses them before construction — they carry
  only `RF_LoadForEdit` flags (`0x2340000`, no GIsClient/GIsServer bit) and
  their class is `NAME_Camera` — so `_Object` stays null, their
  `Level.Actors` slots resolve to null, and `Pawn.PreBeginPlay`'s PRI spawn
  never runs. They never join `PawnList`, the collision hash, startup or
  reset. See [map actors](script-map-actors.md) and
  `validate-map-actor-admission.mjs`.
* `Pawn.AIPickRandomDestination` (native 709) is implemented, oracle-verified
  and dispatched live — Training `mib1` now passes the former tick-2
  enemy-check boundary, lands, and wanders: with seed 1 and 1/60-second
  frames the first six `tries=1` picks all exhaust their search (faithful;
  the original pacing sleeps ~6 s between episodes), pick #15 succeeds and
  the pawn moves ~98 u, with further successful wander legs through 1920
  ticks and no NPC failures. `Pawn.FindPathToward` (native 517) is now
  implemented through the shared navigation services; Secretary0 selects
  PatrolPoint4 and begins moving, with final arrival/timeout fidelity still
  unverified. See
  [pawn navigation](script-pawn-nav.md#aipickrandomdestination-native-709---execaipickrandomdestination-0x103c86f0)
  and [alliance checks](script-pawn-alliance.md).
* ~~`DeusExRootWindow.CanStartConversation` is unprepared; reached by the
  JaimeReyes2 conversation check~~ — the player's `rootWindow` class chain is
  now linked at load (`prepareNpcs`), so the check dispatches to the prepared
  `DeusExRootWindow` body rather than failing on the class. This clears only
  the startup-preparation boundary; the conversation system's own later
  natives and presentation remain separate Stage-3/4 work.

Original extracts remain outside Git under `.cache/research/pawn-startup/`;
animation controls, tick and frame evidence are
already recorded in [animation tick](script-animation-tick.md) and
[mesh frames](script-lodmesh-frame.md).

Play scheduling follow-up: the shared clock now follows the recovered level
frame delta, rather than wrapping this actor path in the former browser-only
120 Hz accumulator. Each supported NPC receives one tick per browser frame;
slow frames retain the original 0.4-second delta ceiling and physics' own
remaining-time subdivisions. See [performance investigation](play-performance.md).

## Display integration contract

The renderer reads the same actor's current AnimSequence, AnimFrame, transforms
and blend fields through the existing original GetFrame translation. It never
selects a sequence or advances a simulation clock — the script runtime owns
both. `createActorMeshPreview.update()` resamples GetFrame whenever the pose
signature changes, so the live startup/tick products are visible in ordinary
Play and through Inspect without preview controls; the resolved map actor and
the runtime-mutated NPC are the same object identity. Each displayed actor
keeps its frame cache between samples, including across tween transitions.
Buffer positions and bounds change in place; original surfaces, skins and UVs
persist. The isolated inspection cache retains the capture-backed identity
contract in [NPC mesh inspection](npc-mesh-preview.md), without registering
captured indices as live browser UObject indices.

## Live Play results

The real `createGame` host attaches all pawn-ancestry map actors, prepares
their class chains plus the player/LevelInfo chains NPC bodies call into, and
runs the LoadMap event chain once per load/reset. Measured on Training:

* `JaimeReyes0` falls under `PHYS_Falling`, lands on tick 4 through
  `processLanded` -> `SetPhysics(PHYS_Walking)` -> `Landed` -> `PlayLanded`,
  clears `WaitForLanding` into `Standing`'s `Sleep`, and loops `BreatheLight`
  at rate 0.5 (frame 0.0958 -> 0.8458 across 600 ticks).
* `ScientistMale0` moves through `Patrolling` and settles into `Standing` at a
  new location through the recovered script path.
* `mib1` lands in `Wandering`, runs `AIPickRandomDestination` through the
  live native-709 dispatch, and moves toward picked destinations across
  load and reset (~98 u travelled on the default seed, further wander legs
  over 1920 ticks, zero NPC failures). Ambient `PlaySound` calls from
  footsteps/scans are recorded nonfatal boundaries rather than pawn-killing
  errors.
* `Shadow0` spawns under Jaime, attaches one real BSP surface through the
  recovered `AttachDecal` sweep, and is stored on the pawn.
* The pawn list stays cycle-free; player reset restores serialized state,
  re-runs startup and resumes animation/physics without hash errors. The
  collidable rebuild re-registers actors inside `changeActor`'s
  remove-mutate-re-add, since `prepareActor` restores serialized collision
  fields on actors already re-registered with live transforms.
* Renderer `update()` re-poses Jaime's vertex buffers every tick from the live
  `AnimSequence`/`AnimFrame`/`Location`/`Rotation` fields.

## Focused integration results

`node scripts/validate-npc-startup-boundary.mjs` runs the original Jaime
PreBeginPlay body in an isolated fixture: the pawn list is restored to the
serialized empty state, the host-produced `Shadow` field and shrunk
`CollisionHeight` are reset to serialized values, and the `AttachDecal(100)`
random-direction draws are pinned to the original's straight-down probe
(the two earlier `FRand` calls keep the real stream; the random direction is
original behavior, the fixture is not). Jaime is retained by the original
relevance check, registered once, resized from `42.79999923706055` to
`38.29999923706055` (hash removal precedes the write and reinsertion follows
it), receives the original Instigator/DesiredRotation writes and BaseEyeHeight
restoration, and constructs a second real Shadow at his feet through the
recovered `AttachDecal` sweep. The fixture also checks that disabling decals
runs the original negative BeginPlay/Destroyed/DetachDecal path, removes the
actor and links it for pending deletion. The live browser does not disable
decals or run this isolated startup fixture.

`node scripts/validate-npc-mesh-preview.mjs` separately invokes the original
PlayWaiting override on all 14 displayed actors, then runs the recovered
animation phase and samples those poses. It checks persistent GPU buffer and
material identities, a continuing BreatheLight animation selected by the
original ScriptedPawn method, a transition into a tween retaining the prior
pose, updated world bounds and hidden/deleted visibility. Sampling does not
write script fields or tick the player.
