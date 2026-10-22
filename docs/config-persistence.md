# Configuration persistence (2026-10-22)

The original keeps its settings across runs in two files of `System\`, `DeusEx.ini` and `User.ini`. Until now Play forgot every one of them on a page reload: the key
bindings of Customize Keys, the resolution `SetRes` chose, the choices of the Settings screens (sound, display, controls, game options, the UI background, the colour
schemes) and `bAskedToTrain`, so New Game asked "train first?" again. The page now keeps what the original writes, in the browser, and rereads it at startup as the
original reads its files. This page holds the evidence (the original's code, a Wine session), what Play does, what was checked, and what is open. The same browser storage
holds the saves later: [save storage](save-storage.md).

## What the original does

Read from the retail binaries, then measured.

| Step | Body |
| --- | --- |
| first run | `appInit`, Core.dll `0x10149ad5-0x10149d6b`: the file named by `INI=` / `USERINI=` (default `DeusEx.ini`, `User.ini`); when it does not exist, `appLoadFileToString("Default.ini")` (`DefUser.ini` for the User file) and `appSaveStringToFile` of that text to the missing name. Only a missing file is copied. |
| read | `GConfig->Init`: `FConfigFile::Read` over the file's text (`config-cache.mjs`, translated earlier). `appLoadFileToString`: a file that starts with FF FE is UTF-16LE, else one byte per character. |
| write | `FConfigFile::Write`, DeusEx.exe `0x10915760` (inline SDK code): returns at once unless the file is dirty and not `NoSave`; clears `Dirty`; builds `[Section]\r\n`, then `Key=Value\r\n` for every pair, then `\r\n`, for **every** section in table order; `appSaveStringToFile(Text, Filename)`. The whole file is rewritten. |
| encoding | `appSaveStringToFile`, Core `0x10148c40`: ANSI, one byte per character, unless some character is `0x100` or more, then FF FE and UTF-16LE for the whole text. No terminating NUL. |
| when | `FConfigCacheIni::Flush(0)`: every dirty file. It is called by `UObject::SaveConfig` (Core `0x10151540`) right after its exports; nothing flushes at exit. |
| dirty | `SetString` marks the file dirty when a key is added or its value differs (the launcher's rule, `config-cache.mjs`); an unchanged value does not. |

Who calls `SaveConfig` in single player (the decoded scripts): `DeusExPlayer.StartTrainingMission`, `MenuUIWindow.StartNewGame` (`bAskedToTrain`, once); the SaveSettings of
Sound, Controls, Game Options, Adjust Colors (`player.SaveConfig()`, and `ThemeManager.SaveConfig()`); `MenuChoice_GoreLevel` (`Level.Game.SaveConfig()`); the Goals and
Inventory screens; the Credits window; every `set ini:...` / `set InputExt ...` the menus send, through `UObject::GlobalSetProperty` (Core `0x101523a0`), which ends in
`SaveConfig` on the class defaults; and `SetRes`, through `UWindowsViewport::ResizeViewport`.

`UWindowsViewport::ResizeViewport` (WinDrv.dll, the function ending at `0x1110e376`, source file `WinViewport.cpp`): with a render device and outside the editor, a
fullscreen viewport (`BlitFlags & BLIT_Fullscreen`) stores `FullscreenViewportX/Y` and `FullscreenColorBits` in the client object, a windowed one the `Windowed*` triple,
`ColorBits = ColorBytes * 8`, and then calls `Client->SaveConfig(CPF_Config)` (`0x1110e35d`). `SetRes` (`UWindowsViewport::Exec`, `0x1110715f`) reaches it through the render
device. The next start opens the viewport at the size of the mode it starts in (`StartupFullscreen` picks the keys).

## Measured under Wine (2026-10-22)

`DeusEx.exe` 1.112fm under Wine 11.17 on the Linux host (`~/.wine-deusex`), under the shared Wine lock, launched on `INI=DeusEx-ad.ini USERINI=User-ad.ini` (copies of the
prefix's files that `ad/scripts/original-game.mjs` writes; the prefix's own `DeusEx.ini` and `User.ini` were untouched: their modification times did not change). Two sessions of
`scripts/travel-probe.sh` in follow mode drove the real menus with the mouse (`dxinput click`, 1280x720 client coordinates) and took the new `ini:<label>` step (a copy of both
files and their modification times) before and after every OK. Session 2 started with `bAskedToTrain=False` (`DX_USER_SET`, new). The numbers are
[scripts/config-persistence-measurements.json](../scripts/config-persistence-measurements.json); the captures are in `.work/config-persistence/wine/` (not in Git).

| Action in the real menu | File written at OK | What changed (the whole file was rewritten, keys in file order) |
| --- | --- | --- |
| Settings > Sound: Sound Effects slider to the middle, Reverse Stereo once | `DeusEx.ini` | `[Galaxy.GalaxyAudioSubsystem]` `SoundVolume` 0 to 127, `ReverseStereo` False to True. `User.ini` was **not** rewritten (its modification time did not move): `player.SaveConfig()` changed nothing. |
| Settings > Display: resolution once (1280x720 to 1280x768), Decals once | `DeusEx.ini` | `[WinDrv.WindowsClient]` `WindowedViewportY` 720 to 768, `Decals` True to False |
| Display: resolution alone (1280x768 to 1280x960), OK | `DeusEx.ini` | `WindowedViewportY` 768 to 960 (X unchanged: X is the width). The window then drew black under the Wine virtual desktop (1400x860; not investigated). |
| Main menu > New Game, `bAskedToTrain=False` | `User.ini`, at the click | `[DeusEx.DeusExPlayer]` `bAskedToTrain` False to True. The prompt appeared; New Game again went straight to the difficulty screen. |
| Settings > Keyboard/Mouse: second row, Enter, `G`, OK | `User.ini` | `[Extension.InputExt]` `G` ShowGoalsWindow to ParseRightClick (`[Engine.Input]` untouched) |
| Settings > Controls: Invert Mouse, Mouse Sensitivity slider | `User.ini` | `[Engine.PlayerPawn]` `bInvertMouse` False to True, `MouseSensitivity` 3.000000 to 7.000000 |
| Settings > Game Options: Gore Level, Subtitles, UI/Menu Background | `User.ini` and `DeusEx.ini` | `[DeusEx.DeusExPlayer]` `bSubtitles` True to False, `UIBackground` 0 to 1; `[Engine.GameInfo]` `bLowGore` False to True, and **65 keys appended** to that section, which the baseline held as `bLowGore` alone: `Level.Game.SaveConfig()` exported every config property of the game class (`bMuteSpectators`, ..., `IPPolicies[0..49]`, ..., `DemoHasTuts`) |
| Settings > Colors: Menu and HUD colour scheme once | `User.ini` | `[DeusEx.DeusExPlayer]` `MenuThemeName` Default to Blue & Gold, `HUDThemeName` Default to Amber |

* Nothing was written before OK: the seven snapshots taken with the choices changed and OK not clicked were byte-identical to the screen's start.
* Nothing was written at exit: the files were byte-identical before and after `cmd exit` in both sessions.
* A file is written at once, whole, in its own key order; a key the file lacked is appended at the end of its section. A file with no changed value is not written.
* At launch the game rewrote `DeusEx-ad.ini` once, `[WindowPositions] WizardDialog` only: the launcher's own window placement, not a setting Play has.
* The played prefix's `User.ini` held keys the installed one lacks (the end of `[DeusEx.DeusExPlayer]`, `[Engine.PlayerPawn]`, a whole `[Extension.InputExt]` section with
  `StrProperty0=` for `IK_None`, `[Engine.Pawn]`): the keys the original's earlier saves had added, in the order the first save adds them. Play's first save adds the same keys in
  the same order (checked).

Unmeasured: the fullscreen branch of `ResizeViewport` (the Wine viewport was windowed), the first-run copy of `Default.ini` (read from `appInit`, not run), the keys the first-run
configuration wizard writes (`FirstRun`, `Detected.ini`: the launcher's, not Play's).

To repeat it: `DX_USER_SET='DeusEx.DeusExPlayer.bAskedToTrain=False' scripts/travel-probe.sh cfg2 follow:<steps>` with lines such as `ini:start`, `key:ESC`, `click:640 304`
(Settings), `click:640 243` (Keyboard/Mouse), `key:DOWN`, `key:ENTER`, `key:G`, `ini:keys-pre-ok`, `click:706 555` (OK), `ini:keys-post-ok`, `shot:<name>`, `quit`, then read the
screens' pictures for the next click.

## What Play does

* **A store that plays the writable file** (`src/runtime/config-store.mjs`). Per file (`deusex.ini`, `user.ini`) it holds `{bytes, base}`: the bytes `appSaveStringToFile` would
  have written (`ini-bytes.mjs`, both directions translated above) and the installed file they were written over. The ini text is the original's own, so reads reproduce the
  original's exactly, including key order and the multi-valued keys.
* **Layering at startup.** `AssetStore(files, {configStore})` builds `configFiles` with `layerConfigFiles`: a missing DeusEx.ini / User.ini is `Default.ini` / `DefUser.ini`
  (appInit's copy), and each file reads the kept bytes over the installed ones. While the installed file is the one the kept file was written over, the read is the kept file.
  If the installed file changed since (another installation, an edited file), the read is the installed file with every key the player changed laid over it (`rebaseIni`: a key whose saved value differs from the
  stored base, or that the base lacked, is set as `SetString` sets it). That second rule is Play's design (the original has one file and no installed copy to compare);
  it keeps a player's choices when the folder behind the page changes.
* **The writes happen where the original writes.** `ConfigCache.flush` reports each file it wrote (`onWrite(name, text)`); `script-class-loader.mjs` hands it to the store. SaveConfig, `set`,
  Customize Keys, the Settings screens and `bAskedToTrain` need nothing else: they already ended in `Flush`. `SetRes` is new: `script-native-config.mjs` `resizeViewport`
  translates the tail of `ResizeViewport` (the Fullscreen* or Windowed* triple, `ColorBits = ColorBytes * 8` with the viewport's depth when the command has none) and
  `Client->SaveConfig()` on the live object (its clamped values, not the class defaults'). Whether the viewport is fullscreen is the page's browser fullscreen, reported to the simulation
  (`fullscreen` option and command), starting from `StartupFullscreen`.
* **Every later map load reads the kept files.** Each map builds a fresh GConfig from `configFiles`; before, that was always the installed files, so a setting changed in the
  menu was gone after the next travel. Now Training's player has the options chosen on the logo map's menu (browser spec).
* **Where the bytes live.** The page opens IndexedDB (`browser-storage.mjs`, database `deusex-web`, version 1, object stores `meta`, `ini`, `saves`, `savedata`, `handles`; the `ini` row is
  `{leaf, bytes, base, savedAt}`; a `format` row names the layout) and loads the rows into the store before the asset stores are built. The simulation worker gets the same records in
  `init`, builds its own store, and answers every file the game writes with a `config` message; the page's store `accept`s it and writes the row (one transaction per file). One writer
  (the page) avoids two realms racing on the database. `?sim=inline` uses the page's store directly.
* **On for the default start, off for the debugging page.** `persistenceMode`: the default start keeps; `?debug=1`, the page every validator opens, has no store at all (the installed
  files, as before); `?persist=1` turns it on anywhere, `?persist=0` off, `?persist=reset` forgets what was kept and keeps from then on (the way back to the shipped ini).
  Validators that open the default start run in a fresh browser context, so they begin from empty storage.
* **Startup.** The kept `Brightness` is applied at the first frame of a load (the render device's Init loads the ramp from `Client->Brightness`; the installed 0.6 is the page's default,
  so nothing changes without a kept value). The kept resolution: `startupViewport` reads the keys `StartupFullscreen` picks; when they differ from the installed file's the page fixes
  the drawing buffer to them as the `SetRes` that wrote them did (`chosenResolution`; the default start draws a 4:3 picture at the window's own density whatever the installed
  640x480 says, [the page](boot.md#the-page), so the installed size is "no choice"). A size chosen while windowed does not take effect at a fullscreen start, in the original or here.
  With the kept config the page no longer overrides `bSubtitles` at each load (it was the value read at page start, which undid the Game Options menu's own choice on the next map).
* **A found fault: `IK_None`.** The Wine files hold `StrProperty0=` in `[Extension.InputExt]`; Play's first save wrote `None=`. `UInput::StaticInitInput` (Engine.dll `0x103930c0`)
  names each key's `UStrProperty` with `FName(EInputKey name + 3, FNAME_Add)`; for `IK_None` that is `NAME_None`, so the property takes its class's unique name, `StrProperty0`.
  `configKeyName` now does that; it also reads that key at load as the original does.

### Failure handling

The page never stops on a storage failure. `openConfigPersistence` reports one of these kinds (`browser-storage.mjs`), shows its message in the page's toast when it happens and
again when the game is on screen (it comes while the files load, and a toast lasts twelve seconds), and `window.deusExViewer.status().storage` carries `{state, kind, message}`.
Meanwhile the store keeps the files in memory, so settings last as long as the page, as a run of the original keeps its GConfig until it exits.

| kind | cause | behaviour |
| --- | --- | --- |
| `unavailable` | no `indexedDB`, or a browser that refuses it in a private window (`InvalidStateError`, as older Firefox did) | installed files, settings for the session, message "does not keep data for this page" |
| `blocked` | site data blocked (reading `indexedDB` throws `SecurityError`), or another tab holds an upgrade open past four seconds | the same, "blocks storage" |
| `newer` | the database was written by a newer build (`VersionError`, or a `format` row above ours) | left alone, the same |
| `quota` | `QuotaExceededError` on a write | the file is kept in memory, the status is `failing`; the next write that fits clears it. Nothing already stored is lost (a transaction aborts whole). |
| `closed` | another tab upgraded the database, or the user cleared site data | writes fail with this kind; "reload the page" |
| `failed` | anything else | the browser's message |

Rows that are not a kept file (wrong type, a leaf other than the two files) are ignored at load.

## Checked

* `test/config-store.test.mjs`, `test/browser-storage.test.mjs`, `test/save-store.test.mjs` (`npm test`): the encodings, the cache's `onWrite`, layering, the rebase, the first-run copy,
  the startup viewport, the IndexedDB layer over a fake that rolls back aborted transactions and injects failures (blocked, private window, newer, quota, closed), the persistence object
  (reload, reset, recovery, the worker/page hand-off).
* `node scripts/validate-config-persistence.mjs` (53 checks): Play replays the measured menu changes through the original menus (Sound, SetRes and Decals, Keyboard/Mouse, Controls, Game Options,
  Colors, New Game) and each OK changes exactly the keys the original changed, to the values it wrote, with nothing written before OK; the keys a first save appends (19 in `User.ini`, the
  65 of `Engine.GameInfo`) are the original's, in its order; the fullscreen branch of `SetRes` (labelled unmeasured above); then a new asset store over the kept records starts a game with the
  rebound key, the options, the volume, Decals and the theme. `--wine .work/config-persistence/wine` replays the session from the measured baselines and requires **byte-identical**
  `User.ini` and `DeusEx.ini` (71 checks): the whole 600-line `[Extension.InputExt]` section included.
* `browser-tests/config-persistence.spec.mjs` (Chromium, new headless, worker mode, `DX_BASE_URL`): on the default start a real `G` rebinds in Customize Keys; `SetRes 800x600`
  fixes the buffer; Controls, Game Options (UI background, Subtitles), Brightness, and New Game's one prompt; Training's player has them after the travel; **after a reload** the buffer is 800x600,
  `KEYBINDING G` is ParseRightClick, the options, brightness and `GetCurrentRes` are kept, and New Game goes to the difficulty screen without the prompt. Also: `?debug=1` starts from the
  installed files and creates no database; blocked storage (a `SecurityError` getter) shows the message and keeps settings for the session only; a database at version 9 is left alone;
  `?persist=reset`.
* `validate-travel-play`, `validate-travel-newgame-play`, `validate-input-bindings`, `validate-native-config`, `validate-settings-play`, `validate-input-console`, `validate-player-dump`,
  `validate-script-config` still pass.

## Open

* **The Display screen's Resolution choice.** Its list is `GetRes`, the host's modes (`DEFAULT_DISPLAY_MODES`), and its value is whatever entry equals `GetCurrentRes`, else the first.
  On the page the buffer is rarely one of them, so the screen's OK sends `SetRes 640x480` for the untouched choice, and now saves it. Unverified in the page; the validator avoids the screen's OK.
  A fix needs a decision about what Play's mode list is (the original's current mode is always in its list).
* **The last write can be lost.** The original writes synchronously; an IndexedDB commit finishes after the page's task. A tab closed within that moment loses the last change. No `pagehide`
  flush is possible for an asynchronous commit.
* **Two tabs.** Each holds its own copy and the last writer of a file wins, as two game instances on one directory would.
* **Best-effort storage.** The browser may evict the origin's data under pressure, and Safari clears script-written storage after seven days without a visit. `navigator.storage.persist()` is not requested
  (Firefox shows a prompt for it); the save storage will ask once the first save exists ([save storage](save-storage.md)).
* **The launcher's files** (`WindowPositions`, `Running.ini`, `Detected.ini`, the first-run wizard) are not Play's; only DeusEx.ini and User.ini are kept, and `onWrite` of any other file is ignored.
* **The mode list, joystick, render device** and the other `UWindowsClient` properties whose live effect is not wired keep their values in the file all the same ([native config](script-native-config.md)).
