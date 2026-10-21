/** The New Game path and the items it carries, in Play against the measured original (docs/travel.md "Play, step 2"), headless.
 *
 * The original under Wine (scripts/travel-probe.sh; `.work/travel/nw0`, `nw1`, `nw2`, outside Git) is the reference: the logo map, a click, the real
 * MenuMain, the real difficulty and New Game screens (name typed, portrait and skills clicked), Start Game, 00_Intro, then Escape or the intro's own end,
 * then 01_NYC_UNATCOIsland; from the Island, console lines (the cheats, `set` of item properties, a pickup by placement and ParseRightClick) and
 * `LocalTravel 02_NYC_Street`, then `LocalTravel 03_NYC_Airfield` from the Street. Play runs the same menus' scripts through the menu driver:
 * MenuMain.winButtons[0] -> MenuUIWindow.StartNewGame -> the "train first?" box (bAskedToTrain is False on a fresh install; the capture's prefix had it
 * True and went straight to the difficulty menu) -> MenuSelectDifficulty -> MenuScreenNewGame -> ProcessAction("START") -> DeusExPlayer.ShowIntro(True)
 * -> SendPlayer("00_Intro"), then 00_Intro's MissionIntro and ShowMainMenu (mission 98) -> PostIntro -> StartNewGame(strStartMap) -> SendPlayer(Island).
 *
 * The captures froze each level on arrival (`set LevelInfo bPlayersOnly True` before the travel: the class default carries into the next level, whose
 * mission script then never runs its first Timer); Play types the same line in the arrived session before its first frame. Checked per scenario:
 *   - every text the original's engine exported (the one for 00_Intro, the one for the Island, then the Street's and the Airfield's, which hold the
 *     items) equals Play's after normalization of pointers, instance numbers and the frame-time values (travel-text.mjs TIME_PROPERTIES: presence only);
 *     the Street's text is what ExportTravel writes, the Airfield's is what the *import* of the Street's leaves to export again (the fixed point,
 *     checked against the original's own, with the first level's goal gone because Mission02.FirstFrame resets it);
 *   - the arrival flags before the first timer and after it, and the flag store's default expiration;
 *   - the engine log's modelled lines in the original's order.
 * Scenarios: A the defaults (Medium) left by Escape; B a customized start (Hard, portrait, two skills raised) left by Escape; C the defaults left by the
 * intro's own end (the conversation sets Intro_Played; MissionIntro.Timer calls PostIntro); D the defaults, then the cheat console lines (credits, skills,
 * augmentations, images, a NanoKeyInfo, a note, a goal) and the two travels; E a typed name, Realistic, a portrait and a skill, then non-default item
 * properties set on the live objects, two keys, two notes, two goals and the two travels; F three items picked up by the real frob path (the Island's soda can,
 * liquor bottle and crowbar: invPosX/Y, invSlots) and the two travels.
 *
 * runner-timeout: 2400
 *
 *   node scripts/validate-travel-newgame.mjs [--only A|B|C|D|E|F|G] [--dump DIR] */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { viewProbe } from '../src/viewer/view-probe.mjs';
import { travelTextOfDump, firstTravelTextDifference, parseTravelText, formatTravelText } from '../src/runtime/travel-text.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
if (!only) {
  // One process per scenario: each builds three to five level sessions (a few GB of object images) that nothing frees until the process ends; all six
  // in one process hit V8's heap limit (4 GB) in scenario C.
  const { spawnSync } = await import('node:child_process');
  const argv = process.argv.slice(2);
  let status = 0;
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    const run = spawnSync(process.execPath, [process.argv[1], '--only', id, ...argv], { stdio: 'inherit' });
    if (run.status !== 0) status = run.status ?? 1;
  }
  process.exit(status);
}
const dump = option('dump', null);   // a directory: Play's texts are written there (to diff against the captures)
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-newgame: no installed game data'); process.exit(0); }
const captureRoot = new URL('../.work/travel/', import.meta.url).pathname;
if (!existsSync(`${captureRoot}nw0/n1b-island-frozen.travel.txt`)) { console.log('SKIP validate-travel-newgame: the measured captures are not in .work/travel/nw0 (outside Git)'); process.exit(0); }

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const TIMES = { times: true };

// --- the measured captures --------------------------------------------------------------------------------------------------------------
const measuredText = async (dir, name) => travelTextOfDump(await readFile(`${captureRoot}${dir}/${name}.travel.txt`, 'utf8'));
/** `flag <name> type <t> expiration <e> value <v>` lines -> Play's `name[=value]@expiration` strings, and the default expiration. */
async function measuredFlags(dir, name) {
  const lines = (await readFile(`${captureRoot}${dir}/${name}.flags.txt`, 'utf8')).split(/\r?\n/);
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
 * `Export travel` line to the end of the Island's startup (and its first Timer's InitStateMachine). */
async function measuredLog(dir, nth) {
  const lines = (await readFile(`${captureRoot}${dir}/final.log`, 'utf8')).split(/\r?\n/);
  let seen = 0, browse = -1;
  for (let i = 0; i < lines.length && browse < 0; i++) if (lines[i].startsWith('Log: Browse: 00_Intro?') && ++seen === nth) browse = i;
  assert.ok(browse >= 0, `${dir}/final.log has no ${nth}th New Game`);
  let island = -1;
  for (let i = browse + 1; i < lines.length; i++) if (lines[i].startsWith('Log: Browse: 01_NYC_UNATCOIsland?')) { island = i; break; }
  assert.ok(island >= 0, `${dir}/final.log: the Island travel of the New Game`);
  let end = lines.length;
  for (let i = island; i < lines.length; i++) if (/Possessed PlayerPawn/.test(lines[i])) { end = i + 2; break; }   // + "All inventory ... accepted"
  for (let i = end; i < lines.length; i++) if (/InitStateMachine/.test(lines[i])) { end = i + 1; break; }
  return lines.slice(browse - 1, end).filter(line => MODELLED.test(line)).map(normalizeLine);
}

// --- Play ---------------------------------------------------------------------------------------------------------------------------------
/** A console line as the capture typed it (the Talk key, the line, Enter): the viewport's Exec chain (`set`, `open`, `LocalTravel`, the exec functions),
 * `set LevelInfo bPlayersOnly True` being the freeze the captures carried into the next level through the class default. */
const typed = (c, line) => c.game.hud.scoped(() => viewProbe(c.game, { exec: [line] }).output[0]);
const flagsOf = c => { const store = c.read(c.player(), 'FlagBase'); return { flags: [...(store?.entries?.values() ?? [])].map(e => `${e.name}${e.type ? `=${e.value}` : ''}@${e.expiration}`).sort(), defaultExpiration: store?.defaultExpiration ?? null }; };
const levelInfoOf = c => c.actors().find(a => c.isA(a, 'engine.levelinfo'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const typeKey = (c, code, ch, shift = false) => {   // a key's press, its WM_CHAR unit and its release (validate-terminals-play.mjs)
  if (shift) c.game.inputKey('ShiftLeft', true);
  c.game.inputKey(code, true); c.game.inputChar(ch.charCodeAt(0)); c.game.inputKey(code, false);
  if (shift) c.game.inputKey('ShiftLeft', false);
  c.frames(1);
};
const typeText = (c, text) => { for (const ch of text) typeKey(c, ch === ' ' ? 'Space' : /[0-9]/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, ch, ch !== ch.toLowerCase() && ch !== ' '); };

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

/** Play's text against the measured one (`file` in `dir`), after normalization. */
async function compareText(label, what, dir, file, text) {
  const measured = await measuredText(dir, file);
  const diff = firstTravelTextDifference(measured.text, text, TIMES);
  check(diff === null, `${label}: the text for ${what} differs from the measured at line ${diff?.line}: expected ${JSON.stringify(diff?.expected)}, got ${JSON.stringify(diff?.actual)}`);
  console.log(`${what} text: ${parseTravelText(text).length} records, measured ${parseTravelText(measured.text).length}${diff ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  return measured;
}

/** One New Game through the intro to the Island; the scenario's measured captures decide what is compared. `after({island})` continues in the Island. */
async function scenario(label, { dir, difficulty, customize, leave, capture, logNth, expect, after }) {
  console.log(`--- ${label}`);
  const { c, request } = await startNewGame({ difficulty, customize });
  if (!request) return;
  const oldLog = [...c.game.doors.scriptRuntime.engineLog];

  // 00_Intro: the text for it, the arrival flags, frozen like the capture
  const introText = request.travelInfo[0][1];
  await compareText(label, '00_Intro', dir, `${capture}-intro-frozen`, introText);
  const intro = await arrive('00_Intro', request);
  if (leave === 'escape') typed(intro, 'set LevelInfo bPlayersOnly True');
  const introFlags = flagsOf(intro), measuredIntroFlags = await measuredFlags(dir, `${capture}-intro-frozen`);
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
  const measuredIsland = await compareText(label, 'Island', dir, expect.islandText, request2.travelInfo[0][1]);
  check(request2.travelInfo[0][0] === measuredIsland.key, `${label}: TravelInfo key ${request2.travelInfo[0][0]} (measured ${measuredIsland.key})`);

  // the Island: frozen at arrival, then the first timers
  const island = await arrive('01_NYC_UNATCOIsland', request2);
  if (expect.frozenIsland) typed(island, 'set LevelInfo bPlayersOnly True');
  island.frames(10);
  const atArrival = flagsOf(island);
  if (expect.frozenIsland) {
    const measured = await measuredFlags(dir, expect.islandFrozenFlags);
    check(same(atArrival.flags, measured.flags) && atArrival.defaultExpiration === measured.defaultExpiration,
      `${label}: Island flags at arrival ${JSON.stringify(atArrival)} (measured ${JSON.stringify(measured)})`);
    typed(island, 'set LevelInfo bPlayersOnly False');
  }
  island.frames(180);
  const afterTimer = flagsOf(island), measuredAfter = await measuredFlags(dir, expect.islandLiveFlags);
  check(same(afterTimer.flags, measuredAfter.flags) && afterTimer.defaultExpiration === measuredAfter.defaultExpiration,
    `${label}: Island flags after the first timer ${JSON.stringify(afterTimer)} (measured ${JSON.stringify(measuredAfter)})`);
  console.log('Island flags at arrival:', atArrival.flags.join(' '), `(default expiration ${atArrival.defaultExpiration}); after the first timer:`, afterTimer.flags.join(' '), `(default expiration ${afterTimer.defaultExpiration})`);

  // the engine log
  if (logNth) {   // (a capture whose final.log was cut short by the 8 KB log flush says so with logNth: null)
    const play = [...oldLog.slice(oldLog.lastIndexOf('Log: Export travel for: Player')), ...introLog, ...island.game.doors.scriptRuntime.engineLog];
    const got = play.filter(line => MODELLED.test(line)).map(normalizeLine).join('\n');
    const want = (await measuredLog(dir, logNth)).join('\n');
    check(got === want, `${label}: the engine log differs from the original's (modelled lines):\n--- Play\n${got}\n--- original\n${want}`);
    console.log(`log: ${got.split('\n').length} modelled lines${got === want ? " in the original's order" : ' (DIFFERS)'}`);
  }
  if (after) await after({ island });
}

/** From the Island: the scenario's console lines, `LocalTravel 02_NYC_Street` (the text with the items), 8 s in the Street, `LocalTravel 03_NYC_Airfield`
 * (the text the import of the first leaves to export). `run` makes the state; `framesBefore` is the time the capture spent before it. */
async function twoHops(label, island, { dir, capture, run }) {
  let c = island;
  run(c);
  c.frames(60);
  typed(c, 'LocalTravel 02_NYC_Street'); c.frames(2);
  const toStreet = c.takeTravel();
  if (!check(toStreet?.map === '02_NYC_Street', `${label}: LocalTravel 02_NYC_Street requested ${toStreet?.map}`)) return;
  if (dump) await writeFile(`${dump}/play-${capture}-street.txt`, toStreet.travelInfo[0][1]);
  await compareText(label, 'Street', dir, `${capture}-street-frozen`, toStreet.travelInfo[0][1]);
  c = await arrive('02_NYC_Street', toStreet);
  typed(c, 'set LevelInfo bPlayersOnly True'); c.frames(10);
  const measuredAtStreet = await measuredFlags(dir, `${capture}-street-frozen`), atStreet = flagsOf(c);
  check(same(atStreet.flags, measuredAtStreet.flags) && atStreet.defaultExpiration === measuredAtStreet.defaultExpiration,
    `${label}: Street flags at arrival ${JSON.stringify(atStreet)} (measured ${JSON.stringify(measuredAtStreet)})`);
  // the arrival's own export (before the first timer) is the imported text but for what the arrival consumed or made: the SKTemp flags (consumed by
  // RestoreSkillPoints), PlayerTraveling (kept for the first timer) and the level-dependent fresh managers
  const exported = formatTravelText(c.game.doors.scriptRuntime.travelExporter.exportTravel(c.player()).records);
  const notFlags = text => parseTravelText(text).filter(record => !record.class.startsWith('Extension.')).map(record => ({ ...record, lines: record.lines.filter(line => !line.startsWith('FlagBase=')) }));
  const fixed = firstTravelTextDifference(formatTravelText(notFlags(toStreet.travelInfo[0][1])), formatTravelText(notFlags(exported)), TIMES);
  check(fixed === null, `${label}: the arrival's export is not the imported text (line ${fixed?.line}: expected ${JSON.stringify(fixed?.expected)}, got ${JSON.stringify(fixed?.actual)})`);
  console.log(`fixed point: the Street arrival's export ${fixed === null ? 'equals' : 'DIFFERS from'} the imported text outside the flag records`);
  typed(c, 'set LevelInfo bPlayersOnly False');
  c.frames(480);
  typed(c, 'LocalTravel 03_NYC_Airfield'); c.frames(2);
  const toAirfield = c.takeTravel();
  if (!check(toAirfield?.map === '03_NYC_Airfield', `${label}: LocalTravel 03_NYC_Airfield requested ${toAirfield?.map}`)) return;
  if (dump) await writeFile(`${dump}/play-${capture}-airfield.txt`, toAirfield.travelInfo[0][1]);
  await compareText(label, "the Airfield (the import's export)", dir, `${capture}-airfield-frozen`, toAirfield.travelInfo[0][1]);
}

/** The New Game screen: the right arrow twice, then Lockpicking and Computer raised once (list rows clicked as the pointer does, then Upgrade). */
const portraitAndSkills = async ({ c, driver, scoped }) => {
  scoped(() => driver.pressField('btnRightArrow')); c.frames(5);
  scoped(() => driver.pressField('btnRightArrow')); c.frames(5);
  const click = row => {
    const { x, y } = driver.center({ field: 'lstSkills', row });
    for (const action of [1, 3]) check(c.game.windowPointer({ relative: false, x, y, key: 1, action }) === true, 'the root takes the pointer sample');
    c.frames(3);
  };
  click(3); scoped(() => driver.pressField('btnUpgrade')); c.frames(5);   // Lockpicking (the list is sorted by name)
  click(0); scoped(() => driver.pressField('btnUpgrade')); c.frames(5);   // Computer
};
/** The name typed over the selected "JC Denton" (the edit window holds the focus with its text selected), one portrait step, Medicine raised once. */
const nameAndMedicine = async ({ c, driver, scoped }) => {
  typeText(c, 'Test Agent'); c.frames(5);
  scoped(() => driver.pressField('btnRightArrow')); c.frames(5);
  const { x, y } = driver.center({ field: 'lstSkills', row: 4 });
  for (const action of [1, 3]) check(c.game.windowPointer({ relative: false, x, y, key: 1, action }) === true, 'the root takes the pointer sample');
  c.frames(3);
  scoped(() => driver.pressField('btnUpgrade')); c.frames(5);   // Medicine
};

const CAPTURED = { A: 'nw0', B: 'nw0', C: 'nw0', D: 'nw0', E: 'nw1', F: 'nw2', G: 'nw3' };
const wanted = id => (!only || only === id) && (existsSync(`${captureRoot}${CAPTURED[id]}/final.log`) || (console.log(`SKIP ${id}: no ${CAPTURED[id]} captures`), false));

if (wanted('A')) {
  await scenario('A: defaults (Medium), Escape', { dir: 'nw0', difficulty: 1, leave: 'escape', capture: 'n1b', logNth: 2,
    expect: { islandText: 'n1b-island-frozen', frozenIsland: true, islandFrozenFlags: 'n1b-island-frozen', islandLiveFlags: 'n1b-island-live' } });
}
if (wanted('B')) {
  await scenario('B: Hard, portrait 2, Lockpicking and Computer raised, Escape', { dir: 'nw0', difficulty: 2, customize: portraitAndSkills, leave: 'escape', capture: 'n2', logNth: 3,
    expect: { islandText: 'n2-island-frozen', frozenIsland: true, islandFrozenFlags: 'n2-island-frozen', islandLiveFlags: 'n2-island-live' } });
}
if (wanted('C')) {
  await scenario("C: defaults (Medium), the intro's own end", { dir: 'nw0', difficulty: 1, leave: 'end', capture: 'n1', logNth: 1,
    expect: { islandText: 'n3-natural-island', frozenIsland: false, islandFrozenFlags: null, islandLiveFlags: 'n3-natural-island' } });
}
if (wanted('D')) {
  // 45 s on the Island, then the cheat console lines (credits, skills, augmentations, images, a NanoKeyInfo, a note, a goal)
  await scenario('D: defaults, the cheats, two travels', { dir: 'nw0', difficulty: 1, leave: 'escape', capture: 'n4', logNth: 4,
    expect: { islandText: 'n4-island-frozen', frozenIsland: true, islandFrozenFlags: 'n4-island-frozen', islandLiveFlags: 'n4-island-live' },
    after: ({ island }) => { island.frames(2520);
      return twoHops('D', island, { dir: 'nw0', capture: 'n4', run: c => {
        for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', 'AllCredits', 'AllSkills', 'AllAugs', 'AllImages', 'GiveNanoKey TestKeyA "Test key A"',
          'NoteAdd "A first note"', 'GoalAdd GoalOne "Reach the dock" 1']) { typed(c, line); c.frames(30); } } }); } });
}
if (wanted('E')) {
  await scenario('E: Realistic, a typed name, a portrait, Medicine, item properties, keys, notes and goals, two travels', { dir: 'nw1', difficulty: 3, customize: nameAndMedicine, leave: 'escape', capture: 'n5', logNth: 1,
    expect: { islandText: 'n5-island-frozen', frozenIsland: true, islandFrozenFlags: 'n5-island-frozen', islandLiveFlags: 'n5-island-live' },
    after: ({ island }) => { island.frames(1500);
      return twoHops('E', island, { dir: 'nw1', capture: 'n5', run: c => {
        for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', 'set DeusEx.DeusExWeapon ClipCount 3', 'set DeusEx.DeusExWeapon ModBaseAccuracy 0.25',
          'set DeusEx.DeusExAmmo AmmoAmount 17', 'set DeusEx.DeusExPickup NumCopies 3', 'set DeusEx.DeusExWeapon bHasLaser True', 'AllCredits',
          'GiveNanoKey KeyOne "Key one"', 'GiveNanoKey KeyTwo "Key two"', 'NoteAdd "Second note"', 'NoteAdd "Third note"', 'GoalAdd GoalA "Goal A"', 'GoalAdd GoalB "Goal B"']) { typed(c, line); c.frames(30); } } }); } });
}
if (wanted('F')) {
  // the Island's soda can, liquor bottle and crowbar, each picked up by placing the player where the view trace selects it (the poses were found in
  // Play with the fixture and typed into the original: `ghost`, `set JCDentonMale Location`, `walk`, `set JCDentonMale ViewRotation`) and ParseRightClick
  const POSES = [['-4172.58447265625', '10127.3134765625', '-256.20001220703125', 54687], ['-4195.2841796875', '10087.5625', '-256.20001220703125', 54873],
    ['-3569.1923828125', '10530.1572265625', '-248.1999969482422', 54510]];
  await scenario('F: defaults, three pickups by the real frob path, two travels', { dir: 'nw2', difficulty: 1, leave: 'escape', capture: 'n6', logNth: 1,
    expect: { islandText: 'n6-island-frozen', frozenIsland: true, islandFrozenFlags: 'n6-island-frozen', islandLiveFlags: 'n6-picked' },
    after: ({ island }) => { island.frames(420);
      return twoHops('F', island, { dir: 'nw2', capture: 'n6', run: c => {
        typed(c, 'set DeusEx.JCDentonMale bCheatsEnabled True'); c.frames(30);   // `ghost` is a cheat: without it `set Location` moves a hashed pawn (the original's LoadMap then dies: "moved without proper hashing")
        for (const [x, y, z, pitch] of POSES) {
          typed(c, 'ghost'); typed(c, `set JCDentonMale Location (X=${x},Y=${y},Z=${z})`); typed(c, 'walk'); typed(c, `set JCDentonMale ViewRotation (Pitch=${pitch},Yaw=32768,Roll=0)`);
          c.frames(180); typed(c, 'ParseRightClick'); c.frames(120);
        } } }); } });
}

if (wanted('G')) {
  // A again with the "train first?" box on the path (`set DeusEx.DeusExPlayer bAskedToTrain False` typed into the original, which then showed the box with Yes and
  // No; No went on to the difficulty screen), and the first Escape on the Island: ShowMainMenu returns at once because the text carried bIgnoreNextShowMenu (the
  // original's screenshot shows the game view), the second opens MenuMain over the Island with Save Game and Back to Game enabled.
  await scenario('G: the train box answered No, Escape, then Escape twice on the Island', { dir: 'nw3', difficulty: 1, leave: 'escape', capture: 'n7', logNth: null,
    expect: { islandText: 'n7-island-frozen', frozenIsland: true, islandFrozenFlags: 'n7-island-frozen', islandLiveFlags: 'n7-island-live' },
    after: ({ island }) => {
      const driver = createMenuDriver(island.game);
      check(island.read(island.player(), 'bIgnoreNextShowMenu') === true, 'G: the Island player carries bIgnoreNextShowMenu');
      island.key('Escape'); island.frames(20);
      check(driver.top() === null, `G: the first Escape on the Island opened ${driver.top()} (the original opened nothing)`);
      check(island.read(island.player(), 'bIgnoreNextShowMenu') === false, 'G: the first ShowMainMenu clears bIgnoreNextShowMenu');
      island.key('Escape'); island.frames(20);
      check(driver.top() === 'deusex.menumain', `G: the second Escape on the Island opened ${driver.top()} (the original: MenuMain)`);
      console.log('Escape twice on the Island: nothing, then MenuMain'); } });
}

if (failures.length) { console.log(`FAIL validate-travel-newgame:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel-newgame: the New Game path (menu, intro, Island) and the items it carries match the measured original');
