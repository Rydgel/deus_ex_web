# Original Play HUD

Play constructs the installed `DeusExRootWindow` and `DeusExHUD` through their
original `InitWindow` bytecode. The shared native window host supplies the
recovered Extension family constructors, initialization, preferred sizes,
configuration, tree tick and GC drawing. The runtime uses one canonical
`player.rootWindow` and HUD for inventory, messages, InfoLink and ConPlay.

The authority is the installed `DeusEx.u` / `Extension.u` embedded source and
bytecode, plus `Extension.dll` and `Engine.dll` instructions. Extracted source,
binaries and captures remain local and ignored. See [host evidence](script-window-host.md),
[GC drawing](script-gc-draw-model.md), [root tick](script-window-root-tick.md),
[projection](script-window-scene-frame.md), and [input queries](script-input-console.md).

## Original behavior

- `DeusExHUD.InitWindow` creates ammo, hit, crosshair, object belt, active items,
  damage, compass, multiplayer skills, information, log, frob, augmentation,
  mission text, bark and received-item windows. `ConfigurationChanged` places
  these windows; the browser does not reproduce that layout with constants.
- `HUDObjectBelt` creates its ten slots with the original RadioBox/Tile families,
  including `ORDER_LeftThenUp`. `CreateNanoKeySlot` uses slot zero. Subsequent
  pickups enter through `DeusExPlayer.AddInventory` → root `AddInventory` →
  `AddObjectToBelt`. Digit keys run `DeusExPlayer.ActivateBelt N`, matching
  User.ini. The original root passes the slot item directly to PutInHand:
  repeating a populated slot retains that item; selecting an empty slot
  requests None and puts the held item away. The
  existing player scheduler now calls `UpdateInHand` before movement: original
  `PlayerWalking.PlayerTick` calls it through `MultiplayerTick` (which also
  serves single player) before `Super.PlayerTick`. This resumes the hand
  transition without manually advancing the weapon state machine. Other
  unrecovered PlayerTick effects remain separate boundaries.
- Original hit/compass/ammo ticks read the live player and weapon. The original
  health flash, energy and breath bars, compass wrapping, ammo labels and belt
  selection draw through their own windows. `AugmentationManager.RefreshAugDisplay`
  resumes the original post-root initialization step, including the possessed
  AugLight icon under the installed `bHUDShowAllAugs` preference.
- Frob brackets use original `FrobDisplayWindow.DrawWindow`, original window
  world-to-screen conversion and an Engine scene frame populated with the
  same camera origin, rotator and horizontal FOV as Play. The renderer currently
  uses 75 degrees; the scene-frame module records its admitted FOVs.
- HUD visibility, theme, border/background translucency, ammo format and log
  settings read the supplied User.ini/DefUser.ini scalar values. A missing
  scalar retains the compiled class default. Original theme-manager functions
  select the colors and textures.
- The native root chooses integer horizontal/vertical multipliers from the
  physical drawing-buffer size using the original 640×480 threshold math.
  Native GC clipping, glyphs, texture extents, colors and command order feed
  the Three.js compositor. No separate in-hand icon is drawn.

## Explicit remaining boundaries

Multiplayer is deferred by user request. `ConditionalBindMultiplayerKeys`,
called by root initialization even in single player, is an explicit recorded
boundary; it does not modify bindings or block the Training HUD.

InfoLink and ConPlay keep their existing specialized presentation and lifecycle
owners. Their frame adapter reads requested SetSize dimensions at +0x9c/+0xa0;
their partial layout does not populate the configured +0x80/+0x84 dimensions.
General HUD windows read configured dimensions through native field bindings.
They share the real root, HUD and byte heap; their delegated subtrees
are excluded from general tree layout/tick/draw/readiness to avoid applying two
owners to them. Native ComputerWindow cursor, fade and static interference are
not completed by this change. Received-item presentation retains its previously
recorded boundary. General window destruction, active focus navigation,
window timers, menus, cursor rendering and debug overlays remain unsupported
when reached. These are explicit errors, not silent substitute behavior.

The final WebGL tile compositor is a browser adapter. Whole-renderer pixel
identity against the original rasterizer is not established in general; for
the interface it is measured since 2026-10-15 ([interface frames](interface-frames.md)):
18 views of 00_Training (the HUD with its belt, log and the log's timeout, eight
persona screens, the main menu and three Settings screens, a datacube's
information display and the keypad) are within 2 of 255 of the original's frames
at every pixel but one scanline of the world, after two fixes the frames found
(GC's authored underline texture, and window ticks on real time rather than the
level's dilated delta). Original 3D mesh lighting also remains separate from
this HUD work. Window audio requests are recorded at their native call boundary
until a playback backend is connected.

## Actor draws in the HUD

The vision augmentation and the developer ActorDisplayWindow draw meshes from
`DrawWindow` through `GC.DrawActor` (1288) and clear depth with `GC.ClearZ`
(1295). The host queues `actor` and `clearZ` commands among the tile commands,
in window order; the page draws the actor between the tile batches in the
master frame. Evidence, the oracle and what is unsupported (bConstrain,
non-mesh DrawTypes, no original-frame comparison):
[gc-draw-actor.md](gc-draw-actor.md).

## Compositor batching boundary

The recovered native GC and Window traversal determine the ordered tile/glyph
command stream; the compositor must retain its texture, draw style, clipping,
source extents, tint and triangle order. A consecutive run of commands using
the same GPU material can share one vertex buffer and submission: depth tests
and writes are disabled for every HUD material, and the ordered triangles use
the same blend factors. A material change ends the run, including a return to
an earlier texture after an intervening command. No window script or GC command
is skipped or cached. This is a host submission change, not a change to native
window behavior or evidence of original rasterizer pixel identity.

`node --test test/hud-compositor.test.mjs` compares the emitted Float32
positions, UVs and tints and ordered styles against the previous individual
tile adapter, including clipping, texture changes, overlapping blend styles,
buffer growth and reuse. The original-window integration validator below
continues to cover the command source.

An isolated Chromium/Metal render comparison against the individual-tile
adapter at `1a17e36` found no differences across 1,536,000 RGBA channels in five
320×240 frames. The frames cover masked, opaque, translucent and modulated
styles, overlapping tiles, clipping, interleaved materials, empty output and
buffer reuse/growth. A 151-command fixture became three submissions and a
257-command glyph run became one; a 90-command interleaved-material fixture
retained all 90 submissions. Local check sources are `.work/hud-pixels.mjs`
and `.work/hud-reference.mjs`, outside Git. This is adapter equivalence,
not an additional claim about the original rasterizer.

## Modulated tiles (2026-10-30)

A DSTY_Modulated tile ignores the GC's tile color and is masked. Deus Ex's `D3DDrv.dll` `UD3DRenderDevice::DrawTile` (body
`0x10005ba0`, vtable `0x10018004` slot `0x7c`, thunk `0x10001172`) replaces the PolyFlags of a `PF_Modulated` tile with `0x42`
(PF_Modulated|PF_Masked, at `0x10005c27`) before `SetBlending` (`0x10008270`: DESTCOLOR/SRCCOLOR blending, and ALPHATESTENABLE
from the PF_Masked bit), and writes the vertex color `0xffffffff` for it (`0x10005c5c` to `0x10005c9d`); only the other styles take
`Color * MaxColor | 0xff000000`. `hud.mjs` does the same: a style 4 tile draws with a white tint and discards the index-zero texels
(the masked style's shader).

The page multiplied modulated tiles by the tile color. `DeusExScopeView.DrawWindow` sets the tile color to 0,0,0 for its black
borders and then draws `HUDScopeView` (or the binoculars' `HUDBinocularView_1`/`_2`) modulated, so every scope view (the rifle, any
weapon with a scope mod: the pistol, stealth pistol, mini-crossbow, plasma rifle and GEP gun, ScopeFOV 10 to 25) and the binoculars
were black: a 2·src·dst tile with a black source. It was so before the live-heap work (`89bd1edd` too). Other modulated draws drawn
after a non-white tile color change with it: the vision augmentation's tints (`DrawVisionAugmentation` sets no tile color of its
own), the frob display's backgrounds (`colBackground`, `colText`) and the credits' background (`colBlack`).

`node scripts/validate-scope-view-play.mjs` (worker mode, 00_Training, `?loadout=1`): belt 5 draws the rifle, `[` (ToggleScope) zooms
it, and the lens centre shows the world while the screen outside it is black (it fails on the old tiles, lens mean 0).
`test/hud-compositor.test.mjs` checks the white tint and the masked shader of a style 4 tile after a black tile color. Not
compared with the original's pixels: the binoculars, the scope mods and the other windows above.

## Focused validation

`node scripts/validate-play-hud.mjs` exercises the live original HUD tree,
canonical root/HUD/key-ring identities, ten slots, AugLight, six live health
fields, damage flash, energy, compass, frob corners, original pickup-to-belt,
ActivateBelt/equip/put-away, ammo, log rows, reset, legacy InfoLink frame crops and
original bitmap-font glyph output. Native family layout, root tick, scene frame,
actor-reference and GC validators cover their translation boundaries against
the shipped DLL. Browser checks additionally cover native layout, pickup/belt
selection, frob brackets, ammo, log placement and shared dialogue behavior.

## What a paint costs (2026-11-05)

One HUD paint runs about 95 original script events a frame over about 46 windows (70 of them `Extension.Window`'s empty DrawWindow
and PostDrawWindow), then the console's PostRender. In Node the events take about 0.65 ms on the Island; the paint is 1.7 to 2.3 ms in
Firefox (`w.hud`), against Chrome's 1.0 to 1.3. The cost is a flat spread over the Rust VM's JavaScript callbacks (`DrawText`, the
`DrawTargetAugmentation` call, window field reads), the JavaScript around each event, and the window tree's native-heap access; no
part is 0.5 ms. The split, the profiles and the parts a port could take are in
[Firefox at 60 fps](firefox-60fps-plan.md#the-hud-phase-2026-11-05); `scripts/hud-census.mjs` prints a paint's events and
fallbacks. The events themselves are unchanged: none is skipped, reordered or cached.
