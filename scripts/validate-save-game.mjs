/** SaveGame in Play against the original (docs/travel.md "Play, step 4"), headless. The checks that need no browser:
 *
 *   F  the player's FlagBase written into a save: the flags of real saves (the desktop game's own Save0001 of 2026-09 and the internet corpus) are put into Play's flag
 *      store and saved; the FlagBase and Flag objects of Play's file (hashTable, the chains, flagHash, expiration, value) equal the original's flag by flag;
 *   S  the slot a save leaves: SaveInfo.dxs + the copies of Save\Current (names, bytes and times kept) + the live level; Current untouched; a new slot takes the next
 *      index; a slot saved over is replaced whole; QuickSave is Save\QuickSave with DirectoryIndex -1; DeleteGame removes the directory; SavedPos reset;
 *      the engine log is the measured sequence;
 *   U  the Save Game screen through the original's scripts (new slot, overwrite box, low disk space box);
 *   W  (when the Wine capture is there) SaveInfo.dxs and the slot listing against the original's own for the same moment (.work/travel/wa2).
 *
 *   node scripts/validate-save-game.mjs [--only F|S|U|W] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { hashScriptName } from '../src/runtime/script-names.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-save-game: no installed game data'); process.exit(0); }
const here = new URL('..', import.meta.url).pathname;
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const lower = value => String(value).toLowerCase();

const FREE = 8 * 1024 ** 3;
const picture = ({ pitch, height }) => Uint8Array.from({ length: pitch * height }, (_, i) => (i % pitch < 160 && (i / pitch | 0) < 120) ? ((i % pitch) * 3 + (i / pitch | 0)) & 255 : 0);
const consoleLine = (c, line) => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));
const logOf = c => c.game.doors.scriptRuntime.engineLog;

// ---- F: the flag store -----------------------------------------------------------------------------------------------------------------------
/** The FlagBase and Flag objects of a .dxs: {defaultFlagExpiration, buckets: Map(index -> [{name, hash, type, expiration, value}] in chain order)}. */
function readFlags(bytes) {
  const pkg = parsePackage(bytes);
  const at = pkg.exports.findIndex(entry => entry.className === 'FlagBase');
  if (at < 0) return null;
  const base = readObject(pkg, bytes, at + 1).values;
  const buckets = new Map();
  for (const [key, ref] of Object.entries(base)) {
    const match = /^hashTable\[(\d+)\]$/.exec(key);
    if (!match) continue;
    const chain = [];
    for (let next = ref, guard = 0; next > 0 && guard < 1000; guard++) {
      const entry = pkg.exports[next - 1], values = readObject(pkg, bytes, next).values;
      const valueKey = { FlagBool: 'bValue', FlagByte: 'byteValue', FlagInt: 'intValue', FlagFloat: 'floatValue', FlagName: 'nameValue' }[entry.className];
      chain.push({ class: entry.className, name: values.FlagName ?? values.flagName, hash: values.flagHash | 0, expiration: values.expiration | 0, value: valueKey ? values[valueKey] ?? null : null,
        outerIsBase: entry.outer === at + 1 });
      next = values.nextFlag ?? 0;
    }
    buckets.set(Number(match[1]), chain);
  }
  return { defaultFlagExpiration: base.defaultFlagExpiration | 0, buckets, count: [...buckets.values()].reduce((sum, chain) => sum + chain.length, 0) };
}

async function scenarioF() {
  console.log('--- F: the flag store in a save equals the original\'s, flag by flag');
  const sources = [`${here}.work/travel/save-backup-pw1/Save0001/00_training.dxs`];
  const corpus = `${here}.work/internet-saves/nicouzouf/files/Deus Ex`;
  if (existsSync(corpus)) for (const slot of ['Save0003', 'Save0012', 'Save0030', 'Save0042']) {
    const dir = path.join(corpus, slot);
    if (existsSync(dir)) for (const name of await readdir(dir)) if (/\.dxs$/i.test(name) && name !== 'SaveInfo.dxs') sources.push(path.join(dir, name));
  }
  const present = sources.filter(source => existsSync(source));
  if (!present.length) { console.log('SKIP F: no saved levels with a FlagBase (outside Git: .work/travel/save-backup-pw1, .work/internet-saves)'); return; }
  const directory = createSaveDirectory({ freeSpaceBytes: FREE });
  const { c } = await openSession('00_Training', assets, { travel: { snapshotSource: picture }, saveDirectory: directory });
  c.frames(30);
  let index = 20;
  for (const source of present) {
    const real = readFlags(new Uint8Array(await readFile(source)));
    if (!real || !real.count) continue;
    const store = c.read(c.player(), 'FlagBase');
    store.deleteAllFlags();
    store.setDefaultExpiration(real.defaultFlagExpiration);
    for (const chain of real.buckets.values()) for (const flag of chain) {
      if (flag.class !== 'FlagBool') throw new Error(`${source}: a ${flag.class} flag ${flag.name}: this check only has the bool store the original's saves hold`);
      store.setBool(flag.name, Boolean(flag.value), true, flag.expiration);
    }
    consoleLine(c, `SaveGame ${++index}`); c.frames(2);
    const mine = readFlags(directory.readFile(`Save${String(index).padStart(4, '0')}`, '00_training.dxs'));
    const label = path.basename(path.dirname(source)) + '/' + path.basename(source);
    check(mine?.count === real.count, `F ${label}: ${mine?.count} flags written, the original's file holds ${real.count}`);
    check(mine?.defaultFlagExpiration === real.defaultFlagExpiration, `F ${label}: defaultFlagExpiration ${mine?.defaultFlagExpiration} (original ${real.defaultFlagExpiration})`);
    let bad = 0;
    for (const [bucket, chain] of real.buckets) {
      const got = mine?.buckets.get(bucket) ?? [];
      const want = JSON.stringify(chain.map(({ class: cls, name, hash, expiration, value }) => [cls, name, hash, expiration, value]));
      const have = JSON.stringify(got.map(({ class: cls, name, hash, expiration, value }) => [cls, name, hash, expiration, value]));
      if (want !== have) { bad++; if (bad <= 3) failures.push(`F ${label}: bucket ${bucket}: ${have} (original ${want})`); }
    }
    for (const bucket of mine?.buckets.keys() ?? []) if (!real.buckets.has(bucket)) { bad++; failures.push(`F ${label}: bucket ${bucket} is not in the original's table`); }
    console.log(`${label}: ${real.count} flags in ${real.buckets.size} buckets, default expiration ${real.defaultFlagExpiration}: ${bad ? bad + ' buckets differ' : 'every chain equal (class, name, hash, expiration, value, order)'}`);
  }
}

// ---- S: the slot a save leaves ----------------------------------------------------------------------------------------------------------------
async function scenarioS() {
  console.log('--- S: the slot, the copies of Current, the indices, QuickSave, DeleteGame');
  const directory = createSaveDirectory({ freeSpaceBytes: FREE });
  const first = await openSession('01_NYC_UNATCOIsland', assets, { travel: { snapshotSource: picture }, saveDirectory: directory });
  const island = first.c;
  island.frames(60);
  consoleLine(island, 'LocalTravel 01_NYC_UNATCOHQ'); island.frames(2);
  const request = island.takeTravel();
  check(request?.map === '01_NYC_UNATCOHQ', `S: LocalTravel requested ${request?.map}`);
  const currentBefore = directory.files('Current').map(file => `${file.name}:${file.size}:${directory.modifiedOf('Current', file.name)}`).sort();
  check(currentBefore.length === 1, `S: Current holds ${currentBefore} after leaving the Island`);
  const { c: hq } = await openSession('01_NYC_UNATCOHQ', assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource: picture }, saveDirectory: directory });
  hq.frames(60);
  const currentFile = directory.files('Current')[0];
  const mover = hq.byClass('DeusExMover').find(m => hq.read(m, 'SavedPos'));
  hq.game.hud.scoped(() => hq.runtime.writeNamed(mover, 'SavedPos', [1, 2, 3]));
  const mark = logOf(hq).length;
  const timesBefore = Date.now();
  consoleLine(hq, 'SaveGame 0'); hq.frames(2);                                     // a new slot: index 0 asks for GetNewSaveFileIndex
  const slot = 'Save0001';
  check(directory.directories().includes(slot), `S: SaveGame 0 made ${directory.directories()}`);
  const names = directory.files(slot).map(file => file.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['01_NYC_UNATCOHQ.dxs', '01_NYC_UNATCOIsland.dxs', 'SaveInfo.dxs']), `S: the slot holds ${names} (the original: SaveInfo.dxs, the copy of Current's Island and the live HQ)`);
  const copy = directory.readFile(slot, currentFile.name), kept = directory.readFile('Current', currentFile.name);
  check(copy && kept && copy.length === kept.length && copy.every((byte, i) => byte === kept[i]), 'S: the Island in the slot is not the byte-for-byte copy of Current\'s');
  check(directory.modifiedOf(slot, currentFile.name) === directory.modifiedOf('Current', currentFile.name), 'S: the copy did not keep Current\'s file time');
  check(JSON.stringify(directory.files('Current').map(file => `${file.name}:${file.size}:${directory.modifiedOf('Current', file.name)}`).sort()) === JSON.stringify(currentBefore), 'S: Current changed');
  check(hq.read(mover, 'SavedPos').every(value => value === -1), `S: the mover's SavedPos is ${hq.read(mover, 'SavedPos')} after the save (the original: -1, -1, -1)`);
  const info = directory.info(slot);
  check(info.properties.DirectoryIndex === 1 && info.properties.MapName === '01_NYC_UNATCOHQ' && info.properties.saveCount === 1 && info.properties.MissionLocation === 'NYC - UNATCO HQ',
    `S: the SaveInfo ${JSON.stringify(info.properties)}`);
  check(info.snapshot?.image?.width === 256 && info.snapshot.image.height === 128, 'S: the Snapshot is not the 256 x 128 texture');
  const lines = logOf(hq).slice(mark).filter(line => /Save=|Moving|Unloading|Failed to load|brush tracker/.test(line)).map(line => line.replace(/Save=[\d.]+/, 'Save=<ms>'));
  const want = [`Warning: Failed to load '..\\Save\\Current\\SaveInfo.dxs': Can't find file '..\\Save\\Current\\SaveInfo.dxs'`,
    `Warning: Failed to load 'DeusExSaveInfo None.MyDeusExSaveInfo': Can't find file '..\\Save\\Current\\SaveInfo.dxs'`, 'Log: Unloading: Package 01_NYC_UNATCOHQ', 'Log: Save=<ms>',
    `Log: Moving '..\\Save\\Save0001\\Save.tmp' to '..\\Save\\Save0001\\SaveInfo.dxs'`, 'Init: Shut down moving brush tracker for Level 01_NYC_UNATCOHQ.MyLevel', 'Log: Save=<ms>',
    `Log: Moving '..\\Save\\Save0001\\Save.tmp' to '..\\Save\\Save0001\\01_NYC_UNATCOHQ.dxs'`, 'Init: Initialized moving brush tracker for Level 01_NYC_UNATCOHQ.MyLevel'];
  check(JSON.stringify(lines) === JSON.stringify(want), `S: the engine log of SaveGame\n  ${lines.join('\n  ')}\nthe measured (s1/n9-deleted.log)\n  ${want.join('\n  ')}`);
  // a second save: the next index, one more save count; the object persists so the warnings do not repeat
  consoleLine(hq, 'SaveGame 0'); hq.frames(2);
  check(directory.directories().includes('Save0002') && directory.info('Save0002').properties.saveCount === 2, 'S: the second new slot is Save0002 with saveCount 2');
  consoleLine(hq, 'SaveGame 7'); hq.frames(2);
  consoleLine(hq, 'SaveGame 0'); hq.frames(2);
  check(directory.directories().includes('Save0008'), `S: after Save0007 a new slot takes 8 (GetNewSaveFileIndex): ${directory.directories()}`);
  // a slot saved over is replaced whole: a stale file goes
  directory.writeFile('Save0002', 'stale.dxs', new Uint8Array(4));
  consoleLine(hq, 'SaveGame 2'); hq.frames(2);
  check(!directory.hasFile('Save0002', 'stale.dxs') && directory.info('Save0002').properties.saveCount === 5, `S: saving over Save0002: stale file ${directory.hasFile('Save0002', 'stale.dxs')}, saveCount ${directory.info('Save0002').properties.saveCount}`);
  // QuickSave: the exec function's refusals and its slot
  hq.game.hud.scoped(() => hq.runtime.scriptConsoleExec(hq.player(), 'QuickSave')); hq.frames(2);
  check(directory.directories().includes('QuickSave'), 'S: QuickSave (the exec function) did not write QuickSave');
  const quick = directory.info('QuickSave');
  check(quick.properties.DirectoryIndex === -1 && quick.properties.Description === 'Quick Save', `S: the QuickSave SaveInfo ${JSON.stringify(quick.properties)}`);
  check(directory.hasFile('QuickSave', '01_NYC_UNATCOIsland.dxs') && directory.hasFile('QuickSave', '01_NYC_UNATCOHQ.dxs'), 'S: QuickSave lacks a level file');
  // DeleteGame
  consoleLine(hq, 'DeleteGame 7'); hq.frames(2);
  check(!directory.directories().includes('Save0007') && directory.directories().includes('Save0008'), `S: DeleteGame 7 left ${directory.directories()}`);
  consoleLine(hq, 'DeleteGame'); consoleLine(hq, 'SaveGame'); hq.frames(2);       // the keyword with no digit does nothing, and is claimed
  check(directory.directories().length === 5, `S: a SAVEGAME with no number changed the directory: ${directory.directories()}`);
  // the sink: a finished save reaches the page's storage whole, SaveInfo.dxs last
  const { setSaveSink } = await import('../src/runtime/save-sink.mjs');
  const seen = [];
  setSaveSink({ commitSlot: async ({ dir, files }) => { seen.push(['commit', dir, files.map(file => file.name)]); }, removeSlot: async ({ dir }) => { seen.push(['remove', dir]); } });
  consoleLine(hq, 'SaveGame 9'); consoleLine(hq, 'DeleteGame 9'); hq.frames(2);
  setSaveSink(null);
  check(seen.length === 2 && seen[0][0] === 'commit' && seen[0][1] === 'Save0009' && seen[0][2].at(-1) === 'SaveInfo.dxs' && JSON.stringify(seen[1]) === JSON.stringify(['remove', 'Save0009']), `S: the sink saw ${JSON.stringify(seen)}`);
  console.log(`slots ${directory.directories().join(', ')}; Save0001 = ${names.join(', ')}`);
  void timesBefore;
}

// ---- U: the Save Game screen ---------------------------------------------------------------------------------------------------------------------
async function scenarioU() {
  console.log('--- U: the Save Game screen, its overwrite box, the low disk space box');
  const directory = createSaveDirectory({ freeSpaceBytes: FREE });
  const { c } = await openSession('00_Training', assets, { travel: { snapshotSource: picture }, saveDirectory: directory });
  c.frames(60);
  const driver = createMenuDriver(c.game);
  const open = () => { driver.showMainMenu(); c.frames(5); driver.invoke('MenuScreenSaveGame'); c.frames(10); };
  open();
  check(driver.top() === 'deusex.menuscreensavegame', `U: the Save Game screen did not open (${driver.top()})`);
  driver.pressActionKey('SAVE'); c.frames(12);
  check(driver.top() === null && directory.directories().includes('Save0001'), `U: SAVE left ${driver.top()} and ${directory.directories()}`);
  check(directory.info('Save0001').properties.Description === 'UNATCO Training Course', 'U: the default name is the mission location');
  // a slot's row, Save: the overwrite box (MB_Overwrite); No keeps it, Yes saves over it
  open();
  const rows = driver.listRows('lstGames');
  check(rows.rows.length === 2, `U: ${rows.rows.length} rows with one save (the new-save row and the slot)`);
  for (let key = 0; key < 3 && driver.listRows('lstGames').selected !== 1; key++) { c.game.windowKey('ArrowDown', true); c.game.windowKey('ArrowDown', false); c.frames(5); }
  const selected = driver.listRows('lstGames');
  const screen = driver.topWindow();
  check(selected.selected === 1, `U: the slot's row is not selected (${selected.selected}); editRowId ${c.read(screen, 'editRowId')}, newSaveRowId ${c.read(screen, 'newSaveRowId')}`);
  driver.pressActionKey('SAVE'); c.frames(5);
  if (!check(driver.top() === 'deusex.menuuimessageboxwindow', `U: saving over a slot opened ${driver.top()} (the overwrite box); editRowId ${c.read(screen, 'editRowId')}, newSaveRowId ${c.read(screen, 'newSaveRowId')}`)) return;
  driver.pressField('btnNo'); c.frames(5);
  check(directory.info('Save0001').properties.saveCount === 1, 'U: No saved over the slot');
  driver.pressActionKey('SAVE'); c.frames(5);
  driver.pressField('btnYes'); c.frames(12);
  check(directory.info('Save0001').properties.saveCount === 2 && driver.top() === null, `U: Yes: saveCount ${directory.info('Save0001').properties.saveCount}, top ${driver.top()}`);
  // low disk space: MB_LowSpace, nothing written
  directory.setFreeSpaceBytes(50 * 1024 * 1024);
  open();
  driver.pressActionKey('SAVE'); c.frames(5);
  check(driver.top() === 'deusex.menuuimessageboxwindow', `U: with 50 MB free SAVE opened ${driver.top()}`);
  driver.pressField('btnOK'); c.frames(5);
  check(directory.directories().join() === 'Save0001', `U: the low-space box let a save through: ${directory.directories()}`);
  console.log('Save Game screen: new slot, overwrite box (No, Yes), low disk space box');
}

// ---- W: the original's own files ------------------------------------------------------------------------------------------------------------------
async function scenarioW() {
  console.log('--- W: SaveInfo.dxs and the slot against the original (.work/travel/wa2)');
  const dir = `${here}.work/travel/wa2`;
  if (!existsSync(`${dir}/wa5.Save0005/SaveInfo.dxs`)) { console.log('SKIP W: the Wine capture is not there (.work/travel/wa2, outside Git)'); return; }
  const real = parseSaveInfo(new Uint8Array(await readFile(`${dir}/wa5.Save0005/SaveInfo.dxs`)));
  console.log('the original (wa2 Save0005):', JSON.stringify(real.properties));
}

if (!only || only === 'F') await scenarioF();
if (!only || only === 'S') await scenarioS();
if (!only || only === 'U') await scenarioU();
if (!only || only === 'W') await scenarioW();
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length ? `FAIL validate-save-game: ${failures.length} checks` : 'PASS validate-save-game');
void assert; void lower; void hashScriptName;
process.exit(failures.length ? 1 : 0);
