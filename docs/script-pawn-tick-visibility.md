# Pawn visibility helpers reached by Actor.Tick

Original source of truth: hash-checked GOTY Engine.dll,
`APawn::ShowSelf` export `10301014` → body `103c0410..103c05b1` and
`APawn::CheckEnemyVisible` export `103014ce` → body `103c0280..103c03b0`.
Both call the existing [line-of-sight worker](script-pawn-perception.md),
`103024e1` → `103beb50`. This contract was recorded before translation.

## ShowSelf

After entering the level `+1144` profiling scope, validate the shown pawn's
XLevel (`Actor+ac`) actor slot zero as LevelInfo (`1057bf00` class chain).
Read LevelInfo.PawnList (`+54c`) once. For each listener in this live linked list:

1. Skip the shown pawn itself.
2. Compare listener.SightCounter (`+320`) against double zero at `10429838`.
   Only below **or unordered** passes (`FCOM; test ah,1`). Zero does not pass.
3. Require IsProbing(SeePlayer), original probe name index `154`.
4. Call the original LOS worker `(listener, shownPawn, checkFOV=1,
   ignoreDistance=0)`. Its existing enemy/FOV/Stimulus/trace behavior applies.
5. On nonzero return, checked lookup of ENGINE_SeePlayer (`105836ac`) and
   ProcessEvent(listener, SeePlayer, [shownPawn]).
6. Read listener.nextPawn (`+498`) **after** the callbacks. Mutations to that
   link affect this traversal; changes to the head do not restart it.

There is no extra health, role, hidden, detectable or player filter here, and
the helper does not reset SightCounter. Actor.Tick supplies its own shown-pawn
`bIsPlayer && !bHidden` gate. Finish the profiling scope on the shown pawn's
current XLevel. A malformed cyclic list is not silently repaired.

## CheckEnemyVisible

Enter the same profiling scope, then read Enemy (`+3cc`). Null skips all work.
For non-null Enemy, call UObject.IsValid; failure reaches appFailAssert at
source line `6b4`. Reload Enemy, then LOS `(pawn, Enemy, checkFOV=0,
ignoreDistance=0)`. Zero return checked-lookups ENGINE_EnemyNotVisible
(`105836a8`) and calls ProcessEvent with no arguments. Nonzero return stores
the **current double XLevel.TimeSeconds** (`+dc`) as float LastSeenTime (`+3c8`).
The LOS worker separately owns LastSeenPos/LastSeeingPos and other sight fields.
The helper does not probe EnemyNotVisible or reset SightCounter; Actor.Tick
does that before/after calling it. Finish profiling on the current XLevel.

## Boundaries

Re-use the established original LOS contract rather than replacing it with
a guessed visibility test. Probe masks, checked event lookup/dispatch, UObject
validity, linked-list identities and profiling are explicit native boundaries.
The BSP FastLineCheck and RNG services used inside LOS retain their existing
contracts. These helpers do not run NPC startup or implement AICanSee lighting.
Profiling counters are not translated or included in the comparison. The
validity failure test supplies a returning assertion leaf and checks the
original continuation; the runtime rejects the invalid-reference condition
unless the host supplies an explicit assertion handler.

## Original references and translation

`scripts/native-pawn-tick-visibility-oracle.py` executes each complete helper
**and the complete original LOS worker**. Only BSP traces, RNG, probe masks,
validity, checked lookup and script dispatch are controlled boundaries.
Fixtures use zero rotation (original sine/cosine table entries exactly 0/1),
so no transcendental substitution is needed. Reference-only execution preceded
the translation. Engine/Core hashes are checked by the shared native runner.

All 24 cases in `scripts/validate-pawn-tick-visibility.mjs` pass: complete actor
storage, callback-time field bits, ordered trace endpoints/results, RNG
consumption and pawn-list effects. They cover self/empty/listener gates,
unordered SightCounter, disabled probes, FOV/distance/occlusion, the enemy
override, far random gating, callback link/head/counter mutations, timestamp
writes and validity assertion ordering. The translation in
`src/runtime/script-pawn-perception.mjs` calls the existing LOS worker directly.

## Linked runtime

`ScriptRuntime.processActorTick` now defaults to the recovered helpers.
`pawnTickVisibilityServices` supplies original class ancestry, live list links,
probe masks, checked lookup and ProcessEvent, plus the existing BSP/RNG LOS
services. Enemy validity must be explicitly bound; the current scene's attached
identity alone is not presented as original UObject.IsValid. Timestamp writes
require the native numeric double clock, not LevelInfo's reflected float or an
unresolved host clock function.

The Training integration prepares Jaime's original ScriptedPawn.SeePlayer and
inherited Pawn.EnemyNotVisible records and uses canonical NPC/player identities
with the real map BSP. ShowSelf executes the original SeePlayer script; clear
enemy sight writes the original last-seen position/time fields. The linked
class **does not probe EnemyNotVisible**: direct helper dispatch is suppressed
inside ProcessEvent, and Actor.Tick skips that helper without resetting the
counter to 0.1. This behavior is preserved rather than enabling a fabricated
reaction. A controlled player AutonomousProxy tick reaches default ShowSelf and
executes Jaime's SeePlayer callback. Fixtures explicitly isolate global Tick,
startup and player physics/input; they are not full-world admission.
The current player collision view exposes Physics as a getter while its
reflected binding supplies a writer; reconciling that field with the host's
physics state is still needed before general scripted player-physics writes.
The explicit AutonomousProxy fixture does not exercise that unfinished bridge.

The existing prototype AICanSee full-illumination fallback was also removed.
The subsequent [AI lighting recovery](script-ai-visibility.md) now supplies
AIGetLightLevel and AIVisibility, including the cache/movement boost, through
native-705 dispatch. The Training check supplies explicit original Region/time
inputs and verifies the resulting linked cache writes.

Focused checks pass: `node scripts/validate-pawn-tick-visibility.mjs`,
`node scripts/validate-gm-trench-play-anim.mjs`, and `npm run build`.
NPC startup, full-world execution, remaining physics/host services and
visible mesh rendering remain open; no full Stage 3 sweep is claimed.
