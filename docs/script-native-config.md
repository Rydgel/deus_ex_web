# Native config classes and the console `get` / `set`

The options menus keep their settings in the engine's native classes. A
`MenuUIChoice` loads and saves with
`ConsoleCommand("get ini:Engine.Engine.AudioDevice SoundVolume")` and
`ConsoleCommand("set ini:Engine.Engine.ViewportManager Brightness 0.5")`, and the
Brightness slider follows each `set` with `FLUSH`. The three classes behind those
`ini:` keys are native, so their properties exist only in the DLLs:

| `[Engine.Engine]` key | Class (DeusEx.ini) | Declared in |
| --- | --- | --- |
| `ViewportManager` | `WinDrv.WindowsClient` (base `Engine.Client`, UClient) | WinDrv.dll, Engine.dll |
| `AudioDevice` | `Galaxy.GalaxyAudioSubsystem` (base `Engine.AudioSubsystem`) | Galaxy.dll |
| `GameRenderDevice` | `GlideDrv.GlideRenderDevice` (base `Engine.RenderDevice`) | GlideDrv.dll, Engine.dll |

`src/runtime/script-native-config.mjs` is the registry behind them;
`script-console-command.mjs` routes `UObject::StaticExec` GET and SET to it, and the
window host owns one (`host.nativeConfig`).

## The original control flow (Core.dll)

| Step | Body |
| --- | --- |
| `UObject::StaticExec` | `0x10153110`: GET at `0x101531ad`, SET at `0x101532da` |
| class | `ParseToken(256, escapes)`, then `StaticFindObject(UClass, ANY_PACKAGE, name)` |
| `ini:` names | `UObject::ResolveName` `0x10154ad0`: `ini:` reads the `System` file, `usr:` the `User` file; the key is the text after the **last** `.`, the section the rest (`Engine.Engine` / `AudioDevice`); the stored value (`Galaxy.GalaxyAudioSubsystem`) replaces the name. A missing key fails the lookup (Throw is 0). |
| property | `ParseToken`, then `FindField` `0x101011db` (the class, then each super) |
| GET | `ExportText(0, buffer, Defaults, Defaults, PPF_Localized)` of the **class default object**, logged. Missing class / property: `Unrecognized class %s` / `Unrecognized property %s` (NAME_ExecWarning), and the command still returns 1. |
| SET | spaces skipped, then `GlobalSetProperty(value, class, property, offset, 1)` `0x101523a0` |
| `GlobalSetProperty` | for every object that IsA the class: `ImportText` into the property, then `PostEditChange` (vtable `+0x40`); then `ImportText` into the class defaults; then `SaveConfig(CPF_Config)` `0x10151540` on the defaults |

`SaveConfig` exports **every** config property of the class (own, then supers) into
`[<class path>]` of the class's config file (`System` = DeusEx.ini), flushes, and
`LoadConfig(1)` re-reads the defaults of every loaded class under the topmost
`CLASS_Config` ancestor (the SDK headers declare `UClient`, `UAudioSubsystem` and
`URenderDevice` as `DECLARE_ABSTRACT_CLASS(..., CLASS_Config)` and `UWindowsClient` as
`CLASS_Transient|CLASS_Config`). Instances keep their values. Two consequences are
visible: `set ... Brightness 7` leaves the **class default** at `7.000000` while the
live client holds the clamped `1`, and the second `get` returns the default.

Property text is `config-text.mjs` (UBoolProperty, UIntProperty, UFloatProperty,
UByteProperty with an enum, UStrProperty at the Core addresses it lists). Its `%f` now
uses the formatter measured against the game's MSVCRT ([value format](script-value-format.md)),
so a `-0.0` exports as `0.000000`.

## Property tables

`tools/native-class-properties.py` reads a class's `StaticConstructor` for the pattern
`new(GetClass(), TEXT("Name"), RF_Public) UXProperty(CPP_PROPERTY(Member), TEXT("Category"), 0x4000)`
and prints name, type, member offset, flags, category and bool bit mask. The tables in
`NATIVE_CONFIG_CLASSES` are that output; `scripts/validate-native-config-classes.mjs`
re-derives them and requires equality: **52 properties** of Engine.Client (17, ctor
`0x10375010`), WinDrv.WindowsClient (10, `0x111015f0`), Galaxy.GalaxyAudioSubsystem (18,
`0x10604bb0`) and Engine.RenderDevice (7, `0x103713c0`), in registration order
(`UStruct::AddCppProperty` `0x10125fd0` prepends, so iteration is reversed). The member
offsets agree with the SDK's `UClient` layout (`UnCamera.h`). The two enums come from the
FNames the constructors create: `Details` {High, Medium, Low, Ultra Low} for TextureDetail /
SkinDetail and `OutputRates` {8000Hz … 48000Hz} for Galaxy's OutputRate (the byte clamped
to <= 6 by `PostEditChange`).

The other render devices (Glide, D3D, OpenGL, Soft, Metal, Sgl) are registered with the
`Engine.RenderDevice` properties only: a name that is not found on them is an explicit
`UnsupportedNativeConfigError`, never "Unrecognized property". A class the engine did not
instantiate (anything but the three configured above and their bases) is not found, as in
the original; a name that resolves to some other class is an explicit boundary, because the
original would find any loaded script class.

## Values

Each loaded class has a class defaults store and each instantiated class a live store, both
filled by `LoadConfig(1)` from GConfig (a pass per class from the topmost down, each reading
all inherited properties under that pass's section). A property with no ini value has an
unrecovered native constructor default: `get` of it is an explicit boundary. The installed
DeusEx.ini has every key, so none of the menu paths reaches that.

The live Galaxy values are Play's own audio state, so a `set` is live without a copy:
`MusicVolume`, `SoundVolume` and `SpeechVolume` are `runtime.audio.volumes.state`; `AmbientFactor`,
`DopplerSpeed`, `UseSurround` and `ReverseStereo` (read by `galaxy-audio.mjs` on every update) are
`galaxyConfig`. `EffectsChannels` is clamped on the instance but not linked: the voice array is sized
at initialisation. `Client.Decals` is the live `WindowsClient.Decals` that
`AttachDecal` and the decal pass read.

## PostEditChange

| Class | Body | Effect |
| --- | --- | --- |
| `UClient` | `0x10374ef0` | Brightness clamped to [0, 1], MipFactor to [-3, 3] (FCOM against the limits: below or unordered gives the low bound) |
| `UWindowsClient` | `0x111030f0` | UClient's, then joystick enumeration when `UseJoystick` (refused: no WINMM) |
| `UGalaxyAudioSubsystem` | `0x10605ad0` | OutputRate <= 6, Latency 10..250, EffectsChannels 0..32, DopplerSpeed [1, 100000], AmbientFactor [0, 10], then `SetVolumes` `0x106061b0`: `galaxy-music.mjs` `setVolumes()` sends `glxSetSampleVolume` (the louder of sound and speech, times 127) and, with UseDigitalMusic, `glxSetMusicVolume` to the library and the mixer |
| `URenderDevice` | `UObject::PostEditChange` | none |

## Display

`FLUSH` reaches `UEngine::Flush`, which calls the render device. D3DDrv's `UD3DRenderDevice::Flush`
(`0x1000107d`; gamma ramp at `0x10002e32`) re-reads `Client->Brightness` (UClient `+0x6c`) and
loads the ramp `appPow(i / 255, 1 / (2.5 * Brightness))`. The window host records that read as
`host.display = {brightness, flushes}`; each frame snapshot carries it
(`sim-session.mjs`), and the page sets its Brightness control and the display ramp exponent
(`display-ramp.mjs brightnessGamma`: `1 / float32(float32(b) * 2.5)`, the largest float for 0).
The control's range is now 0..1, the menu's.

`GetRes` and `GetColorDepths` are answered by `UGlideRenderDevice::Exec` (GlideDrv.dll
`0x10707dec`, `0x10707e22`): the fixed strings `640x480 800x600 1024x768 1280x1024 1600x1200`
and `16`; `TMUDETAIL` stays refused. `SetRes WxH[xD]` is `UWindowsViewport::Exec` (WinDrv.dll
`0x1110715f`): the parse is translated and the `RenDev->SetRes(X, Y, ColorBytes, IsFullscreen())`
call becomes a **request** to the page, which fixes its drawing buffer to that size and scales it
to fit (`main.mjs` `fixedResolution`). No Glide mode exists to switch; this is the browser
standing in for the render device, labelled as such.

## Not covered

* **Persistence.** `SaveConfig` writes GConfig and `Flush` stores the text it would have saved
  in the cache's in-memory `written` file (config-cache.mjs). The browser has no writable System
  directory, so nothing survives a reload; each map load builds a fresh GConfig from the
  installed files. The page's brightness control and drawing-buffer request do persist across
  map loads within a page. Writing the INI files back is Stage 6.
* Live effect of most client and device properties (`TextureDetail`, `SkinDetail`, `NoLighting`,
  `CurvedSurfaces`, `ScreenFlashes`, `DetailTextures`, `HighDetailActors`, ...): the value is
  stored, exported and saved, but Play does not read it. Wired: Brightness (display ramp),
  Decals (decal path), the Galaxy volumes and flags above.
* Galaxy properties the library reads at initialisation (`UseDirectSound`, `Use3dHardware`,
  `LowSoundQuality`, `OutputRate`, `Latency`, `UseCDMusic`, ...): the menus mark these restart-only.
  `EffectsChannels` is clamped and stored but the voice array keeps its size.
* `SetRes`'s colour depth, `ToggleFullscreen` / `EndFullscreen`, `GetCurrentColorDepth` and the
  other `UWindowsViewport::Exec` keywords stay refused.
* Script-class `get` / `set` (any class but the native ones above and InputExt) is refused.

## Checks

* `scripts/validate-native-config-classes.mjs` (`NATIVE_PROBE_PYTHON`): the 52-property tables
  and both enums against the DLL constructors.
* `scripts/validate-native-config.mjs` (headless): 52 checks. Part 1 drives the registry over the
  installed DeusEx.ini (class resolution, FindField, ExportText, every clamp, SaveConfig into
  GConfig, the reload). Part 2 runs the original menus in Training: Sound sliders reach the
  mirror library's `glxSetSampleVolume` / `glxSetMusicVolume` with the x87 arithmetic of
  `galaxy-volumes.mjs`, Brightness reaches Flush, Decals reaches `Client.Decals`, SetRes is
  recorded, Customize Keys rebinds G through GrabMouse / `set Input`, and the Controls screen's Mouse Sensitivity and Invert Mouse change what
  `PlayerPawn.PlayerInput` does with mouse motion (a yaw delta proportional to the sensitivity;
  Invert flips pitch only). Three planted faults (no SetVolumes, no clamp, a clamped class
  default) are caught.
* `scripts/validate-settings-play.mjs` (Playwright, **worker mode**, one worker-side
  `settingsProbe` call per step, `src/viewer/settings-probe.mjs` and `menu-driver.mjs`): the
  menu buttons and slider thumbs of Display > Brightness, Sound and Controls run on 00_Training;
  the page's Brightness control and ramp exponent follow Flush, Cancel restores them, OK writes
  `SoundVolume`, the player's MouseSensitivity / bInvertMouse change, and `SetRes 800x600` fixes
  the canvas drawing buffer to 800x600 (then `GetCurrentRes` reports it).
