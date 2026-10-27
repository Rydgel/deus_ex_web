# Map loading time (Stage 7)

How long a map takes to load in Play, where the time goes, and what can make it
shorter. This is host measurement only: nothing here changes what the
simulation does.

## Measuring

`node scripts/profile-map-load.mjs --maps 01_NYC_UNATCOIsland,02_NYC_BatteryPark`
opens the debugging page in headless Chromium (Metal) against the dev server.
It times the first map from navigation, then each listed map from the map
list's change event until the first frame drawn after the load. `--sim inline`
runs the simulation on the page (Firefox's default), and `--profile` writes a
CPU profile of each load to `.cache/perf/` (with `--sim inline` that profile
covers the simulation side too).

The page keeps the last load's timeline: `deusExViewer.loadTimings()`.

| Field | Steps |
| --- | --- |
| `marks` (page, ms from `loadMap`) | `decoded` (map read and decoded), `world` (the page's world: BSP, static lighting, textures), `host` (the simulation side's reply), `meshes` (actor meshes ready), `swapped` (the new scene in place), `playerStart` (Player start's reply), `ready` |
| `simMarks` (worker: ms from its receipt of the load; inline: from `loadMap`) | `host` (createSimHost entered), `game` (createGame: class loading, the level's startup, Login), `scene` (the page's world part received), `actors`, `occlusion`, `loaded` |
| `firstDraw` | the first frame drawn after the load (its tick and the first use of the shader programs included) |

In worker mode the page builds its world while the worker loads the level
(`sim-client.mjs` `loadOverlapped`), so the page's `world` step is off the
critical path.

## Measurements, 2026-10-26

Apple M2 Pro, Chromium headless, 1440×960. The machine was busy (load average
8 to 10), so absolute times are high and vary by about ±20% between runs. Use
interleaved A/B medians for comparisons.

Worker mode, one browser, map changes after Training:

| Map | first drawn frame | createGame (worker) | page world (overlapped) | Player start | ready → first frame |
| --- | --- | --- | --- | --- | --- |
| 01_NYC_UNATCOIsland | 7.1 s | 5.1 s | 1.3 s | 0.9 s | 0.45 s |
| 02_NYC_BatteryPark | 6.5 s | 4.4 s | 0.7 s | 0.7 s | 0.4 s |
| 00_Training (page open) | 6.1 s from `loadMap` (7.0 s from navigation) | 4.7 s | 1.0 s | 0.2 s | 0.35 s |

Inline, the Island takes 8.3 s to the first frame, because the world build
and the simulation's load run one after the other.

The Island's CPU profile with the simulation inline (about 9.4 s sampled)
shows:

| Cost | ms | Where |
| --- | --- | --- |
| Class loading and linking | about 2,300 to 2,700 | `ScriptClassLoader.load` → `linkerPreload` → `serializeLoadedClass` → `UStruct::Link` (`linkScriptStruct`: its three property-chain walks, `isA`, replication conditions), plus `prepareFunction` |
| The level's startup | about 1,600 | `createScriptDoors` (begin play events, `resetNpcs`), `attach`, player scene, actor mesh admission, spawn closures |
| Player start | about 1,000 | `game.reset`: the level's startup again (`resetNpcs` 605 ms) |
| First frame | about 1,000 | the first tick 550 ms (state code, `FindPathToward`); the first draw 300 ms (shader programs' first use) |
| Page world | about 700 | `addModel`: static lightmaps 550 ms (`staticLightMap`, `shadowIllumination`) |
| GC, unattributed, idle | about 1,300 | |

## Why a map change costs this much

**Every level reloads every script class.** In Play, a level is one
`ScriptRuntime` with its own class loader ([travel](travel.md), "One session
per map"), so each map change serializes and links every class it uses from
its package again. The original loads its startup packages once per process
and never unloads them ([class defaults across a travel](travel.md#class-defaults-across-a-travel)).
Play carries class defaults across a travel explicitly because its classes do
not survive.

**The level's startup ran twice** (until 2026-10-27, migration step 5). A map opened in Play is loaded cold
(`createGame`: the LoadMap passes and Login). Then Player start
(`main.mjs resetCamera` → `game.reset`) runs LoadMap over the same map again.
Only a level restored from its saved file skips the second pass
(`keepLevel`). The second pass is also where Play's spawned-actor names come
from (`MakeUniqueObjectName`'s per-class counters, [Stage 5 exit
criteria](stage-5-exit-criteria.md), "A load-made actor's name does not name
the original's object"). On the Island the cold load names
Shadow0..52 and LaserProxy0..7, and after Player start the level holds
Shadow53..105 and LaserProxy8..15. That is the offset between Play's names and
the original's live captures (Shadow20..72, LaserProxy1..8), whose counters
come from the capture session's own earlier loads.

## Changes

* 2026-10-26: `isA` in the load graph and `UStruct::Link`'s property walks no
  longer allocate a visited set per call. A chain longer than a bound is
  still reported as a cycle. The Island's `createGame` median fell from
  5,863 to 5,408 ms (12 interleaved samples per side; minimum 4,942 to
  4,527 ms). bench-sim's state digests are unchanged (03_NYC_747
  `0750ca718aa7c059`, 01_NYC_UNATCOIsland `52595f00465194dd`, 30 + 120
  ticks). The unit tests pass, and so do validate-object-layout,
  -inventory-spawn, -linker-preload, -linker-imports,
  -script-linker-lazy-loader, -script-scripted-actor-construction,
  -weapon-construction and -class-default-travel.

* 2026-10-26: classes, readiness and the class loader are kept across a
  travel (the script process, [class graph design](class-graph-design.md),
  migration steps 2 and 3). `profile-map-load.mjs --travel` reaches each map
  by the console's `open`. In Chromium's worker mode, three interleaved runs
  per side, wall time to the first drawn frame, `?process=new` → shared
  (medians):
  * the Island: 6.9 → 4.1 s; the worker's `createGame` 4.9 → 2.2 s;
  * Training: 4.1 → 1.5 s; `createGame` 3.3 → 0.75 s.

  Inline mode: the Island 8.0 → 5.1 s, Training 5.3 → 2.5 s (one run per
  side). A load from the map list still starts a new process, so its times
  are those of the measurements above.

* 2026-10-27: LoadMap's collection also covers resources and packages
  ([class graph design](class-graph-design.md), migration step 4b). In
  Chromium's worker mode (three interleaved runs per side, `--travel`
  Training → Island → Training → Island → Training), the arrivals are
  unchanged within noise (Training 1.82 → 1.77 s, the Island again 4.15 →
  4.10 s), except the last Training load in two of three runs (1.76 → 1.94 s).
  The worker no longer keeps every package it has read: unloaded packages'
  bytes wait in a 64 MB cache, and nothing was read from a file again after
  the first arrival.

* 2026-10-27: one LoadMap per arrival (migration step 5): the page no longer
  runs Player start after a load. In Chromium's worker mode (one run), the
  Island by travel 5.59 → 4.59 s to the first drawn frame, Training again
  1.77 → 1.53 s; Player start's step after a load went from 0.2–1.1 s to
  about 1 ms.

## Open

* **Keep loaded classes across a map change**: done (2026-10-26/27, [class
  graph design](class-graph-design.md) migration steps 1 to 4). A travel
  keeps the script process; LoadMap's collection purges the level left's own
  classes and resources and unloads its packages.
* **One LoadMap per arrival**: done (2026-10-27, [class graph
  design](class-graph-design.md) migration step 5). No Player start after a
  load; the names follow one load, as the original's do.
* **First frame.** The shader programs could compile while the page waits for
  the worker (`renderer.compileAsync`, an experiment in [hitch log](hitch-log.md)).
  The first tick is the level's own first-tick script work.
* **Static lightmaps** (0.55 to 0.7 s). These matter inline (Firefox), or in
  worker mode once the worker's load is shorter than the page's world build.
