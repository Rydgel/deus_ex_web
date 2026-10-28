/** The Stage 7 criteria as data (docs/stage-7-exit-criteria.md, adopted by the user on 2026-10-28): one row per criterion of the roadmap's
 * section 7 "Done when". `node scripts/stage7-criteria.mjs` prints the scoreboard, `--list` the rows, `--markdown` the tables of the note
 * (which are generated from here).
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
  weak: 'the suite is Chromium-only and headless; no whole-suite pass is recorded since Stage 6; the Mac has not run it since early October'});
add('7.1.2', 'Chrome, Linux, worker mode', 'H', 'PARTIAL', {decision: 'D1', proof: ['the same'], machine: LINUX, weak: 'as 7.1.1, on this host'});
add('7.1.3', 'Firefox, macOS and Linux, inline mode', 'H', 'PARTIAL', {decision: 'D1', machine: `${MAC}, ${LINUX}`,
  proof: ['the suite with a Firefox project', 'validate-inline-restore-play', 'validate-context-loss-play --browser firefox'],
  need: 'a Firefox project in playwright.config; only two validators run in Firefox today (Linux)'});
add('7.1.4', 'Safari, macOS', 'H', 'MISSING', {decision: 'D1', machine: MAC,
  proof: ['the suite under Playwright\'s WebKit as a stand-in', 'the session in real Safari (by hand or safaridriver)'],
  need: 'never run; Safari\'s storage eviction, no Keyboard Lock, no `showDirectoryPicker`'});

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
  {machine: ALL, proof: ['browser-tests/pointer-lock.spec.mjs'], weak: 'Chromium only'});
add('7.6.2', 'Alt+Enter toggles fullscreen; Escape and F11 behave as [input bindings](input-bindings.md) states with Keyboard Lock (Chromium) and without (Firefox, Safari)', 'O, H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/original-start-input.spec.mjs'], weak: 'Chromium only'});
add('7.6.3', 'resizing the window, changing the device pixel ratio or moving to another screen keeps the 4:3 picture, the HUD, mirrors and the frame keeper correct, with no runtime error', 'H', 'MISSING',
  {machine: `${LINUX}, ${MAC}`, proof: ['a new spec: resizes during Play, pixels against a fresh load at the final size'], need: 'the spec; nothing tests a resize during Play'});
add('7.6.4', 'a hidden tab or system sleep pauses Play; the game resumes on a click with no catch-up and the audio follows', 'H', 'PARTIAL',
  {machine: ALL, proof: ['pointer-lock.spec.mjs (blur)', 'a hidden-tab spec'], weak: 'blur is tested; `visibilitychange` is not'});

// 7.7 Graphics capability and failures --------------------------------------------------------------------------------------------------
add('7.7.1', 'a lost WebGL context freezes Play and restores it as D3DDrv\'s `Lock` does; the frames after equal a run with no loss', 'O', 'PASS',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs (Chromium worker and inline, Firefox)'], weak: 'Safari, and the Mac, not run'});
add('7.7.2', 'no WebGL2, a context creation error or a missing extension: the page says what is missing instead of a dead canvas, and the GPU mesh path falls back', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec with WebGL disabled (`--disable-webgl`), and one with `EXT_color_buffer_float` refused'],
    need: 'a creation error is not handled (only the GPU mesh\'s missing extensions are)'});
add('7.7.3', 'a software renderer (SwiftShader, llvmpipe) keeps the CPU mesh path and stays playable', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['the headless default (SwiftShader) runs'], weak: 'no validator asserts the path; "playable" has no bound on a software renderer'});

// 7.8 Files and storage -----------------------------------------------------------------------------------------------------------------
add('7.8.1', 'the game folder opens through the gate\'s picker in every supported browser', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/viewer.spec.mjs'], weak: 'Chromium headless only'});
add('7.8.2', 'saves in browser storage in every supported browser; `persist()` asked once; a refused or full store is said and the game keeps running', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/save-game.spec.mjs', 'save-folder.spec.mjs', 'test/save-store.test.mjs', 'test/save-persistence.test.mjs'],
    weak: 'Chromium only; the unit tests use a fake store'});
add('7.8.3', 'in Chromium, a Save folder picked on disk keeps its grant across visits and writes slots the desktop game loads', 'H, O', 'MISSING',
  {machine: `${MAC}, ${LINUX}`, proof: ['save-folder.spec.mjs headed with a real folder', 'validate-save-game.mjs'],
    need: '[save storage](save-storage.md) says a headed Chromium with a real folder was not run'});
add('7.8.4', 'settings persist across reloads in every supported browser (row 6.1.5\'s proof)', 'O', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/config-persistence.spec.mjs', 'validate-config-persistence.mjs'], weak: 'Chromium only'});

// 7.9 Failure recovery ------------------------------------------------------------------------------------------------------------------
add('7.9.1', 'a runtime error pauses Play with its message, and Player start or a reload recovers', 'H', 'PARTIAL',
  {machine: ALL, proof: ['browser-tests/runtime-error.spec.mjs'], weak: 'Chromium only'});
add('7.9.2', 'the simulation worker fails (an exception, out of memory, a terminated worker): the page says so and offers a reload or the last save, with nothing written half', 'H', 'MISSING',
  {machine: LINUX, proof: ['a spec that terminates the worker and one that throws in it'],
    need: '`onFailure` pauses with the error, but no test exists, and what an out-of-memory worker does is unknown'});
add('7.9.3', 'a graphics device that never comes back: the page says so, and a reload recovers', 'H', 'PARTIAL',
  {machine: LINUX, proof: ['validate-context-loss-play.mjs with no restore'], weak: 'the toast exists ([context loss](context-loss.md)); not tested'});

// 7.10 Regression coverage --------------------------------------------------------------------------------------------------------------
add('7.10.1', 'the validator sweep passes on the closing commit (`npm run validate -- --jobs 4`)', 'P', 'FAIL',
  {machine: `${LINUX}, with the Mac's stores`, proof: ['run-validators.mjs'],
    weak: 'fails: six reds on a clean head on 2026-10-27 (host-services-play, world-batch-gpu, texture-sampling, lodmesh-lod-play, master-frame-play, conversations-census timeout)'});
add('7.10.2', 'the browser suite passes in every supported browser', 'P', 'MISSING',
  {machine: `${MAC}, ${LINUX}`, proof: ['`npx playwright test` with a project per browser'], need: 'projects for Firefox and WebKit; the suite\'s whole-run result is not recorded'});
add('7.10.3', 'the Stage 4, 5 and 6 gates pass on the closing commit', 'P, O', 'MISSING',
  {machine: `${LINUX}, ${MAC}`, proof: ['validate-stage4-acceptance.mjs', 'validate-stage5-acceptance.mjs', 'stage6-criteria.mjs'],
    need: 'a run on one commit (last runs: Stage 4 on 2026-10-17, Stage 5 on 2026-10-21, Stage 6\'s rows by 2026-10-26)'});

// 7.11 Excluded -------------------------------------------------------------------------------------------------------------------------
const excluded = (id, claim, reason) => add(id, claim, '-', 'EXCLUDED', {excluded: reason});
excluded('7.11.1', 'multiplayer', 'the last priority (AGENTS.md)');
excluded('7.11.2', 'mobile and touch browsers', 'the game takes a keyboard and a mouse');
excluded('7.11.3', 'Windows', 'no Windows machine (D1); Chrome\'s engine rows stand in for Chrome and Edge there, unmeasured');

for (const row of CRITERIA) if (!STATUSES.includes(row.status)) throw new Error(`stage7-criteria: ${row.id} has status ${row.status}`);

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
  // --markdown: the row tables of docs/stage-7-exit-criteria.md, one per clause
  if (process.argv.includes('--markdown')) for (const [c, name] of Object.entries(CLAUSES)) {
    const cell = text => String(text ?? '').replaceAll('|', '\\|');
    const decisions = [...new Set(CRITERIA.filter(row => row.clause === Number(c)).map(row => row.decision).filter(Boolean))];
    console.log(`\n### 7.${c} ${name}${decisions.length ? ` (${decisions.join(', ')})` : ''}\n\n| Row | Criterion | Kind | Proof | Machine | Needed / weak | Status |\n| --- | --- | --- | --- | --- | --- | --- |`);
    for (const row of CRITERIA.filter(row => row.clause === Number(c)))
      console.log(`| ${row.id} | ${cell(row.claim)} | ${row.kind} | ${cell(row.proof.join(', ') || '-')} | ${cell(row.machine)} | ${cell([row.need && `needed: ${row.need}`, row.weak && (row.status === 'FAIL' ? row.weak : `weak: ${row.weak}`), row.excluded].filter(Boolean).join('; ') || '-')} | ${row.status} |`);
  }
}
