# Stage 7 exit criteria: a finite definition of "Done when"

Status: **adopted by the user on 2026-10-28**: the six decisions as recommended
([below](#what-the-user-decided-2026-10-28)). Written from master 598f8928. The data is `scripts/stage7-criteria.mjs`:
`node scripts/stage7-criteria.mjs` prints the scoreboard, `--list` the rows, and `--markdown` the row tables and `--suite` the
browser suite's section of this note, which are generated from it. The rows that rest on a decision say which.

The roadmap's criterion for section 7 ([roadmap](roadmap.md#7-make-the-browser-runtime-reliable)): *done when declared
browser/performance targets pass repeatable tests, long sessions and repeated map changes remain stable, and failures offer
useful recovery paths.* The section lists:
* loading time, frame time, memory and audio latency;
* supported desktop browsers;
* graphics capability errors;
* resize and fullscreen, pointer-lock loss, and pause and tab suspension;
* audio activation, local file access and persistent storage.

It asks the stage to close coverage gaps, not to postpone testing. The rows below fix what "declared", "supported", "stable"
and "useful recovery" mean.

AGENTS.md already declares one target: **120 fps in Play, 8.3 ms of host work per frame on the reference machine (Apple M2
Pro, 1440×960)**, measured by interleaved A/B medians and browser phase timings. Fidelity takes precedence over any
performance change. A speed change under 5% is not worth hours of work (the user, 2026-10-27).

## What the user decided (2026-10-28)

The user took each recommendation below. The alternatives are kept for the record.

1. **D1, the browser matrix.** The recommendation:
   * Chrome on macOS and Linux, in worker mode, Chromium's default.
   * Firefox on macOS and Linux, in inline mode, its default ([sim worker](sim-worker.md)).
   * Safari on macOS.

   Each in its current release at the time of the gate.

   Windows is not covered: neither machine runs it. Chrome's engine rows stand in for Chrome and Edge there, and that is stated,
   not claimed (7.11.3).

   The alternative is to drop Safari to "best effort" (7.1.4 excluded). It has never been run; its storage is cleared after
   seven days without a visit, and it lacks Keyboard Lock and `showDirectoryPicker`.
2. **D2, the frame-time gate.** The recommendation is that AGENTS.md's target is the gate:
   * The median host work per frame is at most 8.3 ms on each map of the frame-time set, in Chrome on the reference
     machine (7.2.1).
   * Every supported browser keeps a floor of 60 fps: a drawn-frame interval p95 of at most 16.7 ms on the same set (7.2.2).

   The alternative makes 60 fps the gate and keeps 120 fps as the tracked project target. Today the Island's worker frame
   is 12.2 ms (p50) on the Linux host, and the reference machine has not been measured since early October. Meeting 7.2.1
   is this stage's largest piece of work.
3. **D3, hitches in Firefox.** The user parked Firefox's GC work on 2026-10-28 ([live heap](live-heap.md), steps 2 to 9).
   Inline, Firefox draws six to eight frames of 100 to 133 ms a minute on the Island (incremental GC slices; see
   [frame cost](play-frame-cost.md) "October 27").

   The recommendation is to declare the bound now and leave 7.2.4 FAIL until the work is unparked: no gap over 150 ms, and
   at most two gaps over 50 ms a minute.

   The alternative is to record today's behavior as a known Firefox limit and exclude the row.
4. **D4, loading time.** Map loading was judged good enough on 2026-10-27. The recommendation is to bound today's
   measurements, with room for noise:
   * A travel arrival reaches its first frame within 5 s in Chrome (the Island measured 4.6 s, Training 1.5 s), and within
     10 s in Firefox.
   * A Load Game reaches its first frame within 8 s.
   * Navigation reaches the logo map's first frame within 10 s.

   All of these are on the reference machine, for every single-player map (a load census), not only the Island.
5. **D5, a long session.** The recommendation is a scripted one-hour session in Chrome and in Firefox:
   * ten map changes;
   * fifty minutes of the frame-time route with placed walks and a save and load every ten minutes.

   It passes with no runtime error. The heap after each forced GC must stay within 10% of the first plateau, and the median
   frame time of the last five minutes within 5% of the first five.

   The first plateau is the level after a warm-up pass of the route (the user's choice, 2026-11-04): a cold start's first visit
   measures the process loading its classes, the packages they hold and its caches, which the original's startup loads at
   once, not a leak ([long session](long-session.md)).
6. **D6, audio latency.** The original's latency (Galaxy's mix buffer through DirectSound) has not been measured. Following
   the fidelity rule, the recommendation is to measure it under Wine first, then hold Play to it: the time from a sound's
   PlaySound call to its first output sample, at most the original's plus one browser render quantum.

   The alternative is a host bound of 100 ms with no original reference.

   **How it is read** (the user's choice, 2026-11-04; [sound start latency](audio-latency.md)): the "output" is the
   moment the host's audio path takes the sound's first frame out of Galaxy's buffer, counted at the device's rate. In the original
   that is Wine's dsound mixer; in Play, the AudioWorklet's render. What each host adds after that is its own buffering to the device
   (`AudioContext.outputLatency`, Wine's buffering to PulseAudio). It is reported, not bounded. The original's figure is a 20-minute
   distribution, since the phase of Galaxy's timer against Wine's mixer moves it by several milliseconds. Median and p95 are compared.

## What a row is, and what passes it

Kinds:
* **O**: the original defines the behavior. The proof compares with the recovered code or a capture. Example: context loss,
  [context loss](context-loss.md).
* **H**: a host target with no original counterpart: a number or a behavior this note declares.
* **P**: Play against itself: no regression, the same state or pixels across modes or builds.

Statuses:
* **PASS**: the proof runs and passes on the rows' machine and browsers.
* **PARTIAL**: a proof exists, but not for every browser or machine the row names, or not since the last change that
  touches it.
* **FAIL**: measured, and it misses the bound.
* **MISSING**: no proof exists, or the bound is undecided.
* **EXCLUDED**: out of scope, with the reason.

Machines:
* **Mac**: the reference machine for every number. It is also the only Safari.
* **Linux**: the AMD host, for Chrome and Firefox behavior, and indicative numbers only.

Headless Chromium on the Mac renders with Metal (`--use-angle=metal`), and on Linux with GL (`--use-angle=gl`). A frame-time
row measures host work. A drawn-interval row needs a headed browser with vsync.

**Frame-time set:** the ten maps of the October 2 census in [frame cost](play-frame-cost.md): Training, the Island, the Bar,
Battery Park, the Airfield, Wan Chai's market, the Ship, the Chateau, Everett and the Area 51 bunker (`frame-time-set.mjs`
`FRAME_TIME_SET`). Each runs the census route: four headings 60 degrees apart, the first the authored view, each held for a
quarter of the session (60 s by default), after a 3 s settle (`hitch-run.mjs --mode scan`). The census itself turned with drag-look
and counted 90 frames per heading. Its tool stayed on the Mac, so the route was re-created from its description, and it sets the
heading with `placeProbe`'s ViewRotation write.

**The rows' tools** (step 1 below, 2026-10-28):
* `hitch-run.mjs` records a session with the in-page hitch log, in Chromium or Firefox ([hitch log](hitch-log.md)).
* `hitch-summary.mjs` gives its figures and judges rows 7.2.1 to 7.2.5.
* `hitch-ab.mjs` runs interleaved arms with each one's CPU.
* `frame-time-set.mjs` runs the set.
* `gecko-gc.mjs` and `hitch-frame-profile.mjs` attribute a stall.

"Frame work" is the page's `animate` and the worker's `w.dur`, per frame. 7.2.1 takes the larger of the two medians, since in
worker mode the two run side by side and the slower bounds the frame rate.

## The scoreboard (2026-11-04)

| Clause | PASS | PARTIAL | FAIL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 7.1 Supported browsers | 0 | 3 | 0 | 1 | 0 |
| 7.2 Frame time | 0 | 2 | 2 | 1 | 0 |
| 7.3 Loading time | 0 | 2 | 1 | 0 | 0 |
| 7.4 Memory and long sessions | 0 | 2 | 0 | 1 | 0 |
| 7.5 Audio | 0 | 2 | 0 | 0 | 0 |
| 7.6 Window and input | 0 | 4 | 0 | 0 | 0 |
| 7.7 Graphics capability and failures | 3 | 0 | 0 | 0 | 0 |
| 7.8 Files and storage | 0 | 3 | 0 | 1 | 0 |
| 7.9 Failure recovery | 1 | 2 | 0 | 0 | 0 |
| 7.10 Regression coverage | 0 | 2 | 0 | 1 | 0 |
| 7.11 Excluded | 0 | 0 | 0 | 0 | 3 |
| **Total** | 4 | 22 | 3 | 5 | 3 |

## The rows

### 7.1 Supported browsers (D1)

A browser passes when the browser suite (7.10.2) and this stage's browser validators pass in it, and when a ten-minute session
runs without a runtime error. The session starts from the original start, loads Training, makes a map change, saves, loads and
plays sound.

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1.1 | Chrome, macOS, worker mode | H | `npx playwright test`, the 7.x validators | Mac | weak: the Mac has not run the suite since early October; on Linux it runs (7.1.2) | PARTIAL |
| 7.1.2 | Chrome, Linux, worker mode | H | the same, `--project chromium` | Linux | weak: the suite on 2026-10-28: 41 of 41 (39 in the whole run, its two failures run again: a fixed race and one unexplained instructor-conversation failure that passed three reruns); the 7.x validators are not run as a set | PARTIAL |
| 7.1.3 | Firefox, macOS and Linux, inline mode | H | the suite, `--project firefox`, validate-inline-restore-play, validate-context-loss-play --browser firefox | Mac, Linux | weak: the suite on 2026-10-28 (Linux): 41 of 41, after four Firefox Play bugs it found were fixed (the wheel; the inline Saves and CRT buttons; the pointer after Alt+Enter; later saves held by the persist() prompt) and its menu specs got a portable cursor driver; the Mac not run | PARTIAL |
| 7.1.4 | Safari, macOS | H | the suite under Playwright's WebKit as a stand-in (`--project webkit`, on the Mac), the session in real Safari (by hand or safaridriver) | Mac | needed: never run; Playwright's Linux WebKit is an Ubuntu build that this host's libraries do not run (ICU 74, libxml2.so.2, flite); Safari's storage eviction, no Keyboard Lock, no `showDirectoryPicker` | MISSING |

### 7.2 Frame time (D2, D3)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.2.1 | Chrome, worker: on each map of the frame-time set, the larger of the page's and the worker's median frame work ≤ 8.3 ms (AGENTS.md) | H | frame-time-set.mjs (hitch-run.mjs --mode scan, hitch-summary.mjs) | Mac | needed: a Mac measurement. Indicative, Linux 2026-11-05 (0f6d1eeb, god mode, [frame cost](play-frame-cost.md#the-frame-time-set-on-2026-11-05-linux)): every map worker-bound; nine of ten under the bound (Training 4.3, the Bar 4.9, Battery Park 8.2, the Airfield 8.2, Wan Chai's market 8.2, the Ship 6.5, the Chateau 5.8, Everett 4.6, the bunker 7.9 ms), the Island over at 8.4 ms (2026-11-04: 8.7 to 8.9); one run's median moves by up to 0.8 ms between runs of one build; the Mac's tick was about 1.35 times this host's | MISSING |
| 7.2.2 | every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps' jitter) | H | frame-time-set.mjs --browser B --headed (a visible window: headless Chromium draws on a synthetic 60 Hz clock) | Mac | Linux, 2026-11-05 (f2f1cb6f, 240 Hz display, [frame cost](play-frame-cost.md#row-722-headed-2026-11-05-linux)): Chrome worker passes on all ten maps (p95 8.3 to 14.9 ms, 116 to 218 fps); Firefox inline fails on six (Island 21, Ship 21, Airfield 25, Wan Chai 25, Bunker 25, Battery Park 31 ms; 37 to 59 fps), its page frame about twice Chrome's worker frame (the level tick 1.8 to 2.4 times); the Mac and Safari not run | FAIL |
| 7.2.3 | Chrome: from a map's first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam | H | hitch-run.mjs --mode roam --seconds 120, hitch-summary.mjs | Mac | weak: Linux only: with all cores, no gap over 100 ms on the Island and WanChai Underworld; pinned to two cores (a loaded machine, where the user feels it on the Mac) 2 to 4 gaps over 100 ms a run, up to 350 ms, each the worker's major GC (2026-10-28, docs/live-heap.md); not on the Mac | PARTIAL |
| 7.2.4 | Firefox inline: from a map's first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3) | H | hitch-ab.mjs or hitch-run.mjs --browser firefox, hitch-summary.mjs, gecko-gaps.mjs (with --profile) | Mac, Linux | fails on its second half: on the Island, Linux, 2026-10-31 (d01854c9, after the live-heap work), three 100 s roams drew no gap over 150 ms and at most one over 100 ms (longest 84, 101, 101 ms), but 10 to 18 over 50 ms a minute (2026-10-28: 26 to 31 over 50 ms in 65 s, longest 133 ms). A Gecko profile of one roam puts 12 of its 31 on major-collection slices (5 to 80 ms, 11 in two collections) and 19 on no pause (long page frames: sim and draw on one thread, 17 to 20 ms median). The worker is no way out: its non-incremental collections freeze 14 times over 150 ms a roam (up to 366 ms) idle, and once every 25 to 40 s for 200 to 250 ms with ?workerBusy=1 (docs/hitch-log.md "Firefox") | FAIL |
| 7.2.5 | no shader program is compiled during play after a load | P | hitch-summary.mjs (programs created from 5 s on) over the frame-time set | Mac, Linux | weak: 0 programs on all ten maps of the frame-time set (Chrome, Linux, 2026-11-04), and on the Island in Firefox (2026-10-28); the Mac is not measured | PARTIAL |

### 7.3 Loading time (D4)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.3.1 | navigation to the logo map's first frame ≤ 10 s (Chrome and Firefox) | H | profile-map-load.mjs --start original --folder ([load time](load-time.md#the-stage-7-rows-2026-11-04-linux)) | Mac | weak: passes on Linux, 2026-11-04, the production build with the folder given at the picker: Chromium 4.7 to 4.8 s, Firefox 6.1 to 6.3 s (the dev server adds 1.5 to 2 s); the Mac not run | PARTIAL |
| 7.3.2 | a travel arrival's first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map | H | profile-map-load.mjs --travel --maps all (the 83 maps) | Mac | weak: passes on Linux, 2026-11-04: all 83 arrive; Chromium median 2.23 s, max 4.30 s (Paris Metro); Firefox, the production build in fresh browsers of about 20 maps, median 4.17 s, max 8.73 s (on a machine under a background load, 11.6 s); the Mac not run | PARTIAL |
| 7.3.3 | Load Game to the first frame ≤ 8 s | H | profile-map-load.mjs --saves (the internet corpus's 39 slots of one playthrough, each by `loadgame N`) | Mac | Linux, 2026-11-04, the production build: every slot loads in both; Chromium median 2.13 s, max 4.20 s, cold 2.85 to 4.12 s (passes); Firefox median 5.22 s, every slot under the bound but the Island's Save0001, cold 7.94 to 8.19 s (median 8.05 of six runs): the page's world build 1.3 s and the simulation's createGame 5.5 s, one after the other on its one thread; the Mac not run | FAIL |

### 7.4 Memory and long sessions (D5)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.4.1 | ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope | P | validate-process-memory.mjs (by hand), map-memory-census.mjs --maps (the same sequence in the page; [memory across many maps](map-memory.md)) | Linux, Mac | weak: Linux, 2026-11-05: passes in Node (the heap 0.65 MB a round trip, ArrayBuffers flat); in the page, Chromium (worker) and Firefox (inline) hold the same process state at every Training arrival (990 classes, the same packages, the same page store), the same level arena (31 MB in Chromium, 35 in Firefox) and the page flat, and after forced collections the total at Training rises 0.4 MB a round trip in both once the script-VM kernel has reached its high-water mark (9.6 and 8.1 MB before): the level interpreter's handle tables, which covered every handle the process had allocated, now cover the level's own handles and those live when it starts ([the handle tables](map-memory.md#the-handle-tables-2026-11-05-linux)), and the purged meshes' lazy arrays are destroyed as the original destroys them ([mesh destruction](mesh-destruction.md): ~ULodMesh/~UMesh compared call by call with the original in Unicorn). Over the 83 distinct maps six faults were found and fixed (Firefox kept every left level alive through the interpreter's WeakRef walks, the 16 GB OOM; a left arena waited for its objects' finalizers; speech packages never released; the trace kernel's arena grew with each map; the handle tables; the lazy arrays): with the handle tables bounded (before the meshes' destruction landed) every level arena stays at 29 to 36 MB (Chromium) and 29 to 41 MB (Firefox), 221 MB at the end before, and after forced collections the total is 0.80 to 1.16 GB (Chromium) and 0.58 to 1.00 GB (Firefox), its slope over the last 42 maps 0.4 and 0.8 MB a map; without forced collections both reach the 83rd map (the tree at most 6.2 GB in Chromium, 6.1 GB in Firefox; 7.4 and 9.4 before); the Mac not run | PARTIAL |
| 7.4.2 | each map of the frame-time set stays within a declared memory budget (page plus worker, after GC) | H | profile-live-heap.mjs, profile-firefox-memory.mjs | Mac | needed: the budget, to fit a 16 GB machine; today the Island's worker reaches 1.4 GB before a GC in Chrome | MISSING |
| 7.4.3 | the one-hour session (D5) in Chrome and Firefox | H | session-hour.mjs ([long session](long-session.md)) | Mac | weak: passes on Linux, 2026-11-04 (8f82b56b), with the first plateau after a warm-up pass of the route (the user's reading of D5): no runtime error, ten map changes, five save and load round trips; the last Island visit's heap -2.4 % (Chrome, worker) and +6.2 % (Firefox, inline) from the warm plateau, the median frame work -10 % (page) and -9.4 % (worker) in Chrome, 0 % in Firefox. From a cold start both failed (+33 %, +44 %): the process filling its classes, packages and caches. The runs found five memory faults and every visited map's procedural textures ticking each frame (about 0.5 ms once warm), all fixed. The Mac not run | PARTIAL |

### 7.5 Audio (D6)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.5.1 | sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser | H | browser-tests/audio-resume.spec.mjs, validate-galaxy-music-play.mjs | Mac, Linux | weak: passes in Chromium and Firefox on Linux, 2026-11-04: the first click starts the logo map's song; a hidden page (modelled, as headless browsers keep a background tab visible) keeps the mix playing, as the original's DSBCAPS_GLOBALFOCUS buffer does, and the game's sound comes back with its ticks; a suspended context resumes by itself (before, only a key or a click resumed it, and a key after Exit brought the sound back); a real hidden tab, a system interruption, WebKit and the Mac not run | PARTIAL |
| 7.5.2 | a sound's latency from PlaySound to output ≤ the original's plus one render quantum (D6) | O | galaxy-output-capture.sh latency and audio-latency-original.mjs (the original under Wine), audio-latency.mjs (Play; [sound start latency](audio-latency.md)) | Mac, Linux | weak: passes on Linux, 2026-11-04: from a start to the host taking its first frame out of Galaxy's buffer (D6's "output" as the user chose to read it, 2026-11-04; each host's own buffering to the device after it is reported, not bounded), the original under Wine 11.20 over 20 minutes (the phase of Galaxy's 20 ms timer against Wine's 10 ms mixer moves its figure by several ms, so a minute is not enough) median 45.6 ms and p95 56.1; Play in Chromium (worker) 46.0 and 55.4, in Firefox (inline) 45.0 and 55.7. The Mac (CrossOver, 2,048-byte periods) not run | PARTIAL |

### 7.6 Window and input

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.6.1 | the pointer lock is taken on the first click; one Escape releases it and reaches the game (MenuMain); a lost lock or a blur lets go of the held input and Play goes on (no pause, the user's choice 2026-10-30); a hidden page resumes without catch-up | H | browser-tests/pointer-lock.spec.mjs, browser-tests/original-start-input.spec.mjs | all browsers | weak: Chrome's worker mode, headless, Linux (2026-10-30): the browser's Escape rule played as its call (exitPointerLock, no key) opens MenuMain once, a delivered key as well counts once, the free mouse drives the menu; a blur lets go of the held movement and the level's clock goes on; a real Escape is not exercised under Playwright (the user saw two presses needed on Chrome Linux and macOS before the change); the hidden-page resume is not tested; Firefox not rerun; WebKit and the Mac not run | PARTIAL |
| 7.6.2 | Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari) | O, H | browser-tests/original-start-input.spec.mjs, input-bindings.spec.mjs | all browsers | weak: passes in Chromium and Firefox on Linux (2026-10-28): Keyboard Lock where the browser has it, and in Firefox Alt+Enter takes the fullscreen and the pointer without it (the pointer asked again at fullscreenchange, which Firefox needs); a held Escape and F11 in a real browser are not exercised; WebKit and the Mac not run | PARTIAL |
| 7.6.3 | resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error | H | validate-resize-play.mjs, [a resize](boot.md#a-resize) | Linux, Mac | weak: resizes during Play equal a fresh load at the final size byte for byte, the frame and MenuMain over the kept frame, in Chromium and Firefox on Linux (2026-10-31), and the page at a new pixel ratio does in Chromium; a real ratio change (a zoom, another screen) is not produced headless, so `watchPixelRatio` is unmeasured; the Mac not run | PARTIAL |
| 7.6.4 | a hidden tab or system sleep stops Play (no frame, no tick); it comes back by itself with no catch-up (no click: the user's choice, 2026-10-30) and the audio follows | H | pointer-lock.spec.mjs (blur), browser-tests/hidden-tab.spec.mjs | all browsers | weak: blur is tested (the game goes on, held input let go); the hidden page passes in Chromium and Firefox on Linux (2026-10-31: no frame and no tick while hidden, back with no click, no catch-up, the held input let go) with the hide modelled (`document.hidden`, `visibilitychange`, no animation frame), as headless browsers keep a background tab visible; a real hidden tab, system sleep and the audio not measured | PARTIAL |

### 7.7 Graphics capability and failures

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.7.1 | a lost WebGL context freezes Play and restores it as D3DDrv's `Lock` does; the frames after equal a run with no loss | O | validate-context-loss-play.mjs (Chromium worker and inline, Firefox) | Linux | weak: Safari, and the Mac, not run | PASS |
| 7.7.2 | no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back | H | browser-tests/no-webgl.spec.mjs, browser-tests/graphics-fallback.spec.mjs, browser-tests/lodmesh-wasm.spec.mjs, [no WebGL 2](boot.md#no-webgl-2) | Linux | weak: the three specs pass in Chromium and Firefox on Linux (2026-10-31); WebKit not run | PASS |
| 7.7.3 | a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable | H | browser-tests/software-renderer.spec.mjs (Chromium on SwiftShader, Firefox on llvmpipe) | Linux | weak: passes on Linux, 2026-11-04: the renderer is named (Firefox masks it as "llvmpipe, or similar", still recognised), the mesh path is the CPU one, Training keeps real time (game 10.02 and 10.07 s in 10.04 s) and draws 133 fps (SwiftShader) and 195 fps (llvmpipe) at 960×640; "playable" is read as keeping real time, the frame rate reported, not bounded; WebKit not run | PASS |

### 7.8 Files and storage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.8.1 | the game folder opens through the gate's picker in every supported browser | H | browser-tests/viewer.spec.mjs | all browsers | weak: the picker opens the folder in Chromium and Firefox headless (`setInputFiles`; viewer.spec passes in both, 2026-10-28); a real picker is not run | PARTIAL |
| 7.8.2 | saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running | H | browser-tests/save-game.spec.mjs, save-folder.spec.mjs, test/save-store.test.mjs, test/save-persistence.test.mjs | all browsers | weak: the save, load and Saves window specs pass in Chromium and Firefox on Linux (2026-10-28; Firefox's persist() prompt no longer holds the later saves); a real persistence prompt's answer is not observed; the unit tests use a fake store | PARTIAL |
| 7.8.3 | in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads | H, O | save-folder.spec.mjs headed with a real folder, validate-save-game.mjs | Mac, Linux | needed: [save storage](save-storage.md) says a headed Chromium with a real folder was not run | MISSING |
| 7.8.4 | settings persist across reloads in every supported browser (row 6.1.5's proof) | O | browser-tests/config-persistence.spec.mjs, validate-config-persistence.mjs | all browsers | weak: the spec passes in Chromium and Firefox on Linux (2026-10-28); WebKit and the Mac not run | PARTIAL |

### 7.9 Failure recovery

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.9.1 | a runtime error pauses Play with its message, and Player start or a reload recovers | H | browser-tests/runtime-error.spec.mjs | all browsers | weak: the spec passes in Chromium and Firefox on Linux (2026-10-28, brought up to date: the push read from Plant7's Location, the right mouse button to use); WebKit and the Mac not run | PARTIAL |
| 7.9.2 | the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half | H | browser-tests/worker-failure.spec.mjs, [a failed worker](sim-worker.md#a-failed-worker) | Linux | weak: the spec passes in Chromium and Firefox on Linux (2026-10-31): a closed and a looping worker (the page tells them by its posts' silence), a failed call and an uncaught exception, a termination at a save's picture request (the kept slot unchanged); out of memory measured in a bare worker only (a RangeError takes the exception path; Chromium's heap exhaustion crashes the tab into the browser's own page, Firefox's grows the process), not induced in Play | PARTIAL |
| 7.9.3 | a graphics device that never comes back: the page says so, and a reload recovers | H | validate-context-loss-play.mjs --case never, [context loss](context-loss.md) | Linux | weak: Chromium (worker and inline) and Firefox on Linux (2026-10-31); WebKit not run | PASS |

### 7.10 Regression coverage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.10.1 | the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`) | P | run-validators.mjs | Linux, with the Mac's stores | weak: on 2026-10-30, after the 6 reds of 2026-10-27 and 25 newer ones were fixed (ac8e211b, 65ab361c, the reds-2026-10-30 branch on 82482dcb): 677 passed, 8 skipped, 1 failed; validate-gpu-mesh stalled idle to the 600 s limit and passes alone (104 s) and on 1.5 cores (116 s), its stall not explained (the runner now prints a killed check's last stdout); not run on the closing commit | PARTIAL |
| 7.10.2 | the browser suite passes in every supported browser | P | `npx playwright test` (projects chromium, firefox, webkit), SUITE_RUN, `--suite` | Mac, Linux | weak: Chromium 50 of 50 and Firefox 49 of 50 on Linux (2026-10-31; the Firefox red, the first save reopening MenuMain, fixed in 30190c15 and its spec passing since); WebKit and the Mac not run | PARTIAL |
| 7.10.3 | the Stage 4, 5 and 6 gates pass on the closing commit | P, O | validate-stage4-acceptance.mjs, validate-stage5-acceptance.mjs, stage6-criteria.mjs | Linux, Mac | needed: a run on one commit (last runs: Stage 4 on 2026-10-17, Stage 5 on 2026-10-21, Stage 6's rows by 2026-10-26) | MISSING |

### 7.11 Excluded

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.11.1 | multiplayer | - | - | - | the last priority (AGENTS.md) | EXCLUDED |
| 7.11.2 | mobile and touch browsers | - | - | - | the game takes a keyboard and a mouse | EXCLUDED |
| 7.11.3 | Windows | - | - | - | no Windows machine (D1); Chrome's engine rows stand in for Chrome and Edge there, unmeasured | EXCLUDED |

## The browser suite by browser

Last run 2026-10-28 on the Linux host (AMD, Arch), headless but pointer-lock.spec, at f2d01365, 41 tests a browser, one worker. The third whole run of the day; its two Chromium failures ran again, three times each, from a frozen worktree (DX_SUITE_TREE): gameplay.spec after its settle and jump checks were fixed, instructor-conversation.spec as it was (it failed once in the whole run, no speaker within 8 s, and passed the three reruns; not explained):

- chromium 153.0.8010.12 (worker mode): 41 pass, 0 fail, 23 min.
- firefox 155.0 (inline mode): 41 pass, 0 fail, 19 min.
- webkit: not run. Playwright's Linux WebKit needs Ubuntu's libraries (ICU 74, libxml2.so.2, flite); it runs on the Mac.

Causes: **stale**, the spec predates a change in Play and fails in every browser; **race**, the spec reads a state before worker mode delivers it; **harness**, Playwright's synthetic input is not a real browser's, and the spec cannot pass as written; **api**, the spec needs a Chromium-only API; **play**, a Play bug in that browser or simulation mode. A test not listed passed in every browser that ran.

| Test | chromium | firefox | Why |
| --- | --- | --- | --- |
| original-start-input.spec.mjs:14 | pass | pass | harness (Firefox): under Playwright's Firefox pointer lock `movementX/Y` is an offset from a fixed point, so the menus' cursor never reached Training; then play: Alt+Enter back into fullscreen left Firefox without the pointer (a lock asked in the same event as the fullscreen is refused, NotAllowedError). **Fixed:** browser-tests/menu-cursor.mjs dispatches the steps outside Chromium; the page asks for the lock again at fullscreenchange |
| original-start-load-game.spec.mjs:12 | pass | pass | harness (Firefox): the same motion. **Fixed:** menu-cursor.mjs |
| load-game.spec.mjs:61 | pass | pass | play then harness (Firefox): the Saves button in inline mode, then the motion. **Fixed:** the inline game answers `windowMouseGrabbed`; menu-cursor.mjs |
| save-folder.spec.mjs:166 | pass | pass | play then harness (Firefox): the same. **Fixed:** the same |
| save-folder.spec.mjs:213 | pass | pass | play (Firefox): the Saves button in inline mode. **Fixed:** the inline game answers `windowMouseGrabbed` |
| save-game.spec.mjs:71 | pass | pass | harness then play (Firefox): the motion; then the first save's `navigator.storage.persist()` prompt, which Firefox leaves pending until the player answers, held every later save in the storage queue (the second was never written), and took the pointer lock back. **Fixed:** menu-cursor.mjs; persist() is no longer awaited (save-persistence.mjs); the spec's cursor reaches the menu at the pointer's own position while the lock is gone |
| save-game.spec.mjs:186 | pass | pass | harness (Firefox): the motion. **Fixed:** menu-cursor.mjs |
| input-bindings.spec.mjs:106 | pass | pass | api (Firefox): Keyboard Lock is Chromium's. **Fixed:** checked where the browser has it; without it, Alt+Enter takes the fullscreen and the pointer and calls nothing |
| pointer-lock.spec.mjs:10 | pass | pass | harness: a synthetic Escape never reaches the browser's own release of the lock. **Fixed:** the spec releases the lock as that rule does (exitPointerLock) and checks the page's part: the lost lock lets go of the held movement |
| input-bindings.spec.mjs:17 | pass | pass | play (Firefox): a tickless `wheelDeltaY` is -round(3 × `deltaY`) in Gecko, and a notch counted 2.5. **Fixed:** `wheelUnits(event, {gecko})` takes that value by the pixel rule |
| pointer-lock.spec.mjs:27 | pass | pass | race (Chromium): the frozen state was read before the posts made before the blur landed. **Fixed:** the frozen state is the first status the next one repeats |
| gameplay.spec.mjs:23 | pass | pass | race (Chromium): `settled` took the spawn while its first ticks still moved it; the jump's top was missed between worker-mode statuses; the spawn's resting height varies with the first ticks' frame times (-80.40 or -80.20). **Fixed:** settled is the simulation's own location unchanged over 0.1 s of its time; the jump is read from viewProbe; the reload is compared in x and y, and in z within 0.5 |
| viewer.spec.mjs:12 | pass | pass | race (Chromium): the draw calls were read before worker mode drew after Player start. **Fixed:** it waits for a draw, and holds W until the inspection camera has moved 100 units |
| viewer.spec.mjs:54 | pass | pass | stale: only Wasm was allowed after the folder is chosen. **Fixed:** the build's own scripts and Wasm (same-origin GETs under /assets/) are |
| native-math.spec.mjs:4 | pass | pass | stale: the sine table's hash from before entry 8192 became the hardware x87's. **Fixed:** b8d75604..., as test/coords.test.mjs |
| lodmesh-wasm.spec.mjs:7 | pass | pass | stale: a JavaScript pose fallback the Rust core replaced. **Fixed:** it checks what a refused WebAssembly does now (inspection only, Play disabled, "Play mode unavailable" in the debugging page's notes; the default start still says nothing, 7.7.2) |
| runtime-error.spec.mjs:14 | pass | pass | stale: a deferred Plant7.PushSound, which plays now. **Fixed:** the push is Plant7's Location (liveProbe) |
| runtime-error.spec.mjs:49 | pass | pass | stale: F for use, and the page's old use counter. **Fixed:** the right mouse button, and the door's mover |
| instructor-conversation.spec.mjs:12 | pass | pass | stale: it patched main.mjs source that no longer exists; F for use. **Fixed:** rewritten on the simulation's probes and the right mouse button (one unexplained Chromium failure in the third run, then three passes) |
| training-walk.spec.mjs:12 | pass | pass | stale: the same source patch; F for use. **Fixed:** rewritten on the probes, with the player's place from viewProbe, a straight walk to the key and the view swept across the trainer's door |
| input-bindings-table.spec.mjs:16 | pass | pass | stale: its QuickSave case expected native 3011 unimplemented. **Fixed:** QuickSave runs in Play (the headless validator keeps the 3011 boundary) |

## The order of the work

1. **Tools into Git.** Done 2026-10-28. `hitch-run.mjs`, `hitch-summary.mjs`, `hitch-ab.mjs`, `frame-time-set.mjs`,
   `gecko-gc.mjs` and `hitch-frame-profile.mjs` replace the `.work/hitch/` copies, with the census route re-created as
   `--mode scan`. `stage7-criteria.mjs` holds the rows.
2. **The browser matrix runs.** Playwright projects for Firefox and WebKit (7.10.2), a first Safari session (7.1.4), and the
   Chromium-only specs extended to the other browsers (7.5.1, 7.6.x, 7.8.x, 7.9.1). These are cheap, and they find the
   browser-specific failures before any performance work. Begun 2026-10-28: the projects exist (`--project chromium|firefox|webkit`;
   the specs that took Chromium's full headless build keep it through `browser-tests/browsers.mjs`), and the suite ran in Chromium
   and Firefox on Linux ([above](#the-browser-suite-by-browser)). The run found two Play bugs, both
   fixed (Firefox's wheel, the inline mode's page buttons); the worker-mode blur it flagged was the spec's early read. The stale specs and
   races were brought up to date the same day (the second run: Chromium 40 of 41, Firefox 33 of 41), and the specs can run against a
   frozen worktree (`DX_SUITE_TREE`) while the checkout is edited. A portable driver for the menus'
   cursor (`browser-tests/menu-cursor.mjs`) and a Firefox expectation without Keyboard Lock followed, and the suite passes 41 of 41 in
   Chromium and Firefox on Linux; two more Firefox bugs they found are fixed (the pointer after Alt+Enter, later saves held by the
   `persist()` prompt). Left: WebKit and Safari, and the suite on the Mac.
3. **The small reliability gaps.** A creation-error message (7.7.2), a resize spec (7.6.3), the hidden tab (7.6.4), a
   worker failure (7.9.2) and a device that never returns (7.9.3). Done 2026-10-31 on Linux: 7.7.2 and 7.9.3 pass; a worker that stops
   answering is now told by its posts' silence (7.9.2), a pixel ratio change now resizes the canvas (7.6.3), and the hidden tab is checked
   with the hide modelled (7.6.4). What headless browsers cannot produce stays open in those rows: a JavaScript heap out of memory in
   Play, a real ratio change, a real hidden tab and sleep.
4. **A measurement pass on the Mac.** The frame-time set, the load census and the memory budget in every browser (7.2,
   7.3, 7.4.2) give each row its first status on the reference machine.
5. **The performance work against 7.2.1.** Each step goes family by family, as a measurement names it, in the Rust core
   (AGENTS.md), and only for gains over 5%.
6. **The long session** (7.4.3) and the audio latency (7.5.2, which starts with the original's measurement). Both pass on Linux
   (2026-11-04: [long session](long-session.md), [sound start latency](audio-latency.md)); the Mac is left.
7. **The gate.** The sweep, the browser suite and the earlier stages' gates on one commit (7.10).
