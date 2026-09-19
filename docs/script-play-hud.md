# Visible single-player HUD bridge

## Original contract (recorded before the browser integration)

The authority is the installed `DeusEx.u` / `Extension.u` embedded source and
bytecode, not a recreated HUD design. The relevant TextBuffers are local-only
under `.cache/reference/`: `HUDHitDisplay`, `HUDCompassDisplay`, `HUDBaseWindow`,
`ProgressBarWindow`, `Crosshair`, `Window`, and `DeusExHUD`.

* `HUDHitDisplay.InitWindow` creates an 84×106 display. Six translucent body
  pieces use the original textures and configurations (head 39,17,4,7;
  torso 36,25,10,23; left/right arms 46/26,27,10,23; left/right legs
  41/33,44,8,36). The white body outline is lowered behind those pieces.
  Energy and breath bars are 5×55 at (15,20) and (61,20).
* `SetHitColor` owns the 0.4-second damage flash, 1-second healing transition,
  and 0.5-second refresh. `Window.GetColorScaled` has strict thresholds
  0.80, 0.40, 0.10, and zero. Run these original functions, including the
  VM's float/int/byte conversions, instead of copying their color arithmetic.
* `ProgressBarWindow` owns value clamping, integer bar height, and color.
  `HUDHitDisplay.Tick` reads the live player's six health fields, Energy,
  EnergyMax and HeadRegion; it shows the breath bar only underwater.
* `HUDCompassDisplay` is 73×40. A 55×22 clip at (13,7) contains two
  240×15 copies of `HUDCompassTicks`. The installed Tick reads actor Rotation
  and map TrueNorth, masks to 65535, and wraps the two strips. The bytecode uses float division for
  `65536 / tickWidth`; float32 storage and truncation of drawPos are significant. At unchanged initial yaw zero,
  the original Tick intentionally leaves both strips at their initial position.
* `DeusExHUD.ConfigurationChanged` places health at (0,0), compass at
  (0,hitHeight+4), and the crosshair at (viewport-size)/2+0.5.
* `HUDBaseWindow.StyleChanged` reads the selected original theme and the
  player border/background translucency flags. DrawBackground/DrawBorder
  supply their own original texture crops; there is no replacement frame art.

The previously recovered Window setters/constructor, GC tile source extents,
clipping, color factors, and translucent/masked flags provide native evidence:
[Window construction](script-window-construction.md),
[GC drawing](script-gc-draw-model.md), [GC state](script-gc-state.md).
Browser compositing is a presentation adapter. Full native HUD allocation,
layout/focus/GC ownership and original-renderer pixel equivalence are not
established by this bridge. Only the named HUD subset is admitted; inventory,
weapon selection, other HUD windows and configurable root scaling remain open.

## Browser result and remaining boundaries

Play now executes the installed InitWindow, SetHitColor, ProgressBarWindow and
compass Tick bodies. The bridge constructs native Window storage using the
existing constructor, binds script width/height to native setter storage, and
adapts NewChild/Lower to a presentation-owned child list. Map north is supplied
from the original map actor. That child list is not the complete native focus,
layout, destruction or GC graph. The selected HUD panels are enabled by the
browser; importing the user's original HUD visibility configuration is still open.

The final tile sink uses the same WebGL context as the world. All HUD tiles stay
in one ordered render list: translucent background/frame first, then opaque
portraits and masked glyphs. Source pixels and crops are preserved. The browser
currently uses one logical HUD pixel per CSS pixel; original root multipliers
and configuration-dependent scaling remain open.

InfoLink no longer has a CSS replacement frame or system-font text. Its original
DrawBackground/DrawBorder bytecode emits two 256/175-wide texture pieces for each
layer, at height 114. DeusExHUD's no-visible-log placement is (hitWidth+20,0).
The runtime's current transmission supplies its own portrait, icon and text.
The three bitmap fonts are FontTiny, FontMenuHeaders_DS and
FontFixedWidthSmall_DS. The renderer uses the already DLL-compared GC.DrawText
body, including its scan, wrap, alignment, clipping, glyph coordinates, texture
cache and PushGC/PopGC. This is a presentation bridge for ComputerWindow's text;
its native cursor/fade/static-noise rasterization remains open. Exact whole-HUD
pixel equivalence against the original renderer is not claimed.

### Newly resolved native boundaries

`Window.SetConfiguration` native 1430: the exec at 0x10051fe0 marshals four
floats and calls 0x1004cd40; the exported wrapper at 0x10003330 calls the same
body. It clamps negative/unordered sizes, compares alignment then x/y/w/h,
clears both alignment bytes, writes all four fields, and calls
AskParentForReconfigure once. Ten original DLL cases compare all 512 object
bytes and call counts, including unchanged, either position or size changed,
alignment reset, negative sizes, NaN and negative zero.

`UFont::Serialize` 0x10385400 calls the page-array helper at 0x10385680.
The page helper 0x10385940 calls archive UObject-reference slot +0x18 for the
texture, followed by the glyph-array serializer. This resolves the formerly
opaque four-byte page header in the three selected fonts as a compact texture
reference followed by a compact glyph count. The glyph records and final
charsPerPage are checked against the existing decoded metrics, and each page
loads through its actual package reference.

Focused checks:

    node scripts/validate-window-configuration.mjs
    node scripts/validate-play-hud.mjs

The HUD check exercises source-owned initialization/draw crops, live six-part
health and its damage flash, energy, compass, reset, and the actual bitmap font
page at the recovered glyph-render boundary. Browser checks cover normal
walking, door use, successive transmissions, turning, Inspect and map changes.
