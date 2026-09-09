# Original controlled-pawn zone updates

Contract traced before translation: Engine SetActorZone1039b940–1039be94 and
PointRegion103f5db0–103f5f32. For an ordinary Pawn, SetActorZone queries center,
feet at Location.Z-CollisionHeight and head at Location.Z+BaseEyeHeight. Region
is Actor+c8; FootRegion Pawn+330; HeadRegion+33c; BaseEyeHeight+3f8.

If center Zone changes and test=false: oldZone.ActorLeaving(actor),
actor.ZoneChange(newZone), then Region store, then newZone.ActorEntered(actor).
On equal center zones it still replaces leaf/index metadata. FootZoneChange and
HeadZoneChange precede their respective region stores. test suppresses callbacks
but not queries/stores. force resets the three old regions to LevelInfo/-1/0
before queries. bDeleteMe (+28 bit80) skips the entire routine. For non-client
NetMode and a PlayerReplicationInfo, copy center Region.Zone to its PlayerZone.
All point-query and script callbacks are distinct verification boundaries.

PointRegion traverses BSP with retained Z/Y/X dot and >=0 choosing front. Final
leaf is the terminal node.leaves[side]. Zone number is node.zones[side] when the
model NumZones is nonzero, otherwise0; the selected zone actor pointer falls
back to the supplied LevelInfo when null. Empty nodes return LevelInfo/-1/0.
The tracked outside/CSG state does not affect the returned region fields.

## Original dry script effects and actual maps

The audited original Engine/DeusEx exports have no JC override of FootZoneChange
beyond Pawn. DeusExPlayer overrides HeadZoneChange. ZoneInfo defines ActorEntered/
ActorLeaving; LevelInfo and SkyZoneInfo inherit them. WarpZoneInfo overrides both
and is outside this adapter. Sources were extracted from their original ScriptText
into ignored `.cache/zone/` and `.cache/reference/`.

- ZoneInfo.ActorEntered/Leaving increments/decrements ZonePlayerCount for a
  player pawn. Transition to1/0 dispatches Trigger/UnTrigger to ZonePlayerEvent
  actors when the name is nonempty. A dry player is neither the no-inventory nor
  projectile/effects branch.
- PlayerWalking.ZoneChange drops a carried decoration only when entering water.
  Its PlayerPawn parent, even for dry new zones, traces below the player when
  crouching with a dry head. Water/swimming state changes remain unsupported.
- Pawn.FootZoneChange, standalone: when TimeSeconds-SplashTime>.25, update
  SplashTime and MakeNoise(1 for Falling, .3 otherwise), even on dry transitions.
  Water splash and pain-zone logic require separate effects and are rejected.
- DeusExPlayer.HeadZoneChange sets a new ambient zone SoundRadius=255 and the
  old ambient zone SoundRadius=0 before inherited Pawn logic. That inherited
  logic has no dry-to-dry effects. Water entry has significant crouch/swimming,
  inventory and pain state changes, explicitly unsupported here.

Both actual Model.Zones tables have only two non-null zone actors: WaterZone and
SkyZoneInfo. All ordinary room entries resolve through null-pointer fallback to
LevelInfo. Consequently ordinary dry changes of BSP leaf or zone number do not
change the zone **actor identity** and do not emit these script events. This is
an evidenced predicate, not an unconditional no-op. `.cache/zone/map-zone-audit.json`
records the inherited zone values and relevant function override inventory.

Native PointRegion captures at the original PlayerStart center, feet(-43) and
head(+40) all resolve to LevelInfo: Training zoneNumber1/leaf3262; Liberty
zoneNumber3 with respective leaves3352/3636/3351. These samples are input
PlayerStart positions, not claims that a full spawned player's subsequent fitted
pose or all possible dry-map coordinates have been captured.

## API and native comparisons

`pointRegion(model,position,levelInfo,zoneActors,numZones=zoneActors.length)`
returns `{zone,leaf,zoneNumber}`. `zoneActors` is the original Model.Zones order,
with real actor identities or null. The fallback must be the same LevelInfo
identity used by line queries and all three initial pawn regions.

`setActorZone(pawn,world,test=false,force=false)` owns ordinary Pawn region updates.
State includes position, height, baseEyeHeight, region/footRegion/headRegion,
deleted and optional playerReplicationInfo.playerZone. World supplies levelInfo,
netMode and pointRegion(position). Required-on-use callbacks are
actorLeaving(zone,pawn), zoneChange(pawn,newZone), actorEntered(zone,pawn),
footZoneChange(pawn,newZone), headZoneChange(pawn,newZone). They run in original
order and may mutate pawn state; later foot/head queries observe changed location,
height or BaseEyeHeight as the DLL does. A missing event callback fails explicitly.
Initialize all three regions as `{zone:levelInfo,leaf:-1,zoneNumber:0}` when
reproducing spawn setup. Ordinary MoveActor and FarMoveActor pass test and force0.

`dryPlayerZoneCallbacks({timeSeconds,makeNoise,zoneEvent,traceWorld})` translates
the source subset above for an audited ordinary JC PlayerWalking pawn and
ZoneInfo/LevelInfo/SkyZoneInfo actors. Zone actors carry mutable inherited values.
Callbacks are not replaced by empty functions: MakeNoise, named event dispatch
and a crouched ZoneChange trace are required when the source branch uses them.
`traceWorld(start,end)` supplies original Actor.Trace with bTraceActors=false;
this adapter does not invent its low-level mask. `zoneEvent(zone,pawn,name,enter)`
receives true for Trigger and false for UnTrigger. Only standalone dry/nonpain
transitions belong to these script callbacks. General SetActorZone itself still
captures client/test behavior independently of those script policies.

The original SetActorZone capture supplies only PointRegion return values and
script callbacks; all native query positions, region comparisons/stores,
callback order and PRI update execute original instructions. Eight cases include
unchanged zone identities, all transitions, test, force, deletion, client PRI and
script-driven position/height/eye mutation. Fourteen direct PointRegion cases
include controlled boundary/null/empty-model cases and six actual map points.
All22 comparisons are exact. Six regression tests distinguish these native
comparisons from the source-translated dry script effects.

```sh
node scripts/validate-native-zone.mjs
node scripts/validate-native-zone.mjs --reuse
node --test test/zone.test.mjs
```

Ignored native case/results are `.cache/zone/{cases,original}.json`. The native
harness does not execute entire game script event bodies. Unsupported water/pain,
warp/custom zone callbacks, general actor classes and full startup remain explicit.

## Player collision-hash insertion during original spawning

SpawnPlayActor10396bd0 calls GameInfo.Login through ProcessEvent at103970ed,
then obtains the returned pawn at10397100 and calls SetPlayer at1039718e.
The GameInfo instance is LevelInfo.Game(+544), loaded at1039707a. Embedded
DeusExGameInfo.Login delegates to GameInfo.Login; GameInfo.Login selects a start
and calls Spawn(SpawnClass,,,StartSpot.Location,StartSpot.Rotation) at source887.
DeusExGameInfo.Login may subsequently SetLocation to a saved dump or selected
PlayerStart. Those operations are FarMoveActor; they are not hash-free setup.
Full Login/mission/player inventory state execution is not reproduced here.

The original SpawnActor sequence proves the bounded registration requirement:

1. Its accepted placement runs FindSpot before construction when required
   (`10395170`–`103951b6`).
2. Append one entry to Level.Actors via original FArray.Add(1,4)
   (`103951bc`–`103951c8`); StaticConstructObject populates that slot
   (`1039521a`–`10395222`). This path appends rather than searching actor holes.
3. Set LevelInfo/Level pointers, then store Location, OldLocation and Rotation
   (`103952f4`–`103953b4`).
4. If bCollideActors and Hash is present, Hash.AddActor is called at103953cf.
   There is no controlled-player exclusion. It occurs **before** later pawn
   foot/head default-region initialization and actor startup callbacks.
5. Initialize body/foot/head regions to LevelInfo/-1/0, set owner/instigator,
   run startup events, then SetActorZone at1039556c (force1). After Login returns,
   SpawnPlayActor assigns Player. Thus initial hash insertion precedes SetPlayer;
   Player pointer absence is not a reason to omit registration.

Root should insert the new player after existing actor registration at its
original spawn insertion point, and perform subsequent resize/move hash updates
rather than leaving it permanently outside the hash. For a simplified initial
Play scene, registering the current player after existing actors corrects the
missing actor; it does not prove all original startup-created actors or their
relative insertion chronology have been reconstructed. The insertion ordering
above is native instruction/source evidence, not a full SpawnPlayActor capture.

## Non-Pawn center-only branch

Original class-chain check1039ba5d–8a determines Pawn membership. Force resets
Actor.Region for every actor, but the branch1039bb00 skips foot/head resets for
non-Pawns. After identical center query/event/store processing,1039bcc2–c7
returns immediately for non-Pawns, skipping foot/head and PRI updates. The
helper exposes this distinction as `actor.isPawn=false`; omitted retains Pawn
compatibility. Movable brush actors need only position and region, plus the
center event callbacks if the zone actor identity changes. Dry-player script
callbacks are not generic mover callbacks; callers must bind audited actor/zone
scripts. LevelInfo itself has a separate special branch outside this API.

Six additional original non-Pawn cases cover changed/equal center identity,
test, forced reset with distinct untouched foot/head sentinels, deletion, and
a PRI sentinel. All 28 native cases compare exactly; 8 focused tests pass.
