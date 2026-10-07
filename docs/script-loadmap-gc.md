# Player start: LoadMap retires and collects the previous level

"Player start" is `UGameEngine::LoadMap` loading the map that is already
loaded, followed by SpawnPlayActor. This note records what LoadMap does to
the previous level's objects, from the original instructions, and how Play
reproduces it on its in-place reload. Evidence was recovered on 2026-09-26
from the hash-pinned GOTY DLLs checked by `scripts/validate-loadmap-gc.mjs`:

| DLL | SHA-256 |
| --- | --- |
| Core.dll | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| Engine.dll | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` |
| Extension.dll | `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c` |
| DeusEx.dll | `b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04` |
| ConSys.dll | `f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa` |

Addresses are preferred image addresses. The validator pins every body range
cited below by SHA-256, the key instructions inside them, the imports they
call and the vtable slots that select each Destroy override.

## Summary

At Player start N, the reload does the following:

1. It destroys player N-1 through `ULevel::DestroyActor`, in the old world,
   before anything loads. The player's script `Destroyed` chain runs, and
   `ConditionalDestroy` reaches `ADeusExPlayer::Destroy` outside a collection.
   That destroys its FlagBase and its root window tree.
2. It replaces every map export in place. Each keeps its address and
   GObjObjects index.
3. Its `CollectGarbage(RF_Native)` purges every object the old level spawned,
   including player N-1's whole graph.

The retired generation is therefore collectable at the same reset, not at a
later one. The corrected claim is that `Viewport.Actor` does not keep the old
player alive. LoadMap nulls it and destroys the player before the collection.
It also tags every old-package actor that the reloaded `Actors` array does
not hold with the collector's exclusion bit, whatever still references it.
At most one generation is live.

## LoadMap before the load (`0x1038c1f0` body)

| Range | Operation |
| --- | --- |
| `0x1038c50b..0x1038c51d` | `Viewports(0).Actor+0x69c &= ~0x200000` (a PlayerPawn bool) |
| `0x1038c527..0x1038c59b` | `PaintProgress` (vtable `+0xb8`, `0x10302211`), audio viewport refresh, `LevelInfo.LevelAction` (`+0x510`) = 0 |
| `0x1038c5fd..0x1038c6b0` | Verify load: `BeginLoad`, `StaticLoadObject(ULevel, MapParent, "MyLevel", URL.Map, 0x1a)`, `EndLoad` |
| `0x1038c6c4..0x1038c6cf` | If GLevel: `NotifyLevelChange` (vtable `+0xc4` → `0x10301e47` → `0x1038c110`) |
| `0x1038c6d5..0x1038c731` | For each Client viewport: `Actor.Player` (`+0x5d4`) = 0, `Viewport.Actor` (`+0x30`) = 0, `Actor.XLevel` (`+0xac`)`->DestroyActor(Actor, 0)` (ULevel vtable `+0x94` → `0x10302568`) |

`UGameEngine::NotifyLevelChange` (`0x1038c110`) dispatches the
`NotifyLevelChange` script event (FName `0x341`) to `Viewports(0)->Console`
(`+0x34`) when the Client, its first viewport and that console exist.
`Engine.Console.NotifyLevelChange` sets `bRestartTimeDemo` and calls
`ClearMessages`.

The dissociation loop dereferences `Actor` without a test. `DestroyActor`'s
class/network gate (`0x10395c59..0x10395cd8`) is now resolved:

* A receiver that is not an `APlayerPawn` skips the gate.
* For an `APlayerPawn`, a null `Player` (`+0x5d4`), which LoadMap guarantees,
  or a `Player` that is not a `UNetConnection` continues on the normal path.
* Only a `UNetConnection` with channel 0 (`+0xe64`) open and `State`
  (`+0x60`) other than `USOCK_Closed` (1) is diverted: it closes that channel
  (vtable `+0x5c`) and returns 0.

The rest of `DestroyActor` is the path documented in
[Actor.Destroy](script-destroy.md). The old player's `Destroyed` chain runs
`DeusExPlayer.Destroyed`, `PlayerPawn.Destroyed` and `Pawn.Destroyed`. That
chain destroys its Shadow, inventory and PRI, calls `RemovePawn` and
`Level.Game.Logout`, and sends `Killed(None, Player, '')` to every pawn on
`Level.PawnList`. The Owner scan then detaches its subsystems.
`ConditionalDestroy` reaches the player's Destroy virtual (below) with
`GObjInGarbageCollection` clear.

## LoadMap unloads and reloads (`0x1038c799..0x1038c911`)

`ResetLoaders(GLevel.Outer, 1, 0)` (import `0x10599f30`, Core body
`0x10155750`) walks the loaders from last to first. For the package's
linker, the DynamicOnly branch calls `DetachExport` (`0x101022b6`) on every
export whose class lacks `CLASS_RuntimeStatic`. That is `0x80` at
`UClass+0x484`. LoadMap then deletes BrushTracker (`+0xfc`), NetDriver
(`+0x3c`) and DemoRecDriver (`+0x88`). The `?push` option would call
`CleanupDestroyed(1)` and `SavePackage`. Finally GLevel is set to null.

`GLevel = StaticLoadObject(ULevel, MapParent, "MyLevel", URL.Map,
LOAD_NoFail)` reloads the map into the same package object. Core
`StaticAllocateObject` (`0x101579c0`, `0x10157c51..0x10157e9e`) finds each
existing export with the same class, Outer and name. It then does the
following:

1. It logs `Replacing`.
2. It keeps `flags & 0x0c000000` and the object index.
3. It runs the complete destructor in place (vtable `+0x0c` with 0).
4. It asserts that `GObjAvailable.Last()` is that index, and pops it
   (`FArray::Remove`, `0x10157e99`).

Every reloaded export therefore keeps its address and GObjObjects index.
Objects the old level spawned are not exports, so they are untouched here.

## LoadMap's collection (`0x1038d0ee..0x1038d1e1`)

The collection is skipped when the loaded package is `Entry`. Otherwise
LoadMap calls `Flush(0)` (vtable `+0x6c`), then:

```text
for (TObjectIterator<AActor> It; It; ++It)          // 0x1038d108..0x1038d1bb
    if (It->IsIn(GLevel->GetOuter())) It->ObjectFlags |= 0x400;
for (i = 0; i < GLevel->Actors.Num(); i++)          // 0x1038d1bd..0x1038d1dc
    if (GLevel->Actors(i)) GLevel->Actors(i)->ObjectFlags &= ~0x400;
UObject::CollectGarbage(RF_Native = 0x04000000);   // 0x1038d1dc..0x1038d1e1
```

`0x400` is the collector archive's exclusion bit (Core `0x1015ec90`,
[Core garbage collection](script-gc.md)). A reference to a tagged object is
written back as null and never marks it. After the reload, the old package
still contains the actors the old level spawned. The new `Actors` array does
not hold them, so all of them are unreachable, and so is anything only they
reached (FlagBase, flags, logs, histories, text parsers).

`CollectGarbage` (`0x10158500`) constructs the mark archive, runs
`SerializeRootSet(Ar, RF_Native, 0x40)` and then `PurgeGarbage`
(`0x101581f0`). With NOGC clear, PurgeGarbage works as follows:

1. It sets `GObjInGarbageCollection` (`0x102a264c`) to 1.
2. Pass 1 walks GObjObjects in index order. It counts every non-null slot
   and calls `ConditionalDestroy` on each object with `0x2` set, skipping
   `0x04000000` objects unless the registrants gate `0x101e559c` is set.
3. Pass 2 re-reads the slot and the count on every iteration. It calls
   vtable `+0x0c` with 1 (the scalar deleting destructor) on each object with
   `0x2` set and without `0x04000000`.
4. The name pass calls `FName::DeleteEntry` on each unmarked name without
   `0x04000000`, in GNames order.
5. It clears `GObjInGarbageCollection`.

Each destructor's `~UObject` (`0x10150040`) appends its slot to
GObjAvailable. Pass 2 therefore leaves the freed slots in ascending order,
and `AddObject` (`0x10157830`) pops the last one. The reload's first spawn,
its GameInfo at `0x1038d59d`, reuses the highest freed slot.

FName::StaticInit hardcodes `None` as entry 0 with flags `0x04000400`
(`0x1014bc26..0x1014bc3d`) and the following hardcoded names with
`0x04000000`. The name pass never deletes them.

## Destroy overrides on this path

`ConditionalDestroy` calls vtable slot `+0x24`. Of every native Actor class
the construction registry admits, only these two override it:

* `ADeusExPlayer` (DeusEx vtable `0x10027568`, `0x100141f0`) makes three
  explicit stores (`0x10014216..0x10014222`) and then calls
  `APlayerPawnExt::Destroy`. By the retail property offsets, the stores null
  `conHistory` (`+0x9fc`), `FirstLog` (`+0xa50`) and `LastLog` (`+0xa54`).
  The SDK header names differ by one member.
* `APlayerPawnExt` (Extension vtable `0x1005c32c`, `0x10037d40`):
  * With `GObjInGarbageCollection` clear and a FlagBase at `+0x890`, it calls
    `ConditionalDestroy(flagBase)` without clearing the pointer. Otherwise it
    nulls `+0x890`.
  * It passes a non-null `rootWindow` (`+0x894`) to `XWindow::SafeDestroy`,
    nulls `+0x894`, and runs `AActor::Destroy`.

The other actors use `AActor::Destroy` (`0x10368f60`). It
ConditionalDestroys a non-null `RenderInterface` (`+0x314`), clears it and
calls `UObject::Destroy`. The remaining classes on this path are:

| Class | Destroy (`+0x24`) | Behavior |
| --- | --- | --- |
| XFlagBase (`0x1005c20c`) | `0x100239f0` | `UObject::Destroy`, then each of 64 buckets (`+0x28`) drained by `RemoveFlag` `0x10023a80`: unlink the head, zero its next `+0x34` and flagBase `+0x30`. No script runs. |
| XRootWindow (`0x10059cc4`) | `0x10039320` | `XWindow::Destroy`. CleanUp (`+0x58`, `0x10039240`) unlinks the root from the root-window list (global `0x100aa8f8`, next `+0x58c`; the removed root keeps its next). It clears `pawn+0x894` only while it still names this root, then calls `RemoveFromRoot` and `XModalWindow::CleanUp`. `~XRootWindow` (`0x100059c0`, deleting `0x100067b0`, size `0x744`) has no root-only members. |
| DumpLocation (`0x10027f94`) | `0x10015120` | `CloseDumpFile` (`0x100159d0`: a non-zero `dumpFile` `+0x9c` is closed, then `dumpFile`=0, `currentDumpLocationIndex` `+0x8c`=-1, `dumpLocationCount` `+0xa0`=0). Each `dumpFileDirectory` (`+0x7c`) FString is emptied and destroyed and the array is zeroed. `player` (`+0xa4`) is zeroed, the scratch block in `currentDumpFileLocation` (`+0x28`) is freed and zeroed, then `UObject::Destroy`. |
| ConHistory (DeusEx `0x10027fe8`) | jmp ConSys `DConHistory::Destroy` `0x1000ca20` | For each event from `firstEvent` (`+0x50`), it reads `next` (`+0x44`), then calls the event's scalar deleting destructor with 1. `firstEvent` is left set. Then `UObject::Destroy`. |
| ConHistoryEvent (`0x1002803c`), DeusExLog (`0x10027ad0`) | jmp `UObject::Destroy` | — |
| LaserIterator (`0x100283d0`), ParticleIterator (`0x10027a14`) | `0x1001aec0`, jmp `UObject::Destroy` | Built by SetupDynamics as an actor's `RenderInterface` ([particles](particles.md), "Iterators"). Pass 1 reaches each one from its actor's `AActor::Destroy` or on its own, whichever comes first in index order. The deleting destructors (`0x1001a9c0`, `0x1000d540`) run `~Class`: ConditionalDestroy, the URenderIterator vtable, ConditionalDestroy, `~UObject`. Then they call `??3UObject`, the ordinary release tail below. |

None of the complete destructors checked here destroys another UObject:
`~XFlagBase` (`0x1001b530`) and `~APlayerPawnExt` (`0x1001c150`) only
guard-call `ConditionalDestroy` and free their own members.

## Play's reload

`game.reset()` first calls `retirePlayer()` in `script-doors.mjs`. That
dispatches `NotifyLevelChange` to the viewport console, clears `Player` and
`Viewport.Actor`, and destroys the player through the live `DestroyActor`.
The world-destroy eligibility boundary admits exactly this player, a
PlayerPawn whose `Player` is None; other Pawns stay refused. The InfoLink
shell's merged window lifecycle routes each destroy service by the window's
storage owner.

The host then restores map exports in place. Play keeps their identities,
which matches StaticAllocateObject keeping their address and index. The
reloaded `Level.Actors` holds the map exports only. Before the GameInfo
spawn, `createLevelCollection().collect()` (`script-level-collection.mjs`)
runs the recovered order through `script-loadmap-gc.mjs` and `script-gc.mjs`:

* **Registry.** The modeled GObjObjects is the construction registry. It
  holds every runtime-constructed object plus the host's four
  package/level records.
* **Tag.** Every registry actor whose Outer chain reaches the level package
  gets `0x400`. The tag is cleared again for each entry of the reloaded
  `Level.Actors`.
* **Mark.** This is a projection of `SerializeRootSet`. The root array is
  the transient package (Core `StaticInit` `0x10152832..0x10152843` calls
  `AddToRoot` on it), plus an engine stand-in for GLevel and the client
  viewports, plus the persistent package records. The level record
  serializes its Outer and its `Actors`. Every other object serializes its
  Name, its header Outer and the reflected references `UStruct::SerializeBin`
  visits (`ScriptRuntime.serializeReferences`). An object outside the
  registry, such as a map export whose slot is unmeasured, is walked once as
  a persistent object. References the exclusion bit nulls are reported in
  `excluded`; the in-place reload leaves none.
* **Purge.** `purgeGarbage` runs the two object passes and the name pass
  over the host FName table. `runtime.garbageCollecting` is
  `GObjInGarbageCollection`.
* **Release.** ConListItem (`0x10002ed0`) and DeusExTextParser
  (`0x10004820`) use their recovered deleting destructors. For every other
  class, the per-level `ConditionalDestroy` calls are no-ops after pass 1,
  and the class member teardown frees native storage the host does not
  have. `~UObject` (unhash, slot clear, GObjAvailable append, state frame)
  and `??3UObject` are the observable tail.
* **Host cleanup.** A released object leaves the host's identity map and the
  window heap's handle table. `runtime.isReleased` lets host caches (the
  weapon view model) drop released identities, and any other access throws.

Measured on Training (`scripts/validate-loadmap-gc.mjs`, 22 Player starts):

* Every reset released the old generation: 243 objects, 130 of them tagged
  actors.
* The registry stayed at 247 live objects in a 247-slot array.
* The FName table stayed at about 251 entries.
* The window heap's high-water mark stayed at `0x15c8c`.
* JS old space grew 0.3 MiB over 19 resets; the remaining growth is V8 code
  space.
* The Stage 3 conformance gate keeps the same results. Standalone, its
  peak RSS fell from 2832 MiB to about 2.0–2.5 GiB. In the 4-job sweep it now
  completes at a 5.4 GiB runner footprint, where it was killed at the
  6144 MiB cap (6191 MiB) before.

Measured on 01_NYC_UNATCOIsland after Play has drawn frames
(`scripts/validate-island-player-start.mjs`): the page's sprite scan built 8
LaserIterators and 4 ParticleIterators. Each of two Player starts, taken
while the opening InfoLink plays, released all 12, and the next frames built
12 new ones. A ParticleGenerator is a pre-placed export: the in-place reload
restores its `RenderInterface` to None, so its old iterator is unreachable.
Before the iterators had their constructor and Destroy, Player start stopped
in pass 1 ("Object destruction requires its native virtual hook"). The reset
was left half done, and the HUD snapshot then read a destroyed window.

## Not modeled or unverified

* LoadMap's presentation steps are not run: PaintProgress/LevelAction, the
  audio refresh, and the `+0x69c` bit on the old player (which is destroyed
  immediately after).
* The mark is a projection. Play's registry has no records for map exports
  (their slots are unmeasured), classes, resources, windows or XFlag nodes,
  so none of these is collectable in Play. XFlag::Destroy (`0x10023870`)
  never runs for the drained flags, and window UObject slots are not
  modeled; the window heap frees their bytes instead.
* Native-only UObject pointers outside reflected properties are not
  serialized, except ULevel's `Actors` and the UObject header.
* It is unmeasured whether the original collection unloads DeusExConText.
  Play keeps it as a persistent package and restores its conversation
  objects (the mission list's whole loaded graph,
  [binding](script-conversation-binding.md#loaded-graph)) to their load
  baseline.
* The in-place replacement's complete destructor on each old export (vtable
  `+0x0c` with 0) is not run. Play restores the export's serialized state
  instead.
* An open dump file in `UDumpLocation::CloseDumpFile` is an explicit
  boundary, because Play never opens one.
* Play's registry indices are host-local. Only
  `scripts/validate-object-index-model.mjs` seeds a registry at the measured
  GObjObjects state; there, the LoadMap purge frees runtime slots in index
  order and reuses the highest first.
