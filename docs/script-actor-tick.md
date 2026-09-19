# Original standalone Actor.Tick

Authority: GOTY Engine.dll `AActor::Tick` at `103a1aa0..103a2ab6` and
`AActor::InStasis` at `1036bfe0..1036c06c`, plus embedded Actor/Pawn/PlayerPawn
declarations. The original bodies and reference cases were recovered before
the translation. `native-actor-tick-oracle.py` executes the complete Tick body,
including original InStasis, animation and timer arithmetic. Event lookup/
ProcessEvent, ProcessState, physics, destruction, deferred-list allocation,
viewport ReadInput and ShowSelf/CheckEnemyVisible are explicit service leaves.
It does not claim to execute those services or a whole original world.

The admitted route starts with Role=ROLE_Authority (4), standalone NetMode=0,
and no DemoRecDriver (+88). Both local and RemoteRole=ROLE_AutonomousProxy (3) branches
are covered. Simulated-client movement and demo/network tails are outside this
contract and must remain explicit unsupported paths.

## Admission and ordering

InStasis returns false unless level.TimeSeconds (double, +dc) minus actor
LastRenderTime (float, +34) is strictly greater than 5, bStasis (+28 bit 200000)
is set, and either bForceStasis (400000) is set or Physics is None/Rotating
(0/5). Then read Model.Zones[Region.ZoneNumber].LastRenderTime at
model+108+24*zone. Stasis requires either that zone to be older than 5 seconds
or DistanceFromPlayer (+38) >1200, and LevelInfo.NetMode (+518)=0. Unordered
comparisons fail the greater-than gates. These are renderer-supplied timestamps;
the runtime must not fabricate recent rendering to keep actors active.

A stasis actor returns 1 without updating bTicked or animation. bTransient
(+2c bit 2) with Role>=2 additionally calls Level.DestroyActor(actor,0).
Otherwise, if Owner exists and its bTicked differs from Level.TickTag (+10c),
allocate an eight-byte Actor/Next node and prepend it to the level's deferred
actor head (+104), then return 0. Allocation failure clears that head and still returns 0.
This phase does not itself retry deferred actors.

Admitted actors copy TickTag's low bit into bTicked (+28 bit 200). A Pawn local
is retained only when bIsPawn (800000) and native Pawn ancestry both hold.
Run the original main/blend animation phases next, before any script Tick.

For RemoteRole=3, Role=4 runs ProcessState then Timer; it skips ordinary Tick,
lifespan and physics. A PlayerPawn with a Pawn ViewTarget first copies the
target's ViewRotation/EyeHeight and optional Weapon.PlayerViewOffset to
TargetViewRotation/TargetEyeHeight/TargetWeaponViewOffset (+864/+870/+874).

Otherwise, a PlayerPawn with Player (+5d4) runs ReadInput(delta), PlayerInput,
PlayerTick, then ReadInput(-1). Camera ancestry with bFrozen (+5fc bit 800)
clear returns early before input. Non-controlled actors return immediately
when tick type is 1; otherwise dispatch Tick(delta) only when probing Tick.
Both admitted script branches then run ProcessState(delta) followed by Timer.
The separate [timer contract](script-timers.md) preserves remainder, one-shot
clearing and synchronous callback effects.

Nonzero ordered LifeSpan is decremented. The unrounded result <=0.0001 (or
unordered) dispatches Expired then **unconditionally** calls DestroyActor and
returns; resetting LifeSpan in Expired does not cancel destruction. Otherwise
nonzero Physics with current Role!=3 invokes performPhysics(delta). Callback
writes to Physics/Role are observed here. Tick does not insert a general
bDeleteMe check between these calls.

## Pawn tail

For bIsPlayer and Role>=3, bViewTarget dispatches UpdateEyeHeight(delta);
otherwise Rotation is copied to ViewRotation. Then a non-null Weapon is moved
to the actor's current Location through Level.FarMoveActor(weapon,location,0,0).

Only current Role=4 and tick type 2 reach the AI timers:

1. Negative/unordered SightCounter gets one addition of 0.2, then subtract delta;
   each assignment stores float32. This is not a catch-up loop.
2. A visible bIsPlayer pawn calls ShowSelf. If SightCounter is negative/unordered
   and EnemyNotVisible is probed, call CheckEnemyVisible then set SightCounter
   to float32(0.1), even if the helper changed it.
3. Positive ordered PainTime subtracts delta; an unrounded result <0.001 (or
   unordered) clears it before PainTimer. SpeechTime follows the same logic and
   then SpeechTimer, reading any changes made by PainTimer.
4. Current bAdvancedTactics (+318 bit 80000000) dispatches UpdateTactics(delta).

Original constants are 1042ada8=5, 1042ad98=1200, 1042ac40=0.0001,
1042ac20=0.001 and 1042b8e8=0.2 (all doubles). Native event globals are reused
from the original initializer, pinned by the DLL's exported `ENGINE_*` FNames,
with existing checked lookup and probe dispatch.

## Reference scope

37 original references in ignored `.cache/research/actor-tick-original.json`
record the full actor storage through +8ff, call order and callback-time field
values, return value, owner-deferred list effects and weapon relocation input.
They include owner/stasis boundaries, animation before events, both timer
branches, Expired callback behavior, callback-controlled physics, Pawn identity
gates, sight/pain/speech/tactics, view target/weapon handling and local input.

World actor-array iteration, deferred retries and startup are separate from
this per-actor body. Missing renderer timestamps, physics/visibility services,
native object identities or prepared script bodies remain unsupported; no
stand-in idle state or skipped service is admitted to make NPCs appear active.

## Translation and linked runtime

All 37 cases pass the translation, including complete actor-storage comparison,
service ordering, callback-time state, deferred-list effects and return values.
`ScriptRuntime.processActorTick` composes the linked animation fields, original
ProcessEvent/state runtime, timers and native destruction service. Its caller
supplies an explicit level clock value, TickTag and deferred-list head, plus any
reached physics/input/visibility/relocation services. Missing clock/tag/render
timestamps are rejected; they do not silently disable stasis. Renderer timestamps
are only required when the original stasis path reads them.

The focused Training check runs LightSwitch0.Frob and then full standalone
Actor.Tick through this bridge. The original DeusExDecoration.Tick and inherited
Actor.Tick bytecode are prepared. Authored bFloating=false, flyGen=None and
ConListItems=None skip their unrelated branches, and standalone NetMode skips
the final network-only velocity clamp. The original animation completes through
the full tick; successive tags set then clear the linked bTicked bit. Original
property offsets/masks for the admission booleans are checked as well.

Jaime's original helper→main/blend animation→FinishAnim integration still passes.
The bridge does not start NPC states or enroll actors in a new world loop.
The subsequent [level scheduler](script-level-tick.md) now composes this entry
with owner-deferred retries and final cleanup. Its focused two-frame fixture
puts LightSwitch0 before TriggerLight0 as an explicit owner dependency. General
world admission, native host services and NPC startup remain open. The later
[visibility helper integration](script-pawn-tick-visibility.md) supplies original
ShowSelf/CheckEnemyVisible by default, including their LOS worker. Native
validity, clock/BSP/RNG bindings and prepared events are still required when
reached. The focused checks and build pass; no new full sweep is claimed.
