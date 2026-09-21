# LoadMap shared startup scheduler

`UGameEngine::LoadMap` (Engine.dll image base `0x10300000`, body
`0x1038c1f0`) does not run `InitExecution` plus the five startup events per
actor. It runs one dedicated pass per step over the live `ULevel::Actors`
TArray, with native operations between the event passes. This page records
the recovered pass structure, the array-mutation semantics, what the Play
host implements, and the branches still unsupported.

## Recovered pass structure

Every pass loop reloads `engine.Level(+0x68).Actors` data pointer (+0x2c)
and Num (+0x30) per iteration and advances by index, skipping null slots —
it is never a snapshot. An actor appended during a pass is reached by that
same pass; a destroyed actor's cleared slot drops it out of every later
pass.

| Order | Operation | Range | Notes |
| ----- | --------- | ----- | ----- |
| 0 | Touching[0..2] clear | `0x1038d7f7-0x1038d824` | Writes `actor+0xe8..+0xf0`; `Touching[3]` untouched. Inside the `bBegunPlay`-not-set branch (`0x1038d6f6`). |
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

Admission stays explicit: the event passes dispatch only to map
pawn-ancestry and map `PatrolPoint`-ancestry actors (`startupAdmitted`),
while the native passes apply to every map actor plus actors the startup
passes themselves spawn (`startupNative`) — the set the original would
have had in the array. Other classes remain unadmitted, not approximated.

### Spawned actors during a pass

Pawn startup spawns (each NPC's `Shadow`) append to the live array inside
`PreBeginPlay`; `collectSpawned` tracks the tail after each dispatch so the
same pass reaches them (they are unadmitted for the event chain — their
`SpawnActor` chain already ran — but the native passes do visit them).

### Base fixup dispatches

AttachTag and `FindBase` run the recovered `SetBase`/`SupportActor`
callbacks through `runtime.dispatchSpawnedEvent`, which resolves the
receiver's own overrides (`DeusExDecoration.BaseChange` et al.); the
Decoration/Inventory class chains are prepared at load for this reason.
A BSP hit (`LevelInfo`) is un-based again like the original.

## Renderer `LastRenderTime` accommodation

The `-10` write makes serialized `bStasis`/`bForceStasis` actors
stasis-eligible (`actorInStasis`, `src/runtime/actor-tick.mjs`). In the
original, `URender::DrawWorld` re-stamps `actor+0x34` for every drawn actor
and the zone stamps update through the same path — the browser host draws
the whole level every frame, so `doors.tick` stamps every live actor with
the current `TimeSeconds` at the top of the tick. Without it, no renderer
ever refreshes the baseline and bStasis pawns would stay gated forever.
Fixtures that bypass the doors tick must supply both stasis inputs
(`zoneLastRenderTime`, `DistanceFromPlayer`) explicitly.

## Remaining gaps

* `Game->InitGame(Options, Error)` — in the original the GameInfo is
  spawned inside LoadMap before this call. This host's `LevelInfo.Game`
  holds the live DataLink fixture object, not an original GameInfo, so the
  branch is documented and skipped rather than dispatched on the stub.
* Non-pawn/non-PatrolPoint event admission — the original dispatches to
  every slot; expanding admission requires each class's startup bodies to
  be prepared and verified.
* The `IsServer` client-only pass and all net-mode branches are unwired by
  design (standalone only).
* A per-actor/per-zone render pass does not exist; the whole-level
  LastRenderTime stamp is the host accommodation described above.

Focused mechanics tests: `test/script-loadmap-startup.test.mjs` (null-slot
skipping, mid-pass array reassignment, shrink, append visibility, head-slot
preservation, compaction, static ordering, `iFirstNetActor`). Integration:
`scripts/validate-secretary-patrol.mjs` (load+reset patrol through the
shared passes), `scripts/validate-map-actor-admission.mjs` (partition-aware
admission), `scripts/validate-world-destroy.mjs` (destroyed-ledger restore
after partitioning).
