# The one-hour session (Stage 7, row 7.4.3)

Decision D5 of the [Stage 7 criteria](stage-7-exit-criteria.md): a scripted one-hour session in Chrome and in Firefox, with ten map
changes and fifty minutes of the frame-time route with placed walks and a save and load every ten minutes. It passes with no runtime
error, the heap after each forced GC within 10% of the first plateau, and the median frame time of the last five minutes within 5% of
the first five. Host measurement only: nothing here changes what the simulation computes.

## The harness

`node scripts/session-hour.mjs [--browser chromium|firefox]` (it starts its own dev server unless given `--url`; about 62 minutes).
One browser, one page and one simulation process for the whole session:

* **The route.** The Island from the debugging page's map list, then the console's `open` (the engine's command chain, a travel that
  keeps the script process, as the original's `open` keeps the engine) through the other nine maps of the frame-time set (Training,
  the Bar, Battery Park, the Airfield, Wan Chai's market, the Ship, the Chateau, Everett, the Area 51 bunker) and back to the Island:
  ten map changes. The two Island visits last five minutes each from their arrival; the nine between share the other fifty.
* **On each map**, the frame-time route with placed walks, over and over: the census scan (`hitch-run.mjs --mode scan`: the authored
  view, then three more 60 degrees apart, 15 s each, standing at the start), then four walks of 20 s from the start at headings 90
  degrees apart (`placeProbe` puts the player back at the start; a jump when stuck). The same steps at the same times on both Island
  visits, so the first and last five minutes compare like with like.
* **Every ten minutes** (on a map between the two Island visits): the Quick Save key (`NumpadAdd`, pressed until the game takes it:
  a DataLink or a conversation refuses it), a 3 s walk away, the Quick Load key (`NumpadDivide`) and the original's confirm box
  answered Yes with the menu cursor. The loaded game must stand where the save left it.
* **God mode.** The console's cheats (`set DeusEx.JCDentonMale bCheatsEnabled True`, then `god`, checked through `windowProbe` and
  given again after each arrival and load when missing), so that the hostile maps (the Airfield, the Ship, the bunker) cannot end
  the session in a death. The NPCs still see, shoot and chase the player.

It records every frame of the [hitch log](hitch-log.md) (`?hitchlog=1`, read every 15 s with `deusExHitch.since`, since the log's
ring keeps 26 minutes), the heaps after forced collections after each scan and at each map's end (Chromium:
`HeapProfiler.collectGarbage` three times in the page and the worker, then `Runtime.getHeapUsage`; Firefox: a Gecko memory report
after its minimize, the signal of `profile-firefox-memory.mjs`, Linux only), the browser's process tree RSS every 10 s (Linux), and
every page error, console error and runtime error. `<out>.json` holds all of it with the verdict; `--summary <out>.json` prints the
verdict again.

**The warm-up pass** (since 2026-11-04, the user's reading of D5's "first plateau"): before the hour, the Island and the nine
maps, `--warmup` minutes each (1.5 by default), the same steps and no save; the measured hour starts on the Island after it, so the
first plateau and the first five minutes are a warm process's. `--warmup 0` is a cold start, as the first hours below ran.

**The verdict**, as the harness reads D5:
* no runtime error, page error or console error, and every load back where its save stood;
* the heap after each forced GC on the last Island visit at most 10% above the first plateau: the median of the first measured
  visit's readings, the same map at the same route steps. Comparing maps with one another would compare levels, not a leak; every map's
  readings are reported instead (row 7.4.2's figures);
* the median frame work of the last five minutes (the last Island visit, from 5 s after its arrival) at most 5% above the first
  five's: the page's (`animate`) and, in worker mode, the worker's (`w.dur`, one per worker frame), as row 7.2.1 measures them.

**The readings.** Each realm's JS heap and its ArrayBuffer and Wasm memory, apart. V8's `Runtime.getHeapUsage` gives the heap
(`usedSize`) and the ArrayBuffer backing stores (`backingStorageSize`), but no Wasm memory (measured: a 64 MB `WebAssembly.Memory`
adds 9 bytes to it), so in Chromium the harness adds each side's live Wasm memories as the hitch log counts them. Gecko's report
has all three per owner (`gc-heap` and `gc-buffers`; `array-buffer` and `wasm`; the rest). The page's script-VM kernel's block
allocator is read too (`blockStats`).

## What the first runs found (2026-11-04, Linux)

Short trials (`--minutes 4 to 6 --edge 0.5 to 1`, the Island, Training, the Bar, the Island) in both browsers, before any full hour:

1. **The hitch log kept every Wasm memory.** `hitch-wasm.mjs` held each `WebAssembly.Memory` it had seen in a strong `Set` (to sum
   their sizes), so with `?hitchlog=1` every past level's object arena stayed alive, on the page and in the worker. It holds them
   weakly now (`WeakRef`, a `WeakSet` so a memory counts once). Measurement only; no effect without the switch.
2. **A level's BSP occlusion was never freed.** `sim-host.mjs dispose` left the occlusion (`createBspOcclusion`: a 32 MB work block
   and the level model's tables) in the script-VM kernel's memory, which lives as long as the realm. Firefox inline (its default)
   kept 45 to 60 MB at each map change: the page's Wasm memory went 172, 223, 266, 330 MB over the Island, Training, the Bar and the
   Island, its live kernel blocks 287, 368, 449, 644 (Chrome with `?sim=inline` the same). In worker mode the occlusion is the
   worker's, in the worker's kernel, which the readings without Wasm memories did not see (not measured before the fix). `dispose`
   now frees it.
   * The kernel holds one brush tracker (tracker.rs's statics, as Engine has one GBrushTracker), and a travel builds the next level's
     host before the last one goes: freeing the old occlusion destroyed the new level's tracker ("AttachDecal: model index out of
     range" at the next AttachDecal). `brush-tracker.mjs` now records which host constructed the tracker last; only that one's
     `live()` is true and only it destroys it.
3. **The kernel's block allocator wasted what was freed.** It handed a freed block whole to the first later request that fitted
   it, so the next level's first small table took the last level's 32 MB work block and the next work block grew the memory (the
   second Island visit held 201 MB in its 208 blocks against 108 MB the first time). It is a best-fit allocator now: free blocks are
   kept by address, merged with their free neighbours and given back to the top, a request takes the smallest one it fits and splits
   it, and every block starts zeroed. With the three fixes the page's kernel holds the same 208 blocks of 59.7 MB on both Island
   visits, its memory stops at 120.9 MB (two levels' occlusions during a travel), and the Island's total after GC is 838 then 888 MB
   (+5.9 %) in Chrome inline.

## Runs

On the Linux host (16 cores, headless, 1440×960, master 75bc6341), outside Git in `.cache/perf/session/hour/`.

### Chromium, worker mode (2026-11-04, 61 minutes)

No runtime, page or console error; ten map changes; five Quick Save and Quick Load round trips, each back where its save stood
(3.2 to 4.1 s after the walk); loads of 2.0 to 4.4 s, the first 7.0 s. **D5 fails** on two of its bounds:

| | first Island visit | last Island visit | change |
| --- | ---: | ---: | ---: |
| total after GC (page and worker, JS and buffers) | 1032 MB (plateau) | 1369 to 1377 MB | **+33 %** |
| page median frame work (`animate`) | 3.3 ms | 3.8 ms | **+15 %** |
| worker median frame work (`w.dur`) | 12.2 ms | 11.9 ms | -2.5 % |

The page's frame work is higher by the same 0.5 ms in every quarter of the last visit (3.3, 3.3, 3.4, 3.2 ms against 3.8, 3.8, 4.0,
3.6 ms), so it is not noise; the frames kept carry no phase times, so which part grew is not known (not explained).

The memory, from the readings and the heap snapshots of both visits (`--snapshots`, `heap-families.mjs`):

| | first | last | what it is |
| --- | ---: | ---: | --- |
| page JS heap | 78 MB | 85 MB | |
| page ArrayBuffers | 352 MB | 416 MB | the page's asset store held more packages (`AssetStore.ready`, 125 to 183 MB in the page's snapshots): in worker mode nothing released a package from the page's store (finding 4 below) |
| worker JS heap | 164 MB | 195 MB | the process's classes and their decoded code (functions, load records, linked classes; 213k to 358k function objects) |
| worker packages held (`AssetStore.ready`) | 199 MB | 300 MB | the packages the process holds; see below |
| worker released-package cache | 0 | 46 MB | bounded at 64 MB |
| worker Wasm memories | 122 MB | 196 MB | the same five memories, larger: high-water marks (a Wasm memory never shrinks): the script-VM kernel (two levels' occlusions at a travel), the trace kernel's arena (9 to 46 MB: each level's collision hash is released by a FinalizationRegistry when collected, a level or two late, and the arena grows by half when full) |

Across the hour the totals follow the map, not the clock (972 MB on the Ship, 1268 MB in the Area 51 bunker), and the worker
sometimes holds the previous one or two levels' object arenas for a while (6 or 7 Wasm memories on Training, the Bar and the Market,
5 again on Battery Park and the Ship): collected late, not kept. The same route in Node (`validate-process-memory.mjs --maps`, the
simulation alone) holds 979 classes and 54 packages on the first Island arrival and 1156 classes and 62 packages on the last: the
classes a process has loaded stay, and the packages they reference stay with them. The original loads DeusEx.u whole at startup
(its classes and what their defaults reference), where Play loads a class when it is first used, so Play's process reaches that
state over the session instead of at the start. That the eight more packages are the ones the original's would hold is not checked.

Apart from the page's store (finding 4, fixed after this run), what D5's bound measures, read this way, is the warm-up from a cold
start: nothing else found grows without a bound. The user's reading (2026-11-04): the first plateau is the level after a warm-up pass
of the route (the warm-up pass above); this hour and the next read it from a cold start.

### Firefox, inline mode (2026-11-04, 61 minutes)

No runtime, page or console error; ten map changes; five Quick Save and Quick Load round trips (6.4 to 10.4 s after the walk); loads
of 6.3 to 13.2 s, the first 22.1 s. **D5 fails** on the heap:

| | first Island visit | last Island visit | change |
| --- | ---: | ---: | ---: |
| page after Gecko's minimize (JS heap, ArrayBuffers and Wasm) | 837 MB (plateau) | 1198 to 1204 MB | **+44 %** |
| page median frame work | 23.0 ms | 21.0 ms | -8.7 % |

The parts: the JS heap 188 to 224 MB; Wasm memories 163 to 264 MB, the script-VM kernel's 113 to 153 MB among them (its high-water
mark: two levels' occlusions at a travel, larger on the later maps; its live blocks are the same, 59.8 and 61.1 MB); the other
ArrayBuffers 487 to 716 MB (inline, the one asset store holds the simulation's packages and the page's, and the released cache).
Before the fixes the same maps read 869, 940, 1093 MB on the Island, Training and the Bar; in this run 842, 738, 736 MB. The frame
comparison is weak: three low-priority Node analyses (heap snapshots and the Node route, single-threaded, `nice 19`) shared the
16-core machine during the first visit, the baseline.

### Chromium, worker mode, after the warm-up pass (2026-11-04, master 8f82b56b, 77 minutes)

With the page store's fix and the warm-up pass (1.5 minutes a map). No runtime, page or console error; ten map changes in the
measured hour; five Quick Save and Quick Load round trips (3.1 to 4.2 s after the walk). **D5 passes:**

| | warm Island (the first plateau) | last Island visit | change |
| --- | ---: | ---: | ---: |
| total after GC | 1428 MB (median of 1428, 1433, 1335) | 1387 to 1393 MB | -2.4 % |
| page median frame work | 4.0 ms | 3.6 ms | -10 % |
| worker median frame work | 12.8 ms | 11.6 ms | -9.4 % |

The warm-up pass took the total from 1028 MB (the Island, cold) to 1428 MB; over the measured hour the visits read between 1046 MB
(the Ship) and 1569 MB (the Ship's first reading, with the bunker's runtime not yet collected), with no trend. The warm Island's
lowest reading (1335 MB) is the same lag: the bunker's runtime collected between the second and third readings.

**The page's frame work after the warm-up.** The cold Island visit's page frame work averaged 3.46 ms, the warm one's 4.07: the
`textures` phase went from 0.38 to 0.91 ms, every other phase within 0.1 ms. The page keeps one procedural texture set for its life
(`procedural-textures.mjs sharedProceduralTextures`), and its `update` ticks every Fire and Wet texture ever acquired, each frame:
after the warm-up pass, every visited map's. The original updates the textures it draws (that module's own note); the past maps'
ticks also take values from the generator the drawn ones share. Fixed after the hours (below).

### Firefox, inline mode, after the warm-up pass (2026-11-04, master 8f82b56b, 79 minutes)

No runtime, page or console error; ten map changes in the measured hour; five Quick Save and Quick Load round trips (6.4 to 10.3 s
after the walk). Nothing else ran on the machine. **D5 passes:**

| | warm Island (the first plateau) | last Island visit | change |
| --- | ---: | ---: | ---: |
| page after Gecko's minimize | 1167 MB (1163, 1167, 1169) | 1234 to 1239 MB | +6.2 % |
| page median frame work | 21.0 ms | 21.0 ms | 0 % |

The rise is the JS heap 215 to 227 MB and the ArrayBuffers and Wasm 952 to 1012 MB. The page's `textures` phase: 0.40 ms on the cold
Island, 0.91 on the warm one, 1.01 on the last (the procedural textures, above).

## A fourth fault: the page's store in worker mode (fixed after the hours)

With `?sim=worker` the page keeps its own asset store for drawing, and only the worker's script process releases packages
(`ScriptProcess.unloadPackages`, from the worker's store): nothing released one from the page's, which kept every package it had read
(125 MB of packages on the first Island visit, 183 MB on the last). Inline, the one store is released by the process during
createSimHost's LoadMap, after the next world is built. The worker now reports the packages its store released with each load's
reply (`sim-worker.mjs releasedPackages`) and the page releases them from its store at the same point of its load (`main.mjs`). A
five-map trial (the Island, Training, the Bar, Battery Park, the Island): the page's store holds 38 packages (134 MB) on the first
Island visit, 27, 19 and 32 on the maps between, and 34 (126 MB) with 20 MB in its released cache on the last
(`deusExViewer.assetsProbe`). Checked: validate-travel-play, -travel-restore-play, -travel-newgame-play, -save-load-play, -hitch-log.

## A fifth fault: every visited map's procedural textures ticked (fixed after the hours)

`procedural-textures.mjs` counts the acquisitions that hold each texture (the world's BSP materials, released with the world; a
live mesh's skin lease; a sprite scene's; the HUD's), and `update` ticks only the textures in use, in acquisition order as before
(docs/fire-texture.md "Host choices"). A route trial (half-minute warm-up visits, `--minutes 11`): the page's `textures` phase is
0.38 ms on the cold Island, the warm Island and the last Island visit alike (0.38 and 0.91 ms before), and every map's depends on
its own textures only (0.07 ms in Wan Chai's market, 0.55 ms in the Chateau). The cold hour's rise of the page's frame work (3.3 to
3.8 ms) was of the same size; that hour kept no phase times, so this is its likely cause, not shown. Checked:
validate-fire-texture-play, -fire-texture-rust, -native-fire-texture (1178 cases, no mismatch), -particles-play,
-sprite-tiles-play, -sprite-tiles-mirror-play, -actor-mesh-scene, -travel-play.

## The ten-minute session (row 7.1: a browser passes with it)

Row 7.1 of the [Stage 7 criteria](stage-7-exit-criteria.md#71-supported-browsers-d1) asks of each supported browser, besides the
suite and the browser validators, "a ten-minute session without a runtime error ... from the original start, loads Training, makes a
map change, saves, loads and plays sound". `node scripts/session-hour.mjs` is not that session (it opens its maps from the debugging
page); `node scripts/session-ten.mjs [--browser chromium|firefox|webkit] [--minutes 10] [--url URL] [--out file.json]` is. One
browser, one page, the default simulation mode (worker in Chromium and WebKit, inline in Firefox; the first step checks which), about
ten minutes of wall time (it starts its own dev server for the tree unless given `--url`). Chromium runs with `--mute-audio`
(its full headless build, which grants the pointer lock), Firefox with `media.volume_scale` 0.0; muted output still renders, so the
sound is measured as the worklet's quanta and Galaxy's voice batches, as `browser-tests/audio-resume.spec.mjs` does. It passes only if
every step below happens and no runtime error (`status().runtimeError`), page error or console error occurs; each step prints a
verdict line, `<out>` holds the record (default `.cache/session-ten/<browser>.json`, a screenshot beside it for each failed step).

1. **start**: the page without `?debug=1` reaches the logo map DX in Play.
2. **pointer-lock**, **logo-music**: the first click takes the pointer (not the screen, no binding reached) and starts the music: the
   AudioContext runs (it was `uninitialized` before), the worklet opens the library, the song plays, about 344 quanta a second.
3. **training-menu**: Esc opens the original MenuMain; the menu's cursor, driven by relative motion with the portable driver
   (`browser-tests/menu-cursor.mjs`), clicks Training; 00_Training loads. **training-music**: its song plays.
4. **training-walk**, **training-look**, **training-sound**: the movement keys walk the player (W, D, A, a jump); the mouse turns the
   view and so does the original's turn key (C: `DefUser.ini`'s arrows strafe); footsteps start effect voices that the worklet applies.
5. **save-game**, **load-game**: Esc, Save Game (the button is insensitive while a DataLink plays, `MenuMain.UpdateButtonStatus`, so
   the tool closes the menu and tries again every few seconds), Save: `Save0001` in the browser's storage; the player walks away; Esc,
   Load Game, the slot's row, Load: the player stands where the save left it.
6. **map-change**: a travel by the console's `open 01_NYC_UNATCOIsland` (the engine's command chain, as `session-hour.mjs` travels),
   not Training's own exit. **island-sound**: the new map's song plays and footsteps make voices again.
7. **quick-save-load**: the Quick Save key (pressed until a DataLink lets the game take it), a walk away, the Quick Load key and the
   original's confirm box answered Yes with the menu cursor: the player stands where the save left it.
8. **session-length**: placed walks and looks (`placeProbe`, as `session-hour.mjs`) until the wall time reaches `--minutes`, the
   runtime error checked every second and the frame counter advancing; **final-sound**: the music still plays, the worklet still
   renders and reports no fault or error; **no-errors**.

Run on the Linux host, 2026-11-10 (headless, the tree's dev server, this tool's first commit): **Chromium (worker mode) 10.0 minutes,
all 16 verdict lines PASS, no runtime, page or console error** (the dev server's 404 for `/favicon.ico` is listed as a note); the
logo map ready after 5.4 s, Training 5.2 s after the click, the map change to the Island 3.1 s after the command, 342 quanta a second
on the logo map, 204 830 quanta rendered with no underrun, fault or error at the end. **Firefox (inline mode) 10.0 minutes, all PASS,
no error and no failed resource load**: the logo map after 9.5 s, Training 6.6 s, the Island 8.7 s, 349 quanta a second, 203 419
quanta with no underrun. Both saved and loaded back to the saved position (Save Game and Load Game through the Esc menu on Training,
Quick Save and Quick Load on the Island) and made footsteps on both maps. WebKit does not start on this host (Playwright's Ubuntu
build wants ICU 74, libxml2.so.2 and flite): the tool reports that and exits with 2, so the WebKit session still needs the Mac.

**Rerun on master after the merge (Linux, 2026-11-10, `bca77379`):**
- **Firefox:** 10.0 minutes, all 16 steps passed.
- **Chromium:** three ten-minute runs.
  - Runs 2 and 3: all 16 steps passed, with the Island ready 3.0 and 2.5 s after the command.
  - Run 1: **the page crashed** 37 s in, during the save-game step (the Save Game screen; Playwright's "Target crashed").
    - Its scope's memory peaked at 1.9 GB, well under the 8 GB cap.
    - Neither the kernel nor systemd-coredump recorded anything.
  - **Eight more one-minute runs** with Playwright's browser log (`DEBUG=pw:browser`) passed every step, through Save Game, Load
    Game, the map change and the quick save and load.

So Chromium's page crashed once in twelve sessions. The cause is not explained and was not reproduced.

**Eight more ten-minute Chromium sessions (2026-11-10 and 11-11, master 13ce5312 to 428083e1)**, one at a time under the heavy lock
and a 6 GB scope with Playwright's browser log (`DEBUG=pw:browser`), `.cache/perf/crash-hunt/hunt.sh`: all eight passed every step
(600 to 770 s each; the only notes are the two failed resource loads every run has). With the earlier runs the page crashed once in
twenty ten-minute sessions and none of eight one-minute ones; it was not seen again, and its cause stays unexplained.

Playwright's WebKit cannot take every step: headless, it refuses the pointer lock without window focus and a synthetic mouse move
carries no `movementX` (docs/mac-pass-2026-11-09.md), so `pointer-lock` and `training-look` report that harness limit as a failure and
the menus run on the free mouse at its own position. Real Safari needs the same session by hand.

## Not done

* The Mac (the reference machine for the numbers): both warm hours pass on the Linux host only.
