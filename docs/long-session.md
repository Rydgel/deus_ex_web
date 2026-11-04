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

**The verdict**, as the harness reads D5:
* no runtime error, page error or console error, and every load back where its save stood;
* the heap after each forced GC on the last Island visit at most 10% above the first plateau: the median of the first visit's
  readings, the same map at the same route steps. Comparing maps with one another would compare levels, not a leak; every map's
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

The full hour in Chromium and Firefox on the Linux host: not yet run (the findings above come from the short trials only).
