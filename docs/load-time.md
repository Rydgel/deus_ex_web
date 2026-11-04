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

## The Stage 7 rows, 2026-11-04 (Linux)

Rows 7.3.1 to 7.3.3 of the [Stage 7 criteria](stage-7-exit-criteria.md) (decision D4).
* **Machine:** the Linux host (AMD, 16 cores), so the figures are indicative; the reference is the Mac.
* **Browsers:** headless Chromium 153 in worker mode and Playwright's Firefox 155 inline, each browser's default.
* **Build:** the production build (`npm run build`, served by Vite's preview server) unless a line says the dev server. A load is
  timed to the first frame drawn after it, from the page's own load timeline.

**The tool.** `profile-map-load.mjs` has these options:
* `--browser chromium|firefox`;
* `--start original` (the page as the original starts, on the logo map DX.dx);
* `--folder` (the production build: the game folder given to the gate's picker as soon as it is shown);
* `--maps all` (the 83 single-player maps, every map but `DXMP_*`), with `--travel`;
* `--saves <Save folder> --slots` (the slots imported through the Saves window, each loaded by the console's `loadgame N`,
  `DeusExPlayer.LoadGame`'s exec, the Load Game screen's own call).

The report is written after every load.

Firefox's figures are from a quiet machine; Chromium's are from the first, busy run (below), so they can only be lower on a quiet one.

| Row | Bound | Chromium | Firefox |
| --- | --- | --- | --- |
| 7.3.1 navigation to the logo map's first frame | 10 s | 4.7 to 4.8 s (dev server 6.6 to 6.8) | 6.1 to 6.3 s |
| 7.3.2 a travel's first frame, 83 maps | 5 s (Chrome), 10 s (Firefox) | median 2.23 s, max 4.30 s (Paris Metro); dev server, in one page | median 4.17 s, max 8.73 s; four fresh browsers of about 20 maps |
| 7.3.3 Load Game's first frame, 39 real slots | 8 s | in one page after the logo map: median 2.13 s, max 4.20 s; cold (the first load of a page), six slots: 2.85 to 4.12 s | in one page: median 5.22 s, max 8.05 s; cold, six slots: 5.84 to 8.00 s; the Island's slot (Save0001) cold in six runs: 7.94 to 8.19 s, median 8.05 |

The slots are the internet corpus's 39 of one playthrough (nicouzouf; `.work/internet-saves`, outside Git), every one arriving on its
map. The travel census goes through the maps in name order from Training, so each arrival is in a process that has loaded the maps
before it, as a player's travels are.

**Chromium passes all three rows. Firefox passes 7.3.1 and 7.3.2, and misses 7.3.3 by a few hundredths of a second on one slot:**
Save0001's Load Game reaches the Island's first frame in 8.05 s (median of six). In Firefox it is, in order on the one thread:
* the page's world build, 1.3 s;
* the simulation's `createGame`, 5.5 s;
* the meshes, 0.35 s;
* the first frame, 0.24 s.

Every other slot is under the bound.

Paris Metro by travel, step by step (dev server, the busy machine):

| Step | Firefox, inline | Chromium, worker |
| --- | --- | --- |
| the page's world (BSP, static lighting, textures) | 1.56 s, before the simulation starts | 1.06 s, while the worker loads |
| the simulation's `createGame` (classes, LoadMap, Login) | 7.3 s | 3.1 s |
| actor meshes, the swap, Player start | 0.97 s | 0.47 s |
| ready to the first drawn frame | 0.89 s | 0.25 s |
| total | 11.2 s | 4.3 s |

So most of the gap is the simulation's load running 2.3 times slower in SpiderMonkey, on the same thread as the world build. A Gecko
profile of the logo map and a Load Game (`--gecko-profile`, 1 ms samples) spreads that time:
* class serializing and linking (`linkerPreload`, `linkScriptClass`), about 3.5 s;
* the level's attach (`createScriptDoors`), about 5.5 s inclusive;
* the page's world build (`addModel`, static lighting, the surfaces' geometry), about 4.3 s;
* the mesh loads, about 2.1 s.

No single function dominates. The async loader's own cost shows in `field` (1.1 s self) and `AssetStore.get` (1.2 s self).

**Firefox under Playwright.** Firefox captures an async stack at every promise and `await` only for a page under a debugger
(`javascript.options.asyncstack_capture_debuggee_only`, true in the release build's `greprefs.js`, as is `asyncstack`). Playwright's
Firefox driver attaches one to every page, so the harness paid a cost a player's Firefox does not:
`js::SavedStacks::saveCurrentStack` under `field`, 3.5 s of the profiled run. Interleaved, two runs each:

| | logo map | Load Game Save0001 | Load Game Save0016 |
| --- | ---: | ---: | ---: |
| capture on | 11.5 s | 16.3 s | 12.6 s |
| capture off | 9.6 s | 11.8 s | 9.1 s |

`profile-map-load.mjs` and `hitch-run.mjs` now turn it off in Firefox (`javascript.options.asyncstack` false; `--ff-prefs '{}'` and
`--ff-asyncstack` keep the driver's state), and the figures above are with it off. Every Firefox figure taken before 2026-11-04 had
it on.

**The machine was busy at first.** The first runs had a background load on the host: load average about 7, and a renderer of the
user's own browser using 1.2 to 1.7 cores for over a day, with the browser's network service as busy.
* **Not the code.** The commit row 7.2.4 was measured on (d01854c9, 2026-10-31) measured the same as master in an interleaved A/B:
  Firefox's page frame on the Island at 25 ms (master 23 to 26), against 17 to 20 ms on October 31.
* **Quiet again.** After the tab was closed, the same roam measured 19 ms and 48 fps, with 22 gaps over 50 ms in 100 s, which is
  October 31's state.
* **Firefox's loads on the busy machine** were about 1.5 times the quiet ones, all three:
  * the logo map, 8.0 against 6.2 s;
  * travels, max 11.6 against 8.7 s, with Paris Metro and the Island over 10 s;
  * Load Game, median 7.1 against 5.2 s, with 11 of 39 over 8 s.

**Memory across many maps.** The first Firefox travel census, one browser through all 83 maps, was killed by the kernel's OOM killer
at its 16 GB cap after 80 travels in 12 minutes. Chromium's run of the same census peaked at 7.5 GB for the browser and the harness
together. The one-hour session (row 7.4.3) did not see this: its warm-up visits all ten of its maps before the plateau is taken, so
memory a map keeps after it is left is already in the plateau. A process that visits many distinct maps grows with each, which rows
7.4.1 and 7.4.2 have to answer: [memory across many maps](map-memory.md) found four faults (in Firefox every left level stayed
alive through the interpreter's process-wide WeakRef walks, the cause of the OOM) and fixed them; both browsers now reach the 83rd map
without forced collections (Firefox's tree at most 9.4 GB, Chromium's 7.4), and two slower growths are left.

## Why a map change costs this much

**Every level reloads every script class.** In Play, a level is one
`ScriptRuntime` with its own class loader ([travel](travel.md), "One session
per map"), so each map change serializes and links every class it uses from
its package again. The original loads its startup packages once per process
and never unloads them ([class defaults across a travel](travel.md#class-defaults-across-a-travel)).
Play carried class defaults across a travel explicitly because its classes did
not survive (until 2026-10-27: the script process keeps them now).

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
* **First frame.** The shader programs compile while the page waits for the
  worker (done 2026-10-27: the shader warm-up, [hitch log](hitch-log.md#shader-programs));
  the Island's first frame no longer builds 24 to 30 programs. The first tick
  is the level's own first-tick script work.
* **Static lightmaps** (0.55 to 0.7 s). These matter inline (Firefox), or in
  worker mode once the worker's load is shorter than the page's world build.
