# LoadMap shared startup scheduler

`UGameEngine::LoadMap` (Engine.dll image base `0x10300000`, body
`0x1038c1f0`) does not run `InitExecution` plus the five startup events per
actor. It runs one dedicated pass per step over the live `ULevel::Actors`
TArray, with native operations between the event passes. This page records
the recovered pass structure, the array-mutation semantics, what the Play
host implements, and the branches still unsupported.

Engine.dll SHA-256:
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.

## Recovered pass structure

Every pass loop reloads `engine.Level(+0x68).Actors` data pointer (+0x2c)
and Num (+0x30) per iteration and advances by index, skipping null slots —
it is never a snapshot. An actor appended during a pass is reached by that
same pass; a destroyed actor's cleared slot drops it out of every later
pass.

| Order | Operation | Range | Notes |
| ----- | --------- | ----- | ----- |
| 0 | Touching[0..3] clear | `0x1038d7f7-0x1038d824` | Writes all four slots at `actor+0xe8..+0xf4`; EAX increments before each store. Inside the `bBegunPlay`-not-set branch (`0x1038d6f6`). |
| 1 | `InitExecution` | `0x1038d869-0x1038d885` | UObject vtable +0x38 on each live actor. |
| 2 | `ULevel::IsServer` client pass | vtable +0x84 | Standalone (netMode 0) is a server; the client-only Role swap/destroy loop never runs. |
| 3 | `bBegunPlay \| bStartup` | `0x1038d885-0x1038d899` | `LevelInfo+0x4f0 |= 0x42`. Cold path also zeros `ULevel+0xdc/+0xe0` and `LevelInfo+0x478` (`TimeSeconds`). |
| 4 | `Game->InitGame(Options, Error)` | `0x1038d897` region | Only when `LevelInfo.Game` is set; see gaps below. |
| 5 | `PreBeginPlay` | `0x1038d99a-0x1038d9cc` | ProcessEvent name global `0x1058364c`. |
| 6 | `BeginPlay` | `0x1038d9ce-0x1038da02` | Name global `0x10583650`. |
| 7 | `SetActorZone` | `0x1038da02-0x1038da26` | ULevel vtable +0xac, `(actor, test=1, force=1)` — callbacks suppressed, Region rebuilt from PointRegion. |
| 8 | `LastRenderTime = -10.0f` | `0x1038da26-0x1038da45` | Unconditional write to `actor+0x34` on every live actor, zones included. |
| 9 | `PostBeginPlay` | `0x1038da45-0x1038da79` | Name global `0x10583648`. |
| 10 | `SetInitialState` | `0x1038da79-0x1038daad` | Name global `0x10583620`. |
| 11 | Base fixup | `0x1038daad-0x1038dbe0` | AttachTag bind, then `FindBase` for `Base==NULL && bCollideWorld && Physics in {0,5}` gated on `IsA` Decoration (`0x10578d48`), Inventory (`0x10576f70`), Pawn (`0x1058c660`). |
| 12 | `bStartup` clear | `0x1038dbe0` | `LevelInfo+0x4f0 &= ~0x40`. |
| 13 | `PostPostBeginPlay` | `0x1038dc65-0x1038dc9d` | Name global `0x10583644`. |
| 14 | Actor partition | `0x1038dcd5-0x1038de5x` | Rebuilds the array as `[slot 0, slot 1, ...non-null statics, ...non-null dynamics]`; `Level+0x110` (`iFirstNetActor`) = write count after the static section. |

Slot semantics of the tail: slots 0 and 1 are copied verbatim — slot 1 keeps
a null when one is there — and every later slot is compacted, so
refused-export nulls and actors destroyed mid-startup drop out of the live
array. Within each group the original relative order is preserved; spawned
(dynamic) actors appended during startup land after the serialized dynamics.

`SpawnActor` runs its own unconditional event chain (`InitExecution` →
`PreBeginPlay` → `BeginPlay` → zones/`LastRenderTime` → `PostBeginPlay` →
`SetInitialState` → base/`PostPostBeginPlay` tail, `0x10395559` region); it
has no `bBegunPlay`/`bStartup` gate. An actor spawned mid-pass therefore
arrives already started and is re-dispatched by the still-open LoadMap pass
— the original's real behavior, not a bug to suppress.

## Host implementation

`src/runtime/script-loadmap-startup.mjs` holds the two array primitives:

* `forEachLiveActor(level, body)` — index-advancing pass that rereads
  `level.actors` and its length each iteration (the TArray data pointer +
  Num rereads), skipping null slots. Reassigning the array mid-pass is
  observed exactly like the original's reload; appends extend the pass.
* `partitionActorArray(actors, isStatic)` — the tail rebuild; returns the
  rebuilt array plus `firstNetActor`. The caller writes
  `level.actors`/`level.iFirstNetActor`.

`src/runtime/script-doors.mjs` `resetNpcs()` runs the schedule above on
every load/reset after the serialized-state restore: Touching clear →
InitExecution → flags → PreBeginPlay → BeginPlay → SetActorZone →
LastRenderTime → PostBeginPlay → SetInitialState → base fixup →
`bStartup` clear → PostPostBeginPlay → partition → the player's
`AddPawn` head-insert (SpawnPlayActor runs after LoadMap in the original).

Every admitted serialized actor now receives every event pass. Actors appended
by startup callbacks receive the remaining passes too, including the pass that
appended them. The existing player and its post-load subsystem identities are
kept outside this map pass until real SpawnPlayActor integration is complete.
`InitExecution` and native passes use the same set.

### Spawned actors during a pass

`collectSpawned` tracks actors appended during each dispatch. `DeusExLevelInfo`
now creates Mission00 through its original PostBeginPlay/SpawnScript; the host
only prepares and locates it. TriggerLights and movers enter their initial
states through the shared SetInitialState, with no separate host startup.
LevelInfo.PreBeginPlay now owns InitEventManager too.

Training's PickupDistributor0 runs its original PostPostBeginPlay: distribute
NanoKeys to tagged ScriptedPawns, then Destroy(). It receives every pass before
its final self-destruction; the array partition correctly retains 311 of the
312 admitted serialized actors. Validators must not equate export admission
with survival after original startup.

### Base fixup dispatches

AttachTag and `FindBase` run the recovered `SetBase`/`SupportActor`
callbacks through `runtime.dispatchSpawnedEvent`, which resolves the
receiver's own overrides (`DeusExDecoration.BaseChange` et al.); the
Decoration/Inventory class chains are prepared at load for this reason.
A BSP hit (`LevelInfo`) is un-based again like the original.

## Review contracts — 2026-09-21

The clear loop increments EAX before storing at `actor+eax*4+0xe4`
(`0x1038d811`, `0x1038d818`). EAX reaches 1, 2, 3 and 4: all four
Touching slots at `+0xe8..+0xf4` clear. Executing the original loop with
`[111,222,333,444]` produces `[0,0,0,0]`; the initial three-slot translation
was wrong.

A browser reset emulates a fresh map reload. It must restore the authored
actor-array prefix (including nulls) before the first shared pass. Reusing
the previous run's partition changes callback order: Training Secretary0
precedes PatrolPoint4 on load but followed it on reset. Player/subsystem
identities that persist in this host stay in the appended tail; tracked NPC
spawns are destroyed before restoring that prefix.

Render.dll SHA-256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`
establishes two distinct writes. `0x10b25150..0x10b25161` copies the
LevelInfo float TimeSeconds (`+0x478`) to the drawn actor's LastRenderTime
(`+0x34`). `0x10b1766d..0x10b1768d` writes that float to
`Model+0x108+24*zoneNumber`, not to the ZoneInfo actor's LastRenderTime.
`FZoneProperties` serialization (`0x103aed30`) reads the actor reference
and two masks but leaves the transient timestamp out; fresh zero-initialized
model storage supplies its initial zero. The original stasis reader and
its controlled original-DLL cases already use this separate model slot
([Actor.Tick](script-actor-tick.md)).

The browser must report actual actor draw submissions; simulation ticks,
headless execution, hidden meshes and frustum-rejected meshes cannot refresh
an actor timestamp. The current renderer lacks original BSP/portal zone
visibility, so it must leave model zone stamps unrefreshed instead of
fabricating a recent draw for the whole level. Actor draw feedback does not
establish original visibility/occlusion fidelity.

## Renderer feedback

`src/viewer/actor-render-feedback.mjs` copies the current LevelInfo float
clock from a mesh's `onAfterRender` callback. `main.mjs` installs it on
actor-backed world meshes (currently movers); `npc-mesh-preview.mjs`
installs it on each NPC mesh. Hidden actors, hidden parents and meshes
rejected by the view frustum receive no submission callback. Headless
`game.tick()` leaves timestamps alone. This replaces the incorrect blanket
tick write, which refreshed even Training's 311 hidden actors and defeated
the original stasis gate.

`player-scene.mjs` owns separate transient model-zone timestamp storage,
initialized and reset to zero. The NPC tick adapter reads it through
Region.ZoneNumber. Original BSP/portal visibility and its zone writes remain
unimplemented. Headless movement fixtures explicitly provide draw feedback
for the actor they observe continuously; they do not establish original
camera visibility. The original Actor.Tick stasis conditions stay enabled.

## Remaining gaps

* `Game->InitGame(Options, Error)` — in the original the GameInfo is
  spawned inside LoadMap before this call. This host's `LevelInfo.Game`
  holds the live DataLink fixture object, not an original GameInfo, so the
  branch is documented and skipped rather than dispatched on the stub.
* The `IsServer` client-only pass and all net-mode branches are unwired by
  design (standalone only).
* The browser's draw submissions supply actor render timestamps, but original
  BSP/portal visibility and model-zone timestamp updates remain unsupported.
  Non-rendered actors can therefore enter stasis in cases where original
  visible-zone feedback would keep them active.

Focused mechanics tests: `test/script-loadmap-startup.test.mjs` (null-slot
skipping, mid-pass array reassignment, shrink, append visibility, head-slot
preservation, compaction, static ordering, `iFirstNetActor`). Integration:
`scripts/validate-secretary-patrol.mjs` (load+reset patrol through the
shared passes), `scripts/validate-map-actor-admission.mjs` (partition-aware
admission), `scripts/validate-world-destroy.mjs` (destroyed-ledger restore
after partitioning).

Review boundaries: `scripts/validate-loadmap-startup.mjs` executes the
original Touching clear loop and actor timestamp store through
`scripts/native-loadmap-state-oracle.py`, then checks fresh/reset pass order,
the fourth contact slot, hidden headless actors, stasis, draw feedback and
zone-storage reset. `browser-tests/render-feedback.spec.mjs` exercises actual
WebGL submissions, hidden actors/parents and frustum rejection.

## Batch 3 startup boundary research (2026-09-25)

Before widening the shared passes, the installed `Engine.Mover.BeginPlay`
body establishes KeyNum/PhysAlpha, calls `Move(BasePos + KeyPos[KeyNum] -
Location)`, then `SetRotation(BaseRot + KeyRot[KeyNum])`. The missing Move
service is an integration boundary to the already recovered scene brush move,
not a reason to omit movers. Nontranslation brush branches remain unsupported.
`DeusExLevelInfo.PostBeginPlay` calls `SpawnScript`; its original
`AllActors(MissionScript)` dedup and Spawn own mission creation. The shared
live-array passes must reach that new actor, including PostPostBeginPlay, so
the host must cease spawning it and dispatching that event separately.
TriggerLight BeginPlay/SetInitialState likewise belong to the shared passes.

`AActor::ProcessState` checks the frame pointer at `0x103e5b85-0x103e5b8d`
and frame.Code (+0x0c) at `0x103e5b93-0x103e5b96`, returning at
`0x103e5cfe` if either is null, **before** reading frame.LatentAction at
`0x103e5bfb-0x103e5c03`. InitExecution's untouched +0x24 therefore must
not be read when no state code exists. This is an original control-flow
condition; zero-initializing the latent slot would hide the missing guard.
