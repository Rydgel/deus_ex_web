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
  weak: 'the suite on 2026-10-28: 30 of 41 pass (with the reruns after that day\'s fixes); of the 11 failures 8 are stale specs, 2 races of a spec with worker mode and 1 Playwright\'s synthetic Escape; the 7.x validators are not run as a set'});
add('7.1.3', 'Firefox, macOS and Linux, inline mode', 'H', 'PARTIAL', {decision: 'D1', machine: `${MAC}, ${LINUX}`,
  proof: ['the suite, `--project firefox`', 'validate-inline-restore-play', 'validate-context-loss-play --browser firefox'],
  weak: 'the suite on 2026-10-28 (Linux): 25 of 41 pass once the two Play bugs it found were fixed (the wheel counted a notch 2.5 times; the default start\'s Saves and CRT buttons never showed in inline mode); of the 16 failures 8 are stale specs, 7 Playwright\'s synthetic input (the menus\' cursor under the pointer lock, Escape) and 1 Chromium\'s Keyboard Lock, so the saving, loading and menu paths are not covered in Firefox. The Mac not run'});
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
    weak: 'measured on Linux only (after 2026-10-27, one roam: draw gap p99 16.8 ms, one 26 ms worker GC); not on the Mac'});
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
add('7.6.1', 'the pointer lock is taken on the first click, Escape releases it, and a lost lock or a blur pauses Play and resumes without catch-up', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/pointer-lock.spec.mjs'],
    weak: 'a blur freezes Play and it resumes without catch-up in Chrome\'s worker mode and Firefox\'s inline mode (2026-10-28, Linux); the Escape half cannot run under Playwright (a synthetic Escape does not reach the browser\'s release of the lock); WebKit and the Mac not run'});
add('7.6.2', 'Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari)', 'O, H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/original-start-input.spec.mjs', 'input-bindings.spec.mjs'],
    weak: 'passes in Chromium; in Firefox the spec cannot drive the menu (Playwright\'s pointer-lock motion) and the Keyboard Lock check is Chromium\'s API; Firefox\'s fullscreen without it has no check'});
add('7.6.3', 'resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error', 'H', 'MISSING',
  {machine: `${LINUX}, ${MAC}`, proof: ['a new spec: resizes during Play, pixels against a fresh load at the final size'], need: 'the spec; nothing tests a resize during Play'});
add('7.6.4', 'a hidden tab or system sleep pauses Play; the game resumes on a click with no catch-up and the audio follows', 'H', 'PARTIAL',
  {machine: ALL, proof: ['pointer-lock.spec.mjs (blur)', 'a hidden-tab spec'], weak: 'blur is tested; `visibilitychange` is not'});

// 7.7 Graphics capability and failures --------------------------------------------------------------------------------------------------
add('7.7.1', 'a lost WebGL context freezes Play and restores it as D3DDrv\'s `Lock` does; the frames after equal a run with no loss', 'O', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs (Chromium worker and inline, Firefox)'], weak: 'Safari, and the Mac, not run'});
add('7.7.2', 'no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec with WebGL disabled (`--disable-webgl`), and one with `EXT_color_buffer_float` refused'],
    need: 'a creation error is not handled (only the GPU mesh\'s missing extensions are); with WebAssembly refused the page stays in inspection and says nothing (lodmesh-wasm.spec, 2026-10-28)'});
add('7.7.3', 'a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['the headless default (SwiftShader) runs'], weak: 'no validator asserts the path; "playable" has no bound on a software renderer'});

// 7.8 Files and storage -----------------------------------------------------------------------------------------------------------------
add('7.8.1', 'the game folder opens through the gate\'s picker in every supported browser', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/viewer.spec.mjs'],
    weak: 'the picker opens the folder in Chromium and Firefox headless (`setInputFiles`, 2026-10-28); the spec\'s request rule is stale, a real picker is not run'});
add('7.8.2', 'saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/save-game.spec.mjs', 'save-folder.spec.mjs', 'test/save-store.test.mjs', 'test/save-persistence.test.mjs'],
    weak: 'passes in Chromium; in Firefox the Saves window imports and exports (save-folder.spec.mjs:212), but the specs that save or load stop at a menu button the cursor cannot reach under Playwright\'s pointer lock; the unit tests use a fake store'});
add('7.8.3', 'in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads', 'H, O', 'MISSING',
  {machine: `${MAC}, ${LINUX}`, proof: ['save-folder.spec.mjs headed with a real folder', 'validate-save-game.mjs'],
    need: '[save storage](save-storage.md) says a headed Chromium with a real folder was not run'});
add('7.8.4', 'settings persist across reloads in every supported browser (row 6.1.5\'s proof)', 'O', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/config-persistence.spec.mjs', 'validate-config-persistence.mjs'],
    weak: 'the spec passes in Chromium and Firefox on Linux (2026-10-28); WebKit and the Mac not run'});

// 7.9 Failure recovery ------------------------------------------------------------------------------------------------------------------
add('7.9.1', 'a runtime error pauses Play with its message, and Player start or a reload recovers', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/runtime-error.spec.mjs'],
    weak: 'the spec is stale in every browser (it waits for a deferred push sound nothing records now, and uses F to open a door)'});
add('7.9.2', 'the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec that terminates the worker and one that throws in it'],
    need: '`onFailure` pauses with the error, but no test exists, and what an out-of-memory worker does is unknown'});
add('7.9.3', 'a graphics device that never comes back: the page says so, and a reload recovers', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs with no restore'], weak: 'the toast exists ([context loss](context-loss.md)); not tested'});

// 7.10 Regression coverage --------------------------------------------------------------------------------------------------------------
add('7.10.1', 'the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`)', 'P', 'FAIL',
  {machine: `${LINUX}, with the Mac's stores`, proof: ['run-validators.mjs'],
    weak: 'fails: six reds on a clean head on 2026-10-27 (host-services-play, world-batch-gpu, texture-sampling, lodmesh-lod-play, master-frame-play, conversations-census timeout)'});
add('7.10.2', 'the browser suite passes in every supported browser', 'P', 'FAIL',
  {machine: `${MAC}, ${LINUX}`, proof: ['`npx playwright test` (projects chromium, firefox, webkit)', 'SUITE_RUN, `--suite`'],
    weak: 'fails: on 2026-10-28 (Linux) Chromium 30 of 41, Firefox 25 of 41 (with the reruns after that day\'s fixes); WebKit runs on the Mac only'});
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
  date: '2026-10-28', machine: 'the Linux host (AMD, Arch), headless but pointer-lock.spec', tests: 41,
  rerun: 'After the fixes of the same day the specs they touch ran again in both browsers (input-bindings, input-bindings-table, load-game, save-folder, pointer-lock.spec:15); the counts and causes include those reruns',
  browsers: {
    chromium: {version: '153.0.8010.12', sim: 'worker', passed: 30, minutes: 23.9},
    firefox: {version: '155.0', sim: 'inline', passed: 25, minutes: 49.4},
    webkit: {notRun: 'Playwright\'s Linux WebKit needs Ubuntu\'s libraries (ICU 74, libxml2.so.2, flite); it runs on the Mac'},
  },
  failures: [
    {test: 'gameplay.spec.mjs:9', chromium: 'race', firefox: 'pass',
      note: '`settled` takes the first grounded snapshot after a load, which in worker mode can be the spawn at z -82.50, a tick before the walk lifts it to -80.20 (the suite failed at the crouch, a rerun at the reload)'},
    {test: 'input-bindings-table.spec.mjs:16', chromium: 'stale', firefox: 'stale',
      note: 'its GreyPlus case (scripts/input-binding-cases.mjs) still expects QuickSave to stop at native 3011, which Stage 6 implemented (Firefox stopped first at the wheel until the wheel fix)'},
    {test: 'input-bindings.spec.mjs:17', chromium: 'pass', firefox: 'pass',
      note: 'Firefox: without the platform\'s wheel ticks, `wheelDeltaY` is -round(3 × `deltaY`) (Gecko\'s WheelEvent.cpp; -300 for Playwright\'s 100-pixel notch, where Chromium gives -120), and wheel-input.mjs took it for ticks: a notch counted 2.5 and the belt moved two items',
      fixed: 'in Firefox that exact value takes the pixel rule (`wheelUnits(event, {gecko})`); a real wheel in Firefox is not measured'},
    {test: 'input-bindings.spec.mjs:104', chromium: 'pass', firefox: 'api',
      note: 'Keyboard Lock (`navigator.keyboard.lock`) is Chromium\'s; Firefox\'s fullscreen without it needs its own expectation ([input bindings](input-bindings.md))'},
    {test: 'instructor-conversation.spec.mjs:4', chromium: 'stale', firefox: 'stale',
      note: 'uses F, the use key before 87926c9e; DefUser.ini binds F to CenterView and RightMouse to use'},
    {test: 'load-game.spec.mjs:60', chromium: 'pass', firefox: 'harness',
      note: 'the default start\'s Saves and CRT buttons never showed in inline mode (main.mjs `placePageButtons` read only the worker\'s `windowGrab`); with them it imports the slots and stops at the Load Game screen, whose Load button the menu cursor does not reach (original-start-input.spec.mjs:13)',
      fixed: 'the buttons: the inline game answers `windowMouseGrabbed` itself'},
    {test: 'lodmesh-wasm.spec.mjs:3', chromium: 'stale', firefox: 'stale',
      note: 'checks the JavaScript pose fallback for a refused WebAssembly, which the Rust core replaced; with Wasm refused the page stays in inspection and says nothing (row 7.7.2)'},
    {test: 'native-math.spec.mjs:3', chromium: 'stale', firefox: 'stale',
      note: 'expects the sine table\'s hash from before entry 8192 became the hardware x87\'s ([fitting](fitting.md), 2026-10-18); test/coords.test.mjs holds the current b8d75604...'},
    {test: 'original-start-input.spec.mjs:13', chromium: 'pass', firefox: 'harness',
      note: 'the original menus\' cursor follows relative motion; under Playwright\'s Firefox pointer lock `movementX/Y` is a synthetic point\'s offset from a fixed point (-465 for a 25-pixel step), so the cursor never reaches Training. A real mouse in Firefox is not measured'},
    {test: 'original-start-load-game.spec.mjs:11', chromium: 'pass', firefox: 'harness', note: 'the same motion: the click lands off Load Game'},
    {test: 'pointer-lock.spec.mjs:5', chromium: 'harness', firefox: 'harness',
      note: 'the browser\'s own Escape rule releases the lock, and a synthetic Escape does not reach it (original-start-input.spec.mjs\'s note)'},
    {test: 'pointer-lock.spec.mjs:15', chromium: 'pass', firefox: 'pass',
      note: 'worker mode: the frozen state was read too early, not a Play bug. The posts made before the blur (their time before it) land after it, and the game status comes with every 15th post; the simulation\'s own Level.TimeSeconds ran 66.6 ms of those posts after the blur and then stopped, since every later post says `run: false`',
      fixed: 'the spec takes the frozen state as the first status the next one repeats'},
    {test: 'runtime-error.spec.mjs:11', chromium: 'stale', firefox: 'stale',
      note: 'waits for Plant7.PushSound among the deferred effects; nothing records it there now'},
    {test: 'runtime-error.spec.mjs:48', chromium: 'stale', firefox: 'stale', note: 'uses F to open the first door'},
    {test: 'save-folder.spec.mjs:165', chromium: 'pass', firefox: 'harness',
      note: 'the Saves button in inline mode (load-game.spec.mjs:60); with it the folder\'s saves list with their pictures, and the Load button is not reached', fixed: 'the buttons'},
    {test: 'save-folder.spec.mjs:212', chromium: 'pass', firefox: 'pass', note: 'the Saves button in inline mode', fixed: 'the buttons'},
    {test: 'save-game.spec.mjs:63', chromium: 'pass', firefox: 'harness', note: 'the menu cursor\'s motion (original-start-input.spec.mjs:13): Training is never clicked'},
    {test: 'save-game.spec.mjs:178', chromium: 'pass', firefox: 'harness', note: 'the same'},
    {test: 'training-walk.spec.mjs:4', chromium: 'stale', firefox: 'stale',
      note: 'uses F to open the doors, and its fixture patches main.mjs\'s source to read the page\'s `game`, which worker mode keeps in the worker'},
    {test: 'viewer.spec.mjs:11', chromium: 'race', firefox: 'pass',
      note: 'reads the draw calls right after Player start, before worker mode draws again (0; 1835 a frame later)'},
    {test: 'viewer.spec.mjs:50', chromium: 'stale', firefox: 'stale',
      note: 'allows only Wasm after the folder is chosen; the simulation worker and the lazy modules load then too (35 scripts in Chromium, 2 in Firefox), all same-origin GETs, which is the rule that matters'},
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
    lines.push(`- ${n} ${b.version} (${b.sim} mode): ${b.passed} pass, ${SUITE_RUN.tests - b.passed} fail (${Object.entries(count).map(([c, k]) => `${k} ${c}`).join(', ')}), ${b.minutes} min.`);
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
