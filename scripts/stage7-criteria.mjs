/** The Stage 7 criteria as data (docs/stage-7-exit-criteria.md, adopted by the user on 2026-10-28): one row per criterion of the roadmap's
 * section 7 "Done when". `node scripts/stage7-criteria.mjs` prints the scoreboard, `--list` the rows, `--suite` the browser suite's last
 * run by browser, `--markdown` the tables of the note (which are generated from here).
 *
 * A row is {id, clause, claim, kind, proof, machine, need, weak, status, excluded}:
 *   kind     O (the original defines the behavior: compared with its recovered code or a capture), H (a host target this note declares),
 *            P (Play against itself: no regression, the same state or pixels across modes or builds).
 *   proof    the checks and tools that decide the row, named, not run.
 *   machine  where the row is measured: the Mac (Apple M2 Pro, the reference machine for every number, and the only Safari), the Linux
 *            host, or every supported browser.
 *   status   as last measured (a Stage 7 row is a measurement, not only the existence of a proof): PASS, PARTIAL (a proof exists but not
 *            for every browser or machine the row names, or not since a change that touches it), FAIL (measured, it misses the bound),
 *            MISSING (no proof, or no measurement), EXCLUDED.
 *   decision the user's decision of 2026-10-28 the row rests on (D1 to D6). */

export const CLAUSES = Object.freeze({
  1: 'Supported browsers', 2: 'Frame time', 3: 'Loading time', 4: 'Memory and long sessions', 5: 'Audio', 6: 'Window and input',
  7: 'Graphics capability and failures', 8: 'Files and storage', 9: 'Failure recovery', 10: 'Regression coverage', 11: 'Excluded',
});
export const STATUSES = Object.freeze(['PASS', 'PARTIAL', 'FAIL', 'MISSING', 'EXCLUDED']);

export const CRITERIA = [];
const add = (id, claim, kind, status, extra = {}) =>
  CRITERIA.push({id, clause: Number(id.split('.')[1]), claim, kind, status, proof: [], machine: '-', need: null, weak: null, decision: null, excluded: null, ...extra});
const ALL = 'all browsers', MAC = 'Mac', LINUX = 'Linux';

// 7.1 Supported browsers (D1) -----------------------------------------------------------------------------------------------------------
const SUITE = ['`npx playwright test`', 'the 7.x validators'];
add('7.1.1', 'Chrome, macOS, worker mode', 'H', 'FAIL', {decision: 'D1', proof: SUITE, machine: MAC,
  need: 'the three failures that came back explained or fixed, then the suite again on the Mac',
  weak: 'fails on the Mac, 2026-11-09 (177e242a, [Mac pass](mac-pass-2026-11-09.md#chromium-711), [the suite by browser](#the-browser-suite-by-browser)): 44 of 49 pass, 4 skipped (no `.work/real-saves` there); of the five failures audio-resume.spec and runtime-error.spec pass when run again (races on a loaded host), and three fail again: gameplay.spec:89 (a simulation frame in flight in the worker moves the player after the switch to the inspection camera), instructor-conversation.spec (no conversation within 5 s of the use; not explained) and lighting.spec (the canvas does not reach the capture size within the poll; not explained). On Linux, 2026-11-10 (528ac7f0), the three pass in Chromium, with gameplay.spec\'s other case (4 of 4)'});
add('7.1.2', 'Chrome, Linux, worker mode', 'H', 'PARTIAL', {decision: 'D1', proof: ['the same, `--project chromium`'], machine: LINUX,
  weak: 'the suite on 2026-10-28: 41 of 41 (39 in the whole run, its two failures run again: a fixed race and one unexplained instructor-conversation failure that passed three reruns); the 7.x validators are not run as a set'});
add('7.1.3', 'Firefox, macOS and Linux, inline mode', 'H', 'PARTIAL', {decision: 'D1', machine: `${MAC}, ${LINUX}`,
  proof: ['the suite, `--project firefox`', 'validate-inline-restore-play', 'validate-context-loss-play --browser firefox'],
  need: 'lighting.spec and mirrors.spec sizing the viewport in whole pixels and software-renderer.spec\'s Firefox case kept to Linux, then the suite again on the Mac',
  weak: 'the Mac, 2026-11-09 (177e242a, [Mac pass](mac-pass-2026-11-09.md#firefox-713)): 46 of 49 pass, 4 skipped; lighting.spec and mirrors.spec ask Playwright for a viewport 712.8 px high (Firefox on macOS lays the bars out at fractional heights), which it refuses, and software-renderer.spec\'s Firefox path is Mesa\'s llvmpipe, which macOS does not have; no Play fault. Linux, 2026-10-28: 41 of 41, after four Firefox Play bugs it found were fixed (the wheel; the inline Saves and CRT buttons; the pointer after Alt+Enter; later saves held by the persist() prompt) and its menu specs got a portable cursor driver; 2026-10-31: 49 of 50 (row 7.10.2)'});
add('7.1.4', 'Safari, macOS', 'H', 'FAIL', {decision: 'D1', machine: MAC,
  proof: ['the suite under Playwright\'s WebKit as a stand-in (`--project webkit`, on the Mac)', 'the session in real Safari (by hand or safaridriver)'],
  need: 'the wheel-and-belt failure explained; the session in real Safari ([the checklist](mac-pass-2026-11-09.md#real-safari-714)); Playwright\'s Linux WebKit is an Ubuntu build that this host\'s libraries do not run (ICU 74, libxml2.so.2, flite)',
  weak: 'Playwright\'s WebKit 26.6 on the Mac, 2026-11-09 (177e242a, [Mac pass](mac-pass-2026-11-09.md#webkit-714)): 35 of 49 pass, 4 skipped, 14 fail. Ten are Playwright\'s WebKit rather than a browser a player has: headless WebKit refuses the pointer lock without window focus (five tests, and most likely the two original-start menu specs), a synthetic drag carries no `movementX` (two), and the same folder given three times keeps the first (viewer.spec:54). Three are the specs\' assumptions: no-webgl.spec turns WebGL off with a Chromium switch, software-renderer.spec has no WebKit path, and lighting.spec reads the canvas where WebKit appears to give a cleared buffer (unconfirmed). One is not explained: the first wheel notch put the item after next in hand (input-bindings.spec:17). The saves, settings, hidden page, worker failure, graphics fallback and the sound\'s start pass. Real Safari not run (the user skipped the by-hand check, 2026-11-10); Safari\'s storage eviction, no Keyboard Lock, no `showDirectoryPicker`'});

// 7.2 Frame time (D2, D3) ---------------------------------------------------------------------------------------------------------------
add('7.2.1', 'Chrome, worker: on each map of the frame-time set, the larger of the page\'s and the worker\'s median frame work ≤ 16.7 ms (AGENTS.md: 60 fps since 2026-11-05, 8.3 ms before)', 'H', 'PASS',
  {decision: 'D2', machine: MAC, proof: ['frame-time-set.mjs (hitch-run.mjs --mode scan, hitch-summary.mjs)'],
    weak: 'passes on the Mac, 2026-11-08 (dab89bcb, headed, a 120 Hz display, [Mac pass](mac-pass-2026-11-08.md#1-chrome-headed-the-frame-time-set-721-722-725)): every map worker-bound, the worker\'s median 2.1 to 4.0 ms (the Island 4.0, the Airfield 3.4, Battery Park 3.2, Wan Chai\'s market 3.1, the bunker 3.1, the Chateau 2.5, the Ship 2.3, Training, the Bar and Everett 2.1), the page\'s 0.9 to 2.2 ms: at most a quarter of the bound. Linux, 2026-11-08 (headless, the same route): the worker\'s median 3.6 to 6.3 ms, the page\'s 1.3 to 3.3 ms'});
add('7.2.2', 'every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps\' jitter)', 'H', 'PARTIAL',
  {decision: 'D2', machine: MAC, proof: ['frame-time-set.mjs --browser B --headed (a visible window: headless Chromium draws on a synthetic 60 Hz clock)'],
    weak: 'Chrome (worker) and Firefox (inline, a 20 µs page clock) pass on the Mac, 2026-11-08 (dab89bcb, a 120 Hz display, [Mac pass](mac-pass-2026-11-08.md#2-firefox-headed-the-frame-time-set-722-725)), all ten maps each: Chrome p95 9.2 to 10.1 ms (118.9 to 120.0 fps), Firefox 9.3 to 10.3 ms (115.8 to 119.8 fps), the first headed Firefox pass; Safari not run (7.1.4). Linux, 2026-11-05 (f2f1cb6f, 240 Hz, before the Firefox bundles, [frame cost](play-frame-cost.md#row-722-headed-2026-11-05-linux)): Chrome passed on all ten, Firefox missed six (21 to 31 ms)'});
add('7.2.3', 'Chrome: from a map\'s first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam', 'H', 'PASS',
  {machine: MAC, proof: ['hitch-run.mjs --mode roam --seconds 120', 'hitch-summary.mjs'],
    weak: 'passes on the Mac, 2026-11-08 (dab89bcb, headless, [Mac pass](mac-pass-2026-11-08.md#3-roams-723-724)): the Island and WanChai Underworld, no gap over 50 ms (the longest 49.9 and 50.0 ms), and on Linux with all cores. Outside the row: on Linux pinned to two cores (a loaded machine) 2 to 4 gaps over 100 ms a run, up to 350 ms, each the worker\'s major GC (2026-10-28, docs/live-heap.md)'});
add('7.2.4', 'Firefox inline: from a map\'s first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3)', 'H', 'FAIL',
  {decision: 'D3', machine: `${MAC}, ${LINUX}`, proof: ['hitch-ab.mjs or hitch-run.mjs --browser firefox', 'hitch-summary.mjs', 'gecko-gaps.mjs (with --profile)'],
    need: 'the Mac\'s roams again on a quiet host (2026-11-09\'s ran under swap); the major collection about 40 s into every Island roam, whose slices between frames (28 to 101 ms) alone make two to four gaps over 50 ms, is the part Play can act on; `--gclog` recorded no collector line on the Mac, so an attribution there needs `--profile`',
    weak: 'fails on the Mac, 2026-11-09 (177e242a, the host under swap: 15.8 to 17.7 GB in use, a VM up to 93 % of a core, the user\'s Firefox decoding a video, [Mac pass](mac-pass-2026-11-09.md#3-what-fills-firefoxs-gaps-724)): four 100 s Island roams 8.9, 4.1, 23.0 and 33.6 over 50 ms a minute and 1, 0, 2 and 6 over 150 ms (the longest 317 ms), worse than 2026-11-08\'s and worse along the pass (102 to 83 fps). Two profiled roams attribute them: most gaps follow a slow page frame (ticks of 40 to 330 ms), in the second roam with the main thread on the CPU for under 60 % of the frame in 35 of 46 (runnable in ordinary script and not running: preempted or stalled on page faults, which the profile cannot tell apart); the rest are the incremental collector\'s slices between frames about 40 s in (INTER_SLICE_GC, TOO_MUCH_MALLOC) and script between frames. 2026-11-08\'s 185 ms between two ordinary frames did not recur (the longest such time 112 ms, a collector slice). 2026-11-08 (dab89bcb, [Mac pass](mac-pass-2026-11-08.md#3-roams-723-724)): 2.4, 1.2, 2.4 and 3.5 a minute, roam 4 two gaps over 150 ms. Linux, 2026-11-08 (8e34e66a, [Firefox 60 fps plan](firefox-60fps-plan.md#row-724-on-master-2026-11-08)): four roams 1.2 to 1.8 a minute, none over 100 ms; the recurring gaps are one 51 to 68 ms tick at about 20 s (ConBindEvents from an actor\'s script tick) and the collector\'s slices at about 40 s'});
add('7.2.5', 'no shader program is compiled during play after a load', 'P', 'PASS',
  {machine: `${MAC}, ${LINUX}`, proof: ['hitch-summary.mjs (programs created from 5 s on) over the frame-time set'],
    weak: '0 programs from 5 s on, on all ten maps of the frame-time set: Chrome and Firefox on the Mac (2026-11-08, dab89bcb, headed, [Mac pass](mac-pass-2026-11-08.md#1-chrome-headed-the-frame-time-set-721-722-725)), Chrome (2026-11-04) and Firefox (2026-11-07, e9ea7a5e, inline) on Linux; Safari not run'});

// 7.3 Loading time (D4) -----------------------------------------------------------------------------------------------------------------
add('7.3.1', 'navigation to the logo map\'s first frame ≤ 10 s (Chrome and Firefox)', 'H', 'PASS',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --start original --folder ([load time](load-time.md#the-stage-7-rows-2026-11-04-linux))'],
    weak: 'passes on the Mac, 2026-11-09 (177e242a, the production build with Play running, three fresh browsers each, [Mac pass](mac-pass-2026-11-09.md#1-the-original-start-on-the-production-build-731)): Chromium 3.53 to 3.88 s, Firefox 5.67 to 7.22 s, most of it the first `game` step loading the script process (2.8 to 3.1 s and 4.6 to 6.1 s). Linux, 2026-11-09 (81f57d5f): Chromium 3.53 and 3.61 s, Firefox 6.08 and 6.12 s. The Mac\'s run of 2026-11-08 (0.60 to 1.12 s) loaded no Play: the production build had no script-vm.wasm from ce3a87eb (2026-11-07) to 81f57d5f, and profile-map-load.mjs now counts such a load as not drawn'});
add('7.3.2', 'a travel arrival\'s first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map', 'H', 'FAIL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --travel --maps all (the 83 maps)'],
    need: 'Firefox again on a quiet Mac',
    weak: 'Firefox fails on the Mac, 2026-11-09 (177e242a, the production build, the host under swap, [Mac pass](mac-pass-2026-11-09.md#2-travel-and-load-game-on-the-production-build-732-733)): 76 of 83 within 10 s, median 5.13 s, max 18.23 s (09_NYC_Dockyard; the Graveyard 17.08, Wan Chai\'s Underworld 13.00), every phase of a load slower than in the dev-server run of 2026-11-08 by about the same factor (1.3 to 1.7 at the median), with no drift along the run; Chromium, run just before it, passes: 83 of 83, median 1.65 s, max 2.94 s (15_Area51_Final). 2026-11-08 (dfd61024, the dev server, [Mac pass](mac-pass-2026-11-08.md#4-loading-731-to-733)): Chromium median 1.51 s, max 2.99 s; Firefox median 3.38 s, max 6.45 s. Linux, 2026-11-10 (528ac7f0, Firefox, the production build then the dev server, back to back on a quiet host): median 3.79 and 3.77 s, max 6.96 and 7.08 s (the Island), 83 of 83 within 10 s in both, so the build loads as fast as the dev server; 2026-11-04 (the dev server): Chromium median 2.23 s, max 4.30 s; Firefox median 4.17 s, max 8.73 s'});
add('7.3.3', 'Load Game to the first frame ≤ 8 s', 'H', 'FAIL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --saves (the internet corpus\'s 39 slots of one playthrough, each by `loadgame N`)'],
    need: 'Firefox again on a quiet Mac',
    weak: 'Firefox fails on the Mac, 2026-11-09 (177e242a, the production build, the host under swap, [Mac pass](mac-pass-2026-11-09.md#2-travel-and-load-game-on-the-production-build-732-733)): 36 of 39 within 8 s, median 4.85 s (slot by slot 1.04 times 2026-11-08\'s), but three slots in a row 1.7 to 3.6 times slower, the time in `game`: Save0026 13.10 s, Save0027 10.59 s, Save0028 8.72 s; Chromium passes, 39 of 39, median 1.79 s, max 4.87 s (Save0027). 2026-11-08 (dfd61024, the dev server, [Mac pass](mac-pass-2026-11-08.md#4-loading-731-to-733)): Chromium median 1.60 s, max 3.06 s; Firefox median 4.52 s, max 6.50 s. Linux, 2026-11-10 (528ac7f0, Firefox, the production build): 39 of 39 within 8 s, median 4.59 s, max 6.80 s (Save0001), Save0026 to Save0028 4.77, 6.34 and 5.67 s; 2026-11-05 (the production build, [load time](load-time.md#row-733-each-classs-fields-linked-once-2026-11-05)): median 4.74 s, max 6.87 s'});

// 7.4 Memory and long sessions (D5) -----------------------------------------------------------------------------------------------------
add('7.4.1', 'ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope', 'P', 'PARTIAL',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-process-memory.mjs (by hand)', 'map-memory-census.mjs --maps (the same sequence in the page; [memory across many maps](map-memory.md))'],
    weak: 'Linux, 2026-11-05: passes in Node (the heap 0.65 MB a round trip, ArrayBuffers flat); in the page, Chromium (worker) and Firefox (inline) hold the same process state at every Training arrival (990 classes, the same packages, the same page store), the same level arena (31 MB in Chromium, 35 in Firefox) and the page flat, and after forced collections the total at Training rises 0.4 MB a round trip in both once the script-VM kernel has reached its high-water mark (9.6 and 8.1 MB before): the level interpreter\'s handle tables, which covered every handle the process had allocated, now cover the level\'s own handles and those live when it starts ([the handle tables](map-memory.md#the-handle-tables-2026-11-05-linux)), and the purged meshes\' lazy arrays are destroyed as the original destroys them ([mesh destruction](mesh-destruction.md): ~ULodMesh/~UMesh compared call by call with the original in Unicorn). Over the 83 distinct maps six faults were found and fixed (Firefox kept every left level alive through the interpreter\'s WeakRef walks, the 16 GB OOM; a left arena waited for its objects\' finalizers; speech packages never released; the trace kernel\'s arena grew with each map; the handle tables; the lazy arrays): with the handle tables bounded (before the meshes\' destruction landed) every level arena stays at 29 to 36 MB (Chromium) and 29 to 41 MB (Firefox), 221 MB at the end before, and after forced collections the total is 0.80 to 1.16 GB (Chromium) and 0.58 to 1.00 GB (Firefox), its slope over the last 42 maps 0.4 and 0.8 MB a map; without forced collections both reach the 83rd map (the tree at most 6.2 GB in Chromium, 6.1 GB in Firefox; 7.4 and 9.4 before); the Mac not run'});
add('7.4.2', 'each map of the frame-time set stays within the declared memory budget, 1.25 GB for the page plus the worker after forced collections in every browser (the user\'s, 2026-11-08)', 'H', 'PARTIAL',
  {machine: MAC, proof: ['map-memory-census.mjs --maps (the set twice in one page: [the frame-time set](map-memory.md#row-742-the-frame-time-set-2026-11-08-linux))', 'profile-live-heap.mjs', 'profile-firefox-memory.mjs'],
    need: 'Safari: the census drives Chromium and Firefox only',
    weak: 'Chromium (worker) and Firefox (inline) pass on the Mac. Chromium, 2026-11-08 (dfd61024, [Mac pass](mac-pass-2026-11-08.md#5-memory-742-chromium)): 806 to 1,157 MB (the Island\'s second visit, 7 % under), the second pass\'s slope -1.3 MB a map. Firefox, 2026-11-09 (177e242a, the forced collection through Gecko\'s memory-report FIFO, [Mac pass](mac-pass-2026-11-09.md#742-the-census)): 592.8 to 942.5 MB (the Island\'s second visit, 24 % under), the second pass\'s slope -0.6 MB a map, five Wasm memories at every reading. Linux: Chromium 807 to 1,158 MB, Firefox 583 to 936 MB (24ad3e65), its Linux path unchanged by the FIFO change (2026-11-10: 583.3 MB at Training\'s start); before two faults that held left levels were fixed, 1,368 and 1,149 MB. While playing, nothing forced, the Linux process tree at most 2.8 GB (Chromium) and 3.1 GB (Firefox)'});
add('7.4.3', 'the one-hour session (D5) in Chrome and Firefox', 'H', 'PASS', {decision: 'D5', machine: MAC,
  proof: ['session-hour.mjs ([long session](long-session.md))'],
  weak: 'Chrome (worker) and Firefox (inline) pass on the Mac. Chrome, 2026-11-09 (0a25b847, [Mac pass](mac-pass-2026-11-08.md#after-the-fix-the-hour-again)): no runtime error, ten map changes, 5 of 5 saves, the last Island visit +1.2 % from the warm plateau, the median frame work 0.0 % (page) and +1.8 % (worker), no left level held at any of its 33 readings; on dfd61024 it failed (+13.0 %, worker +9.3 %): three holders each kept a left level now and then (the trace kernel\'s last model, and accessors made per call in setSpawnActorZone and the physics adapters, kept by V8\'s allocation sites), fixed in 0a25b847 ([map memory](map-memory.md#the-one-hour-sessions-held-levels-2026-11-09-mac)). Firefox, 2026-11-09 (177e242a, the forced collection through Gecko\'s memory-report FIFO, the host under swap, [Mac pass](mac-pass-2026-11-09.md#743-the-hour)): no runtime error, ten map changes, 5 of 5 saves, the last Island visit +0.5 % from the 973.0 MB plateau, the median page frame work 8.0 then 7.0 ms, five Wasm memories at all 43 readings. The holds were intermittent, so one clean hour in each is evidence, not proof. Linux, 2026-11-04 (8f82b56b, before those fixes), with the first plateau after a warm-up pass (the user\'s reading of D5): Chrome -2.4 %, Firefox +6.2 %, the frame work within bounds'});

// 7.5 Audio (D6) ------------------------------------------------------------------------------------------------------------------------
add('7.5.1', 'sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser', 'H', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['browser-tests/audio-resume.spec.mjs', 'validate-galaxy-music-play.mjs'],
    weak: 'passes in Chromium and Firefox on Linux, 2026-11-04: the first click starts the logo map\'s song; a hidden page (modelled, as headless browsers keep a background tab visible) keeps the mix playing, as the original\'s DSBCAPS_GLOBALFOCUS buffer does, and the game\'s sound comes back with its ticks; a suspended context resumes by itself (before, only a key or a click resumed it, and a key after Exit brought the sound back); on the Mac (2026-11-09) the spec passes in Firefox and Playwright\'s WebKit, and in Chromium when run again (in the whole run no music came in the second after the click, on a loaded host); a real hidden tab and a system interruption not run'});
add('7.5.2', 'a sound\'s latency from PlaySound to output ≤ the original\'s plus one render quantum (D6)', 'O', 'PARTIAL',
  {decision: 'D6', machine: `${MAC}, ${LINUX}`, proof: ['galaxy-output-capture.sh latency and audio-latency-original.mjs (the original under Wine)',
    'audio-latency.mjs (Play; [sound start latency](audio-latency.md))'],
    weak: 'passes on Linux, 2026-11-04: from a start to the host taking its first frame out of Galaxy\'s buffer (D6\'s "output" as the user chose to read it, 2026-11-04; each host\'s own buffering to the device after it is reported, not bounded), the original under Wine 11.20 over 20 minutes (the phase of Galaxy\'s 20 ms timer against Wine\'s 10 ms mixer moves its figure by several ms, so a minute is not enough) median 45.6 ms and p95 56.1; Play in Chromium (worker) 46.0 and 55.4, in Firefox (inline) 45.0 and 55.7. The Mac (CrossOver, 2,048-byte periods) not run'});

// 7.6 Window and input ------------------------------------------------------------------------------------------------------------------
add('7.6.1', 'the pointer lock is taken on the first click; one Escape releases it and reaches the game (MenuMain); a lost lock or a blur lets go of the held input and Play goes on (no pause, the user\'s choice 2026-10-30); a hidden page resumes without catch-up', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/pointer-lock.spec.mjs', 'browser-tests/original-start-input.spec.mjs'],
    weak: 'Chrome\'s worker mode, headless, Linux (2026-10-30): the browser\'s Escape rule played as its call (exitPointerLock, no key) opens MenuMain once, a delivered key as well counts once, the free mouse drives the menu; a blur lets go of the held movement and the level\'s clock goes on; a real Escape is not exercised under Playwright (the user saw two presses needed on Chrome Linux and macOS before the change); the hidden-page resume is not tested; on the Mac (2026-11-09) both specs pass in Chromium and Firefox, and Playwright\'s WebKit refuses the pointer lock without window focus, so they cannot pass there'});
add('7.6.2', 'Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari)', 'O, H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/original-start-input.spec.mjs', 'input-bindings.spec.mjs'],
    weak: 'passes in Chromium and Firefox on Linux (2026-10-28): Keyboard Lock where the browser has it, and in Firefox Alt+Enter takes the fullscreen and the pointer without it (the pointer asked again at fullscreenchange, which Firefox needs); a held Escape and F11 in a real browser are not exercised; on the Mac (2026-11-09) both specs pass in Chromium and Firefox; in Playwright\'s WebKit the refused pointer lock fails them, and input-bindings.spec\'s wheel case fails, not explained (7.1.4)'});
add('7.6.3', 'resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error', 'H', 'PARTIAL',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-resize-play.mjs', '[a resize](boot.md#a-resize)'],
    weak: 'resizes during Play equal a fresh load at the final size byte for byte, the frame and MenuMain over the kept frame, in Chromium and Firefox on Linux (2026-10-31), and the page at a new pixel ratio does in Chromium; a real ratio change (a zoom, another screen) is not produced headless, so `watchPixelRatio` is unmeasured; the Mac not run'});
add('7.6.4', 'a hidden tab or system sleep stops Play (no frame, no tick); it comes back by itself with no catch-up (no click: the user\'s choice, 2026-10-30) and the audio follows', 'H', 'PARTIAL',
  {machine: ALL, proof: ['pointer-lock.spec.mjs (blur)', 'browser-tests/hidden-tab.spec.mjs'],
    weak: 'blur is tested (the game goes on, held input let go); the hidden page passes in Chromium and Firefox on Linux (2026-10-31: no frame and no tick while hidden, back with no click, no catch-up, the held input let go) with the hide modelled (`document.hidden`, `visibilitychange`, no animation frame), as headless browsers keep a background tab visible; hidden-tab.spec and the blur pass in Chromium, Firefox and Playwright\'s WebKit on the Mac (2026-11-09); a real hidden tab, system sleep and the audio not measured'});

// 7.7 Graphics capability and failures --------------------------------------------------------------------------------------------------
add('7.7.1', 'a lost WebGL context freezes Play and restores it as D3DDrv\'s `Lock` does; the frames after equal a run with no loss', 'O', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs (Chromium worker and inline, Firefox)'], weak: 'Safari, and the Mac, not run'});
add('7.7.2', 'no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back', 'H', 'PASS',
  {machine: LINUX, proof: ['browser-tests/no-webgl.spec.mjs', 'browser-tests/graphics-fallback.spec.mjs', 'browser-tests/lodmesh-wasm.spec.mjs', '[no WebGL 2](boot.md#no-webgl-2)'],
    weak: 'the three specs pass in Chromium and Firefox on Linux (2026-10-31) and on the Mac (2026-11-09); in Playwright\'s WebKit there all but no-webgl.spec pass, which turns WebGL off with a Chromium switch WebKit ignores'});
add('7.7.3', 'a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable', 'H', 'PASS',
  {machine: LINUX, proof: ['browser-tests/software-renderer.spec.mjs (Chromium on SwiftShader, Firefox on llvmpipe)'],
    weak: 'passes on Linux, 2026-11-04: the renderer is named (Firefox masks it as "llvmpipe, or similar", still recognised), the mesh path is the CPU one, Training keeps real time (game 10.02 and 10.07 s in 10.04 s) and draws 133 fps (SwiftShader) and 195 fps (llvmpipe) at 960×640; "playable" is read as keeping real time, the frame rate reported, not bounded; on the Mac (2026-11-09) Chromium passes, and the spec has no path for macOS Firefox (llvmpipe is Linux only) or WebKit'});

// 7.8 Files and storage -----------------------------------------------------------------------------------------------------------------
add('7.8.1', 'the game folder opens through the gate\'s picker in every supported browser', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/viewer.spec.mjs'],
    weak: 'the picker opens the folder in Chromium and Firefox headless (`setInputFiles`; viewer.spec passes in both on Linux, 2026-10-28, and on the Mac, 2026-11-09); in Playwright\'s WebKit the same folder given three times keeps the first (viewer.spec:54; a player picks once); a real picker is not run'});
add('7.8.2', 'saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/save-game.spec.mjs', 'save-folder.spec.mjs', 'test/save-store.test.mjs', 'test/save-persistence.test.mjs'],
    weak: 'the save, load and Saves window specs pass in Chromium and Firefox on Linux (2026-10-28; Firefox\'s persist() prompt no longer holds the later saves); on the Mac (2026-11-09) save-game.spec passes in Chromium, Firefox and Playwright\'s WebKit, and save-folder.spec skips (it needs the desktop slots of `.work/real-saves`); a real persistence prompt\'s answer is not observed; the unit tests use a fake store'});
add('7.8.3', 'in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads', 'H, O', 'MISSING',
  {machine: `${MAC}, ${LINUX}`, proof: ['save-folder.spec.mjs headed with a real folder', 'validate-save-game.mjs'],
    need: '[save storage](save-storage.md) says a headed Chromium with a real folder was not run'});
add('7.8.4', 'settings persist across reloads in every supported browser (row 6.1.5\'s proof)', 'O', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/config-persistence.spec.mjs', 'validate-config-persistence.mjs'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-28), and in Chromium, Firefox and Playwright\'s WebKit on the Mac (2026-11-09)'});

// 7.9 Failure recovery ------------------------------------------------------------------------------------------------------------------
add('7.9.1', 'a runtime error pauses Play with its message, and Player start or a reload recovers', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/runtime-error.spec.mjs'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-28, brought up to date: the push read from Plant7\'s Location, the right mouse button to use); on the Mac (2026-11-09) both cases pass in Firefox and Playwright\'s WebKit, and in Chromium the door case passed when run again (in the whole run the door was still opening when its 5 s poll ended)'});
add('7.9.2', 'the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['browser-tests/worker-failure.spec.mjs', '[a failed worker](sim-worker.md#a-failed-worker)'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-31), and in Chromium, Firefox and Playwright\'s WebKit on the Mac (2026-11-09): a closed and a looping worker (the page tells them by its posts\' silence), a failed call and an uncaught exception, a termination at a save\'s picture request (the kept slot unchanged); out of memory measured in a bare worker only (a RangeError takes the exception path; Chromium\'s heap exhaustion crashes the tab into the browser\'s own page, Firefox\'s grows the process), not induced in Play'});
add('7.9.3', 'a graphics device that never comes back: the page says so, and a reload recovers', 'H', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs --case never', '[context loss](context-loss.md)'],
    weak: 'Chromium (worker and inline) and Firefox on Linux (2026-10-31); WebKit not run'});

// 7.10 Regression coverage --------------------------------------------------------------------------------------------------------------
add('7.10.1', 'the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`)', 'P', 'PARTIAL',
  {machine: `${LINUX}, with the Mac's stores`, proof: ['run-validators.mjs'],
    weak: 'on 2026-11-06 (Linux, master e2c96f5c, after the night\'s Firefox ports): 680 passed, 8 skipped (Wine and hardware probes), 0 failed in 91 minutes, validate-full-run (New Game to an ending, the original\'s travel text at every mission change) included and validate-gpu-mesh in 136 s; not yet the closing commit. Before: on 2026-10-30, after the 6 reds of 2026-10-27 and 25 newer ones were fixed (ac8e211b, 65ab361c, the reds-2026-10-30 branch on 82482dcb): 677 passed, 8 skipped, 1 failed; validate-gpu-mesh stalled idle to the 600 s limit and passes alone (104 s) and on 1.5 cores (116 s), its stall not explained (the runner now prints a killed check\'s last stdout); not run on the closing commit'});
add('7.10.2', 'the browser suite passes in every supported browser', 'P', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['`npx playwright test` (projects chromium, firefox, webkit)', 'SUITE_RUN, `--suite`'],
    weak: 'Chromium 50 of 50 and Firefox 49 of 50 on Linux (2026-10-31; the Firefox red, the first save reopening MenuMain, fixed in 30190c15 and its spec passing since); on the Mac (2026-11-09, [the suite by browser](#the-browser-suite-by-browser)) Chromium 44 of 49, Firefox 46 of 49 and Playwright\'s WebKit 35 of 49, 4 skipped in each (no desktop slots there)'});
add('7.10.3', 'the Stage 4, 5 and 6 gates pass on the closing commit', 'P, O', 'MISSING',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-stage4-acceptance.mjs', 'validate-stage5-acceptance.mjs', 'stage6-criteria.mjs'],
    need: 'a run on one commit (last runs: Stage 4 on 2026-10-17, Stage 5 on 2026-10-21, Stage 6\'s rows by 2026-10-26)'});

// 7.11 Excluded -------------------------------------------------------------------------------------------------------------------------
const excluded = (id, claim, reason) => add(id, claim, '-', 'EXCLUDED', {excluded: reason});
excluded('7.11.1', 'multiplayer', 'the last priority (AGENTS.md)');
excluded('7.11.2', 'mobile and touch browsers', 'the game takes a keyboard and a mouse');
excluded('7.11.3', 'Windows', 'no Windows machine (D1); Chrome\'s engine rows stand in for Chrome and Edge there, unmeasured');

for (const row of CRITERIA) if (!STATUSES.includes(row.status)) throw new Error(`stage7-criteria: ${row.id} has status ${row.status}`);

// The browser suite by browser (row 7.10.2), as last run: every test that failed in some browser, with its cause there (SUITE_CAUSES) or
// 'pass' (`fixed`: what made it pass since, shown by a rerun). A test not listed passed in every browser that ran. Recorded by hand
// from the runs' JSON reports and logs.
export const SUITE_CAUSES = Object.freeze({
  stale: 'the spec predates a change in Play and fails in every browser',
  race: 'the spec reads a state before worker mode delivers it, or before a loaded host has drawn it',
  harness: 'Playwright\'s synthetic input or headless window is not a real browser\'s, and the spec cannot pass as written',
  spec: 'the spec assumes what that browser does not do (a Chromium switch, a whole-pixel layout, a readback outside the frame that drew)',
  platform: 'the spec\'s case has no path in that browser on that system',
  api: 'the spec needs a Chromium-only API',
  play: 'a Play bug in that browser or simulation mode',
  unexplained: 'it fails and its cause is not found',
});
export const SUITE_RUN = {
  date: '2026-11-09', machine: 'the Mac (Apple M2 Pro, macOS on Darwin 25.6, a loaded host: [Mac pass](mac-pass-2026-11-09.md#5-supported-browsers-711-713-714)), headless, on 177e242a\'s code', tests: 53,
  rerun: 'Each project ran alone with the repository\'s config, Firefox through a wrapper that mutes it, and software-renderer.spec in Firefox alone after the user muted the Mac (Playwright\'s WebKit, build 2359, has no mute switch either). Chromium\'s five failures ran again once, alone: audio-resume.spec and runtime-error.spec passed, the other three failed again. The four skips (load-game.spec and save-folder.spec\'s three) need `.work/real-saves`, the desktop slots from the Linux host\'s Wine prefix, which the Mac does not have. Before it, Linux on 2026-10-31: Chromium 50 of 50, Firefox 49 of 50, the red fixed since (row 7.10.2); on 2026-10-28 41 of 41 in both, after the failures of that day\'s first run were fixed (Git history of this file).',
  browsers: {
    chromium: {version: '153.0.8010.12', sim: 'worker', passed: 44, skipped: 4, minutes: 20},
    firefox: {version: '155.0', sim: 'inline', passed: 46, skipped: 4, minutes: 20},
    webkit: {version: '26.6', sim: 'worker', passed: 35, skipped: 4, minutes: 17},
  },
  failures: [
    {test: 'audio-resume.spec.mjs:24', chromium: 'race', firefox: 'pass', webkit: 'pass',
      note: 'race (Chromium, the whole run): no music in the second after the click (0 quanta, over 150 expected); passed when run again alone'},
    {test: 'runtime-error.spec.mjs:49', chromium: 'race', firefox: 'pass', webkit: 'pass',
      note: 'race (Chromium, the whole run): the door DeusExMover16 still opening (alpha 0.958) when the 5 s poll ended; passed when run again alone'},
    {test: 'gameplay.spec.mjs:89', chromium: 'race', firefox: 'pass', webkit: 'pass',
      note: 'race (Chromium, twice): after the switch to the inspection camera the player moved (44 units, then 5): a simulation frame already in flight in the worker lands after the spec reads the frozen state; whether inspect drops that frame (Play) or the spec waits for it is open; Firefox runs inline, and Chromium on Linux passes (2026-11-10)'},
    {test: 'instructor-conversation.spec.mjs:12', chromium: 'unexplained', firefox: 'pass', webkit: 'pass',
      note: 'unexplained (Chromium, twice): no conversation within 5 s of the use, though the frob trace had selected UNATCOTroop3 (framed as the target, no pause, 16 fps); passes in Firefox there and in Chromium on Linux (2026-11-10)'},
    {test: 'lighting.spec.mjs:10', chromium: 'unexplained', firefox: 'spec', webkit: 'spec',
      note: 'unexplained (Chromium, twice): the canvas never read 926 × 603 within the 5 s poll (the failure\'s screenshot: a 603-pixel canvas, 0 fps), while the same steps alone reach it in 200 ms, and Chromium on Linux passes (2026-11-10); spec (Firefox): Firefox on macOS lays the bars out at fractional heights and the spec asks Playwright for a viewport 712.8 px high, which it refuses; spec (WebKit, unconfirmed): the unlit probe pixel read [0, 0, 0, 0] in the spec\'s own animation frame, where WebKit appears to give the cleared buffer of a view that draws only on a change'},
    {test: 'mirrors.spec.mjs:6', chromium: 'pass', firefox: 'spec', webkit: 'pass', note: 'spec (Firefox): lighting.spec\'s sizing, the same fractional height'},
    {test: 'software-renderer.spec.mjs:17', chromium: 'pass', firefox: 'platform', webkit: 'platform',
      note: 'platform: its Firefox case is Mesa\'s llvmpipe through LIBGL_ALWAYS_SOFTWARE, which only Linux has (on macOS Firefox reports "Apple M1, or similar"), and it has no WebKit case ("Apple GPU")'},
    {test: 'pointer-lock.spec.mjs:10', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): headless WebKit refuses the pointer lock, "Pointer lock requires the window to have focus"'},
    {test: 'input-bindings-table.spec.mjs:16', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): the same refused lock, at the double click'},
    {test: 'input-bindings.spec.mjs:106', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): no Keyboard Lock, as the spec expects there, then the same refused lock'},
    {test: 'original-start-input.spec.mjs:15', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): the same refused lock'},
    {test: 'original-start-input.spec.mjs:54', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): the same refused lock'},
    {test: 'hud.spec.mjs:5', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): a synthetic drag carries no `movementX/Y` there, so the compass does not turn'},
    {test: 'viewer.spec.mjs:12', chromium: 'pass', firefox: 'pass', webkit: 'harness', note: 'harness (WebKit): the same drag, the camera unturned'},
    {test: 'original-start-load-game.spec.mjs:12', chromium: 'pass', firefox: 'pass', webkit: 'harness',
      note: 'harness (WebKit), most likely, not checked: the menus\' cursor follows relative motion, which WebKit reports as 0, so the click on Load Game lands where the cursor was'},
    {test: 'original-start-intro-credits.spec.mjs:13', chromium: 'pass', firefox: 'pass', webkit: 'harness',
      note: 'harness (WebKit), most likely, not checked: no menu after the intro\'s Escape and two clicks, the original start taking the pointer on a click'},
    {test: 'input-bindings.spec.mjs:17', chromium: 'pass', firefox: 'pass', webkit: 'unexplained',
      note: 'unexplained (WebKit): the first wheel notch put MedKit0 (items[2]) in hand, not Multitool3 (items[1]), though the wheel reaches the page as in Chromium (one event, deltaY 100)'},
    {test: 'no-webgl.spec.mjs:8', chromium: 'pass', firefox: 'pass', webkit: 'spec', note: 'spec (WebKit): it turns WebGL off with `--disable-webgl`, a Chromium switch WebKit ignores, so the gate went on to load the map'},
    {test: 'viewer.spec.mjs:54', chromium: 'pass', firefox: 'pass', webkit: 'harness',
      note: 'harness (WebKit): the spec gives the same temporary folder three times, and after the second `setInputFiles` the page still read the first, invalid 00_Training.dx (no change event, or the old File\'s bytes: not checked); a player picks a folder once'},
  ],
};
for (const [name, run] of Object.entries(SUITE_RUN.browsers)) if (!run.notRun) {
  const failed = SUITE_RUN.failures.filter(f => f[name] !== 'pass');
  if (failed.some(f => !SUITE_CAUSES[f[name]])) throw new Error(`stage7-criteria: a ${name} failure has no cause`);
  if (run.passed + failed.length + (run.skipped ?? 0) !== SUITE_RUN.tests) throw new Error(`stage7-criteria: ${name} counts ${run.passed} + ${failed.length} + ${run.skipped ?? 0} != ${SUITE_RUN.tests}`);
}

/** The suite run as the note's section of that name (`--suite`). */
function suiteMarkdown() {
  const cell = text => String(text ?? '').replaceAll('|', '\\|');
  const names = Object.keys(SUITE_RUN.browsers), ran = names.filter(n => !SUITE_RUN.browsers[n].notRun);
  const lines = [`## The browser suite by browser\n`, `Last run ${SUITE_RUN.date} on ${SUITE_RUN.machine}, ${SUITE_RUN.tests} tests a browser, one worker. ${SUITE_RUN.rerun}\n`];
  for (const n of names) {
    const b = SUITE_RUN.browsers[n];
    if (b.notRun) { lines.push(`- ${n}: not run. ${b.notRun}.`); continue; }
    const count = {};
    for (const f of SUITE_RUN.failures) if (f[n] !== 'pass') count[f[n]] = (count[f[n]] ?? 0) + 1;
    const causes = Object.entries(count).map(([c, k]) => `${k} ${c}`).join(', ');
    lines.push(`- ${n} ${b.version} (${b.sim} mode): ${b.passed} pass, ${SUITE_RUN.tests - b.passed - (b.skipped ?? 0)} fail${causes ? ` (${causes})` : ''}${b.skipped ? `, ${b.skipped} skipped` : ''}, ${b.minutes} min.`);
  }
  lines.push('', `Causes: ${Object.entries(SUITE_CAUSES).map(([c, text]) => `**${c}**, ${text}`).join('; ')}. A test not listed passed in every browser that ran, but for the skipped ones.`, '');
  lines.push(`| Test | ${ran.join(' | ')} | Why |`, `| --- | ${ran.map(() => '---').join(' | ')} | --- |`);
  for (const f of SUITE_RUN.failures) lines.push(`| ${f.test} | ${ran.map(n => f[n]).join(' | ')} | ${cell(f.note)}${f.fixed ? `. **Fixed:** ${cell(f.fixed)}` : ''} |`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = {};
  for (const row of CRITERIA) (counts[row.clause] ??= {})[row.status] = (counts[row.clause][row.status] ?? 0) + 1;
  console.log(`| Clause | ${STATUSES.join(' | ')} |\n| --- | ${STATUSES.map(() => '---:').join(' | ')} |`);
  const total = {};
  for (const [c, name] of Object.entries(CLAUSES)) {
    const k = counts[c] ?? {};
    for (const s of STATUSES) total[s] = (total[s] ?? 0) + (k[s] ?? 0);
    console.log(`| 7.${c} ${name} | ${STATUSES.map(s => k[s] ?? 0).join(' | ')} |`);
  }
  console.log(`| **Total** | ${STATUSES.map(s => total[s]).join(' | ')} |`);
  if (process.argv.includes('--list')) for (const row of CRITERIA) console.log(`${row.id}\t${row.status}\t${row.claim}`);
  if (process.argv.includes('--suite')) console.log(`\n${suiteMarkdown()}`);
  // --markdown: the row tables of docs/stage-7-exit-criteria.md, one per clause
  if (process.argv.includes('--markdown')) for (const [c, name] of Object.entries(CLAUSES)) {
    const cell = text => String(text ?? '').replaceAll('|', '\\|');
    const decisions = [...new Set(CRITERIA.filter(row => row.clause === Number(c)).map(row => row.decision).filter(Boolean))];
    console.log(`\n### 7.${c} ${name}${decisions.length ? ` (${decisions.join(', ')})` : ''}\n\n| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |\n| --- | --- | --- | --- | --- | --- | --- |`);
    for (const row of CRITERIA.filter(row => row.clause === Number(c)))
      console.log(`| ${row.id} | ${cell(row.claim)} | ${row.kind} | ${cell(row.proof.join(', ') || '-')} | ${cell(row.machine)} | ${cell([row.need && `needed: ${row.need}`, row.weak && (row.status === 'FAIL' ? row.weak : `weak: ${row.weak}`), row.excluded].filter(Boolean).join('; ') || '-')} | ${row.status} |`);
  }
}
