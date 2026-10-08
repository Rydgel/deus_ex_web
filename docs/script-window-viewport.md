# ViewportWindow (XViewportWindow)

The Extension window that draws the world from an actor or a location into its
rectangle. Security computers use three of them (ComputerSecurityCameraWindow,
one per camera view); the spy drone and the scope/targeting views use the same
class. This note covers the window's own bodies and natives, and the camera
pass that draws the world into the rectangle ("Camera pass" below, with its
unsupported parts).

Authority: installed Extension.dll (SHA-256 `93c35502…8b916d9c`, preferred
base 0x10000000), Engine.dll for APlayerPawn's view list, the DX SDK 1112f
`ExtViewport.h` layout, and Extension.u `ViewportWindow.uc`.

## Storage

Registration size 0x1b4, vtable 0x1005be08.

| Offset | Field |
| --- | --- |
| +0x14c | flags: 1 bEnableViewport, 2 bClearZ, 4 bShowActor, 8 bShowWeapons, 0x10 bUseViewRotation, 0x20 bUseEyeHeight, 0x40 bWatchEyeHeight |
| +0x150 | fov (float) |
| +0x154 | defaultTexture |
| +0x158 | defaultColor (RGBA) |
| +0x15c / +0x160 | originActor / watchActor |
| +0x164 / +0x170 | location / relLocation |
| +0x17c / +0x188 | rotation / relRotation |
| +0x194 | private bOriginActorDestroyed (bit 0) |
| +0x198 / +0x1a4 | lastLocation / lastRotation |
| +0x1b0 | viewportFrame (the FSceneNode that Draw creates and PostDraw finishes) |

## Bodies

`src/runtime/script-window-viewport.mjs` translates each body below.

- Constructor 0x10018af0: UObject, XExtensionObject vtable, XClipRect zeroed, then the viewport vtable.
- Init 0x10049f10: XWindow::Init; clears bDrawRawBackground; sets flags enable,
  clearZ, useViewRotation, useEyeHeight and watchEyeHeight, and clears
  showActor and showWeapons; fov 90; defaultColor black, with an alpha byte
  equal to the high byte of the parent argument slot (a stale stack byte);
  clears every vector, rotator and actor; then
  `SetViewportActor(GetPlayerPawn(), TRUE, TRUE)`.
- CleanUp 0x1004a070: `SetViewportActor(NULL, TRUE, TRUE)`, then XWindow::CleanUp.
- SetViewportActor 0x1004a170: flags enable and useEyeHeight come from the
  arguments. Location and relLocation are cleared. If the origin changes, the
  player's `RemoveAdditionalView(old)` runs (vtable +0xb0), then
  `AddAdditionalView(new)` (vtable +0xac) unless the new origin is the player.
  The window then adds an actor reference to the new origin and removes the
  old one. lastLocation becomes the origin's Location, or the window's
  location when there is no origin.
- SetViewportLocation 0x1004a300: sets the enable flag, location and relLocation (zero); drops the origin reference; lastLocation = location.
- SetWatchActor 0x1004a400: sets the watchEyeHeight flag and clears both
  rotators. It swaps the watch reference. lastRotation is the look-at rotation
  from lastLocation, computed by Core's FVector::Rotation, or the window's
  rotation when there is no watch actor.
- SetRotation 0x1004a570: rotation, relRotation zero, drops the watch reference, lastRotation = rotation.
- SetFOVAngle 0x1004a660: values above 179.0f become 179.0f; values below
  double 0.1, and NaN (C0 set), become 0.1f.
- Natives 1945–1956: exec wrappers checked by the common exec-body harness
  (`validate-window-native-diff.mjs`). They cover EnableViewport,
  SetFOVAngle, ShowViewportActor, ShowWeapons, SetRelativeLocation,
  SetRelativeRotation, SetDefaultTexture and ClearZBuffer.
  - SetDefaultTexture's omitted colour is white (255,255,255). Its alpha is
    the high byte of an FFrame pointer, which is modelled as 0.
- Draw 0x1004a770:
  1. Origin and watch validity go through IsActorValid. A destroyed origin
     leaves the last frame in location/rotation and sets the private flag. A
     destroyed watch actor leaves lastRotation as the rotation.
  2. The frame position is the origin's Location. A Pawn origin with
     bUseEyeHeight adds EyeHeight.
  3. The frame rotation is the origin's Rotation. A PlayerPawn origin with
     bUseViewRotation uses ViewRotation instead.
  4. relLocation is applied as its length along `relLocation.Rotation() +
     rotation`, using the X axis of `GMath.UnitCoords / R`.
  5. A watch actor replaces the rotation with a look-at rotation, using the
     watch actor's eye height when bWatchEyeHeight is set. relRotation is
     then added.
  6. The script event CalcView (vtable +0x11c) runs. Its outputs become the
     frame and are stored as lastLocation/lastRotation.
  7. The renderer is `player.XLevel->Engine->Render`. CreateMasterFrame
     (+0x64) is called with the canvas viewport. The frame's
     XB/YB/X/Y are `ftol((clip + origin) * root multiplier)`, offset by any
     current canvas frame's XB/YB.
  8. The player's bBehindView is set unless bShowWeapons is set and the
     origin is the player. The player's FovAngle becomes the window's fov
     (as raw dwords). The origin's bHidden is set unless bShowActor.
  9. ComputeRenderSize runs. Canvas X/Y/ClipX/ClipY/Frame are switched to
     the frame. ClearZ (RenDev +0x90) runs if bClearZ, then RenderFrame
     calls Render->DrawWorld (+0x70).
  10. Every saved value is restored in reverse order.
  11. With no renderer, no canvas viewport, no frame, an empty size, or a
      disabled viewport, the fallback runs instead: PushGC, SetStyle(1),
      SetTileColor(defaultColor),
      `DrawPattern(0, 0, width, height, 0, 0, defaultTexture)`, PopGC.
      XWindow::Draw always follows.
- PostDraw 0x1004af20: XWindow::PostDraw, then FinishMasterFrame (+0x6c) if a frame exists.
- ConvertVectorToCoordinates 0x1004afc0: projects a point through the frame's
  Coords and FX2/FY2/projection, without the root multipliers. With no frame it
  hits assertion line 0x2cf, which we raise as an error.
- Engine APlayerPawn::AddAdditionalView 0x103ba540 /
  RemoveAdditionalView 0x103ba4c0 work on AdditionalViews[3] at +0x6a8:
  - Add stores the actor in the first empty slot. A null actor counts as
    success.
  - Remove clears the first match and shifts the later slots down. It does
    not clear the last slot.

## Reference cases

`scripts/native-window-viewport-oracle.py` runs the unchanged bodies under
Unicorn, with Extension rebased to 0x12000000 and Core/Engine at their native
bases. The XWindow/XGC leaves, render services and the CalcView event are
recorded host events. GMath is built by its own FGlobalMath constructor.
`scripts/validate-window-viewport-diff.mjs` replays the same steps through the
translation and compares every viewport field, the actor fields Draw saves and
restores, the reference table, AdditionalViews, the canvas, and the ordered
events.

Result: 18 cases and 97 steps are identical, and 10/10 mutations are detected.

- The cases cover Init, origin changes, player and pawn origins (view
  rotation, eye height, weapons), relative location and rotation, watch
  look-at and SetRotation, a destroyed origin and watch, the AdditionalViews
  shift, a CalcView override, the canvas-frame offset, and each fallback
  (disabled, no renderer, no canvas viewport, no frame, zero size).
- They also cover the FOV clamps, CleanUp, and projection both through a
  frame and without one.
- Default-colour alpha is a stale stack byte (the parent pointer's high
  byte), so it is compared as `parentHigh:rgb`.

## Play wiring

The window host admits `extension.viewportwindow` (construct, Init, CleanUp,
Draw, PostDraw, ConvertVectorToCoordinates, natives 1940–1943 and 1945–1956,
and member cleanup on destroy).

The render services are Play's:

- CreateMasterFrame allocates a heap scene node. ComputeRenderSize writes it
  with the recovered scene-frame translation (`writeWindowSceneFrame`), using
  the viewer's FovAngle while Draw holds the window's fov there.
- DrawWorld queues a `viewport` draw command in window order. The command
  holds the rectangle, location, rotation, fov, clearZ, the hidden origin,
  bBehindView and the frame's plan (below).

`AdditionalViews` is replicated. PlayerPawn.uc describes it as other actors
"the pawn can see from the point of view of". Its readers in Engine.dll
(network relevancy) are not traced. Play does not use it for rendering.

## Camera pass

### Original evidence

- **RenderFrame** (`0x1004b260`) calls `Render->DrawWorld(frame)` (vslot
  0x70) when the frame's X and Y are positive. It does nothing else.
- **DrawWorld** (Render.dll `0x10b1cb90`, see
  [bsp-occlusion.md](bsp-occlusion.md) "Call order") works the same on the
  window's master frame as on the player's. In order, it:
  1. increments the frame counter;
  2. runs OccludeFrame: SetupDynamics, OccludeBsp, dynamic lights and the
     child frames;
  3. runs DrawFrame;
  4. clears Z and calls the viewing actor's RenderOverlays, but only when it
     has a Target ([script-weapon-rendering.md](script-weapon-rendering.md)).
- **Why Draw sets bBehindView.** With bBehindView set, Target is None, so a
  camera view draws no weapon overlay. The flag also stops the level-actor
  pass from excluding the player, so JC is drawn in the view.
- **The origin is not drawn**, because Draw sets its bHidden.
- **Placement.** The view draws inside PostRender's window paint, after
  ClearZ, over whatever the HUD drew before it. The window draws after it
  then cover it.

### Play

**Planning.** The window host calls `viewportPlanner` (sim-session.mjs
`planViewportPass`) inside its DrawWorld service, while Draw holds the flags.
In the worker this:

- increments DrawWorld's frame counter;
- runs OccludeBsp from a master frame at the camera's location, rotation and
  fov, at the window's size. Its drawn polygons and tracked movers are kept,
  and the sky frame when OccludeBsp makes one. The moving brush tracker is
  not updated again: the main frame's update stands, as the original updates
  it on the game thread when a mover moves, not in a DrawWorld.
- runs inside the HUD paint, so at the render pass's x87 precision control
  24 (render-precision.mjs): CreateMasterFrame for this frame (occlude.rs,
  the x87.rs model) rounds at 24 bits, where the main frame's, built before
  URender::PreRender, rounds at 64. That follows where XViewportWindow::Draw
  runs. The frame is CreateMasterFrame on the main viewport's size (the
  screen span) and Draw's ComputeRenderSize at 24 bits on the window's rectangle
  ([the 3D frame's projection](render-pass-precision.md#the-3d-frames-projection-2026-10-08));
  validate-bsp-occlusion's `masterControlWord` 0x007f cases run both against
  the unchanged original (the tangent is the FPTAN model's, measured on
  hardware for FOV 75 and 90). Draw itself was not run.
- runs SetupDynamics' candidates for that frame (the actor layer's
  bindings and iterator items, and the sprite records, read live under Draw's
  flags: the camera hidden, the owner-see rules following bBehindView) through
  the same Setup path as the main frame, and OccludeBsp returns the frame's
  Frame->Sprite keys. The decal block is off. On the GPU path the actor layer
  also asks which groups the camera's frustum keeps.
- writes LastRenderTime (DrawActorSprite's render feedback) for exactly
  the Frame->Sprite actors and sprites, whether three.js then culls them or
  not; an actor in the camera's cone but occluded or out of range is not
  stamped.

**Posing.** The actor layer poses the actors the previous HUD frame's camera
Frame->Sprite held (and mirror children's ids) as child-only. Posing every
admitted actor in the map instead made each frame minutes long on Island
(the "8 minutes to the first poll" of the earlier WIP: all actors posed and
lit); that is the cause of the slowness, measured by the stall's return when
the Set was widened to every actor.

**Drawing.** The page's HUD renderer splits its frame at each `viewport`
command. `main.mjs` `viewportWorldPass`:

- clears Z;
- draws the sky frame;
- selects OccludeBsp's polygons and applies the actor decisions;
- renders the scene from the camera into the window's rectangle (viewport
  and scissor);

then the HUD draws continue.

**Light maps.** The light maps of the camera frame's OccludeBsp polygons
are animated and relit with the main frame's. When the main frame lists no
polygons, the light maps in the main frustum or a camera's frustum are.

**Check.** `scripts/validate-terminals-camera-browser.mjs` runs in the
default worker mode. On Island it:

- frobs ComputerSecurity1 with the page's right click;
- types the login on the keyboard;
- reads the plan through the worker-side terminal probe
  (`terminal-probe.mjs`): one frame from SecurityCamera5, OccludeBsp nodes,
  and the camera absent from its actors;
- reads the page's pass: the same rectangle, with draw calls;
- checks the plan's location and rotation equal SecurityCamera5's, and
  its FOV is the window's;
- checks the stamped set is the frame's Frame->Sprite actors: of 82 mesh
  actors inside SecurityCamera5's view cone on Island, 72 (behind walls or
  beyond the room) are not in it and keep their LastRenderTime;
- checks that the rectangle's image varies, and the plan's own cost.

Measured on the Linux host (headless SwiftShader, worker mode): the camera
frame plans in about 2 ms and frames stay at about 16 ms; the first poll after
the login arrives within seconds. The earlier WIP reached it after about 8
minutes: it passed `children: true` to the actor layer while a camera view was
on, which poses (and lights) every admitted actor in the map each frame. That
is reproduced by restoring that value (the check then runs past 100 s), and
removed by posing only the camera's Frame->Sprite ids.

The image has not been compared with an original frame.

### Unsupported or approximate (explicit)

- The decal block: decals are not drawn in camera views.
- Mirror child frames inside a camera view (Play's mirror child frames, from
  master, are not run for the camera frame).
- Coronas.
- Per-frame mesh lighting: the camera view reuses the main frame's colours.
- Fog maps: the main frame's.
- The first HUD frame of a camera view (and a frame whose Frame->Sprite adds
  an actor the previous one lacked) lacks the actors outside the main
  frame, because posing follows the previous HUD frame.

Reproduce:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-viewport-diff.mjs`
- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-native-diff.mjs`
- `node scripts/validate-terminals-play.mjs --map 01_NYC_UNATCOIsland --terminal ComputerSecurity1`
  (the security screen end to end, headless)
- `node scripts/validate-terminals-camera-browser.mjs [--shot camera.png]` (the camera pass)

## Handoff: the camera frame as a full root frame (WIP, 2026-10-08, paused)

No code changed yet. Verified: nothing new (the baseline
`validate-terminals-camera-browser` run was stopped before it reported).
Original evidence read: `URender::DrawWorld` (`0x10b1cb90`) pushes the same
frame for OccludeFrame (`0x10b1ce3b`) and DrawFrame (`0x10b1ce44`), so the
mirror and sky child frames, SetupDynamics per frame, decals, fog and coronas
are the generic per-frame passes for a ViewportWindow's master frame too.
Reads of the real viewport still apply: the corona pass takes the viewport
actor's (the player's) leaf lights, line-checks them to the camera frame's
origin, shares the one 32-entry corona cache and clock with the main frame's
pass, and runs only for `Recursion` 0 (the camera frame is). RenderOverlays
needs a Target (none with bBehindView).

Next step (plan, not done):
1. Sim side (`src/viewer/sim-session.mjs` `planViewportPass`): call
   `visibility(...)` with `children`/`frameDynamics` so the camera frame gets
   mirror and sky child frames (return `frames`), then reuse `stamps()`'s
   pass logic (`drawn.passes({camera: viewportCamera, frames, rect})`,
   `actorScene.framePasses`) generalized to take a camera and frame list;
   light and LOD each drawn binding per camera frame (`lightFramesOf`,
   `lodFramesOf`, `meshLighting.childFrame`) and add a root-frame lighting
   context from the camera's master words; fix first-HUD-frame posing
   (`viewportIds` follows the previous HUD frame).
2. Page side (`src/viewer/main.mjs` `viewportWorldPass`): run
   `world.mirrors.render(renderer, scene, viewportCamera, {frames, rect,
   framePass, skyIn, updateActors})` before the camera's render, per-frame fog
   (`world.fog.update` with the camera's Coords) and the decal and corona
   passes, mirroring `drawFrame`'s main block; consider factoring that block
   into one function used for both.
3. Verify in worker mode: extend `validate-terminals-camera-browser`
   (lit actors equal SetupForActor on the camera frame's inputs; find a
   camera that sees a mirror, decal or corona, or build a fixture), then
   `validate-terminals-play`, `validate-window-viewport-diff`,
   `validate-mirrors-play`, `validate-gpu-mesh`, `npm test`, and an
   interleaved A/B of the cost with the camera window open.
Setup done in this worktree: branch at master `e70fd64`, wasm rebuilt.
