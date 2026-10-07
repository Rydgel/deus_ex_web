# ViewportWindow (XViewportWindow)

The Extension window that draws the world from an actor or a location into its
rectangle. Security computers use three of them (ComputerSecurityCameraWindow,
one per camera view); the spy drone and the scope/targeting views use the same
class. This note covers the window's own bodies and natives. The page-side
camera pass that draws the world into the rectangle is a separate step and is
**not implemented yet** (see "Play wiring" below).

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

The render services are Play's, and the following is the part that is
**unsupported**:

- CreateMasterFrame allocates a heap scene node. ComputeRenderSize writes it
  with the recovered scene-frame translation (`writeWindowSceneFrame`), using
  the viewer's FovAngle while Draw holds the window's fov there.
- DrawWorld queues a `viewport` draw command in window order. The command
  holds the rectangle, location, rotation, fov, clearZ, the hidden origin and
  bBehindView.
- `sim-session` passes the command to the page. `hud.mjs` currently skips it.
  The second camera pass that renders the world into that rectangle (camera
  occlusion, per-pass actor visibility, hiding the origin, fov) is **not
  implemented**. Camera windows therefore show no world image yet.
- URender::DrawWorld's own work for an additional view has not been traced
  either (beyond the AdditionalViews list it uses for visibility).

Reproduce:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-viewport-diff.mjs`
- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-native-diff.mjs`
- `node scripts/validate-terminals-play.mjs --map 01_NYC_UNATCOIsland --terminal ComputerSecurity1`
  (the security screen constructs its three camera windows and then stops at
  the pan slider's ScaleManager native).
