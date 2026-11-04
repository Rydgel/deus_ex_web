# Frame hitch recorder (`?hitchlog=1`)

A measurement tool for periodic frame-rate drops: it records what the page,
the simulation worker and WebGL were doing in every frame, so a drop that only
shows on one machine can be attributed to a thread, a phase or a resource
from a saved file. It is host measurement only. It reads the runtime's
counters and wraps WebGL and WebAssembly entry points; it changes no
simulation state, and without the URL switch it installs nothing
(`hitch-log.mjs` exports `hitchEnabled = false`, every hook in `main.mjs` is
`hitch?.…`).

## Running it

1. Start Play as usual, with the switch: `http://127.0.0.1:5173/?hitchlog=1`
   (add `&sim=inline` for a second recording with the simulation on the page,
   below). A small label at the bottom left shows the elapsed time and how
   many draw gaps over 100 ms there were.
2. Play the map for several minutes, until a few hitches have happened.
3. Press **Ctrl+Shift+H** (on macOS Control or Command), or press Esc and
   click the label's **Save hitch log** button, or run `deusExHitch.save()`
   in the console. The label then names the saved file (or the error). The
   browser saves
   `deusex-hitchlog-<map>-<time>.json`. Press it again later for a longer
   file; the log keeps the last 96,000 frames (26 minutes at 60 Hz, 13 at
   120 Hz) and every second of the session.
4. `node scripts/analyze-hitchlog.mjs <file>` prints the report; the file is
   also what to send back.

**Scripted sessions** (Stage 7's frame-time rows, [criteria](stage-7-exit-criteria.md)):
* `node scripts/hitch-run.mjs --map MAP --seconds S --mode roam|walk|idle|scan [--browser firefox]` records a session with the
  recorder and saves its full dump to `<out>.json`. It starts its own dev server unless given `--url`. Chromium options add CPU
  throttling, V8 GC events, the worker's heap and CPU profiles, and debugger stalls; Firefox options add a Gecko profile.
* `scripts/hitch-summary.mjs` reads the file (and a saved dump): frame work and drawn-gap figures, and the 7.2 rows' verdicts.
* `scripts/hitch-ab.mjs` runs interleaved arms with each session's CPU.
* `scripts/frame-time-set.mjs` runs the ten-map frame-time set.
* `scripts/session-hour.mjs` runs the one-hour session (row 7.4.3, [long session](long-session.md)).
* `scripts/hitch-frame-profile.mjs` and `scripts/gecko-gc.mjs` name what a slow frame ran.
* `scripts/gecko-gaps.mjs RUN.json PROFILE.json` lines a Firefox run's drawn gaps up with the Gecko profile's GC and CC pauses
  (`--thread page` inline, `--thread worker` with the worker).

These tools replace the earlier `.work/hitch/` copies that the dated sections below cite.

For the memory theory of a hitch that only shows on a 16 GB machine, run this
in a Terminal next to the game and note the times of the hitches (it logs
swap use, the compressor and pageouts every two seconds):

```
while true; do date +%T; sysctl -n vm.swapusage; vm_stat | egrep "Pages free|Pages stored in compressor|Pageouts|Swapouts|Swapins"; sleep 2; done | tee ~/dx-vm.log
```

Activity Monitor's Memory tab (the "Memory Pressure" graph and the memory of
the renderer process of the game's tab) says the same in one picture.

## What a file holds

- `meta`: browser, GPU string (`glRenderer`, which names the ANGLE backend),
  device pixel ratio, canvas size, cores, `performance.memory` availability.
- `seconds`: one row per second for the whole session: frames and drawn
  frames, the longest frame interval, the page's longest `animate()` and its
  slowest phase, the worker's longest frame, merged posts and latency, the
  milliseconds in WebGL compile, upload, sync and draw calls, the page heap
  (Chrome only), the wasm memories (page and worker), three.js geometry,
  texture and program counts, WebGL objects created, long tasks, audio
  underruns, focus and visibility.
- `events`: long tasks and long animation frames (with the scripts they ran),
  every WebGL call over 2 ms (`slowGL`, with its name), page visibility and
  focus changes, map changes.
- `programs`: every shader program three.js compiled, with its cache key and
  the time. A program compiled in the middle of play is a synchronous stall
  on the thread that draws (ANGLE's Metal backend compiles slowly).
- `rows`: per-frame columns (`columns`) for the frames around every hitch
  (the draw gap exceeded `hitchLimitMs`) and around every slow second, plus
  the last 15 s. `deusExHitch.dump({full: true})` returns every frame kept. `deusExHitch.since(n, columns)` returns the frames
  recorded from frame number `n` on (as rows of the named columns) and the number to ask from next: a session longer than the
  ring reads it in pieces ([long session](long-session.md)).
- `summary`: draw-gap percentiles over all kept frames.

The per-frame columns: `t`, `dt` (requestAnimationFrame interval), `drawn`
(a snapshot was drawn this frame), `animate` (page ms), `p.*` (the page's
phases, `framePhases`), `gpu` (EXT_disjoint_timer_query ms, where the browser
exposes it), `gl.*` (ms in the WebGL calls that can block, uploaded MB and
call counts), `w.*` (the worker's frame: start, duration, posts merged, the
dt it advanced, post-to-start latency, age of the oldest merged post, whether
a status request rode on it, wasm MB, then its step times) and the page
client's `outstanding` and `waiting` snapshot counts.

## Reading it

`scripts/analyze-hitchlog.mjs` classifies each slow second:

- *worker frame*: the worker's longest frame is most of the longest frame
  interval. The step times name the step; a stall in which every step is
  slow at once, with the page quiet, is the worker's JavaScript heap being
  collected (see the Linux measurement below).
- *page frame (phase)*: `animate()` is long; `phaseKey` names the slowest
  phase; `gl*` columns say whether WebGL calls account for it.
- *WebGL calls*: compile, upload, sync or draw time covers the gap. A
  program in `programs` created in the same second is a shader compile.
- *neither thread*: both threads were quiet while the interval was long. The
  browser, the GPU process or the operating system stalled them (memory
  compression or swap, thermal or power limits, a background app, a
  window-server hiccup); check `focus` and `visible` and the Terminal log.

A second recording with `&sim=inline` runs the simulation on the page: Chrome's
`performance.memory` then covers its heap (`heapMB`), so heap drops line up
with the stalls, and a stall that stays with the page and its heap is
garbage collection.

## Browsers

Chromium gives every field. Without `performance.memory`, long-task and
long-animation-frame observers, or timer queries (Firefox, Safari) those
fields stay empty (`hasMemoryApi` in `meta`); the frame intervals, the
worker's frame record, the WebGL call timings, the renderer counts and the
programs are the same everywhere. Run in Playwright's Firefox 155 on the Linux
host (2026-10-15; not in Safari); every optional API is feature-tested.

## Shader programs

three.js builds a program the first time a material is drawn with a program
key it has not built, and checks its link status at once, so the thread that
draws waits for the compiler. `programs` and `gl.compile` say how often that
happens in play.

**Before the warm-up (Linux host, 2026-10-27).** A map built 7 to 30
programs, most of them in its first drawn frame (the Island, after Training:
6 to 24 programs, a 400 to 550 ms first frame), the rest when a draw first
needed a variant: actor meshes by environment pass, side, alpha test and
blend state (Style), the view model, lightmap batches by texture count,
translucent sprites. On the Island 0 to 15 were built after the first 5 s of
roaming, each a 50 to 120 ms frame; a program no material used any more was
deleted and built again when the next one needed it. Airfield built 17 to 19
during a 90 s roam. The former `?precompile=1` compiled only what the scene
held at load (Airfield: 7 late).

**The warm-up** (`src/viewer/shader-warmup.mjs`, on by default,
`?shaderWarmup=0` turns it off). Once the page's world is built and sent to
the worker, the page compiles, while the worker runs the level's startup:

- the world's own materials (BSP surfaces, movers, sky, fog surfaces) and
  the full-screen passes (display ramp, flash). Compiling a material binds
  nothing: its first draw derives its program key again from its state then
  and finds the program built;
- stand-ins for what is made once play runs, built by each factory's own
  construction (`actorMeshWarmup`, `spriteWarmup`, `decalWarmup`,
  `detailWarmup`, `coronaWarmup`, the fog pass's `warmup`, `hudWarmup`): the
  actor meshes' materials (a GPU slot's by environment flag, and the CPU
  path's) by side, alpha test and opacity, their batches, a weapon's
  back-side faces in a mirror frame, the sprites' four blends, decals, detail textures, coronas, mover
  fog items and the HUD's two tile shaders. Their onBeforeCompile and
  customProgramCacheKey are the draws' own, and their map and geometry give
  the key what it reads from them (that a map exists; which standard
  attributes the geometry has), so the programs are the ones the draws would
  build. The stand-ins are never drawn; they are kept until the next level's
  warm-up has finished, so their programs stay alive meanwhile.

A level with mirror planes takes the mirror passes' clipping-plane shape (one
plane, disabled outside a mirror frame) at its swap (`mirrors.mjs
clipShape`), the shape every draw had after its first mirror pass anyway, so
its first mirror pass no longer rebuilds every material's program and the
warm-up builds one shape. The driver compiles and links what the warm-up
issued while the load goes on (one program after another, about 15 to 18 ms
each in Chromium here, 9 in Firefox); the link checks, which wait for that
(each program's first use), run at the end of the load (`finish`), when the
programs are built. With KHR_parallel_shader_compile (Chromium) non-blocking
completion polls say when they were; Firefox 155 here has no such extension,
and nothing is asked of a program before `finish`. A page call that must
wait for the GPU process waits for every compile queued before it: a first
try that built 130 programs at once (both clipping shapes) held the page
2.3 s inside the load, and a first Firefox version that checked the links at
once 0.65 s. `status().shaderWarmup` gives `programs` (built by this
warm-up), `mainMs` (the page's part), `ms` (until the polls saw every program
linked; null without the extension), `checkMs` (the link checks) and
`waitMs` (how long the load waited at its end).

**Measured** (Linux host, headless Chromium, `--use-angle=gl`, worker mode,
1440x960, roams with `.work/hitch/run.mjs` after the page's first map,
Training; interleaved with `?shaderWarmup=0`):

| | warm-up off | warm-up on |
|---|---|---|
| Island, 2 x 120 s: programs built after the swap | 24 and 30 (460 to 580 ms of compile calls: a 400 to 417 ms first frame, then 0 and 6 late ones) | 0 |
| Airfield, 3 x 60 s (to the player's death): programs built in play | 25 to 27 (366 to 454 ms) | 0 (the first two runs: 2, the actor meshes' CPU path at the death, which the stand-ins now include) |
| the Island's load: ready, first frame | 6.17 to 6.23 s, 6.95 to 7.00 s | 6.15 to 6.21 s, 6.59 to 6.65 s |
| warm-up: programs, until linked (page thread) | | Training 75, 1.33 s in a 5.4 s load (34 ms, link checks 14 ms); Island 10, 0.18 s (8 to 13 ms, 4 ms); Airfield 13; DXONLY 2, 0.05 s |
| Firefox inline, Island 90 s: programs built in play | 18 (the first frames; 146 ms of compile calls on the page) | 0 (Training's load: 87 ms of link checks; the Island's: 3 ms) |

The load waits only for the link checks (`waitMs` 3 to 14 ms: the worker's
startup takes 4 to 5 s, Firefox's inline startup 14 s). Without the warm-up some programs were built twice: three.js deletes a
program no material uses, and the next draw needing it builds it again (the
Island's opaque GPU-mesh pair at 65 s and 81 s; Airfield's batch program four
times); the stand-ins keep them. The shader sources match: recording every
linked program's source (`run.mjs --sources`, an init script around
shaderSource and linkProgram), all 44 distinct programs the draws built with
the warm-up off on Training, Airfield and DXONLY were built with the same
source by the warm-up run (`.work/hitch/compare-texts.mjs`).

Not covered: the frame keeper's copy pass (a save's snapshot), the CRT
display shaders (off by default), a level whose world materials change after
its load (none known), and the first frame's other work (the swap's 0.2 s
frame is the load's last step, not a compile).

## Cost

Off: nothing. On: two `performance.now()` calls around each WebGL call that
can block or draw (about 100 a frame), a 50-column `Float32Array` row per
frame, one observer each for long tasks and long animation frames, and a
once-a-second table row. The recorder turns `?gpuTimer=1` on (one timer query
per frame) and adds a field to the worker's snapshot. Measured on the Linux
host, Everett roam, interleaved pairs with `?gpuTimer=1` in both arms: page
2.29 ms (off) and 2.04 ms (on) per drawn frame, worker 6.65 and 6.57 ms, 59.7
fps in both; the difference is inside the run-to-run noise.

## What it found on the Linux host (2026-10-14)

See [Play frame cost](play-frame-cost.md) "October 14: periodic hitches".

## Firefox: the worker's idle GC (2026-10-15)

Firefox 155 here reproduces the user's pattern (worker frames of 0.7 s every
~6 s on Everett after another map). The Gecko profiler
(`MOZ_PROFILER_STARTUP=1 MOZ_PROFILER_STARTUP_FEATURES=js,threads,markers
MOZ_PROFILER_STARTUP_FILTERS='GeckoMain,DOM Worker' MOZ_PROFILER_SHUTDOWN=file`)
names it: Gecko runs a full, non-incremental, compacting GC (reason DOM_WORKER,
options Shrink) in a worker about five seconds after the worker's event queue
first drains, whatever its allocation rate. A worker that idles between frames
therefore pauses for the cost of its whole heap every ~5.5 s. The previous
map's runtime stayed alive in the handle table and doubled that cost (fixed);
`?workerBusy=1` keeps the worker's queue non-empty (one busy core) and removes
the periodic pause in Firefox. The hand-off, what to record on the Mac: the
default and `?workerBusy=1`, then `node scripts/analyze-hitchlog.mjs` on both.
Details and numbers: [Play frame cost](play-frame-cost.md) "October 14, later".

**On the user's Mac (Firefox 157, Apple M1 class, 120 Hz, Everett after another
map, 2026-10-15, after the leak fix).** The recorder's contiguous rows, about
20 s of play each: the worker stalls 208-398 ms every ~5.5 s (7 over 200 ms in
two runs; before the leak fix 1.1-2.4 s), `?sim=inline` has none over 200 ms
(worst gap 108 ms, p99 24.7 ms) at the same frame rate (111 fps; page frame
work 6 ms median, 12 ms p99). Play therefore defaults to `?sim=inline` in
Firefox (main.mjs `simMode`); `?sim=worker` keeps the worker there. On the
Linux host under an 8-job validator sweep Firefox inline drew 35 fps against
the worker's 45, with no stall over 200 ms against 16: a slower machine trades
frame rate for the stalls.

**With the busy queue (2026-10-28).** `?workerBusy=1` removes the idle GC, but
a worker's allocation-triggered major GC is not incremental either: on the
Island, one 320 to 340 ms pause about every 50 s of play, against inline's six
to eight 100 to 133 ms frames a minute ([frame cost](play-frame-cost.md)
"October 27"). Firefox stays inline.

**After the live-heap work (2026-10-31, d01854c9).** The question was
whether the smaller heap ([live heap](live-heap.md)) lets Firefox drop
inline. `scripts/hitch-ab.mjs --arms
"inline:sim=inline,worker:sim=worker,busy:sim=worker&workerBusy=1" --pairs 2
-- --browser firefox --map 01_NYC_UNATCOIsland --seconds 100 --mode roam`,
Linux, Firefox 155, counted from 5 s after the map by
`scripts/hitch-summary.mjs`:

| | gaps over 50 ms (a minute) | over 100 / 150 ms | longest | fps drawn | CPU |
| --- | --- | --- | --- | --- | --- |
| inline (default) | 23, 17 (13.6, 10.2) | 0, 1 / 0, 0 | 84, 101 ms | 52.1, 48.9 | 1.35 cores |
| worker | 31, 32 (18.3, 18.8) | 19, 15 / 14, 14 | 366, 350 ms | 54.2, 53.8 | 1.69 cores |
| worker, `?workerBusy=1` | 11, 12 (6.5, 7.1) | 4, 4 / 3, 4 | 216, 216 ms | 51.5, 56.7 | 1.72 cores |

Inline's 100 to 133 ms frames are nearly gone: at most one a roam, of
101 ms (in the 40 s to 100 s window the October 28 roams used: 9 and 6 gaps
over 50 ms, none over 100 ms, against 26 to 31 and 6 to 8 over 90 ms). A third inline roam with a Gecko profile
(`scripts/gecko-gaps.mjs RUN.json PROFILE.json`, the page's thread) puts 12
of its 31 gaps over 50 ms on a major collection's slices, 11 of them in two
collections (36 to 38 s and 45 s after the map) whose incremental slices ran
5 to 80 ms (the longest with "started idle but extended" budgets; in 5 of
the 12 the slice is under 15 ms, so the frame's own work is most of the
gap), and 19 on no collection pause (a 2 to 3 ms minor GC at most): page
frames of more than two display frames (sim and draw on one thread, 17 to
20 ms median, 26 to 30 ms p95). The worker's gaps are still its own
collections: idle, the 5 s `DOM_WORKER` GC every 5.5 to 6 s (133 to 366
ms); with the busy queue one every 25 to 40 s of 200 to 250 ms, where the
worker answers about 130 ms late, merges 8 to 10 posts, and runs a 41 to 55
ms tick. Neither worker arm is profiled today (two profiled busy roams did
not save the content process's threads at shutdown), so this rests on the
spacing, these columns, and the October 15 and 28 profiles. Firefox stays
inline: its worker trades frames over 50 ms for freezes of 200 ms and more.
Since a worker's collection is one slice over the whole heap, that changes
only with a much smaller JavaScript heap, the simulation's data in Wasm
memory ([Rust core](rust-core.md)).

Tools that found it (kept out of Git, in `.work/hitch/` of the worktree):
`run-ff.mjs` (Firefox long run with the recorder, `--via MAP`, `--profile`,
`--worker-patch`), `ff-gc.mjs` (GC markers of a Gecko profile), `stalls.mjs`
(worker frames over a limit with their steps and spacing), `leak-ab.mjs` (live
heap after map A then B in Node), `heap-ab.mjs` and `snap-ab.mjs` (the same in
the Chromium worker, with a heap snapshot), `snap-paths-all.mjs` (strong
retention paths to a marker class), `snap-summary.mjs` / `snap-shapes.mjs`
(composition).
