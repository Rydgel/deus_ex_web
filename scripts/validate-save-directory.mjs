#!/usr/bin/env node
/** The Load Game screen's save-game directory (docs/save-directory.md): native 3013 DeusExPlayer.CreateGameDirectoryObject, the GameDirectory
 * natives 3080-3094 and DeusExSaveInfo.UpdateTimeStamp 3075, against the hash-checked DeusEx.dll and the Wine measurements of
 * scripts/save-directory-measurements.json.
 *
 *  1. DLL facts: the format strings, vtable slots, allocation sizes and the instruction bytes the bodies' behavior rests on, and the native
 *     indices DeusEx.u declares for each function (the registry's list).
 *  2. The pure bodies on the measured saves' sizes (Save0001: 3,268,631 + 34,576 bytes = 3225 KB, 4 MB on the original's screen).
 *  3. Play on the logo map DX.dx, MenuMain, Load Game: with an empty save directory (what the original shows with no saves) and with the two saves
 *     of the Wine capture. The screen's state (rows, selection, info text, buttons' sensitivity, the free-space label) and the registry slots
 *     the natives take (the Package `saveInfo`, the snapshots' Texture and Palette, the temporary GameDirectory, LinkerLoad and DeusExSaveInfo
 *     objects' reuse by the windows' GCs) are compared with the original's, slot for slot relative to the screen's own (Play's model of the
 *     original's registry starts 3 slots below the original's at the logo map: docs/save-directory.md "Registry").
 *  4. The natives' own quirks on a prepared directory object: GD_Maps stops by name, PurgeAllSaveInfo's skipped entry. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-save-directory: no installed game data'); process.exit(0); }
const root = gameDirectory();
const measurements = JSON.parse(await readFile(new URL('./save-directory-measurements.json', import.meta.url), 'utf8'));

// The two saves of the capture (their SaveInfo.dxs through parsePackage, 2026-10-21): QuickSave, then Save0001.
const SAVES = [
  {directory: 'QuickSave', files: [{name: '00_training.dxs', size: 3254476}, {name: 'SaveInfo.dxs', size: 34563}],
    info: {properties: {Year: 2026, Month: 9, Day: 9, Hour: 14, Minute: 27, Second: 10, DirectoryIndex: -1, Description: 'Quick Save',
      MissionLocation: 'UNATCO Training Course', MapName: '00_training', saveCount: 4, saveTime: 3406}, snapshot: {texture: 'Texture3', palette: 'Palette3'}}},
  {directory: 'Save0001', files: [{name: '00_training.dxs', size: 3268631}, {name: 'SaveInfo.dxs', size: 34576}],
    info: {properties: {Year: 2026, Month: 9, Day: 12, Hour: 14, Minute: 47, Second: 33, DirectoryIndex: 1, Description: 'UNATCO Training Course',
      MissionLocation: 'UNATCO Training Course', MapName: '00_training', saveCount: 1, saveTime: 983}, snapshot: {texture: 'Texture1', palette: 'Palette1'}}},
];
// What the original's screen showed (Wine screenshots sd1/load1.png, load2.png, empty1.png; the free space is the host volume's)
const ORIGINAL = {
  rows: [['UNATCO Training Course', '09/12/2026 02:47pm', '1368353280.000000', '1.000000'], ['Quick Save', '09/09/2026 02:27pm', '1368051968.000000', '-1.000000']],
  firstInfo: 'Location: UNATCO Training Course\nSave Count: 1\nPlay Time: 00:16:23\nFile Size: 4MB',
  quickInfo: 'Location: UNATCO Training Course\nSave Count: 4\nPlay Time: 00:56:46\nFile Size: 4MB',
};
const FREE_BYTES = 92745808 * 1024;   // the capture's `df` figure for the Wine prefix: the label read 90571MB then 90564MB as other processes wrote

if (process.argv.includes('--scenario')) { await scenario(process.argv[process.argv.indexOf('--scenario') + 1]); process.exit(0); }

// 1. DLL facts ------------------------------------------------------------------------------------------------------------------------------
const dll = await readFile(path.join(root, 'System/DeusEx.dll'));
assert.equal(createHash('sha256').update(dll).digest('hex'), 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04');
const pe = dll.readUInt32LE(60), opt = pe + 24, base = dll.readUInt32LE(opt + 28);
const sections = Array.from({length: dll.readUInt16LE(pe + 6)}, (_, i) => {
  const s = opt + dll.readUInt16LE(pe + 20) + i * 40;
  return {virtual: dll.readUInt32LE(s + 12), size: Math.max(dll.readUInt32LE(s + 8), dll.readUInt32LE(s + 16)), raw: dll.readUInt32LE(s + 20)};
});
const at = va => { const rva = va - base, s = sections.find(s => s.virtual <= rva && rva < s.virtual + s.size); return s.raw + rva - s.virtual; };
const hex = (va, n) => dll.subarray(at(va), at(va) + n).toString('hex');
const wide = va => { let out = ''; for (let o = at(va); dll.readUInt16LE(o); o += 2) out += String.fromCharCode(dll.readUInt16LE(o)); return out; };
const ansi = va => { let out = ''; for (let o = at(va); dll[o]; o += 1) out += String.fromCharCode(dll[o]); return out; };
const dword = va => dll.readUInt32LE(at(va));

const strings = {0x10034ccc: '%s\\%s*', 0x10034524: 'Save', 0x1003453c: 'QuickSave', 0x10034790: '%s%04d', 0x10034d1c: '%s\\%s\\*.*', 0x10034d08: '%s\\%s\\%s',
  0x10034d30: '%s%04d.%s', 0x100344e8: '%s\\%s\\%s.%s', 0x100344c8: '%s\\%s%04d\\%s.%s', 0x100346dc: 'SaveInfo', 0x1003476c: 'MyDeusExSaveInfo', 0x10034d00: 'C:\\'};
for (const [va, text] of Object.entries(strings)) assert.equal(wide(Number(va)), text, `string at 0x${Number(va).toString(16)}`);
assert.equal(ansi(0x10034ce8), 'GetDiskFreeSpaceExA');
assert.equal(ansi(0x10034cdc), 'KERNEL32');
const {GAME_DIRECTORY, SAVE_INFO} = await import('../src/runtime/script-game-directory.mjs');
// XGameDirectory vtable 0x10027e58: +0x0c scalar deleting destructor, +0x24 Destroy, +0x28 Serialize; UDeusExSaveInfo 0x10027a7c: +0x0c, +0x24 (UObject::Destroy thunk)
assert.deepEqual([0xc, 0x24, 0x28].map(o => dword(GAME_DIRECTORY.vtable + o)), [0x10013260, 0x100170d0, 0x100171c0]);
assert.deepEqual([0xc, 0x24].map(o => dword(SAVE_INFO.vtable + o)), [0x1000daa0, 0x10014de0]);
// allocation sizes: `push 0x54` before ??2XGameDirectory (execCreateGameDirectoryObject), `push 0x78` before ??2UDeusExSaveInfo (GetTempSaveInfo)
assert.equal(hex(0x10014baf, 2), '6a54'); assert.equal(hex(0x1001813e, 2), '6a78');
assert.equal(GAME_DIRECTORY.size, 0x54); assert.equal(SAVE_INFO.size, 0x78);
// GetSaveGamesDirectory FindFiles(spec, Files=0 (push ebx), Directories=1 (push 1)); GetSaveDirectorySize FindFiles(spec, Files=1, Directories=0)
assert.equal(hex(0x100175e2, 2), '6a01'); assert.equal(hex(0x100175ea, 1), '53');
assert.equal(hex(0x10017a80, 1), '55'); assert.equal(hex(0x10017a88, 2), '6a01');
// GetSaveInfo: StaticLoadObject(.., LOAD_NoWarn|LOAD_Quiet = 0x2002); DeleteSaveInfo: ResetLoaders(Outer, 0, 1)
assert.equal(hex(0x10017f69, 5), '6802200000'); assert.equal(hex(0x100181a5, 4), '6a016a00');
// GetNewSaveFileIndex: NUL at wide index 4 of the match, the number read from index 5 (+0xa bytes)
assert.equal(hex(0x10017d13, 6), '66c740080000'); assert.equal(hex(0x10017d19, 3), '83c00a');
// GetSaveFreeSpace: GetDiskFreeSpaceExA through GetProcAddress, __alldiv(low, high, 0x400, 0): push 0 (ebx), push 0x400
assert.equal(hex(0x100178fa, 2), 'ffd0'); assert.equal(hex(0x1001790d, 8), '53680004000050' + '51');
// GetDirFilename / GenerateNewSaveFilename exec thunk: the int parameter starts at -1
assert.equal(hex(0x10018532, 7), 'c745f0ffffffff');

// the indices DeusEx.u declares
const {parsePackage} = await import('../src/unreal/package.mjs');
const {readFunctionMetadata} = await import('../src/unreal/script-metadata.mjs');
const {GAME_DIRECTORY_NATIVES} = await import('../src/runtime/script-game-directory.mjs');
const dxBytes = new Uint8Array(await readFile(path.join(root, 'System/DeusEx.u'))), dxPackage = parsePackage(dxBytes);
const declared = path => readFunctionMetadata({pkg: dxPackage, bytes: dxBytes}, dxPackage.exports.findIndex(e => e.path === path) + 1).nativeIndex;
assert.equal(declared('DeusExPlayer.CreateGameDirectoryObject'), GAME_DIRECTORY_NATIVES.create);
assert.equal(declared('DeusExSaveInfo.UpdateTimeStamp'), GAME_DIRECTORY_NATIVES.updateTimeStamp);
const members = ['GetGameDirectory', 'GetNewSaveFileIndex', 'GenerateSaveFilename', 'GenerateNewSaveFilename', 'GetDirCount', 'GetDirFilename', 'SetDirType',
  'SetDirFilter', 'GetSaveInfo', 'GetSaveInfoFromDirectoryIndex', 'GetTempSaveInfo', 'DeleteSaveInfo', 'PurgeAllSaveInfo', 'GetSaveFreeSpace', 'GetSaveDirectorySize'];
members.forEach((name, i) => assert.equal(declared(`GameDirectory.${name}`), 3080 + i, name));
assert.equal(3080 + members.length - 1, GAME_DIRECTORY_NATIVES.last);

// 2. The pure bodies on the measured sizes --------------------------------------------------------------------------------------------------
const directoryModule = await import('../src/runtime/save-directory.mjs');
const {saveDirectoryKilobytes, saveFreeKilobytes, createSaveDirectory} = directoryModule;
const directory = createSaveDirectory({saves: SAVES, freeSpaceBytes: FREE_BYTES});
// Save0001: 3268631 / 1024 = 3192, 34576 / 1024 = 33: 3225 KB, / 1024 + 1 = 4 (MenuScreenLoadGame.UpdateSaveInfo), as the screen said
assert.equal(saveDirectoryKilobytes(directory.files('Save0001')), 3225);
assert.equal(Math.trunc(saveDirectoryKilobytes(directory.files('Save0001')) / 1024) + 1, 4);
assert.equal(Math.trunc(saveDirectoryKilobytes(directory.files('QuickSave')) / 1024) + 1, 4);
assert.equal(saveFreeKilobytes(FREE_BYTES), 92745808);
assert.equal(Math.trunc(saveFreeKilobytes(FREE_BYTES) / 1024), 90572);

// 3. Play on DX.dx --------------------------------------------------------------------------------------------------------------------------
const realSaves = process.env.DX_SAVE_DIR ?? path.join(process.env.HOME ?? '', '.wine-deusex/drive_c/Deus Ex GOTY Edition/Save');
const haveReal = await readFile(path.join(realSaves, 'Save0001/SaveInfo.dxs')).then(() => true, () => false);
for (const name of ['empty', 'saves', ...(haveReal ? ['real'] : [])]) {
  const child = spawnSync(process.execPath, [import.meta.filename, '--scenario', name], {encoding: 'utf8', maxBuffer: 1 << 26});
  process.stdout.write(child.stdout ?? '');
  if (child.status !== 0) { process.stderr.write(child.stderr ?? ''); throw new Error(`scenario ${name} failed (exit ${child.status}, ${child.signal ?? ''})`); }
}
console.log('validate-save-directory: DeusEx.dll facts, the measured sizes, and the Load Game screen of DX.dx (empty and with the two measured saves) '
  + 'agree with the original: rows, texts, buttons and registry slots');

async function scenario(name) {
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
  const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');
  const {createMenuDriver} = await import('../src/viewer/menu-driver.mjs');
  const {createSaveDirectory} = await import('../src/runtime/save-directory.mjs');
  const {UnsupportedGameDirectoryError} = await import('../src/runtime/script-game-directory.mjs');
  const files = [];
  for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const file of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${file}`, read: () => readFile(`${root}/${dir}/${file}`)});
  const assets = new AssetStore(files), asset = await assets.get('DX');
  const withSaves = name !== 'empty', real = name === 'real';
  // `real`: the two saves of the Wine capture read from their files (src/runtime/save-info.mjs parseSaveInfo over the SaveInfo.dxs bytes):
  // the properties, and the snapshot picture the screen draws
  let saves = withSaves ? SAVES : [];
  const realFiles = new Map();
  if (real) {
    const {parseSaveInfo} = await import('../src/runtime/save-info.mjs');
    const dir = process.env.DX_SAVE_DIR ?? path.join(process.env.HOME ?? '', '.wine-deusex/drive_c/Deus Ex GOTY Edition/Save');
    saves = [];
    for (const slot of ['QuickSave', 'Save0001']) {
      const info = parseSaveInfo(await readFile(path.join(dir, slot, 'SaveInfo.dxs')));
      realFiles.set(slot, info);
      saves.push({directory: slot, files: SAVES.find(save => save.directory === slot).files, info});
    }
    for (const save of SAVES) assert.deepEqual(realFiles.get(save.directory).properties, save.info.properties, `${save.directory}: the properties read from the file`);
  }
  const saveDirectory = createSaveDirectory({saves, freeSpaceBytes: FREE_BYTES});
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true, saveDirectory});
  const runtime = game.doors.scriptRuntime.runtime;
  const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
  const input = createPlayerInputFixture(game, {paint});
  const driver = createMenuDriver(game);
  const model = runtime.actorLifecycle.construction.registry.original;
  assert.ok(model, 'the registry model is seeded');
  input.tick(30);
  driver.showMainMenu(); input.tick(5);
  assert.equal(driver.top(), 'deusex.menumain');
  model.log = [];
  driver.invoke('MenuScreenLoadGame'); input.tick(10);
  assert.equal(driver.top(), 'deusex.menuscreenloadgame', 'the Load Game screen opens');
  const screenSlot = model.log.find(e => e.ev === 'add' && e.cls === 'MenuScreenLoadGame').index;
  const relative = list => list.map(i => i - screenSlot);
  const live = new Map();
  // (a Texture that is a script object is labelled by its own name in the model's log, `Texture3.Texture3`: the class record the label reads has
  // no `name`; the slot is what the original's dump compares)
  const replay = () => { live.clear(); for (const e of model.log) { if (e.ev === 'add') live.set(e.index, `${/^Texture\d+$/.test(e.cls) ? 'Texture' : e.cls}.${e.name ?? ''}`); else live.delete(e.index); } };
  const sensitivity = () => { const c = driver.controls(); return Object.fromEntries(c.menu.actionButtons.filter(b => b.window !== null).map(b => [b.key || '(cancel)', c.windows[b.window].sensitive])); };
  const freeText = () => driver.windowText('winFreeSpace');
  const expectedMB = Math.trunc(Math.trunc(FREE_BYTES / 1024) / 1024);

  // the screen's state
  const opened = driver.listRows('lstGames');
  assert.equal(freeText(), `Free Space: ${expectedMB}MB`);
  assert.equal(runtime.readNamed(driver.topWindow(), 'freeDiskSpace'), Math.trunc(FREE_BYTES / 1024));
  const expectation = measurements[withSaves ? 'saves' : 'empty'];
  const windowHost = game.doors.scriptRuntime.windowHost;
  if (!withSaves) {
    assert.deepEqual(opened.rows, [], 'no rows without saves (the original shows no empty-list text)');
    assert.equal(opened.selectedCount, 0);
    assert.equal(driver.windowText('winSaveInfo'), '');
    assert.deepEqual(sensitivity(), {'(cancel)': true, LOAD: false, DELETE: false}, 'Load Game and Delete Game are insensitive with no row; Cancel is not');
  } else {
    assert.deepEqual(opened.rows, ORIGINAL.rows, 'rows sorted by date, newest first: the original lists the Save0001 row above Quick Save');
    assert.equal(opened.selected, 0, 'the first row is selected');
    assert.equal(driver.windowText('winSaveInfo'), ORIGINAL.firstInfo);
    assert.deepEqual(sensitivity(), {'(cancel)': true, LOAD: true, DELETE: true});
  }
  // the registry slots after the screen opened
  replay();
  const after = expectation.afterOpen;
  assert.equal(model.count - screenSlot, after.objects, 'the number of objects the screen left');
  assert.deepEqual(relative(model.freeIndices), after.free, 'the free slots (none: the windows\' GCs reused every slot the natives freed)');
  const named = pattern => Object.fromEntries([...live].filter(([, n]) => pattern.test(n)).map(([i, n]) => [n, i - screenSlot]));
  assert.deepEqual(named(/^(Package|Texture|Palette)\./), after.survivors, 'the Package saveInfo and the snapshot exports stay');
  assert.deepEqual(named(/^GC\.GC27[2-5]$/), after.gc, 'the GCs created after the natives reused the freed slots in the measured order');

  // The snapshot picture (docs/save-storage.md "The snapshot"): the DeusExSaveInfo's Snapshot is a Texture the window host adopted, and the screen's
  // snapshot window draws it through its background: the tile of the Wine capture, the picture's top-left 160 x 120 of the 256 x 128 texture, unscaled
  // (sd1/load1.png: the row of lights at x 13..160 of the texture sits at the window's own x 13..160)
  let snapshotPixels = null, snapshotTile = null;
  if (real) {
    ({snapshotPixels} = await import('../src/runtime/save-info.mjs'));
    snapshotTile = () => {
      const tiles = paint().filter(c => c.texture?.dynamic && /^image:/.test(c.texture.key));
      assert.equal(tiles.length, 1, 'one snapshot picture on the screen');
      return tiles[0];
    };
    const sent = windowHost.display.images;
    assert.equal(sent.length, 2, 'the page is sent each picture once: PopulateGames loaded the two SaveInfos, the first row\'s selection found the objects');
    for (const [image, slot] of [[sent[0], 'QuickSave'], [sent[1], 'Save0001']]) {
      const expected = snapshotPixels(realFiles.get(slot).snapshot.image);
      assert.equal(image.width, 256); assert.equal(image.height, 128);
      assert.ok(Buffer.from(image.data).equals(Buffer.from(expected.data)), `${slot}: the pixels the page gets are the palette applied to the file's P8 texture`);
    }
    const tile = snapshotTile();
    assert.equal(tile.texture.key, sent[1].key, 'the selected first row (Save0001) draws its own snapshot');
    assert.deepEqual([tile.u, tile.v, tile.ul, tile.vl, tile.style], [0, 0, 160, 120, 1], 'the window shows the top-left 160 x 120 of the texture, unscaled, in the normal style');
    assert.equal(tile.width * 3, tile.height * 4, 'the 160 x 120 window (4:3)');
    const snapshotObject = runtime.readNamed(driver.topWindow(), 'winSnapshot');
    assert.ok(snapshotObject, 'the snapshot window');
  }
  if (withSaves) {
    game.windowKey('ArrowDown', true); game.windowKey('ArrowDown', false); input.tick(5);
    const second = driver.listRows('lstGames');
    assert.equal(second.selected, 1, 'the second row (Quick Save) is selected');
    assert.equal(driver.windowText('winSaveInfo'), ORIGINAL.quickInfo);
    if (real) {
      assert.equal(snapshotTile().texture.key, windowHost.display.images[0].key, 'selecting Quick Save shows its own picture');
      assert.equal(windowHost.display.images.length, 2, 'the selection loaded the SaveInfo again: its Texture exists, the picture is not sent again');
    }
    assert.deepEqual(sensitivity(), {'(cancel)': true, LOAD: true, DELETE: false}, 'Quick Save cannot be deleted (DirectoryIndex < 0)');
    assert.equal(model.count - screenSlot, expectation.afterSelectQuickSave.objects);
    assert.deepEqual(relative(model.freeIndices), expectation.afterSelectQuickSave.free,
      'selecting a row creates a GameDirectory, a LinkerLoad and a DeusExSaveInfo and frees them (linker, save info, directory)');
  }
  // Escape closes the screen: the windows' teardown frees their slots in the original's order (the GameDirectory objects were freed already)
  game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(10);
  assert.equal(driver.top(), 'deusex.menumain');
  replay();
  const closed = expectation.afterEscape;
  assert.equal(model.count - screenSlot, closed.objects);
  assert.deepEqual(relative(model.freeIndices), closed.free, 'the free list after the screen closed (the original\'s GObjAvailable, slot for slot)');
  if (withSaves) assert.deepEqual(named(/^(Package|Texture|Palette)\./), closed.survivors, 'the Package saveInfo and the snapshot exports stay resident');
  // the natives' quirks, on a directory object of this session
  const player = game.player.collisionActor;
  const call = (target, fn, ...args) => game.hud.scoped(() => runtime.callFunction(runtime.lookup(target, fn), target, args.length, i => args[i]));
  if (withSaves) {
    const created = game.hud.scoped(() => runtime.callFunction(runtime.lookup(player, 'CreateGameDirectoryObject'), player, 0, () => undefined));
    call(created, 'SetDirType', 1); call(created, 'GetGameDirectory');
    assert.equal(call(created, 'GetDirCount'), 1, 'the Save* directories: Save0001 (QuickSave and Current are not matched)');
    assert.equal(call(created, 'GetDirFilename', 0), 'Save0001'); assert.equal(call(created, 'GetDirFilename', 1), '');
    assert.equal(call(created, 'GetNewSaveFileIndex'), 2, 'the number of Save0001 read from its sixth character: "001"');
    assert.equal(call(created, 'GenerateNewSaveFilename'), 'Save0002.dxs'); assert.equal(call(created, 'GenerateSaveFilename', 7), 'Save0007.dxs');
    assert.equal(call(created, 'GetSaveFreeSpace'), Math.trunc(FREE_BYTES / 1024));
    assert.equal(call(created, 'GetSaveDirectorySize', -1), 3211); assert.equal(call(created, 'GetSaveDirectorySize', 1), 3225);
    assert.equal(call(created, 'GetSaveInfo', 2), null, 'no Save0002');
    // PurgeAllSaveInfo's loop re-reads Num after each delete, so with two entries the second is skipped (and leaks); a second SaveInfo of the
    // package cannot be loaded while the first is (a named stop), so the list is set to a loaded one and the temporary one
    const a = call(created, 'GetSaveInfo', 1), t = call(created, 'GetTempSaveInfo');
    assert.equal(runtime.readNamed(a, 'Description'), 'UNATCO Training Course');
    assert.throws(() => call(created, 'GetSaveInfo', -1), error => error instanceof UnsupportedGameDirectoryError, 'a second load of the export is a named stop');
    runtime.writeNamed(created, 'loadedSaveInfoPointers', [a, t]);
    call(created, 'PurgeAllSaveInfo');
    assert.equal(runtime.isReleased(a), true); assert.equal(runtime.isReleased(t), false, 'the entry the loop skipped stays allocated');
    assert.deepEqual(runtime.readNamed(created, 'loadedSaveInfoPointers'), []);
    // a missing file appends a null pointer (0x10017fb7); a save made with cheats says so; the snapshot texture is not created
    saveDirectory.put({directory: 'Save0002', files: [{name: 'SaveInfo.dxs', size: 10}], info: {properties: {Year: 2026, Month: 10, Day: 21, Hour: 0, Minute: 5, Second: 0,
      DirectoryIndex: 2, Description: 'Cheater', MissionLocation: 'Somewhere', MapName: '01_nyc_unatcoisland', saveCount: 1, saveTime: 61, bCheatsEnabled: true}, snapshot: null}});
    call(created, 'GetGameDirectory');
    assert.equal(call(created, 'GetDirCount'), 2); assert.equal(call(created, 'GetNewSaveFileIndex'), 3);
    const cheat = call(created, 'GetSaveInfo', 2);
    assert.equal(runtime.readNamed(cheat, 'bCheatsEnabled'), true); assert.equal(runtime.readNamed(cheat, 'Snapshot'), null);
    assert.equal(runtime.readNamed(cheat, 'saveTime'), 61); assert.equal(runtime.readNamed(cheat, 'Description'), 'Cheater');
    assert.equal(call(created, 'GetSaveInfo', 9), null);
    assert.deepEqual(runtime.readNamed(created, 'loadedSaveInfoPointers'), [cheat, null], 'the loaded list holds the object and the null of the missing file');
    game.hud.scoped(() => runtime.criticalDelete({argumentCount: 1, evaluateArgument: () => created}));
    assert.equal(runtime.isReleased(created), true); assert.equal(runtime.isReleased(t), true, 'Destroy deletes the temporary SaveInfo');
  } else {
    const created = game.hud.scoped(() => runtime.callFunction(runtime.lookup(player, 'CreateGameDirectoryObject'), player, 0, () => undefined));
    call(created, 'SetDirType', 0);
    assert.throws(() => call(created, 'GetGameDirectory'), error => error instanceof UnsupportedGameDirectoryError, 'GD_Maps stops by name');
    call(created, 'SetDirType', 1); call(created, 'GetGameDirectory');
    assert.equal(call(created, 'GetDirCount'), 0); assert.equal(call(created, 'GetSaveInfo', -1), null);
    assert.equal(call(created, 'GetSaveInfoFromDirectoryIndex', 0), null); assert.equal(call(created, 'GetNewSaveFileIndex'), 1);
    assert.equal(call(created, 'GetSaveDirectorySize', 1), 0);
    const temp = call(created, 'GetTempSaveInfo');
    assert.equal(call(created, 'GetTempSaveInfo'), temp, 'one temp SaveInfo per directory');
    call(temp, 'UpdateTimeStamp');
    assert.ok(runtime.readNamed(temp, 'Year') >= 2026);
  }
  console.log(`  scenario ${name}: rows ${JSON.stringify(opened.rows.map(r => r[0]))}, ${model.count - screenSlot} objects, slots as measured`);
}
