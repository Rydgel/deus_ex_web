# XWindow BoundsUpdate / SortWindowLists — the ConfigureChild leaves

`XWindow::ConfigureChild` (see [script-window-configure-child.md](script-window-configure-child.md))
runs two conditional leaves once it has stored a window's new geometry and the
configure depth is 1 (or the `+0x28` window type is ≥ 1). Both were previously
unprovided boundaries; enabling `DeusExPlayer.bSubtitles` reached the first one
as `XWindow::ConfigureChild requires boundsUpdate service`, because the
first-person conversation panel's reconfigure calls `ConfigureChild` on the
visible `HUDConWindowFirst`. This records the recovered bodies.

Evidence: `Extension.dll` SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`. Translation
in `src/runtime/script-window-bounds-update.mjs`; bit-exact comparison against the
unchanged DLL executed under Unicorn in
`scripts/native-window-bounds-update-oracle.py`, driven by
`scripts/validate-window-bounds-update.mjs`.

## BoundsUpdate `0x10051160`

The recursive absolute-bounds/clip computation. For a window with a parent it
loads the window's `+0x78/+0x7c/+0x80/+0x84` (x/y/w/h) and the parent's
absolute-bounds struct `+0xd4..+0xe8`, and writes this window's own
absolute-bounds struct at `+0xd4..+0xe8`:

| Offset | Field | Parent present | Null parent (root) |
| --- | --- | --- | --- |
| `+0xd4` | absX | `x + parent.absX` | `0` |
| `+0xd8` | absY | `parent.absY + y` | `0` |
| `+0xdc` | clip inset left | `clamp(absX, parentClipL) − absX` | `0` |
| `+0xe0` | clip inset top | `clamp(absY, parentClipT) − absY` | `0` |
| `+0xe4` | clipped width | `min(absX+w, parentClipR) − clamp(absX, parentClipL)` | `w` |
| `+0xe8` | clipped height | `min(absY+h, parentClipB) − clamp(absY, parentClipT)` | `h` |

where `parentClipL = parent.absX + parent.clipInsetL`, `parentClipR =
parentClipL + parent.clipWidth`, and similarly for top/bottom. Every add and
subtract is a single float32 store; the left/top clamps are x87 `max` (C0 set
for `<` and for unordered) and the right/bottom clamps are x87 `min` (C3|C0 set
for `≤` and for unordered). When the window carries a GC (`+0x130` non-null) the
six floats are copied to `GC+0x2c..+0x40` by the leaf `0x10026f00` (a plain
6-dword copy). The body then recurses over `firstChild` (`+0x13c`) /
`nextSibling` (`+0x148`).

The oracle validates eight native window trees — root-only, one child, a clipped
child (visible size shrinks), a child entirely left of the parent clip (negative
inset/width), a two-level nest, two siblings, a child with a GC, and fractional
x/y/w/h — comparing all six floats (and the GC copy) bit-for-bit with the DLL.

## SortWindowLists `0x10045140`

Re-sorts the type-≥1 ancestor's two window-manager lists after the geometry
changed: list A (`+0x14c`, count `+0x150`) by `(absY, absX, pointer)` through
comparator `0x10045250`, list B (`+0x158`, count `+0x15c`) by `(absX, absY,
pointer)` through comparator `0x100452d0`, writing each entry's index back to
`+0x11c` / `+0x120`. It then runs the invalid-region check `0x10045000`: with
both accumulated extents (`+0x16c` width, `+0x170` height) still zero it returns
0 and the top-level repaint tail (`0x1004c580` → `0x10036ed0`) does not run.

The window shell used by the live conversation does not maintain the
manager draw/input lists, so both counts are zero and the accumulated invalid
region is zero. In that reached configuration SortWindowLists is inert (both
qsorts and re-index loops skip, the invalid-region check returns 0, the repaint
tail is not reached). The oracle confirms the empty-list path returns cleanly
and validates both comparators over pointer-to-pointer slots. A populated list
or a non-empty invalid region is an explicit boundary — the Stage-4
window-manager paint/accelerator machinery, which the bounded renderer does not
use.

## Integration

`src/runtime/script-infolink-shell.mjs` binds both leaves onto the shell's
`configureChild` service, reading/writing the same raw window storage as the
rest of the window natives. With them present, the subtitles-on
`ConPlay.SetupEventSpeechPost → conWinFirst.Show/Clear/DisplayName/DisplayText`
path completes its reconfigure through the original `ConfigureChild` body
instead of throwing. `GetTopChild` (reached by
`HUDConWindowFirst.DestroyChildren`) is served by the same raw storage through
the added `sensitivity` service.

The bounded conversation renderer (`src/viewer/conversation-hud.mjs`) still
computes the frame placement from the recovered `ORDER_Down` TileWindow layout
and `DeusExHUD.ConfigurationChanged`'s centering — audited to match: `qWidth =
Min(width−100, 800)`, `x = width/2 − qWidth/2`, `y = infoBottom − conHeight −
20` (with `infoBottom = height` while the belt is absent). This does not build
the full native TileWindow reconfiguration/render tree, which stays a Stage-4
boundary; it uses the recovered `ConfigureChild`/`BoundsUpdate` bodies to
complete the play-time reconfigure and reads the original window fields for
presentation.
