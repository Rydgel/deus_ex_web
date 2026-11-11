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

AGENTS.md declares one target: **60 fps in Play, 16.7 ms of host work per frame on the reference machine (Apple M2 Pro,
1440×960)**, measured by interleaved A/B medians and browser phase timings. It was 120 fps (8.3 ms) from 2026-09-30 until the
user set 60 fps on 2026-11-05 (D2 below). Fidelity takes precedence over any
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

   **Changed on 2026-11-10: the user dropped Safari ("let's skip safari completely").** Row 7.1.4 is excluded, and "every
   supported browser" in the other rows means Chrome and Firefox. Playwright's WebKit project and the specs' WebKit branches stay in
   the tree, but no row depends on them.
2. **D2, the frame-time gate.** The recommendation is that AGENTS.md's target is the gate:
   * The median host work per frame is at most 8.3 ms on each map of the frame-time set, in Chrome on the reference
     machine (7.2.1).
   * Every supported browser keeps a floor of 60 fps: a drawn-frame interval p95 of at most 16.7 ms on the same set (7.2.2).

   The alternative makes 60 fps the gate and keeps 120 fps as the tracked project target. Today the Island's worker frame
   is 12.2 ms (p50) on the Linux host, and the reference machine has not been measured since early October. Meeting 7.2.1
   is this stage's largest piece of work.

   **2026-11-05:** the user made 60 fps the project's target ("60 fps is a good goal"), in AGENTS.md as well. Row 7.2.1
   keeps AGENTS.md's target, so its bound is now 16.7 ms of median frame work; the 60 fps floor in every browser (7.2.2) is
   unchanged. On Linux, Chrome's worker mode had all ten maps at 8.4 ms or less by then, and passed 7.2.2 headed on all ten;
   Firefox's inline mode is what remains under the floor.
3. **D3, hitches in Firefox.** The user parked Firefox's GC work on 2026-10-28 ([live heap](live-heap.md), steps 2 to 9).
   Inline, Firefox draws six to eight frames of 100 to 133 ms a minute on the Island (incremental GC slices; see
   [frame cost](play-frame-cost.md) "October 27").

   The recommendation is to declare the bound now and leave 7.2.4 FAIL until the work is unparked: no gap over 150 ms, and
   at most two gaps over 50 ms a minute.

   The alternative is to record today's behavior as a known Firefox limit and exclude the row.

   **2026-11-08:** the bound now holds on Linux: four 100 s Island roams on master 8e34e66a drew no gap over 100 ms and 1.2 to 1.8
   over 50 ms a minute (row 7.2.4, PARTIAL until the Mac runs it; [Firefox 60 fps plan](firefox-60fps-plan.md#row-724-on-master-2026-11-08)).

   **2026-11-10:** the user parked the row again ("do both": park 7.2.4 and start the object-model migration). The collectors' window
   (two major collections at about 40 and 47 s that run past 1.5 s, where SpiderMonkey forces long uninterruptible slices) is traced to
   Gecko's idle-slice rule and SpiderMonkey's budget rule ([the collector's window](firefox-60fps-plan.md#the-collectors-window-2026-11-10)).
   Two heap cuts took 3 to 20% off the marking and no gap; halving it means the script process's object model out of JavaScript
   objects, which is under way as its own work ([object model plan](object-model-plan.md)). The row stays FAIL meanwhile.

   **2026-11-11:** the row passes on the reference machine. The Mac's third pass, on a quiet host ([Mac pass](mac-pass-2026-11-10.md#4-firefox-inline-on-the-island-724)),
   drew 0.6 to 1.2 gaps over 50 ms a minute and none over 100 ms in five of five Island roams, headed and headless. There every gap
   is the first frame after a major collection's code discard, and the collections past 1.5 s make none. Linux's clean roams on the
   four heap cuts are within the bound with no margin (1.8, 1.8 and 0 a minute). The object-model migration goes on for that margin.
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
* **Mac**: the reference machine for every number. (It was also the only Safari, which the user dropped on 2026-11-10.)
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

## The scoreboard (2026-11-11)

| Clause | PASS | PARTIAL | FAIL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 7.1 Supported browsers | 2 | 0 | 1 | 0 | 1 |
| 7.2 Frame time | 5 | 0 | 0 | 0 | 0 |
| 7.3 Loading time | 3 | 0 | 0 | 0 | 0 |
| 7.4 Memory and long sessions | 3 | 0 | 0 | 0 | 0 |
| 7.5 Audio | 1 | 1 | 0 | 0 | 0 |
| 7.6 Window and input | 0 | 4 | 0 | 0 | 0 |
| 7.7 Graphics capability and failures | 3 | 0 | 0 | 0 | 0 |
| 7.8 Files and storage | 1 | 2 | 0 | 1 | 0 |
| 7.9 Failure recovery | 3 | 0 | 0 | 0 | 0 |
| 7.10 Regression coverage | 0 | 1 | 1 | 1 | 0 |
| 7.11 Excluded | 0 | 0 | 0 | 0 | 3 |
| **Total** | 21 | 8 | 2 | 2 | 4 |

## The rows

### 7.1 Supported browsers (D1)

A browser passes when the browser suite (7.10.2) and this stage's browser validators pass in it, and when a ten-minute session
runs without a runtime error. The session starts from the original start, loads Training, makes a map change, saves, loads and
plays sound. `scripts/session-ten.mjs` runs it ([the ten-minute session](long-session.md#the-ten-minute-session-row-71-a-browser-passes-with-it)).

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1.1 | Chrome, macOS, worker mode | H | `npx playwright test`, the 7.x validators, session-ten.mjs (the ten-minute session from the original start) | Mac | needed: the suite again on the Mac with instructor-conversation.spec rewritten for the original's radius greeting and lighting.spec's longer poll (2026-11-11); fails on the Mac, 2026-11-11 (881d4cbc, [Mac pass](mac-pass-2026-11-11.md#1-the-suite-711-713-7102)): the suite 47 of 49 run, 4 skipped (no `.work/real-saves` there). Both failures are with the suite's default headless Chromium, which draws with SwiftShader there (15 to 18 fps), and both pass on Metal: instructor-conversation.spec (its placement 80 units from the instructor starts the greeting by radius before the spec's use, as the original's ScriptedPawn.Tick does, and on SwiftShader the 1.8 s greeting is over before the use returns; the spec is rewritten to read the radius greeting, then a use past the repeat gate) and lighting.spec (the page answered 5.9 s after the switch to Inspect and the resize, past the 5 s poll; now 20 s). The 7.x validators pass ([five in Chromium](mac-pass-2026-11-11.md#3-this-stages-browser-validators), worker and inline, drawing on Metal); the ten-minute session passed every step on 2026-11-10 (57f28f9f). 2026-11-10 (57f28f9f): 48 of 49. On Linux the suite passes in Chromium (2026-11-10, 2ee6821c: 53 of 53) | FAIL |
| 7.1.2 | Chrome, Linux, worker mode | H | the same, `--project chromium` | Linux | weak: one renderer crash stays open and unexplained, accepted as documented by the user on 2026-11-11: on 2026-11-10 the page crashed at the Save Game screen, 37 s into a ten-minute session (1.9 GB at its peak, no kernel or core-dump record), once in twenty ten-minute sessions and in none of eight one-minute ones, and not since (eight of those twenty on 2026-11-10/11). session-ten.mjs now keeps the browser's own log (`<out>.browser.log`, Playwright's DEBUG=pw:browser), whose stderr carries a crashed process's signal, reason and stack (Playwright's headless Chromium writes no minidump), so a recurrence leaves evidence. the suite on 2026-11-10 (2ee6821c with the spec changes in SUITE_RUN): 53 of 53; the same day the browser validators pass: validate-context-loss-play (one run of three found the frame in flight's snapshot already in before the loss, its path unexercised: the validator now runs that case again, up to three times), validate-inline-restore-play and validate-resize-play; and the ten-minute session from the original start ([session-ten.mjs](long-session.md#the-ten-minute-session-row-71-a-browser-passes-with-it): Training through MenuMain, walk, look and footsteps, Save Game and Load Game, a travel, Quick Save and Quick Load, the music to the end) passes all 16 steps in three of four ten-minute runs and eight one-minute runs. 2026-10-28: 41 of 41 (one unexplained instructor-conversation failure that passed three reruns; on the Mac it failed twice, 2026-11-09) | PASS |
| 7.1.3 | Firefox, macOS and Linux, inline mode | H | the suite, `--project firefox`, validate-inline-restore-play, validate-context-loss-play --browser firefox, validate-resize-play --browser firefox | Mac, Linux | weak: passes on the Mac, 2026-11-11 (881d4cbc, [Mac pass](mac-pass-2026-11-11.md#1-the-suite-711-713-7102)): the suite 48 of 48 run, 5 skipped (the four desktop-slot specs, and software-renderer.spec, which skips Firefox off Linux), and the three browser validators pass in Firefox ([validators](mac-pass-2026-11-11.md#3-this-stages-browser-validators)); the ten-minute session passed every step on 2026-11-10 (57f28f9f). 2026-11-10/11: 48 of 48 on a clean rerun. Linux, 2026-10-28: 41 of 41, after four Firefox Play bugs it found were fixed (the wheel; the inline Saves and CRT buttons; the pointer after Alt+Enter; later saves held by the persist() prompt) and its menu specs got a portable cursor driver; 2026-10-31: 49 of 50 (row 7.10.2); 2026-11-10 (2ee6821c with those spec changes): 53 of 53, the three browser validators pass in Firefox, and so does the ten-minute session from the original start (session-ten.mjs, all 16 steps in each of two runs) | PASS |
| 7.1.4 | Safari, macOS | H | the suite under Playwright's WebKit as a stand-in (`--project webkit`, on the Mac), the session in real Safari (by hand or safaridriver) | Mac | weak: Playwright's WebKit 26.6 on the Mac, 2026-11-09 (177e242a, [Mac pass](mac-pass-2026-11-09.md#webkit-714)): 35 of 49 pass, 4 skipped, 14 fail, none of them found to be Play. Eleven are Playwright's WebKit rather than a browser a player has: headless WebKit refuses the pointer lock without window focus (five tests, and most likely the two original-start menu specs), a synthetic drag carries no `movementX` (two), the same folder given three times keeps the first (viewer.spec:54), and a synthetic wheel of 100 pixels is 2.5 notches, as Playwright's WebKit makes ticks from WebKit's 40-pixel line (input-bindings.spec:17, found from the sources on 2026-11-10; the spec now gives WebKit 40). Three are the specs' assumptions: no-webgl.spec turned WebGL off with a Chromium switch (it now models a WebKit without WebGL), software-renderer.spec has no WebKit case (now skipped), and lighting.spec reads the canvas where WebKit appears to give a cleared buffer (unconfirmed). The saves, settings, hidden page, worker failure, graphics fallback and the sound's start pass. Real Safari not run (the user skipped the by-hand check, 2026-11-10); Safari's storage eviction, no Keyboard Lock, no `showDirectoryPicker`; the user dropped Safari on 2026-11-10 ("let's skip safari completely"); what was measured before is kept with it | EXCLUDED |

### 7.2 Frame time (D2, D3)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.2.1 | Chrome, worker: on each map of the frame-time set, the larger of the page's and the worker's median frame work ≤ 16.7 ms (AGENTS.md: 60 fps since 2026-11-05, 8.3 ms before) | H | frame-time-set.mjs (hitch-run.mjs --mode scan, hitch-summary.mjs) | Mac | weak: passes on the Mac, 2026-11-08 (dab89bcb, headed, a 120 Hz display, [Mac pass](mac-pass-2026-11-08.md#1-chrome-headed-the-frame-time-set-721-722-725)): every map worker-bound, the worker's median 2.1 to 4.0 ms (the Island 4.0, the Airfield 3.4, Battery Park 3.2, Wan Chai's market 3.1, the bunker 3.1, the Chateau 2.5, the Ship 2.3, Training, the Bar and Everett 2.1), the page's 0.9 to 2.2 ms: at most a quarter of the bound. Linux, 2026-11-08 (headless, the same route): the worker's median 3.6 to 6.3 ms, the page's 1.3 to 3.3 ms | PASS |
| 7.2.2 | every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps' jitter) | H | frame-time-set.mjs --browser B --headed (a visible window: headless Chromium draws on a synthetic 60 Hz clock) | Mac | weak: Chrome (worker) and Firefox (inline, a 20 µs page clock) pass on the Mac, 2026-11-08 (dab89bcb, a 120 Hz display, [Mac pass](mac-pass-2026-11-08.md#2-firefox-headed-the-frame-time-set-722-725)), all ten maps each: Chrome p95 9.2 to 10.1 ms (118.9 to 120.0 fps), Firefox 9.3 to 10.3 ms (115.8 to 119.8 fps), the first headed Firefox pass (Safari dropped, 2026-11-10). Linux, 2026-11-05 (f2f1cb6f, 240 Hz, before the Firefox bundles, [frame cost](play-frame-cost.md#row-722-headed-2026-11-05-linux)): Chrome passed on all ten, Firefox missed six (21 to 31 ms) | PASS |
| 7.2.3 | Chrome: from a map's first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam | H | hitch-run.mjs --mode roam --seconds 120, hitch-summary.mjs | Mac | weak: passes on the Mac, 2026-11-08 (dab89bcb, headless, [Mac pass](mac-pass-2026-11-08.md#3-roams-723-724)): the Island and WanChai Underworld, no gap over 50 ms (the longest 49.9 and 50.0 ms), and on Linux with all cores. Outside the row: on Linux pinned to two cores (a loaded machine) 2 to 4 gaps over 100 ms a run, up to 350 ms, each the worker's major GC (2026-10-28, docs/live-heap.md) | PASS |
| 7.2.4 | Firefox inline: from a map's first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3) | H | hitch-ab.mjs or hitch-run.mjs --browser firefox, hitch-summary.mjs, gecko-gc-windows.mjs and gecko-gaps.mjs (with --profile) | Mac, Linux | weak: passes on the Mac on the four heap cuts too, 2026-11-11 (881d4cbc, [Mac pass](mac-pass-2026-11-11.md#5-firefox-inline-on-the-island-724)): three headless roams 1.8, 0.6 and 1.2 over 50 ms a minute, none over 100 ms, the longest 59.4 ms, every gap after a slice that discarded JIT code. One stack-sampled roam (not counted) shows the slow task after the discard in the Baseline tiers (39 % Baseline, 38 % Baseline interpreter, 1.3 % Ion, against about 65 % Ion in ordinary frames), 40 % of it in Baseline compilation: the discarded code compiled again. passes on the Mac, 2026-11-10/11 (57f28f9f, the first of the four heap cuts, a quiet host, [Mac pass](mac-pass-2026-11-10.md#4-firefox-inline-on-the-island-724)): five 100 s Island roams, four headless and one headed at 120 Hz, 1.2, 1.2, 0.6, 0.6 and 0.6 over 50 ms a minute, none over 100 ms, the longest 83 ms: a margin of one or two gaps a roam. Every gap is the first frame after a major collection's `prepare.mark_discard_code` slice (1.8 to 3.0 ms; `FULL_GC_TIMER` and `ALLOC_TRIGGER`, not `CC_FINISHED`), whose frames then run 3 to 10 times slower for 100 to 250 ms (the page's JIT code discarded and compiled again, shown by the 2026-11-11 sampled roam); the collections past 1.5 s (3 to 6 extended slices, 13 to 31 ms in all) and MeetPaul's tick (27 to 30 ms) make none. The other three cuts (0da32296) only take work out of the collections and are not yet measured there. Linux, indicative (2026-11-11, 0da32296, [all four cuts](firefox-60fps-plan.md#all-four-cuts-against-the-base-interleaved-2026-11-11)): three clean roams 1.8, 1.8 and 0 a minute, none over 100 ms, within the bound with no margin; its gaps follow the collections that run past 1.5 s, where SpiderMonkey makes every slice uninterruptible and Gecko gives idle slices only to a frame that ends 5 ms before the vsync ([the collector's window](firefox-60fps-plan.md#the-collectors-window-2026-11-10)); whether they also open at the code discard is not checked. Before: the Mac under swap, 2026-11-09 (177e242a), 4.1 to 33.6 a minute and up to 6 over 150 ms; 2026-11-08 (dab89bcb) 1.2 to 3.5 a minute; Linux 2026-11-10 (BindEvents' change, MeetPaul's tick 58.5 to 40.5 ms) 2.0 to 3.2 | PASS |
| 7.2.5 | no shader program is compiled during play after a load | P | hitch-summary.mjs (programs created from 5 s on) over the frame-time set | Mac, Linux | weak: 0 programs from 5 s on, on all ten maps of the frame-time set: Chrome and Firefox on the Mac (2026-11-08, dab89bcb, headed, [Mac pass](mac-pass-2026-11-08.md#1-chrome-headed-the-frame-time-set-721-722-725)), Chrome (2026-11-04) and Firefox (2026-11-07, e9ea7a5e, inline) on Linux | PASS |

### 7.3 Loading time (D4)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.3.1 | navigation to the logo map's first frame ≤ 10 s (Chrome and Firefox) | H | profile-map-load.mjs --start original --folder ([load time](load-time.md#the-stage-7-rows-2026-11-04-linux)) | Mac | weak: passes on the Mac, 2026-11-09 (177e242a, the production build with Play running, three fresh browsers each, [Mac pass](mac-pass-2026-11-09.md#1-the-original-start-on-the-production-build-731)): Chromium 3.53 to 3.88 s, Firefox 5.67 to 7.22 s, most of it the first `game` step loading the script process (2.8 to 3.1 s and 4.6 to 6.1 s). Linux, 2026-11-09 (81f57d5f): Chromium 3.53 and 3.61 s, Firefox 6.08 and 6.12 s. The Mac's run of 2026-11-08 (0.60 to 1.12 s) loaded no Play: the production build had no script-vm.wasm from ce3a87eb (2026-11-07) to 81f57d5f, and profile-map-load.mjs now counts such a load as not drawn | PASS |
| 7.3.2 | a travel arrival's first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map | H | profile-map-load.mjs --travel --maps all (the 83 maps) | Mac | weak: passes on the Mac, 2026-11-10 (57f28f9f, the production build, a quiet host, [Mac pass](mac-pass-2026-11-10.md#3-travel-and-load-game-on-the-production-build-732-733)): 83 of 83 in each, Chromium median 1.15 s, max 2.30 s, Firefox median 3.03 s, max 6.38 s (10_Paris_Metro in both); map by map 0.73 (Chromium) and 0.57 (Firefox) times 2026-11-09's, whose seven Firefox travels over 10 s (up to 18.23 s, 09_NYC_Dockyard) ran under swap; part of the gain may be the tree (the light-map compaction cuts allocation at load), not separated. Linux, 2026-11-10 (528ac7f0, Firefox, the production build then the dev server, back to back on a quiet host): median 3.79 and 3.77 s, max 6.96 and 7.08 s (the Island), 83 of 83 within 10 s in both, so the build loads as fast as the dev server; 2026-11-04 (the dev server): Chromium median 2.23 s, max 4.30 s; Firefox median 4.17 s, max 8.73 s | PASS |
| 7.3.3 | Load Game to the first frame ≤ 8 s | H | profile-map-load.mjs --saves (the internet corpus's 39 slots of one playthrough, each by `loadgame N`) | Mac | weak: passes on the Mac, 2026-11-10 (57f28f9f, the production build, a quiet host, [Mac pass](mac-pass-2026-11-10.md#3-travel-and-load-game-on-the-production-build-732-733)): 39 of 39 in each, Chromium median 1.31 s, max 2.51 s, Firefox median 3.94 s, max 5.62 s (Save0001, the Island, in both); the three Firefox slots over 8 s on 2026-11-09 (Save0026 to Save0028, up to 13.10 s, the host under swap) well inside it. Linux, 2026-11-10 (528ac7f0, Firefox, the production build): 39 of 39 within 8 s, median 4.59 s, max 6.80 s (Save0001), Save0026 to Save0028 4.77, 6.34 and 5.67 s; 2026-11-05 (the production build, [load time](load-time.md#row-733-each-classs-fields-linked-once-2026-11-05)): median 4.74 s, max 6.87 s | PASS |

### 7.4 Memory and long sessions (D5)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.4.1 | ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope | P | validate-process-memory.mjs (by hand), map-memory-census.mjs --maps (the same sequence in the page; [memory across many maps](map-memory.md)) | Linux, Mac | weak: the Mac, 2026-11-11 (57f28f9f, in the page, [Mac pass](mac-pass-2026-11-10.md#6-ten-island-and-training-round-trips-741)): Chromium (worker) and Firefox (inline) hold the same process state at every Training arrival (990 classes, 46 packages of 170.9 MB, the same page store, one interpreter and one event host reachable, 8,067 live handles), and after forced collections the total at Training rises 1.03 and 1.58 MB a round trip over all ten, 0.51 and 0.41 once the script-VM kernel's Wasm memory has reached its high-water mark (a memory never shrinks); validate-process-memory.mjs (Node) run on Linux only. The criteria set no number for "bounded": these slopes, with the flat hour of 7.4.3, are what is read as bounded. Linux, 2026-11-05: passes in Node (the heap 0.65 MB a round trip, ArrayBuffers flat); in the page, Chromium (worker) and Firefox (inline) hold the same process state at every Training arrival (990 classes, the same packages, the same page store), the same level arena (31 MB in Chromium, 35 in Firefox) and the page flat, and after forced collections the total at Training rises 0.4 MB a round trip in both once the script-VM kernel has reached its high-water mark (9.6 and 8.1 MB before): the level interpreter's handle tables, which covered every handle the process had allocated, now cover the level's own handles and those live when it starts ([the handle tables](map-memory.md#the-handle-tables-2026-11-05-linux)), and the purged meshes' lazy arrays are destroyed as the original destroys them ([mesh destruction](mesh-destruction.md): ~ULodMesh/~UMesh compared call by call with the original in Unicorn). Over the 83 distinct maps six faults were found and fixed (Firefox kept every left level alive through the interpreter's WeakRef walks, the 16 GB OOM; a left arena waited for its objects' finalizers; speech packages never released; the trace kernel's arena grew with each map; the handle tables; the lazy arrays): with the handle tables bounded (before the meshes' destruction landed) every level arena stays at 29 to 36 MB (Chromium) and 29 to 41 MB (Firefox), 221 MB at the end before, and after forced collections the total is 0.80 to 1.16 GB (Chromium) and 0.58 to 1.00 GB (Firefox), its slope over the last 42 maps 0.4 and 0.8 MB a map; without forced collections both reach the 83rd map (the tree at most 6.2 GB in Chromium, 6.1 GB in Firefox; 7.4 and 9.4 before) | PASS |
| 7.4.2 | each map of the frame-time set stays within the declared memory budget, 1.25 GB for the page plus the worker after forced collections in every browser (the user's, 2026-11-08) | H | map-memory-census.mjs --maps (the set twice in one page: [the frame-time set](map-memory.md#row-742-the-frame-time-set-2026-11-08-linux)), profile-live-heap.mjs, profile-firefox-memory.mjs | Mac | weak: Chromium (worker) and Firefox (inline) pass on the Mac. Chromium, 2026-11-08 (dfd61024, [Mac pass](mac-pass-2026-11-08.md#5-memory-742-chromium)): 806 to 1,157 MB (the Island's second visit, 7 % under), the second pass's slope -1.3 MB a map. Firefox, 2026-11-09 (177e242a, the forced collection through Gecko's memory-report FIFO, [Mac pass](mac-pass-2026-11-09.md#742-the-census)): 592.8 to 942.5 MB (the Island's second visit, 24 % under), the second pass's slope -0.6 MB a map, five Wasm memories at every reading. Linux: Chromium 807 to 1,158 MB, Firefox 583 to 936 MB (24ad3e65), its Linux path unchanged by the FIFO change (2026-11-10: 583.3 MB at Training's start); before two faults that held left levels were fixed, 1,368 and 1,149 MB. While playing, nothing forced, the Linux process tree at most 2.8 GB (Chromium) and 3.1 GB (Firefox) | PASS |
| 7.4.3 | the one-hour session (D5) in Chrome and Firefox | H | session-hour.mjs ([long session](long-session.md)) | Mac | weak: Chrome (worker) and Firefox (inline) pass on the Mac. Chrome, 2026-11-09 (0a25b847, [Mac pass](mac-pass-2026-11-08.md#after-the-fix-the-hour-again)): no runtime error, ten map changes, 5 of 5 saves, the last Island visit +1.2 % from the warm plateau, the median frame work 0.0 % (page) and +1.8 % (worker), no left level held at any of its 33 readings; on dfd61024 it failed (+13.0 %, worker +9.3 %): three holders each kept a left level now and then (the trace kernel's last model, and accessors made per call in setSpawnActorZone and the physics adapters, kept by V8's allocation sites), fixed in 0a25b847 ([map memory](map-memory.md#the-one-hour-sessions-held-levels-2026-11-09-mac)). Firefox, 2026-11-09 (177e242a, the forced collection through Gecko's memory-report FIFO, the host under swap, [Mac pass](mac-pass-2026-11-09.md#743-the-hour)): no runtime error, ten map changes, 5 of 5 saves, the last Island visit +0.5 % from the 973.0 MB plateau, the median page frame work 8.0 then 7.0 ms, five Wasm memories at all 43 readings. The holds were intermittent, so one clean hour in each is evidence, not proof. Linux, 2026-11-04 (8f82b56b, before those fixes), with the first plateau after a warm-up pass (the user's reading of D5): Chrome -2.4 %, Firefox +6.2 %, the frame work within bounds | PASS |

### 7.5 Audio (D6)

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.5.1 | sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser | H | browser-tests/audio-resume.spec.mjs, validate-galaxy-music-play.mjs | Mac, Linux | weak: passes in Chromium and Firefox on Linux, 2026-11-04: the first click starts the logo map's song; a hidden page (modelled, as headless browsers keep a background tab visible) keeps the mix playing, as the original's DSBCAPS_GLOBALFOCUS buffer does, and the game's sound comes back with its ticks; a suspended context resumes by itself (before, only a key or a click resumed it, and a key after Exit brought the sound back); on the Mac (2026-11-09) the spec passes in Firefox and Playwright's WebKit, and in Chromium when run again (in the whole run no music came in the second after the click, on a loaded host); a real hidden tab and a system interruption not run | PARTIAL |
| 7.5.2 | a sound's latency from PlaySound to output ≤ the original's plus one render quantum (D6) | O | galaxy-output-capture.sh latency and audio-latency-original.mjs (the original under Wine or CrossOver), audio-latency.mjs (Play; [sound start latency](audio-latency.md)) | Mac, Linux | weak: passes on the Mac, 2026-11-11 (881d4cbc, [Mac pass](mac-pass-2026-11-11.md#4-sound-start-latency-752)): the original under CrossOver 26.3 over 20 minutes, take median 44.39 ms and p95 57.11 (the bound 47.29 and 60.01); Play right after, Chromium (worker) 43.06 and 51.66, Firefox (inline) 43.46 and 51.93. Two caveats: the reader's cursor check had to accept 89 % of the first 200 callbacks there (CrossOver's cursor moves in 2,048-byte steps out of step with Galaxy's callbacks, and no other dword matches at all), which the user accepted on 2026-11-11 (the check is now 85 %; Linux's 200 of 200 and its figures unchanged); and the start placement the uniform take assumes is confirmed for 109 of 250 real starts there (100 of 109 on Linux), the rest not examined. passes on Linux, 2026-11-04: from a start to the host taking its first frame out of Galaxy's buffer (D6's "output" as the user chose to read it, 2026-11-04; each host's own buffering to the device after it is reported, not bounded), the original under Wine 11.20 over 20 minutes (the phase of Galaxy's 20 ms timer against Wine's 10 ms mixer moves its figure by several ms, so a minute is not enough) median 45.6 ms and p95 56.1; Play in Chromium (worker) 46.0 and 55.4, in Firefox (inline) 45.0 and 55.7 | PASS |

### 7.6 Window and input

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.6.1 | the pointer lock is taken on the first click; one Escape releases it and reaches the game (MenuMain); a lost lock or a blur lets go of the held input and Play goes on (no pause, the user's choice 2026-10-30); a hidden page resumes without catch-up | H | browser-tests/pointer-lock.spec.mjs, browser-tests/original-start-input.spec.mjs | all browsers | weak: Chrome's worker mode, headless, Linux (2026-10-30): the browser's Escape rule played as its call (exitPointerLock, no key) opens MenuMain once, a delivered key as well counts once, the free mouse drives the menu; a blur lets go of the held movement and the level's clock goes on; a real Escape is not exercised under Playwright (the user saw two presses needed on Chrome Linux and macOS before the change); the hidden-page resume is not tested; on the Mac (2026-11-09) both specs pass in Chromium and Firefox, and Playwright's WebKit refuses the pointer lock without window focus, so they cannot pass there | PARTIAL |
| 7.6.2 | Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox) | O, H | browser-tests/original-start-input.spec.mjs, input-bindings.spec.mjs | all browsers | weak: passes in Chromium and Firefox on Linux (2026-10-28): Keyboard Lock where the browser has it, and in Firefox Alt+Enter takes the fullscreen and the pointer without it (the pointer asked again at fullscreenchange, which Firefox needs); a held Escape and F11 in a real browser are not exercised; on the Mac (2026-11-09) both specs pass in Chromium and Firefox; in Playwright's WebKit the refused pointer lock fails them, and input-bindings.spec's wheel case read Playwright's synthetic 100 pixels as 2.5 notches (WebKit's 40-pixel line; the spec now gives it 40, 2026-11-10) | PARTIAL |
| 7.6.3 | resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error | H | validate-resize-play.mjs, [a resize](boot.md#a-resize) | Linux, Mac | weak: resizes during Play equal a fresh load at the final size byte for byte, the frame and MenuMain over the kept frame, in Chromium and Firefox on Linux (2026-10-31, again 2026-11-10), and the page at a new pixel ratio does in Chromium; a real ratio change (a zoom, another screen) is not produced headless, so `watchPixelRatio` is unmeasured; on the Mac (2026-11-11, 881d4cbc) validate-resize-play passes in Chromium (resize and ratio) and Firefox (resize) | PARTIAL |
| 7.6.4 | a hidden tab or system sleep stops Play (no frame, no tick); it comes back by itself with no catch-up (no click: the user's choice, 2026-10-30) and the audio follows | H | pointer-lock.spec.mjs (blur), browser-tests/hidden-tab.spec.mjs | all browsers | weak: blur is tested (the game goes on, held input let go); the hidden page passes in Chromium and Firefox on Linux (2026-10-31: no frame and no tick while hidden, back with no click, no catch-up, the held input let go) with the hide modelled (`document.hidden`, `visibilitychange`, no animation frame), as headless browsers keep a background tab visible; hidden-tab.spec and the blur pass in Chromium, Firefox and Playwright's WebKit on the Mac (2026-11-09); a real hidden tab, system sleep and the audio not measured | PARTIAL |

### 7.7 Graphics capability and failures

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.7.1 | a lost WebGL context freezes Play and restores it as D3DDrv's `Lock` does; the frames after equal a run with no loss | O | validate-context-loss-play.mjs (Chromium worker and inline, Firefox) | Linux, Mac | weak: passes on Linux, Chromium (worker) and Firefox, 2026-11-10 (in worker mode one run of three found the frame in flight's snapshot in before the loss, which left the loss case's path unexercised: the validator now runs that case again, up to three times); on the Mac (2026-11-11, 881d4cbc, [validators](mac-pass-2026-11-11.md#3-this-stages-browser-validators)) it passes in Chromium (worker and inline, drawing on Metal) and Firefox | PASS |
| 7.7.2 | no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back | H | browser-tests/no-webgl.spec.mjs, browser-tests/graphics-fallback.spec.mjs, browser-tests/lodmesh-wasm.spec.mjs, [no WebGL 2](boot.md#no-webgl-2) | Linux | weak: the three specs pass in Chromium and Firefox on Linux (2026-10-31) and on the Mac (2026-11-09); in Playwright's WebKit there all but no-webgl.spec pass, which turned WebGL off with a Chromium switch WebKit ignores (since 2026-11-10 it models a WebKit without WebGL there, not rerun) | PASS |
| 7.7.3 | a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable | H | browser-tests/software-renderer.spec.mjs (Chromium on SwiftShader, Firefox on llvmpipe) | Linux | weak: passes on Linux, 2026-11-04: the renderer is named (Firefox masks it as "llvmpipe, or similar", still recognised), the mesh path is the CPU one, Training keeps real time (game 10.02 and 10.07 s in 10.04 s) and draws 133 fps (SwiftShader) and 195 fps (llvmpipe) at 960×640; "playable" is read as keeping real time, the frame rate reported, not bounded; on the Mac (2026-11-09) Chromium passes, and the spec has no case for macOS Firefox (llvmpipe is Linux only) or WebKit, which it now skips (2026-11-10); Linux, 2026-11-10: SwiftShader 134.5 fps, llvmpipe 235.5 fps, real time kept | PASS |

### 7.8 Files and storage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.8.1 | the game folder opens through the gate's picker in every supported browser | H | browser-tests/viewer.spec.mjs | all browsers | weak: the picker opens the folder in Chromium and Firefox headless (`setInputFiles`; viewer.spec passes in both on Linux, 2026-10-28, and on the Mac, 2026-11-09); in Playwright's WebKit the same folder given three times keeps the first (viewer.spec:54; a player picks once); a real picker is not run | PARTIAL |
| 7.8.2 | saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running | H | browser-tests/save-game.spec.mjs, save-folder.spec.mjs, test/save-store.test.mjs, test/save-persistence.test.mjs | all browsers | weak: the save, load and Saves window specs pass in Chromium and Firefox on Linux (2026-10-28; Firefox's persist() prompt no longer holds the later saves); on the Mac (2026-11-09) save-game.spec passes in Chromium, Firefox and Playwright's WebKit, and save-folder.spec skips (it needs the desktop slots of `.work/real-saves`); a real persistence prompt's answer is not observed; the unit tests use a fake store | PARTIAL |
| 7.8.3 | in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads | H, O | save-folder.spec.mjs headed with a real folder, validate-save-game.mjs | Mac, Linux | needed: [save storage](save-storage.md) says a headed Chromium with a real folder was not run | MISSING |
| 7.8.4 | settings persist across reloads in every supported browser (row 6.1.5's proof) | O | browser-tests/config-persistence.spec.mjs, validate-config-persistence.mjs | all browsers | weak: the spec passes in Chromium and Firefox on Linux (2026-10-28), and in Chromium, Firefox and Playwright's WebKit on the Mac (2026-11-09) | PASS |

### 7.9 Failure recovery

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.9.1 | a runtime error pauses Play with its message, and Player start or a reload recovers | H | browser-tests/runtime-error.spec.mjs | all browsers | weak: both cases pass in Chromium and Firefox in the whole runs on the Mac (2026-11-10/11, 57f28f9f, a quiet host, [Mac pass](mac-pass-2026-11-10.md#1-the-suite-711-713-791-7102)) and on Linux (2026-11-10, 2ee6821c; brought up to date on 2026-10-28: the push read from Plant7's Location, the right mouse button to use); on the Mac on 2026-11-09, under swap, Chromium's door case passed only when run again (the door still opening when its 5 s poll ended) | PASS |
| 7.9.2 | the simulation worker fails (an exception, an out-of-memory error a page can catch, a closed, looping or terminated worker): the page says so and offers a reload or the last save, with nothing written half; a heap exhausted past what a page can catch ends in the browser's own crash page (the user's decision, 2026-11-11) | H | browser-tests/worker-failure.spec.mjs, [a failed worker](sim-worker.md#a-failed-worker) | Linux | weak: the spec passes in Chromium and Firefox on Linux (2026-10-31), and in Chromium, Firefox and Playwright's WebKit on the Mac (2026-11-09): a closed and a looping worker (the page tells them by its posts' silence), a failed call and an uncaught exception, a termination at a save's picture request (the kept slot unchanged); out of memory measured in a bare worker (a RangeError takes the exception path, as in Play; Chromium's heap exhaustion crashes the tab into the browser's own page and Firefox's grows the process, which no page can answer: a browser limit the user accepted on 2026-11-11), not induced in Play | PASS |
| 7.9.3 | a graphics device that never comes back: the page says so, and a reload recovers | H | validate-context-loss-play.mjs --case never, [context loss](context-loss.md) | Linux, Mac | weak: Chromium (worker and inline) and Firefox on Linux (2026-10-31) and on the Mac (2026-11-11, 881d4cbc) | PASS |

### 7.10 Regression coverage

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.10.1 | the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`) | P | run-validators.mjs | Linux, with the Mac's stores | weak: a dry run on 2026-11-11 (Linux, master b2b9ddb4, 699 validators in 78 minutes at 4 jobs): 689 passed, 8 skipped, 2 failed, both stale harnesses fixed the same day: validate-native-make-noise and validate-native-move build their runtime by hand, and since the bunker bundle (4ed50f0a, 2026-11-06) soundField reads only attached instances, which their stand-in GameInfo, PRIs and receiver were not; both match the original's oracle data again (29 and 4 cases). The closing run waits for the object-model migration's third round (the user, 2026-11-11). Before: on 2026-11-06 (Linux, master e2c96f5c, after the night's Firefox ports): 680 passed, 8 skipped (Wine and hardware probes), 0 failed in 91 minutes, validate-full-run (New Game to an ending, the original's travel text at every mission change) included and validate-gpu-mesh in 136 s; not yet the closing commit. Before: on 2026-10-30, after the 6 reds of 2026-10-27 and 25 newer ones were fixed (ac8e211b, 65ab361c, the reds-2026-10-30 branch on 82482dcb): 677 passed, 8 skipped, 1 failed; validate-gpu-mesh stalled idle to the 600 s limit and passes alone (104 s) and on 1.5 cores (116 s), its stall not explained (the runner now prints a killed check's last stdout); not run on the closing commit | PARTIAL |
| 7.10.2 | the browser suite passes in every supported browser | P | `npx playwright test` (projects chromium and firefox; webkit too, recorded but not counted since Safari was dropped), SUITE_RUN, `--suite` | Mac, Linux | needed: the suite again on the Mac with the spec changes of 2026-11-11 ([the suite by browser](#the-browser-suite-by-browser), "changed since"); fails on the Mac, 2026-11-11 (881d4cbc, a quiet host, [the suite by browser](#the-browser-suite-by-browser)): Chromium 47 of 49 run (instructor-conversation.spec and lighting.spec, both with the suite's SwiftShader Chromium and both passing on Metal), Firefox 48 of 48 run, 4 and 5 skipped; 2026-11-10/11 (57f28f9f): Chromium 48 of 49, Firefox 48 of 48. Linux, 2026-11-10 (2ee6821c with the spec changes recorded then): Chromium 53 of 53 and Firefox 53 of 53; 2026-10-31: Chromium 50 of 50, Firefox 49 of 50 (the Firefox red, the first save reopening MenuMain, fixed in 30190c15) | FAIL |
| 7.10.3 | the Stage 4, 5 and 6 gates pass on the closing commit | P, O | validate-stage4-acceptance.mjs, validate-stage5-acceptance.mjs, stage6-criteria.mjs | Linux, Mac | needed: a run on one commit, the closing one, after the object-model migration's third round (the user, 2026-11-11). The dry run of 2026-11-11 (master 2181f406 to 8b57af52): the Stage 5 gate passes 50 of 50 (46 min at 3 jobs); the Stage 4 gate 69 of 70 at 2 jobs, the 70th (4.2.2, Street y3: 6 outlier blocks of the panning sky, which follows the level's clock, beyond its allowance of two) passing alone twice at --jobs 1, the adopted official mode, once three harness faults were fixed: its frame harnesses patched main.mjs lines that changed on 2026-10-30, it ran without the store path its doc names (DX_ORIGINALS, the Mac's copies in .work/mac-stores), and its tagged live and conversation checks read a stale report.json (since 4928697b a tagged replay writes report-<tag>.json only); Stage 6's rows rest on 19 tools, 16 of which pass in the sweep: validate-menu-main skips (its original capture of 2026-10-23 is lost, and a retake on 2026-11-11 diverged in the 15_Area51_Final half: the original's Save Game click did nothing, cause not found), and census-transitions.mjs and validate-load-saves.mjs run by hand, not yet | MISSING |

### 7.11 Excluded

| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.11.1 | multiplayer | - | - | - | the last priority (AGENTS.md) | EXCLUDED |
| 7.11.2 | mobile and touch browsers | - | - | - | the game takes a keyboard and a mouse | EXCLUDED |
| 7.11.3 | Windows | - | - | - | no Windows machine (D1); Chrome's engine rows stand in for Chrome and Edge there, unmeasured | EXCLUDED |

## The browser suite by browser

Last run 2026-11-11 on the Mac (Apple M2 Pro, macOS on Darwin 25.6, a quiet host: [Mac pass](mac-pass-2026-11-11.md#1-the-suite-711-713-7102)), headless, on 881d4cbc's code, 53 tests a browser, one worker. One project at a time, one worker, Firefox muted through a wrapper of the repository's config. Both Chromium failures ran again alone and in probes, failing each time with the suite's default headless Chromium, which draws with SwiftShader on the Mac (15 to 18 fps), and each passed once with the same spec on Metal. The four skips in each (load-game.spec:61 and save-folder.spec's three) need `.work/real-saves`, the Linux host's Wine desktop slots; Firefox's fifth is software-renderer.spec, which skips Firefox off Linux. Before it, the Mac on 2026-11-10/11 (57f28f9f): Chromium 48 and Firefox 48 of 48 or 49 run; on 2026-11-09 (177e242a, under swap) Chromium 44, Firefox 46 and Playwright's WebKit 35 of 49 (Git history of this file). Linux on 2026-11-10 (2ee6821c, headless): Chromium 53 of 53 and Firefox 53 of 53, the desktop slots there.

- chromium 153.0.8010.12 (worker mode): 47 pass, 2 fail (1 spec, 1 race), 4 skipped, 19 min.
- firefox 155.0 (inline mode): 48 pass, 0 fail, 5 skipped, 19 min.
- webkit: not run. Safari and WebKit left Stage 7 on 2026-11-10 (the user's decision); Playwright's WebKit ran 35 of 49 on the Mac on 2026-11-09.

Causes: **stale**, the spec predates a change in Play and fails in every browser; **race**, the spec reads a state before worker mode delivers it, or before a loaded host has drawn it; **harness**, Playwright's synthetic input or headless window is not a real browser's, and the spec cannot pass as written; **spec**, the spec assumes what that browser does not do (a Chromium switch, a whole-pixel layout, a readback outside the frame that drew); **platform**, the spec's case has no path in that browser on that system; **api**, the spec needs a Chromium-only API; **play**, a Play bug in that browser or simulation mode; **unexplained**, it fails and its cause is not found. A test not listed passed in every browser that ran, but for the skipped ones.

| Test | chromium | firefox | Why |
| --- | --- | --- | --- |
| instructor-conversation.spec.mjs:12 | spec | pass | spec (Chromium on SwiftShader, 9 of 9 runs; passes on Metal): the spec's placement 80 units from the instructor, inside MunitionsTrooperFrob's radius of 160, starts the greeting by radius before its use (the original's ScriptedPawn.Tick, IM_Radius); the page stalls about 1.1 s as it starts and the right click takes about 1 s to return, so the 1.8 s greeting is over before the reads. On a fast page the step passed without its use playing anything. **Changed since, not rerun there:** rewritten: a reader samples the conversations from each step on; step 1 reads the radius greeting, then a use past the 1 s repeat gate and inside the 5 s radius hold-out plays it again |
| lighting.spec.mjs:10 | race | pass | race (Chromium on SwiftShader; passes on Metal): after the switch to Inspect and the resize the page answered the first read 5.9 s later, past the 5 s poll. **Changed since, not rerun there:** the poll waits 20 s |

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
   `persist()` prompt). On the Mac (2026-11-09, [Mac pass](mac-pass-2026-11-09.md#5-supported-browsers-711-713-714)) the suite ran
   in the three engines: Chromium 44 of 49 (three failures that came back, two of them not explained), Firefox 46 of 49 (two specs'
   sizing, one Linux-only case) and Playwright's WebKit 35 of 49 (eleven its synthetic input or headless window, the wheel's
   among them, and three the specs' assumptions). The specs were brought up to date on 2026-11-10 and pass 53 of 53 in Chromium
   and Firefox on Linux. The Mac's rerun on a quiet host (2026-11-10/11, [Mac pass](mac-pass-2026-11-10.md#1-the-suite-711-713-791-7102))
   passes Firefox 48 of 48 run and Chromium 48 of 49. The one failure is instructor-conversation.spec. On the Mac the suite's
   Chromium draws with SwiftShader at 18 fps, and the spec's backed-off polls straddled a short greeting; the same spec passes 3 of 3
   on Metal. The spec samples every 100 ms since 2026-11-11. The fourth pass (2026-11-11, [Mac pass](mac-pass-2026-11-11.md)) ran the
   browser validators there, all passing, and the suite again: Firefox 48 of 48 run, Chromium 47 of 49. Both Chromium failures come
   from the suite's default headless Chromium drawing with SwiftShader on the Mac, and both pass on Metal:
   * instructor-conversation.spec's own placement starts the greeting by radius before its use, as the original does, so on a slow
     page the greeting was over before the use returned;
   * lighting.spec's 5 s poll ran out before the page applied a resize.
   Both specs are corrected (2026-11-11). Left: the Mac's Chromium suite with them. (Safari was dropped on 2026-11-10.)
3. **The small reliability gaps.** A creation-error message (7.7.2), a resize spec (7.6.3), the hidden tab (7.6.4), a
   worker failure (7.9.2) and a device that never returns (7.9.3). Done 2026-10-31 on Linux: 7.7.2 and 7.9.3 pass; a worker that stops
   answering is now told by its posts' silence (7.9.2), a pixel ratio change now resizes the canvas (7.6.3), and the hidden tab is checked
   with the hide modelled (7.6.4). What headless browsers cannot produce stays open in those rows: a JavaScript heap out of memory in
   Play, a real ratio change, a real hidden tab and sleep.
   The checks a person does in a real browser for those rows and for 7.5.1, 7.6.1, 7.6.2, 7.8.1 to 7.8.3 are listed in
   [Stage 7 checks by hand](stage-7-hand-checks.md) (2026-11-10).
4. **A measurement pass on the Mac.** The frame-time set, the load census and the memory budget in every browser (7.2,
   7.3, 7.4.2) give each row its first status on the reference machine. Done 2026-11-08/09 ([Mac pass](mac-pass-2026-11-08.md)):
   7.2.1, 7.2.3, 7.2.5, 7.3.2 and 7.3.3 pass; 7.2.2 passes in Chrome and Firefox (Safari, then left, was dropped on 2026-11-10); 7.2.4 fails (Firefox's Island
   roams); 7.4.2 and 7.4.3 pass in Chrome, which Firefox's tools cannot measure off Linux. Its 7.3.1 run does not count: the
   production build had no Play from ce3a87eb (2026-11-07) until 81f57d5f, which the pass's failed console calls led to. The second
   pass ([2026-11-09](mac-pass-2026-11-09.md)) ran on a host under swap (15.8 to 17.7 GB in use): 7.3.1 passes on the fixed build;
   Firefox's 7.4.2 and 7.4.3 pass through Gecko's memory-report FIFO, the memory tools' macOS path; Firefox's travels and Load
   Game on the production build fail (7.3.2, 7.3.3), Chromium's pass. On Linux (2026-11-10) Firefox's travels and Load Game
   pass on the production build, the travels as fast as on the dev server (medians 3.79 and 3.77 s), so the Mac's Firefox
   figures wait for a quiet host. The third pass ([2026-11-10/11](mac-pass-2026-11-10.md)) ran on a quiet host, after the user
   closed the heavy apps. 7.2.4, 7.3.2, 7.3.3, 7.4.1 and 7.9.1 pass there. Firefox's travels have a median of 3.03 s and a maximum
   of 6.38 s, and its Load Game a median of 3.94 s and a maximum of 5.62 s. The ten round trips hold the same state at every arrival.
   Play's sound start is measured there (42.7 and 43.4 ms at the median), but the original is not yet. The fourth pass captured it
   under CrossOver (44.39 ms median, p95 57.11), and 7.5.2 passes there; 7.1.3 passes with Firefox's browser validators, and 7.2.4
   passes again on the four heap cuts.
5. **The performance work against 7.2.1.** Each step goes family by family, as a measurement names it, in the Rust core
   (AGENTS.md), and only for gains over 5%. Since the target became 60 fps (2026-11-05), what is left is Firefox's: the
   [Firefox 60 fps plan](firefox-60fps-plan.md) for rows 7.2.2 and 7.2.4. On 2026-11-07/08 Firefox met both on Linux headless
   (the frame-time set's page p95 under 16.7 ms on all ten maps, 7.2.4's roams). On the Mac (2026-11-08) Firefox passes 7.2.2
   headed on all ten maps but fails 7.2.4: two of its four Island roams draw 2.4 gaps over 50 ms a minute and one draws two over
   150 ms, mostly time between frames that only a profiled Mac roam could attribute. Profiled on 2026-11-09, under swap, every roam
   was worse: most gaps follow slow frames whose thread was runnable and not running, and the rest are the major collection about
   40 s in, whose slices between frames (28 to 101 ms) are the part Play can act on. On a quiet host (2026-11-10/11) 7.2.4 passes
   in five of five roams (above, D3).
6. **The long session** (7.4.3) and the audio latency (7.5.2, which starts with the original's measurement). Both pass on Linux
   (2026-11-04: [long session](long-session.md), [sound start latency](audio-latency.md)). On the Mac the Chrome hour passes once
   three holders of left levels were fixed (0a25b847, 2026-11-09); Firefox's hour passes there too (2026-11-09, +0.5 %,
   through Gecko's memory-report FIFO); Play's audio latency was measured there on 2026-11-11 (below Linux's original), and the
   original's own figure under CrossOver is still to be captured.
7. **The gate.** The sweep, the browser suite and the earlier stages' gates on one commit (7.10). On 2026-11-11 the user accepted 7.1.2's one unexplained
   renderer crash as documented (one in twenty sessions, not reproduced; the ten-minute session now keeps the browser's own log) and
   7.9.2's heap exhaustion as a browser limit (a page can answer an out-of-memory error it can catch, not the browser's crash page), and
   chose to run the gate after the object-model migration's third round has landed.
