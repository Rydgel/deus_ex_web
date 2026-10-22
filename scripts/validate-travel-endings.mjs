/** The main menu's Play Intro and Credits, the DXOnly level and the three endings in Play against the measured original (docs/travel.md "Play, step 5"),
 * headless.
 *
 * The original under Wine (scripts/travel-probe.sh; `.work/travel/ep1` to `ep8`, outside Git) is the reference: the logo map's MenuMain, Play Intro, the
 * intro left by Escape in its conversation (ep2) or by its own end (ep1), the `dxonly` level and the menu a click opens there, Credits run to their end
 * (ep1) or ended by a click (ep2), the Quotes window (ep5, cheats on), and the three endings entered by `LocalTravel 99_Endgame1..3` from a directly
 * opened `15_Area51_Final`/`15_Area51_Page` (ep3, ep4, ep5; the original's `open` leaves the FlagBase empty, so Play's marker is removed first) run to their
 * credits, a click and `dxonly`, then the menu. Play drives the same scripts: MenuMain.winButtons[5] -> ShowIntro, MissionIntro, PostIntro -> SendPlayer
 * "dxonly"; DeusExPlayer.TravelPostAccept's DXOnly hack (Paralyzed); Paralyzed.Fire -> ShowMainMenu; winButtons[6] -> CreditsWindow; MissionEndgame
 * (InitStateMachine, FirstFrame's conversation, Timer, PrintEndgameQuote, FinishCinematic -> ShowCredits(True)); CreditsWindow.DestroyWindow ->
 * SendPlayer "dxonly".
 *
 * Checked per scenario (each is its own process: a scenario's level sessions are not freed):
 *   - every travel text the original's engine exported (00_Intro, dxonly, the endgame, the dxonly after it) equals Play's after normalization;
 *   - the arrival flags and the flag sets over the ending's time (the measured snapshots appear in Play's sequence, in order);
 *   - the engine log's modelled lines, in the original's order, from the Export travel of the level left to the end of the dxonly arrival;
 *   - the windows: the menu a click opens on dxonly, the Credits window and its end, the Quotes window.
 * Not compared (named in docs/travel.md): the conversation's length in level time (Play's is 2 to 8 s longer than the captures'), the Galaxy/DevMusic
 * and window-host log lines (modelled in their own validators), ScriptWarning lines.
 *
 * Scenarios: P (Play Intro, Escape, DXOnly, Credits), N (the intro's own end), C (Credits to their end), E1 E2 E3 (the endings), T1 T2 T3 (the conversations' length at the capture's frame
 * time), M1 M2 M3 (the endgame MapExits as their triggers fire them), W (the ending with bQuotesEnabled), X (Escape in the Endgame1 conversation), Q (the Quotes window).
 *
 * runner-timeout: 2400
 *
 *   node scripts/validate-travel-endings.mjs [--only P|N|C|E1|E2|E3|T1|T2|T3|M1|M2|M3|W|X|Q] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { viewProbe } from '../src/viewer/view-probe.mjs';
import { travelTextOfDump, firstTravelTextDifference, parseTravelText } from '../src/runtime/travel-text.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
if (!only) {
  const { spawnSync } = await import('node:child_process');
  const argv = process.argv.slice(2);
  let status = 0;
  for (const id of ['P', 'N', 'C', 'E1', 'E2', 'E3', 'T1', 'T2', 'T3', 'M1', 'M2', 'M3', 'W', 'X', 'Q']) {
    const run = spawnSync(process.execPath, [process.argv[1], '--only', id, ...argv], { stdio: 'inherit' });
    if (run.status !== 0) status = run.status ?? 1;
  }
  process.exit(status);
}
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-endings: no installed game data'); process.exit(0); }
const captureRoot = new URL('../.work/travel/', import.meta.url).pathname;
const CAPTURED = { P: 'ep2', N: 'ep1', C: 'ep1', E1: 'ep3', E2: 'ep4', E3: 'ep5', T1: 'ep3', T2: 'ep4', T3: 'ep5', M1: 'ep3', M2: 'ep4', M3: 'ep5', W: 'ep11', X: 'ep7', Q: 'ep5' };
if (!existsSync(`${captureRoot}${CAPTURED[only]}/final.log`)) { console.log(`SKIP validate-travel-endings ${only}: the measured captures are not in .work/travel/${CAPTURED[only]} (outside Git)`); process.exit(0); }

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(`${only}: ${message}`); return ok; };
const TIMES = { times: true };

// --- the measured captures ---------------------------------------------------------------------------------------------------------------
const measuredText = async (dir, name) => travelTextOfDump(await readFile(`${captureRoot}${dir}/${name}.travel.txt`, 'utf8'));
/** `flag <name> type <t> expiration <e> value <v>` lines -> `name=value@expiration` (the value of every type, bools as 0/1), sorted, and the default expiration. */
async function measuredFlags(dir, name) {
  const lines = (await readFile(`${captureRoot}${dir}/${name}.flags.txt`, 'utf8')).split(/\r?\n/);
  const header = /defaultExpiration (\d+)/.exec(lines[0]);
  const flags = [];
  for (const line of lines) {
    const m = /^\s+flag (\S+) type (\d+) expiration (\d+) value (0x[0-9a-f]+)/.exec(line);
    if (m) flags.push(`${m[1]}=${Number(m[4])}@${m[3]}`);
  }
  return { flags: flags.sort(), defaultExpiration: header ? Number(header[1]) : null };
}
const MODELLED = /^(Log: (Export travel for|Browse:|Doing load, not loadgame|Current mission number|Attempting to get player|Unloading: Package (DX|00_Intro|dxonly|15_Area51_\w+|99_endgame\w+)$|LoadMap:|Game class is|Bringing Level|Spawning new actor|Possessed PlayerPawn)|ScriptLog: (InitGame|Base Mutator|DeusExLevelInfo - Spawned new mission script|Login:|All inventory|\*\*\*\* InitStateMachine)|Init: Initialized moving brush tracker)/i;
const normalizeLine = line => line.replace(/\b(JCDentonMale|Mutator|WindowsViewport)\d+\b/g, '$1#').replace(/\s+$/, '');
/** The measured session log's modelled lines from the `Export travel for` that precedes the first `Browse:` line matching `fromBrowse`, to the first line
 * matching `until` (inclusive). */
async function measuredLog(dir, fromBrowse, until) {
  const lines = (await readFile(`${captureRoot}${dir}/final.log`, 'utf8')).split(/\r?\n/);
  const browse = lines.findIndex(line => fromBrowse.test(line));
  assert.ok(browse > 0, `${dir}/final.log has no ${fromBrowse}`);
  const start = lines.lastIndexOf('Log: Export travel for: Player', browse);
  assert.ok(start >= 0 && start >= browse - 2, `${dir}/final.log: no Export travel before ${fromBrowse}`);
  let end = lines.findIndex((line, i) => i > browse && until.test(line));
  assert.ok(end > browse, `${dir}/final.log has no ${until} after the Browse`);
  return lines.slice(start, end + 1).filter(line => MODELLED.test(line)).map(normalizeLine);
}
/** Play's modelled lines: the level left (from its last Export travel), then each arrived level's log, to the line matching `until` (inclusive). */
function playLog(left, arrived, until) {
  const from = left.lastIndexOf('Log: Export travel for: Player');
  const lines = [...left.slice(from), ...arrived.flat()];
  const end = lines.findIndex((line, i) => i > 0 && until.test(line));
  return lines.slice(0, end < 0 ? lines.length : end + 1).filter(line => MODELLED.test(line)).map(normalizeLine);
}

// --- Play ------------------------------------------------------------------------------------------------------------------------------------
const typed = (c, line) => c.game.hud.scoped(() => viewProbe(c.game, { exec: [line] }).output[0]);
const arrive = async (map, request) => (await openSession(map, assets, { travel: { arrival: request, lastURL: request.lastURL } })).c;
/** A directly opened map as the original's `open` leaves it: the player's FlagBase empty. Play's login supplies the fresh-mission marker PlayerTraveling
 * (script-mission-live.mjs beginFreshMission) and its first Timer would run FirstFrame; the original's `open` has neither (tools/dump-flags-win.c: 0 flags). */
async function openCold(map) {
  const { c } = await openSession(map, assets, { travel: {} });
  const base = c.read(c.player(), 'FlagBase'), call = ['PlayerTraveling', 0];
  c.runtime.callFunction(c.runtime.lookup(base, 'DeleteFlag'), base, call.length, i => call[i]);
  return c;
}
const flagsOf = c => { const s = c.read(c.player(), 'FlagBase'); return { flags: [...(s?.entries?.values() ?? [])].map(e => `${e.name}=${Number(e.value)}@${e.expiration}`).sort(), defaultExpiration: s?.defaultExpiration ?? null }; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The left mouse button, pressed and released: Fire for the player (Paralyzed.Fire opens MenuMain on DXOnly), MouseButtonReleased for a window. */
const click = c => { c.game.inputButton('LeftMouse', true); c.frames(2); c.game.inputButton('LeftMouse', false); c.frames(3); };
const levelInfoOf = c => c.actors().find(a => c.isA(a, 'engine.levelinfo'));
const lastConEnd = request => Number(/LastConEndTime=(\S+)/.exec(request?.travelInfo?.[0]?.[1] ?? '')?.[1] ?? NaN);

async function compareText(what, dir, file, text) {
  const measured = await measuredText(dir, file);
  const diff = firstTravelTextDifference(measured.text, text, TIMES);
  check(diff === null, `the text for ${what} differs from the measured ${dir}/${file} at line ${diff?.line}: expected ${JSON.stringify(diff?.expected)}, got ${JSON.stringify(diff?.actual)}`);
  console.log(`${what} text: ${parseTravelText(text).length} records, measured ${parseTravelText(measured.text).length}${diff ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  return measured;
}
async function compareFlags(what, dir, file, c) {
  const measured = await measuredFlags(dir, file), got = flagsOf(c);
  check(same(got, measured), `${what} flags ${JSON.stringify(got)} (measured ${dir}/${file}: ${JSON.stringify(measured)})`);
  console.log(`${what} flags:`, got.flags.join(' ') || '(none)', `(default expiration ${got.defaultExpiration})`);
}
function compareLog(what, got, want) {
  check(got.join('\n') === want.join('\n'), `the engine log differs from the original's (${what}, modelled lines):\n--- Play\n${got.join('\n')}\n--- original\n${want.join('\n')}`);
  console.log(`${what}: ${got.length} modelled log lines${got.join('\n') === want.join('\n') ? ' equal to the original\'s' : ' (DIFFER)'}`);
}

/** The logo map, Escape, and a MenuMain button pressed. */
async function menuPress(index) {
  const { c } = await openSession('DX', assets, { travel: {} });
  c.frames(120); c.key('Escape'); c.frames(20);
  const driver = createMenuDriver(c.game);
  check(driver.top() === 'deusex.menumain', `Escape opened ${driver.top()}`);
  c.game.hud.scoped(() => driver.pressButton(index)); c.frames(10);
  return { c, driver };
}

if (only === 'P') {
  // Play Intro on the logo map (no confirmation: the level's mission number is -2), the conversation's Escape (ConWindowActive: AbortCinematicConvo ends the
  // conversation, MissionIntro.Timer then calls PostIntro), the DXOnly level, a click for the menu, Credits ended by a click, Exit's box.
  const { c } = await menuPress(5);
  const request = c.takeTravel();
  if (!check(request?.map === '00_Intro', `Play Intro requested ${request?.map}`)) { finish(); }
  check(c.read(c.player(), 'bStartNewGameAfterIntro') === false, 'Play Intro leaves bStartNewGameAfterIntro False (PostIntro then goes to dxonly)');
  await compareText('00_Intro', 'ep1', 'intro0', request.travelInfo[0][1]);
  const intro = await arrive('00_Intro', request);
  intro.frames(60 * 14); intro.key('Escape');
  let request2 = null;
  for (let i = 0; i < 20 && !request2; i++) { intro.frames(30); request2 = intro.takeTravel(); }
  if (!check(request2?.map === 'dxonly', `leaving the intro by Escape requested ${request2?.map}`)) finish();
  console.log(`Escape at 14 s: the conversation ended at level time ${lastConEnd(request2).toFixed(2)} s (measured 20.88 s with the Escape at about 20 s: LastConEndTime is the Escape's time)`);
  await compareText('dxonly (Escape in the conversation)', 'ep2', 'dxonly-esc', request2.travelInfo[0][1]);
  const dx = await arrive(request2.map, request2);
  dx.frames(120);
  check(dx.state(dx.player()) === 'deusex.deusexplayer.paralyzed', `the player arrives in ${dx.state(dx.player())} (DeusExPlayer.TravelPostAccept's DXOnly hack: Paralyzed)`);
  await compareFlags('dxonly arrival', 'ep2', 'dxonly-esc', dx);
  const driver = createMenuDriver(dx.game);
  check(driver.top() === null, `no window is open on the DXOnly level at arrival (${driver.top()})`);
  click(dx); dx.frames(20);
  check(driver.top() === 'deusex.menumain', `a click on DXOnly opens ${driver.top()} (the original: MenuMain)`);
  const controls = driver.controls();
  const sensitive = index => controls.windows[controls.menu.buttons[index].window].sensitive;
  check(!sensitive(1) && !sensitive(7), 'Save Game and Back to Game are insensitive on DXOnly (MenuMain.UpdateButtonStatus: the player is Paralyzed)');
  check(sensitive(0) && sensitive(5) && sensitive(6), 'New Game, Play Intro and Credits are sensitive');
  dx.key('Escape'); dx.frames(20);
  check(driver.top() === null, `Escape closes the menu on DXOnly (${driver.top()}; the original: the logo only)`);
  dx.key('Escape'); dx.frames(20);
  check(driver.top() === 'deusex.menumain', `a second Escape reopens the menu on DXOnly (${driver.top()}; the original opens it: ep1 esc1, esc2)`);
  // Credits: the CreditsWindow over the menu, ended by a click (MouseButtonReleased -> FinishedScrolling; bQuotesEnabled False: PopWindow), the menu again
  dx.game.hud.scoped(() => driver.pressButton(6)); dx.frames(60 * 12);
  check(driver.top() === 'deusex.creditswindow', `Credits opened ${driver.top()}`);
  click(dx); dx.frames(20);
  check(driver.top() === 'deusex.menumain', `a click ends the Credits and the menu is back (${driver.top()})`);
  check(dx.takeTravel() === null, 'the Credits from the menu (bLoadIntro False) travel nowhere');
  check(dx.read(dx.player(), 'bQuotesEnabled') === false, 'bQuotesEnabled is False by default (the original goes straight back to the menu at the Credits end)');
  dx.game.hud.scoped(() => driver.pressButton(9)); dx.frames(20);
  check(driver.top() === 'deusex.menuuimessageboxwindow', `Exit opens its confirmation box (${driver.top()})`);
  const log = playLog(c.game.doors.scriptRuntime.engineLog, [intro.game.doors.scriptRuntime.engineLog, dx.game.doors.scriptRuntime.engineLog], /Initialized moving brush tracker for Level dxonly\.MyLevel/);
  compareLog('Play Intro, Escape, dxonly', log, await measuredLog('ep2', /^Log: Browse: 00_Intro/, /Initialized moving brush tracker for Level dxonly\.MyLevel/));
}

if (only === 'N') {
  // The intro left by its own end: the conversation sets Intro_Played, MissionIntro.Timer calls PostIntro (ep1: no key pressed after the first snapshot)
  const { c } = await menuPress(5);
  const request = c.takeTravel();
  const intro = await arrive('00_Intro', request);
  let request2 = null;
  for (let i = 0; i < 300 && !request2; i++) { intro.frames(60); request2 = intro.takeTravel(); }
  if (!check(request2?.map === 'dxonly', `the intro's own end requested ${request2?.map}`)) finish();
  const t = lastConEnd(request2);
  console.log(`the intro's conversation ended at level time ${t.toFixed(2)} s (measured: 126.67 s in ep1, which had one screenshot key during the conversation; the first New Game captures: about 136 s)`);
  check(t > 110 && t < 150, `the intro's conversation ended at ${t} s`);
  await compareText('dxonly (the intro\'s own end)', 'ep1', 'dxonly', request2.travelInfo[0][1]);
  const dx = await arrive(request2.map, request2);
  dx.frames(120);
  await compareFlags('dxonly arrival', 'ep1', 'dxonly', dx);
}

if (only === 'C') {
  // The Credits window from the menu to its end. Layout and speed against the measured screenshots: 25 px/s (currentScrollSpeed 0.04), the tile column 9797 px
  // tall; in ep1 (1280x720) the banner's top was at y 512 at 8.3 s, "Andrew Megowan" at y 62 at 221 s (offset 4867 +-45 in the column), "EIDOS INTERACTIVE EUROPE"
  // at y 42 at 346.8 s (7992 +-45), the photo's bottom at y 488 at 400.5 s (the end 19.5 s later), the menu back at about 421 s: (708 + 9797) / 25 = 420.2 s.
  const { c, driver } = await menuPress(6);
  check(driver.top() === 'deusex.creditswindow', `Credits opened ${driver.top()}`);
  const win = driver.topWindow(), W = driver.W;
  const read = (w, name) => c.runtime.readNamed(w, name);
  c.frames(5);
  const scroll = read(win, 'winScroll');
  check(read(win, 'currentScrollSpeed') === Math.fround(0.04), `currentScrollSpeed ${read(win, 'currentScrollSpeed')}`);
  check(read(scroll, 'height') === 9797, `the credits column is ${read(scroll, 'height')} px tall (9797)`);
  const offsets = {};
  for (let child = W.ptr(scroll, 0x13c); child; child = W.ptr(child, 0x148)) {
    if (!c.runtime.instance(child).cls.record.key.endsWith('textwindow')) continue;
    const text = c.game.hud.scoped(() => c.runtime.callFunction(c.runtime.lookup(child, 'GetText'), child, 0, () => undefined)).trim();
    if (['Andrew Megowan', 'EIDOS INTERACTIVE EUROPE'].includes(text)) offsets[text] = W.f32(child, 0xd8) - W.f32(scroll, 0xd8);
  }
  check(Math.abs(offsets['Andrew Megowan'] - 4867) <= 45, `"Andrew Megowan" at column offset ${offsets['Andrew Megowan']} (measured 4867 +-45)`);
  check(Math.abs(offsets['EIDOS INTERACTIVE EUROPE'] - 7992) <= 45, `"EIDOS INTERACTIVE EUROPE" at column offset ${offsets['EIDOS INTERACTIVE EUROPE']} (measured 7992 +-45)`);
  console.log('column offsets', JSON.stringify(offsets));
  // the column starts at winScroll.y 468 (the root's height less the 12 px ConfigurationChanged leaves: ep1's 720 px root: 708) and the window ends when y + height < 0
  const rootHeight = read(read(win, 'root'), 'height'), startY = read(scroll, 'y'), expected = (startY + 9797) / 25 + 0.04;
  let ended = null;
  for (let s = 0; s < 500 && ended === null; s++) { c.frames(60); if (driver.top() !== 'deusex.creditswindow') ended = s + 5 / 60; }
  console.log(`the Credits ended after ${ended?.toFixed(1)} s at a root ${rootHeight} px tall, the column starting at y ${startY} (expected ${expected.toFixed(1)} s; the original at 720 px: about 421 s, (708 + 9797) / 25 = 420.2)`);
  check(ended !== null && Math.abs(ended - expected) <= 1.5, `the Credits ended after ${ended} s (expected ${expected})`);
  check(driver.top() === 'deusex.menumain', `the menu is back after the Credits (${driver.top()})`);
}

/** An ending: a directly opened map, `LocalTravel` to the endgame, the conversation, the quote, the credits, a click, dxonly, a click for the menu. */
async function ending({ id, from, target, dir, arrivalText, dxText, dxFlags, flagSnapshots, playedBy, conEnd }) {
  const c = await openCold(from);
  c.frames(120);
  typed(c, `LocalTravel ${target}`); c.frames(5);
  const request = c.takeTravel();
  if (!check(request?.map === target, `LocalTravel requested ${request?.map}`)) finish();
  await compareText(`${target} (LocalTravel from ${from})`, dir, arrivalText, request.travelInfo[0][1]);
  const endgame = await arrive(request.map, request);
  const driver = createMenuDriver(endgame.game);
  // the flag sets over the ending's time: the measured snapshots must appear in Play's sequence in order, with Play's own times beside them
  const sequence = [], times = [];
  let credits = null;
  for (let t = 0; t < 240 && credits === null; t++) {
    endgame.frames(60);
    const now = flagsOf(endgame).flags;
    if (t === 3) check(endgame.state(endgame.player()) === 'deusex.deusexplayer.paralyzed', `the player is ${endgame.state(endgame.player())} 3 s into the endgame (the cinematic's Paralyzed state)`);
    if (!sequence.length || !same(sequence[sequence.length - 1], now)) { sequence.push(now); times.push(t); }
    if (driver.top() === 'deusex.creditswindow') credits = t;
  }
  console.log(`${id}: flag sets over time:`, sequence.map((s, i) => `${times[i]}s {${s.join(' ')}}`).join(' | '), `; the Credits window at ${credits} s`);
  check(credits !== null, 'the Credits window never opened');
  let from0 = 0;
  for (const snapshot of flagSnapshots) {
    const measured = (await measuredFlags(dir, snapshot)).flags;
    const at = sequence.findIndex((s, i) => i >= from0 && same(s, measured));
    if (!check(at >= 0, `the measured flags ${dir}/${snapshot} ${JSON.stringify(measured)} do not appear (in order) in Play's ${JSON.stringify(sequence)}`)) break;
    from0 = at;
  }
  // when Endgame<n>_Played appears: inside the window the captures' snapshots bound (wall clock, +-10 s), and before the Credits window
  const played = `Endgame${target.slice(-1)}_Played`, playedAt = sequence.findIndex(s => s.some(f => f.startsWith(`${played}=`)));
  check(playedAt >= 0 && times[playedAt] >= playedBy[0] && times[playedAt] <= playedBy[1] && times[playedAt] < credits, `${played} appeared at ${times[playedAt]} s (measured between ${playedBy[0]} and ${playedBy[1]} s of wall clock), the Credits at ${credits} s`);
  // the conversation's length in level time: Play's against the capture's (docs/travel.md "Unresolved")
  endgame.frames(60 * 12);
  const interim = endgame.takeTravel();
  check(interim === null, 'the endgame travelled before the click');
  click(endgame); endgame.frames(5);
  const request2 = endgame.takeTravel();
  if (!check(request2?.map === 'dxonly', `the click on the Credits requested ${request2?.map} (CreditsWindow.DestroyWindow -> SendPlayer dxonly)`)) finish();
  const t = lastConEnd(request2);
  console.log(`${id}: LastConEndTime ${t.toFixed(2)} s (measured ${conEnd} s: Play ${(100 * (t / conEnd - 1)).toFixed(1)} % longer)`);
  check(t > conEnd * 0.9 && t < conEnd * 1.2, `the conversation ended at ${t} s (measured ${conEnd} s)`);
  await compareText(`dxonly (after ${target})`, dir, dxText, request2.travelInfo[0][1]);
  const dx = await arrive(request2.map, request2);
  dx.frames(120);
  await compareFlags('dxonly arrival', dir, dxFlags, dx);
  const dxDriver = createMenuDriver(dx.game);
  click(dx); dx.frames(20);
  check(dxDriver.top() === 'deusex.menumain', `a click on DXOnly after the ending opens ${dxDriver.top()}`);
  const log = playLog(c.game.doors.scriptRuntime.engineLog, [endgame.game.doors.scriptRuntime.engineLog, dx.game.doors.scriptRuntime.engineLog], /Initialized moving brush tracker for Level dxonly\.MyLevel/);
  compareLog(`${id} from the Export travel to the dxonly arrival`, log, await measuredLog(dir, new RegExp(`^Log: Browse: ${target}`, 'i'), /Initialized moving brush tracker for Level dxonly\.MyLevel/));
}
if (only === 'E1') await ending({ id: 'E1', from: '15_Area51_Final', target: '99_Endgame1', dir: 'ep3', arrivalText: 'e1-a', dxText: 'e1-dxonly', dxFlags: 'e1-dxonly',
  flagSnapshots: ['e1-a', 'e1-c'], playedBy: [45, 75], conEnd: 54.04 });
if (only === 'E2') await ending({ id: 'E2', from: '15_Area51_Final', target: '99_Endgame2', dir: 'ep4', arrivalText: 'e2-a', dxText: 'e2-dxonly', dxFlags: 'e2-dxonly',
  flagSnapshots: ['e2-a', 'e2-d'], playedBy: [47, 75], conEnd: 66.16 });
if (only === 'E3') await ending({ id: 'E3', from: '15_Area51_Page', target: '99_endgame3', dir: 'ep5', arrivalText: 'e3-a', dxText: 'e3-dxonly', dxFlags: 'e3-dxonly',
  flagSnapshots: ['e3-a', 'e3-d'], playedBy: [60, 160], conEnd: 101.68 });

/** The conversation's length at the capture's frame time. The original's ULevel::Tick clamps the delta its ACTORS get (timers, Sleep) to 0.005 s at the low end while
 * LevelInfo.TimeSeconds adds the unclamped product (docs/script-level-tick.md): the captures ran these levels at frames of about 4.7 ms (ep9 sampled ConPlay0's
 * TimerCounter running 1.02 to 1.18 times faster than TimeSeconds), so a conversation lasts fewer level seconds than at 60 Hz, where Play's headless frames
 * (1/60 s) and a 60 Hz display never clamp. Play at 4.7 ms frames lands on the measured end (LastConEndTime). */
async function timing({ id, from, target, conEnd, frame }) {
  const c = await openCold(from);
  c.frames(60);
  typed(c, `LocalTravel ${target}`); c.frames(5);
  const request = c.takeTravel();
  const endgame = (await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, frameSeconds: frame })).c;
  const played = `Endgame${target.slice(-1)}_Played`;
  let t = null;
  for (let i = 0; i < 130 / frame && t === null; i++) {
    endgame.frames(1);
    if (endgame.read(endgame.player(), 'FlagBase')?.getBool(played)) t = Number(endgame.read(endgame.player(), 'LastConEndTime'));
  }
  console.log(`${id}: at ${(frame * 1000).toFixed(1)} ms frames the conversation ended at level time ${t?.toFixed(2)} s (measured ${conEnd} s: ${t ? (100 * (t / conEnd - 1)).toFixed(1) : '?'} %)`);
  check(t !== null && Math.abs(t / conEnd - 1) <= 0.05, `the conversation ended at ${t} s at ${frame} s frames (measured ${conEnd} s, +-5 %)`);
}
if (only === 'T1') await timing({ id: 'T1', from: '15_Area51_Final', target: '99_Endgame1', conEnd: 54.04, frame: 0.0047 });
if (only === 'T2') await timing({ id: 'T2', from: '15_Area51_Final', target: '99_Endgame2', conEnd: 66.16, frame: 0.0047 });
if (only === 'T3') await timing({ id: 'T3', from: '15_Area51_Page', target: '99_endgame3', conEnd: 101.68, frame: 0.0047 });

/** The endgame MapExits fired as their triggers fire them: `Actor.Trigger(Other, Instigator)` on the `MapExit` (the Dispatcher of the reactor sequence, the FlagTrigger on
 * HeliosFree and Mission15.Timer's `A.Trigger(Self, None)` all call it): MapExit.Trigger -> LoadMap -> ClearWindowStack, SendPlayer(Player, DestMap) with DestMap spelled
 * as the map has it ('99_Endgame1', '99_Endgame2', '99_endgame3'). The text is the one `LocalTravel` exported (the same ClientTravel). The original was not driven
 * through these triggers (docs/travel.md Unresolved 19). */
async function mapExit({ id, from, destMap, dir, arrivalText }) {
  const c = await openCold(from);
  c.frames(120);
  const exit = c.actors().find(a => c.isA(a, 'deusex.mapexit') && c.read(a, 'DestMap') === destMap);
  if (!check(exit, `${from} has no MapExit to ${destMap}`)) finish();
  const pawn = c.player();
  c.game.hud.scoped(() => c.runtime.callFunction(c.runtime.lookup(exit, 'Trigger'), exit, 2, i => [pawn, pawn][i]));
  let request = null;
  for (let i = 0; i < 20 && !request; i++) { c.frames(5); request = c.takeTravel(); }
  if (!check(request?.map === destMap, `MapExit.Trigger requested ${request?.map} (DestMap ${destMap})`)) finish();
  check(request.url === `${destMap}?Name=Player?Class=DeusEx.JCDentonMale`, `the URL is ${request.url}`);
  await compareText(`${destMap} (${exit.name}.Trigger)`, dir, arrivalText, request.travelInfo[0][1]);
  const endgame = await arrive(request.map, request);
  endgame.frames(180);
  check(endgame.state(endgame.player()) === 'deusex.deusexplayer.paralyzed', `the player is ${endgame.state(endgame.player())} in ${destMap}`);
  const info = endgame.actors().find(a => endgame.isA(a, 'deusex.deusexlevelinfo'));
  check(endgame.read(info, 'missionNumber') === 99, `${destMap}'s mission number is ${endgame.read(info, 'missionNumber')}`);
}
if (only === 'M1') await mapExit({ id: 'M1', from: '15_Area51_Final', destMap: '99_Endgame1', dir: 'ep3', arrivalText: 'e1-a' });
if (only === 'M2') await mapExit({ id: 'M2', from: '15_Area51_Final', destMap: '99_Endgame2', dir: 'ep4', arrivalText: 'e2-a' });
if (only === 'M3') {
  // Page: the flag `killpage` (a conversation event in the game; set here through FlagBase.SetBool as a test input) makes Mission15.Timer set MS_PageExploding, run
  // PageExplosionEffects, destroy Page and the platform at 6 s (MS_PageDestroyed) and, nine seconds after the flag, trigger every actor tagged `start_endgame`: the MapExit
  const c = await openCold('15_Area51_Page');
  c.frames(120);
  const base = c.read(c.player(), 'FlagBase'), call = ['killpage', true, true, 16];
  c.runtime.callFunction(c.runtime.lookup(base, 'SetBool'), base, call.length, i => call[i]);
  let request = null, destroyedAt = null;
  for (let t = 1; t <= 40 && !request; t++) {
    c.frames(60); request = c.takeTravel();
    if (destroyedAt === null && base.getBool('MS_PageDestroyed')) destroyedAt = t;
  }
  console.log(`M3: MS_PageDestroyed at ${destroyedAt} s, the request ${request?.url}`);
  check(request?.map === '99_endgame3', `the killpage route requested ${request?.map}`);
  check(destroyedAt >= 5 && destroyedAt <= 8, `Page was destroyed ${destroyedAt} s after the flag (Mission15.Timer: 6 s, a one second Timer)`);
  check(!request || request.travelInfo[0][1].includes('killpage'), 'the travel text carries the killpage flag');
}

if (only === 'W') {
  // The ending with bQuotesEnabled True (typed in the endgame level as the capture typed it on the logo map: Play's class defaults do not outlive a level session): the credits run
  // to their end, CreditsWindow.FinishedScrolling only plays `CreditsEnd`, the window's Tick waits creditsEndSoundLength (4 s) and InvokeQuotesWindow opens QuotesWindow with
  // SetClearStack(True) and SetLoadIntro(True); its end clears the window stack and SendPlayer(dxonly) (ep11).
  const c = await openCold('15_Area51_Final');
  c.frames(120);
  typed(c, 'LocalTravel 99_Endgame2'); c.frames(5);
  const request = c.takeTravel();
  const endgame = await arrive(request.map, request);
  typed(endgame, 'set DeusEx.DeusExPlayer bQuotesEnabled True');
  const driver = createMenuDriver(endgame.game);
  let credits = null, endedCredits = null, quotes = null, t = 0;
  for (; t < 1500; t++) {
    endgame.frames(60);
    const top = driver.top();
    if (credits === null && top === 'deusex.creditswindow') credits = t;
    if (credits !== null && quotes === null && top === 'deusex.quoteswindow') { quotes = t; break; }
  }
  console.log(`W: the credits at ${credits} s, the Quotes window at ${quotes} s (${quotes - credits} s later; 410 s of scrolling at the headless root, then the 4 s of creditsEndSoundLength)`);
  check(credits !== null && quotes !== null && Math.abs(quotes - credits - (410.1 + 4)) <= 3, `the Quotes window opened ${quotes - credits} s after the credits`);
  const win = driver.topWindow(), read = name => endgame.runtime.readNamed(win, name);
  check(read('bClearStack') === true && read('bLoadIntro') === true, `the Quotes window after the credits has bClearStack ${read('bClearStack')} and bLoadIntro ${read('bLoadIntro')}`);
  let request2 = null;
  for (let u = 0; u < 600 && !request2; u++) { endgame.frames(60); request2 = endgame.takeTravel(); if (request2) console.log(`W: the Quotes window ended after ${u + 1} s`); }
  if (!check(request2?.map === 'dxonly', `the end of the Quotes window requested ${request2?.map}`)) finish();
  check(driver.top() === null, `the window stack is clear at the end of the Quotes window (${driver.top()})`);
  await compareText('dxonly (after the credits and the Quotes window)', 'ep11', 'q-dxonly', request2.travelInfo[0][1]);
  const dx = await arrive(request2.map, request2);
  dx.frames(120);
  await compareFlags('dxonly arrival', 'ep11', 'q-dxonly', dx);
}

if (only === 'X') {
  // Escape during the Endgame1 conversation: ConWindowActive's AbortCinematicConvo ends it and calls MissionEndgame.FinishCinematic at once (the Credits
  // follow without the quote); ep7: the Escape at about 20 s, LastConEndTime 21.9 s, the flags {Endgame1_Played, EndgameExplosions False}, the Credits.
  const c = await openCold('15_Area51_Final');
  c.frames(120);
  typed(c, 'LocalTravel 99_Endgame1'); c.frames(5);
  const request = c.takeTravel();
  const endgame = await arrive(request.map, request);
  const driver = createMenuDriver(endgame.game);
  endgame.frames(60 * 18);
  check(driver.top() === 'deusex.conwindowactive', `the conversation window is up at 18 s (${driver.top()})`);
  endgame.key('Escape'); endgame.frames(30);
  check(driver.top() === 'deusex.creditswindow', `Escape in the conversation opens ${driver.top()} (the original: the Credits at once)`);
  const measured = (await measuredFlags('ep7', 'esc-after')).flags;
  check(same(flagsOf(endgame).flags, measured), `the flags after the Escape ${JSON.stringify(flagsOf(endgame).flags)} (measured ${JSON.stringify(measured)})`);
  click(endgame); endgame.frames(5);
  const request2 = endgame.takeTravel();
  if (!check(request2?.map === 'dxonly', `the click requested ${request2?.map}`)) finish();
  await compareText('dxonly (after Escape in Endgame1)', 'ep7', 'esc-dxonly', request2.travelInfo[0][1]);
  const dx = await arrive(request2.map, request2);
  dx.frames(120);
  await compareFlags('dxonly arrival', 'ep7', 'esc-dxonly', dx);
  const log = playLog(c.game.doors.scriptRuntime.engineLog, [endgame.game.doors.scriptRuntime.engineLog, dx.game.doors.scriptRuntime.engineLog], /Initialized moving brush tracker for Level dxonly\.MyLevel/);
  compareLog('Escape in Endgame1', log, await measuredLog('ep7', /^Log: Browse: 99_Endgame1/i, /Initialized moving brush tracker for Level dxonly\.MyLevel/));
}

if (only === 'Q') {
  // The Quotes window: DeusExPlayer.ShowQuotesWindow (a cheat exec) from the logo map, as ep5 typed it; a click ends it (MouseButtonReleased ->
  // FinishedScrolling: PopWindow), leaving the logo map as it was
  const { c } = await openSession('DX', assets, { travel: {} });
  c.frames(120);
  c.exec('ShowQuotesWindow'); c.frames(10);   // (the typed lines of viewProbe switch the cheats on first: this one is the player's exec itself)
  const driver = createMenuDriver(c.game);
  check(driver.top() === null, `ShowQuotesWindow without cheats opened ${driver.top()} (it returns at once)`);
  typed(c, 'set DeusEx.JCDentonMale bCheatsEnabled True'); typed(c, 'ShowQuotesWindow'); c.frames(30);
  check(driver.top() === 'deusex.quoteswindow', `ShowQuotesWindow opened ${driver.top()}`);
  const win = driver.topWindow(), read = name => c.runtime.readNamed(win, name);
  check(read('textName') === 'DeusExQuotes' && read('ScrollMusicString') === 'Quotes_Music.Quotes_Music' && read('bClearStack') === false && read('bLoadIntro') === false, 'the Quotes window\'s defaults');
  c.frames(60 * 15);
  check(driver.top() === 'deusex.quoteswindow', 'the Quotes window is still scrolling at 15 s');
  click(c); c.frames(20);
  check(driver.top() === null, `a click ends the Quotes window (${driver.top()})`);
  check(c.takeTravel() === null, 'the Quotes window from the cheat travels nowhere');
}

finish();
function finish() {
  if (failures.length) { console.log(`FAIL validate-travel-endings ${only}:\n  ${failures.join('\n  ')}`); process.exit(1); }
  console.log(`PASS validate-travel-endings ${only}`);
  process.exit(0);
}
