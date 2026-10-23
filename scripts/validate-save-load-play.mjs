/** Stage 6 row 6.2.2: a game saved in Play and loaded in Play is the saved game, and the original loads the same slot to the same state.
 *
 * The played state is mission 1's placed chain (scripts/chains/mission01.mjs) to the snapshot after the commander (`b3-commander`: MeetPaul and MeetTerrorist
 * played, their history, goals and notes, the rifle, the mission-complete pass), then every augmentation, skill and image and a nano key by the cheat lines of
 * the travel captures (`AllAugs`, `AllSkills`, `AllImages`, `GiveNanoKey`; the chain has already turned the cheats on). The level is frozen
 * (`set LevelInfo bPlayersOnly True`, as the captures freeze it) and the console's `SaveGame 13` writes Save0013; the saving session then leaves by
 * `LocalTravel 01_NYC_UNATCOHQ`, whose travel text is the saved player's every travel property. The slot is written to .work/play-saves-622/ (outside Git).
 *
 * Then the slot is loaded in Play as a desktop slot is (scripts/validate-load-game.mjs: from 00_TrainingCombat, frozen, `LoadGame 13`) and compared with
 * the saving session: the flags (name, type, expiration, value), the player's place, rotation, health and physics (the view rotation is the saved Rotation:
 * GameInfo.Login's ClientSetRotation, measured), the actor census (class
 * and name; the mission script the load spawns apart) and the travel text the loaded player exports by the same LocalTravel (after the normalization of
 * docs/travel.md: pointers, instance numbers, the two frame-time values). The original's load of the same slot is validate-load-game.mjs scenario P
 * (its capture sl1: scripts/travel-probe.sh puts the slot into the prefix as Save0013, `LoadGame 13` from Training Combat, the dumps): run after this.
 *
 * runner-timeout: 1500
 *
 *   node scripts/validate-save-load-play.mjs [--keep-slot] */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, runChainInPlay, typeLine } from './chain-play.mjs';
import { loadChain } from './chain-lib.mjs';
import { openSession } from './census-stage5-session.mjs';
import { firstTravelTextDifference, parseTravelText } from '../src/runtime/travel-text.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-save-load-play: no installed game data'); process.exit(0); }
const OUT = new URL('../.work/play-saves-622/', import.meta.url).pathname;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const snapshotSource = ({ pitch, height }) => Uint8Array.from({ length: pitch * height }, (_, i) => (i % pitch < 160 && (i / pitch | 0) < 120) ? ((i % pitch) + (i / pitch | 0)) & 255 : 0);
const isScript = name => /^Mission\d+$/.test(name);
/** A line through the viewport's Exec chain (PlayerPawn.ConsoleCommand: SaveGame and set are engine commands, not script exec functions). */
const consoleLine = (c, line) => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));

/** What a level session holds of the saved game. */
function stateOf(c) {
  const p = c.player();
  const store = c.read(p, 'FlagBase');
  return {
    flags: [...(store?.entries?.values() ?? [])].map(e => `${e.name}|${e.type}|${e.expiration}|${e.value | 0}`).sort(), defaultExpiration: store?.defaultExpiration ?? null,
    player: { location: c.pos(p).map(Math.fround), rotation: c.read(p, 'Rotation'), viewRotation: c.read(p, 'ViewRotation'), health: c.read(p, 'Health'), physics: c.read(p, 'Physics') },
    actors: c.actors().filter(a => !isScript(a.name)).map(a => `${c.runtime.instance(a).cls.record.name}.${a.name}`).sort(),
  };
}
function leave(c, map) {
  c.exec(`LocalTravel ${map}`); c.frames(2);
  return c.takeTravel();
}

const assets = await loadAssets();
// 1. the played state and the save
const run = await runChainInPlay(await loadChain('01'), { assets, until: 'b3-commander', sessionTravel: { snapshotSource } });
const c = run.session, directory = run.saveDirectory;
for (const line of ['AllAugs', 'AllSkills', 'AllImages', 'GiveNanoKey TestKeyA "Test key A"']) { typeLine(c, line); c.frames(30); }
c.frames(120);
consoleLine(c, 'set LevelInfo bPlayersOnly True'); c.frames(30);
const saved = stateOf(c);
consoleLine(c, 'SaveGame 13'); c.frames(5);
check(directory.hasFile('Save0013', 'SaveInfo.dxs'), 'SaveGame 13 left no Save0013\\SaveInfo.dxs');
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}Save0013`, { recursive: true });
for (const { name } of directory.files('Save0013')) await writeFile(`${OUT}Save0013/${name}`, directory.readFile('Save0013', name));
const savedLeave = leave(c, '01_NYC_UNATCOHQ');
check(savedLeave, 'the saving session did not travel');
await writeFile(`${OUT}saved.json`, JSON.stringify({ ...saved, export: savedLeave?.travelInfo?.[0]?.[1] ?? null }, null, 1));
const items = parseTravelText(savedLeave.travelInfo[0][1]);
console.log(`saved: Save0013 (${directory.files('Save0013').map(file => file.name).join(', ')}); ${saved.flags.length} flags, ${saved.actors.length} actors, ${items.length} travel records`);

// 2. the slot loaded in Play, as a desktop slot is loaded (validate-load-game.mjs)
const { c: from } = await openSession('00_TrainingCombat', assets, { travel: {}, saveDirectory: directory });
from.frames(60);
consoleLine(from, 'set LevelInfo bPlayersOnly True');
from.exec('LoadGame 13'); from.frames(2);
const request = from.takeTravel();
if (!check(request?.map === '01_NYC_UNATCOIsland', `LoadGame 13 requested ${request?.map}`)) { console.log(`FAIL validate-save-load-play:\n  ${failures.join('\n  ')}`); process.exit(1); }
const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource }, saveDirectory: directory });
consoleLine(d, 'set LevelInfo bPlayersOnly True');
d.frames(2);
const loaded = stateOf(d);
check(JSON.stringify(loaded.flags) === JSON.stringify(saved.flags), `flags: loaded ${loaded.flags.length}, saved ${saved.flags.length}; only loaded ${loaded.flags.filter(f => !saved.flags.includes(f)).slice(0, 6)}; only saved ${saved.flags.filter(f => !loaded.flags.includes(f)).slice(0, 6)}`);
check(loaded.defaultExpiration === saved.defaultExpiration, `the default expiration ${loaded.defaultExpiration} (saved ${saved.defaultExpiration})`);
// GameInfo.Login finds the saved pawn and calls ClientSetRotation(Rotation): the loaded ViewRotation is the pawn's Rotation (the saved view's pitch goes;
// measured in the original, docs/travel.md "Play, step 4: loading a saved game": saved (8293,-16162,0), loaded (0,-16162,0))
const expected = { ...saved.player, viewRotation: saved.player.rotation };
for (const key of Object.keys(expected))
  check(JSON.stringify(loaded.player[key]) === JSON.stringify(expected[key]), `player ${key}: loaded ${JSON.stringify(loaded.player[key])}, expected ${JSON.stringify(expected[key])} (saved ${JSON.stringify(saved.player[key])})`);
const onlyLoaded = loaded.actors.filter(a => !saved.actors.includes(a)), onlySaved = saved.actors.filter(a => !loaded.actors.includes(a));
check(!onlyLoaded.length && !onlySaved.length, `actor census: only loaded ${onlyLoaded.slice(0, 8)} (${onlyLoaded.length}); only saved ${onlySaved.slice(0, 8)} (${onlySaved.length})`);
check(d.actors().filter(a => isScript(a.name)).length === 1, 'the loaded level holds no mission script, or more than one');
check(!d.read(d.player(), 'bCheatsEnabled'), 'the loaded player has bCheatsEnabled on (not a saved property)');
const loadedLeave = leave(d, '01_NYC_UNATCOHQ');
if (check(loadedLeave, 'the loaded level did not travel')) {
  const difference = firstTravelTextDifference(savedLeave.travelInfo[0][1], loadedLeave.travelInfo[0][1], { times: true });
  check(difference === null, `the loaded player's export differs from the saved one at line ${difference?.line}: saved ${JSON.stringify(difference?.expected)}, loaded ${JSON.stringify(difference?.actual)}`);
  console.log(`loaded: ${loaded.flags.length} flags, ${loaded.actors.length} actors, export ${parseTravelText(loadedLeave.travelInfo[0][1]).length} records${difference ? ' (DIFFERS)' : ' (equal to the saved export after normalization)'}`);
}
if (failures.length) { console.log(`FAIL validate-save-load-play:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-save-load-play: the slot Play saved loads in Play as the saved game (flags, player, actors, every travel property)');
process.exit(0);
