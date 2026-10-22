/** SaveGame in Play against the original (docs/travel.md "Play, step 4"), headless. The checks that need no browser:
 *
 *   F  the player's FlagBase written into a save: the flags of real saves (the desktop game's own Save0001 of 2026-09 and the internet corpus) are put into Play's flag
 *      store and saved; the FlagBase and Flag objects of Play's file (hashTable, the chains, flagHash, expiration, value) equal the original's flag by flag;
 *   S  the slot a save leaves: SaveInfo.dxs + the copies of Save\Current (names, bytes and times kept) + the live level; Current untouched; a new slot takes the next
 *      index; a slot saved over is replaced whole; QuickSave is Save\QuickSave with DirectoryIndex -1; DeleteGame removes the directory; SavedPos reset;
 *      the engine log is the measured sequence;
 *   L  the measured SaveGame 77 (Island, HQ, the Island restored, SaveGame): the slot's files and times, the SaveInfo;
 *   U  the Save Game screen through the original's scripts (new slot, overwrite box, low disk space box);
 *   W  (when the Wine capture is there) SaveInfo.dxs and the slot listing against the original's own for the same moment (.work/travel/wa5);
 *   C  (when the capture is there) the original, under Wine, loaded Play's slots (wc1, wc2): the loaded player's location, stats, inventory and FlagBase, the log and the restored Island's troops against what Play saved.
 *
 *   node scripts/validate-save-game.mjs [--only F|S|L|U|W|C] */
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
if (!only) {
  // one process per scenario: the realm remembers a first save (the SaveInfo object, the warnings of the first GetSaveInfo(-2)), which scenario S measures from the start
  const { spawnSync } = await import('node:child_process');
  let status = 0;
  for (const id of ['F', 'S', 'L', 'U', 'W', 'C']) { const run = spawnSync(process.execPath, [process.argv[1], '--only', id], { stdio: 'inherit' }); if (run.status !== 0) status = run.status ?? 1; }
  process.exit(status);
}
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
  // a loaded game leaves the slot's SaveInfo.dxs in Current (LoadGame copies the whole slot): CopySaveGameFiles copies it with the levels (*.dxs) and SavePackage writes over it
  directory.writeFile('Current', 'SaveInfo.dxs', directory.readFile('Save0001', 'SaveInfo.dxs'));
  consoleLine(hq, 'SaveGame 3'); hq.frames(2);
  const three = directory.files('Save0003').map(file => file.name).sort();
  check(JSON.stringify(three) === JSON.stringify(['01_NYC_UNATCOHQ.dxs', '01_NYC_UNATCOIsland.dxs', 'SaveInfo.dxs']) && directory.info('Save0003').properties.DirectoryIndex === 3,
    `S: a save with a SaveInfo.dxs in Current: ${three} / ${JSON.stringify(directory.info('Save0003')?.properties)}`);
  directory.removeFile('Current', 'SaveInfo.dxs'); directory.remove('Save0003');
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

// ---- L: the measured SaveGame 77 --------------------------------------------------------------------------------------------------------------
/** The measured session s1 (.work/travel/s1): the Island, HQ, the Island restored from Current, `SaveGame 77`: the listing the original left (n5-saved.save.txt). */
async function scenarioL() {
  console.log('--- L: SaveGame in the restored Island after the Island -> HQ -> Island round trip: the original\'s listing of Save0077 (s1/n5-saved)');
  const measured = `${here}.work/travel/s1/n5-saved.save.txt`;
  if (!existsSync(measured)) { console.log('SKIP L: the measured listing is not there (.work/travel/s1, outside Git)'); return; }
  const wanted = new Map();
  for (const line of (await readFile(measured, 'utf8')).split('\n')) {
    const m = /^f (Save0077|Current)\/(\S+)\t(\d+)\t(\S+ \S+)/.exec(line);
    if (m) { if (!wanted.has(m[1])) wanted.set(m[1], []); wanted.get(m[1]).push({ name: m[2], size: Number(m[3]), time: m[4] }); }
  }
  const directory = createSaveDirectory({ freeSpaceBytes: FREE });
  const open = async (map, request) => (await openSession(map, assets, { travel: { ...(request ? { arrival: request, lastURL: request.lastURL } : {}), snapshotSource: picture }, saveDirectory: directory })).c;
  const island = await open('01_NYC_UNATCOIsland', null);
  island.frames(30);
  consoleLine(island, 'LocalTravel 01_NYC_UNATCOHQ'); island.frames(2);
  const toHq = island.takeTravel();
  const hq = await open('01_NYC_UNATCOHQ', toHq);
  hq.frames(30);
  consoleLine(hq, 'LocalTravel 01_NYC_UNATCOIsland'); hq.frames(2);
  const back = hq.takeTravel();
  check(back?.restore, 'L: the Island was not restored from Current');
  const restored = await open('01_NYC_UNATCOIsland', back);
  restored.frames(30);
  const current = directory.files('Current').map(file => `${file.name}:${directory.modifiedOf('Current', file.name)}`).sort();
  check(directory.files('Current').map(file => file.name).sort().join() === wanted.get('Current').map(file => file.name).sort().join(), `L: Current holds ${current}`);
  consoleLine(restored, 'SaveGame 77'); restored.frames(2);
  const slot = (directory.files('Save0077') ?? []).map(file => file.name).sort();
  check(slot.join() === wanted.get('Save0077').map(file => file.name).sort().join(), `L: Save0077 holds ${slot} (the original: ${wanted.get('Save0077').map(file => file.name).sort()})`);
  check(directory.modifiedOf('Save0077', '01_NYC_UNATCOHQ.dxs') === directory.modifiedOf('Current', '01_NYC_UNATCOHQ.dxs'), 'L: the HQ copy lost Current\'s file time (the original kept it)');
  check(directory.modifiedOf('Save0077', '01_NYC_UNATCOIsland.dxs') >= directory.modifiedOf('Current', '01_NYC_UNATCOIsland.dxs'), 'L: the live Island is not newer than the one in Current');
  const info = directory.info('Save0077').properties;
  check(info.DirectoryIndex === 77 && info.Description === 'Untitled' && info.MissionLocation === 'NYC - Liberty Island' && info.MapName === '01_NYC_UNATCOIsland' && info.saveCount === 1,
    `L: the SaveInfo ${JSON.stringify(info)} (the original: 77, "Untitled", "NYC - Liberty Island", "01_NYC_UNATCOIsland", saveCount 1)`);
  console.log(`Save0077: ${slot.join(', ')}; ${JSON.stringify(info)}`);
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
/** The live player's `saveTime=<float>` / `saveCount=0x..` / `bCheatsEnabled=<n>` of a dump-actor-win props file (the first line of an object, not a Class row). */
async function playerProps(file) {
  const line = (await readFile(file, 'utf8')).split('\n').find(text => /^JCDentonMale JCDentonMale\d+ /.test(text));
  return Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map(([, key, value]) => [key, Number(value)]));
}
async function scenarioW() {
  console.log('--- W: SaveInfo.dxs and the slot against the original for the same moment (.work/travel/wa5: Training, SaveGame 5 and 6, QuickSave)');
  const dir = `${here}.work/travel/wa5`;
  if (!existsSync(`${dir}/wa5.Save0005/SaveInfo.dxs`)) { console.log('SKIP W: the Wine capture is not there (.work/travel/wa5, outside Git)'); return; }
  const { explainSaveInfoDifferences } = await import('./save-info-diff.mjs');
  const original = async (slot, tag) => new Uint8Array(await readFile(`${dir}/${tag}.${slot}/SaveInfo.dxs`));
  const directory = createSaveDirectory({ freeSpaceBytes: FREE });
  // Play: the logo map, LocalTravel 00_Training (the original's route), a few seconds of play
  // (the headless drivers' clock reads 12:00:01, whose zero minute is a field the original does not store: a clock like the capture's, with no zero field, keeps the layouts equal)
  const clock = () => ({ Year: 2026, Month: 10, Day: 22, Hour: 14, Minute: 28, Second: 31 });
  const logo = (await openSession('DX', assets, { travel: { snapshotSource: picture, clock }, saveDirectory: directory })).c;
  logo.frames(120);
  consoleLine(logo, 'LocalTravel 00_Training'); logo.frames(2);
  const request = logo.takeTravel();
  const c = (await openSession('00_Training', assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource: picture, clock }, saveDirectory: directory })).c;
  c.frames(600);
  const compare = async (label, slot, tag, playTime, propsBefore, propsAfter) => {
    const real = await original(slot, tag), ours = directory.readFile(slot, 'SaveInfo.dxs');
    const a = parseSaveInfo(ours), b = parseSaveInfo(real);
    for (const key of ['Description', 'MissionLocation', 'MapName', 'DirectoryIndex', 'saveCount', 'bCheatsEnabled'])
      check(a.properties[key] === b.properties[key], `W ${label}: ${key} is ${JSON.stringify(a.properties[key])} (the original: ${JSON.stringify(b.properties[key])})`);
    check(Boolean(a.snapshot) === Boolean(b.snapshot) && a.snapshot.image.width === b.snapshot.image.width && a.snapshot.image.height === b.snapshot.image.height, `W ${label}: the Snapshot differs in form`);
    // saveTime: ftol of the player's property at the call. Play's is exact; the original's lies between the readings taken before and after the command
    check((a.properties.saveTime ?? 0) === Math.trunc(playTime), `W ${label}: Play's saveTime ${a.properties.saveTime} is not ftol(${playTime})`);
    const low = Math.trunc(propsBefore.saveTime), high = Math.trunc(propsAfter.saveTime);
    check((b.properties.saveTime ?? 0) >= low && (b.properties.saveTime ?? 0) <= high, `W ${label}: the original's saveTime ${b.properties.saveTime ?? 0} is outside ftol of its readings ${propsBefore.saveTime}..${propsAfter.saveTime}`);
    const diff = explainSaveInfoDifferences(ours, real);
    if (!diff.sameLayout) {
      const names = bytes => { const pkg = parsePackage(bytes); return { names: pkg.names.map(entry => entry.name).join(' '), exports: pkg.exports.map(entry => `${entry.name}:${entry.serialOffset}+${entry.serialSize}`).join(' '), props: JSON.stringify(parseSaveInfo(bytes).properties) }; };
      check(false, `W ${label}: Play's file is ${diff.play} bytes, the original's ${diff.real}\n  Play ${JSON.stringify(names(ours))}\n  real ${JSON.stringify(names(real))}`);
      return;
    }
    for (const entry of diff.unexpected.slice(0, 6)) check(false, `W ${label}: byte ${entry.offset} (${entry.label}) is ${entry.play}, the original's ${entry.real}`);
    const order = diff.history.nameTail.play === diff.history.nameTail.real && diff.history.textureFirst.play === diff.history.textureFirst.real ? ''
      : ` (process history, not reproducible: names ${diff.history.nameTail.play.replace(/ /g, ',')} vs the original's ${diff.history.nameTail.real.replace(/ /g, ',')}, Texture first ${diff.history.textureFirst.play} vs ${diff.history.textureFirst.real}; Play's file written in the original's order for the comparison)`;
    console.log(`${label}: ${real.length} bytes each, the same layout${order}; the bytes that differ: ${diff.groups.map(group => `${group.label} x${group.count}`).join(', ')}${diff.unexpected.length ? `; UNEXPECTED ${diff.unexpected.length}` : '; nothing else'}`);
  };
  const props = tag => playerProps(`${dir}/${tag}.props.txt`);
  let before = c.read(c.player(), 'saveTime');
  consoleLine(c, 'SaveGame 5'); c.frames(2);
  await compare('SaveGame 5', 'Save0005', 'wa5', before, await props('wa-player-a'), await props('wa-player-b'));
  c.game.hud.scoped(() => c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true)); c.frames(2);
  before = c.read(c.player(), 'saveTime');
  consoleLine(c, 'SaveGame 6'); c.frames(2);
  await compare('SaveGame 6 (cheats on)', 'Save0006', 'wa6', before, await props('wa-player-b'), await props('wa-player-c'));
  c.game.hud.scoped(() => c.runtime.writeNamed(c.player(), 'bCheatsEnabled', false));
  if (existsSync(`${dir}/waq.QuickSave/SaveInfo.dxs`)) {
    for (let seconds = 0; seconds < 300 && c.read(c.player(), 'dataLinkPlay'); seconds += 2) c.frames(120);
    before = c.read(c.player(), 'saveTime');
    c.game.hud.scoped(() => c.runtime.scriptConsoleExec(c.player(), 'QuickSave')); c.frames(2);
    const after = await props('wa-player-c');
    await compare('QuickSave', 'QuickSave', 'waq', before, after, { saveTime: after.saveTime + 200 });
  }
  // the listing the original left (b): the same file names per slot
  const wanted = { Save0005: ['00_training.dxs', 'SaveInfo.dxs'], QuickSave: ['00_training.dxs', 'SaveInfo.dxs'] };
  for (const [slot, names] of Object.entries(wanted))
    check(JSON.stringify(directory.files(slot).map(file => file.name).sort()) === JSON.stringify(names.sort()), `W: ${slot} holds ${directory.files(slot).map(file => file.name)}`);
}

// ---- C: the original loads Play's slots -----------------------------------------------------------------------------------------------------
/** A dump-actor-win props file: the player's line as {name, key: string}, and every `<Class> <name> Owner=<owner>` row. */
function readProps(text) {
  const lines = text.split('\n');
  const line = lines.find(row => /^JCDentonMale JCDentonMale\d+ /.test(row));
  const values = {};
  if (line) for (const [, key, value] of line.matchAll(/(\w+)=(\([^)]*\)|\S+)/g)) values[key] = value;
  return { player: line?.split(' ')[1] ?? null, values, owners: lines.map(row => /^(\w+) (\w+) Owner=(\S+)$/.exec(row)).filter(Boolean).map(([, className, name, owner]) => ({ className: lower(className), name, owner })) };
}
const tuple = text => text.slice(1, -1).split(',').map(Number);
/** The flag dump (`<tag>.flags.txt`): [{name, type, expiration, value, bucket}] of the loaded player's FlagBase. */
function readFlagDump(text) {
  return text.split('\n').map(row => /^\s+flag (\S+) type (\d+) expiration (-?\d+) value (0x[0-9a-f]+) bucket (\d+)$/.exec(row)).filter(Boolean)
    .map(([, name, type, expiration, value, bucket]) => ({ name, type: Number(type), expiration: Number(expiration), value: Number(value), bucket: Number(bucket) }));
}
async function scenarioC() {
  console.log('--- C: the original (Wine) loaded the slots Play wrote: the loaded player against what Play saved (.work/travel/wc1, .work/play-saves)');
  const wine = `${here}.work/travel/wc1`, facts = `${here}.work/play-saves`;
  // wc2: the Island slot regenerated with the final writer (play-saves2: the name table as the original orders it) and Play's QuickSave through the QuickLoad box
  const wine2 = `${here}.work/travel/wc2`, facts2 = `${here}.work/play-saves2`;
  if (!existsSync(`${wine}/wc-training-player.props.txt`) || !existsSync(`${facts}/facts-T.json`)) { console.log('SKIP C: the Wine capture or the generated saves are not there (.work/travel/wc1, .work/play-saves, outside Git)'); return; }
  const read = async (name, from = wine) => (existsSync(`${from}/${name}`) ? readFile(`${from}/${name}`, 'utf8') : null);
  const fact = async (name, from = facts) => JSON.parse(await readFile(`${from}/facts-${name}.json`, 'utf8'));
  const T = (await fact('T')).training, I = await fact('I'), H = (await fact('H')).hq;
  const loaded = async (label, group, saved, dir, source = { wine, facts }) => {
    const text = await read(`${group}-player.props.txt`, source.wine);
    if (text === null) { console.log(`C ${label}: no capture (${group}), not compared`); return; }
    const { player, values } = readProps(text), before = saved.before;
    check(player !== null, `C ${label}: the loaded player is not in the dump`);
    if (player === null) return;
    const same = (name, got, want) => check(got === want, `C ${label}: ${name} is ${got} in the original, Play saved ${want}`);
    // the dump prints a float with %.9g: the same float32
    tuple(values.Location).forEach((v, i) => same(`Location[${i}]`, Math.fround(v), Math.fround(before.location[i])));
    // the pawn's Rotation is not compared: the original turns it after the load (the Island: yaw 3935 at the first dump, the saved -7040 five minutes later, ViewRotation -7040 throughout)
    const turned = tuple(values.Rotation).some((v, i) => v !== before.rotation[i]);
    if (values.ViewRotation) tuple(values.ViewRotation).forEach((v, i) => same(`ViewRotation[${i}]`, v, before.viewRotation[i]));
    for (const [key, want] of [['Health', before.health], ['HealthHead', before.healthHead], ['HealthTorso', before.healthTorso], ['Credits', before.credits], ['SkillPointsAvail', before.skillPointsAvail], ['SkillPointsTotal', before.skillPointsTotal]])
      if (values[key] !== undefined) same(key, Number(values[key]), want);
    if (values.Energy !== undefined) same('Energy', Number(values.Energy), Math.fround(before.energy));
    if (values.CombatDifficulty !== undefined) same('CombatDifficulty', Number(values.CombatDifficulty), before.combatDifficulty);
    // bCheatsEnabled is not a saved property: the original's own level file with the cheats on (wa6) holds no tag for it, Play's holds none, and the loaded player has it off
    // (the SaveInfo keeps the flag: the Load Game screen's cheat marker)
    same('bCheatsEnabled', Number(values.bCheatsEnabled) === 1, false);
    const levelFile = (await readdir(`${source.facts}/${dir}`)).find(name => name.toLowerCase() === `${saved.info.MapName}.dxs`.toLowerCase());
    if (levelFile) {
      const bytes = new Uint8Array(await readFile(`${source.facts}/${dir}/${levelFile}`)), pkg = parsePackage(bytes);
      const at = pkg.exports.findIndex(entry => entry.className === 'JCDentonMale');
      check(at >= 0 && readObject(pkg, bytes, at + 1).values.bCheatsEnabled === undefined, `C ${label}: Play's level file holds a bCheatsEnabled tag on the player (the original's wa6 file, saved with the cheats on, holds none)`);
    }
    same('saveCount', Number(values.saveCount), saved.info.saveCount);
    check(Number(values.saveTime) >= before.saveTime, `C ${label}: saveTime ${values.saveTime} is below Play's ${before.saveTime} (the original adds the time played since the load)`);
    same('inHand', values.inHand === 'None' ? null : values.inHand, before.inHand);
    // the inventory: each saved item is in the loaded player's hands under its own name, whatever file the dump put it in
    const dumps = await Promise.all(['weapons', 'ammo', 'medkit', 'keyring', 'images', 'augs', 'skills'].map(async kind => [kind, await read(`${group}-${kind}.props.txt`, source.wine)]));
    const owners = dumps.flatMap(([, file]) => (file ? readProps(file).owners : []));
    // a session dumps some kinds of item only (the HQ one: weapons): the items of a kind not dumped are not compared
    const kindOf = item => /^weapon/.test(item.class) ? 'weapons' : /^ammo/.test(item.class) ? 'ammo' : item.class === 'medkit' ? 'medkit' : item.class === 'nanokeyring' ? 'keyring' : /^image/.test(item.class) ? 'images' : /^aug/.test(item.class) ? 'augs' : /^skill/.test(item.class) ? 'skills' : null;
    const dumped = new Set(dumps.filter(([, file]) => file).map(([kind]) => kind));
    const compared = before.items.filter(item => dumped.has(kindOf(item)));
    const missing = compared.filter(item => !owners.some(entry => entry.name === item.name && entry.className === item.class && entry.owner === player));
    check(missing.length === 0, `C ${label}: ${missing.length} of ${compared.length} saved items are not the loaded player's: ${missing.slice(0, 4).map(item => item.name)}`);
    // the FlagBase: names, expirations and the hash bucket of each
    const flags = await read(`${group}.flags.txt`, source.wine);
    if (flags !== null) {
      const got = readFlagDump(flags), want = new Set(before.flags);
      const have = new Set(got.map(flag => `${flag.name}@${flag.expiration}`));
      check(got.length === before.flags.length && [...want].every(entry => have.has(entry)), `C ${label}: flags ${[...have].filter(entry => !want.has(entry)).join(',')} are extra, ${[...want].filter(entry => !have.has(entry)).join(',')} missing`);
      for (const flag of got) check(flag.bucket === (hashScriptName(flag.name) & 63), `C ${label}: flag ${flag.name} sits in bucket ${flag.bucket}, Play's hash gives ${hashScriptName(flag.name) & 63}`);
    }
    console.log(`${label}: the original's loaded player = Play's saved one (${compared.length} of ${before.items.length} items dumped and found, ${before.flags.length} flags, Location ${values.Location}${turned ? `; the pawn's Rotation ${values.Rotation} was not the saved one at the dump` : ''}${before.bCheatsEnabled ? '; saved with the cheats on, loaded with them off' : ''})`);
  };
  await loaded('Save0010 (Training)', 'wc-training', T, 'training');
  await loaded('Save0011 (Island)', 'wc-island', I.island, 'island');
  await loaded('Save0012 (HQ)', 'wc-hq', H, 'hq');
  if (existsSync(`${facts2}/facts-I.json`)) {
    const I2 = await fact('I', facts2), source2 = { wine: wine2, facts: facts2 };
    await loaded('Save0011 (Island, the final writer)', 'wc2-island', I2.island, 'island', source2);
    await loaded('QuickSave (Island) through the QuickLoad box', 'wc2-quick', I2.islandQuick, 'island-quick', source2);
  }
  // the log of the whole session: three `LoadGame N` in the loaded-game sequence of travel.md "Load game, restart and URL forms" (Browse, Doing loadgame, LoadMap of Save\Current with
  // ?load?loadonly?loadgame, Login, Possessed) and nothing the original warns about but the two GameReplicationInfo lines every restore of a level prints
  const log = await read('wc-hq-island.log');
  if (log !== null) {
    const rows = log.split(/\r?\n/);
    for (const [n, map] of [[10, '00_training'], [11, '01_NYC_UNATCOIsland'], [12, '01_NYC_UNATCOHQ']]) {
      let at = rows.indexOf(`Log: Browse: Index.dx?loadgame=${n}?Name=Player?Class=DeusEx.JCDentonMale`);
      const steps = ['Log: Doing loadgame, not load', `Log: LoadMap: ..\\Save\\Current\\${map}.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale`, 'ScriptLog: Login: Player', `Log: Possessed PlayerPawn: JCDentonMale ${map}.JCDentonMale0`];
      const found = at >= 0 && steps.every(step => { at = rows.indexOf(step, at + 1); return at >= 0; });
      check(found, `C log: the LoadGame ${n} sequence (Browse, Doing loadgame, LoadMap ${map}, Login, Possessed) is not in the original's log`);
    }
    const warned = rows.filter(row => /^(Warning|Error|Critical)\b/.test(row) && !/Type mismatch in Region of GameReplicationInfo: file 10, class 2|Skipping 6 bytes of type 10/.test(row));
    check(warned.length === 0, `C log: the original warned: ${warned.slice(0, 3).join(' | ')}`);
    console.log(`the original's log: three loaded games in the loaded-game sequence, then LocalTravel from HQ restoring the Island from Current; ${warned.length} warnings besides the two GameReplicationInfo lines`);
  }
  // HQ -> Island by LocalTravel: the Island the slot held (copied from Current) comes back with its ten troops
  const troops = await read('wc-hq-island-troops.actors.txt');
  if (troops !== null) {
    const alive = troops.split('\n').map(row => /^UNATCOTroop (\w+) .* Deleted=0$/.exec(row)?.[1]).filter(Boolean).sort();
    const bytes = new Uint8Array(await readFile(`${facts}/hq/01_NYC_UNATCOIsland.dxs`)), pkg = parsePackage(bytes);
    const saved = pkg.exports.filter(entry => entry.className === 'UNATCOTroop').map(entry => entry.name).sort();
    check(alive.join() === saved.join(), `C HQ -> Island: the restored Island holds troops ${alive}, Play's file ${saved}`);
    console.log(`Save0012 -> LocalTravel to the Island: the original restored the Island Play's slot held, ${alive.length} troops = Play's ${saved.length}`);
  }
}

if (!only || only === 'F') await scenarioF();
if (!only || only === 'S') await scenarioS();
if (!only || only === 'L') await scenarioL();
if (!only || only === 'U') await scenarioU();
if (!only || only === 'W') await scenarioW();
if (!only || only === 'C') await scenarioC();
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length ? `FAIL validate-save-game: ${failures.length} checks` : 'PASS validate-save-game');
void assert; void lower; void hashScriptName;
process.exit(failures.length ? 1 : 0);
