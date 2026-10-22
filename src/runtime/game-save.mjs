/** DDeusExGameEngine::SaveGame (DeusEx.dll 0x1000ef10), DeleteGame (0x10010710) and their callers over Play's save directory
 * (docs/travel.md "SaveGame", docs/save-storage.md "Writing a save").
 *
 * DeusExPlayer.SaveGame (native 3011, ADeusExPlayer::execSaveGame 0x10014830: the index and the optional description, then
 * `GetLevel()->Engine->SaveGame(index, description)`), QuickSave (index -1, the localized "Quick Save"), the Save Game screen (index 0 for a new
 * slot, or an existing slot's) and the console `SAVEGAME n` (DDeusExGameEngine::Exec 0x1000ed70, description "") are one function. In the original's order:
 *
 *   1. a viewport actor and a DeusExLevelInfo are required (else: nothing; for the level info `WARNING!  DeusExLevelInfo MISSING!`);
 *   2. the SaveInfo object (`MyDeusExSaveInfo` of the package `saveInfo`, found through LoadSaveInfo(-2), which warns when Current\SaveInfo.dxs is missing)
 *      is filled: MapName and MissionLocation from the DeusExLevelInfo, Description = the description or the level's Title, DirectoryIndex = the index,
 *      saveCount = ++player.saveCount, saveTime = ftol(player.saveTime), UpdateTimeStamp (the local clock), bCheatsEnabled (the player's), and, unless the render
 *      device is OpenGLDrv.OpenGLRenderDevice, a new Texture (CreateTexture) that the root window's GenerateSnapshot fills with the 160 x 120 picture of the
 *      frame the player sees (SetSnapshotSize(160, 120) first: a side effect that stays on the root window);
 *   3. an index of 0 is a new slot: XGameDirectory::GetNewSaveFileIndex over the Save* directories (largest number + 1);
 *   4. the destination is `Save\QuickSave` for -1, else `Save\Save%04d` of the SaveInfo's index (made if absent); DeleteSaveGameFiles(destination) empties it
 *      (releasing the level package's loaders: the log's `Unloading: Package`), CopySaveGameFiles(Current, destination) copies every `*.dxs` with its time;
 *   5. SavePackage writes `SaveInfo.dxs` (log: `Save=<ms>`, `Moving ... SaveInfo.dxs`), then SaveCurrentLevel(index) writes the level the player is in into the slot,
 *      with the player (PruneTravelActors does not run): the brush tracker, CleanupDestroyed(1), `Save=<ms>`, `Moving ... <MapName>.dxs`, the movers' SavedPos reset.
 * DeleteGame(n) deletes the directory `Save%04d` of n and everything in it (DeleteDirectory, Tree).
 *
 * Differences from the original, each labelled where it is:
 *   - The picture comes from the page (the simulation has no frame): the SaveInfo is built with a black picture, the page answers with the grey 160 x 120 of the
 *     frame it draws next (RootWindow.GenerateSnapshot's own pixel work, script-root-snapshot.mjs), and the slot is committed when it arrives (or, after
 *     `snapshotTimeout`, with the black picture). The slot appears in the directory and in the page's storage then, whole, SaveInfo.dxs last.
 *   - The SaveInfo, Texture and Palette are not objects of Play's registry model: their registry slots are **unverified**. The Texture's and Palette's unique number is the Texture
 *     class's counter (Texture0 and Palette0 in the first save of a process, as measured), advanced by every Texture the process names, as the original's is.
 *   - A save's order of exports, names and imports is Play's (docs/travel.md "Unresolved" 10); SaveInfo.dxs is the original's byte for byte (save-info-write.mjs).
 *
 * `snapshotSource` is a synchronous picture provider for a session without a page (validators): ({snapW, snapH, pitch, height}) -> P8 indices or null. */
import { saveSlotDirectory, wildcardMatch, newSaveFileIndex } from './save-directory.mjs';
import { writeSaveInfoDetailed } from './save-info-write.mjs';
import { parseSaveInfo } from './save-info.mjs';
import { potCeiling } from './script-root-snapshot.mjs';
import { msvcrtWtoi } from './script-text-parser.mjs';
import { saveSink } from './save-sink.mjs';

const SNAPSHOT_WIDTH = 160, SNAPSHOT_HEIGHT = 120;
const lower = value => String(value).toLowerCase();

/** The local clock as appSystemTime reports it: a host input (script-game-directory.mjs has the same). */
const browserClock = () => {
  const now = new Date();
  return { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate(), Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() };
};
/** `Save%04d` as the C format writes it for DeleteGame (no QuickSave special case: DeleteGame(-1) names `Save-001`). */
const deleteGameDirectory = index => `Save${index < 0 ? '-' + String(-index).padStart(3, '0') : String(index).padStart(4, '0')}`;
/** The two ints of an appSeconds() double, as Texture.InternalTime holds them (a host clock reading). */
function internalTimeOf(seconds) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, seconds, true);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}

/** What the realm remembers across levels: the SaveInfo object persists in the original's package `saveInfo` once made (the warnings of GetSaveInfo(-2) are the first save's);
 * the saves waiting for the page's picture (a save outlives the level it was made in: the page answers by the job's number, not by a session's serial). */
const realm = { saveInfoObject: false, nextJob: 1, pending: new Map() };

/** The page's answer to a snapshot request: the picture (`{data}`: the P8 indices of the grey 160 x 120 in the next power of two); the slot is committed with it. */
export function deliverSaveSnapshot(jobId, picture) {
  const job = realm.pending.get(jobId);
  if (!job) return false;
  job.commit(picture?.data ?? null);
  return true;
}
/** Saves still waiting for the page's picture: the page keeps a frame to answer them from while any are. */
export const pendingSaveSnapshots = () => realm.pending.size;

export function createGameSaver({ runtime, level, directory, store, levelSaver, log, viewport, config, windowHost = () => null, textureClass = null,
  clock = browserClock, snapshotSource = null, schedule = (ms, fn) => setTimeout(fn, ms), snapshotTimeout = 4000, appSeconds = () => performance.now() / 1000,
  now = () => Date.now(), onMessage = () => {} }) {
  const read = (object, name) => runtime.readNamed(object, name);
  const write = (object, name, value) => runtime.writeNamed(object, name, value);
  const levelInfo = () => level.actors[0];
  const deusExLevelInfo = () => level.actors.find(actor => actor && runtime.attachedInstance(actor)?.cls.record.key === 'deusex.deusexlevelinfo') ?? null;
  let last = null;

  /** The render device the engine config names (Engine.Engine GameRenderDevice, GConfig->GetString with no file). */
  const renderDevice = () => String(config?.getString('Engine.Engine', 'GameRenderDevice', null) ?? '');

  /** The unique number the engine's counter gives the next Texture (and, with it, the Palette): the Texture class's name counter. */
  const nextTextureNumber = () => {
    if (!textureClass || !Number.isInteger(textureClass.nameCounter)) return 0;
    const number = textureClass.nameCounter;
    textureClass.nameCounter = (number + 1) | 0;
    return number;
  };

  function commit(job, pixels) {
    if (job.done) return;
    job.done = true;
    if (job.timer !== null && job.timer !== undefined) { clearTimeout(job.timer); job.timer = null; }
    realm.pending.delete(job.id);
    if (pixels && job.info.pixelLength === pixels.length) job.info.bytes.set(pixels, job.info.pixelOffset);
    // the level files first and SaveInfo.dxs last: a slot interrupted between its files is a directory the Load Game screen shows as "save info missing"
    const files = [...job.levelFiles, { name: 'SaveInfo.dxs', bytes: job.info.bytes, modified: job.modified }];
    directory.put({ directory: job.dir, files, info: parseSaveInfo(job.info.bytes) });
    last = { dir: job.dir, files: files.map(file => ({ name: file.name, size: file.bytes.length })), picture: Boolean(pixels) };
    const sink = saveSink();
    if (sink) {
      try { Promise.resolve(sink.commitSlot({ dir: job.dir, files })).catch(error => onMessage('failed', error)); }
      catch (error) { onMessage('failed', error); }
    }
  }

  /** DDeusExGameEngine::SaveGame(Position, Description). */
  function saveGame(position, description = '') {
    position = position | 0;
    const player = read(viewport(), 'Actor');
    if (!player) return null;
    const info = deusExLevelInfo();
    if (!info) { log('Log', 'WARNING!  DeusExLevelInfo MISSING!'); return null; }

    // GetSaveInfo(package) -> LoadSaveInfo(-2): the SaveInfo object of an earlier save is still in the package; the first has to be made, after a failed load of Current\SaveInfo.dxs
    if (!realm.saveInfoObject && !directory.hasFile('Current', 'SaveInfo.dxs')) {
      log('Warning', `Failed to load '..\\Save\\Current\\SaveInfo.dxs': Can't find file '..\\Save\\Current\\SaveInfo.dxs'`);
      log('Warning', `Failed to load 'DeusExSaveInfo None.MyDeusExSaveInfo': Can't find file '..\\Save\\Current\\SaveInfo.dxs'`);
    }
    realm.saveInfoObject = true;

    const text = String(description ?? '');
    const properties = {
      MapName: String(read(info, 'MapName') ?? ''),
      Description: text !== '' ? text : String(read(levelInfo(), 'Title') ?? ''),
      DirectoryIndex: position,
      MissionLocation: String(read(info, 'MissionLocation') ?? ''),
    };
    const count = ((read(player, 'saveCount') | 0) + 1) | 0;
    write(player, 'saveCount', count);
    properties.saveCount = count;
    properties.saveTime = Math.trunc(Number(read(player, 'saveTime') ?? 0)) | 0;
    Object.assign(properties, clock());
    properties.bCheatsEnabled = Boolean(read(player, 'bCheatsEnabled'));

    // the Snapshot: CreateTexture, SetSnapshotSize(160, 120) on the root window, GenerateSnapshot (the Texture's unique number is taken first)
    let snapshot = null, jobId = null, textureName = 'Texture0', paletteName = 'Palette0';
    if (lower(renderDevice()) !== 'opengldrv.openglrenderdevice') {
      const number = nextTextureNumber();
      textureName = `Texture${number}`; paletteName = `Palette${number}`;
      const pitch = potCeiling(SNAPSHOT_WIDTH), height = potCeiling(SNAPSHOT_HEIGHT);
      const host = windowHost();
      host?.snapshot?.setSize?.(read(player, 'rootWindow'), SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
      let data = snapshotSource?.({ snapW: SNAPSHOT_WIDTH, snapH: SNAPSHOT_HEIGHT, pitch, height }) ?? null;
      if (!data && !snapshotSource && host?.snapshot?.requestForSave) {
        const id = realm.nextJob++;
        if (host.snapshot.requestForSave(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT, 1, id) !== null) jobId = id;
      }
      snapshot = { pitch, height, data: data ?? new Uint8Array(pitch * height) };
      if (!data && jobId === null) log('Log', 'SaveGame: no frame to take the snapshot from: the picture is black');
    }

    // a new slot
    if (position === 0) {
      const names = directory.directories().filter(name => wildcardMatch('Save*', name));
      properties.DirectoryIndex = newSaveFileIndex(names, msvcrtWtoi);
    }
    const index = properties.DirectoryIndex;
    const dir = position === -1 ? 'QuickSave' : saveSlotDirectory(index);
    // DeleteSaveGameFiles(destination): the level package's loaders go (once per level); the old files go when the new slot is committed
    store.releaseLoaders();
    // CopySaveGameFiles(Current, destination): every *.dxs with its time
    const levelFiles = new Map();
    for (const { name } of directory.files('Current')) {
      if (!wildcardMatch('*.dxs', name)) continue;
      const bytes = directory.readFile('Current', name);
      if (bytes) levelFiles.set(lower(name), { name, bytes, modified: directory.modifiedOf?.('Current', name) ?? now() });
    }
    // SavePackage(SaveInfo): the file is complete but for the picture
    const started = performance.now();
    const written = writeSaveInfoDetailed({ properties, snapshot, guid: globalThis.crypto.getRandomValues(new Uint8Array(16)), textureName, paletteName,
      textureFirst: true, internalTime: internalTimeOf(appSeconds()) });
    log('Log', `Save=${(performance.now() - started).toFixed(6)}`);
    log('Log', `Moving '..\\Save\\${dir}\\Save.tmp' to '..\\Save\\${dir}\\SaveInfo.dxs'`);
    const job = { id: jobId, dir, index, levelFiles: [], info: { bytes: written.bytes, pixelOffset: written.pixelOffset, pixelLength: written.pixelLength }, modified: now(),
      done: false, timer: null };
    job.commit = pixels => commit(job, pixels);
    // SaveCurrentLevel(index, 0): the level and the player, into the slot
    const saved = levelSaver.saveCurrentLevel(index, { write: (name, bytes) => levelFiles.set(lower(name), { name, bytes, modified: now() }) });
    job.levelFiles = [...levelFiles.values()];
    if (!saved) return null;
    if (jobId !== null) {
      realm.pending.set(jobId, job);
      job.timer = schedule(snapshotTimeout, () => { job.timer = null; commit(job, null); });
    } else commit(job, null);
    return { dir, index, job: jobId };
  }

  /** DDeusExGameEngine::DeleteGame(Index): the directory and everything in it. */
  function deleteGame(index) {
    const dir = deleteGameDirectory(index | 0);
    directory.remove(dir);
    const sink = saveSink();
    if (sink) { try { Promise.resolve(sink.removeSlot({ dir })).catch(error => onMessage('failed', error)); } catch (error) { onMessage('failed', error); } }
    return dir;
  }

  /** DeleteSaveGameFiles(path) for a save slot (`..\Save\Save0001`, native 3012 with an argument): the files go, the directory stays. */
  function deleteSaveGameFiles(path) {
    store.releaseLoaders();
    const dir = String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    return directory.clearDirectory(dir);
  }

  return {
    saveGame, deleteGame, deleteSaveGameFiles,
    get last() { return last; },
  };
}
