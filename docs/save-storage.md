# Save storage (2026-10-22)

Where Play's saves will live, and the layer that keeps them: roadmap section 6, "store progress locally in the browser, with save export/import, format versioning, and clear
storage failure handling", and the user's request (2026-10-22) that saves can live on the real file system, outside the browser, so that desktop saves can be imported and Play's
saves are written in the original's `.dxs` format. This page is the design, what is built, the failure cases, and where it stops. The ini settings use the same database but stay in
the browser: [configuration persistence](config-persistence.md). Nothing here writes into the player's game folder's ini files.

## The contract

A save in the original is a directory of files under `Save\`: `Save0001\SaveInfo.dxs` (a package with the `DeusExSaveInfo` object and the snapshot texture), `Save0001\<map>.dxs` (the
level, one per visited map) and the other files of the directory; `QuickSave\` and `Current\` are directories of the same kind ([save directory](save-directory.md), [travel](travel.md#the-save-directory)).
Play keeps **the same directories and files, byte for byte**: a `.dxs` it writes is the original's format (the writer is [travel](travel.md) step 4), so a save the desktop game made can be put in
the same place and read, and one Play made can be taken out.

The reads the `GameDirectory` natives make are synchronous (`directories()`, `files(dir)`, `info(dir)`, `freeSpaceBytes()`, [save-directory.mjs](../src/runtime/save-directory.mjs)); storage is
asynchronous. `src/runtime/save-store.mjs` joins them:

* A **save backend** is the asynchronous side and knows nothing of the game: `list()` (every file under `<dir>\`, without bytes), `read(dir, name)`, `write(dir, name, bytes, {modified})`,
  `remove(dir, name)`, `removeDir(dir)`, `freeSpace()`, `close()`. Three exist: `memory` (tests, and a page with no storage), `indexeddb`, `folder`.
* `createStoredSaveDirectory({backend, parseInfo, freeBytes})` makes the **synchronous directory** the natives read, from an index of the backend's listing filled by `refresh()` before a
  session and kept current by each write; `info(dir)` is the parsed `SaveInfo.dxs` (the package reader of save step 4 is the `parseInfo` it is given). `read()`, `write()`, `remove()` and `removeDir()`
  are the asynchronous bytes and deletes that the save and load paths (`SaveGame` 3011, `?loadgame=`) will await. A failed write leaves the index as it was.

## The two backends

**(a) Browser storage, the default (`createIndexedDbSaveBackend`).** The same IndexedDB database as the settings (`deusex-web`, [browser-storage.mjs](../src/runtime/browser-storage.mjs)): the `saves`
store holds one row per file without its bytes, `{dir, name, size, modified}` (index `dir`), so a listing never reads a 3 MB save, and `savedata` holds `{dir, name, bytes}`; a write is **one
transaction** over both, so a quota failure leaves neither. Free space is `StorageManager.estimate()`'s `quota - usage` (`save-directory-host.mjs`, the host input of the Load Game screen).

**(b) A folder on disk (`createFolderSaveBackend`), Chromium only.** `showDirectoryPicker({mode: 'readwrite'})` (`pickSaveFolder`) returns a directory handle, which is kept in the `handles` store
(handles are structured-cloneable into IndexedDB) so a later visit finds it. The folder is the `Save` directory itself: the player can point it at the desktop game's own `Save` folder, and
the files are the original's, written as they are. Only the two levels the game uses are read; nothing else in the folder is touched, and files beside the directories are ignored.
`remove` removes a directory when its last file goes, as DeleteSaveGame removes the directory. A later visit asks again: `ensureFolderPermission(handle)` is `queryPermission({mode: 'readwrite'})`;
when it says `prompt`, the page shows a "reconnect folder" control and calls `requestPermission` from its click (it needs a user activation, so never at startup). Without the permission the page runs on the
IndexedDB backend and keeps the handle for the next try. Free space is the volume's, which the browser cannot say: the host's figure (or the fixed default) stands in.

Which backend is in use is the player's choice and a stored setting; the default is IndexedDB. Both can hold saves at once (importing from the folder into the browser is `importSaveFiles` over a listing of the folder).

## Where the page stops being able to use the folder: Firefox and Safari

Neither has `showDirectoryPicker`. The fallback moves saves as files:

* **In:** `<input type="file" webkitdirectory multiple>` (Chromium, Firefox, Safari 11.1+). The player chooses the desktop game's `Save` folder, one `SaveNNNN` folder, or any folder holding them;
  `importSaveFiles(directory, files)` writes each file under its last two path segments (`Save/Save0001/SaveInfo.dxs` and `Save0001/SaveInfo.dxs` both name `Save0001`, `SaveInfo.dxs`), only into
  directories the game names (`SaveNNNN`, `QuickSave`, `Current`), and returns `{written, skipped}` so the page can say what it did not take. Built and tested.
* **Out:** a download. A folder cannot be downloaded, so the page makes one file: a zip (stored, without compression; a save is already a package) of the slots' files at their relative paths, from
  `exportSaveFiles(directory, {only})`'s `{path, bytes}` list, offered as a `Blob` through `<a download>`. The zip writer (about sixty lines with a CRC-32) and the control are **not built**; the data
  side is. The player unpacks it into the desktop game's `Save` folder. Failure cases: a blob the browser cannot allocate (a few hundred MB of saves; the page exports a slot at a time then), iOS Safari
  opening the file instead of saving it, a blocked download.
* The same two controls also serve Chromium players who do not want a folder grant.

## Failure cases

Every failure is a `StorageError` with a `kind` (`browser-storage.mjs`; the folder adds `denied`, `missing`, `cancelled`) and a message the page can show; saving never stops the game.

| situation | what happens | what the player sees / does |
| --- | --- | --- |
| No IndexedDB, blocked site data, a private window that refuses it | the `memory` backend: saves last as long as the page | the message; export is the way to keep them |
| Quota exceeded on a write | the single transaction aborts: the previous file stays, nothing half-written | "no room": delete a slot or export; the Load Game screen's free space already shows what the browser says |
| The browser evicts the origin's data, or Safari clears it after seven days | rows are gone; the next `refresh()` lists nothing | `navigator.storage.persist()` is asked once the first save exists (a prompt in Firefox, a grant by engagement in Chromium) and an export reminder; unverified |
| Another tab upgrades or clears the database | `closed` on the next operation | reload the page |
| A database from a newer build | `newer`: opened by nothing, left alone | the page runs without it |
| Folder permission not granted on a later visit | `denied`, `queryPermission` says `prompt` | "reconnect folder" (a click); until then the IndexedDB backend |
| The folder moved, renamed, or on a drive not connected | `missing` (`NotFoundError`) | choose it again; the handle is kept for a retry |
| The folder is read-only, or the desktop game holds a file | `NoModificationAllowedError` / `InvalidStateError` map to `denied` / `missing` | the write fails whole: `createWritable` writes to a swap file and commits on `close()`, so a file is never half-written |
| A crash between the files of one save | a save is several files and the folder has no cross-file transaction | the Load Game screen shows a directory whose `SaveInfo.dxs` is missing as a row labelled `SaveInfoMissing_Label` (row id -2, `PopulateGames`), which cannot be loaded; the writer (step 4) should write the level files first and `SaveInfo.dxs` last, so a crash leaves that row rather than a listed save with levels missing (the IndexedDB backend could put a whole slot in one transaction: `storage.run` over both stores); the original's order is not measured |
| Two tabs, or the desktop game running on the same folder | no locking; the last writer wins, a slot number may collide | `refresh()` before every listing and before `GetNewSaveFileIndex` |
| Names | NTFS is case-insensitive, IndexedDB keys are not | the game writes canonical names (`Save0001`); the directory sorts case-insensitively as NTFS lists; an import keeps the player's spelling |
| The folder picker is dismissed | `cancelled` | nothing changes |

## Checked

`test/save-store.test.mjs` runs the same script against all three backends (listing order, sizes, a SaveInfo parsed on write, bytes round trip, overwrite, delete, `DeleteSaveGame`, a new session over the
same storage) and compares the stored directory with `createSaveDirectory` for the natives' reads; the IndexedDB backend over the fake that rolls back aborted transactions (quota leaves neither row nor bytes),
free space from the estimate; the folder over an in-memory handle tree (two levels, files beside directories untouched, empty directories removed, permission states, `denied`/`missing`/`quota` mapping, the
handle kept in IndexedDB); import and export. The fakes model only what the code uses; the real IndexedDB runs in `browser-tests/config-persistence.spec.mjs` (settings), and no real File System Access
folder has been exercised yet.

## Where this stops

Built: the interface, the memory, IndexedDB and folder backends, the permission and picker helpers, import and export of the file lists, the database schema and its failure handling, and the tests above.
Not built: wiring the stored directory into the page and worker (the worker's `hostSaveDirectory()` is still the in-memory one, so the Load Game screen lists nothing; it needs the listing sent in `init` as the
config files are, and a `write` message back), the folder controls (pick, reconnect, import), the zip writer and download, `parseInfo` (the `SaveInfo.dxs` reader), and the `.dxs` writer: all of
[travel](travel.md) step 4 (`SaveGame`, `?loadgame=`, the snapshot texture), which this layer is the floor of.
