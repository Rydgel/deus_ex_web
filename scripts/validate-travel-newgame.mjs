/** The New Game path in Play against the measured original (docs/travel.md "Play, step 2"), headless.
 *
 * The original under Wine (scripts/travel-probe.sh, `.work/travel/nw0`: the logo map, a click, the real MenuMain, the real difficulty
 * and New Game screens, Start Game, 00_Intro, then Escape or the intro's own end, then 01_NYC_UNATCOIsland) is the reference. Play runs the
 * same menus' scripts through the menu driver: MenuMain.winButtons[0] -> MenuUIWindow.StartNewGame -> the "train first?" box (bAskedToTrain
 * is False on a fresh install; the capture's prefix had it True and went straight to the difficulty menu) -> MenuSelectDifficulty ->
 * MenuScreenNewGame -> ProcessAction("START") -> DeusExPlayer.ShowIntro(True) -> SendPlayer("00_Intro"), then 00_Intro's MissionIntro and
 * ShowMainMenu (mission 98) -> PostIntro -> StartNewGame(strStartMap) -> SendPlayer("01_NYC_UNATCOIsland").
 *
 * The captures froze each level on arrival (`set LevelInfo bPlayersOnly True` before the travel: the class default carries into the next
 * level, whose mission script then never runs its first Timer); Play does the same by writing bPlayersOnly on the arrived level's
 * LevelInfo before its first frame. Checked per scenario:
 *   - the text exported at Start Game equals the measured text for 00_Intro (96 records) and the text at the Escape equals the measured
 *     text for the Island (79 records), after normalization of pointers, instance numbers and the frame-time values
 *     (`saveTime`, `LastConEndTime`: travel-text.mjs TIME_PROPERTIES, presence only);
 *   - the arrival flags before the first timer and after it, and the flag store's default expiration;
 *   - the engine log's modelled lines in the original's order.
 * Scenarios: A the defaults (Medium) left by Escape; B a customized start (Hard, portrait, two skills raised, a typed name) left by Escape;
 * C the defaults left by the intro's own end (the conversation sets Intro_Played; MissionIntro.Timer calls PostIntro).
 *
 *   node scripts/validate-travel-newgame.mjs [--only A|B|C] */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
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
const dump = option('dump', null);   // a directory: Play's texts are written there (to diff against the captures)
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-newgame: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/nw0/', import.meta.url).pathname;
if (!existsSync(`${captures}n1b-island-frozen.travel.txt`)) { console.log('SKIP validate-travel-newgame: the measured captures are not in .work/travel/nw0 (outside Git)'); process.exit(0); }

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const TIMES = { times: true };

// --- the measured captures --------------------------------------------------------------------------------------------------------------
const measuredText = async name => travelTextOfDump(await readFile(`${captures}${name}.travel.txt`, 'utf8'));
/** `flag <name> type <t> expiration <e> value <v>` lines -> Play's `name[=value]@expiration` strings, and the default expiration. */
async function measuredFlags(name) {
  const lines = (await readFile(`${captures}${name}.flags.txt`, 'utf8')).split(/\r?\n/);
  const header = /defaultExpiration (\d+)/.exec(lines[0]);
  const flags = [];
  for (const line of lines) {
    const m = /^\s+flag (\S+) type (\d+) expiration (\d+) value (0x[0-9a-f]+)/.exec(line);
    if (m) flags.push(`${m[1]}${Number(m[2]) ? `=${Number(m[4])}` : ''}@${m[3]}`);
  }
  return { flags: flags.sort(), defaultExpiration: header ? Number(header[1]) : null };
}
const MODELLED = /^(Log: (Unloading: Package (DX|00_Intro)$|Export travel for|Browse:|Doing load, not loadgame|Current mission number|Attempting to get player|LoadMap:|Game class is|Bringing Level|Spawning new actor|Possessed PlayerPawn)|ScriptLog: (InitGame|Base Mutator|DeusExLevelInfo - Spawned new mission script|Login:|All inventory|\*\*\*\* InitStateMachine))/;
const normalizeLine = line => line.replace(/\b(?:TrainingRuntime|DX|00_Intro|01_NYC_UNATCOIsland)\.(\w+?)\d+\b/g, '$1#').replace(/\b(\w+?)\d+\b(?= started mission)/g, '$1#')
  .replace(/Level (?:DX|00_Intro|01_NYC_UNATCOIsland)\.MyLevel/, 'Level <map>.MyLevel').replace(/\s+$/, '');
/** The measured session log's modelled lines of the `nth` New Game (the nth `Browse: 00_Intro` line of the session, counting from 1): from its
 * `Export travel` line to the end of the Island's startup (`through`: how many `Browse:` lines after the first to include). */
async function measuredLog(nth, { untilFlagsTimer }) {
  const lines = (await readFile(`${captures}final.log`, 'utf8')).split(/\r?\n/);
  let seen = 0, browse = -1;
  for (let i = 0; i < lines.length && browse < 0; i++) if (lines[i].startsWith('Log: Browse: 00_Intro?') && ++seen === nth) browse = i;
  assert.ok(browse >= 0, `final.log has no ${nth}th New Game`);
  let island = -1;
  for (let i = browse + 1; i < lines.length; i++) if (lines[i].startsWith('Log: Browse: 01_NYC_UNATCOIsland?')) { island = i; break; }
  assert.ok(island >= 0, 'final.log: the Island travel of the New Game');
  let end = lines.length;
  for (let i = island; i < lines.length; i++) if (/Possessed PlayerPawn/.test(lines[i])) { end = i + 2; break; }   // + "All inventory ... accepted"
  if (untilFlagsTimer) for (let i = end; i < lines.length; i++) if (/InitStateMachine/.test(lines[i])) { end = i + 1; break; }
  return lines.slice(browse - 1, end).filter(line => MODELLED.test(line)).map(normalizeLine);
}

// --- Play ---------------------------------------------------------------------------------------------------------------------------------
/** A console line as the capture typed it (the Talk key, the line, Enter): the viewport's Exec chain (`set`, `open`, `LocalTravel`, the exec functions),
 * `set LevelInfo bPlayersOnly True` being the freeze the captures carried into the next level through the class default. */
const typed = (c, line) => c.game.hud.scoped(() => viewProbe(c.game, { exec: [line] }).output[0]);
const flagsOf = c => { const store = c.read(c.player(), 'FlagBase'); return { flags: [...(store?.entries?.values() ?? [])].map(e => `${e.name}${e.type ? `=${e.value}` : ''}@${e.expiration}`).sort(), defaultExpiration: store?.defaultExpiration ?? null }; };
const levelInfoOf = c => c.actors().find(a => c.isA(a, 'engine.levelinfo'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Esc, New Game, the "train first?" box answered No, a difficulty, the New Game screen `customize`d, Start Game: the request for 00_Intro. */
async function startNewGame({ difficulty, customize }) {
  const { c } = await openSession('DX', assets, { travel: {} });
  c.frames(120);
  c.key('Escape'); c.frames(20);
  const driver = createMenuDriver(c.game);
  const scoped = fn => c.game.hud.scoped(fn);
  const step = (label, fn, expect, frames = 30) => { scoped(fn); c.frames(frames); check(driver.top() === expect, `${label}: the top window is ${driver.top()} (expected ${expect})`); };
  assert.equal(driver.top(), 'deusex.menumain', 'Escape opens the original main menu');
  check(c.read(c.player(), 'bAskedToTrain') === false, 'a fresh configuration has bAskedToTrain False');
  step('New Game', () => driver.pressButton(0), 'deusex.menuuimessageboxwindow');
  step('the training box, No', () => driver.pressField('btnNo'), 'deusex.menuselectdifficulty');
  step(`difficulty ${difficulty}`, () => driver.pressButton(difficulty), 'deusex.menuscreennewgame');
  if (customize) await customize({ c, driver, scoped });
  scoped(() => driver.pressActionKey('START'));
  c.frames(3);
  const request = c.takeTravel();
  check(request?.map === '00_Intro', `Start Game requested ${request?.map}`);
  return { c, request };
}

const arrive = async (map, request) => (await openSession(map, assets, { travel: { arrival: request, lastURL: request.lastURL } })).c;

/** One New Game through the intro to the Island; the scenario's measured captures decide what is compared. */
async function scenario(label, { difficulty, customize, leave, capture, logNth, expect }) {
  console.log(`--- ${label}`);
  const { c, request } = await startNewGame({ difficulty, customize });
  if (!request) return;
  const oldLog = [...c.game.doors.scriptRuntime.engineLog];

  // 00_Intro: the text for it, the arrival flags, frozen like the capture
  const introText = request.travelInfo[0][1];
  const measuredIntro = await measuredText(`${capture}-intro-frozen`);
  const introDiff = firstTravelTextDifference(measuredIntro.text, introText, TIMES);
  check(introDiff === null, `${label}: the text for 00_Intro differs from the measured at line ${introDiff?.line}: expected ${JSON.stringify(introDiff?.expected)}, got ${JSON.stringify(introDiff?.actual)}`);
  console.log(`00_Intro text: ${parseTravelText(introText).length} records, measured ${parseTravelText(measuredIntro.text).length}${introDiff ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  const intro = await arrive('00_Intro', request);
  const frozenIntro = leave === 'escape';
  if (frozenIntro) typed(intro, 'set LevelInfo bPlayersOnly True');
  const introFlags = flagsOf(intro), measuredIntroFlags = await measuredFlags(`${capture}-intro-frozen`);
  check(same(introFlags.flags, measuredIntroFlags.flags) && introFlags.defaultExpiration === measuredIntroFlags.defaultExpiration,
    `${label}: flags at the intro ${JSON.stringify(introFlags)} (measured ${JSON.stringify(measuredIntroFlags)})`);

  // leaving the intro: Escape (ShowMainMenu on mission 98) or its own end (the conversation, then MissionIntro.Timer)
  let request2 = null;
  if (leave === 'escape') { intro.frames(60); intro.key('Escape'); intro.frames(10); request2 = intro.takeTravel(); }
  else {
    for (let i = 0; i < 400 && !request2; i++) { intro.frames(60); request2 = intro.takeTravel(); }
    console.log(`the intro ended by itself at level time ${intro.read(levelInfoOf(intro), 'TimeSeconds').toFixed(1)} s`);
  }
  if (!check(request2?.map === '01_NYC_UNATCOIsland', `${label}: leaving the intro requested ${request2?.map}`)) return;
  const introLog = [...intro.game.doors.scriptRuntime.engineLog];

  // the text for the Island
  const islandText = request2.travelInfo[0][1];
  const measuredIsland = await measuredText(expect.islandText);
  const islandDiff = firstTravelTextDifference(measuredIsland.text, islandText, TIMES);
  check(islandDiff === null, `${label}: the text for the Island differs from the measured at line ${islandDiff?.line}: expected ${JSON.stringify(islandDiff?.expected)}, got ${JSON.stringify(islandDiff?.actual)}`);
  console.log(`Island text: ${parseTravelText(islandText).length} records, measured ${parseTravelText(measuredIsland.text).length}${islandDiff ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  check(request2.travelInfo[0][0] === measuredIsland.key, `${label}: TravelInfo key ${request2.travelInfo[0][0]} (measured ${measuredIsland.key})`);

  // the Island: frozen at arrival, then the first timers
  const island = await arrive('01_NYC_UNATCOIsland', request2);
  const li = levelInfoOf(island);
  if (expect.frozenIsland) typed(island, 'set LevelInfo bPlayersOnly True');
  island.frames(10);
  const atArrival = flagsOf(island);
  if (expect.frozenIsland) {
    const measured = await measuredFlags(expect.islandFrozenFlags);
    check(same(atArrival.flags, measured.flags) && atArrival.defaultExpiration === measured.defaultExpiration,
      `${label}: Island flags at arrival ${JSON.stringify(atArrival)} (measured ${JSON.stringify(measured)})`);
    typed(island, 'set LevelInfo bPlayersOnly False');
  }
  island.frames(180);
  const afterTimer = flagsOf(island), measuredAfter = await measuredFlags(expect.islandLiveFlags);
  check(same(afterTimer.flags, measuredAfter.flags) && afterTimer.defaultExpiration === measuredAfter.defaultExpiration,
    `${label}: Island flags after the first timer ${JSON.stringify(afterTimer)} (measured ${JSON.stringify(measuredAfter)})`);
  console.log('Island flags at arrival:', atArrival.flags.join(' '), `(default expiration ${atArrival.defaultExpiration}); after the first timer:`, afterTimer.flags.join(' '), `(default expiration ${afterTimer.defaultExpiration})`);

  // the engine log
  const play =[...oldLog.slice(oldLog.lastIndexOf('Log: Export travel for: Player')), ...introLog, ...island.game.doors.scriptRuntime.engineLog];
  const got = play.filter(line => MODELLED.test(line)).map(normalizeLine).join('\n');
  const want = (await measuredLog(logNth, { untilFlagsTimer: true })).join('\n');
  check(got === want, `${label}: the engine log differs from the original's (modelled lines):\n--- Play\n${got}\n--- original\n${want}`);
  console.log(`log: ${got.split('\n').length} modelled lines${got === want ? " in the original's order" : ' (DIFFERS)'}`);
  return { c, intro, island };
}

const portraitAndSkills = async ({ c, driver, scoped }) => {
  const W = driver.W, runtime = driver.runtime;
  const screen = () => driver.topWindow();
  scoped(() => driver.pressField('btnRightArrow')); c.frames(5);
  scoped(() => driver.pressField('btnRightArrow')); c.frames(5);
  // the rows of the skill list, clicked as the pointer does: Lockpicking, then Computer (sorted by name), each followed by Upgrade
  const list = runtime.readNamed(screen(), 'lstSkills');
  const line = W.f32(list, 0x19c), x = W.f32(list, 0xd4) + 20, y0 = W.f32(list, 0xd8);
  const click = row => {
    for (const action of [1, 3]) check(c.game.windowPointer({ relative: false, x, y: y0 + (row + 0.5) * line, key: 1, action }) === true, 'the root takes the pointer sample');
    c.frames(3);
  };
  click(3); scoped(() => driver.pressField('btnUpgrade')); c.frames(5);   // Lockpicking
  click(0); scoped(() => driver.pressField('btnUpgrade')); c.frames(5);   // Computer
};

if (!only || only === 'A') {
  await scenario('A: defaults (Medium), Escape', { difficulty: 1, leave: 'escape', capture: 'n1b', logNth: 2,
    expect: { islandText: 'n1b-island-frozen', frozenIsland: true, islandFrozenFlags: 'n1b-island-frozen', islandLiveFlags: 'n1b-island-live' } });
}
if (!only || only === 'B') {
  await scenario('B: Hard, portrait 2, Lockpicking and Computer raised, Escape', { difficulty: 2, customize: portraitAndSkills, leave: 'escape', capture: 'n2', logNth: 3,
    expect: { islandText: 'n2-island-frozen', frozenIsland: true, islandFrozenFlags: 'n2-island-frozen', islandLiveFlags: 'n2-island-live' } });
}
if (!only || only === 'C') {
  await scenario("C: defaults (Medium), the intro's own end", { difficulty: 1, leave: 'end', capture: 'n1', logNth: 1,
    expect: { islandText: 'n3-natural-island', frozenIsland: false, islandFrozenFlags: null, islandLiveFlags: 'n3-natural-island' } });
}

if (!only || only === 'D') {
  // The player's state carried through two travels (the original's session: a New Game as A, then 45 s on the Island, the cheat console lines
  // (bCheatsEnabled, AllCredits, AllSkills, AllAugs, AllImages, GiveNanoKey, NoteAdd, GoalAdd) and `LocalTravel 02_NYC_Street`; 8 s in the Street,
  // `LocalTravel 03_NYC_Airfield`). Each text is compared with the original's after normalization: the first is what ExportTravel writes for
  // images, a NanoKeyInfo, a note, a goal, every augmentation and skill; the second is what the *import* of the first leaves to export again
  // (the goal is gone: Mission02.FirstFrame resets the secondary goals), so the pair checks the import and the callbacks as a fixed point.
  console.log('--- D: items through two travels');
  const { request } = await startNewGame({ difficulty: 1 });
  let c = await arrive('00_Intro', request);
  typed(c, 'set LevelInfo bPlayersOnly True');
  c.frames(60); c.key('Escape'); c.frames(10);
  const toIsland = c.takeTravel();
  c = await arrive('01_NYC_UNATCOIsland', toIsland);
  c.frames(2700);
  for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', 'AllCredits', 'AllSkills', 'AllAugs', 'AllImages', 'GiveNanoKey TestKeyA "Test key A"',
    'NoteAdd "A first note"', 'GoalAdd GoalOne "Reach the dock" 1']) { typed(c, line); c.frames(30); }
  c.frames(60);
  typed(c, 'LocalTravel 02_NYC_Street'); c.frames(2);
  const toStreet = c.takeTravel();
  if (check(toStreet?.map === '02_NYC_Street', `D: LocalTravel 02_NYC_Street requested ${toStreet?.map}`)) {
    const text = toStreet.travelInfo[0][1], measured = await measuredText('n4-street-frozen');
    if (dump) await writeFile(`${dump}/play-street.txt`, text);
    const diff = firstTravelTextDifference(measured.text, text, TIMES);
    check(diff === null, `D: the text for the Street differs from the measured at line ${diff?.line}: expected ${JSON.stringify(diff?.expected)}, got ${JSON.stringify(diff?.actual)}`);
    console.log(`Street text: ${parseTravelText(text).length} records, measured ${parseTravelText(measured.text).length}${diff ? ' (DIFFERS)' : ' (equal after normalization)'}`);
    c = await arrive('02_NYC_Street', toStreet);
    typed(c, 'set LevelInfo bPlayersOnly True'); c.frames(10);
    const measuredFlagsAtStreet = await measuredFlags('n4-street-frozen'), atStreet = flagsOf(c);
    check(same(atStreet.flags, measuredFlagsAtStreet.flags) && atStreet.defaultExpiration === measuredFlagsAtStreet.defaultExpiration,
      `D: Street flags at arrival ${JSON.stringify(atStreet)} (measured ${JSON.stringify(measuredFlagsAtStreet)})`);
    typed(c, 'set LevelInfo bPlayersOnly False');
    c.frames(480);
    typed(c, 'LocalTravel 03_NYC_Airfield'); c.frames(2);
    const toAirfield = c.takeTravel();
    if (check(toAirfield?.map === '03_NYC_Airfield', `D: LocalTravel 03_NYC_Airfield requested ${toAirfield?.map}`)) {
      const text2 = toAirfield.travelInfo[0][1], measured2 = await measuredText('n4-airfield-frozen');
      if (dump) await writeFile(`${dump}/play-airfield.txt`, text2);
      const diff2 = firstTravelTextDifference(measured2.text, text2, TIMES);
      check(diff2 === null, `D: the second text (the import's export) differs from the measured at line ${diff2?.line}: expected ${JSON.stringify(diff2?.expected)}, got ${JSON.stringify(diff2?.actual)}`);
      console.log(`Airfield text: ${parseTravelText(text2).length} records, measured ${parseTravelText(measured2.text).length}${diff2 ? ' (DIFFERS)' : ' (equal after normalization)'}`);
    }
  }
}

if (failures.length) { console.log(`FAIL validate-travel-newgame:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel-newgame: the New Game path (menu, intro, Island) matches the measured original');
