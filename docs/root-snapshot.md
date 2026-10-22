# RootWindow.GenerateSnapshot (native 1524)

`native(1524) final function Texture GenerateSnapshot(optional bool bFilter)` is how the original keeps a picture of the game behind its
menus. Callers:

* `DeusExRootWindow.ShowSnapshot`, which `UIPauseGame` calls whenever the UI pauses the game (a menu, the inventory, any persona
  screen). It calls the native only when the player's `UIBackground` is 1; `System/User.ini` and `DefUser.ini` set 0 (Render 3D, the world
  keeps drawing behind the UI) and the Game options screen's UI Background choice (`MenuChoice_UIBackground`) offers Render 3D, Snapshot
  (1) and Black (2). With 1 the root stores the texture in `snapshot`, draws it as the raw background (`SetRawBackground(snapshot,
  colSnapshot)`, `SetRawBackgroundSize(snapshotWidth, snapshotHeight)`, `StretchRawBackground(True)`) and turns 3D rendering off
  (`EnableRendering(False)`) until `HideSnapshot`/`UnPauseGame`.
* `MenuScreenSaveGame.GenerateNewSnapShot` (`GenerateSnapshot(True)`, the save preview; with `UIBackground` 0 it needs the frame behind the screen, which the page keeps while any window holds the mouse: `display.keepFrame`).
* `DDeusExGameEngine::SaveGame` (`0x1000f3c5..0x1000f44f`) calls `XRootWindow::GenerateSnapshot` itself, with its SaveInfo's own texture (the body then reuses the texture instead of making one), after
  `SetSnapshotSize(160, 120)` on the player's root window: the picture in every `SaveInfo.dxs` ([travel](travel.md#savegame-in-full), [save storage](save-storage.md#writing-a-save)). Play makes it from the page's kept
  frame with the same pixel work (`snapshotGrey`) and returns the P8 indices to the simulation (a request flagged `deliver`, answered by the `snapshot` message).

## What the original does

The exec is Extension.dll `0x1003cf30` (registered cell `0x10098abc`); it passes no existing texture, `bFilter` (read and never used by the
method), and a zero colour flag to `XRootWindow::GenerateSnapshot` (`0x10039410`, `ret 0x10`):

1. `GRenderDevice->Viewport` (URenderDevice `+0x34`) gives SizeX and SizeY (`+0x78`, `+0x7c`); a buffer of SizeX * SizeY dwords is
   allocated (`GMalloc`) and filled by `URenderDevice::ReadPixels` (RenDev vtable `+0xa0`, D3DDrv `0x10007610`): the last frame, one dword
   a pixel, byte 0 blue, 1 green, 2 red.
2. A new `UTexture` subclass (Extension vtable `0x100613e8`, `0xc0` bytes, outer `GetTransientPackage()`) is made, its `+0x84` flag word gets
   `0x10`, and `Init(U, V)` (vtable `+0x64`) is called with the root's snapshot size (`SetSnapshotSize`, native 1523: `+0x738`, `+0x73c`)
   rounded up to powers of two (unsigned compares; 0 stays 0, above `0x10000` wraps to 0). The texture is 8-bit paletted (P8).
3. With the zero colour flag (the only one a script can pass) the palette is the grey ramp `(i, i, i, 255)`; `UTexture::CreateColorRange`
   runs and `MaxColor` is set to white.
4. Pixels: the exec steps two float32 accumulators `srcX`, `srcY` by `stepX = SizeX / snapW` and `stepY = SizeY / snapH` over the frame
   and, for each destination pixel `(x, y)` with `x < snapW` and `y < snapH`, averages the source pixels `(trunc(srcX) + dx, trunc(srcY) + dy)`
   for `dx < stepX`, `dy < stepY` that lie inside the frame. Each channel total is the sum of `byte * (1/255)`, the double at `0x1005e3c0`
   (the products and sums are exact: 49 odd bits); blue is scaled by the unrounded `1.0 / n` and green and red, stored to float32 first, by
   the float32 `1 / n`; each is multiplied by `256.0f`, stored to float32, reduced by `0.5f` and `fistp`ed (round to nearest even),
   clamped to 0..255. The byte stored in the texture is the integer third of the three channel bytes. The rest of the texture
   (past `snapW` x `snapH`) is whatever `Init` left (zero).

So the snapshot is a grey picture of the frame the player last saw, `snapshotWidth` x `snapshotHeight` of it, held as an object in the
script's `snapshot` variable until it is replaced or `CriticalDelete`d (Extension slot-3 destructor `0x1003d100`: `~UTexture`, then
`operator delete` of `0xc0` bytes).

## What Play does

* The pixel work is `src/runtime/script-root-snapshot.mjs` (`snapshotGrey`, `potCeiling`): the loops in doubles where float32 accumulators and
  exact integer sums make that equal to the x87, and the per-(sum, count) byte on the x87 helpers, memoised. It is shared by the page and
  the validators.
* The frame is the page's (the simulation worker has none). While the player's `UIBackground` is 1 the page copies each finished frame (the
  canvas after the display ramp) into a GPU texture (`src/viewer/frame-keeper.mjs`, one framebuffer copy a frame, nothing otherwise) and
  reads the kept frame back only when asked.
* Native 1524 (`W.snapshot.generate` in `script-window-host.mjs`, routed by the window-host natives) makes the texture object (class
  `Engine.Texture`, outer the transient package, vtable `0x100613e8`, `USize`/`VSize` the powers of two), registers a reference the HUD
  commands name (`snapshot:<serial>`) and puts a request (`serial`, sizes) into the frame snapshot's `display` state. The page, on the
  snapshot that carries the request and before it draws it, makes the grey image from its kept frame (`applySnapshotRequests` in
  `main.mjs`) and gives it to the HUD renderer (`setDynamicImage`); the HUD commands of that same snapshot draw it through the original
  `DrawRawBackground`/`DrawStretchedTexture`. The frame is the one before the pause, as in the original, because the page holds
  the previous frame until it draws the new snapshot's.
* `CriticalDelete(snapshot)` (native 751) frees the object and tells the page to drop the image.

## Checks

* `scripts/validate-root-snapshot.mjs`: the method runs unchanged in Unicorn (`native-root-snapshot-oracle.py`; the stand-ins are
  `ReadPixels`, `GMalloc`, the texture's `Init` and storage, `CreateColorRange`) against `snapshotGrey` on 131 synthetic frames (noise,
  small values, near-white, flat, black, white, gradients; frame and snapshot sizes from 1 x 1 up to 160 x 100, integer and fractional
  ratios, steps of 1.1 to 1.4 where the float32 accumulators land near whole pixels, up- and down-scaling, a zero snapshot size): the
  P8 bytes, the grey palette, `Init(U, V)` and `MaxColor` are identical (about three minutes in Unicorn). Of eight planted mutations five
  are killed (the integer third, the float32 store of green and red's total, the box bound, both float32 accumulators); the three
  survivors are equivalent: blue's extended path and green/red's float32 path give the same byte for every
  pair (sum, n) with n up to 16 (computed exhaustively), so swapping the channels or rounding blue's `1 / n` changes nothing, and
  `Math.round` against round-to-nearest-even differs only at a tie, which `(float32 - 0.5)` reaches only at the clamped ends.
* `scripts/validate-root-snapshot-play.mjs` (Node, 00_Training): with `UIBackground` 1 the main menu's pause calls the native, whose texture the
  root draws (a HUD command naming the snapshot, at the powers of two).
* `scripts/validate-root-snapshot-browser.mjs` (headless Chromium, default start): the setting on, 00_Training, Escape: the menu draws over a
  grey picture of the frame, no runtime error, and a second pause makes a new one.

## Not measured

* `ReadPixels` reads a 16-bit DirectDraw surface (the installed `ColorDepth`/`FullscreenColorBits` are 16) and, with `UseGammaCorrection`,
  maps each channel through a 256-entry gamma table before the dwords are made (D3DDrv `0x10007610`). The page's frame is 8 bits per channel
  as displayed (after the display ramp, with the CRT effect if it is on); the 5-6-5 quantisation and the table are not modelled, so the grey
  values can differ from the original's by a few levels.
* `UTexture::CreateColorRange` is not run (the texture's colour-range fields are read by no shipped script), and `MaxColor` is not written.
* The colour-flag path (a non-zero third argument builds a quantised palette) is not reached by any script and is not translated.
* The first frame after the setting is turned on has no kept frame yet: the snapshot is black.
