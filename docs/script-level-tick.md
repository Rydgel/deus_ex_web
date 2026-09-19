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
