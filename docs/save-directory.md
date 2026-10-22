# The save-game directory: the Load Game screen (2026-10-21)

The original's Load Game screen (`MenuScreenLoadGame`) reads the `Save\` directory through eleven natives of two classes. Until now a click on MenuMain's Load Game
stopped Play at native 3013 `DeusExPlayer.CreateGameDirectoryObject`, the one stop of the [native census](native-census.md)'s menu sweep on the default start's path.
This note holds what the natives do (recovered from the retail `DeusEx.dll`), what the original showed under Wine for an empty and a two-save directory, and what Play
implements. It is the directory side only: `SaveGame` (native 3011) and loading a save (`?loadgame=`) are [travel order step 4](travel.md#proposed-implementation-order-for-play). (2026-10-22: the page now gives it real saves from a folder or the browser, and the screen draws their snapshot pictures: [save storage](save-storage.md).)

Verification, in one line each (all pass at this commit): `node scripts/validate-save-directory.mjs` (DLL facts, the measured sizes, the screen's rows, texts, buttons and
**every registry slot** of the screen opening and closing, empty and with the two measured saves, against the Wine dumps), `browser-tests/original-start-load-game.spec.mjs`
(the default start in headless Chromium: click Load Game, the empty screen, Escape), `test/save-directory.test.mjs` (the pure bodies), `test/native-registry.test.mjs`.

## The original

`DeusEx.GameDirectory` (`GameDirectory.uc`, `native noexport`) is the C++ class `XGameDirectory` (DeusEx.dll, size 0x54, vtable `0x10027e58`); `DeusExSaveInfo` is `UDeusExSaveInfo`
(size 0x78, vtable `0x10027a7c`). Members of `XGameDirectory`: `gameDirectoryType` (+0x28), `currentFilter` (+0x2c, FString), `directoryList` (+0x38, TArray<FString>),
`loadedSaveInfoPointers` (+0x44, TArray<UDeusExSaveInfo*>), `tempSaveInfo` (+0x50). `GSys->SavePath` (+0x30) is `..\Save`; `FURL::DefaultSaveExt` is `dxs`.
Every body below was read from the disassembly and its string and byte facts are asserted by `validate-save-directory.mjs` against the hash-pinned DLL.

| native | body | what it does |
|---|---|---|
| 3013 `DeusExPlayer.CreateGameDirectoryObject` | exec `0x10014b90` | `new` an `XGameDirectory` (`StaticAllocateObject`, size 0x54, Outer `GetTransientPackage()`, name `None`, flags 0), then its constructor `0x10017090` (the five members zero, the vtable). The object is named `GameDirectory<N>`. |
| 3086 `SetDirType` | `0x10018280` | `gameDirectoryType = arg` |
| 3080 `GetGameDirectory` | `0x100171e0` | type 0 `GetMapsDirectory` (`*.dx` in the map paths; the developer's `LoadMapWindow`), type 1 `GetSaveGamesDirectory` `0x10017520`: type = 1, `directoryList` emptied, then `FindFiles("<SavePath>\Save*", Files=0, Directories=1)`: the **directories** whose name starts with `Save` (`Save0001`, ...; not `QuickSave`, not `Current`) |
| 3084 `GetDirCount` | `0x10017e70` | `directoryList.Num` |
| 3085 `GetDirFilename` | `0x10017e80` | `directoryList(i)`, or the empty string out of range |
| 3087 `SetDirFilter` | `0x10018290` | `currentFilter = arg` |
| 3088 `GetSaveInfo(i)` | `0x10017eb0` | path `<SavePath>\QuickSave\SaveInfo.dxs` for -1, else `<SavePath>\Save%04d\SaveInfo.dxs`; `StaticLoadObject(DeusExSaveInfo, NULL, "MyDeusExSaveInfo", path, LOAD_NoWarn\|LOAD_Quiet = 0x2002)`; the result **even when null** is appended to `loadedSaveInfoPointers`; returns it |
| 3089 `GetSaveInfoFromDirectoryIndex(i)` | `0x10018000` | null when `i` is outside `directoryList`; else the same load of `<SavePath>\<directoryList(i)>\SaveInfo.dxs` (appended, null or not) |
| 3090 `GetTempSaveInfo` | `0x10018120` | the `tempSaveInfo` object, created once: `new` a `UDeusExSaveInfo` (size 0x78) in the transient package; constructor `0x10014dc0` (`DirectoryIndex = 0`) |
| 3091 `DeleteSaveInfo(info)` | `0x10018170` | null or a pointer not in the list: nothing. Else `ResetLoaders(info->Outer, 0, 1)` (the package's `LinkerLoad` is deleted), the object's scalar deleting destructor, and the entry leaves the list |
| 3092 `PurgeAllSaveInfo` | `0x10018240` | `for (i = 0; i < Num; i++) DeleteSaveInfo(list[i])` with `Num` re-read each pass and each delete removing its entry: **every second entry is skipped** (it stays allocated until a collection); then the array is emptied |
| 3093 `GetSaveFreeSpace` | `0x10017770` | `GetDiskFreeSpaceExA(<drive of GFileManager->GetDefaultDirectory()>:\)` through `GetProcAddress` (`GetDiskFreeSpace` A/W when that is not exported); the result is the free bytes available **divided by 1024 as a signed 64-bit value (`__alldiv`) and returned as an int** (kilobytes); a failed call returns 0. The screen shows `freeDiskSpace / 1024` as `Free Space: <n>MB` and paints it red below `minFreeDiskSpace` (100) |
| 3094 `GetSaveDirectorySize(i)` | `0x100179d0` | the directory `QuickSave` for -1, else `Save%04d`; `FindFiles("<SavePath>\<dir>\*.*", Files=1)`; the sum over the files of `FileSize / 1024` (each a signed int division, rounded toward zero). The screen shows `sum / 1024 + 1` MB |
| 3081 `GetNewSaveFileIndex` | `0x10017cc0` | over `directoryList`: copy each name, find `Save`, **put a NUL at the fifth character of the match and read the number from the sixth** (`Save0001` reads `001`; `Save1234` reads 234), keep the largest; return it plus one |
| 3082 `GenerateSaveFilename(i)` | `0x10017d60` | `"%s%04d.%s"` with `Save`, `i`, `dxs` |
| 3083 `GenerateNewSaveFilename(optional i)` | `0x10017e30` | the exec thunk starts `i` at -1; `GetSaveGamesDirectory()`; -1 becomes `GetNewSaveFileIndex()`; `GenerateSaveFilename(i)` |
| 3075 `DeusExSaveInfo.UpdateTimeStamp` | `0x10014df0` | `appSystemTime` into `Year, Month, Day, Hour, Minute, Second` (the local clock; the day of week and milliseconds are dropped) |
| `Destroy` (vtable +0x24) | `0x100170d0` | the directory list is released, `PurgeAllSaveInfo()`, the temp SaveInfo (+0x50) is deleted through its scalar deleting destructor, then `UObject::Destroy` |
| `Serialize` (+0x28) | `0x100171c0` | writes **only** `directoryList` (no `UObject::Serialize`): a collection sees no object reference in the directory |

`CriticalDelete(saveDir)` (native 751) calls the deleting destructor `0x10013260` (`~XGameDirectory`: `ConditionalDestroy` = the `Destroy` above, the members, `~UObject`, then the free).

The screen's script (`MenuScreenLoadGame.uc`): `InitWindow` calls `PopulateGames` (a GameDirectory; `GetSaveInfo(-1)`: a QuickSave row and `DeleteSaveInfo`; then for each `GetSaveInfoFromDirectoryIndex(i)` a row
`Description;time;julian;time;DirectoryIndex` and `DeleteSaveInfo`; `lstGames.EnableAutoSort(True)`; `CriticalDelete`), `EnableButtons`, `UpdateFreeDiskSpace` (another GameDirectory, `GetSaveFreeSpace`,
`CriticalDelete`). Selecting a row runs `UpdateSaveInfo` (a third GameDirectory, `GetSaveInfo(DirectoryIndex)`, `GetSaveDirectorySize`, `CriticalDelete`). With no row the screen has **no empty-list text**: a blank list, an empty info box,
Load Game and Delete Game insensitive, Cancel and the Confirm Savegame Deletion box live. `MenuScreenSaveGame` (reached only with a running game) reads the same directory (`GetTempSaveInfo`, `UpdateTimeStamp`, `CriticalDelete`);
its other natives (`SaveGame` 3011, `GenerateSnapshot` 1524, `Object.GetConfig`) are not part of this step.

## Measured

2026-10-21, `DeusEx.exe` 1.112fm under Wine on the Linux host (`~/.wine-deusex`, the shared Wine lock), `scripts/travel-probe.sh` in follow mode (tags `sd1`, `sd2`, `sd3`; captures under `.work/travel/<tag>/` of the worktree, outside Git),
the logo map `DX.dx`, a click opens MenuMain, a click on Load Game (the button at 640,268 of the 1280x720 viewport). The registry was read with `tools/dump-gobjects-win.c --available` before and after each step
(the same tool as [object-index captures](object-index-captures.md)). The prefix's `Save\` held `QuickSave` and `Save0001` (two files each, `00_training.dxs` and `SaveInfo.dxs`: 3,254,476 + 34,563 and 3,268,631 + 34,576 bytes, from 2026-09-09 and 09-12) and an empty `Current`.
Nothing in the prefix was deleted: the folder was copied to `.work/save-backup-20261021/` first, moved aside (renamed) for the empty measurement and moved back, and compared with the copy afterwards.

**The screen with the two saves** (`sd1/load1.png`, `load2.png`): rows sorted by date, newest first: `UNATCO Training Course  09/12/2026 02:47pm` (selected), `Quick Save  09/09/2026 02:27pm`.
Info for the first row: `Location: UNATCO Training Course / Save Count: 1 / Play Time: 00:16:23 / File Size: 4MB`, a snapshot picture, `Free Space: 90571MB`. Selecting Quick Save: `Save Count: 4 / Play Time: 00:56:46 / File Size: 4MB`, and Delete Game insensitive.
Their `SaveInfo.dxs` files are version-68 packages (`parsePackage`): exports `Palette`, `Texture` (the 160x120 snapshot) and `DeusExSaveInfo MyDeusExSaveInfo`; the properties are in `scripts/validate-save-directory.mjs`.
`File Size: 4MB` is the formula above: `Save0001` is 3,268,631 + 34,576 bytes = 3192 + 33 = 3225 KB, `3225 / 1024 + 1 = 4`; QuickSave 3178 + 33 = 3211 KB.

**The free space** is the host volume's: the label read 90571MB, 90572MB and 90564MB over the sessions, while `df -k` of the prefix said 92,745,808 KB available (`/ 1024 = 90572`) and the other processes of the host wrote.
It is a host input, not a value to reproduce.

**The empty directory** (`sd3/empty1.png`): no rows, nothing in the info box or the snapshot area, `Free Space: 90564MB`, Load Game and Delete Game insensitive. The game created no `Save\` directory for the read.

**The engine log** (`Save\` read): the original's `DeusEx.log` is flushed in 8 KB blocks and the session's last block never reached the file, so no log line of the read was captured; none of the flushed lines concerns it.
(Unverified: whether a missing `SaveInfo.dxs` or a loaded one prints `Loading: Package saveInfo`; the travel captures show that line for a `LoadGame`.)

### Registry

`GObjObjects` slots, relative to the Load Game screen object (`MenuScreenLoadGame0`, slot 34308 in all runs; `scripts/save-directory-measurements.json` holds the numbers):

* **Empty**: the screen leaves 126 objects (windows and graphics contexts). The GameDirectory objects the screen makes (three during `InitWindow`: none survives) leave **no** object behind and no
  `Package saveInfo`: a missing file creates nothing (no package, no linker is left in the registry).
* **Two saves**: 132 objects, and five that are not windows or graphics contexts: `Package saveInfo` (+86), `Texture Texture3` (+89), `Palette Palette3` (+90), `Texture Texture1` (+91), `Palette Palette1` (+92);
  the graphics contexts `GC272` (+85), `GC274` (+87), `GC273` (+88). Selecting the second row creates three objects at +132, +133, +134 and frees them in the order +133, +134, +132 (the free list `[133, 134, 132]`).
  Closing the screen leaves the five (the package and the snapshot exports stay resident) and a free list of 130 slots, the windows' in the original's order.

The sequence that explains it, and that Play reproduces (`validate-save-directory.mjs` replays Play's slot model through the screen and compares the final layout, the count and the free list at three moments, all slot for slot):

1. `PopulateGames`: `GameDirectory` D1 = +85. `GetSaveInfo(-1)`: `Package saveInfo` (+86, once for the process), `LinkerLoad` L (+87), `DeusExSaveInfo` S (+88), then the snapshot `Texture3` (+89) and its `Palette3` (+90).
   `DeleteSaveInfo`: the linker goes (+87), then the object (+88). `GetSaveInfoFromDirectoryIndex(0)`: a new linker takes +88, the object +87, `Texture1` +91, `Palette1` +92; `DeleteSaveInfo`: +88, then +87. `CriticalDelete(D1)`: +85.
2. `UpdateFreeDiskSpace`: a GameDirectory takes +85 and gives it back.
3. The first row's selection (`UpdateSaveInfo`): D = +85, linker +87, SaveInfo +88 (the snapshot exports exist: nothing new); freed in the order +87, +88, +85. The list is `[.., 87, 88, 85]`.
4. The windows' graphics contexts then take +85 (GC272), +88 (GC273), +87 (GC274): the order the dump shows.

Play's model of the original's registry starts the DX map 3 slots short of the original's (`DX open capture (3 holes)`, [object-index captures](object-index-captures.md)); every comparison is relative to the screen's own slot, and the 3-slot offset is the same
before and after, so it is the pre-existing seed's, not the natives'.

## Play

* `src/runtime/save-directory.mjs`: the **save directory** interface the natives read (`directories()`, `files(dir)`, `info(dir)`, `freeSpaceBytes()`), an in-memory implementation (`createSaveDirectory`, **empty by default**, with `put`/`remove` for the
  future `SaveGame`/`DeleteGame`), and the pure bodies (slot names, FindFirstFile wildcards, the KB sums, the free-space conversion, `GetNewSaveFileIndex`, `GenerateSaveFilename`). A browser store (IndexedDB) or a picked folder implements them: `save-store.mjs` (`createStoredSaveDirectory` over a save backend), designed in [save storage](save-storage.md); its writes are step 4.
  Since 2026-10-22 the page owns that storage and **sends the simulation the listing** (`replace(list)`: every slot's files and its `info`, `parseSaveInfo`'s `{properties, snapshot: {texture, palette, image}}`, `image` the decoded P8 picture of the snapshot, null when the texture is in a form the reader does not decode).
  `hostSaveDirectory()` is the one directory of a JavaScript realm (the page, or the sim worker), so it outlives the per-map sessions; `createGame({saveDirectory})` takes another.
* `src/runtime/script-game-directory.mjs`: `prepareGameDirectoryStore` (called by `script-doors.mjs` next to the dump and log stores): the natives of the table, `GameDirectory` objects that take their registry slot
  from `allocateObject` like the original's `new`, `DeusExSaveInfo` objects filled from the store's `info`, the package, linker and snapshot-export slots, `Destroy`, `Serialize` and the scalar deleting destructor (`CriticalDelete`, `script-runtime.mjs`).
  `script-values.mjs` gained the whole-value storage of a non-owning object array (`loadedSaveInfoPointers`), as for `Decal.SurfList`. Registry: `src/runtime/native-registry.mjs`, id `game-directory` (3013, 3075, 3080-3094).
* `src/viewer/save-directory-host.mjs`: the **free space host input**. The original asks the volume of its working directory; Play's saves will live in browser storage, whose room is `StorageManager.estimate()`'s `quota - usage`, read once per session
  before the sim is created (the native is synchronous), capped at what the original's int kilobytes can hold (2 TiB less 1 KiB). Without a StorageManager (a Node validator, an old browser) the fixed default is **8 GiB** (`DEFAULT_FREE_BYTES`),
  a labelled figure, not a measurement. The screen shows it as `Free Space: <MB>MB`.
* The **local clock** (`UpdateTimeStamp`) is the browser's (`browserClock`), a host input.
* `viewer/menu-driver.mjs` and `settings-probe.mjs` gained the read-only ops `list` and `text` (rows and selection of a list window, the text of a label) for the validators.

### Boundaries (stated, not implemented)

* **GD_Maps** (`SetDirType(0)`, then `GetGameDirectory`): the developer map list of `LoadMapWindow`; stops by name (`UnsupportedGameDirectoryError`).
* **The snapshot texture** *(done 2026-10-22, [save storage](save-storage.md#the-snapshot))*: a SaveInfo with the decoded picture gets the Texture as a script object, `Snapshot` points to it, and the screen's snapshot window draws it as the original does (checked against the Wine captures and in the page). The Palette keeps only its slot; a texture the reader does not decode (an info without `image`) takes the slots and leaves `Snapshot` None, the picture area empty.
* **A second `GetSaveInfo` while one is loaded** (the original's linker would answer with the loaded object): stops by name; the screens delete each SaveInfo before loading another.
* **The order of `directories()`**: NTFS returns ascending names and the in-memory directory sorts that way; the order of the original's `FindFiles` was measured only for the two entries of the capture, and the screen sorts by date anyway.
* **The registry slots of saves with a snapshot of a different export name or a Package `saveInfo` already resident from another path** (the model keys the exports by name, as the measured run shows for two distinct names); a collection's treatment of the resident `Package saveInfo`
  after a map change is **unverified** (it is not registered among the collection's package roots).
* **The Save Game screen** (Training, MenuMain's Save Game): its `InitWindow` runs `NewSaveGame` through the same natives (3013, `GetTempSaveInfo` 3090, `UpdateTimeStamp` 3075, `CriticalDelete`) and the first tick stops at the
  name-bound `Object.GetConfig` in `GenerateNewSnapShot` (`node scripts/census-ui-screens.mjs --map 00_Training --screens MenuScreenSaveGame`): not compared with the original, and `GetConfig`, `GenerateSnapshot` (1524) and `SaveGame` (3011) are step 4.
* Unverified: the engine log lines of the read; `GetSaveFreeSpace` through `GetDiskFreeSpace` (the path only Windows 95 OSR1 takes); the temp SaveInfo and `UpdateTimeStamp` against the original (read from the disassembly, run, not measured).

## Next

`SaveGame` (3011) fills a slot: `SaveInfo` object, `Current` copied into the slot, the live level with the player written into it ([travel](travel.md#the-save-directory)); the store's `put` is where it lands. Loading a slot (`?loadgame=N`),
`DeleteGame` (`save.remove`), and the snapshot `SaveGame` makes (`GenerateSnapshot`, [root snapshot](root-snapshot.md)) follow with it. The screen's `Load Game` button reaches `LoadGame` -> `ClientTravel("?loadgame=N")` today and stops there by name (`DDeusExGameEngine::Browse loadgame: loading a saved game is not implemented`, [travel](travel.md)); the browser spec drives it.
