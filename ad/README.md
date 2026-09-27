# Promo video

A 106-second motion-graphics promo for the Deus Ex browser runtime, rendered
from code: original-game captures, browser-runtime captures, animated
evidence from this repository, and an original synthesized soundtrack.

Output: `ad/out/deus-ex-browser-runtime.mp4` (1920×1080, 30 fps, H.264 + AAC).
Captures, renders and generated audio stay out of Git (`ad/.gitignore`); they
contain original game content.

## Pipeline

```sh
node ad/scripts/facts.mjs              # numbers and snippets -> ad/build/facts.json
# original game (CrossOver bottle "DeusEx"), see below
node ad/scripts/original-game.mjs launch 00_Training.dx
node ad/scripts/capture-original.mjs   # Training, UNATCO HQ, Liberty Island stills
node ad/scripts/capture-intro.mjs      # 00_Intro stills from its CameraPoints
# browser runtime (dev server on 127.0.0.1:5173)
node ad/scripts/capture-browser.mjs stills
node ad/scripts/capture-browser.mjs clips
node ad/scripts/prepare-assets.mjs     # graded stills -> ad/build/assets
node ad/scripts/music.mjs              # soundtrack -> ad/build/music.wav
node ad/scripts/render.mjs             # -> ad/out/deus-ex-browser-runtime.mp4
node ad/scripts/render.mjs --stills 12.5,45.6   # review frames -> ad/build/preview
```

The renderer is `ad/src/` (canvas 2D + a Three.js wireframe of Training's
original BSP from `reports/00_Training/world.obj`). `render.mjs` serves the
repo read-only on 127.0.0.1, steps `window.__video.renderFrame(t)` in headless
Chromium (Metal ANGLE) and pipes frames to ffmpeg.

## Original-game captures

- The game runs in the CrossOver bottle with `INI=DeusEx-ad.ini
  USERINI=User-ad.ini` copies (silent 1280×720 window, two extra bindings);
  the installed `DeusEx.ini`/`User.ini` are never modified.
- `tools/dxinput.c` posts window messages to `DeusEx.exe` inside the bottle
  (no memory access). UE1's WinDrv reads keys from messages, but its
  `GetKeyState` check releases posted keys at once, so held movement is
  replaced by `set ... Location/ViewRotation/Velocity` console commands.
- Frames are the game's own `Shot` bitmaps (numpad `*`). They hold the raw
  framebuffer, so `prepare-assets.mjs` applies the original D3D gamma ramp
  (Brightness 0.6 → exponent 1/1.5, docs/lighting.md). The browser captures use
  the viewer's default brightness 0.6, which applies the same curve.
- Ghost-camera shots use eye = Location + 40; the Training pairs line up
  exactly with the browser's reference camera at the same eye and rotator.
- `00_Intro` starts its conversation on the first frame and grabs the
  keyboard. `capture-intro.mjs` sets `LevelInfo.bPlayersOnly` *before*
  `open 00_Intro` (the class default carries into the new level), so the intro
  loads frozen; each shot uses a CameraPoint's own location and rotation.
  Frozen pawns never start an animation, so the stills hold every
  `ScriptedPawn` on a `BreatheLight` frame: they are the cinematic's camera
  placements, not frames of its animation.
- Force-killing `DeusEx.exe` triggers the "Recovery Mode" wizard on the next
  launch; `dxinput` action `button Run Deus Ex` dismisses it. Quit with the
  console command `exit` instead.

## Browser-runtime captures

`capture-browser.mjs` drives the dev server in headless Chromium. A virtual
clock replaces `requestAnimationFrame`/`performance.now`, so each 30 fps frame
advances Play by exactly two 1/60 s steps whatever the render speed. Each map
boots in a fresh page through a filtered `/__game__/manifest`.

Found while capturing (current working tree, not fixed here):
- Switching maps in one page (Training → Liberty Island) raises
  `NativeHeapError: Native heap object was freed` from `script-play-hud.mjs`
  while the old game's HUD snapshot is read, and the load never finishes.
- The keypad and DataCube previews do not open their windows when F is
  pressed: the keypad preview aims above the keypad (the frob trace misses),
  and the DataCube never becomes the frob target. Those clips are unused.
- Play is unavailable on Liberty Island and UNATCO HQ, so their actors are not
  posed or not shown; only original shots of those maps are used.

## Where the claims come from

Every number on screen is computed by `facts.mjs` or quoted from project
docs: git history (commits, days, lines added, per-day calendar), code counts
(`src/` lines, `scripts/validate-*`, `scripts/validate-native-*`,
`docs/*.md`), the `System/DeusEx.u` header, `DeusExMover.Frob` decoded with
`src/unreal/bytecode.mjs`, `checkMove` (0x103c3290) disassembled with
`tools/disasm-body.py`, its port in `src/runtime/script-pawn-nav.mjs`, and
README.md's measured comparisons (10,980 rays, 7,320 extent traces, 402
placement chains, 2,547 physics queries; 219/219 packages, 88 maps). The
`maxError 0` line refers to decoration rolling physics against the original
DLL.

## Soundtrack

`music.mjs` synthesizes everything (subtractive voices, drums, reverb,
ping-pong delay, look-ahead limiter; about −14 LUFS). The piece is written in
the spirit of the original's tracker-era score — D minor, 120 BPM, arpeggios,
breakbeat, orchestra stabs — with its own melody; it does not reproduce the
Deus Ex theme. Sound effects are placed on the video's cuts and typing.
