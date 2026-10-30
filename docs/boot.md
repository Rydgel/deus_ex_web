# The original's start: splash, logo map and main menu

Stage 6 (docs/roadmap.md §6) starts the page as the original starts: the user asked on 2026-10-21 for the
page to behave as the game does, with the web debugging HUD only behind `?debug=1`. This page is the
source of truth for that sequence, traced from the original before anything is wired.

## What the original does

1. **Splash.** `DeusEx.exe` builds the path `..\Help\Logo.bmp` (UTF-16 literal at `0x1092d2c4`, used at
   `0x1090909e`-`0x1090914d`) for the engine's `InitSplash` (SDK `Engine/Inc/UnEngineWin.h`: the bitmap is
   loaded by `FWindowsBitmap::LoadFile`, and a borderless dialog of exactly the bitmap's size is centred on the
   screen, `(SM_CXSCREEN - BitmapX) / 2`, by its own thread until `ExitSplash`). `Help/Logo.bmp` is 512 × 410,
   8 bits per pixel. The first-run and safe-mode configuration pages hide the splash and show it again
   (`ExitSplash`, `D.DoModal()`, `InitSplash(NULL)`, `UnEngineWin.h` ~757). `..\Help\LogoSmall.bmp` (500 × 77,
   `0x1092d990`) is pushed at `0x1090c89b` by another path, not the splash (which one is not traced).
2. **The logo map.** With no map on the command line the engine browses to `DeusEx.ini` `[URL] LocalMap=DX.dx`,
   with `DefaultGame=DeusEx.DeusExGameInfo`, `GameEngine=DeusEx.DeusExGameEngine` and the player class
   `Class=DeusEx.JCDentonMale`. DX.dx's `DeusExLevelInfo0` has `MapName` "DX", `MissionLocation` "Intro" and
   `missionNumber` −2. Its actors: `EidosLogo0` (2557, 77, 12), `IonStormLogo0` (1280, 13, −5), `DXLogo3` (−6, −1, 22)
   with two `DXText` and an `ElectricityEmitter` under it, 16 `InterpolationPoint`s tagged `IntroCam` (Position 1
   to 15, `RateModifier` per point, `bEndOfPath` on `InterpolationPoint13`), 5 lights and a `PlayerStart`.
3. **The flight.** `DeusExPlayer.TravelPostAccept` (DeusEx.u, "hack for the DX.dx logo/splash level"): for
   mission −2 it finds the `IntroCam` point with `Position == 1`, turns collision off, sets it as `Target`,
   `SetPhysics(PHYS_Interpolating)`, `PhysRate` 1, `PhysAlpha` 0, `bInterpolating`, hides the HUD, puts nothing in
   hand and goes to state `Interpolating`. The camera flies past the Eidos logo, the Ion Storm logo and the
   Deus Ex logo. `Interpolating.InterpolateEnd` travels only if `NextMap` is set; DX.dx's player has none, so
   the view stays on the logo at the path's end.
4. **The menu.** In state `Interpolating`, `Fire` (the left button: `LeftMouse=ParseLeftClick|Fire`) calls
   `ShowMainMenu` when the level's mission number is below 0, and `Escape=ShowMainMenu` (DefUser.ini) does the
   same. `ShowMainMenu` flushes the texture caches (`FLUSH`) and invokes `MenuMain` on the root window. Whether
   anything opens the menu without input is measured below.
5. **From the menu.** Every choice travels, through `Level.Game.SendPlayer` or a `ClientTravel`:
   Training (`StartTrainingMission`: `SendPlayer(Self, "00_Training")`), New Game (MenuScreenNewGame, then
   `ShowIntro(True)`: `SendPlayer(Self, "00_Intro")`, then `PostIntro` → `StartNewGame(strStartMap)`), Load Game
   (`ClientTravel("?loadgame=" $ saveIndex, TRAVEL_Absolute, False)`). The travel itself is [travel](travel.md)'s.

## In Play

DX.dx already runs headless (`stage5-capture-rehearsal.mjs --map DX`, 2026-10-21): the player is
`interpolating` (physics 8) from (2796, 321, −106) at tick 1, passes x 2566 at 300 and 1539 at 600, and is at
(−11.3, 404.8, −123.0) by tick 1500, by the original's `TravelPostAccept`. The original captures:

| Scene | Inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `dxb1` | none, 1700 ticks | the player is at the path's end, (−12.76, 404.92, −123.07), from the first traced tick: the flight ran in the harness's frozen phase (below); the logo's emitter draws 3 numbers a tick | **FAIL**: Play starts the flight at tick 1 (2877.7, 358.9, −131.3); the stream differs from tick 1 (the emitter draws only once it is in view) |
| `dxb2` | Escape at 1600 | `MenuMain` and its windows at 1600, and inside the second menu button's layout the first load of `DXFonts`: `Package DXFonts`, `LinkerLoad`, `Font MainMenuTrueType`, `Texture0`, `Texture1`, `Palette1` | **FAIL** on the flight, as `dxb1`; the creations are **equal**, 100 of 100 in class, tick, order and slot, since the registry model takes the shared graph's first loads (below) |

**The harness's frozen phase holds no flight.** `live-acceptance.mjs` opens the map with `bPlayersOnly` set and waits for the load (`--load-wait`,
25 s by default) before the tracer arms the level's breakpoints. `bPlayersOnly` freezes the level but not the players, so on DX.dx the original's
player flies the whole path before the first traced tick (4,079 window frames in `dxb1`), while Play's replay starts it at tick 1. The capture of
the boot itself needs a mode that traces from the load (the tracer attaches to a running process with `DebugActiveProcess`, after the open):
not done. The flight is the same native `PHYS_Interpolating` as the intro's camera, whose shots are compared with the original in Stage 4 (4.5.7).

**A first package load through the shared graph takes its registry slots** (`ScriptRuntime.modelGraphDynamicLoad`). `dxb2`'s first difference was the
font: `DynamicLoadObject("DXFonts.MainMenuTrueType")` runs `StaticLoadObject` over the shared class graph (`loadGraphDynamicObject`), which modeled
nothing, while the prepared routes (portraits, speech) did (`modelPreparedDynamicLoad`). The package's `UPackage` and `LinkerLoad` are now taken at its
`CreateLinkerLoad`, and each object of it once in the order `EndLoad` preloads them, `GObjLoaded`'s, which is the creation order: the Font, then the page
Textures its `Serialize` created, then the Palette the first Texture's created, as the original did. A class's first load from such a package (its
functions, states and properties) is not measured and stays out of the model. On the other maps `DXFonts` is resident before the seed (the HUD).

## The page

The page (by default since the travel of steps 0 and 1; `?boot=1` before) starts as the original does: the page bars are gone (`#app.original-start`), `Help/Logo.bmp` (served by the dev server
with the other game folders, or read from the chosen folder) is shown at its own size in device pixels, centred over black, from the moment the
files are known until the first map is loaded, and that map is DX.dx in Play. The play hint keeps only its stops (a runtime error, a travel,
the pointer lock). `?debug=1` is the debugging page (the toolbar, the web crosshair and hints, Inspect, the map list, `00_Training` loaded
first), which every tool and validator opens: the 65 scripts that open the page pass their URL through `scripts/page-url.mjs` `debugUrl`. The
menu's Training and New Game buttons travel ([travel](travel.md)): Escape and a click on Training arrive in `00_Training` (steps 0 and 1); New Game
runs the difficulty and New Game screens, the intro and the Island (step 2). Play Intro (the intro, then the DXOnly level: the DX logo with the player Paralyzed, a click or Escape for the menu) and Credits run the original's scripts and end at the menu (step 5, [travel](travel.md#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings)); Load Game's slots are step 4's load side.

**The screen's shape is the original's 4:3 (2026-10-21).** The original starts fullscreen at `DeusEx.ini` `[WinDrv.WindowsClient]`
`FullscreenViewportX=640`, `FullscreenViewportY=480` (`StartupFullscreen=True`), and every mode its Display menu offers is 4:3 or 5:4 (the page's
display modes, `DEFAULT_DISPLAY_MODES`). Its projection keeps the horizontal field of view, so a wider screen shows less above and below: the
original's own frame of the flight's end at 1280 × 720 (`.work/acceptance/DX/dxend-original.png`) has the "Deus Ex" text below its bottom edge, as
Play's 1280 × 720 frame has. At 960 × 720 (the original after `--early-cmds "SetRes 960x720"`, `dxend43`) the text is in view in both, at the same
place (x 175 to 780) and with the logo the same size; that capture's hold caught the spinning logo at another yaw, so its pixels are not
compared. The default start therefore draws a 4:3 picture centred in the window at the window's own pixel density (`screenAspect` `4:3`); a
resolution chosen in the menu (`SetRes`) fixes the buffer to that size as before, and `?debug=1` keeps its own choice (the window's shape by
default). A resolution chosen in the menu is kept across a reload with the other settings
([configuration persistence](config-persistence.md)): `SetRes` writes the Fullscreen* or Windowed* viewport keys, and the next start fixes the drawing buffer to the ones of the mode it
starts in when they differ from the installed file's: in the original the mode `StartupFullscreen` picks, in the page always the Windowed* keys, since the page starts windowed
(`display-config.mjs` `chosenResolution(..., false)`; below).

**The mouse and fullscreen (2026-10-21).** The original starts fullscreen with the mouse captured (`StartupFullscreen=True`, `CaptureMouse=True`),
its menus draw their own cursor, and its viewport's `WM_KEYDOWN`/`WM_SYSKEYDOWN` case (WinDrv.dll `0x1110a280`) turns Enter with Alt held
(`GetKeyState(VK_MENU) & 0x8000`) into `UWindowsViewport::ToggleFullscreen` (`0x1110a29b`) instead of an input event (`SC_MAXIMIZE` reaches it too,
`0x1110b172`). A browser grants fullscreen and the pointer lock only on the user's input, and the user's Escape releases the lock, except in a page's
fullscreen whose Keyboard Lock holds Escape (Chromium only; a held Escape still leaves). So on the default start (`main.mjs` `grabPointer`):
* the first click takes the pointer, after the click's release, so the window that takes the click sees its press and release before the lock's
  input reset. **It does not take fullscreen** (the user's choice, 2026-10-22: from 2026-10-21 the first click took fullscreen too, as
  `StartupFullscreen=True` starts the original; now the page starts windowed and fullscreen is Alt+Enter's or the Display screen's Toggle Full-Screen Mode);
* a click in the world that takes the pointer reaches no binding (no Fire): a rule of this page, not the original's;
* while a menu holds the mouse, the pointer lock's relative motion moves the menu's own cursor, and the system cursor is hidden over it;
* Alt+Enter takes fullscreen (`#app`), every bindable key through the Keyboard Lock ([input bindings](input-bindings.md)) and the pointer, and leaves them
  again; the Enter press reaches no binding, as in the original. Firefox refuses a pointer lock asked in the same event as the fullscreen
  (NotAllowedError) and grants it once the page is fullscreen (measured 2026-10-28), so the page asks again at `fullscreenchange`;
* a travel keeps the pointer (the original's viewport keeps the mouse across a level load);
* out of fullscreen, or in a browser without Keyboard Lock, Escape releases the pointer as the browser requires, and the next click (a menu
  button's included) takes it back. The browser takes that Escape press for itself (the page sees no key), so the page hands it to the game
  (`main.mjs` `handEscape`, 2026-10-30): a lock the page did not give back itself (`releasePointer`), lost while the page keeps the focus, its
  visibility and its fullscreen state, is an Escape, 50 ms later, through the page's own key paths; a real Escape press around it stands for
  it, and the browser's late press or release of it is dropped. One press opens MenuMain and frees the mouse, whose own position then drives
  the menu's cursor. (Before, the first press only freed the mouse and a second one opened the menu.) The original's windowed viewport gets
  every Escape: WinDrv's window procedure answers WM_KEYDOWN itself;
* a lost focus lets go of the held input and the game goes on (the user's choice, 2026-10-30; before, a blur paused Play until a click,
  "Click the view to resume"); a hidden page runs no frame and comes back with an ordinary step, not the time it was hidden.
  A check that needs a still frame calls `deusExViewer.freeze()` (validation only): the simulation halts, as a blur did, and the page
  keeps drawing the last snapshot; `freeze(false)` goes on with no catch-up.

The keys and the wheel the first click makes the game's, and the Keyboard Lock list, are in [input bindings](input-bindings.md).

`browser-tests/original-start-input.spec.mjs` drives this in Chromium's new headless mode (which grants the lock and fullscreen). Its Escape is a
synthetic key, which does not go through the browser's own Escape rule, so what a real Escape does with Keyboard Lock is Chromium's documented
behaviour, not measured here. The web crosshair is hidden on the default start.

**The logos are drawn (2026-10-21).** DX.dx's `EidosLogo0`, `IonStormLogo0`, `DXLogo3` and the two `DXText` are classic `UMesh`
meshes (DeusExDeco's `EidosLogo`, `IonStormLogo`, `DXLogo`, `DXText`), as are DeusExCharacters' `Fly`s (the flies `FlyGenerator`s
spawn): the game's only five, and Play's actor mesh layer bound only `LodMesh`, so the flight showed the electricity's glow and nothing
else, and the flies never drew on any map. [Classic UMesh](umesh.md) traces the path from the original: `UMesh::Serialize`, `UMesh::GetFrame`
(`0x103a7780`) and Render's `DrawMesh` classic body (`0x10b0d235`), each translated and compared with the unchanged original in the
Unicorn oracle, bit for bit at the render pass's precision control 24; the binding is `actor-umesh-sim.mjs`, the CPU path of the LodMesh
one. On the default start the Eidos logo, the Ion Storm logo and the Deus Ex logo with its text now appear during the flight;
`validate-umesh-play` checks the five actors and a FlyGenerator's flies on the Island. The original's `Shot` of the flight's end pose
and Play's frame equal to within one pixel by 1/255 outside the random electricity bolt ([UMesh](umesh.md) "Frame against the original").
