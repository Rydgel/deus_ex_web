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
identity against the original rasterizer is not established. Original 3D mesh
lighting also remains separate from this HUD work. Window audio requests are
recorded at their native call boundary until a playback backend is connected.

## Focused validation

`node scripts/validate-play-hud.mjs` exercises the live original HUD tree,
canonical root/HUD/key-ring identities, ten slots, AugLight, six live health
fields, damage flash, energy, compass, frob corners, original pickup-to-belt,
ActivateBelt/equip/put-away, ammo, log rows, reset, legacy InfoLink frame crops and
original bitmap-font glyph output. Native family layout, root tick, scene frame,
actor-reference and GC validators cover their translation boundaries against
the shipped DLL. Browser checks additionally cover native layout, pickup/belt
selection, frob brackets, ammo, log placement and shared dialogue behavior.
