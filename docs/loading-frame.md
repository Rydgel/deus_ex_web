# The loading frame

What the original shows while a map loads, who draws it, and how Play draws it (2026-10-30). Before this, Play covered every load with
the page's own gate (`#gate`: "Loading original map", "Reading …", "Compiling shaders").

## What the original shows

Measured under Wine on the Linux host (D3DDrv, 1280×720 window in a 1400×860 Wine desktop, `scripts/travel-probe.sh ls1` in follow
mode; the frames are X11 grabs of the Wine desktop window, `.work/loading-screen/`, outside Git):

| load | frames before / during | what is on screen during the load |
|---|---|---|
| New Game from DX.dx's menu (Start Game → 00_Intro) | `newgame/t002282` / `t002452..t002942` | the logo map without the menus or cursor, darkened, "LOADING" |
| Escape in the intro (PostIntro → 01_NYC_UNATCOIsland) | `island/t002432` / `t003337`, `t003599` | the intro's camera drawn again (it had moved), darkened, "LOADING" |
| `LocalTravel 01_NYC_UNATCOHQ` on the Island | `hq/t002720` / `t003625`, `t003874` | the Island with its HUD, darkened, "LOADING" |
| Load Game from the main menu (Save0001, Training) | `loadgame/t001595` / `t002129`, `t002356` | the level behind the menu, the menu gone, the HUD darkened, "LOADING" |

The frame stays until the next level's first frame. The loads here were short (0.3 to 0.6 s), so each shows in one to three grabs.

Measured in `hq/` (the player stood still, so the frame before and the loading frame show the same scene): of the 37,343 channel values
at 100 or more outside the text, 35,081 equal `round(value × 25 / 255)` exactly and the others are the window's border column (the
grab's crop started one column late: the client area begins at desktop x = 4). The text: blue, (0, 0, 255) at its core, its ink
from x 567 to 712 and y 347 to 369 in viewport pixels, centred.

## Who draws it

**LoadMap's PaintProgress frame.** `UGameEngine::LoadMap` (Engine `0x1038c1f0`), when there is a client with a viewport and a level
(`0x1038c36d..0x1038c38c`; the very first map, loaded before any level, draws nothing):

| address | step |
|---|---|
| `0x1038c3e0` | `LevelInfo.LevelAction` (`+0x510`) = 1, `LEVACT_Loading` (3, `LEVACT_Connecting`, at `0x1038c446` for a pending net level) |
| `0x1038c49c..0x1038c4fc` | `LevelInfo.Pauser` (`+0x4e0`) = "" |
| `0x1038c51d` | the viewport actor's `+0x69c &= ~0x200000`: bit 21 of PlayerPawn's bitfield word, `bShowMenu` (the SDK's `EngineClasses.h` order) |
| `0x1038c52e` | `PaintProgress()` (vtable `+0xb8`, thunk `0x10302211`, body `0x10388740`) |
| `0x1038c534..0x1038c549` | `Audio->SetViewport(Audio->GetViewport())` |
| `0x1038c59b` | `LevelAction` = 0 |

`UGameEngine::PaintProgress` (`0x10388740`) swaps the viewport actor's `FlashFog` (`+0x61c`) for (0, 0, 0) and `FlashScale` (`+0x610`)
for (0.1, 0.1, 0.1) (`0x3dcccccd`), calls `Draw(Viewport, 1, NULL, NULL)` (vtable `+0x78`) and swaps them back. That `Draw`
(`0x1038f110`) is an ordinary frame of the level being left: the world, the HUD windows (the PostRenderFlash event), then EndFlash with
the flash halved and clamped (`0x1038f36e..0x1038f54e`, [screen flash](screen-flash.md)): alpha `min(2 × 0.05, 1) × 256 − 0.5` → 25,
fog 0, so `dst × 25/255` over the world and the HUD. After EndFlash, the viewport actor's PostRender event (`0x1038f73e`) and the
console's: `UConsole::PostRender` (vtable `+0x5c`, `0x10379f70`) puts back the frame `UConsole::PreRender` (`0x10379d10`) kept
and sets `FrameX` (`+0x738`) and `FrameY` (`+0x73c`) from its X and Y, then the PostRender event (`0x1038f772`) runs `Engine.Console.PostRender`.

Which frame that is: every travel reaches LoadMap from `UGameEngine::Tick`'s client travel after the level's tick, so the frame is that
tick's state, never drawn otherwise. New Game, Load Game and QuickLoad clear the window stack first (`DeusExPlayer.StartNewGame`,
`LoadGame`: `ClearWindowStack` then `ClientTravel`), so the menus are gone from it. A travel within a mission also runs
`SaveCurrentLevel(-2)` before LoadMap, which draws a PaintProgress frame of its own with `LevelAction = 2` (DeusEx `0x1000fd7a`): "SAVING",
replaced by the LOADING frame once the level is filed (not caught by the grabs, about one a second).

`Draw` also sets `LevelAction = 4` (Precaching, `0x1038f202`) for a frame when the render device's `PrecacheOnFlip` (`+0x6c`) is set,
and runs `Render->Precache` after it (`0x1038f7c3..0x1038f7f2`). D3DDrv's `UsePrecache=False` (DeusEx.ini) leaves it unset: no
PRECACHING frame in the shipped configuration.

**The console's message.** DeusEx.ini's `[Engine.Engine] Console=Engine.Console`. `Console.PostRender` calls `DrawLevelAction(C)`
(Engine `Console.uc`): `bShowMenu` returns at once, a `Pauser` with `LEVACT_None` prints PausedMessage; LoadMap cleared both, so
`LEVACT_Loading` picks `LoadingMessage` (Engine.int `LOADING`), `C.Style = 3` (STY_Translucent), `DrawColor = (0, 0, 255)`,
`C.Font = C.LargeFont`, then `PrintActionMessage`: `bCenter = false`, `StrLen`, `SetPos(FrameX/2 - XL/2, FrameY/2 - YL/2)`,
`DrawText(BigMessage, false)`.

`C` is the viewport's canvas after `UCanvas::Update` (`0x10377560`): the Canvas.Reset event (the class defaults: Font None,
Space and Org 0, Style 1, DrawColor (127, 127, 127), Z 1), then `Frame` (`+0x7c`), `ClipX`/`SizeX` and `ClipY`/`SizeY` from the frame.
Engine.u's Canvas defaults name the stock fonts; `LargeFont` is Engine.LargeFont (the TrueType import "HandelGothic BT", height 32,
anti-aliased: 4 pages of 64 glyphs). `UCanvas::Init` (`0x10377540`) only sets `Viewport`.

The canvas text natives:

* `execStrLen` (native 464, `0x10377650`): CurX and CurY truncated to ints and zeroed, `WrappedStrLenf` (vtable `+0x68`, `0x10377380`)
  = `WrappedPrint(STY_None, XL, YL, Font, 0, Text)`, CurX and CurY back from the ints, XL and YL from WrappedPrint's ints.
* `execDrawText` (native 465, `0x103778f0`): CR defaults to 1; no Font logs "DrawText: No font"; a Style other than STY_None runs
  `WrappedPrint(Style, XL, YL, Font, bCenter & 1, Text)`; `CurX += XL`, `CurYL = max(CurYL, YL)`; CR: `CurY += CurYL`, CurX and CurYL 0.
* `WrappedPrint` (`0x10376790`, cdecl with `this` first): returns if ClipX or ClipY is negative; PolyFlags `STY_None` 1, `STY_Translucent`
  4, `STY_Modulated` 0x40, else 0, each `| 0x1000802`; the colour is DrawColor × 1/255. Per line: `TestXL = ftol(CurX)`; each character
  (page = ch / CharactersPerPage; a page or glyph past the arrays is 0 × 0) adds `ftol(USize + SpaceX)` and raises `TestYL` to
  `ftol(SpaceY) + VSize`; a line wider than ClipX ends at its last word (the first word always fits). A drawn line (`Style != 0`,
  `OrgY + CurY < Frame->Y`, `OrgY + CurY + YL > 0`) starts at `ftol(CurX)` (centred: `ftol((ClipX - XL) × 0.5 + CurX)`), y `ftol(CurY)`;
  then CurX = 0, `CurY += YL`, XL the widest line, YL the sum; spaces after a wrap are skipped.
* DrawString (`0x10376d20`, here with no clip and no `&` hot key): each glyph whose page has a texture goes to the tile submit at
  `(ftol(X + advance + OrgX), ftol(Y + OrgY))`, USize × VSize from (StartU, StartV); the advance grows by `ftol(USize + SpaceX)`.
* The tile submit (`0x10377170`): PF_Invisible draws nothing; a tile beyond the frame or without area is dropped; one the frame cuts is
  clipped with its U/V extents scaled by integer division (`0x103771de..0x1037727c`), then `RenDev->DrawTile`.

For "LOADING" in a 1280×720 frame: XL 150 (USize 18, 25, 23, 25, 10, 25, 24), YL 39, `SetPos(565, 340.5)`, the glyph cells
x 565..715, y 340..379, which hold the ink measured above. Composited from these cells (Engine.LargeFont's page texels, masked,
`ONE, INVSRCCOLOR` with (0, 0, 255)) over the measured frame before, darkened by 25/255, the 200 × 60 box around the text matches
the grab with a worst difference of 6 levels (35,167 values equal, 709 within 2, 124 within 6): D3DDrv uploads the font page as a
16-bit texture (`Use32BitTextures=False`), which rounds the anti-aliased edge levels; Play draws the 8-bit RGBA texels.

## Play

* **The simulation side** (`src/runtime/script-console-level-action.mjs`): an Engine.Canvas object, the canvas text natives above
  (`wrappedPrint`, `canvasStrLen`, `canvasDrawText`, the dispatcher of natives 464 and 465 while the loading frame runs), and `paint`,
  which runs LoadMap's and PaintProgress's steps around the frame's HUD paint: `LevelAction` = 1, `Pauser` = "", `bShowMenu` false, the
  flash swapped (so the HUD paint's flash planes are PaintProgress's), then the console's `FrameX`/`FrameY`, the canvas's Update and the
  original `Console.DrawLevelAction(Canvas)` script, the flash swapped back and `LevelAction` = 0. Its tiles are HUD tile commands on
  Engine.LargeFont's pages. The natives are JavaScript, not the Rust core: they run once per map load, on a handful of glyphs, off the
  per-frame path.
* **Which frame** (`sim-session.mjs`): the snapshot whose tick travelled (`begin.travel`, after `game.clientTravel()`'s travel step, the
  part of Browse before LoadMap) paints its HUD that way (`hud({progress})`); `snapshot.hud.console` carries the console's tiles.
  The LargeFont pages are among the HUD textures decoded before a level's first frame (`hudTextures`), since this frame is drawn once.
* **The page** (`main.mjs`): `drawFrame` draws the console's tiles after the flash pass, before the display ramp. `travelTo` holds the
  canvas (`travelHeld`) and `loadMap` keeps the gate hidden for a travel (`heldFrame`): no frame is drawn from the travel's snapshot to the
  next level's first, so the loading frame stays through the worker's load and the page's own build (meshes, the world swap, the shader
  warm-up). With the tools (`?debug=1`) the load's steps show in the status line instead of the gate.
* **The page's gate stays** where the original has no level frame: the first map at page start (LoadMap's gate needs a level; the
  splash covers it), a map opened from the list (page tooling; the console's `open`/`LocalTravel` is a travel and gets the loading frame)
  and a load that fails ("Could not load this map").

### Checks

* `scripts/validate-loading-frame-play.mjs` (Chromium worker by default; `--browser firefox`, `--sim inline`): on 00_Training,
  `LocalTravel 00_TrainingCombat` and then `QuickSave` + `LoadGame -1`. Each: the gate never shows from the travel to the arrival; the
  loading frame's flash is `{scale: [0.05f × 3, 0], fog: 0}`; its console tiles equal PrintActionMessage's layout computed from Engine.u's
  LargeFont for the canvas size (page, x, y, size, U/V, colour (0, 0, 255), style 3); on screen during the load the frame is darkened and
  the LOADING cells hold blue pixels; the next level arrives with no stop.
* The travel validators the gate touched: `validate-travel-play`, `validate-travel-newgame-play`, `validate-travel-restore-play`,
  `validate-inline-restore-play` (waits for the gate hidden), `browser-tests/original-start-input.spec.mjs`, `load-game.spec.mjs`,
  `original-start-load-game.spec.mjs`.

## Not done or not verified

* **SAVING.** `SaveCurrentLevel` draws a PaintProgress frame with `LevelAction = 2` before it files a level: a travel within a mission
  (replaced by the LOADING frame once filed) and every Save Game and Quick Save (shown while the save writes, then play goes on). Play's
  save runs inside the worker's tick and posts no frame before it: no SAVING frame is drawn. Its duration in the original was not measured.
* **The rest of Console.PostRender** (the Border pattern with `bNoDrawWorld`, the time demo, the console lines and border,
  DrawSingleView's messages) is not run, on the loading frame or on any other Play frame; DrawLevelAction is, and on the loading frame
  its only reachable branch is the LevelAction message.
* **The canvas branches the loading frame does not reach**: WrappedPrint's word wrap, a centred line (`bCenter`), non-zero SpaceX/SpaceY,
  several lines and DrawText's CR are translated from the disassembly above but not compared with the original (no oracle run, no
  capture). The loading frame is one unwrapped line with SpaceX = SpaceY = 0 and `bCenter` false, which the grab verifies.
* **Partial clipping** of a canvas glyph (the tile submit's `0x103771de..0x1037727c`) is not translated and stops by name; a centred
  message reaches it only in a frame narrower than the message (150 px for LOADING).
* **The audio refresh** after PaintProgress (`Audio->SetViewport`) is not modelled here.
* **A canvas resize during the load** (the window resized, fullscreen toggled) clears the browser's drawing buffer, and the held frame
  with it, until the next level's first frame. The original's window keeps its last presented frame.
* **Texel depth**: Play's glyph edges are the 8-bit palette's, the original's D3D upload is 16-bit (up to 6 levels apart, above).
