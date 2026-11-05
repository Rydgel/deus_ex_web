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
add('7.1.1', 'Chrome, macOS, worker mode', 'H', 'PARTIAL', {decision: 'D1', proof: SUITE, machine: MAC,
  weak: 'the Mac has not run the suite since early October; on Linux it runs (7.1.2)'});
add('7.1.2', 'Chrome, Linux, worker mode', 'H', 'PARTIAL', {decision: 'D1', proof: ['the same, `--project chromium`'], machine: LINUX,
  weak: 'the suite on 2026-10-28: 41 of 41 (39 in the whole run, its two failures run again: a fixed race and one unexplained instructor-conversation failure that passed three reruns); the 7.x validators are not run as a set'});
add('7.1.3', 'Firefox, macOS and Linux, inline mode', 'H', 'PARTIAL', {decision: 'D1', machine: `${MAC}, ${LINUX}`,
  proof: ['the suite, `--project firefox`', 'validate-inline-restore-play', 'validate-context-loss-play --browser firefox'],
  weak: 'the suite on 2026-10-28 (Linux): 41 of 41, after four Firefox Play bugs it found were fixed (the wheel; the inline Saves and CRT buttons; the pointer after Alt+Enter; later saves held by the persist() prompt) and its menu specs got a portable cursor driver; the Mac not run'});
add('7.1.4', 'Safari, macOS', 'H', 'MISSING', {decision: 'D1', machine: MAC,
  proof: ['the suite under Playwright\'s WebKit as a stand-in (`--project webkit`, on the Mac)', 'the session in real Safari (by hand or safaridriver)'],
  need: 'never run; Playwright\'s Linux WebKit is an Ubuntu build that this host\'s libraries do not run (ICU 74, libxml2.so.2, flite); Safari\'s storage eviction, no Keyboard Lock, no `showDirectoryPicker`'});

// 7.2 Frame time (D2, D3) ---------------------------------------------------------------------------------------------------------------
add('7.2.1', 'Chrome, worker: on each map of the frame-time set, the larger of the page\'s and the worker\'s median frame work ≤ 8.3 ms (AGENTS.md)', 'H', 'MISSING',
  {decision: 'D2', machine: MAC, proof: ['frame-time-set.mjs (hitch-run.mjs --mode scan, hitch-summary.mjs)'],
    need: 'a Mac measurement. Indicative, Linux 2026-11-05 (0f6d1eeb, god mode, [frame cost](play-frame-cost.md#the-frame-time-set-on-2026-11-05-linux)): every map worker-bound; nine of ten under the bound (Training 4.3, the Bar 4.9, Battery Park 8.2, the Airfield 8.2, Wan Chai\'s market 8.2, the Ship 6.5, the Chateau 5.8, Everett 4.6, the bunker 7.9 ms), the Island over at 8.4 ms (2026-11-04: 8.7 to 8.9); one run\'s median moves by up to 0.8 ms between runs of one build; the Mac\'s tick was about 1.35 times this host\'s'});
add('7.2.2', 'every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps\' jitter)', 'H', 'FAIL',
  {decision: 'D2', machine: MAC, proof: ['frame-time-set.mjs --browser B --headed (a visible window: headless Chromium draws on a synthetic 60 Hz clock)'],
    weak: 'Linux, 2026-11-05 (f2f1cb6f, 240 Hz display, [frame cost](play-frame-cost.md#row-722-headed-2026-11-05-linux)): Chrome worker passes on all ten maps (p95 8.3 to 14.9 ms, 116 to 218 fps); Firefox inline fails on six (Island 21, Ship 21, Airfield 25, Wan Chai 25, Bunker 25, Battery Park 31 ms; 37 to 59 fps), its page frame about twice Chrome\'s worker frame (the level tick 1.8 to 2.4 times); the Mac and Safari not run'});
add('7.2.3', 'Chrome: from a map\'s first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam', 'H', 'PARTIAL',
  {machine: MAC, proof: ['hitch-run.mjs --mode roam --seconds 120', 'hitch-summary.mjs'],
    weak: 'Linux only: with all cores, no gap over 100 ms on the Island and WanChai Underworld; pinned to two cores (a loaded machine, where the user feels it on the Mac) 2 to 4 gaps over 100 ms a run, up to 350 ms, each the worker\'s major GC (2026-10-28, docs/live-heap.md); not on the Mac'});
add('7.2.4', 'Firefox inline: from a map\'s first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3)', 'H', 'FAIL',
  {decision: 'D3', machine: `${MAC}, ${LINUX}`, proof: ['hitch-ab.mjs or hitch-run.mjs --browser firefox', 'hitch-summary.mjs', 'gecko-gaps.mjs (with --profile)'],
    weak: 'fails on its second half: on the Island, Linux, 2026-10-31 (d01854c9, after the live-heap work), three 100 s roams drew no gap over 150 ms and at most one over 100 ms (longest 84, 101, 101 ms), but 10 to 18 over 50 ms a minute (2026-10-28: 26 to 31 over 50 ms in 65 s, longest 133 ms). A Gecko profile of one roam puts 12 of its 31 on major-collection slices (5 to 80 ms, 11 in two collections) and 19 on no pause (long page frames: sim and draw on one thread, 17 to 20 ms median). The worker is no way out: its non-incremental collections freeze 14 times over 150 ms a roam (up to 366 ms) idle, and once every 25 to 40 s for 200 to 250 ms with ?workerBusy=1 (docs/hitch-log.md "Firefox")'});
add('7.2.5', 'no shader program is compiled during play after a load', 'P', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['hitch-summary.mjs (programs created from 5 s on) over the frame-time set'],
    weak: '0 programs on all ten maps of the frame-time set (Chrome, Linux, 2026-11-04), and on the Island in Firefox (2026-10-28); the Mac is not measured'});

// 7.3 Loading time (D4) -----------------------------------------------------------------------------------------------------------------
add('7.3.1', 'navigation to the logo map\'s first frame ≤ 10 s (Chrome and Firefox)', 'H', 'PARTIAL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --start original --folder ([load time](load-time.md#the-stage-7-rows-2026-11-04-linux))'],
    weak: 'passes on Linux, 2026-11-04, the production build with the folder given at the picker: Chromium 4.7 to 4.8 s, Firefox 6.1 to 6.3 s (the dev server adds 1.5 to 2 s); the Mac not run'});
add('7.3.2', 'a travel arrival\'s first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map', 'H', 'PARTIAL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --travel --maps all (the 83 maps)'],
    weak: 'passes on Linux, 2026-11-04: all 83 arrive; Chromium median 2.23 s, max 4.30 s (Paris Metro); Firefox, the production build in fresh browsers of about 20 maps, median 4.17 s, max 8.73 s (on a machine under a background load, 11.6 s); the Mac not run'});
add('7.3.3', 'Load Game to the first frame ≤ 8 s', 'H', 'FAIL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --saves (the internet corpus\'s 39 slots of one playthrough, each by `loadgame N`)'],
    weak: 'Linux, 2026-11-04, the production build: every slot loads in both; Chromium median 2.13 s, max 4.20 s, cold 2.85 to 4.12 s (passes); Firefox median 5.22 s, every slot under the bound but the Island\'s Save0001, cold 7.94 to 8.19 s (median 8.05 of six runs): the page\'s world build 1.3 s and the simulation\'s createGame 5.5 s, one after the other on its one thread; the Mac not run'});

// 7.4 Memory and long sessions (D5) -----------------------------------------------------------------------------------------------------
add('7.4.1', 'ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope', 'P', 'PARTIAL',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-process-memory.mjs (by hand)', 'map-memory-census.mjs --maps (the same sequence in the page; [memory across many maps](map-memory.md))'],
    weak: 'Linux, 2026-11-04: passes in Node; in the page, Chromium (worker) and Firefox (inline) hold the same process state at every Training arrival (990 classes, the same packages, the same page store) with the page flat, but the total after forced collections rises 6.9 MB (Chromium) and 5.2 MB (Firefox) a round trip: each level\'s interpreter tables cover every handle ever allocated (handles are never reused; about 2.4 MB of the level\'s arena a map change). The purged meshes\' lazy arrays, which stayed attached to their package\'s linker archive (9.6 and 8.1 MB a round trip before), are now destroyed as the original destroys them (2026-11-05, [mesh destruction](mesh-destruction.md): ~ULodMesh/~UMesh compared call by call with the original in Unicorn): the actors\' backing stores hold 1,530 ArrayBuffers at the second and the tenth Training arrival (1,630 and 2,046 before). Over the 83 distinct maps four faults were found and fixed (Firefox kept every left level alive through the interpreter\'s WeakRef walks, the 16 GB OOM; a left arena waited for its objects\' finalizers; speech packages never released; the trace kernel\'s arena grew with each map): both browsers reach the 83rd map without forced collections (the tree at most 7.4 GB in Chromium, 9.4 GB in Firefox), and after forced collections 0.79 to 1.35 GB (Chromium) and 0.58 to 1.18 GB (Firefox), the handle tables the only slope left; the Mac not run'});
add('7.4.2', 'each map of the frame-time set stays within a declared memory budget (page plus worker, after GC)', 'H', 'MISSING',
  {machine: MAC, proof: ['profile-live-heap.mjs', 'profile-firefox-memory.mjs'],
    need: 'the budget, to fit a 16 GB machine; today the Island\'s worker reaches 1.4 GB before a GC in Chrome'});
add('7.4.3', 'the one-hour session (D5) in Chrome and Firefox', 'H', 'PARTIAL', {decision: 'D5', machine: MAC,
  proof: ['session-hour.mjs ([long session](long-session.md))'],
  weak: 'passes on Linux, 2026-11-04 (8f82b56b), with the first plateau after a warm-up pass of the route (the user\'s reading of D5): no runtime error, ten map changes, five save and load round trips; the last Island visit\'s heap -2.4 % (Chrome, worker) and +6.2 % (Firefox, inline) from the warm plateau, the median frame work -10 % (page) and -9.4 % (worker) in Chrome, 0 % in Firefox. From a cold start both failed (+33 %, +44 %): the process filling its classes, packages and caches. The runs found five memory faults and every visited map\'s procedural textures ticking each frame (about 0.5 ms once warm), all fixed. The Mac not run'});

// 7.5 Audio (D6) ------------------------------------------------------------------------------------------------------------------------
add('7.5.1', 'sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser', 'H', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['browser-tests/audio-resume.spec.mjs', 'validate-galaxy-music-play.mjs'],
    weak: 'passes in Chromium and Firefox on Linux, 2026-11-04: the first click starts the logo map\'s song; a hidden page (modelled, as headless browsers keep a background tab visible) keeps the mix playing, as the original\'s DSBCAPS_GLOBALFOCUS buffer does, and the game\'s sound comes back with its ticks; a suspended context resumes by itself (before, only a key or a click resumed it, and a key after Exit brought the sound back); a real hidden tab, a system interruption, WebKit and the Mac not run'});
add('7.5.2', 'a sound\'s latency from PlaySound to output ≤ the original\'s plus one render quantum (D6)', 'O', 'PARTIAL',
  {decision: 'D6', machine: `${MAC}, ${LINUX}`, proof: ['galaxy-output-capture.sh latency and audio-latency-original.mjs (the original under Wine)',
    'audio-latency.mjs (Play; [sound start latency](audio-latency.md))'],
    weak: 'passes on Linux, 2026-11-04: from a start to the host taking its first frame out of Galaxy\'s buffer (D6\'s "output" as the user chose to read it, 2026-11-04; each host\'s own buffering to the device after it is reported, not bounded), the original under Wine 11.20 over 20 minutes (the phase of Galaxy\'s 20 ms timer against Wine\'s 10 ms mixer moves its figure by several ms, so a minute is not enough) median 45.6 ms and p95 56.1; Play in Chromium (worker) 46.0 and 55.4, in Firefox (inline) 45.0 and 55.7. The Mac (CrossOver, 2,048-byte periods) not run'});

// 7.6 Window and input ------------------------------------------------------------------------------------------------------------------
add('7.6.1', 'the pointer lock is taken on the first click; one Escape releases it and reaches the game (MenuMain); a lost lock or a blur lets go of the held input and Play goes on (no pause, the user\'s choice 2026-10-30); a hidden page resumes without catch-up', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/pointer-lock.spec.mjs', 'browser-tests/original-start-input.spec.mjs'],
    weak: 'Chrome\'s worker mode, headless, Linux (2026-10-30): the browser\'s Escape rule played as its call (exitPointerLock, no key) opens MenuMain once, a delivered key as well counts once, the free mouse drives the menu; a blur lets go of the held movement and the level\'s clock goes on; a real Escape is not exercised under Playwright (the user saw two presses needed on Chrome Linux and macOS before the change); the hidden-page resume is not tested; Firefox not rerun; WebKit and the Mac not run'});
add('7.6.2', 'Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari)', 'O, H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/original-start-input.spec.mjs', 'input-bindings.spec.mjs'],
    weak: 'passes in Chromium and Firefox on Linux (2026-10-28): Keyboard Lock where the browser has it, and in Firefox Alt+Enter takes the fullscreen and the pointer without it (the pointer asked again at fullscreenchange, which Firefox needs); a held Escape and F11 in a real browser are not exercised; WebKit and the Mac not run'});
add('7.6.3', 'resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error', 'H', 'PARTIAL',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-resize-play.mjs', '[a resize](boot.md#a-resize)'],
    weak: 'resizes during Play equal a fresh load at the final size byte for byte, the frame and MenuMain over the kept frame, in Chromium and Firefox on Linux (2026-10-31), and the page at a new pixel ratio does in Chromium; a real ratio change (a zoom, another screen) is not produced headless, so `watchPixelRatio` is unmeasured; the Mac not run'});
add('7.6.4', 'a hidden tab or system sleep stops Play (no frame, no tick); it comes back by itself with no catch-up (no click: the user\'s choice, 2026-10-30) and the audio follows', 'H', 'PARTIAL',
  {machine: ALL, proof: ['pointer-lock.spec.mjs (blur)', 'browser-tests/hidden-tab.spec.mjs'],
    weak: 'blur is tested (the game goes on, held input let go); the hidden page passes in Chromium and Firefox on Linux (2026-10-31: no frame and no tick while hidden, back with no click, no catch-up, the held input let go) with the hide modelled (`document.hidden`, `visibilitychange`, no animation frame), as headless browsers keep a background tab visible; a real hidden tab, system sleep and the audio not measured'});

// 7.7 Graphics capability and failures --------------------------------------------------------------------------------------------------
add('7.7.1', 'a lost WebGL context freezes Play and restores it as D3DDrv\'s `Lock` does; the frames after equal a run with no loss', 'O', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs (Chromium worker and inline, Firefox)'], weak: 'Safari, and the Mac, not run'});
add('7.7.2', 'no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back', 'H', 'PASS',
  {machine: LINUX, proof: ['browser-tests/no-webgl.spec.mjs', 'browser-tests/graphics-fallback.spec.mjs', 'browser-tests/lodmesh-wasm.spec.mjs', '[no WebGL 2](boot.md#no-webgl-2)'],
    weak: 'the three specs pass in Chromium and Firefox on Linux (2026-10-31); WebKit not run'});
add('7.7.3', 'a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable', 'H', 'PASS',
  {machine: LINUX, proof: ['browser-tests/software-renderer.spec.mjs (Chromium on SwiftShader, Firefox on llvmpipe)'],
    weak: 'passes on Linux, 2026-11-04: the renderer is named (Firefox masks it as "llvmpipe, or similar", still recognised), the mesh path is the CPU one, Training keeps real time (game 10.02 and 10.07 s in 10.04 s) and draws 133 fps (SwiftShader) and 195 fps (llvmpipe) at 960×640; "playable" is read as keeping real time, the frame rate reported, not bounded; WebKit not run'});

// 7.8 Files and storage -----------------------------------------------------------------------------------------------------------------
add('7.8.1', 'the game folder opens through the gate\'s picker in every supported browser', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/viewer.spec.mjs'],
    weak: 'the picker opens the folder in Chromium and Firefox headless (`setInputFiles`; viewer.spec passes in both, 2026-10-28); a real picker is not run'});
add('7.8.2', 'saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/save-game.spec.mjs', 'save-folder.spec.mjs', 'test/save-store.test.mjs', 'test/save-persistence.test.mjs'],
    weak: 'the save, load and Saves window specs pass in Chromium and Firefox on Linux (2026-10-28; Firefox\'s persist() prompt no longer holds the later saves); a real persistence prompt\'s answer is not observed; the unit tests use a fake store'});
add('7.8.3', 'in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads', 'H, O', 'MISSING',
  {machine: `${MAC}, ${LINUX}`, proof: ['save-folder.spec.mjs headed with a real folder', 'validate-save-game.mjs'],
    need: '[save storage](save-storage.md) says a headed Chromium with a real folder was not run'});
add('7.8.4', 'settings persist across reloads in every supported browser (row 6.1.5\'s proof)', 'O', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/config-persistence.spec.mjs', 'validate-config-persistence.mjs'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-28); WebKit and the Mac not run'});

// 7.9 Failure recovery ------------------------------------------------------------------------------------------------------------------
add('7.9.1', 'a runtime error pauses Play with its message, and Player start or a reload recovers', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/runtime-error.spec.mjs'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-28, brought up to date: the push read from Plant7\'s Location, the right mouse button to use); WebKit and the Mac not run'});
add('7.9.2', 'the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['browser-tests/worker-failure.spec.mjs', '[a failed worker](sim-worker.md#a-failed-worker)'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-31): a closed and a looping worker (the page tells them by its posts\' silence), a failed call and an uncaught exception, a termination at a save\'s picture request (the kept slot unchanged); out of memory measured in a bare worker only (a RangeError takes the exception path; Chromium\'s heap exhaustion crashes the tab into the browser\'s own page, Firefox\'s grows the process), not induced in Play'});
add('7.9.3', 'a graphics device that never comes back: the page says so, and a reload recovers', 'H', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs --case never', '[context loss](context-loss.md)'],
    weak: 'Chromium (worker and inline) and Firefox on Linux (2026-10-31); WebKit not run'});

// 7.10 Regression coverage --------------------------------------------------------------------------------------------------------------
add('7.10.1', 'the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`)', 'P', 'PARTIAL',
  {machine: `${LINUX}, with the Mac's stores`, proof: ['run-validators.mjs'],
    weak: 'on 2026-10-30, after the 6 reds of 2026-10-27 and 25 newer ones were fixed (ac8e211b, 65ab361c, the reds-2026-10-30 branch on 82482dcb): 677 passed, 8 skipped, 1 failed; validate-gpu-mesh stalled idle to the 600 s limit and passes alone (104 s) and on 1.5 cores (116 s), its stall not explained (the runner now prints a killed check\'s last stdout); not run on the closing commit'});
add('7.10.2', 'the browser suite passes in every supported browser', 'P', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['`npx playwright test` (projects chromium, firefox, webkit)', 'SUITE_RUN, `--suite`'],
    weak: 'Chromium 50 of 50 and Firefox 49 of 50 on Linux (2026-10-31; the Firefox red, the first save reopening MenuMain, fixed in 30190c15 and its spec passing since); WebKit and the Mac not run'});
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
  race: 'the spec reads a state before worker mode delivers it',
  harness: 'Playwright\'s synthetic input is not a real browser\'s, and the spec cannot pass as written',
  api: 'the spec needs a Chromium-only API',
  play: 'a Play bug in that browser or simulation mode',
});
export const SUITE_RUN = {
  date: '2026-10-28', machine: 'the Linux host (AMD, Arch), headless but pointer-lock.spec, at f2d01365', tests: 41,
  rerun: 'The third whole run of the day; its two Chromium failures ran again, three times each, from a frozen worktree (DX_SUITE_TREE): gameplay.spec after its settle and jump checks were fixed, instructor-conversation.spec as it was (it failed once in the whole run, no speaker within 8 s, and passed the three reruns; not explained)',
  browsers: {
    chromium: {version: '153.0.8010.12', sim: 'worker', passed: 41, minutes: 23},
    firefox: {version: '155.0', sim: 'inline', passed: 41, minutes: 19},
    webkit: {notRun: 'Playwright\'s Linux WebKit needs Ubuntu\'s libraries (ICU 74, libxml2.so.2, flite); it runs on the Mac'},
  },
  failures: [
    // every one fixed on 2026-10-28; the first run's causes
    {test: 'original-start-input.spec.mjs:14', chromium: 'pass', firefox: 'pass', note: 'harness (Firefox): under Playwright\'s Firefox pointer lock `movementX/Y` is an offset from a fixed point, so the menus\' cursor never reached Training; then play: Alt+Enter back into fullscreen left Firefox without the pointer (a lock asked in the same event as the fullscreen is refused, NotAllowedError)',
      fixed: 'browser-tests/menu-cursor.mjs dispatches the steps outside Chromium; the page asks for the lock again at fullscreenchange'},
    {test: 'original-start-load-game.spec.mjs:12', chromium: 'pass', firefox: 'pass', note: 'harness (Firefox): the same motion', fixed: 'menu-cursor.mjs'},
    {test: 'load-game.spec.mjs:61', chromium: 'pass', firefox: 'pass', note: 'play then harness (Firefox): the Saves button in inline mode, then the motion', fixed: 'the inline game answers `windowMouseGrabbed`; menu-cursor.mjs'},
    {test: 'save-folder.spec.mjs:166', chromium: 'pass', firefox: 'pass', note: 'play then harness (Firefox): the same', fixed: 'the same'},
    {test: 'save-folder.spec.mjs:213', chromium: 'pass', firefox: 'pass', note: 'play (Firefox): the Saves button in inline mode', fixed: 'the inline game answers `windowMouseGrabbed`'},
    {test: 'save-game.spec.mjs:71', chromium: 'pass', firefox: 'pass',
      note: 'harness then play (Firefox): the motion; then the first save\'s `navigator.storage.persist()` prompt, which Firefox leaves pending until the player answers, held every later save in the storage queue (the second was never written), and took the pointer lock back',
      fixed: 'menu-cursor.mjs; persist() is no longer awaited (save-persistence.mjs); the spec\'s cursor reaches the menu at the pointer\'s own position while the lock is gone'},
    {test: 'save-game.spec.mjs:186', chromium: 'pass', firefox: 'pass', note: 'harness (Firefox): the motion', fixed: 'menu-cursor.mjs'},
    {test: 'input-bindings.spec.mjs:106', chromium: 'pass', firefox: 'pass', note: 'api (Firefox): Keyboard Lock is Chromium\'s', fixed: 'checked where the browser has it; without it, Alt+Enter takes the fullscreen and the pointer and calls nothing'},
    {test: 'pointer-lock.spec.mjs:10', chromium: 'pass', firefox: 'pass', note: 'harness: a synthetic Escape never reaches the browser\'s own release of the lock',
      fixed: 'the spec releases the lock as that rule does (exitPointerLock) and checks the page\'s part: the lost lock lets go of the held movement'},
    {test: 'input-bindings.spec.mjs:17', chromium: 'pass', firefox: 'pass', note: 'play (Firefox): a tickless `wheelDeltaY` is -round(3 × `deltaY`) in Gecko, and a notch counted 2.5',
      fixed: '`wheelUnits(event, {gecko})` takes that value by the pixel rule'},
    {test: 'pointer-lock.spec.mjs:27', chromium: 'pass', firefox: 'pass', note: 'race (Chromium): the frozen state was read before the posts made before the blur landed',
      fixed: 'the frozen state is the first status the next one repeats'},
    {test: 'gameplay.spec.mjs:23', chromium: 'pass', firefox: 'pass',
      note: 'race (Chromium): `settled` took the spawn while its first ticks still moved it; the jump\'s top was missed between worker-mode statuses; the spawn\'s resting height varies with the first ticks\' frame times (-80.40 or -80.20)',
      fixed: 'settled is the simulation\'s own location unchanged over 0.1 s of its time; the jump is read from viewProbe; the reload is compared in x and y, and in z within 0.5'},
    {test: 'viewer.spec.mjs:12', chromium: 'pass', firefox: 'pass', note: 'race (Chromium): the draw calls were read before worker mode drew after Player start',
      fixed: 'it waits for a draw, and holds W until the inspection camera has moved 100 units'},
    {test: 'viewer.spec.mjs:54', chromium: 'pass', firefox: 'pass', note: 'stale: only Wasm was allowed after the folder is chosen', fixed: 'the build\'s own scripts and Wasm (same-origin GETs under /assets/) are'},
    {test: 'native-math.spec.mjs:4', chromium: 'pass', firefox: 'pass', note: 'stale: the sine table\'s hash from before entry 8192 became the hardware x87\'s', fixed: 'b8d75604..., as test/coords.test.mjs'},
    {test: 'lodmesh-wasm.spec.mjs:7', chromium: 'pass', firefox: 'pass', note: 'stale: a JavaScript pose fallback the Rust core replaced',
      fixed: 'it checks what a refused WebAssembly does now (inspection only, Play disabled, "Play mode unavailable" in the debugging page\'s notes; the default start still says nothing, 7.7.2)'},
    {test: 'runtime-error.spec.mjs:14', chromium: 'pass', firefox: 'pass', note: 'stale: a deferred Plant7.PushSound, which plays now', fixed: 'the push is Plant7\'s Location (liveProbe)'},
    {test: 'runtime-error.spec.mjs:49', chromium: 'pass', firefox: 'pass', note: 'stale: F for use, and the page\'s old use counter', fixed: 'the right mouse button, and the door\'s mover'},
    {test: 'instructor-conversation.spec.mjs:12', chromium: 'pass', firefox: 'pass', note: 'stale: it patched main.mjs source that no longer exists; F for use',
      fixed: 'rewritten on the simulation\'s probes and the right mouse button (one unexplained Chromium failure in the third run, then three passes)'},
    {test: 'training-walk.spec.mjs:12', chromium: 'pass', firefox: 'pass', note: 'stale: the same source patch; F for use',
      fixed: 'rewritten on the probes, with the player\'s place from viewProbe, a straight walk to the key and the view swept across the trainer\'s door'},
    {test: 'input-bindings-table.spec.mjs:16', chromium: 'pass', firefox: 'pass', note: 'stale: its QuickSave case expected native 3011 unimplemented', fixed: 'QuickSave runs in Play (the headless validator keeps the 3011 boundary)'},
  ],
};
for (const [name, run] of Object.entries(SUITE_RUN.browsers)) if (!run.notRun) {
  const failed = SUITE_RUN.failures.filter(f => f[name] !== 'pass');
  if (failed.some(f => !SUITE_CAUSES[f[name]])) throw new Error(`stage7-criteria: a ${name} failure has no cause`);
  if (run.passed + failed.length !== SUITE_RUN.tests) throw new Error(`stage7-criteria: ${name} counts ${run.passed} + ${failed.length} != ${SUITE_RUN.tests}`);
}

/** The suite run as the note's section of that name (`--suite`). */
function suiteMarkdown() {
  const cell = text => String(text ?? '').replaceAll('|', '\\|');
  const names = Object.keys(SUITE_RUN.browsers), ran = names.filter(n => !SUITE_RUN.browsers[n].notRun);
  const lines = [`## The browser suite by browser\n`, `Last run ${SUITE_RUN.date} on ${SUITE_RUN.machine}, ${SUITE_RUN.tests} tests a browser, one worker. ${SUITE_RUN.rerun}:\n`];
  for (const n of names) {
    const b = SUITE_RUN.browsers[n];
    if (b.notRun) { lines.push(`- ${n}: not run. ${b.notRun}.`); continue; }
    const count = {};
    for (const f of SUITE_RUN.failures) if (f[n] !== 'pass') count[f[n]] = (count[f[n]] ?? 0) + 1;
    const causes = Object.entries(count).map(([c, k]) => `${k} ${c}`).join(', ');
    lines.push(`- ${n} ${b.version} (${b.sim} mode): ${b.passed} pass, ${SUITE_RUN.tests - b.passed} fail${causes ? ` (${causes})` : ''}, ${b.minutes} min.`);
  }
  lines.push('', `Causes: ${Object.entries(SUITE_CAUSES).map(([c, text]) => `**${c}**, ${text}`).join('; ')}. A test not listed passed in every browser that ran.`, '');
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
