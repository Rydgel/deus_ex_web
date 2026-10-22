/** Play writes save slots for the original to load (docs/travel.md "Play, step 4"), headless: the files of `Save\<slot>\` a Play session made with SaveGame, QuickSave
 * and the Save Game screen's native, plus `facts.json` (what the player held when it saved), in a directory outside Git. `scripts/travel-probe.sh` puts a slot into the
 * Wine prefix (`putslot:<dir>:<slot>`) and the original loads it (`cmd:LoadGame <n>`); `scripts/validate-save-game.mjs` compares what it shows with the facts.
 *
 * Scenarios (one process each):
 *   T  00_Training from the menu's Training button, a few seconds of walking, `SaveGame 10` (no cheats);
 *   I  the Island by the New Game path (the intro left by Escape), the cheat lines of the travel captures (credits, skills, augmentations, images, a key, a note, a
 *      goal), some play, `SaveGame 11`;
 *   H  the Island, then `LocalTravel 01_NYC_UNATCOHQ`, play, `SaveGame 12` in HQ: the slot holds HQ (the live level) and the Island (copied from Current).
 *
 *   node scripts/make-play-saves.mjs --out DIR [--only T|I|H] */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { viewProbe } from '../src/viewer/view-probe.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const out = option('out', null), only = option('only', null);
if (!out) { console.error('usage: make-play-saves.mjs --out DIR [--only T|I|H]'); process.exit(2); }
if (!only) {
  const { spawnSync } = await import('node:child_process');
  let status = 0;
  for (const id of ['T', 'I', 'H']) { const run = spawnSync(process.execPath, [process.argv[1], '--only', id, '--out', out], { stdio: 'inherit' }); if (run.status !== 0) status = run.status ?? 1; }
  process.exit(status);
}
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);

/** A picture for the snapshot (a synthetic gradient: the page supplies the real frame; the original only draws it). */
const snapshotSource = ({ pitch, height }) => Uint8Array.from({ length: pitch * height }, (_, i) => (i % pitch < 160 && (i / pitch | 0) < 120) ? ((i % pitch) + (i / pitch | 0)) & 255 : 0);
const directory = createSaveDirectory({ freeSpaceBytes: 8 * 1024 ** 3 });
/** The viewport's Exec chain as the Talk key's console reaches it, with no cheat written (`typed` below writes bCheatsEnabled, as the probe does). */
const console_ = (c, line) => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));
const typed = (c, line) => c.game.hud.scoped(() => viewProbe(c.game, { exec: [line] }).output[0]);
const arrive = async (map, request) => (await openSession(map, assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource }, saveDirectory: directory })).c;

/** What the player holds, read from the live objects: the facts the original's loaded player is compared with. */
function facts(c, label) {
  const read = (object, name) => c.read(object, name);
  const player = c.player();
  const items = [];
  for (let item = read(player, 'Inventory'); item; item = read(item, 'Inventory'))
    items.push({ class: c.runtime.instance(item).cls.record.key.split('.').pop(), name: item.name, beltPos: read(item, 'beltPos') ?? null, bInObjectBelt: Boolean(read(item, 'bInObjectBelt')) });
  const store = read(player, 'FlagBase');
  return {
    label, map: c.game.doors.scriptRuntime.asset?.name ?? null,
    flags: [...(store?.entries?.values() ?? [])].map(e => `${e.name}${e.type ? `=${e.value}` : ''}@${e.expiration}`).sort(), defaultExpiration: store?.defaultExpiration ?? null,
    items, location: read(player, 'Location'), rotation: read(player, 'Rotation'), viewRotation: read(player, 'ViewRotation'),
    health: read(player, 'Health'), healthHead: read(player, 'HealthHead'), healthTorso: read(player, 'HealthTorso'),
    credits: read(player, 'Credits'), skillPointsAvail: read(player, 'SkillPointsAvail'), skillPointsTotal: read(player, 'SkillPointsTotal'),
    energy: read(player, 'Energy'), saveCount: read(player, 'saveCount'), saveTime: read(player, 'saveTime'), bCheatsEnabled: Boolean(read(player, 'bCheatsEnabled')),
    combatDifficulty: read(player, 'CombatDifficulty'), inHand: read(player, 'inHand')?.name ?? null,
  };
}

async function dumpSlot(slot, name, extra) {
  const dir = `${out}/${name}`;
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const { name: file } of directory.files(slot)) { await writeFile(`${dir}/${file}`, directory.readFile(slot, file)); written.push(file); }
  const info = parseSaveInfo(directory.readFile(slot, 'SaveInfo.dxs'));
  console.log(`${name}: ${slot} -> ${dir}: ${written.join(', ')}; ${JSON.stringify(info.properties)}`);
  return { slot, files: written, info: info.properties, ...extra };
}

async function newGameIsland() {
  const { c } = await openSession('DX', assets, { travel: { snapshotSource }, saveDirectory: directory });
  c.frames(120); c.key('Escape'); c.frames(20);
  const driver = createMenuDriver(c.game);
  const scoped = fn => c.game.hud.scoped(fn);
  const step = (fn, frames = 30) => { scoped(fn); c.frames(frames); };
  step(() => driver.pressButton(0));                 // New Game -> the "train first?" box
  step(() => driver.pressField('btnNo'));            // No
  step(() => driver.pressButton(2));                 // Medium
  scoped(() => driver.pressActionKey('START')); c.frames(3);
  const toIntro = c.takeTravel();
  if (toIntro?.map !== '00_Intro') throw new Error(`Start Game requested ${toIntro?.map}`);
  const intro = await arrive('00_Intro', toIntro);
  typed(intro, 'set LevelInfo bPlayersOnly True');   // (the freeze of the captures; it writes bCheatsEnabled, which the Island's player does not take: the text does not carry it)
  intro.frames(60); intro.key('Escape'); intro.frames(10);
  const toIsland = intro.takeTravel();
  if (toIsland?.map !== '01_NYC_UNATCOIsland') throw new Error(`leaving the intro requested ${toIsland?.map}`);
  const island = await arrive('01_NYC_UNATCOIsland', toIsland);
  island.frames(240);
  return island;
}
const walk = (c, seconds) => { c.game.inputKey('KeyW', true); c.frames(60 * seconds); c.game.inputKey('KeyW', false); c.frames(30); };
const cheats = c => { for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', 'AllCredits', 'AllSkills', 'AllAugs', 'AllImages', 'GiveNanoKey TestKeyA "Test key A"',
  'NoteAdd "A first note"', 'GoalAdd GoalOne "Reach the dock" 1']) { typed(c, line); c.frames(30); } };

const result = {};
if (only === 'T') {
  const { c } = await openSession('DX', assets, { travel: { snapshotSource }, saveDirectory: directory });
  c.frames(120); c.key('Escape'); c.frames(20);
  const driver = createMenuDriver(c.game);
  c.game.hud.scoped(() => driver.pressButton(4)); c.frames(3);                    // Training
  const request = c.takeTravel();
  if (request?.map !== '00_Training') throw new Error(`the Training button requested ${request?.map}`);
  const training = await arrive('00_Training', request);
  training.frames(300); walk(training, 3);
  const before = facts(training, 'before SaveGame 10');
  console_(training, 'SaveGame 10'); training.frames(5);
  result.training = { before, ...await dumpSlot('Save0010', 'training', {}) };
  result.trainingLog = training.game.doors.scriptRuntime.engineLog.filter(line => /Save=|Moving|Unloading|Failed to load|brush tracker/.test(line)).slice(-24);
} else if (only === 'I') {
  const island = await newGameIsland();
  walk(island, 3); cheats(island); island.frames(120);
  const before = facts(island, 'before SaveGame 11');
  console_(island, 'SaveGame 11'); island.frames(5);
  result.island = { before, ...await dumpSlot('Save0011', 'island', {}) };
  island.game.inputKey('NumpadAdd', true); island.frames(2); island.game.inputKey('NumpadAdd', false); island.frames(5);   // the Quick Save key (GreyPlus)
  result.islandQuick = directory.hasFile('QuickSave', 'SaveInfo.dxs') ? await dumpSlot('QuickSave', 'island-quick', {}) : null;
} else if (only === 'H') {
  const island = await newGameIsland();
  walk(island, 2);
  console_(island, 'LocalTravel 01_NYC_UNATCOHQ'); island.frames(2);
  const request = island.takeTravel();
  if (request?.map !== '01_NYC_UNATCOHQ') throw new Error(`LocalTravel requested ${request?.map}`);
  const hq = await arrive('01_NYC_UNATCOHQ', request);
  hq.frames(240); walk(hq, 2);
  const before = facts(hq, 'before SaveGame 12');
  console_(hq, 'SaveGame 12'); hq.frames(5);
  result.hq = { before, ...await dumpSlot('Save0012', 'hq', {}) };
}
await mkdir(out, { recursive: true });
await writeFile(`${out}/facts-${only}.json`, JSON.stringify(result, null, 1));
console.log(`facts-${only}.json written`);
