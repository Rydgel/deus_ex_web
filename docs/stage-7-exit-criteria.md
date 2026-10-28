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
6. **D6, audio latency.** The original's latency (Galaxy's mix buffer through DirectSound) has not been measured. Following
   the fidelity rule, the recommendation is to measure it under Wine first, then hold Play to it: the time from a sound's
   PlaySound call to its first output sample, at most the original's plus one browser render quantum.

   The alternative is a host bound of 100 ms with no original reference.

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

## The scoreboard (2026-10-28)

| Clause | PASS | PARTIAL | FAIL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 7.1 Supported browsers | 0 | 2 | 1 | 1 | 0 |
| 7.2 Frame time | 0 | 2 | 1 | 2 | 0 |
| 7.3 Loading time | 0 | 1 | 0 | 2 | 0 |
| 7.4 Memory and long sessions | 0 | 1 | 0 | 2 | 0 |
| 7.5 Audio | 0 | 1 | 0 | 1 | 0 |
| 7.6 Window and input | 0 | 2 | 1 | 1 | 0 |
| 7.7 Graphics capability and failures | 1 | 1 | 0 | 1 | 0 |
| 7.8 Files and storage | 0 | 3 | 0 | 1 | 0 |
| 7.9 Failure recovery | 0 | 2 | 0 | 1 | 0 |
| 7.10 Regression coverage | 0 | 0 | 2 | 1 | 0 |
| 7.11 Excluded | 0 | 0 | 0 | 0 | 3 |
| **Total** | 1 | 15 | 5 | 13 | 3 |

## The rows

### 7.1 Supported browsers (D1)

A browser passes when the browser suite (7.10.2) and this stage's browser validators pass in it, and when a ten-minute session
runs without a runtime error. The session starts from the original start, loads Training, makes a map change, saves, loads and
plays sound.

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1.1 | Chrome, macOS, worker mode | H | `npx playwright test`, the 7.x validators | Mac | weak: the Mac has not run the suite since early October; on Linux it runs (7.1.2) | PARTIAL |
| 7.1.2 | Chrome, Linux, worker mode | H | the same, `--project chromium` | Linux | weak: the suite on 2026-10-28: 29 of 41 pass; of the 12 failures 8 are stale specs, 2 races of a spec with worker mode, 1 Playwright's synthetic Escape and 1 a Play bug (a blur in worker mode, 7.6.1); the 7.x validators are not run as a set | PARTIAL |
| 7.1.3 | Firefox, macOS and Linux, inline mode | H | the suite, `--project firefox`, validate-inline-restore-play, validate-context-loss-play --browser firefox | Mac, Linux | fails: the suite on 2026-10-28 (Linux), 23 of 41 pass; two Play bugs fail five tests (the wheel counts a notch 2.5 times; the default start's Saves and CRT buttons never show in inline mode), and of the other 13, 7 are stale specs, 5 Playwright's synthetic input under the pointer lock or Escape and 1 Chromium's Keyboard Lock. The Mac not run | FAIL |
| 7.1.4 | Safari, macOS | H | the suite under Playwright's WebKit as a stand-in (`--project webkit`, on the Mac), the session in real Safari (by hand or safaridriver) | Mac | needed: never run; Playwright's Linux WebKit is an Ubuntu build that this host's libraries do not run (ICU 74, libxml2.so.2, flite); Safari's storage eviction, no Keyboard Lock, no `showDirectoryPicker` | MISSING |

### 7.2 Frame time (D2, D3)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.2.1 | Chrome, worker: on each map of the frame-time set, the larger of the page's and the worker's median frame work ≤ 8.3 ms (AGENTS.md) | H | frame-time-set.mjs (hitch-run.mjs --mode scan, hitch-summary.mjs) | Mac | needed: a Mac measurement. Indicative: the Island's worker frame p50 12.2 ms on Linux (2026-10-27) | MISSING |
| 7.2.2 | every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps' jitter) | H | frame-time-set.mjs --browser B, headed (hitch-run.mjs --headed) | Mac | needed: a headed run per browser. Indicative: Firefox inline draws 43 to 45 fps on the Island on Linux | MISSING |
| 7.2.3 | Chrome: from a map's first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam | H | hitch-run.mjs --mode roam --seconds 120, hitch-summary.mjs | Mac | weak: measured on Linux only (after 2026-10-27, one roam: draw gap p99 16.8 ms, one 26 ms worker GC); not on the Mac | PARTIAL |
| 7.2.4 | Firefox inline: from a map's first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3) | H | hitch-ab.mjs or hitch-run.mjs --browser firefox, hitch-summary.mjs | Mac, Linux | fails today: 26 to 31 gaps over 50 ms and 6 to 8 over 90 ms in 65 s from 40 s after the map, longest 133 ms (Linux, 2026-10-28); the work is the parked live-heap plan | FAIL |
| 7.2.5 | no shader program is compiled during play after a load | P | hitch-summary.mjs (programs created from 5 s on) over the frame-time set | Mac, Linux | weak: 0 programs measured on the Island, Airfield and UNATCO HQ (Chrome) and the Island (Firefox), on Linux; the Mac is not measured | PARTIAL |

### 7.3 Loading time (D4)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.3.1 | navigation to the logo map's first frame ≤ 10 s (Chrome and Firefox) | H | profile-map-load.mjs (the first map from navigation) | Mac | needed: a measurement of the original start, not of `?debug=1` Training | MISSING |
| 7.3.2 | a travel arrival's first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map | H | profile-map-load.mjs --travel, as a census over the 83 maps | Mac | weak: measured for the Island (4.6 s) and Training (1.5 s) in Chrome only | PARTIAL |
| 7.3.3 | Load Game to the first frame ≤ 8 s | H | profile-map-load.mjs over the internet save corpus's slots | Mac | needed: the measurement; no tool times a load from a save | MISSING |

### 7.4 Memory and long sessions (D5)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.4.1 | ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope | P | validate-process-memory.mjs (by hand), the same sequence in the page | Linux, Mac | weak: passes in Node, which has no page, worker, GPU or audio; the browser's page and worker heaps are not measured over map changes | PARTIAL |
| 7.4.2 | each map of the frame-time set stays within a declared memory budget (page plus worker, after GC) | H | profile-live-heap.mjs, profile-firefox-memory.mjs | Mac | needed: the budget, to fit a 16 GB machine; today the Island's worker reaches 1.4 GB before a GC in Chrome | MISSING |
| 7.4.3 | the one-hour session (D5) in Chrome and Firefox | H | a session harness | Mac | needed: the harness | MISSING |

### 7.5 Audio (D6)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.5.1 | sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser | H | validate-galaxy-music-play.mjs, a browser spec | Mac, Linux | weak: Chromium only; suspension and resume are not checked | PARTIAL |
| 7.5.2 | a sound's latency from PlaySound to output ≤ the original's plus one render quantum (D6) | O | a Wine measurement of the original, `AudioContext.outputLatency` plus the worklet's queue in Play | Mac, Linux | needed: the original's measurement; Play's is not measured | MISSING |

### 7.6 Window and input

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.6.1 | the pointer lock is taken on the first click, Escape releases it, and a lost lock or a blur pauses Play and resumes without catch-up | H | browser-tests/pointer-lock.spec.mjs | all browsers | fails in Chrome's worker mode: after a blur paused the page the player still walked 7.8 units (about 50 ms) (2026-10-28, Linux); Firefox inline freezes at once. The Escape half cannot run under Playwright (a synthetic Escape does not reach the browser's release of the lock) | FAIL |
| 7.6.2 | Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari) | O, H | browser-tests/original-start-input.spec.mjs, input-bindings.spec.mjs | all browsers | weak: passes in Chromium; in Firefox the spec cannot drive the menu (Playwright's pointer-lock motion) and the Keyboard Lock check is Chromium's API; Firefox's fullscreen without it has no check | PARTIAL |
| 7.6.3 | resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error | H | a new spec: resizes during Play, pixels against a fresh load at the final size | Linux, Mac | needed: the spec; nothing tests a resize during Play | MISSING |
| 7.6.4 | a hidden tab or system sleep pauses Play; the game resumes on a click with no catch-up and the audio follows | H | pointer-lock.spec.mjs (blur), a hidden-tab spec | all browsers | weak: blur is tested; `visibilitychange` is not | PARTIAL |

### 7.7 Graphics capability and failures

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.7.1 | a lost WebGL context freezes Play and restores it as D3DDrv's `Lock` does; the frames after equal a run with no loss | O | validate-context-loss-play.mjs (Chromium worker and inline, Firefox) | Linux | weak: Safari, and the Mac, not run | PASS |
| 7.7.2 | no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back | H | a spec with WebGL disabled (`--disable-webgl`), and one with `EXT_color_buffer_float` refused | Linux | needed: a creation error is not handled (only the GPU mesh's missing extensions are); with WebAssembly refused the page stays in inspection and says nothing (lodmesh-wasm.spec, 2026-10-28) | MISSING |
| 7.7.3 | a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable | H | the headless default (SwiftShader) runs | Linux | weak: no validator asserts the path; "playable" has no bound on a software renderer | PARTIAL |

### 7.8 Files and storage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.8.1 | the game folder opens through the gate's picker in every supported browser | H | browser-tests/viewer.spec.mjs | all browsers | weak: the picker opens the folder in Chromium and Firefox headless (`setInputFiles`, 2026-10-28); the spec's request rule is stale, a real picker is not run | PARTIAL |
| 7.8.2 | saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running | H | browser-tests/save-game.spec.mjs, save-folder.spec.mjs, test/save-store.test.mjs, test/save-persistence.test.mjs | all browsers | weak: passes in Chromium; in Firefox the specs stop before saving (the menu cursor under Playwright's pointer lock; the Saves button never shows in inline mode); the unit tests use a fake store | PARTIAL |
| 7.8.3 | in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads | H, O | save-folder.spec.mjs headed with a real folder, validate-save-game.mjs | Mac, Linux | needed: [save storage](save-storage.md) says a headed Chromium with a real folder was not run | MISSING |
| 7.8.4 | settings persist across reloads in every supported browser (row 6.1.5's proof) | O | browser-tests/config-persistence.spec.mjs, validate-config-persistence.mjs | all browsers | weak: the spec passes in Chromium and Firefox on Linux (2026-10-28); WebKit and the Mac not run | PARTIAL |

### 7.9 Failure recovery

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.9.1 | a runtime error pauses Play with its message, and Player start or a reload recovers | H | browser-tests/runtime-error.spec.mjs | all browsers | weak: the spec is stale in every browser (it waits for a deferred push sound nothing records now, and uses F to open a door) | PARTIAL |
| 7.9.2 | the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half | H | a spec that terminates the worker and one that throws in it | Linux | needed: `onFailure` pauses with the error, but no test exists, and what an out-of-memory worker does is unknown | MISSING |
| 7.9.3 | a graphics device that never comes back: the page says so, and a reload recovers | H | validate-context-loss-play.mjs with no restore | Linux | weak: the toast exists ([context loss](context-loss.md)); not tested | PARTIAL |

### 7.10 Regression coverage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.10.1 | the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`) | P | run-validators.mjs | Linux, with the Mac's stores | fails: six reds on a clean head on 2026-10-27 (host-services-play, world-batch-gpu, texture-sampling, lodmesh-lod-play, master-frame-play, conversations-census timeout) | FAIL |
| 7.10.2 | the browser suite passes in every supported browser | P | `npx playwright test` (projects chromium, firefox, webkit), SUITE_RUN, `--suite` | Mac, Linux | fails: on 2026-10-28 (Linux) Chromium 29 of 41, Firefox 23 of 41; WebKit runs on the Mac only | FAIL |
| 7.10.3 | the Stage 4, 5 and 6 gates pass on the closing commit | P, O | validate-stage4-acceptance.mjs, validate-stage5-acceptance.mjs, stage6-criteria.mjs | Linux, Mac | needed: a run on one commit (last runs: Stage 4 on 2026-10-17, Stage 5 on 2026-10-21, Stage 6's rows by 2026-10-26) | MISSING |

### 7.11 Excluded

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.11.1 | multiplayer | - | - | - | the last priority (AGENTS.md) | EXCLUDED |
| 7.11.2 | mobile and touch browsers | - | - | - | the game takes a keyboard and a mouse | EXCLUDED |
| 7.11.3 | Windows | - | - | - | no Windows machine (D1); Chrome's engine rows stand in for Chrome and Edge there, unmeasured | EXCLUDED |

## The browser suite by browser

Last run 2026-10-28 on the Linux host (AMD, Arch), headless but pointer-lock.spec, 41 tests a browser, one worker:

- chromium 153.0.8010.12 (worker mode): 29 pass, 12 fail (2 race, 8 stale, 1 harness, 1 play), 23.9 min.
- firefox 155.0 (inline mode): 23 pass, 18 fail (5 play, 1 api, 7 stale, 5 harness), 49.4 min.
- webkit: not run. Playwright's Linux WebKit needs Ubuntu's libraries (ICU 74, libxml2.so.2, flite); it runs on the Mac.

Causes: **stale**, the spec predates a change in Play and fails in every browser; **race**, the spec reads a state before worker mode delivers it; **harness**, Playwright's synthetic input is not a real browser's, and the spec cannot pass as written; **api**, the spec needs a Chromium-only API; **play**, a Play bug in that browser or simulation mode. A test not listed passed in every browser that ran.

| Test | chromium | firefox | Why |
| --- | --- | --- | --- |
| gameplay.spec.mjs:9 | race | pass | `settled` takes the first grounded snapshot after a load, which in worker mode can be the spawn at z -82.50, a tick before the walk lifts it to -80.20 (the suite failed at the crouch, a rerun at the reload) |
| input-bindings-table.spec.mjs:16 | stale | play | Chromium: its GreyPlus case (scripts/input-binding-cases.mjs) still expects QuickSave to stop at native 3011, which Stage 6 implemented. Firefox stops before it, at the wheel |
| input-bindings.spec.mjs:17 | pass | play | Firefox fills the legacy `wheelDeltaY` with -3 × `deltaY` (-300 for a 100-pixel notch; Chromium gives -120, Windows' units), and wheel-input.mjs takes it for the platform's notch units: a notch counts 2.5 and the belt moves two items. A real wheel in Firefox is not measured |
| input-bindings.spec.mjs:104 | pass | api | Keyboard Lock (`navigator.keyboard.lock`) is Chromium's; Firefox's fullscreen without it needs its own expectation ([input bindings](input-bindings.md)) |
| instructor-conversation.spec.mjs:4 | stale | stale | uses F, the use key before 87926c9e; DefUser.ini binds F to CenterView and RightMouse to use |
| load-game.spec.mjs:60 | pass | play | the default start's Saves and CRT buttons never show in inline mode: main.mjs `placePageButtons` needs `simClient` and the worker's `windowGrab`, so in Firefox no button opens the Saves window |
| lodmesh-wasm.spec.mjs:3 | stale | stale | checks the JavaScript pose fallback for a refused WebAssembly, which the Rust core replaced; with Wasm refused the page stays in inspection and says nothing (row 7.7.2) |
| native-math.spec.mjs:3 | stale | stale | expects the sine table's hash from before entry 8192 became the hardware x87's ([fitting](fitting.md), 2026-10-18); test/coords.test.mjs holds the current b8d75604... |
| original-start-input.spec.mjs:13 | pass | harness | the original menus' cursor follows relative motion; under Playwright's Firefox pointer lock `movementX/Y` is a synthetic point's offset from a fixed point (-465 for a 25-pixel step), so the cursor never reaches Training. A real mouse in Firefox is not measured |
| original-start-load-game.spec.mjs:11 | pass | harness | the same motion: the click lands off Load Game |
| pointer-lock.spec.mjs:5 | harness | harness | the browser's own Escape rule releases the lock, and a synthetic Escape does not reach it (original-start-input.spec.mjs's note) |
| pointer-lock.spec.mjs:15 | play | pass | worker mode: the player walked 7.8 units (about 50 ms) after a blur paused the page; inline mode freezes at once. Whether frames in flight or ticks before the worker hears of the pause is not traced |
| runtime-error.spec.mjs:11 | stale | stale | waits for Plant7.PushSound among the deferred effects; nothing records it there now |
| runtime-error.spec.mjs:48 | stale | stale | uses F to open the first door |
| save-folder.spec.mjs:165 | pass | play | the Saves button in inline mode (load-game.spec.mjs:60) |
| save-folder.spec.mjs:212 | pass | play | the same |
| save-game.spec.mjs:63 | pass | harness | the menu cursor's motion (original-start-input.spec.mjs:13): Training is never clicked |
| save-game.spec.mjs:178 | pass | harness | the same |
| training-walk.spec.mjs:4 | stale | stale | uses F to open the doors, and its fixture patches main.mjs's source to read the page's `game`, which worker mode keeps in the worker |
| viewer.spec.mjs:11 | race | pass | reads the draw calls right after Player start, before worker mode draws again (0; 1835 a frame later) |
| viewer.spec.mjs:50 | stale | stale | allows only Wasm after the folder is chosen; the simulation worker and the lazy modules load then too (35 scripts in Chromium, 2 in Firefox), all same-origin GETs, which is the rule that matters |

## The order of the work

1. **Tools into Git.** Done 2026-10-28. `hitch-run.mjs`, `hitch-summary.mjs`, `hitch-ab.mjs`, `frame-time-set.mjs`,
   `gecko-gc.mjs` and `hitch-frame-profile.mjs` replace the `.work/hitch/` copies, with the census route re-created as
   `--mode scan`. `stage7-criteria.mjs` holds the rows.
2. **The browser matrix runs.** Playwright projects for Firefox and WebKit (7.10.2), a first Safari session (7.1.4), and the
   Chromium-only specs extended to the other browsers (7.5.1, 7.6.x, 7.8.x, 7.9.1). These are cheap, and they find the
   browser-specific failures before any performance work. Begun 2026-10-28: the projects exist (`--project chromium|firefox|webkit`;
   the specs that took Chromium's full headless build keep it through `browser-tests/browsers.mjs`), and the suite ran in Chromium
   and Firefox on Linux ([above](#the-browser-suite-by-browser)). Left: the two Firefox Play bugs and the worker-mode blur, the
   stale specs and races, a portable way to move the menus' cursor (the harness rows), WebKit and Safari on the Mac.
3. **The small reliability gaps.** A creation-error message (7.7.2), a resize spec (7.6.3), the hidden tab (7.6.4), a
   worker failure (7.9.2) and a device that never returns (7.9.3).
4. **A measurement pass on the Mac.** The frame-time set, the load census and the memory budget in every browser (7.2,
   7.3, 7.4.2) give each row its first status on the reference machine.
5. **The performance work against 7.2.1.** Each step goes family by family, as a measurement names it, in the Rust core
   (AGENTS.md), and only for gains over 5%.
6. **The long session** (7.4.3) and the audio latency (7.5.2, which starts with the original's measurement).
7. **The gate.** The sweep, the browser suite and the earlier stages' gates on one commit (7.10).
