# The options menus in Play (Stage 4)

Esc opens the original `MenuMain`; its Settings entry is `MenuSettings`, which invokes the
screens below. Everything runs from the original `DeusEx.u` scripts: the browser supplies
only the window-host natives and the engine services behind `ConsoleCommand`
([native config](script-native-config.md)). The scripts are read with
`scripts/dump-script-function.mjs` (decoded bytecode with native names; the retail sources
are not shipped).

## Census (2026-10-08, Training)

`scripts/census-ui-screens.mjs` takes menu paths, `MenuSettings>MenuScreenDisplay#MenuChoice_Brightness`
(`>` steps through the buttons whose `buttonDefaults` invoke the next class, `#` presses an
action choice) and exercise words: `!cycle` activates every value choice once (the
restart-required ones open their message box, which the census dismisses), `!reset` presses
Reset to Defaults, `!ok` presses OK (SaveSettings, then pop). Each screen opens, draws,
takes input and closes:

| Screen | Choices | Result |
| --- | --- | --- |
| MenuSettings | the six screens below | opens, closes to MenuMain |
| Controls | Always Run, Toggle Crouch, Invert Mouse, Mouse Sensitivity | cycle / reset / OK pass |
| Customize Keys | the key list | Down + Enter waits for a key (GrabMouse, LockMouse, ShowCursor), a key is taken, OK rebinds it through `set Input`: G moved from ShowGoalsWindow to the second row's action |
| Game options (`MenuScreenOptions`) | Object Names, Weapon Auto-Reload, Gore Level, Subtitles, Crosshairs, HUD Augmentation Display, UI Background, Player Bob, Log Timeout | pass, except **UI/Menu Background = Snapshot** followed by OK: `ShowSnapshot` calls `RootWindow.GenerateSnapshot` (native 1524), a render-to-texture of the 3D view: unsupported. Reset to Render 3D and the rest pass. |
| Display | Adjust Brightness..., Toggle Full-Screen Mode, Render Device, Screen Resolution, Texture Color Depth, World/Object Texture Detail, Detail Textures, Decals | pass, except **Toggle Full-Screen Mode**: `UWindowsViewport::Exec ToggleFullscreen`. Render Device opens its restart prompt (a message box) and closes. |
| Adjust Brightness | Brightness slider | pass |
| Sound | Music, Sound Effects, Speech volume, Effects Channels, Sample Rate, Sound Quality, Reverse Stereo, Dolby Surround, Hardware 3D | pass |
| Adjust Colors | Menu / HUD translucency, colour schemes, HUD borders | pass. `MenuScreenRGB` and the theme load/save screens are reached only from `DeusExPlayer.ShowRGBDialog`, which returns unless cheats are enabled: not a player menu. |
| New Game, Load / Save Game | | New Game is another family; Load / Save stop at the save-game directory (Stage 6) |

## Natives and engine services this added

* ScaleWindow `SetValueFormat`, `GetValueString`, `SetEnumeration`, `ClearAllEnumerations`,
  `PlayScaleSound` (1646–1649, 1653): [scale settings](script-window-scale-settings.md).
* `RootWindow.SetSnapshotSize` (1523), `Window.GrabMouse` / `UngrabMouse` (1450 / 1451, wrappers
  of the already translated `XWindow::GrabMouse` / `UngrabMouse`).
* Core casts ByteToBool, IntToBool, BoolToByte / Int / Float, FloatToBool, StringToFloat,
  ByteToString, BoolToString: [Core casts](script-core-casts.md); MSVCRT `%f` and `atof`:
  [value format](script-value-format.md).
* `UObject::StaticExec` GET and SET for the viewport manager, audio device and render device
  classes, with their property tables, PostEditChange and SaveConfig:
  [native config](script-native-config.md). `UGlideRenderDevice::Exec` GetRes / GetColorDepths and
  `UWindowsViewport::Exec` SetRes.

## What each setting does in Play

| Setting | Path | Effect |
| --- | --- | --- |
| Brightness | slider -> `set ini:...ViewportManager Brightness v` + `FLUSH` -> UClient PostEditChange clamp -> render device Flush | the page's display ramp exponent `1 / (2.5 * Brightness)` and its Brightness control follow (`display-ramp.mjs`, D3DDrv Flush `0x10002e32`); Cancel restores the saved value; Escape on this screen saves (`bEscapeSavesSettings`) |
| Music / Sound Effects / Speech volume | sliders -> `SetInstantMusicVolume` / `SetInstantSoundVolume` / `SetInstantSpeechVolume` (natives 268-270) while dragging; OK -> `set ini:...AudioDevice <Volume> v` -> Galaxy PostEditChange -> SetVolumes | the Galaxy library's sample and music volumes (the AudioWorklet's mixer), through the translated `galaxy-music.mjs` `setVolumes` |
| Reverse Stereo, Dolby Surround | `set ini:...AudioDevice ...` | `galaxy-audio.mjs` reads both each update |
| Decals | `set ini:...ViewportManager Decals` | `Client.Decals`, read by `AttachDecal` and the decal pass |
| Mouse Sensitivity, Invert Mouse | `PlayerPawn.UpdateSensitivity` / `bInvertMouse` | read by the original `PlayerPawn.PlayerInput` (`MouseScale = MouseSensitivity * FOVScale`; the vertical axis flips): a yaw delta proportional to the sensitivity, Invert flips pitch only |
| Always Run, Toggle Crouch, Subtitles, Crosshairs, ... | script properties of the player | stored on the player, read by the game scripts |
| Screen Resolution | `SetRes WxH` | a request to the page, which fixes its drawing buffer to that size (see below) |
| Sample Rate, Sound Quality, Hardware 3D, Texture Color Depth, Render Device | config + restart prompt | stored; the menu itself says they apply after a restart |

`GetCurrentRes` reports the page's real drawing buffer. The list `GetRes` returns is the Glide
device's fixed list (`640x480 ... 1600x1200`), the installed `GameRenderDevice`, so the Resolution
choice shows the entry matching the current size, or the first one when the browser's buffer is
none of them (the original's current mode is always in the list).

## Boundaries

* **Persistence.** The INI files are not written back (Stage 6): `SaveConfig` updates the
  in-memory GConfig, which each map load rebuilds from the installed files; only the page's own
  Brightness control and fixed resolution survive map loads.
* UI Background = Snapshot (native 1524), Toggle Full-Screen Mode (`ToggleFullscreen`),
  `GetCurrentColorDepth`, `EndFullscreen`, `Preferences` are explicit errors.
* Live effect of the other client and render-device properties (texture detail, `NoLighting`,
  `CurvedSurfaces`, `ScreenFlashes`, `DetailTextures`, ...) is not modelled; the values are stored,
  exported and saved.
* Sound Effects volume reaches the mixer through `glxSetSampleVolume`; the speech path of the
  browser conversation player still mixes by the per-sound volume only
  ([Galaxy volumes](galaxy-volumes.md)).

## Checks

`scripts/validate-native-config.mjs` (52 checks, headless, the menus driven through
`src/viewer/menu-driver.mjs`), `scripts/validate-native-config-classes.mjs` (the property tables
against the DLL constructors) and `scripts/validate-settings-play.mjs` (Playwright, worker mode, a
worker-side `settingsProbe` call per step): Display > Brightness, Sound and Controls on
00_Training.
