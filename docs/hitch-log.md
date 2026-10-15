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
  the last 15 s. `deusExHitch.dump({full: true})` returns every frame kept.
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

three.js compiles a program the first time a material is drawn, and checks
its link status at once, so the thread that draws waits for the compiler.
`programs` and `gl.compile` say how often that happens in play. On the Linux
host a map builds 7 to 30 programs; Everett's last one is built 19 s into
play, Airfield builds 19 more programs during a minute of roaming (5 to 25 ms
each here). Whether ANGLE's Metal backend or Apple's OpenGL makes them
seconds is not known here; the recorder will show it. `?precompile=1` builds
the scene's programs while the loading screen is up (`renderer.compileAsync`):
Airfield goes from 28-30 programs (17-19 built after play began, 150-160 ms of
`gl.compile` in a 90 s roam) to 69 (7 late, 78 ms). It
also compiles about 40 programs a roam never uses, so it moves the cost to
the load rather than removing it; it is off by default, and an experiment for
a machine whose log shows compile time in slow seconds.

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

Tools that found it (kept out of Git, in `.work/hitch/` of the worktree):
`run-ff.mjs` (Firefox long run with the recorder, `--via MAP`, `--profile`,
`--worker-patch`), `ff-gc.mjs` (GC markers of a Gecko profile), `stalls.mjs`
(worker frames over a limit with their steps and spacing), `leak-ab.mjs` (live
heap after map A then B in Node), `heap-ab.mjs` and `snap-ab.mjs` (the same in
the Chromium worker, with a heap snapshot), `snap-paths-all.mjs` (strong
retention paths to a marker class), `snap-summary.mjs` / `snap-shapes.mjs`
(composition).
