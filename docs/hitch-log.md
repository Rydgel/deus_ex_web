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
3. Press **Ctrl+Shift+H** (also on macOS: Control, not Command), or run
   `deusExHitch.download()` in the console. The browser saves
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

## Cost

Off: nothing. On: two `performance.now()` calls around each WebGL call that
can block or draw (about 100 a frame), a 50-column `Float32Array` row per
frame, one observer each for long tasks and long animation frames, and a
once-a-second table row. The recorder turns `?gpuTimer=1` on (one timer query
per frame) and adds a field to the worker's snapshot. It reads the Linux
host's frame time within noise (see "Verification").

## Measured on the Linux host (2026-10-14)

See the section at the end of this file, added with the results.
