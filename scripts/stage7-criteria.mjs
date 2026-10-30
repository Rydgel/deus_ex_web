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
    need: 'a Mac measurement. Indicative: the Island\'s worker frame p50 12.2 ms on Linux (2026-10-27)'});
add('7.2.2', 'every supported browser: drawn-frame interval p95 ≤ 16.7 ms on the frame-time set (with 0.5 ms for the frame timestamps\' jitter)', 'H', 'MISSING',
  {decision: 'D2', machine: MAC, proof: ['frame-time-set.mjs --browser B, headed (hitch-run.mjs --headed)'],
    need: 'a headed run per browser. Indicative: Firefox inline draws 43 to 45 fps on the Island on Linux'});
add('7.2.3', 'Chrome: from a map\'s first 5 s on, no drawn-frame gap over 100 ms in a 120 s roam', 'H', 'PARTIAL',
  {machine: MAC, proof: ['hitch-run.mjs --mode roam --seconds 120', 'hitch-summary.mjs'],
    weak: 'Linux only: with all cores, no gap over 100 ms on the Island and WanChai Underworld; pinned to two cores (a loaded machine, where the user feels it on the Mac) 2 to 4 gaps over 100 ms a run, up to 350 ms, each the worker\'s major GC (2026-10-28, docs/live-heap.md); not on the Mac'});
add('7.2.4', 'Firefox inline: from a map\'s first 5 s on, no gap over 150 ms and at most two over 50 ms a minute (D3)', 'H', 'FAIL',
  {decision: 'D3', machine: `${MAC}, ${LINUX}`, proof: ['hitch-ab.mjs or hitch-run.mjs --browser firefox', 'hitch-summary.mjs'],
    weak: 'fails today: 26 to 31 gaps over 50 ms and 6 to 8 over 90 ms in 65 s from 40 s after the map, longest 133 ms (Linux, 2026-10-28); the work is the parked live-heap plan'});
add('7.2.5', 'no shader program is compiled during play after a load', 'P', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['hitch-summary.mjs (programs created from 5 s on) over the frame-time set'],
    weak: '0 programs measured on the Island, Airfield and UNATCO HQ (Chrome) and the Island (Firefox), on Linux; the Mac is not measured'});

// 7.3 Loading time (D4) -----------------------------------------------------------------------------------------------------------------
add('7.3.1', 'navigation to the logo map\'s first frame ≤ 10 s (Chrome and Firefox)', 'H', 'MISSING',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs (the first map from navigation)'],
    need: 'a measurement of the original start, not of `?debug=1` Training'});
add('7.3.2', 'a travel arrival\'s first frame ≤ 5 s in Chrome, ≤ 10 s in Firefox, for every single-player map', 'H', 'PARTIAL',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs --travel, as a census over the 83 maps'],
    weak: 'measured for the Island (4.6 s) and Training (1.5 s) in Chrome only'});
add('7.3.3', 'Load Game to the first frame ≤ 8 s', 'H', 'MISSING',
  {decision: 'D4', machine: MAC, proof: ['profile-map-load.mjs over the internet save corpus\'s slots'], need: 'the measurement; no tool times a load from a save'});

// 7.4 Memory and long sessions (D5) -----------------------------------------------------------------------------------------------------
add('7.4.1', 'ten Island and Training round trips in one process: the same state at each arrival, flat package memory, a bounded heap slope', 'P', 'PARTIAL',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-process-memory.mjs (by hand)', 'the same sequence in the page'],
    weak: 'passes in Node, which has no page, worker, GPU or audio; the browser\'s page and worker heaps are not measured over map changes'});
add('7.4.2', 'each map of the frame-time set stays within a declared memory budget (page plus worker, after GC)', 'H', 'MISSING',
  {machine: MAC, proof: ['profile-live-heap.mjs', 'profile-firefox-memory.mjs'],
    need: 'the budget, to fit a 16 GB machine; today the Island\'s worker reaches 1.4 GB before a GC in Chrome'});
add('7.4.3', 'the one-hour session (D5) in Chrome and Firefox', 'H', 'MISSING', {decision: 'D5', machine: MAC, proof: ['a session harness'], need: 'the harness'});

// 7.5 Audio (D6) ------------------------------------------------------------------------------------------------------------------------
add('7.5.1', 'sound and music start on the first gesture, and resume after a hidden tab or a suspended context, in every supported browser', 'H', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['validate-galaxy-music-play.mjs', 'a browser spec'], weak: 'Chromium only; suspension and resume are not checked'});
add('7.5.2', 'a sound\'s latency from PlaySound to output ≤ the original\'s plus one render quantum (D6)', 'O', 'MISSING',
  {decision: 'D6', machine: `${MAC}, ${LINUX}`, proof: ['a Wine measurement of the original', '`AudioContext.outputLatency` plus the worklet\'s queue in Play'],
    need: 'the original\'s measurement; Play\'s is not measured'});

// 7.6 Window and input ------------------------------------------------------------------------------------------------------------------
add('7.6.1', 'the pointer lock is taken on the first click; one Escape releases it and reaches the game (MenuMain); a lost lock or a blur lets go of the held input and Play goes on (no pause, the user\'s choice 2026-10-30); a hidden page resumes without catch-up', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/pointer-lock.spec.mjs', 'browser-tests/original-start-input.spec.mjs'],
    weak: 'Chrome\'s worker mode, headless, Linux (2026-10-30): the browser\'s Escape rule played as its call (exitPointerLock, no key) opens MenuMain once, a delivered key as well counts once, the free mouse drives the menu; a blur lets go of the held movement and the level\'s clock goes on; a real Escape is not exercised under Playwright (the user saw two presses needed on Chrome Linux and macOS before the change); the hidden-page resume is not tested; Firefox not rerun; WebKit and the Mac not run'});
add('7.6.2', 'Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari)', 'O, H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/original-start-input.spec.mjs', 'input-bindings.spec.mjs'],
    weak: 'passes in Chromium and Firefox on Linux (2026-10-28): Keyboard Lock where the browser has it, and in Firefox Alt+Enter takes the fullscreen and the pointer without it (the pointer asked again at fullscreenchange, which Firefox needs); a held Escape and F11 in a real browser are not exercised; WebKit and the Mac not run'});
add('7.6.3', 'resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error', 'H', 'MISSING',
  {machine: `${LINUX}, ${MAC}`, proof: ['a new spec: resizes during Play, pixels against a fresh load at the final size'], need: 'the spec; nothing tests a resize during Play'});
add('7.6.4', 'a hidden tab or system sleep pauses Play; the game resumes on a click with no catch-up and the audio follows', 'H', 'PARTIAL',
  {machine: ALL, proof: ['pointer-lock.spec.mjs (blur)', 'a hidden-tab spec'], weak: 'blur is tested; `visibilitychange` is not'});

// 7.7 Graphics capability and failures --------------------------------------------------------------------------------------------------
add('7.7.1', 'a lost WebGL context freezes Play and restores it as D3DDrv\'s `Lock` does; the frames after equal a run with no loss', 'O', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs (Chromium worker and inline, Firefox)'], weak: 'Safari, and the Mac, not run'});
add('7.7.2', 'no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec with WebGL disabled (`--disable-webgl`), and one with `EXT_color_buffer_float` refused'],
    need: 'a creation error is not handled (only the GPU mesh\'s missing extensions are); with WebAssembly refused the map loads for inspection and only the debugging page\'s notes say why ("Play mode unavailable: Failed to fetch"), the default start nothing (lodmesh-wasm.spec, 2026-10-28)'});
add('7.7.3', 'a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['the headless default (SwiftShader) runs'], weak: 'no validator asserts the path; "playable" has no bound on a software renderer'});

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
add('7.9.2', 'the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec that terminates the worker and one that throws in it'],
    need: '`onFailure` pauses with the error, but no test exists, and what an out-of-memory worker does is unknown'});
add('7.9.3', 'a graphics device that never comes back: the page says so, and a reload recovers', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs with no restore'], weak: 'the toast exists ([context loss](context-loss.md)); not tested'});

// 7.10 Regression coverage --------------------------------------------------------------------------------------------------------------
add('7.10.1', 'the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`)', 'P', 'FAIL',
  {machine: `${LINUX}, with the Mac's stores`, proof: ['run-validators.mjs'],
    weak: 'fails: six reds on a clean head on 2026-10-27 (host-services-play, world-batch-gpu, texture-sampling, lodmesh-lod-play, master-frame-play, conversations-census timeout)'});
add('7.10.2', 'the browser suite passes in every supported browser', 'P', 'PARTIAL',
  {machine: `${MAC}, ${LINUX}`, proof: ['`npx playwright test` (projects chromium, firefox, webkit)', 'SUITE_RUN, `--suite`'],
    weak: 'Chromium and Firefox 41 of 41 on Linux (2026-10-28, with two Chromium reruns); WebKit and the Mac not run'});
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
