# The first frames after a map's load

Host performance only: what the game computes is unchanged by anything below (every digest in "Checks" is equal to the one
before). The levels are loaded in Play, the first frames are long, and the user feels it at every map load.

## The problem

On the Island (`01_NYC_UNATCOIsland`, Chromium, worker mode, Linux host) the worker's first frames of Play, from the hitch log, were

| run | first worker frames (ms) | over 50 ms in the first 5 s |
|---|---|---|
| `merge-check/round11` | 342, 169, 144, 58, 31, 22 | 4 |
| this tree before, 3 runs | 271 114 53 34 22 · 259 128 48 30 17 · 268 93 63 34 28 | 3, 2, 3 |

and the `w.tick` column was nearly all of each of them (no GC in them). A steady Play frame is 10 to 16 ms. Headless
(`node scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --warm 0 --ticks 12`), tick 0 is 265 to 308 ms, then 26 to 31, 17, 13, 14, 11.

The first tick is not cold JavaScript. Booting the same map three times in one process (`createGame` again, a warm V8) gives
tick 0 at 299, 259 and 218 ms: the work is the level's, and the second and third frames in the browser are the first tick's
shadow, not extra work of their own: a worker frame that takes 300 ms makes the page post thirteen frames that merge into
the next one with their dts summed (0.217 s; the 0.4 s clamp is the level's), and a tick with that dt costs 60 to 140 ms
(falling pawns subdivide with it; the landings run script) before it posts the next dt.

What the first tick is (Island, `SCRIPT_VM_STATS`, `--script-profile`, `RIDER_STATS`, `--tickstats`; pawns are 200 of the 300 ms):

* 172 `SpawnActor` calls from the pawns' first state code (their starting inventory: 29 Terrorists, 10 UNATCOTroops, ... each
  with weapons and ammo; 157 `Inventory.GiveTo` and 152 `Pawn.DeleteInventory` calls in the same tick). A spawn is 0.3 to 0.5 ms: object storage and its class image, the
  PreBeginPlay/BeginPlay/PostBeginPlay chain, the collision view, the zone, the encroachment check.
* The first `MoveActor` of 45 pawns with inventory, each of which scanned all 2,431 slots of `Level.Actors` for its based riders
  (`js_move_riders`, 112,632 `Base` reads, 34 ms).
* 274 calls of `ScriptedPawn.ChangeAlly` (the pawns' alliances), 70 us each, 26 ms.
* 63 class-image builds, 18 ms, for 20 classes: the weapons' script writes `Default.MPPickupAmmoCount` in every spawn.
* 177 script functions lowered to the Rust VM on their first run (24 ms; 24 of them again after a field registered, 3.6 ms).
* Everything else is spread thin: the first `describe` of 767 actors (14 ms), `FarMoveActor`, `SetBase`, landings.

## Tools

* `bench-sim.mjs --warm 0 --ticks N` times the level's first ticks; the report has `firstTickMs`, and `--dts 0.0167,0.34,0.17`
  gives the first ticks the dts they have in the browser after a slow one. `--digest-every 1` hashes the actors after every tick.
* `hitch-run.mjs --load-profile [FRAMES]` takes a CPU profile of the simulation worker from the end of the map's load to its
  FRAMES-th frame (`--worker-profile` starts after the settle, too late), saved as `<out>.worker.cpuprofile` for
  `scripts/hitch-frame-profile.mjs`; the dump keeps the page's `loadTimings`. The harness attaches to the worker when it is
  created (a worker's target has an empty url until `targetInfoChanged`) and a patch of the worker's module calls
  `console.profile` at the `loaded` message and `console.profileEnd` at the FRAMES-th frame. `--vite-port` fixes the dev server's port.
* The cost centres above came from `bench-sim --cpu-profile` read by function and by caller, and from scenario scripts that wrap
  one runtime method (spawn time by class, class image builds, lowerings, `classInfo` rebuilds, calls of one script function).

## Riders

`moveActorRiders` (move-riders.mjs) runs the original's scan of `Level.Actors` at every MoveActor with a StandingCount, in order,
reading each `Base` where the scan is. The reads went through the host's accessor, its link state, the released check, the cell
read and the handle lookup: 0.34 us each, and an actor's first move scans all of them (the cache of a mover's rider list helps
from its second move, and a pawn's inventory arrives after the first state code).

A slot whose Base read is a plain read of one image cell (`services.baseInstance(other)`: a host with its Base link installed,
a spawned collision view; `ScriptRuntime.riderBaseInstance`) is now compared as the cell's word with the mover's handle: the
identity a handle names is the one object that has it. Every other slot (one in 2,431 on the Island, the controlled player's
binding) takes the reads it took. The table of slots (`hosts`, `ats`) is filled for the actor in each slot, checked at every read,
and dropped when `baseEpoch()` changes; the epoch is bumped by the installers and Base bindings, every move of the array, and every
point where an instance gets poison or is released (`copyStorage`, `poisonField`, the three `freeObject` sites), the only two
states in which the cell is not the plain read. After each visited rider (its move runs events) the mover's handle and the arena's
view are read again: a pointer stored to the mover during the scan gives it a handle, and a grown arena replaces the view. The
tight loop is a function of its own (`nextCandidate`) that returns at the next slot that is a rider by its word or that the table
cannot decide.

`RIDER_VERIFY=1` also compares each recorded scan with the plain reads (`RIDER_NODIRECT=1` turns the direct reads off).
`test/rider-direct.test.mjs` covers the order, a null slot, a Base stored into a later slot by a rider's move, a mover given its
handle during the scan, an epoch bump during a visit, a released instance and a poisoned one.

`js_move_riders` in the Island's first tick (`SCRIPT_VM_IMPORT_TIME=1`, median of five interleaved runs against the tree this
branch started from): 36.8 ms to 8.9 ms. What is left of it is the table's fill (2,431 `baseInstance` calls, once per epoch, so
again in tick 1 after the end-of-tick `CleanupDestroyed` compaction bumps it), the 45 scans, and the riders' own moves (a few ms).
The same runs: `js_eval` 87.9 to 70.8 ms (the script statements and calls the Rust VM leaves to JavaScript: ChangeAlly's array
stores), `js_object` 61.3 to 49.3 ms (the spawns).

## Class defaults

A weapon's script writes `Default.MPPickupAmmoCount` in each spawn. `classDefaultReference` replaced the class's values Map with
a new one each time, so `classImage` (which compares the default Maps by identity) rebuilt the class image and
`classDefaultsChanged` invalidated the Rust interpreters' copies: 63 builds of 20 classes, 18 ms. A write of the scalars the
default already holds now leaves the Map in place (an object or array value replaces it as before): 19 builds, 10 ms (the first
write of each class adds the key, which is one build).

## Array elements

`arrayReference.setValue` (script-values.mjs) read the whole array, copied it, set the element and wrote every element back
(`writeLogical` reads the array once more): `AlliancesEx[i].AllianceName = n` was two round trips of sixteen structs in
`ScriptedPawn.ChangeAlly`. A storage that writes one element (`CellStorage.writeElement` over `writeFixedElement`: an image cell,
no poison entry, an index inside the array) stores the element alone; any other storage, a bool element and an index outside the
array take the whole-value path as before. ChangeAlly: 26 ms to 9 ms (70 us a call to 24 us). The whole-array rewrite differed
from the original only for a signalling NaN in another element, which the original does not touch.

## Ahead of the first frame

What is left of the first tick (about 250 ms on the Island, 76 on Training, 64 on 03_NYC_747) is the level's own initial state,
and it cannot be made small: Training, with a handful of pawns, takes 76 ms. It can be taken off the player's path, though. The
worker is idle between the `loaded` message and the first frame (the page builds its meshes and swaps its world in; the shader
warm-up has finished during the load): 220 ms on the Island, measured as `host` to `ready` of `loadTimings`.

The page now asks the worker for the first tick at the `host` mark (`call('preTick', {dt, width, height, aspect, resizes})`,
sim-session.mjs `preTick`): the tick the first frame would make, with the dt its post would carry (`FIRST_FRAME_DT`, 1/60), after
the viewport's size is set as `begin` sets it (the first tick reads `UViewport SizeX, SizeY`; `bench-sim` has no viewport, which
is the 246 errors it reports on 02_NYC_BatteryPark). The first post is then sent `preTicked` with no dt; `begin` takes the
tick's errors and travel request, and ticks only for the posts merged into that frame after the first one (their dt; none, no
tick). A tick the worker could not make (failed, travelled, a live replay) leaves the frame its own: `begin` gives it
`FIRST_FRAME_DT`. A travel's arrival and a loaded game's level take it too, with the loading frame ("Travel and loaded games"
below). The page does not ask when a start cheat or the easter egg act on the level first, for the loadout of a map opened
directly, nor inline (Firefox's default, where nothing is idle: the tick would move into the load's blocked thread).
`?preTick=off` (measurement only) leaves every first tick to its first frame, the A arm.

`frame-alloc-meter.mjs --pre-tick` makes the tick ahead and posts the frame as the page does; every frame hash equals the run
without it on the four maps (`validate-pre-tick.mjs` checks two), so the tick sequence the game sees is the one it saw. What
changes is when the first tick runs and what the posts merged during it are: they reach the next frame as their dt (the host
chooses the dts in Play, and the game takes whatever it is given, as before).

## Travel and loaded games

A level entered by travel (every level after the first in the default start: New Game reaches the intro and the Island that way)
and a loaded game (`LoadGame`, a travel with `?loadgame=N`) were left out at first, because their first tick is the loading
frame: DeusEx.exe's main loop passes `appSeconds() - OldTime` to the engine's Tick and does not reset `OldTime` across the load
(docs/travel.md "The first tick after the load"), and the page measures the first frame's dt from the last frame before the load
(`main.mjs` `travelFrameTime`). They take the pre-tick now (2026-10-30), with that loading frame measured from the last frame
before the load to the `host` mark: `(performance.now() - travelFrameTime) / 1000`, the dt the first post would have measured
less the page's build that follows the worker's load (`host` to `ready`, 170 to 570 ms here). That build is not the level's
time, as a load that much shorter would not be. The level's actors see no difference past the 0.4 s clamp of `ULevel::Tick`
(every load here is over 2 s); `TimeSeconds` reads the shorter loading frame, 0.1 to 0.7 s less than the frame-measured one in the runs below
(which already was this host's load time, not the original's). A travel arrival whose `travelFrameTime` is unknown takes
`FIRST_FRAME_DT`, as its first frame did.

Chromium, worker mode, the default start's New Game path (DX -> 00_Intro by travel -> 01_NYC_UNATCOIsland by travel), then
QuickSave and `LoadGame -1` on the Island; `.work/first-frames/load-frames.mjs`, three interleaved runs per arm, the frames of
each arrival split at its load's start (the hitch log's `map` event is sampled once a second and can fall after the first frames):

| arrival | `?preTick=off`: first worker frames, max in 5 s | pre-tick: first worker frames, max in 5 s |
|---|---|---|
| 00_Intro (travel) | 206 44 13 · 196 42 23 · 208 20 44; 206 196 208 | 22 20 11 · 22 21 11 · 23 22 13; 34 34 36 |
| 01_NYC_UNATCOIsland (travel) | 219 83 24 · 208 39 68 · 253 37 72; 219 208 253 | 34 33 25 · 27 32 19 · 28 34 22; 34 32 34 |
| 01_NYC_UNATCOIsland (loaded game) | 75 35 18 · 72 22 26 · 71 34 15; 75 72 71 | 22 29 28 · 19 32 15 · 22 29 16; 29 32 29 |

No page error and no Play stop in the twelve runs. `TimeSeconds` once the level is ready: intro 2.55 to 2.62 s without,
2.09 to 2.13 with; the Island 2.75 to 2.80 without, 2.56 to 2.66 with; the loaded game (its saved time plus the loading frame)
11.30 to 11.42 without, 10.69 to 10.77 with.

## Before and after

Headless, `bench-sim --warm 0`, interleaved runs of the tree this branch started from and this one, median (minimum) in ms:

| map | tick 0 before | tick 0 after | tick 1 before | tick 1 after | boot before | boot after |
|---|---|---|---|---|---|---|
| 01_NYC_UNATCOIsland (7 runs) | 308 (283) | 255 (225) | 31.0 | 23.0 | 5571 (5445) | 5538 (5472) |
| 00_Training (5) | 82.6 (80.0) | 76.0 (71.7) | 8.7 | 7.8 | 3853 (3833) | 3938 (3854) |
| 03_NYC_747 (5) | 63.6 (60.4) | 64.0 (62.9) | 5.1 | 5.5 | 3785 (3736) | 3822 (3758) |
| 02_NYC_BatteryPark (5) | 224 (200) | 196 (195) | 24.5 | 21.0 | 4806 (4786) | 4843 (4780) |

(tick 0 is not under 60 ms on any of them but 747: the cold level start is the cost; the ticks it is spread over now follow in
the browser.) The boot is the same within its spread (the minimums differ by 20 to 27 ms).

Chromium, worker mode, `hitch-run --mode roam` (8 s), first worker frames in ms and the load's marks (ms from the load's start;
`ready` is when Play may start, `firstDraw` the first drawn frame):

| map | tree | first worker frames | max in 5 s | frames over 50 ms | ready | firstDraw |
|---|---|---|---|---|---|---|
| Island | before | 271 114 53 34 22 · 259 128 48 30 17 · 268 93 63 34 28 | 271 259 268 | 3 2 3 | 5068 5079 5078 | 5445 5442 5446 |
| Island | after | 36 43 26 38 39 · 35 49 38 39 36 · 38 46 32 40 32 | 43 49 46 | 0 0 0 | 5034 4967 5093 | 5171 5100 5227 |
| Training | before | 55 11 13 13 9 · 59 12 15 13 11 | 55 59 | 1 1 | 3418 3509 | 3544 3645 |
| Training | after | 16 11 9 16 10 · 16 15 11 17 11 | 26 22 | 0 0 | 3429 3419 | 3515 3500 |
| 03_NYC_747 | before | 56 18 10 11 10 · 51 15 10 10 8 | 56 51 | 1 1 | 3436 3411 | 3568 3533 |
| 03_NYC_747 | after | 23 17 10 14 12 · 17 15 12 11 9 | 23 17 | 0 0 | 3302 3303 | 3397 3390 |

The load is not slower (the `host` mark, the worker's load, is 4864 4895 4891 before and 4812 4729 4852 after on the Island),
and the first drawn frame comes 200 to 350 ms earlier on the Island. A 60 s Island roam (`hitch-run --seconds 60`): 0 errors,
60.0 fps, 0 gaps over 50 ms, the first five seconds' worker frames 32 43 26 33 33 20 (max 43).

## Checks

* `frame-alloc-meter.mjs` (Island 600 frames after 900 warm, 03_NYC_747 and 00_Training 400 after 200, and `--warm 0` on those
  and 02_NYC_BatteryPark) and `hud-stream-digest.mjs --stream` (1500 frames) against references of the untouched tree:
  identical, digests c8cf5fff928609c1, f6337bff0cf741fc, e4b017e7b1bc0439, 16bfe2bd08ed1653 (and fe6376148b82a968,
  0ce0657e2f244872, 24dff4e600df8641, 41979956b1a2d63c for `--warm 0`). With `--pre-tick`, the four `--warm 0` runs are identical to those.
* `bench-sim.mjs`: Island 15e3720088490242, 00_Training 148077479825af78, 03_NYC_747 ad8e591a01434df5 (warm 60, 300 ticks), and
  `--warm 0 --ticks 300 --digest-every 10` on the four maps, the Island at `--digest-every 1` for 40 ticks and with
  `--dts 0.0167,0.34,0.17,0.13,0.1`: all equal to the untouched tree's.
* `node --test` on the 207 files of `test/`, one at a time under 6 GB: 0 failing (`rider-direct.test.mjs` is new).
* Validators (headless): script-vm-interp, script-vm-x87, script-process, script-spawn, script-scripted-actor-spawn,
  script-pawn-spawn-binding, spawn-mesh-binding, native-actor-constructors, inventory-spawn, rider-move-kernel,
  native-set-rotation-riders, native-based-actors, walk-loop-kernel, pawn-nav, mover-push-play, triggers, island-conversation,
  play-hud, save-game, save-load-play, load-saves (41 of 41 slots), pre-tick (new); travel, level-save and travel-endings SKIP
  (their measured captures are not in this checkout). Browser: sim-split (inline against worker, 240 frames), hitch-log, gpu-mesh,
  scope-view-play, mirrors-play, particles-play, flash-play, decals-play, lasers-play, coronas-play, settings-play,
  context-loss-play, page-movers-play: all pass; `validate-host-services-play` fails on the untouched tree too ("Open").
* Rust untouched.

## Open

* The first tick is still 250 ms on the Island (headless), and 76 ms on Training. The pieces left in it: the spawns (about 50 ms:
  construction, the events, the collision view, the zone), the 177 first lowerings (24 ms; lowering a function on its second run
  would save the 81 that run once, 9 ms, and cost their interpretation), the first `describe` of 767 actors (14 ms), landings and
  `FarMoveActor`. A tick made ahead of the first frame hides them in Play (travel arrivals and loaded games included); a start
  cheat, the easter egg, the loadout of a map opened directly and Firefox's inline mode still pay them in a frame.
* The ticks after the first, in the browser, are 26 to 49 ms for four or five frames (the landings of the falling pawns, with the
  dts of posts that merged while the frame before ran): under 50 ms in every run here, with little room.
* The page's first drawn frame is 67 to 83 ms on the main thread (1,134 uploads, 69 MB: `p.textures` 22 ms, `gl.upload` 26 ms,
  `p.render` 44 ms), once. The shader programs are built during the load (`gl.compile` 3 ms); the textures and buffers are
  uploaded by the first draw. Uploading them while the worker loads (the page idles for 3.8 s of the Island's load) is not done.
* `validate-host-services-play` fails with and without these changes (`game.resetInput is not a function` in the inline page).
