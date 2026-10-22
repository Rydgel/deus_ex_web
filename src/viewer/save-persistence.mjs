/**
 * The page's side of the save directory (docs/save-storage.md "The folder flow"): which storage holds the player's saves, the directory the
 * Load Game screen lists, and the controls the page offers outside the original's menus (pick a folder, reconnect it, import, export).
 *
 * Where the saves are, by priority:
 *   1. a folder on disk the player picked (Chromium: showDirectoryPicker, readwrite; the handle is kept in IndexedDB and its permission asked
 *      again by a click on a later visit), which can be the desktop game's own `Save` folder or the installation (its `Save` is used);
 *   2. the browser's own storage (IndexedDB), every browser's default;
 *   3. memory, when the browser keeps nothing for the page.
 * On the dev server the installed game's `Save` folder is also read, read-only, under whichever of those holds the page's own saves.
 *
 * The simulation reads the directory synchronously, so the page sends it a listing (`simSaves()`: each slot's files and its parsed SaveInfo with the
 * snapshot picture) at startup and again after every change (`onChange`). Failures never stop the page: every one is a StorageError with a message,
 * the status carries it, and the page falls back one step (a folder that cannot be used leaves the browser's storage in charge).
 */
import { openBrowserStorage, StorageError } from '../runtime/browser-storage.mjs';
import {
  createMemorySaveBackend, createIndexedDbSaveBackend, createFolderSaveBackend, createLayeredSaveBackend, createServedSaveBackend, createStoredSaveDirectory,
  ensureFolderPermission, pickSaveFolder, savedSaveFolder, resolveSaveFolder, importSaveFiles, exportSaveFiles, folderError,
} from '../runtime/save-store.mjs';
import { parseSaveInfo } from '../runtime/save-info.mjs';
import { createStoredZip } from '../runtime/zip-store.mjs';

/** `off` or `on`: the default start keeps and reads saves; the `?debug=1` page every validator opens starts from an empty directory (as it starts from the
 * installed ini); `?saves=on` turns it on anywhere, `?saves=off` off. */
export function saveMode(search, originalStart) {
  const value = new URLSearchParams(search).get('saves');
  if (value === 'off') return 'off';
  if (value === 'on') return 'on';
  return originalStart ? 'on' : 'off';
}

/** The dev server's read-only endpoint for the installed game's `Save` folder (vite.config.mjs), as a `served` source. An answer that is not ok is no saves. */
export function devServedSaves(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (!fetchImpl) return null;
  return {
    async manifest() { try { const response = await fetchImpl('/__game__/saves'); return response.ok ? await response.json() : { files: [] }; } catch { return { files: [] }; } },
    async file(dir, name) {
      const response = await fetchImpl(`/__game__/save/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    },
  };
}

const signatureOf = directory => directory.directories()
  .map(dir => `${dir}:${directory.files(dir).map(file => `${file.name}=${file.size}@${directory.modifiedOf(dir, file.name)}`).sort().join(',')}`).join('|');
const failureOf = error => { const result = error instanceof StorageError ? error : folderError(error); return { kind: result.kind, message: result.message }; };

/**
 * `mode` from saveMode; `openStorage` the storage open (tests pass failures); `served` the dev server's source or null; `showDirectoryPicker` the browser's
 * (null where it has none: Firefox, Safari); `onChange(status)` hears every change of the status or the listing.
 * The directory is built and listed before this resolves.
 */
export async function openSavePersistence({ mode = 'off', openStorage = openBrowserStorage, served = null, parseInfo = parseSaveInfo,
  showDirectoryPicker = globalThis.showDirectoryPicker?.bind(globalThis) ?? null, onChange = () => {} } = {}) {
  let storage = null, directory = null, handle = null, signature = '';
  const state = { source: 'memory', browser: { kind: null, message: null }, folder: null, message: null, error: null };
  const keepsServed = Boolean(served) && mode !== 'off';
  const layer = top => keepsServed ? createLayeredSaveBackend(top, createServedSaveBackend(served)) : top;
  const list = backend => createStoredSaveDirectory({ backend: layer(backend), parseInfo });
  const status = () => ({
    mode, source: state.source, served: keepsServed, canPickFolder: typeof showDirectoryPicker === 'function' && mode !== 'off',
    folder: state.folder ? { ...state.folder } : null, browser: { ...state.browser }, message: state.message, error: state.error,
    slots: directory ? directory.directories().filter(dir => /^(Save\d+|QuickSave)$/i.test(dir) && directory.info(dir)).length : 0,
  });
  const notify = () => onChange(status());

  /** A picked folder, as the directory: the Save folder itself, or the installation's. */
  async function useFolder(picked) {
    const place = await resolveSaveFolder(picked);
    const next = await list(createFolderSaveBackend(place));
    directory = next; handle = picked;
    state.source = 'folder'; state.folder = { name: picked.name, state: 'granted', installed: place.installed }; state.message = null; state.error = null;
    signature = signatureOf(directory);
  }
  async function useBrowserStorage({ forget = false } = {}) {
    let next;
    try { next = await list(storage ? createIndexedDbSaveBackend(storage) : createMemorySaveBackend()); state.source = storage ? 'browser' : 'memory'; }
    catch (error) { state.error = failureOf(error); next = await list(createMemorySaveBackend()); state.source = 'memory'; }
    directory = next; if (forget) { handle = null; state.folder = null; state.message = null; state.error = null; }
    if (state.source === 'memory' && state.browser.message) state.message = state.browser.message;
    signature = signatureOf(directory);
  }

  if (mode === 'off') { directory = await list(createMemorySaveBackend()); signature = signatureOf(directory); }
  else {
    try { storage = await openStorage(); } catch (error) { state.browser = failureOf(error); storage = null; }
    if (storage) { try { handle = await savedSaveFolder(storage); } catch (error) { state.error = failureOf(error); handle = null; } }
    if (handle) {
      state.folder = { name: handle.name, state: 'prompt', installed: false };
      try {
        if (await ensureFolderPermission(handle)) await useFolder(handle);
        else state.message = `The save folder “${handle.name}” needs your permission again: use “Reconnect folder” in the Saves window (Alt+S).`;
      } catch (error) { state.error = failureOf(error); state.folder = { name: handle.name, state: 'unusable', installed: false }; }
    }
    if (!directory) await useBrowserStorage();
  }

  /** Run one action that can change the listing, one at a time. */
  let queue = Promise.resolve();
  const action = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  const relist = async () => {
    await directory.refresh();
    const next = signatureOf(directory), changed = next !== signature; signature = next;
    return changed;
  };

  return {
    status,
    /** The stored directory (save-store.mjs createStoredSaveDirectory). */
    get directory() { return directory; },
    /** The directory the simulation reads, as plain data: every slot's files and its parsed SaveInfo. */
    simSaves: () => directory.directories().map(dir => ({ directory: dir, files: directory.files(dir), info: directory.info(dir) })),
    /** Read the storage again (the desktop game or another tab changed the folder). Resolves to whether the listing changed. */
    refresh: () => action(async () => {
      try { const changed = await relist(); if (changed) notify(); return changed; } catch (error) { state.error = failureOf(error); notify(); return false; }
    }),
    /** Ask the player for a folder (call from a click): the desktop game's `Save` folder, or the installation. Throws a StorageError (`cancelled`, `denied`, ...). */
    pickFolder: () => action(async () => {
      const picked = await pickSaveFolder(storage, { showDirectoryPicker });
      try { await useFolder(picked); } catch (error) { state.error = failureOf(error); notify(); throw folderError(error); }
      notify();
    }),
    /** Ask the browser's permission for the folder of an earlier visit again (call from a click). */
    reconnectFolder: () => action(async () => {
      if (!handle && storage) handle = await savedSaveFolder(storage);
      if (!handle) throw new StorageError('missing', 'There is no save folder to reconnect.');
      try {
        if (!await ensureFolderPermission(handle, { request: true })) throw new StorageError('denied', 'The browser did not give this page access to the save folder.');
        await useFolder(handle);
      } catch (error) { state.error = failureOf(error); notify(); throw folderError(error); }
      notify();
    }),
    /** Stop using the folder (its handle is forgotten): the browser's storage is in charge again; the folder's files stay where they are. */
    forgetFolder: () => action(async () => {
      try { await storage?.delete('handles', 'saves'); } catch (error) { state.error = failureOf(error); }
      await useBrowserStorage({ forget: true }); notify();
    }),
    /** Put the files of a `webkitdirectory` input into the writable storage: the desktop game's `Save` folder, one `SaveNNNN` folder, or a folder that holds
     * them. Resolves to {written, skipped}. */
    importFiles: files => action(async () => {
      let result;
      try { result = await importSaveFiles(directory, files); } catch (error) { state.error = failureOf(error); notify(); throw folderError(error); }
      await relist(); notify();
      return result;
    }),
    /** The saves as one zip file: {name, bytes, count} (`Save/<slot>/<file>`, stored, so the player can unpack it next to the game). */
    exportZip: ({ only = null } = {}) => action(async () => {
      const files = await exportSaveFiles(directory, { only });
      return { name: 'Deus Ex Saves.zip', bytes: createStoredZip(files.map(file => ({ path: `Save/${file.path}`, bytes: file.bytes, modified: file.modified }))), count: files.length };
    }),
    close() { directory?.backend?.close?.(); try { storage?.close(); } catch { /* closed already */ } },
  };
}
