# Original standalone level scheduling

Source: hash-checked GOTY `Engine.dll`, `ULevel::Tick` export `10301104`,
complete body `103a51a0..103a5bb1`. The per-actor contract is in
[Actor.Tick](script-actor-tick.md). This is scheduling infrastructure toward
NPC execution; startup, full-world admission and rendering remain separate.

## Recovered contract before translation

- `Actors` is the live FArray at level `+2c/+30/+34`; `FirstDynamicActor`
  is `+110`. `LoadMap` stable-partitions static/nonstatic actors and records
  this boundary (`1038dd49..1038de0a`). Do not infer it by filtering each tick.
- Entry validates `Actors[0]` as LevelInfo, calls `InitStats`, saves both
  FMemStack marks, initializes runaway detection, and sets `InTick` (`+108`).
  Profiling and an optional level `+f8` service precede simulation time.
  Network/demo dispatch is a separate, unsupported route in this translation.
- `103a5468..103a5487`: multiply float input delta by float TimeDilation
  (LevelInfo `+474`), store float simulation delta, but retain the unrounded
  product for addition to the double level clock (`+dc`). Store that sum as
  double level time and float LevelInfo.TimeSeconds (`+478`). `UpdateTime`
  (`103a08f0`) then calls `appSystemTime` to populate eight calendar fields.
  Thus the clock advances even on paused/time-only ticks, before delta clamps.
- `bPlayersOnly` (`+4f0 & 4`) changes tick type to 1. Delta clamps to float
  `0.005`/`0.4` (`3ba3d70a`/`3ecccccd`); the unordered lower comparison selects
  the minimum. Tick type 0 skips normal actor processing.
- With empty Pauser and a standalone level, `103a55c1..103a5698` reads the
  first viewport's Actor. If it is a PlayerPawn with a Player, snapshot its
  location and write DistanceFromPlayer (`Actor+38`) for every non-null
  dynamic slot. Use extended subtraction, `(dy²+dz²)+dx²`, a double store
  before appSqrt and a float store afterward. All distances precede all ticks.
- `103a5698..103a56cd` clears the deferred head (`+104`) and scans ascending
  indices from FirstDynamicActor, rereading the array/count on each iteration.
  Null slots are skipped. Actor.Tick(delta,type) is called even when bTicked
  already equals TickTag. Appended/replaced slots are visible in the same pass.
  The progress accumulator adds signed return values with 32-bit wrapping.
- `103a56cd..103a570e` retries a snapshot of the deferred linked list only
  when its head and the preceding pass's progress are nonzero. Clear the live
  head/progress before the retry pass; skip entries whose Actor.bTicked equals
  level TickTag. Read each node's next pointer after its callback. New deferrals
  form the next pass. There is no guessed retry cap. A no-progress head can
  remain when stack storage is released; it is not a persistent next-frame queue.
- Nonempty Pauser takes the paused loop (`103a5793..103a58cf`): controlled
  PlayerPawns receive ReadInput(delta), then PlayerInput(delta), then reset
  each FloatProperty with CPF_Input (`flags & 4`) to zero. Iterate class child
  chains derived-first, then base classes. Only the first dword of each property
  is cleared, including fixed arrays. No PlayerTick or ReadInput(-1). Other
  actors tick only if bAlwaysTick (`+1a0 & 0x20`). No deferred reset/retry here.
- `103a5992..103a5a2b`: EventManager.Tick is conditional on a current manager,
  the saved LevelInfo's Pauser **array count being zero**, and tick type 2.
  An allocated empty string can admit normal actors yet suppress this callback.
  The actor admission comparison follows UTF-16 C-string termination, including
  a leading embedded NUL; the manager gate still uses the FString array count.
- `103a5b35..103a5b9f`: TickTag (`+10c`) becomes oldTag==0, InTick becomes 0,
  restore the saved memory marks (including FreeChunks if needed), then call
  CleanupDestroyed(0). Cleanup is after actor/event callbacks and tag changes.

## External boundaries and open work

Actor.Tick, viewport input, script dispatch, property metadata, calendar,
profiling/runaway counters, FMemStack lifetime, optional level service,
EventManager.Tick and CleanupDestroyed are explicit boundaries. Existing
verified actor/cleanup implementations can be composed by the runtime; stubbing
these leaves in an original-DLL scheduler reference does not validate their
internal behavior. The optional level `+f8` service's identity is not yet
established here. Network/demo scheduling remains unsupported. A host must
provide a real actor prefix and prepared callbacks before world enrollment.

## Translation and verification

`scripts/native-level-tick-oracle.py` executes the complete original function,
including original InitStats, UpdateTime, FString comparison and property IsA.
Its controlled Actor.Tick callbacks return explicit integer results and mutate
the live array/deferred list. CRT string comparison, appSqrt, calendar,
script/input, EventManager and final cleanup are declared leaves. No scheduling
instruction is replaced. `scripts/validate-level-tick.mjs` compares 31 cases:
full actor storage, exact double/float clock bytes, callback order and snapshots,
array mutations, list heads and calendar output. Reference-only execution was
established before the scheduler translation.

`src/runtime/level-tick.mjs` translates simulation time and scheduling. The host's
required beginTick/endTick services own entry counters/runaway setup, saved
temporary-memory lifetime and release. Profiling values themselves are not
translated or compared. Calendar is required through updateTime; the exact
Pauser FString allocation count is a separate required service when the
manager gate reads it. Nonfinite clock/coordinate inputs and non-null level
`+f8` services are explicitly unsupported, as are network/demo drivers.

`ScriptRuntime.processLevelTick` supplies linked fields/class ancestry, actual
Actor.Tick, script dispatch, the original FloatProperty/CPF_Input reset and
CleanupDestroyed. The Training integration fixture orders LightSwitch0 before
its explicit TriggerLight0 owner. On each of two frames, the child defers, its
owner ticks, then the child retries; Frob animation completes, bTicked follows
the frame tag, player distances update and cleanup compacts a dynamic null slot.
The fixture supplies a viewport identity and scoped temporary allocation; the
existing Play bridge does not yet own the full original viewport/input loop.
All 15 linked PlayerPawn input floats also pass the reset boundary check.

Focused commands: `node scripts/validate-level-tick.mjs`,
`node scripts/validate-gm-trench-play-anim.mjs`, and `npm run build`.
These checks do not establish complete NPC startup, full-world execution,
native visibility/physics services or final mesh rendering.

## Earlier Play frame timing integration (superseded by batch 5)

Before batch 5, the time calculation was shared through `levelTickTime`: both the complete
scheduler and the bounded Play host used the same extended product, separate
double/float time stores, and actor delta clamp. Play supplies one call per
browser animation frame, with no outer fixed-step accumulator. It publishes
TimeSeconds before actors run and reads the live LevelInfo.TimeDilation.
That change did not enroll additional actors or connect the complete level
scheduler to Play. Batch 5 below replaces that bounded host and expands
`validate-play-frame.mjs` at the integration boundary; the 31 original-DLL
cases above continue to check the shared math.


## Batch 5 Play integration (2026-09-27)

The original references above establish the scheduling contract before this
integration. Play now calls `ScriptRuntime.processLevelTick` on the scene level
itself: the live `Actors` array, LoadMap `FirstDynamicActor`, double clock,
TickTag, deferred head and pending-deletion chain have a single owner. The
browser supplies the input delta once; the returned actor delta also drives
the native HUD. There are no mover, trigger, DataLink, light, NPC, inventory or
mission tick passes. Renderer invalidation observes light/mover fields after
the scheduler; it does not execute script.

At the batch 5 checkpoint the controlled player remained a declared substitute.
Batch 6 replaces that branch with viewport ReadInput, original PlayerInput and
state PlayerTick, reset, ProcessState/timers, Pawn physics and eye update.
Actor.Tick's stasis, owner dependency, bTicked and animation phases still
precede it. The paused branch calls original PlayerInput and resets CPF_Input
floats without advancing player movement; other paused actors receive the
original bAlwaysTick gate. The existing DLL tests cover both branches and
retry order independently of Play. The new input/physics integration and its
remaining limits are in [the player-tick contract](script-player-tick.md).

An actor exception records its identity and freezes the entire frame at an
explicit boundary. Subsequent calls rethrow the same failure until reload;
there is no skip-forever actor list. Startup failure records likewise block
world ticking. Spawn tracking surrounds actual scheduled calls and is only
used for reload bookkeeping.

Native scratch allocation is represented by per-frame JavaScript objects;
profiling counters are not simulated. Calendar values are supplied by the
platform local clock, corresponding to UpdateTime/appSystemTime. Network,
demo, optional +f8 service and EventManager remain explicit boundaries.
Training's Stage-5 event service keeps EventManager null; if a real manager is
installed, its native Tick and exact Pauser FString allocation count must be
provided (the logical string adapter cannot distinguish allocated-empty).

Actor identity remains unified, with two storage adapters: serialized map
actors expose native members bound to VM properties; spawned actors install a
field-backed collision view on the very same script identity. Both occur in
Level.Actors and the collision hash without proxy identities. Falling map
pickups use the existing map MoveActor surface and actorLanded; map decorations
keep the decoration-specific landing callback. See [actor physics](actor-physics.md).

`validate-gameplay.mjs` runs its full Training route, interactions, closing-door
contact and reset through this scheduler. Its older NYC landing/walking case
first asserts the actual full-world boundary and its recorded actor, then
creates a fresh scene for an explicitly isolated retained-player-port check.
That check calls the existing player port against the loaded scene without
advancing world scripts.
It does not establish full-world support for `01_NYC_UNATCOIsland`. Read-only
native-call tracing of the full NYC scheduler identified native 267
(`SetLocation`) in original `ScriptedPawn.PutInWorld`, with receiver
`UNATCOTroop3` (`DeusEx.UNATCOTroop`), reaching the explicit unlinked map-pawn
`FarMoveActor` service. That boundary remains visible in ordinary Play; no
actor is skipped or given substitute movement. The previous NPC failure
suppression had concealed that distinction in the old mixed-map smoke test.

An additional diagnostic attempted NYC reset after that failed frame and
reached a JavaScript stack overflow in LoadMap GC's recursive reference walk
(`script-loadmap-gc.mjs` -> `serializeReferences`). NYC reset was not part of
the old test's coverage and remains unresolved. The isolated fixture does not
claim support for that path. Training's original full-world reset assertions
remain unchanged.

## Animation under TimeDilation in Play (2026-10-08)

Question: does an actor's animation advance by the dilated delta, or by the
page's frame time? The original: `ULevel::Tick` multiplies the input delta by
`LevelInfo.TimeDilation` (`103a5468..103a5487`) and clamps the **actor** delta
to [0.005, 0.4] (`103a54c8..103a54df`, floats `3ba3d70a`/`3ecccccd`) for every
tick (not only `bPlayersOnly`), while `TimeSeconds` adds the unclamped product.
`AActor::Tick`'s animation phase starts with `remaining = DeltaSeconds` and adds
`remaining * AnimRate` to `AnimFrame` per pass
([animation tick](script-animation-tick.md), `103a1bf0..103a1fd2`). So in the
original an actor's animation advances by clamp(frame time x TimeDilation,
0.005, 0.4) per tick: a level "held" at TimeDilation 0.001 still advances every
animation 0.005 s per tick (the capture tool's hold, which also holds the
original's clock), and the animation's phase counts ticks, not clock seconds.
Play's `processLevelTick` is that code (`levelTickTime`: the 31 original-DLL
cases of `validate-level-tick`, including both clamp ends, pass) and ticks once
per posted frame in worker mode (sim-session `begin`), with the worker summing
the dt of merged posts.

`scripts/validate-anim-dilation-play.mjs` (worker mode, paused Playwright
clock, each 16 ms frame settled so the worker never merges): the ghost
player's looping animation and TimeSeconds read before and after N frames at
TimeDilation 1, 0.5, 0.01, 0.001, 0.0001 and 50, against the original's rule
in float32 frame by frame. PASS: the actor delta is 0.016, 0.008, 0.005,
0.005, 0.005 and 0.4; TimeSeconds advances by the unclamped product (+0.192,
+0.096, +0.00192, +0.000192, +0.000019 over 12 frames; +0.8 in one frame at
50); AnimFrame advances by delta x AnimRate to within 2e-6 in every row
(+0.096, +0.048, +0.03, +0.075, +0.075 and +0.5). Play is right; the
animation phase in a held capture differs run to run only because the held
level still ticks the animation once per frame the page ran
([visual acceptance](visual-acceptance.md#cpu-and-gpu-mesh-paths-jcs-reflection-2026-10-08-a-capture-artifact-fixed-in-the-tool)).

