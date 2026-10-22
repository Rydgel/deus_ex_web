/**
 * Where Play's saves live: one interface, three backends (docs/save-storage.md).
 *
 * The original keeps a save as a directory of files under `Save\` (`Save0001\SaveInfo.dxs`, `Save0001\00_Training.dxs`, ..., `QuickSave\`,
 * `Current\`). Play keeps the same files, byte for byte, behind a SAVE BACKEND, so a `.dxs` written here is the original's format and a
 * save made by the desktop game can be put in the same place:
 *
 *   indexeddb  the browser's own storage (browser-storage.mjs `saves` and `savedata` stores). The default; every browser has it.
 *   folder     a directory the player picked on disk with the File System Access API (`showDirectoryPicker`, Chromium only), which can be the
 *              desktop game's own `Save` folder. Its handle is kept in IndexedDB and its permission asked again on a later visit.
 *   memory     nothing kept: tests, and the page when no storage can be opened.
 *
 * A backend is asynchronous and knows nothing of the game:
 *
 *   kind
 *   list()                 -> [{dir, name, size, modified}] every file under `<dir>\`, without bytes
 *   read(dir, name)        -> Uint8Array, or null when there is no such file
 *   write(dir, name, data, {modified}) -> void     creates the directory, replaces the file
 *   remove(dir, name)      -> boolean              removes a directory when its last file goes (the original's DeleteSaveGame)
 *   removeDir(dir)         -> number of files removed
 *   freeSpace()            -> bytes the backend can still take, or null when it cannot say
 *   close()
 *
 * `createStoredSaveDirectory` turns a backend into the synchronous read interface the GameDirectory natives use (save-directory.mjs):
 * the natives are synchronous, so it holds an index of the listing, filled by `refresh()` before a session and kept current by each
 * write, and answers `directories()`, `files()`, `info()` and `freeSpaceBytes()` from it. Reading or writing bytes is `await directory.read()`
 * / `await directory.write()`, which the save and load paths (`SaveGame` 3011, `?loadgame=`; travel step 4) will await.
 */
import { StorageError, storageError, STORAGE_MESSAGES } from './browser-storage.mjs';

const lower = value => String(value).toLowerCase();
const byName = (a, b) => lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0;

/** The directory and file a path names, the last two segments: `Save/Save0001/SaveInfo.dxs`, `Save0001/SaveInfo.dxs` and a
 * `webkitdirectory` entry's `Save/Save0001/SaveInfo.dxs` all name (`Save0001`, `SaveInfo.dxs`). Null for a file with no directory. */
export function saveFilePath(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.length >= 2 ? { dir: parts.at(-2), name: parts.at(-1) } : null;
}

// ---- the backends ---------------------------------------------------------------------------------------------------------------------

/** A backend that keeps its files in memory. */
export function createMemorySaveBackend({ freeBytes = null } = {}) {
  const files = new Map();                                    // `dir\0name` -> {dir, name, bytes, modified}
  const keyOf = (dir, name) => `${dir}\0${name}`;
  return {
    kind: 'memory',
    async list() { return [...files.values()].map(({ dir, name, bytes, modified }) => ({ dir, name, size: bytes.length, modified })); },
    async read(dir, name) { const file = files.get(keyOf(dir, name)); return file ? file.bytes.slice() : null; },
    async write(dir, name, data, { modified = Date.now() } = {}) { files.set(keyOf(dir, name), { dir, name, bytes: new Uint8Array(data), modified }); },
    async remove(dir, name) { return files.delete(keyOf(dir, name)); },
    async removeDir(dir) { let n = 0; for (const [key, file] of files) if (file.dir === dir) { files.delete(key); n++; } return n; },
    async freeSpace() { return typeof freeBytes === 'function' ? freeBytes() : freeBytes; },
    close() {},
  };
}

/** The IndexedDB backend over an open BrowserStorage (browser-storage.mjs). A write is one transaction holding the file's row and its bytes,
 * so a quota failure leaves neither. */
export function createIndexedDbSaveBackend(storage) {
  return {
    kind: 'indexeddb',
    async list() { return (await storage.getAll('saves')).map(({ dir, name, size, modified }) => ({ dir, name, size, modified })); },
    async read(dir, name) { const row = await storage.get('savedata', [dir, name]); return row ? new Uint8Array(row.bytes) : null; },
    async write(dir, name, data, { modified = Date.now() } = {}) {
      const bytes = new Uint8Array(data);
      await storage.run(['saves', 'savedata'], 'readwrite', stores => {
        stores.saves.put({ dir, name, size: bytes.length, modified });
        stores.savedata.put({ dir, name, bytes });
      });
    },
    async remove(dir, name) {
      const had = Boolean(await storage.get('saves', [dir, name]));
      await storage.run(['saves', 'savedata'], 'readwrite', stores => { stores.saves.delete([dir, name]); stores.savedata.delete([dir, name]); });
      return had;
    },
    async removeDir(dir) {
      const rows = await storage.getAllByIndex('saves', 'dir', dir);
      await storage.run(['saves', 'savedata'], 'readwrite', stores => { for (const { name } of rows) { stores.saves.delete([dir, name]); stores.savedata.delete([dir, name]); } });
      return rows.length;
    },
    /** What the browser says is left of this origin's quota (StorageManager.estimate()). */
    async freeSpace() { const estimate = await storage.estimate(); return estimate?.quota != null && estimate.usage != null ? Math.max(0, estimate.quota - estimate.usage) : null; },
    close() { storage.close(); },
  };
}

/** The StorageError kinds a File System Access failure maps to: `denied` (permission refused or not granted), `missing` (the folder went away),
 * `cancelled` (the picker was dismissed), else the IndexedDB kinds. */
export function folderError(error) {
  if (error instanceof StorageError) return error;
  const kind = { NotAllowedError: 'denied', SecurityError: 'denied', NotFoundError: 'missing', AbortError: 'cancelled',
    QuotaExceededError: 'quota', NoModificationAllowedError: 'denied', InvalidStateError: 'missing', TypeMismatchError: 'missing' }[error?.name] ?? 'failed';
  const text = { denied: 'The browser does not let this page use that folder (permission refused): choose it again.',
    missing: 'The save folder is not there any more (moved, renamed or on a drive that is not connected).',
    cancelled: 'No folder was chosen.' }[kind] ?? STORAGE_MESSAGES[kind];
  return new StorageError(kind, error?.message ? `${text} (${error.name}: ${error.message})` : text, error);
}

/**
 * A folder on disk as the `Save\` directory (File System Access API): `root` is a FileSystemDirectoryHandle of the `Save` folder itself, which
 * the player can point at the desktop game's own. The files are the original's, written as they are; nothing else in the folder is touched.
 * Only the two levels the game uses are read (`<dir>\<file>`).
 */
export function createFolderSaveBackend(root, { freeBytes = null } = {}) {
  const wrap = async work => { try { return await work(); } catch (error) { throw folderError(error); } };
  return {
    kind: 'folder', name: root.name,
    list: () => wrap(async () => {
      const out = [];
      for await (const entry of root.values()) {
        if (entry.kind !== 'directory') continue;
        for await (const child of entry.values()) {
          if (child.kind !== 'file') continue;
          const file = await child.getFile();
          out.push({ dir: entry.name, name: child.name, size: file.size, modified: file.lastModified });
        }
      }
      return out;
    }),
    read: (dir, name) => wrap(async () => {
      try {
        const handle = await (await root.getDirectoryHandle(dir)).getFileHandle(name);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) { if (error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError') return null; throw error; }
    }),
    write: (dir, name, data) => wrap(async () => {
      const handle = await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(data); await writable.close(); } catch (error) { try { await writable.abort?.(); } catch { /* closed already */ } throw error; }
    }),
    remove: (dir, name) => wrap(async () => {
      let directory;
      try { directory = await root.getDirectoryHandle(dir); await directory.removeEntry(name); } catch (error) { if (error?.name === 'NotFoundError') return false; throw error; }
      // the original's DeleteSaveGame removes the directory with its files; one left empty is removed too
      let empty = true; for await (const _ of directory.values()) { empty = false; break; }
      if (empty) await root.removeEntry(dir);
      return true;
    }),
    removeDir: dir => wrap(async () => {
      let n = 0;
      try { for await (const entry of (await root.getDirectoryHandle(dir)).values()) if (entry.kind === 'file') n++; await root.removeEntry(dir, { recursive: true }); }
      catch (error) { if (error?.name === 'NotFoundError') return 0; throw error; }
      return n;
    }),
    freeSpace: async () => typeof freeBytes === 'function' ? freeBytes() : freeBytes,
    close() {},
  };
}

/** Whether a permission request must be asked again: `queryPermission` says `prompt` (or `denied`) for readwrite. */
export async function ensureFolderPermission(handle, { request = false } = {}) {
  const options = { mode: 'readwrite' };
  if (await handle.queryPermission?.(options) === 'granted') return true;
  // requestPermission needs a user activation: the page asks from a click on its "reconnect folder" control, never at startup
  return request && await handle.requestPermission?.(options) === 'granted';
}

/** Ask the player for a folder (a user activation) and keep its handle in IndexedDB, so a later visit can ask permission again. */
export async function pickSaveFolder(storage, { showDirectoryPicker = globalThis.showDirectoryPicker?.bind(globalThis) } = {}) {
  if (typeof showDirectoryPicker !== 'function') throw new StorageError('unavailable', 'This browser cannot pick a folder to keep saves in (it needs the File System Access API: Chromium).');
  let handle;
  try { handle = await showDirectoryPicker({ id: 'deusex-saves', mode: 'readwrite' }); } catch (error) { throw folderError(error); }
  if (storage) await storage.put('handles', { id: 'saves', handle, name: handle.name });
  return handle;
}

/** The folder a previous visit picked: its handle from IndexedDB, or null. Whether it may be used is `ensureFolderPermission`. */
export async function savedSaveFolder(storage) {
  try { return (await storage.get('handles', 'saves'))?.handle ?? null; } catch (error) { throw storageError(error); }
}

// ---- the directory the natives read -------------------------------------------------------------------------------------------------------

/**
 * The synchronous Save directory (save-directory.mjs's interface) over a backend. `parseInfo(bytes)` turns a `SaveInfo.dxs` into the
 * `{properties, snapshot}` `info()` returns (the package reader of save step 4); without it `info()` is null. `freeBytes` is the host's
 * figure for the volume (src/viewer/save-directory-host.mjs) while the backend cannot say.
 */
export async function createStoredSaveDirectory({ backend, parseInfo = null, freeBytes = null }) {
  const slots = new Map();                                    // dir -> Map(name -> {size, modified})
  const infos = new Map();                                    // dir -> {properties, snapshot}
  let free = freeBytes;
  const loadInfo = async dir => {
    infos.delete(dir);
    if (!parseInfo || !slots.get(dir)?.has('SaveInfo.dxs')) return;
    const bytes = await backend.read(dir, 'SaveInfo.dxs');
    const info = bytes ? parseInfo(bytes) : null;
    if (info) infos.set(dir, info);
  };
  const directory = {
    backend,
    /** Read the backend's listing again (before a session, after another tab or the desktop game changed the folder). */
    async refresh() {
      slots.clear(); infos.clear();
      for (const { dir, name, size, modified } of await backend.list()) {
        if (!slots.has(dir)) slots.set(dir, new Map());
        slots.get(dir).set(name, { size, modified });
      }
      for (const dir of slots.keys()) await loadInfo(dir);
      const room = await backend.freeSpace();
      if (room !== null && room !== undefined) free = room;
      return directory;
    },
    directories: () => [...slots.keys()].sort(byName),
    files: dir => [...(slots.get(dir) ?? [])].map(([name, { size }]) => ({ name, size })),
    info: dir => infos.get(dir) ?? null,
    freeSpaceBytes: () => free,
    setFreeSpaceBytes(value) { free = value; },
    /** The bytes of one file, or null. */
    read: (dir, name) => backend.read(dir, name),
    /** Write one file; the listing (and a SaveInfo's parsed info) follow. A failure leaves the index as it was. */
    async write(dir, name, data, options) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await backend.write(dir, name, bytes, options);
      if (!slots.has(dir)) slots.set(dir, new Map());
      slots.get(dir).set(name, { size: bytes.length, modified: options?.modified ?? Date.now() });
      if (name === 'SaveInfo.dxs') await loadInfo(dir);
      if (typeof free === 'number') free = Math.max(0, free - bytes.length);
    },
    /** The original's DeleteSaveGame: the directory and every file in it. */
    async removeDir(dir) { const n = await backend.removeDir(dir); slots.delete(dir); infos.delete(dir); return n; },
    async remove(dir, name) {
      const had = await backend.remove(dir, name);
      slots.get(dir)?.delete(name); if (!slots.get(dir)?.size) { slots.delete(dir); infos.delete(dir); }
      return had;
    },
  };
  await directory.refresh();
  return directory;
}

// ---- import and export without the File System Access API (Firefox, Safari) -----------------------------------------------------------------

/** Put the files of a `webkitdirectory` input (or a dropped folder) into a directory: every file two levels deep or more, by the last two
 * path segments, so the player can choose the desktop game's `Save` folder, one `SaveNNNN` folder or any folder holding them. `files` are
 * `{webkitRelativePath | path, arrayBuffer()}` (File objects). Returns {written, skipped}. */
export async function importSaveFiles(directory, files) {
  let written = 0; const skipped = [];
  for (const file of files) {
    const where = saveFilePath(file.webkitRelativePath || file.path || file.name);
    if (!where || !/^(Save\d+|Save-\d+|QuickSave|Current)$/i.test(where.dir)) { skipped.push(file.webkitRelativePath || file.name); continue; }
    await directory.write(where.dir, where.name, new Uint8Array(await file.arrayBuffer()), { modified: file.lastModified });
    written++;
  }
  return { written, skipped };
}

/** Every file of the directory as `{path, bytes}` with the original's relative path (`Save0001/SaveInfo.dxs`), for a download. */
export async function exportSaveFiles(directory, { only = null } = {}) {
  const out = [];
  for (const dir of directory.directories()) {
    if (only && !only.includes(dir)) continue;
    for (const { name } of directory.files(dir)) out.push({ path: `${dir}/${name}`, bytes: await directory.read(dir, name) });
  }
  return out;
}
