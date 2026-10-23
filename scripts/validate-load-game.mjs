/** Loading a saved game in Play against the measured original (docs/travel.md "Play, step 4: loading a saved game"), headless.
 *
 * Each scenario loads one slot in Play and compares the loaded state with what the original showed after `LoadGame N` of the same slot (captures under
 * .work/travel, outside Git: scripts/save-probe.sh, tools/dump-flags-win.c, dump-actor-win.c, dump-gobjects-win.c, dump-travel-win.c):
 *   - the engine log from `Browse:` to `Initialized moving brush tracker` (the lines Play models, in the original's order);
 *   - the player's flags, location, rotation, view rotation, health and physics;
 *   - the travel text the loaded player exports when it leaves the level (`LocalTravel`): every travel property of the player and of the
 *     objects it holds (inventory, ammo, mods, augmentations, skills, notes, goals, keys, images, conversation history);
 *   - the actor census against the original's GObjObjects (class and name of every actor class Play holds);
 *   - the loaded level ran no begin-play pass, holds one player pawn, keeps the TravelInfo its file holds.
 *
 * I   the Island slot the original wrote itself (SaveGame 77, session o1e: troops killed, MeetPaul played, notes, goals, keys, every augmentation and
 *     skill, a fired pistol), loaded from HQ
 * T   the old desktop slot Save0001 of the Wine prefix (Training, 2026-09-12), loaded from Training Combat (session w1)
 * Q   the same prefix's QuickSave (slot -1)
 * N, H, G  three third-party slots (.work/internet-saves, SOURCES.md): the Island (Save0002), Hong Kong Market (Save0016) and the GOTY Area 51
 *     slot (retromaggedon Save0035), loaded in the original by session w1 from Training Combat
 * P   the slot Play saved itself (scripts/validate-save-load-play.mjs, Stage 6 row 6.2.2), loaded in the original by session sl1 from Training Combat
 *
 *   node scripts/validate-load-game.mjs [--only I|T|Q|N|H|G|P] */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { travelTextOfDump, firstTravelTextDifference, parseTravelText } from '../src/runtime/travel-text.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-load-game: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/', import.meta.url).pathname;
const INTERNET = process.env.DX_INTERNET_SAVES ?? '/home/rydgel/projects/deus_ex_web/.work/internet-saves';
// the desktop slots of the Wine capture: the copy kept in .work/real-saves (the prefix's own Save folder is rewritten by other sessions)
const PREFIX_SAVES = process.env.DX_SAVE_DIR ?? new URL('../.work/real-saves', import.meta.url).pathname;

const SCENARIOS = {
  I: { title: 'the Island slot the original wrote (SaveGame 77), loaded from HQ', capture: 'o1e', label: 'b', slotDir: `${captures}o1e/b-slot.Save0077`, index: 77,
    from: '01_NYC_UNATCOHQ', leave: '01_NYC_UNATCOHQ', freezeBefore: true },
  T: { title: 'the old desktop slot Save0001 (Training), loaded from Training Combat', capture: 'w1', label: 'w-old1', slotDir: path.join(PREFIX_SAVES, 'Save0001'), index: 1,
    from: '00_TrainingCombat', leave: '00_TrainingCombat', freezeBefore: true },
  Q: { title: 'the QuickSave slot (-1), loaded from Training Combat', capture: 'w1', label: 'w-oldq', slotDir: path.join(PREFIX_SAVES, 'QuickSave'), index: -1,
    from: '00_TrainingCombat', leave: '00_TrainingCombat', freezeBefore: true },
  N: { title: 'nicouzouf Save0002 (Island), loaded from Training Combat', capture: 'w1', label: 'w-nico2', slotDir: `${INTERNET}/nicouzouf/files/Deus Ex/Save0002`, index: 201,
    from: '00_TrainingCombat', leave: '00_TrainingCombat', freezeBefore: true },
  H: { title: 'nicouzouf Save0016 (Hong Kong Market), loaded from Training Combat', capture: 'w1', label: 'w-nico16', slotDir: `${INTERNET}/nicouzouf/files/Deus Ex/Save0016`, index: 202,
    from: '00_TrainingCombat', leave: '00_TrainingCombat', freezeBefore: true },
  G: { title: 'retromaggedon Save0035 (GOTY Area 51 Final), loaded from Training Combat', capture: 'w1', label: 'w-retro35', slotDir: `${INTERNET}/retromaggedon/files/Save0035`, index: 203,
    from: '00_TrainingCombat', leave: '00_TrainingCombat', freezeBefore: true },
  // Stage 6 row 6.2.2: the slot Play saved (scripts/validate-save-load-play.mjs: mission 1's chain to the commander, every augmentation, skill and image), the
  // capture taken on the Mac's bottle by scripts/travel-steps/sl1-play-slot.steps
  P: { title: 'the slot Play saved (Save0013: the Island after the commander), loaded from Training Combat', capture: 'sl1', label: 'p',
    slotDir: new URL('../.work/play-saves-622/Save0013', import.meta.url).pathname, index: 13, from: '00_TrainingCombat', leave: '01_NYC_UNATCOHQ', freezeBefore: true },
};
// Each scenario opens two level sessions: one process per scenario keeps the heap of each bounded.
if (!only) {
  const { spawnSync } = await import('node:child_process');
  let failed = 0;
  for (const id of Object.keys(SCENARIOS)) {
    const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--only', id], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
  console.log(failed ? `FAIL validate-load-game: ${failed} of ${Object.keys(SCENARIOS).length} scenarios failed` : 'PASS validate-load-game: every scenario');
  process.exit(failed ? 1 : 0);
}
const wanted = [only];
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

/** A slot directory of the capture as the page's storage lists it, with the bytes (a headless run has no page to fetch them). */
async function slotFromDirectory(dir, name) {
  const entries = [];
  for (const file of await readdir(dir)) entries.push({ name: file, bytes: new Uint8Array(await readFile(`${dir}/${file}`)) });
  const info = entries.find(entry => entry.name === 'SaveInfo.dxs');
  return { directory: name, files: entries, info: info ? parseSaveInfo(info.bytes) : null };
}

/** `flag NAME type T expiration E value 0xV bucket B` lines of tools/dump-flags-win.c. */
function originalFlags(text) {
  return text.split(/\r?\n/).map(line => /^\s+flag (\S+) type (\d+) expiration (-?\d+) value 0x([0-9a-f]+)/.exec(line)).filter(Boolean)
    .map(([, name, type, expiration, value]) => `${name}|${type}|${expiration}|${parseInt(value, 16) | 0}`).sort();
}
/** The JCDentonMale row of dump-actor-win.c with explicit fields: `Location=(x,y,z) Rotation=(p,y,r) ... Health=0x64 Physics=1`. */
function originalPlayer(text) {
  const line = text.split(/\r?\n/).find(row => /^JCDentonMale JCDentonMale\d+ /.test(row));
  const triple = name => new RegExp(`${name}=\\(([^)]*)\\)`).exec(line)[1].split(',').map(Number);
  return { location: triple('Location').map(Math.fround), rotation: triple('Rotation'), viewRotation: triple('ViewRotation'),
    health: parseInt(/Health=0x([0-9a-f]+)/.exec(line)[1], 16), physics: Number(/Physics=(\d+)/.exec(line)[1]) };
}
/** `slot N index N ptr 0x... Class.Name` lines of tools/dump-gobjects-win.c: the objects of GObjObjects. */
const originalObjects = text => text.split(/\r?\n/).map(line => /^slot\s+(\d+) index\s+\d+ ptr 0x[0-9a-f]+ (\S+?)\.(\S+)$/.exec(line)).filter(Boolean).map(([, slot, cls, name]) => [cls, name, Number(slot)]);

const MODELLED = /^(Log: (Browse:|Doing loadgame|Loading: Package saveInfo|Unloading: Package|LoadMap:|Spawning new actor|Possessed PlayerPawn|Game class is|Bringing Level)|Init: (Shut down|Initialized) moving brush tracker|Warning: |ScriptLog: (Login:|All inventory|DeusExLevelInfo - Spawned|InitGame|Base Mutator|\*\*\*\* InitStateMachine))/;
const normalize = line => line.replace(/(Possessed PlayerPawn: \w+ )\S*?\.\w+?\d+$/, '$1<pawn>').replace(/\s+$/, '');
/** The lines the collection of the old level prints and the tracker shutdown are the original's own garbage collection, which Play does not model
 * (docs/travel.md "Unresolved" 10 and 11); only the left level's `Unloading` stays. */
const modelled = (lines, leftPackage) => lines.filter(line => MODELLED.test(line) && !/^Init: Shut down/.test(line)
  && !(/^Log: Unloading: Package/.test(line) && !line.endsWith(` ${leftPackage}`))).map(normalize);

async function scenario(id) {
  const spec = SCENARIOS[id];
  const cap = `${captures}${spec.capture}/`;
  if (!existsSync(`${cap}${spec.label}-loaded.flags.txt`) || !existsSync(path.join(spec.slotDir, 'SaveInfo.dxs'))) { console.log(`--- ${id}: SKIP (the capture or the slot is not here)`); return; }
  console.log(`--- ${id}: ${spec.title}`);
  const slotName = spec.index === -1 ? 'QuickSave' : `Save${String(spec.index).padStart(4, '0')}`;
  const directory = createSaveDirectory({ saves: [await slotFromDirectory(spec.slotDir, slotName)] });
  const { c } = await openSession(spec.from, assets, { travel: {}, saveDirectory: directory });
  c.frames(60);
  if (spec.freezeBefore) c.exec('set LevelInfo bPlayersOnly True');       // the captures' freeze: the class default carries into the loaded level
  c.exec(`LoadGame ${spec.index}`); c.frames(2);
  const request = c.takeTravel();
  if (!check(request, `${id}: LoadGame ${spec.index} made no request for the next level`)) return;
  console.log(`request: ${request.url}, restore ${JSON.stringify(request.restore)}`);
  check(request.url.startsWith('..\\Save\\Current\\') && request.url.endsWith('.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale'), `${id}: LoadMap URL ${request.url}`);
  check(request.travelInfo.length === 0, `${id}: ${request.travelInfo.length} travel pair(s) in a loaded game's request`);
  const currentNames = directory.files('Current').map(file => file.name).sort();
  const slotNames = directory.files(slotName).map(file => file.name).sort();
  check(JSON.stringify(currentNames) === JSON.stringify(slotNames), `${id}: Current holds ${currentNames} (the slot: ${slotNames})`);

  const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
  d.exec('set LevelInfo bPlayersOnly True');
  d.frames(2);
  const p = d.player();
  // 1. the log
  const log = d.game.doors.scriptRuntime.engineLog, oldLog = c.game.doors.scriptRuntime.engineLog;
  const browse = oldLog.findIndex(line => line.startsWith('Log: Browse: Index.dx?loadgame='));
  const measured = (await readFile(`${cap}final.log`, 'utf8')).split(/\r?\n/);
  const at = measured.findIndex(line => line.startsWith(`Log: Browse: Index.dx?loadgame=${spec.index}?`));
  let end = measured.length;
  for (let i = at; i < measured.length; i++) if (/Initialized moving brush tracker/.test(measured[i])) { end = i + 1; break; }
  const leftPackage = spec.from;
  const wantLog = modelled(measured.slice(at, end), leftPackage), gotLog = modelled([...oldLog.slice(browse), ...log], leftPackage);
  check(at >= 0 && gotLog.join('\n') === wantLog.join('\n'), `${id}: the engine log differs:\n--- Play\n${gotLog.join('\n')}\n--- original\n${wantLog.join('\n')}`);
  console.log(`log: ${gotLog.length} modelled lines${gotLog.join('\n') === wantLog.join('\n') ? ' in the original\'s order' : ' (DIFFER)'}`);
  check(!log.some(line => /^Log: (Game class is|Bringing Level)|InitGame|Base Mutator/.test(line)), `${id}: the loaded level ran a begin-play line`);
  check(d.actors().filter(a => d.isA(a, 'engine.playerpawn')).length === 1, `${id}: not exactly one player pawn in the loaded level`);
  // `bCheatsEnabled` is not a saved property (the save branch measured the original's file): a loaded player has the cheats off, whatever the SaveInfo says
  check(!d.read(p, 'bCheatsEnabled'), `${id}: the loaded player has bCheatsEnabled on`);
  // 2. flags
  const flags = [...(d.read(p, 'FlagBase')?.entries?.values() ?? [])].map(e => `${e.name}|${e.type}|${e.expiration}|${e.value | 0}`).sort();
  const wantFlags = originalFlags(await readFile(`${cap}${spec.label}-loaded.flags.txt`, 'utf8'));
  check(JSON.stringify(flags) === JSON.stringify(wantFlags), `${id}: flags ${flags.join(' ')} (the original: ${wantFlags.join(' ')})`);
  console.log(`flags: ${flags.length}${JSON.stringify(flags) === JSON.stringify(wantFlags) ? ' equal' : ' (DIFFER)'}`);
  // 3. the player's place and health
  const want = originalPlayer(await readFile(`${cap}${spec.label}-loaded-player.props.txt`, 'utf8'));
  const got = { location: d.pos(p).map(Math.fround), rotation: d.read(p, 'Rotation'), viewRotation: d.read(p, 'ViewRotation'), health: d.read(p, 'Health'), physics: d.read(p, 'Physics') };
  for (const key of Object.keys(want)) check(JSON.stringify([].concat(got[key])) === JSON.stringify([].concat(want[key])), `${id}: player ${key} ${JSON.stringify(got[key])} (the original: ${JSON.stringify(want[key])})`);
  console.log(`player: location ${got.location.map(Math.round)}, rotation ${got.rotation}, health ${got.health}`);
  // 4. the actor census
  // The dump lists every object of GObjObjects, the leftovers of earlier levels among them (the original's collection keeps some: `PlayerStart1`,
  // `DeusExGameInfo0`, a copy of the level left ...), and does not say which package an object is in. So: every actor Play holds is an object of the dump
  // (class and name, anywhere), and every object of the dump in the slots of the loaded package (the saved pawn's slot and up to 200 below it, where the
  // load puts its objects) whose class Play holds is a Play actor. The mission script is spawned by the load (a name counter apart, docs/travel.md
  // "Unresolved" 10): one in Play, and one in the dump's loaded slots.
  const original = originalObjects(await readFile(`${cap}${spec.label}-loaded.gobjects.txt`, 'utf8'));
  const pawnSlot = original.find(([cls, name]) => cls === 'JCDentonMale' && name === p.name)?.[2];
  check(pawnSlot !== undefined, `${id}: the original's dump has no ${p.name}`);
  const isScript = name => /^Mission\d+$/.test(name);
  const classes = new Set(d.actors().map(a => d.runtime.instance(a).cls.record.name));
  const anywhere = new Set(original.map(([cls, name]) => `${cls}.${name}`));
  const loaded = original.filter(([cls, , slot]) => classes.has(cls) && slot >= (pawnSlot ?? 0) - 200);
  const loadedActors = new Set(loaded.filter(([, name]) => !isScript(name)).map(([cls, name]) => `${cls}.${name}`));
  const playActors = new Set(d.actors().filter(a => !isScript(a.name)).map(a => `${d.runtime.instance(a).cls.record.name}.${a.name}`));
  const scripts = [d.actors().filter(a => isScript(a.name)).length, loaded.filter(([, name]) => isScript(name)).length];
  const onlyPlay = [...playActors].filter(name => !anywhere.has(name)), onlyOriginal = [...loadedActors].filter(name => !playActors.has(name));
  console.log(`census: Play ${playActors.size} actors (all in the original's dump); the original's loaded slots hold ${loadedActors.size} of those classes; only in Play ${onlyPlay.length}${onlyPlay.length ? ` (${onlyPlay.slice(0, 6)})` : ''}, only in the original's loaded slots ${onlyOriginal.length}${onlyOriginal.length ? ` (${onlyOriginal.slice(0, 6)})` : ''}; mission scripts ${scripts}`);
  check(onlyPlay.length === 0 && onlyOriginal.length === 0 && scripts[0] === 1 && scripts[1] <= 1, `${id}: the actor census differs: only in Play ${onlyPlay.slice(0, 12)}; only in the original ${onlyOriginal.slice(0, 12)}; mission scripts ${scripts}`);
  // 5. what the loaded player exports when it leaves (every travel property)
  d.exec(`LocalTravel ${spec.leave}`); d.frames(2);
  const leave = d.takeTravel();
  if (check(leave, `${id}: the loaded level did not travel`)) {
    const text = leave.travelInfo[0][1];
    const exported = travelTextOfDump(await readFile(`${cap}${spec.label}-export.travel.txt`, 'utf8'));
    const difference = firstTravelTextDifference(exported.text, text, { times: true });
    check(difference === null, `${id}: the loaded player's export differs from the original's at line ${difference?.line}: expected ${JSON.stringify(difference?.expected)}, got ${JSON.stringify(difference?.actual)}`);
    console.log(`export: ${parseTravelText(text).length} records, original ${parseTravelText(exported.text).length}${difference ? ' (DIFFERS)' : ' (equal after normalization)'}`);
  }
}

for (const id of wanted) await scenario(id);
if (failures.length) { console.log(`FAIL validate-load-game:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-load-game');
