/** Map travel in Play against the measured original (docs/travel.md "Proposed implementation order", step 1), headless.
 *
 * The reference is the captures under .work/travel (outside Git: the original under Wine, tools/dump-travel-win.c, scripts/travel-probe.sh).
 * Scenario A is the menu's Training button on the logo map: DX.dx, Escape, MenuMain, winButtons[4] -> DeusExPlayer.StartTrainingMission ->
 * SendPlayer -> ClientTravel. Scenario B is the console `LocalTravel 00_TrainingCombat` from the logo map (the same ClientTravel with the
 * player's augmentations still in place: the measured 96-record text). Each runs the recovered chain in Play's headless session:
 *   - the exported text equals the measured one after normalization (pointers and instance numbers; travel-text.mjs);
 *   - Browse takes the measured branch and the next level's request is the measured URL;
 *   - the new session (the page's loadMap in the browser) imports the text: the player's flags are {PlayerTraveling} before the first
 *     mission timer and the measured set after it, with no host-supplied marker;
 *   - the engine log holds the original's lines in the original's order (the lines Play models: the measured log filtered to them);
 *   - the text exported again from the arrived player is a fixed point of the import (same records and values), apart from what the
 *     arrival changed (documented per scenario).
 * Mission00.FirstFrame's effect (UNATCOTroop2 knocked out into a carcass) is checked in scenario A.
 *
 *   node scripts/validate-travel.mjs [--only A|B] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { travelTextOfDump, firstTravelTextDifference, parseTravelText, normalizeTravelText } from '../src/runtime/travel-text.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/', import.meta.url).pathname;
if (!existsSync(`${captures}s2/s5-training-menu.travel.txt`)) { console.log('SKIP validate-travel: the measured captures are not in .work/travel (outside Git)'); process.exit(0); }

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

/** The lines Play models, normalized to compare across sessions: object paths lose their package and instance number. */
const MODELLED = /^(Log: (Unloading: Package DX$|Export travel for|Browse:|Doing load, not loadgame|Current mission number|Attempting to get player|LoadMap:|Game class is|Bringing Level|Spawning new actor|Possessed PlayerPawn)|ScriptLog: (InitGame|Base Mutator|DeusExLevelInfo - Spawned new mission script|Login:|All inventory|\*\*\*\* InitStateMachine))/;
const normalizeLine = line => line.replace(/\b(?:TrainingRuntime|DX|00_Training|00_TrainingCombat)\.(\w+?)\d+\b/g, '$1#').replace(/\b(\w+?)\d+\b(?= started mission)/g, '$1#')
  .replace(/Level (?:DX|00_Training|00_TrainingCombat)\.MyLevel/, 'Level <map>.MyLevel').replace(/Unloading: Package DX/, 'Unloading: Package DX').replace(/\s+$/, '');

/** The measured log's modelled lines of the travel whose `Browse:` line is `browseLine` (the `occurrence`th, counting from 1): from the
 * DeleteSaveGameFiles `Unloading` before its `Export travel` line (when the script made one) to the new level's InitStateMachine. */
async function measuredLog(file, browseLine, occurrence) {
  const lines = (await readFile(`${captures}${file}`, 'utf8')).split(/\r?\n/);
  let browse = -1;
  let seen = 0;
  for (let i = 0; i < lines.length && browse < 0; i++) if (lines[i] === browseLine && ++seen === occurrence) browse = i;
  assert.ok(browse >= 0, `${file} has no ${browseLine}`);
  let start = browse - 1;
  assert.equal(lines[start], 'Log: Export travel for: Player', `${file}: the Export travel line precedes the Browse line`);
  if (lines[start - 1] === 'Log: Unloading: Package DX') start--;
  let end = lines.length;
  for (let i = browse; i < lines.length; i++) if (/InitStateMachine/.test(lines[i])) { end = i + 1; break; }
  return lines.slice(start, end).filter(line => MODELLED.test(line)).map(normalizeLine);
}

async function flow(name, begin, { measuredFile, measuredLogFile, browseLine, occurrence, flagsAfter }) {
  console.log(`--- ${name}`);
  const { c } = await openSession('DX', assets, { travel: {} });
  c.frames(120);
  begin(c);
  // the travel step runs after the next tick (UGameEngine::Tick): the level left ticks once more
  c.frames(2);
  const request = c.takeTravel();
  if (!check(request, `${name}: the tick's travel step made no request for the next level`)) return;
  const oldLog = c.game.doors.scriptRuntime.engineLog;
  check(request.map === '00_Training' || request.map === '00_TrainingCombat', `${name}: next map ${request.map}`);
  console.log(`request: ${request.url}, ${request.travelInfo.length} pair(s), text ${request.travelInfo[0]?.[1].length} bytes`);

  // 1. the exported text
  const text = request.travelInfo[0][1], records = parseTravelText(text);
  const measured = travelTextOfDump(await readFile(`${captures}${measuredFile}`, 'utf8'));
  const measuredRecords = parseTravelText(measured.text).length;
  const difference = firstTravelTextDifference(measured.text, text);
  check(difference === null, `${name}: the exported text differs from the measured at line ${difference?.line}: expected ${JSON.stringify(difference?.expected)}, got ${JSON.stringify(difference?.actual)}`);
  console.log(`text: ${records.length} records, measured ${measuredRecords}${difference ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  check(request.travelInfo[0][0] === measured.key, `${name}: TravelInfo key ${request.travelInfo[0][0]} (measured ${measured.key})`);

  // 2. the arrival: a new session, as the page's loadMap makes it
  const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL } });
  const p = d.player();
  const flags = () => [...(d.read(p, 'FlagBase')?.entries?.values() ?? [])].map(e => `${e.name}${e.type ? `=${e.value}` : ''}@${e.expiration}`).sort();
  const atArrival = d.game.doors.scriptRuntime.travelExporter.exportTravel(p).records;
  const before = flags();
  console.log('flags at arrival (before the first timer):', before.join(' '));
  check(JSON.stringify(before) === JSON.stringify(['PlayerTraveling@0']), `${name}: flags at arrival ${before}`);
  d.frames(120);
  const after = flags();
  console.log('flags after the first timer:', after.join(' '));
  check(JSON.stringify(after) === JSON.stringify(flagsAfter), `${name}: flags after the timer ${after} (expected ${flagsAfter})`);
  d.frames(280);
  const troop = d.actor('UNATCOTroop2'), carcass = d.byClass('UNATCOTroopCarcass');
  console.log('UNATCOTroop2:', troop ? d.state(troop) : 'gone', 'carcasses', carcass.map(a => a.name).join(','));

  // 3. the log
  const expected = await measuredLog(measuredLogFile, browseLine, occurrence);
  {
    // the travel's lines: from the DeleteSaveGameFiles `Unloading` the script made (or, when Browse made it, from `Export travel`)
    const exported = oldLog.lastIndexOf('Log: Export travel for: Player');
    const mark = oldLog[exported - 1] === 'Log: Unloading: Package DX' ? exported - 1 : exported;
    const own = [...oldLog.slice(mark < 0 ? 0 : mark), ...d.game.doors.scriptRuntime.engineLog].filter(line => MODELLED.test(line)).map(normalizeLine);
    // The cold login's own lines (the logo map's Login, InitGame ...) precede the Unloading line: they are not in the slice.
    const got = own.join('\n'), want = expected.join('\n');
    check(got === want, `${name}: the engine log differs from the original's (modelled lines):\n--- Play\n${got}\n--- original\n${want}`);
    console.log(`log: ${own.length} modelled lines${got === want ? ' in the original\'s order' : ' (DIFFERS)'}`);
  }

  // 4. what the arrival holds (the export of the arrived player, before the first timer) contains the text that was imported: every property
  // line of every record is there. It may hold more: SpawnPlayActor's pass 2 writes only the lines the text has, so a spawned actor keeps what
  // its own startup set (SkillWeaponPistol.PreBeginPlay's CurrentLevel = 1, which ResetSkills had put back to the class default 0 in the
  // text). The flag objects are left out (the arrival consumed the SKTemp_SkillPoints flags); the augmentation manager is left out of A,
  // whose text carries none (ResetPlayer(True) removed it) and whose arrived player keeps the one Login made.
  const strip = (records, augs) => records.filter(record => !record.class.startsWith('Extension.') && !(augs && /^DeusEx\.Aug/.test(record.class)))
    .map(record => ({ ...record, lines: record.lines.filter(line => !(augs && line.startsWith('AugmentationSystem='))) }));
  const augs = name.startsWith('A');
  const recordsOf = lines => { const out = []; for (const line of lines) { if (line.startsWith('Class=')) out.push([line]); else if (line !== '{' && line !== '}') out.at(-1).push(line); } return out; };
  const a = recordsOf(normalizeTravelText(strip(parseTravelText(text), augs)).split('\n')), b = recordsOf(normalizeTravelText(strip(atArrival, augs)).split('\n'));
  check(a.length === b.length, `${name}: the arrival holds ${b.length} non-flag records, the text ${a.length}`);
  const missing = [], extra = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const have = new Set(b[i]), wanted = new Set(a[i]);
    for (const line of a[i]) if (!have.has(line)) missing.push(`${a[i][0]}: ${line}`);
    for (const line of b[i]) if (!wanted.has(line)) extra.push(`${a[i][0].replace(/^Class=(\S+).*/, '$1')}: ${line}`);
  }
  check(missing.length === 0, `${name}: the arrival lacks lines of the imported text: ${missing.slice(0, 4).join(' | ')}`);
  console.log(`import: ${b.length} non-flag records; every line of the text is in the arrival${missing.length ? ' (NOT)' : ''}; the arrival adds ${extra.length} line(s)${extra.length ? `: ${[...new Set(extra)].slice(0, 6).join(', ')}` : ''}`);
  return { carcass: carcass.length, troop: troop ? d.state(troop) : 'gone' };
}

if (!only || only === 'A') {
  const result = await flow('A: menu Training', c => {
    c.key('Escape'); c.frames(20);
    const driver = createMenuDriver(c.game);
    assert.equal(driver.top(), 'deusex.menumain', 'Escape opens the original main menu');
    c.game.hud.scoped(() => driver.pressButton(4));
  }, { measuredFile: 's2/s5-training-menu.travel.txt', measuredLogFile: 's4/f2-space-portal.log', occurrence: 2,
    browseLine: 'Log: Browse: 00_Training?Name=Player?Class=DeusEx.JCDentonMale', flagsAfter: ['M00_TRAINING_StartupText@1', 'M0MissionStart@1'] });
  if (result) check(result.carcass === 1, `A: FirstFrame's effect: ${result.carcass} UNATCOTroopCarcass (expected 1)`);
}
if (!only || only === 'B') {
  await flow('B: LocalTravel 00_TrainingCombat', c => { c.exec('LocalTravel 00_TrainingCombat'); }, { measuredFile: 'r1/dx-to-combat.travel.txt',
    measuredLogFile: 's1/c2-training.log', occurrence: 1, browseLine: 'Log: Browse: 00_TrainingCombat?Name=Player?Class=DeusEx.JCDentonMale',
    flagsAfter: ['M0MissionStart@1'] });
}

if (failures.length) { console.log(`FAIL validate-travel:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel: the exported text, the Browse branch, the arrival flags, the log order and the import match the measured original');
