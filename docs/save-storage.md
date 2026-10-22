# Save storage (2026-10-22)

Where Play's saves live, the layer that keeps them, how the page gets them into the original's Load Game screen, and how that screen draws their snapshot pictures: roadmap section 6,
"store progress locally in the browser, with save export/import, format versioning, and clear storage failure handling", and the user's decision (2026-10-22) that saves live in the
original's format, can sit in the file system outside the browser, and that real desktop saves can be imported. The ini settings use the same database but stay in the browser:
[configuration persistence](config-persistence.md). Nothing here writes into the player's game folder except through a folder the player picked for saves.

State: the storage layer, the page's folder flow, the wiring into the simulation worker and the snapshot picture are built and checked (below). **Loading a slot and writing a save are not**
([travel](travel.md) step 4): the Load Game screen lists and previews saves; its Load Game button stops by name.

## The contract

A save in the original is a directory of files under `Save\`: `Save0001\SaveInfo.dxs` (a package with the `DeusExSaveInfo` object and the snapshot texture), `Save0001\<map>.dxs` (the
level, one per visited map) and the other files of the directory; `QuickSave\` and `Current\` are directories of the same kind ([save directory](save-directory.md), [travel](travel.md#the-save-directory)).
Play keeps **the same directories and files, byte for byte**: a `.dxs` it writes is the original's format (the writer is [travel](travel.md) step 4), so a save the desktop game made is read
as it is, and one Play made can be taken out.

The reads the `GameDirectory` natives make are synchronous (`directories()`, `files(dir)`, `info(dir)`, `freeSpaceBytes()`, [save-directory.mjs](../src/runtime/save-directory.mjs)); storage is
asynchronous. `src/runtime/save-store.mjs` joins them:

* A **save backend** is the asynchronous side and knows nothing of the game: `list()` (every file under `<dir>\`, without bytes), `read(dir, name)`, `write(dir, name, bytes, {modified})`,
  `remove(dir, name)`, `removeDir(dir)`, `freeSpace()`, `close()`. Five exist: `memory` (tests, a page with no storage, the debugging page), `indexeddb`, `folder`, and for the dev server `served` and `layered`.
* `createStoredSaveDirectory({backend, parseInfo, freeBytes})` makes the **synchronous directory** the natives read, from an index of the backend's listing filled by `refresh()` and kept current by each
  write; `info(dir)` is the parsed `SaveInfo.dxs` ([save-info.mjs](../src/runtime/save-info.mjs) `parseSaveInfo`, below). A SaveInfo that cannot be read or is not a package is no info: the directory
  still lists and the screen shows the original's "save info missing" row ([save directory](save-directory.md#the-original), `PopulateGames`). `read()`, `write()`, `remove()` and `removeDir()`
  are the asynchronous bytes and deletes that the save and load paths (`SaveGame` 3011, `?loadgame=`) will await. A failed write leaves the index as it was.

## The backends

**Browser storage, the default (`createIndexedDbSaveBackend`).** The same IndexedDB database as the settings (`deusex-web`, [browser-storage.mjs](../src/runtime/browser-storage.mjs)): the `saves`
store holds one row per file without its bytes, `{dir, name, size, modified}` (index `dir`), so a listing never reads a 3 MB save, and `savedata` holds `{dir, name, bytes}`; a write is **one
transaction** over both, so a quota failure leaves neither. Free space is `StorageManager.estimate()`'s `quota - usage` (`save-directory-host.mjs`, the host input of the Load Game screen).

**A folder on disk (`createFolderSaveBackend`), Chromium only.** `showDirectoryPicker({id: 'deusex-saves', mode: 'readwrite'})` returns a directory handle, kept in the `handles` store (handles are
structured-cloneable into IndexedDB) so a later visit finds it. The player may pick the desktop game's `Save` folder itself **or the game folder**: `resolveSaveFolder` takes a folder with a
`System` directory in it for the installation and uses its `Save` child (the original's `SavePath=..\Save`), created by the first write, not before; any other folder is the save directory.
Only the two levels the game uses are read; nothing else in the folder is touched, and files beside the directories are ignored. `remove` removes a directory when its last file goes, as
DeleteSaveGame removes the directory. A later visit asks again: `ensureFolderPermission(handle)` is `queryPermission({mode: 'readwrite'})`; when it says `prompt` the page offers "Reconnect folder" and
calls `requestPermission` from that click (it needs a user activation, so never at startup). Free space is the volume's, which the browser cannot say: the host's estimate stands in.

**The dev server's own `Save` folder (`createServedSaveBackend`, `createLayeredSaveBackend`).** See "The dev server" below.

## The folder flow

The decisions of 2026-10-22, with what each rests on.

### Chromium: a separate grant for the Save folder, not the game folder

The game folder keeps its picker (`<input webkitdirectory>`, the gate's "Choose game folder"): it reads the install into File objects in every browser, needs no handle and no permission, and it is the
production test's path (`browser-tests/viewer.spec.mjs`). Saves get **their own, optional grant**: `showDirectoryPicker({mode: 'readwrite'})` on the Save folder (or the game folder, see above).
Why not make the game folder's pick the grant:

* A `readwrite` grant on the whole installation lets the page change the game's files, for a feature that needs one subfolder. The grant the player sees ("edit files in <folder>") should name what the page uses.
* Chromium's File System Access API refuses some folders: it blocks system directories, and (from the Chromium source as recalled, **not tested here**) the program-files folders, where a Steam install lives
  by default. The `webkitdirectory` pick is not subject to that block, so the game would still open; a `readwrite` pick of that install would fail where the game folder pick works. The Save folder grant fails
  alone, and import (below) still brings the saves in.
* A handle can be kept for the next visit; the File objects of the game folder cannot, so the gate asks for the game folder every visit anyway while the Save folder is picked once.

A failed or refused pick leaves the browser's storage in charge and says why (`denied`, `missing`, `cancelled`).

### Firefox and Safari: browser storage, import and export

Neither has `showDirectoryPicker`: the Saves window hides that control. **In:** `<input type="file" webkitdirectory multiple>` (Firefox, Safari 11.1+, Chromium): the player chooses the desktop game's `Save`
folder, one `SaveNNNN` folder, or any folder holding them; `importSaveFiles(directory, files)` writes each file under its last two path segments (`Save/Save0001/SaveInfo.dxs` and `Save0001/SaveInfo.dxs` both
name `Save0001`, `SaveInfo.dxs`), only into directories the game names (`SaveNNNN`, `QuickSave`, `Current`), and reports `{written, skipped}`. **Out:** one zip (`src/runtime/zip-store.mjs`: stored entries, a
CRC-32 and the three zip records, about seventy lines) of every file at `Save/<slot>/<file>`, offered through `<a download>`: unpacked next to the game, `Save` is the desktop game's folder. The archive reads with
`unzip -t` and Python's `zipfile`; the browser spec downloads it and compares every byte and CRC with the files that went in. Failure cases of the download: a blob the browser cannot allocate (a few hundred MB
of saves), iOS Safari opening the file instead of saving it, a blocked download. The same two controls serve Chromium players who do not want a folder grant. (Firefox and Safari were not run here: the code
paths are the ones the Chromium spec drives, and the `webkitdirectory` and `<a download>` behavior is the platforms' documented one.)

### The dev server: the served Save folder, read-only

The dev server serves the installed game's files (`vite.config.mjs`), so it also lists its `Save` folder: `GET /__game__/saves` (the two levels the game uses, `Save<N>`, `QuickSave`, `Current`, each file's
`{dir, name, size, modified}`, read at each request so a save the desktop game made shows on the next page load) and `GET /__game__/save/<dir>/<file>`. **Read-only, and no write endpoint exists:** whatever the
page saves lands in the browser's storage or the folder the player picked, never in the installation, because a dev server that writes a developer's real saves is one mistake from losing them. The endpoints
sit in `configureServer`, so neither `vite build` nor `vite preview` has them, and the page asks for them only under `import.meta.env.DEV`. The served folder is read **under** the page's own saves
(`createLayeredSaveBackend(top, served)`): a directory the page holds hides the same directory of the served one, the rest shows, writes go to the top, and a served-only slot cannot be removed (`denied`). The
browser spec checks the endpoint's limits (other directories, parent paths, other levels, any method but GET, cross-site requests).

### Where the controls are: the Saves window, outside the original's UI

The original's menus have no folder control, and the default start shows no page chrome at all (`#app.original-start` hides the toolbar and the footer), so the controls are a native `<dialog>` of the page,
the Saves window: opened from the **Saves** page button the default start shows while an original window holds the mouse (a menu, the
inventory), in the bar beside the 4:3 picture (`#page-buttons`, `main.mjs` `placePageButtons`, the user's choice of 2026-10-22: on the default
start no page shortcut takes a key, since Alt is the original's Strafe and Alt+S is game input), from a **Saves…** button on the gate (production's
first screen, where the player already chooses the game folder) and from **Tools > Saves…** or **Alt+S** on the debugging page. The button takes
clicks when the system pointer is free: a menu opened by Escape in a window, or after Alt+Enter in fullscreen. It shows where the saves are, "Use a Save folder…" / "Use another folder…" (Chromium), "Reconnect folder" (a stored folder that needs
the browser's permission again), "Stop using the folder" (forgets the handle; the folder's files stay), "Import saves…" and "Export saves". The default start's look is unchanged until it is opened (checked in the
browser spec: no toolbar, a closed dialog). While it is open the page keeps its keys (Tab, Enter, Escape) from the game.

### Order, status and refresh

At page start (before the game files, so the window works at the gate) `openSavePersistence` ([save-persistence.mjs](../src/viewer/save-persistence.mjs)) opens the storage and chooses, by priority: **a stored
folder whose permission is granted**, else **the browser's storage**, else **memory** (storage unavailable). The dev server's folder sits under whichever is chosen. `?saves=off` and the `?debug=1` page
every validator opens use memory and an empty directory (as `?debug=1` starts from the installed ini); `?saves=on` turns it on anywhere. The simulation reads the directory synchronously, so the page sends it
the listing: `simSaves()` (each slot's files and its parsed SaveInfo, with the snapshot's P8 picture) goes in the worker's `init` message and again in a `saves` message after every change (a picked folder, an
import); `?sim=inline` replaces `hostSaveDirectory()` directly. The worker's `GameDirectory` natives then read the real files' names, sizes, free space and SaveInfo; the Load Game screen lists them when it opens
(the original asks the file system at each open; here the screen reads the page's listing, as fresh as its last refresh). A folder or the dev server's folder is read again when the player returns to the page (visibility and focus, at most every
three seconds): a save the desktop game wrote shows at the next open of the screen. `window.deusExViewer.saves` (status, refresh, open) is the specs' handle.

## Failure cases

Every failure is a `StorageError` with a `kind` (`browser-storage.mjs`; the folder adds `denied`, `missing`, `cancelled`) and a message the page shows (toast and the Saves window); saving never stops the game.

| situation | what happens | what the player sees / does |
| --- | --- | --- |
| No IndexedDB, blocked site data, a private window that refuses it | the `memory` backend: saves last as long as the page | the message; export is the way to keep them |
| Quota exceeded on a write | the single transaction aborts: the previous file stays, nothing half-written | "no room": delete a slot or export; the Load Game screen's free space already shows what the browser says |
| The browser evicts the origin's data, or Safari clears it after seven days | rows are gone; the next listing finds nothing | `navigator.storage.persist()` is to be asked once the first save exists (a prompt in Firefox, a grant by engagement in Chromium) and an export reminder; unverified, not built |
| Another tab upgrades or clears the database | `closed` on the next operation | reload the page |
| A database from a newer build | `newer`: opened by nothing, left alone | the page runs without it |
| Folder permission not granted on a later visit | `queryPermission` says `prompt`; the browser's storage is in charge | the message, and "Reconnect folder" (a click) in the Saves window |
| The folder moved, renamed, or on a drive not connected | `missing` (`NotFoundError`): the folder is `unusable`, the browser's storage is in charge | the message; pick it again, or "Stop using the folder" |
| The folder is read-only, or the desktop game holds a file | `NoModificationAllowedError` / `InvalidStateError` map to `denied` / `missing` | the write fails whole: `createWritable` writes to a swap file and commits on `close()`, so a file is never half-written |
| A crash between the files of one save | a save is several files and the folder has no cross-file transaction | the Load Game screen shows a directory whose `SaveInfo.dxs` is missing as a row labelled `SaveInfoMissing_Label` (row id -2, `PopulateGames`), which cannot be loaded; the writer (step 4) should write the level files first and `SaveInfo.dxs` last (the original's order is not measured) |
| Two tabs, or the desktop game running on the same folder | no locking; the last writer wins, a slot number may collide | the listing is read again on return to the page and before a write |
| Names | NTFS is case-insensitive, IndexedDB keys are not | the game writes canonical names (`Save0001`); the directory sorts case-insensitively as NTFS lists; an import keeps the player's spelling |
| The folder picker is dismissed | `cancelled` | nothing changes |
| A SaveInfo that is not a package | no info for that slot | the screen's "save info missing" row; the other slots list |
| A snapshot texture in a form the reader does not decode | the info has the export names and no picture | the row lists and its info text shows, the picture area stays empty |

## The snapshot

Each slot's `SaveInfo.dxs` is a version-68 package of three exports (the real saves of [save directory](save-directory.md): `Palette1`, `Texture1`, `MyDeusExSaveInfo`). The `DeusExSaveInfo` object's tagged
properties are the ones `DeusExSaveInfo.uc` declares (a value equal to the class default is not stored) and `Snapshot`, an object reference to the Texture. The Texture is the 160 x 120 picture
`XRootWindow::GenerateSnapshot` made, held in the next power-of-two size: **P8, 256 x 128, one mip, the picture in its top-left 160 x 120**, `UClamp`/`VClamp` the full 256 x 128; its `Palette` is the
256-colour grey ramp (alpha 255) of [root snapshot](root-snapshot.md). `parseSaveInfo` reads the package tables and the three exports (nothing is executed) and returns `{properties, snapshot: {texture, palette,
image: {width, height, data (P8), colors (RGBA palette)}}}`.

### How the original draws it

`MenuScreenLoadGame.UpdateSaveInfo` (decoded from DeusEx.u with `scripts/dump-script-function.mjs`): `saveInfo = saveDir.GetSaveInfo(rowIndex)` (native 3088, `StaticLoadObject` of the file),
`winSnapshot.SetBackground(saveInfo.Snapshot)` (native 1421 `XWindow::SetBackground` stores the Texture pointer at the window's `+0xec` and asks the parent to reconfigure), and for a missing file
`SetBackground(None)`. `CreateSnapshotWindow` makes `winSnapshot` a plain `Window` of 160 x 120 at (387, 24) in the client. The window draws its background in `XWindow::DrawTree` (`0x10051490`): style on and a texture
set, `DrawIconPattern(0, 0, width, height, 0, 0, ul, vl)` with `ul = vl = 0` (the surface bit for stretching is clear), that is a tile of the window's own size from the texture's origin at one texel per pixel.
So the window shows the texture's top-left 160 x 120, unscaled and unframed.

### Evidence from the original

`scripts/validate-save-snapshot.mjs` reads the two real saves and the two Wine captures of the Load Game screen with them (`sd1/load1.png`, `load2.png`, 1280 x 720, [save directory](save-directory.md#measured)):
at one window position, (754, 237) in both captures (the Load Game client origin would then be (367, 213)), **every one of the 19,200 pixels of the 160 x 120 area is a single-valued, non-decreasing function of the
texture's palette index** (0 pixels off, for each save): the texture's top-left 160 x 120, unscaled, through the display ramp of the Wine render device (sample: index 31 shows as 25, 96 as 86, 161 as 153, 223 as 220).
Both captures give the same level for each of the 97 palette indices the two pictures share. That is the draw above, measured; the ramp is the render device's, not a value Play takes (Play's display ramp is its own,
[play fog](play-fog-gamma-blend.md) notes the Wine brightness gap).

### What Play does

* `parseSaveInfo` (`src/runtime/save-info.mjs`) is the `parseInfo` of the stored directory. The page parses (it holds the bytes) and sends the plain result to the simulation.
* `script-game-directory.mjs` `loadSaveInfo`: a SaveInfo whose directory entry has the decoded picture gets the **Texture as a script object** (`Engine.Texture`, outer the Package `saveInfo`, the export's name,
  `USize`/`VSize`/`UClamp`/`VClamp`/`UBits`/`VBits` as the file has them), and the DeusExSaveInfo's `Snapshot` property points to it. The Palette keeps only its registry slot: no script reads it and its
  `Colors` is an array of structs the script value layer has no form for. The registry slots stay exactly the measured ones (Texture, then Palette, per export name, once each for the process): the
  `real` scenario of `validate-save-directory.mjs` replays the screen with the two real files through the same slot comparison as before.
* The window host gives that Texture a raw image and the reference its HUD commands name (`image:<serial>`), like `GenerateSnapshot`'s textures (`W.snapshot.adopt`, [root snapshot](root-snapshot.md)); the RGBA
  pixels (the palette applied, index 0 kept with alpha 0 as the HUD decodes every tile texture) go to the page once, in the next frame snapshot's `display.images`; the page gives them to the HUD renderer
  (`setDynamicImage`), which draws the tile the original's draw produces: `u = v = 0, ul = 160, vl = 120` of the 256 x 128 texture.
* The engine's unique-name counter names the exports (`Texture1`, `Texture3`), so saves of different sessions can share a name. An export of a name the package already holds is, in the original, the object replaced
  in place (`StaticAllocateObject` of an existing name keeps the object's slot; **not measured**): Play keeps the one object and image key and replaces the pixels under it, so the window that holds the pointer shows
  the new picture, and no second slot is taken.

## Checked

* `npm test` (801 tests pass): `test/save-store.test.mjs` and `test/save-backends.test.mjs` run the same script against every backend (listing order, sizes, a SaveInfo parsed on write, bytes round trip,
  overwrite, delete), the IndexedDB backend over the fake that rolls back aborted transactions, the folder over an in-memory handle tree (two levels, an installation without a `Save` yet, files beside directories
  untouched, empty directories removed, permission states, `denied`/`missing`/`quota` mapping, the handle kept in IndexedDB), the served and layered backends, import and export;
  `test/save-persistence.test.mjs` (the page's choice of backend, pick, remembered folder, reconnect, forget, a dismissed picker, an unreadable folder, storage that cannot open, the dev server's folder under the
  page's, a refresh that finds a change once, a SaveInfo that is not a package); `test/save-info.test.mjs` over a hand-built package laid out like the real ones; `test/zip-store.test.mjs` (the CRC check value,
  DOS dates, an archive read back entry by entry; the archive also passes `unzip -t` and `zipfile.testzip`).
* `node scripts/validate-save-directory.mjs`: the three scenarios (empty, the two measured saves as names, and `real`: the two real files through `parseSaveInfo`) against the Wine registry dumps: rows, texts, buttons,
  every registry slot; in `real` the page is sent each picture once, the pixels are the palette applied to the file's P8 texture, and the screen's snapshot tile is the first row's picture with `u = v = 0, ul = 160, vl = 120`, then Quick Save's after a selection.
* `node scripts/validate-save-snapshot.mjs`: the Wine evidence above.
* `browser-tests/save-folder.spec.mjs` (Chromium new headless, worker mode, the default start; `DX_BASE_URL` names the dev server, `DX_SAVE_DIR` the real saves, default the Wine prefix's Save folder, read and never changed):
  1. a folder picked through the Saves window (a real `FileSystemDirectoryHandle` from the origin private file system, answered by the picker call) with copies of the real saves in a `Deus Ex/System` + `Deus Ex/Save`
     tree: the status is `folder`, installed, 2 saves; the Load Game screen lists the two rows of the Wine capture, the info text of each, the Load/Delete sensitivity, and **each snapshot window read from the drawing buffer is the
     real file's texture** (correlation above 0.97 with its own, below 0.9 with the other; every pixel one function of the palette index, as the Wine capture; the display ramp does not reverse); the Load Game button stops
     by name (`DDeusExGameEngine::Browse loadgame: loading a saved game is not implemented (docs/travel.md order step 4)`, the toast names `?loadgame=1`); the folder's files are unchanged;
  2. the same screen from saves imported (`webkitdirectory`) into the browser's storage, and the export's zip: every file at `Save/<slot>/<file>`, the bytes and CRC-32 of the files that went in;
  3. the dev endpoints' limits.
  Also: `browser-tests/original-start-load-game.spec.mjs` (now with `?saves=off`, the empty directory), `browser-tests/config-persistence.spec.mjs`, `validate-travel-play`, `validate-travel-newgame-play`.

## Open

* **Not run in a real browser with a real picker.** The headless Chromium of the specs has no picker and **closes the page when it reads a stored directory handle back out of IndexedDB** (observed here: the first read
  of a handle crashes the renderer; writing one works). So the later-visit path (stored handle, `queryPermission`, "Reconnect folder") runs against fakes only, and the picked-folder path runs with an origin-private-file-system
  handle, which is a real File System Access handle but not a folder on the player's disk. A headed Chromium with a real folder, Firefox and Safari were not run.
* **The program-files block** of Chromium's picker is from memory of its source, not tested here.
* **Writing** (`SaveGame`, `DeleteGame`, `?loadgame=`, the quick save and autosave, the snapshot that `GenerateSnapshot` makes for a new save) is [travel](travel.md) step 4. With saves listed, the screen's Delete Game
  button is reachable: it sends the console command `DeleteGame n`, which `DDeusExGameEngine::Exec` claims (a named stop; not exercised by the specs).
* `navigator.storage.persist()` and the export reminder are not built.
* The free space is the browser's estimate for every backend; a folder's volume is not asked.
* The same-name export replacement above, and the registry effects of many loads of same-named exports, are unmeasured.
