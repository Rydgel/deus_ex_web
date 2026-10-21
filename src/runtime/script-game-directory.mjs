/** DeusEx.GameDirectory and DeusExSaveInfo's natives, and DeusExPlayer.CreateGameDirectoryObject (docs/save-directory.md): the
 * save-game directory the Load Game and Save Game screens read.
 *
 *   3013 DeusExPlayer.CreateGameDirectoryObject   0x10014b90: `new(0x54)` XGameDirectory in GetTransientPackage() (flags 0, name None), then the
 *                                                 constructor 0x10017090 (the five members zero; the vtable 0x10027e58)
 *   3075 DeusExSaveInfo.UpdateTimeStamp           0x10014df0: appSystemTime into Year..Second (the local clock)
 *   3080 GameDirectory.GetGameDirectory           0x100171e0: by gameDirectoryType (+0x28): 0 GetMapsDirectory, 1 GetSaveGamesDirectory
 *   3081 GetNewSaveFileIndex 0x10017cc0    3082 GenerateSaveFilename 0x10017d60    3083 GenerateNewSaveFilename 0x10017e30
 *   3084 GetDirCount 0x10017e70            3085 GetDirFilename 0x10017e80          3086 SetDirType 0x10018280   3087 SetDirFilter 0x10018290
 *   3088 GetSaveInfo 0x10017eb0            3089 GetSaveInfoFromDirectoryIndex 0x10018000   3090 GetTempSaveInfo 0x10018120
 *   3091 DeleteSaveInfo 0x10018170         3092 PurgeAllSaveInfo 0x10018240
 *   3093 GetSaveFreeSpace 0x10017770       3094 GetSaveDirectorySize 0x100179d0
 *
 * What each reads is Play's save directory (save-directory.mjs); the file system calls of the originals become its reads. The object slots
 * follow the measured Wine sequence (docs/save-directory.md "Registry"): a GameDirectory takes one slot; a StaticLoadObject of a SaveInfo
 * takes the Package `saveInfo` (the first time), a LinkerLoad (when the package has none), the DeusExSaveInfo and the Texture and Palette
 * exports of its snapshot (once each); DeleteSaveInfo frees the LinkerLoad (ResetLoaders), then the DeusExSaveInfo; the directory's Destroy
 * purges what is still loaded and the object's own slot goes last.
 *
 * Unsupported, by name: the Maps directory (GD_Maps: the developer's LoadMapWindow), and a SaveInfo's Snapshot texture (the Snapshot property
 * of a loaded DeusExSaveInfo stays None; the Texture and Palette exports take their slots, no Texture object exists). */
import {refValue} from './script-vm.mjs';
import {msvcrtWtoi} from './script-text-parser.mjs';
import {saveSlotDirectory, wildcardMatch, saveDirectoryKilobytes, saveFreeKilobytes, newSaveFileIndex, generateSaveFilename} from './save-directory.mjs';

export const GAME_DIRECTORY = Object.freeze({vtable: 0x10027e58, size: 0x54});
export const SAVE_INFO = Object.freeze({vtable: 0x10027a7c, size: 0x78, name: 'MyDeusExSaveInfo', packageName: 'saveInfo', flags: 0x70004});
/** The natives of the two classes and the player's creator, as the registry lists them. */
export const GAME_DIRECTORY_NATIVES = Object.freeze({create: 3013, updateTimeStamp: 3075, first: 3080, last: 3094});

export class UnsupportedGameDirectoryError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'UnsupportedGameDirectoryError'; Object.assign(this, details); }
}

/** The local clock as appSystemTime reports it: {Year, Month, Day, Hour, Minute, Second}. A host input. */
export const browserClock = () => {
  const now = new Date();
  return {Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate(), Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds()};
};

const SAVE_INFO_PROPERTIES = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'DirectoryIndex', 'Description', 'MissionLocation', 'MapName', 'saveCount', 'saveTime', 'bCheatsEnabled'];

export async function prepareGameDirectoryStore({runtime, assets, directory, clock = browserClock, atoi = msvcrtWtoi}) {
  if (!directory) throw new Error('GameDirectory requires the save directory');
  const dx = await assets.get('DeusEx');
  const directoryClass = await runtime.loadClass(dx, dx.exportsByPath.get('gamedirectory'));
  const infoClass = await runtime.loadClass(dx, dx.exportsByPath.get('deusexsaveinfo'));
  for (const cls of [directoryClass, infoClass]) for (const field of cls.propertyLink ?? []) await runtime.field(field);
  for (const path of ['deusexplayer.creategamedirectoryobject', 'deusexsaveinfo.updatetimestamp',
    ...['getgamedirectory', 'getnewsavefileindex', 'generatesavefilename', 'generatenewsavefilename', 'getdircount', 'getdirfilename', 'setdirtype',
      'setdirfilter', 'getsaveinfo', 'getsaveinfofromdirectoryindex', 'gettempsaveinfo', 'deletesaveinfo', 'purgeallsaveinfo', 'getsavefreespace',
      'getsavedirectorysize'].map(name => `gamedirectory.${name}`)])
    await runtime.prepareFunction(dx, dx.exportsByPath.get(path));
  const construction = () => runtime.actorLifecycle?.construction;
  const original = () => construction()?.registry?.original ?? null;
  const get = (object, name) => runtime.readNamed(object, name), set = (object, name, value) => runtime.writeNamed(object, name, value);

  // The Package `saveInfo`: created by the first load of a SaveInfo.dxs (GetPackageLinker's CreatePackage), resident from then on.
  const saveInfoPackage = {record: null, linker: null, exports: new Set()};
  const packageRecord = () => {
    if (saveInfoPackage.record) return saveInfoPackage.record;
    const base = construction(), resolved = base.internName(SAVE_INFO.packageName);
    const record = {identity: {kind: 'Package', key: 'package:saveinfo', name: resolved.name}, index: -1, hashNext: null, stateFrame: null,
      linker: null, linkerIndex: -1, outer: null, flags: 0, name: resolved.name, nameIndex: resolved.index,
      objectClass: runtime.resources.nativeClass('Core.Package')};
    base.registry.add(record);
    return saveInfoPackage.record = record;
  };
  const takeLinker = () => {
    if (saveInfoPackage.linker) return;
    const holder = {kind: 'LinkerLoad'};
    original()?.take(holder, 'LinkerLoad', null);
    saveInfoPackage.linker = holder;
  };
  /** UObject::ResetLoaders(Package, 0, 1): the package's LinkerLoad is deleted (its slot goes back). */
  const resetLoaders = () => {
    const holder = saveInfoPackage.linker;
    if (!holder) return;
    saveInfoPackage.linker = null;
    original()?.giveBack(holder);
  };

  const unregistered = (native, destroy) => { native.nativeVtable = 0x10179dfc; native.destroy = destroy; };
  /** UDeusExSaveInfo's constructor 0x10014dc0: UObject's, then DirectoryIndex (+0x40) = 0 and the vtable 0x10027a7c, whose Destroy
   * (0x10014de0) is UObject::Destroy. */
  const constructSaveInfo = object => {
    const native = runtime.instance(object).nativeObject;
    unregistered(native, receiver => runtime.destroyObjectBase(receiver));
    set(object, 'DirectoryIndex', 0);
    native.nativeVtable = SAVE_INFO.vtable;
    return object;
  };
  const allocateSaveInfo = (outer, name, flags) => runtime.allocateObject(infoClass, {outer, name, flags, template: null}, {
    ...construction(), initNativeProperties: () => {},
    validate: args => args.cls === infoClass && args.outer === outer && args.template === null && args.flags === flags && args.name === name,
  });

  /** StaticLoadObject(DeusExSaveInfo, NULL, "MyDeusExSaveInfo", "<SavePath>\<dir>\SaveInfo.dxs", LOAD_NoWarn|LOAD_Quiet): null when the file is absent
   * (the original creates nothing then: the empty directory's dump has no Package `saveInfo`). */
  const loadSaveInfo = name => {
    const found = directory.info(name);
    if (!found) return null;
    const outer = packageRecord();
    // The export is already loaded (a SaveInfo of the package is still held): the original's linker answers with that object. Not measured: the
    // Load Game and Save Game scripts delete each SaveInfo before they load another.
    if (construction().findObject(outer, SAVE_INFO.name))
      throw new UnsupportedGameDirectoryError(`StaticLoadObject of ${SAVE_INFO.name} while one is loaded is not implemented`, {native: 3088});
    takeLinker();
    const object = constructSaveInfo(allocateSaveInfo(outer, SAVE_INFO.name, SAVE_INFO.flags));
    // the properties the file serialized; the Snapshot Texture (and the Palette its Preload creates) are objects of the package: created once
    for (const key of SAVE_INFO_PROPERTIES) if (found.properties[key] !== undefined) set(object, key, found.properties[key]);
    if (found.snapshot) {
      for (const [cls, export_] of [['Texture', found.snapshot.texture], ['Palette', found.snapshot.palette]]) {
        const key = `${cls}.${export_}`.toLowerCase();
        if (saveInfoPackage.exports.has(key)) continue;
        saveInfoPackage.exports.add(key);
        original()?.take({kind: cls}, cls, export_);
      }
    }
    return object;
  };
  const pointers = receiver => get(receiver, 'loadedSaveInfoPointers');
  /** GetSaveInfo and GetSaveInfoFromDirectoryIndex append what StaticLoadObject returned, a null too (0x10017fb7, 0x100180dc). */
  const remember = (receiver, object) => { set(receiver, 'loadedSaveInfoPointers', [...pointers(receiver), object]); return object; };

  /** XGameDirectory::DeleteSaveInfo 0x10018170: a null does nothing; a pointer the directory does not hold does nothing; else ResetLoaders of
   * its Outer (the LinkerLoad goes), the scalar deleting destructor (vtable +0x0c), and the entry is removed. */
  const deleteSaveInfo = (receiver, info) => {
    if (info === null || info === undefined) return;
    const list = pointers(receiver), at = list.indexOf(info);
    if (at < 0) return;
    resetLoaders();
    runtime.deleteObject(info);
    const next = [...pointers(receiver)];
    next.splice(at, 1);
    set(receiver, 'loadedSaveInfoPointers', next);
  };
  /** 0x10018240: for i = 0; i < Num (re-read); i++: DeleteSaveInfo(list[i]) (which removes the entry it deletes, so every second one is
   * skipped), then the array is emptied: the ones skipped are not deleted (they stay allocated until a collection). */
  const purgeAllSaveInfo = receiver => {
    for (let i = 0; i < pointers(receiver).length; i++) deleteSaveInfo(receiver, pointers(receiver)[i]);
    set(receiver, 'loadedSaveInfoPointers', []);
  };
  /** XGameDirectory::Destroy 0x100170d0: the directory list's strings and array are released, PurgeAllSaveInfo, the temp SaveInfo (+0x50) is deleted
   * through its scalar deleting destructor, then UObject::Destroy. */
  const destroyDirectory = receiver => {
    set(receiver, 'directoryList', []);
    purgeAllSaveInfo(receiver);
    const temp = get(receiver, 'tempSaveInfo');
    if (temp) runtime.deleteObject(temp);
    runtime.destroyObjectBase(receiver);
  };
  const createDirectory = receiver => {
    if (receiver === null || receiver === undefined) throw new Error('CreateGameDirectoryObject requires the player');
    const base = construction(), outer = base?.transientPackage;
    if (!outer) throw new Error('CreateGameDirectoryObject requires GetTransientPackage()');
    const object = runtime.allocateObject(directoryClass, {outer, name: 'None', flags: 0, template: null}, {...base, initNativeProperties: () => {},
      validate: args => args.cls === directoryClass && args.outer === outer && args.template === null && args.flags === 0 && String(args.name).toLowerCase() === 'none'});
    const native = runtime.instance(object).nativeObject;
    unregistered(native, destroyDirectory);
    native.nativeVtable = GAME_DIRECTORY.vtable;
    // XGameDirectory::Serialize (0x100171c0, vtable +0x28) serializes only the directory list (+0x38, strings): the loaded SaveInfo pointers and
    // the temp SaveInfo are not references a collection sees
    native.serializeReferences = () => 0;
    return object;
  };
  const getSaveGamesDirectory = receiver => {
    set(receiver, 'gameDirectoryType', 1);
    const names = directory.directories().filter(name => wildcardMatch('Save*', name));
    set(receiver, 'directoryList', names);
  };
  const getTempSaveInfo = receiver => {
    const existing = get(receiver, 'tempSaveInfo');
    if (existing) return existing;
    const outer = construction().transientPackage;
    const object = constructSaveInfo(allocateSaveInfo(outer, 'None', 0));
    set(receiver, 'tempSaveInfo', object);
    return object;
  };
  const argument = (call, index) => refValue(call.evaluateArgument(index));
  const noArguments = (call, what) => { if (call.argumentCount !== 0) throw new Error(`${what} takes no arguments`); };

  const previous = runtime.native;
  for (let native = GAME_DIRECTORY_NATIVES.first; native <= GAME_DIRECTORY_NATIVES.last; native++) runtime.boundaryNatives.add(native);
  runtime.boundaryNatives.add(GAME_DIRECTORY_NATIVES.create);
  runtime.boundaryNatives.add(GAME_DIRECTORY_NATIVES.updateTimeStamp);
  runtime.native = call => {
    const receiver = call.receiver;
    switch (call.index) {
      case 3013: noArguments(call, 'CreateGameDirectoryObject'); return createDirectory(receiver);
      case 3075: {
        noArguments(call, 'UpdateTimeStamp');
        const now = clock();
        for (const key of ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second']) set(receiver, key, now[key]);
        return undefined;
      }
      case 3080:
        noArguments(call, 'GetGameDirectory');
        if (get(receiver, 'gameDirectoryType') === 0)
          throw new UnsupportedGameDirectoryError('GameDirectory.GetGameDirectory of GD_Maps (the developer map list) is not implemented', {native: 3080});
        getSaveGamesDirectory(receiver);
        return undefined;
      case 3081: noArguments(call, 'GetNewSaveFileIndex'); return newSaveFileIndex(get(receiver, 'directoryList'), atoi);
      case 3082: return generateSaveFilename(argument(call, 0) | 0);
      case 3083: {
        // the exec thunk's int parameter starts at -1 (0x10018532): omitted, the new index is looked up
        let slot = call.argumentCount === 0 ? -1 : argument(call, 0) | 0;
        getSaveGamesDirectory(receiver);
        if (slot === -1) slot = newSaveFileIndex(get(receiver, 'directoryList'), atoi);
        return generateSaveFilename(slot);
      }
      case 3084: noArguments(call, 'GetDirCount'); return get(receiver, 'directoryList').length;
      case 3085: { const entry = argument(call, 0) | 0, names = get(receiver, 'directoryList'); return entry >= 0 && entry < names.length ? names[entry] : ''; }
      case 3086: set(receiver, 'gameDirectoryType', argument(call, 0) & 255); return undefined;
      case 3087: set(receiver, 'currentFilter', String(argument(call, 0) ?? '')); return undefined;
      case 3088: return remember(receiver, loadSaveInfo(saveSlotDirectory(argument(call, 0) | 0)));
      case 3089: {
        const entry = argument(call, 0) | 0, names = get(receiver, 'directoryList');
        if (entry < 0 || entry >= names.length) return null;
        return remember(receiver, loadSaveInfo(names[entry]));
      }
      case 3090: noArguments(call, 'GetTempSaveInfo'); return getTempSaveInfo(receiver);
      case 3091: deleteSaveInfo(receiver, argument(call, 0)); return undefined;
      case 3092: noArguments(call, 'PurgeAllSaveInfo'); purgeAllSaveInfo(receiver); return undefined;
      case 3093: noArguments(call, 'GetSaveFreeSpace'); return saveFreeKilobytes(directory.freeSpaceBytes());
      case 3094: return saveDirectoryKilobytes(directory.files(saveSlotDirectory(argument(call, 0) | 0)));
      default: return previous(call);
    }
  };
  return {directory, loadSaveInfo, createDirectory, saveInfoPackage};
}
