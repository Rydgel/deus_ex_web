# ListWindow window family (XListWindow) in Play

Authority: Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c` (preferred
base `0x10000000`; the oracle rebases it to `0x12000000`), Core.dll and the
shipped MSVCRT.dll executing unchanged in the oracle, the installed
`Extension.u` declarations (`ListWindow.uc`) and the SDK header `ExtList.h`
for member names. Every address below is a body in that image.

The row/column model natives that were recovered first are documented in
[the list model](script-window-list.md); this page covers the family as a
whole: construction, lifecycle, every ListWindow native, the virtual overrides
and their wiring in the window host. It also records XScaleWindow::Draw, which
the persona lists reach as soon as they overflow their scroll area.

## Class

`XListWindow : XWindow`, vtable `0x1005b998`, registration size `0x1d0`. The
vtable overrides the destructor (`+0x0c`), Serialize, Init `0x1002e900`,
CleanUp `0x1002ead0`, ParentRequestedPreferredSize `0x10033260`,
ParentRequestedGranularity `0x100332c0`, VisibilityChanged `0x10033d90`,
MouseMoved `0x100338c0`, MouseButtonPressed `0x10033750`,
MouseButtonReleased `0x100339c0`, KeyPressed `0x10033ae0`,
VirtualKeyPressed `0x10033ca0`, Tick `0x10033e50` and Draw `0x10033350`; every
other slot is XWindow's.

| offset | member (ExtList.h) | notes |
| ---: | --- | --- |
| `+0x14c` | `delimiter` FString | Init sets `;` |
| `+0x158` | `inverseColor` | selected-row text colour |
| `+0x15c`/`+0x160` | `highlightTexture`/`focusTexture` | |
| `+0x164`/`+0x168` | `highlightColor`/`focusColor` | |
| `+0x16c` | `focusThickness` | Init 1.0 |
| `+0x170` | `rows` TArray of `XListRowData*` | a row id *is* the row pointer |
| `+0x17c` | `cols` TArray of 0x38-byte `XListColData` | its count is the column count |
| `+0x188` | bit0 `bAutoSort`, bit1 `bAutoExpandColumns`, bit2 `bMultiSelect` | Init: `(old & ~1) | 6` |
| `+0x18c`/`+0x190` | `colMargin`/`rowMargin` | Init 3.0 / 1.0 |
| `+0x194` | bit0 `bHotKeys` | Init sets it |
| `+0x198` | `hotKeyCol` | |
| `+0x19c` | `lineSize` | ComputeRowSize: tallest column font's space glyph + 2·rowMargin |
| `+0x1a0`/`+0x1a4` | `activateSound`/`moveSound` | |
| `+0x1a8` | `numSelected` | |
| `+0x1ac`/`+0x1b0` | `focusLine`/`anchorLine` (row pointers) | |
| `+0x1b4` | bit0 `bDragging` | |
| `+0x1b8`/`+0x1bc` | `lastIndex`/`remainingDelay` | drag state |
| `+0x1c0`/`+0x1cc` | `hotKeyString` FString / `hotKeyTimer` | |

`XListColData` (0x38): index, title FString, sortIndex, bitfield `+0x14`
(bit0 reverse, bit1 case sensitive, bit2 **hidden**), width, alignment byte
`+0x1c`, colour (unaligned dword `+0x1d`), font `+0x24`, type byte `+0x28`,
format FString `+0x2c`.

## Lifecycle

* InternalConstructor `0x100162f0` → `0x10016300`: UObject, the
  XExtensionObject vtable, XClipRect at `+0xd4`, `rows`/`cols` zeroed, the list
  vtable. The FStringNoInit members are not touched.
* Init `0x1002e900`: XWindow::Init, SetDelimiter(`;`), inverse/highlight/focus
  colours (0,0,0)/(255,255,255)/(128,128,128) whose alpha byte is the high
  byte of the parent pointer (the FColor temporaries live in the argument
  slot), flags `(old & ~1) | 6` (auto-sort off, **auto-expand and
  multi-select on**), focus thickness 1, margins 3/1, `maxClicks` (`+0xd0`) 2,
  hot keys on, every other member zero, `hotKeyString = L""`,
  SetNumColumns(1), ResetSortColumns(1), SetSelectability(1). The persona
  lists turn multi-select off themselves.
* CleanUp `0x1002ead0` (before XWindow::CleanUp): clears focus/anchor, frees
  every row front to back (each field's `0x100368b0`, the field array's
  Empty and `~TArray`, `GMalloc->Free(row)`), empties `rows`, runs each column's
  title/format teardown (`0x10012630` ×3, `0x10003990` ×2), empties `cols`,
  ClearHotKeyString.
* `~XListWindow` `0x10015de0` (members only; the XWindow/UObject chain is the
  host's): hotKeyString, columns (`0x100161c0`), rows array, delimiter.

## Natives

All 69 natives 1720–1812 are dispatched by `dispatchListWindowNative`
(`src/runtime/script-window-list.mjs`), exec bodies `0x10033f50`–`0x100366f0`.
Optional parameters keep the values each exec writes into its slot before the
GNatives evaluation: SelectRow/SelectAllRows/HideColumn/EnableHotKeys/
EnableAutoSort/EnableAutoExpandColumns/EnableMultiSelect/ResetSortColumns
default TRUE; SelectToRow (clear TRUE, invert FALSE, span FALSE); MoveRow and
SetRow (select TRUE, clear TRUE, drag FALSE); SetFocusRow (move TRUE, anchor
TRUE); SetSortColumn/AddSortColumn FALSE; ResizeColumns FALSE; AddRow client
data 0; SetListSounds None; PlayListSound volume −1.0, pitch 1.0; SetColumnType
passes NULL for an empty format (the per-type default). SetRowClientObject
shares SetRowClientInt's exec: the object pointer is the client data.

Behaviour worth recording:

* **CheckPosition `0x10032a70`** (after SetField/SetFieldValue/ModifyRow on an
  auto-sorted list) re-inserts the row when its predecessor compares `>= 0`,
  or else when the row compares `<= 0` against its successor — the successor
  test is the original's (it leaves a row that sorts *after* its successor in
  place). Reproduced.
* **MoveToRow `0x10032e30`** (behind SetRow, SelectToRow, MoveRow and the
  mouse): single-select forces clear and drops the span; a span deselects the
  old anchor..focus range and selects anchor..row; invert toggles; the focus
  move re-anchors unless spanning; a changed focus row plays `moveSound`.
* **MoveRow `0x1002f790`**: without a focus row the start index is
  `0xffff0001`, so Up/Down/Page land on row 0 after the clamp; an empty list
  only clears the focus.
* **GetColumnColor `0x10030210`** returns (0,0,0) with the alpha byte of the
  column argument's slot for an invalid column (−1 → alpha 255).
* **FindRowByKey `0x10030d50`** (KeyPressed): the hot-key string grows by the
  key; a string of one repeated character cycles one row from the focus row,
  any other prefix matches starting at the focus row; ASCII A–Z compare case
  insensitively; the timer is reset to 1 s and Tick clears the string when it
  runs out.
* **PlayListSound `0x10031370`** uses XWindow::PlaySound's positioned overload
  only when every ancestor is visible: x at the clip (or window) centre, y at
  `focus.index * lineSize + rowMargin` or the clip/window centre.
* **ChangeListSelection `0x100331a0`** and **ActivateListRow `0x100330e0`**
  walk `this`, then each parent, calling vtable `+0x10c` ListSelectionChanged
  (list, numSelected, focusRow) / `+0x108` ListRowActivated (list, focusRow)
  until one returns nonzero; activation first requires every ancestor to be
  visible. XWindow's slots are the script bridges `0x10003f90`/`0x10003f50`.

## Virtual overrides

* ParentRequestedPreferredSize: width = Σ visible column widths (each sum
  stored), height = `rows * lineSize`; the specified flags are ignored.
* ParentRequestedGranularity: (1.0, lineSize) handed to XWindow's script
  bridge `0x10050450`.
* VisibilityChanged: the script event; a newly visible list without a focus
  row selects and focuses row 0 (SetRow(row0, TRUE, TRUE, FALSE)), which is
  how every persona list shows its first entry.
* MouseButtonPressed: the script event first; a left click picks
  `_ftol(y / lineSize)` clamped to the rows, shift spans, ctrl inverts and
  keeps the other rows, starts dragging and arms `GetTickOffset() + 0.1`.
  Always handled for the left button; other buttons return the script result.
* MouseMoved: the script event; while dragging, a new row extends the span.
* MouseButtonReleased: the script event; a left release stops dragging and a
  click count above 1 on a row focuses it, plays `activateSound` and
  activates it.
* KeyPressed: the script event with the key as a one-character FString, then
  the hot-key search (handled whenever the key is a valid hot key and hot keys
  are on).
* VirtualKeyPressed: the script event (ListWindow.uc moves the focus row);
  arrows and Escape clear the hot-key string; Enter plays `activateSound`,
  activates the focus row and is handled.
* Tick: the drag repeat (the MouseMoved virtual at the cursor whenever the
  remaining delay, compared unstored, goes below zero) and the hot-key timeout.
* Draw: runs inside the render pass, so its x87 arithmetic is precision
  control 24 ([render-pass precision](render-pass-precision.md)). The first
  row is `fistp(f32((clipY + 1e-5) / lineSize) − 0.5)` (round to nearest even:
  row 33 of a list scrolled to exactly 33 lines starts at 32), the last
  `appCeil((clipH + clipY) / lineSize)` limited to the row count. PushGC, style
  masked, no word wrap, left/top alignment, no special text; selected rows get
  `DrawPattern(highlightTexture)` in highlightColor; each visible column sets
  its font pair and, per row, the inverse or column colour, intersects the
  cell less the margins, aligns (left: x + colMargin; right:
  `(colW − fieldW) + (x − colMargin)`; centre: `(colW − fieldW)·0.5 + x`) and
  draws the text at `((lineSize − fieldH) + (y − rowMargin)) + 1.0`, restoring
  the clip rectangle (XGC::SetClipRect `0x10026f00`); a focused list draws the
  focus box `DrawBox(focusThickness, focusTexture)` in focusColor on the focus
  row; PopGC; XWindow::Draw (script DrawWindow).

## XScaleWindow::Draw

`0x1003fb10` with DrawScaleTexture `0x1003f250`
(`src/runtime/script-window-scale-draw.mjs`), reached when a list overflows
its PersonaScrollAreaWindow: the track (scale texture, border box through the
border pattern, colour), each tick (TickToPixel `0x1003ea70` at precision 24,
centred by `_ftol(size · 0.5)`; the first tick is skipped unless flag bit2,
one more for a span scale) and the thumb with its two caps. DrawScaleTexture
saves the GC style and tile colour, draws the border inset, the caps
(`DrawIconPattern` with the cap extents) and the body (`ul`/`vl` zero when the
stretch flag is set), then restores both. The scale draw does not call the
script DrawWindow. It replaces the former "scalewindow.draw native override"
boundary.

## Host wiring

`src/runtime/script-window-host.mjs` admits `extension.listwindow`:
construction, Init, CleanUp/destructor, the 69 natives, the virtual slots
above, the `+0x108`/`+0x10c` script bridges, and the list services: GMalloc
(`heap.realloc`), XWindow::GetGC/ReleaseGC (`W.gc`), XGC::GetTextExtent for
ComputeFieldSize, the image cells `L""`, the sort-column list, the glyph-miss
pair and KeyPressed's stack FString. A script row id that is not a heap block
is a boundary error instead of a wild read.

Also added on the way, each from its own body: ClipWindow.ForceChildSize
(1689, exec `0x1000cb70`, both defaults TRUE, reached by MenuScreenSaveGame;
compared by `validate-window-native-diff.mjs`, now 745 cases across 53
natives) and the EnableSingleLineEditing/EnableUppercaseOnly text-copy cell in
the host's edit memory (reached by MenuUILoadSaveEditWindow).

## Verification

`scripts/validate-window-list-family.mjs` with
`scripts/native-listwindow-family-oracle.py` (NATIVE_PROBE_PYTHON). Each case
builds a fresh window-host heap (list window, parents, fonts, textures, the
window and global GCs, canvas and render interface), prepares the list through
the JavaScript translation, and runs one native — the registered exec body,
parameters decoded through a GNatives stub at their widths, skipped optionals
as EX_Nothing, out parameters through GPropAddr — or one virtual, in both
runtimes over the same image. Compared: every window dword (in-call GMalloc
blocks labelled by allocation order), each row with its fields and strings,
each column with its strings, the delimiter and hot-key strings, the GC image,
the allocator stream, every host event (script events, reconfigure,
show-area, selectability, sounds, selection/activation virtuals, MouseMoved,
DrawTile/glyph argument blocks, texture Lock/Unlock), the result slot and the
out cells. Draw and the scale draw run at control word `0x007f`, the rest at
`0x037f`. XGC bodies, GetCharSize, FArray/FString code, appStrcmp/appStricmp,
appMemmove and qsort execute; only host leaves are intercepted (see the
oracle's header). VM parameter-string temporaries and `Realloc(NULL, 0)` are
not allocator events on either side.

Result (2026-10-06): **280/280 cases identical** — all 69 natives, 14 list
bodies (constructor, destructor, Init, CleanUp and the ten virtuals) plus the
scale draw; **19/19 mutations** of the translation (Draw rounding and
alignment, MoveToRow span, CheckPosition, the click modifiers, a SelectRow
default, PlayListSound, FindRowByKey, Init margins, the Tick compare,
GetColumnColor's alpha, DeleteRow's anchor, VisibilityChanged, activation
click count, three scale-draw changes) are detected. The fourteen earlier
per-native list validators still pass.

In Play (headless, `scripts/census-ui-screens.mjs`): Conversations, Images
and Logs open, paint at 1432×1268 and close with Escape on 00_Training and
01_NYC_UNATCOIsland (11/11 screens on both maps). A fresh game has empty
lists, so `scripts/validate-window-list-play.mjs` (an integration check, not
an original comparison) adds 40 log lines through the original
DeusExPlayer.AddLog and opens the Logs screen: 40 rows newest first, row 0
selected by VisibilityChanged, the scrollbar drawn, then a press, drag,
release and double click through the root's mouse route, Down/Up/End/Home
through ListWindow.uc's VirtualKeyPressed, and Escape. A local probe that ran
the original `AllImages` cheat exec (35 images) also showed the Images list
selecting its first image and displaying it through ListSelectionChanged.

## Status (2026-10-07)

Complete for the persona list screens; open items below.

* Family diff: 280/280 identical (69 natives, 14 list bodies, the scale
  draw), 19/19 mutations detected.
* `validate-window-list-play.mjs` passes; the window validator sweep is 83
  passed, 1 skipped (`validate-window-scene-frame`, skipped before this work),
  0 failed; `npm test` 598/598; text-layout-diff, datacube-read, keypad and
  the 14 per-native list validators pass.
* `scripts/census-ui-screens.mjs` now runs each screen in its own child Node
  process, so memory no longer piles up across games (a single process ran out
  of its 4 GB JavaScript heap at the ninth Island game). 11 of 11 screens open,
  draw and close on both 00_Training and 01_NYC_UNATCOIsland.
  `--screens MenuScreenLoadGame,MenuScreenSaveGame` records both at native
  3013 (below).
* `EventHost.attach` (`src/runtime/script-vm-events.mjs`) re-reads the arena
  view after the call-cache allocation: that allocation can grow the Wasm
  memory and detach the view taken before it (seen creating the ninth game in
  one process).

## Boundaries and open items

* **Load Game / Save Game** (MenuScreenLoadGame/SaveGame, MenuUIListWindow):
  reachable headless from MenuMain's buttons
  (`--screens MenuScreenLoadGame,MenuScreenSaveGame`); both stop at native
  3013 `DeusExPlayer.CreateGameDirectoryObject` (GameDirectory, the save-game
  directory) — Stage 6.
* KeyPressed (hot keys) is translated and compared, but the root's
  typed-character route to a window's KeyPressed is not recovered (as for
  EditWindow), so hot keys are not reachable in Play yet.
* The conversation history list with rows (ListSelectionChanged →
  DisplayHistory) is not exercised in Play: a fresh game has no ConHistory.
* Serialize `0x1002ec70` (UObject::Serialize only) is not wired; saving is
  Stage 6.
* Init's colour alpha bytes are the high byte of the parent window's heap
  address in Play (`0x21`), not the original's address; the persona lists
  overwrite all three colours in StyleChanged.
* GetTickOffset hands MouseButtonPressed a float, as the original's ST0
  return; the host value is the root's tick offset rounded to binary32.
