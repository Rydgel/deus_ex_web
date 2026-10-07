# LargeTextWindow and EditWindow window family

Extension.dll (base `0x10000000`, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`).
`XLargeTextWindow` (vtable `0x1005b3e8`, 0x1d0 bytes) lays text out in rows
and draws it row by row; `XEditWindow` (vtable `0x1005b50c`, 0x28c bytes)
adds the caret, selection, blink, drag and editing input. The Goals screen's
`PersonaNotesEditWindow` is the first Training user.

Translations:

| module | bodies |
|---|---|
| `src/runtime/script-gc-text-line.mjs` | XGC GetTextLine `0x10027e50`, DrawTextLine `0x10028470`, DrawTextChar `0x100285f0`, ConvertPixelPos `0x10029880` (CharToPixel `0x10027fc0`, PixelToChar `0x10028050`) |
| `src/runtime/script-window-large-text.mjs` | ctor `0x10012a50`, Init `0x1002d480`, CleanUp `0x1002d560`, SetText `0x1002d6b0`, AppendText `0x1002d730`, MakeLinesDirty `0x1002d880`, ComputeLineHeight `0x1002d9d0`, GenerateLines `0x1002da70`, GetTextExtent `0x1002e130`, ParentRequestedPreferredSize `0x1002e1d0`, ParentRequestedGranularity `0x1002e380`, ConfigurationChanged `0x1002e430`, Draw `0x1002e500` |
| `src/runtime/script-window-edit.mjs` | ctor `0x10013690`, Init `0x1001cea0`, YToRow `0x1001e740`, XToCol `0x1001e7f0`, RowToY `0x1001e930`, ColToX `0x1001e9d0`, XYToPos `0x1001ec10`, PosToXY `0x1001ecd0`, ShowCursor `0x1001ef40`, ComputeCursorConfig `0x1001f680`, ActivateEdit `0x1001fb50`, PlayEditSound `0x1001dca0`, AppendText `0x1001e310`, Tick `0x100207d0`, CursorRequested `0x10020940`, ParentRequestedPreferredSize `0x10020ac0`, ConfigurationChanged `0x10020ba0`, VisibilityChanged `0x10020c60`, Draw `0x10020d00`, KeyPressed `0x10021290`, VirtualKeyPressed `0x10021480`, MouseButtonPressed `0x10021570`, MouseMoved `0x100216b0`, MouseButtonReleased `0x10021760`, XWindow::EnableSpecialText `0x1004dbe0` |
| `src/runtime/script-edit-model.mjs` | the editing methods behind natives 1880-1920 (docs/script-edit-model.md), CleanUp `0x1001d0b0`'s undo teardown, FilterChar `0x10021830` with a script override |
| `src/runtime/script-window-edit-natives.mjs` | exec marshalling of 1860 and 1880-1921 (defaults from the exec bodies `0x1002e7b0`, `0x10021af0`-`0x10022a30`) |

Host wiring: `src/runtime/script-window-host.mjs` admits both families
(construction, Init, the virtual overrides, CleanUp/destructor, natives) and
routes TextWindow.SetText/AppendText (1550/1551) to the overriding virtuals
(vtable `+0x11c`/`+0x120`). Window.AskParentToShowArea (1468, exec
`0x10053350`: a zero width or height is the window's) was added for
PersonaScreenGoals.WindowReady.

## Layout

LargeTextWindow script fields: `vSpace +0x174`, `lineHeight +0x178`,
`textParams +0x17c` / `rowData +0x194` (the layout Draw and the editor use),
`queryTextParams +0x1a0` / `queryRowData +0x1b8` (preferred-size queries),
`tempRowData +0x1c4` (incremental reflow scratch). XTextParams is 24 bytes
`{flags (bit0 dirty, bit1 special text), dirtyStart, dirtyCount, normalFont,
boldFont, destWidth}`; an XTextRowData row is 0x24 bytes `{width f32, start,
visible length, full length, XTextState[20]}`. EditWindow field names are the
script declarations (bEditable/bSingleLine/bUppercaseOnly at `+0x1d0`,
insertPos `+0x1d4` ... selectEndX `+0x288`).

## Behaviour notes

* GenerateLines writes the line height first, then compares the stored
  XTextParams (flag bits 0-1, width with fcomp C3, both fonts). When they match
  and a range is dirty it reflows incrementally: from two rows before the first
  row starting after the dirty start, lines are rescanned into tempRowData
  until one starts at an old row's start with an equal state (hasColor 0, or
  all four colour floats C3-equal), and the scratch rows are spliced in. A
  changed layout regenerates every row in place and trims the tail. Both paths
  add one to the last row's full length.
* MakeAreaDirty (`0x1002d8b0`) moves only rows that start after the edit point;
  a moved start at or before it becomes point + 1. The edit model's translation
  moved every earlier row too; the diff harness below found it and it is fixed.
* PreferredSize compares min/max lines with the drawing rows' count (`+0x198`),
  not the query rows it just generated.
* The two Draw bodies differ: the LargeText row step is `(lineHeight + vSpace)`
  kept on the x87 stack, EditWindow stores it to a float first and draws rows
  at least 4 pixels wide.
* Caret types 1, 2 and 4 centre the caret on the glyph and put it at the line
  bottom; 0 and 3 centre it on the insertion point and the line. A type that
  needs the insertion texture's size dereferences it unconditionally (a null
  texture is a boundary error here).
* XTextWindow::AppendText (`0x10045e60`) grows the text FString like
  `operator+=` (Num + length, Max = Num + 3Num/8 + 32 when exceeded); the host
  now supplies GMalloc (`services.realloc`) so the raw words follow it.

Stack garbage the original stores but never reads back is modelled as zero:
the upper bits of a stored XTextParams flags word, the first row's saved
colour floats (read only when its hasColor byte is set), and the alpha byte of
Init's three FColor temporaries (the parent pointer's high byte, reproduced).

## Verification

`scripts/validate-text-layout-diff.mjs` builds the window, UGC, fonts,
textures, canvas and render interface in the window-host heap and runs each
case twice over the same memory image: the JavaScript translation, and the
original body in `scripts/native-text-layout-oracle.py` (Unicorn with
Extension.dll rebased to `0x12000000`, Core and MSVCRT executing, only host
leaves intercepted). It compares the window image (FString/TArray contents in
place of their pointers), the UGC image, every host event (script events,
reconfigure and show-area requests, sounds, DrawTile and glyph argument
blocks, texture Lock/Unlock), EAX and out parameters. 147/147 cases are
identical, covering full and incremental layout, special text, preferred size
and granularity, both Draw bodies with alignments, clipping and selections,
every caret type, blink and drag ticks, cursor requests, input handlers,
AppendText/SetText and the row/column helpers.

Not covered by the harness (read from the disassembly): the constructors,
both Init bodies and CleanUp, which the Goals probe runs in Play.

## Remaining boundaries

* Typed characters reach XEditWindow::KeyPressed through the recovered
  route ([typed characters](script-window-typed-keys.md)); Goals notes, the
  New Game name and computer logins take text in Play. Arrow keys,
  Backspace, Delete and Enter arrive as virtual keys through
  HandleVirtualKeyboard. The compared KeyPressed keys now include 0xe9,
  0x20ac, 0x08 and 0 (151/151).
* An omitted colour argument to 1905/1907/1908/1909 keeps the exec's stale
  stack alpha and stays a boundary, as for the button colour natives.
