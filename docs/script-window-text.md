# InfoLink TextWindow native slice

Authority is the installed `Extension.u` and installed `Extension.dll`, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
This slice covers both `TextWindow` children in the original
`HUDInfoLinkDisplay.CreateControls` body: `winName` and `winQueued`.

`Extension.TextWindow` is class export 22. Its native default constructor at
`0x10008e70` calls the Window constructor, clears the inherited origin region
`+0xd4..+0xe8`, and installs the TextWindow vtable. Runtime class attachment
owns that vtable identity; the existing Window constructor translation owns
the shared storage writes.

The TextWindow virtual `Init` at `0x10045af0` first calls
`XWindow::Init(parent)`. It then establishes these additional fields:

| field | native offset | initial value |
| --- | ---: | ---: |
| `HAlign` | `+0x14c` | 1 |
| `VAlign` | `+0x14d` | 1 |
| `bWordWrap` / `bTextIsAccelerator` | `+0x150`, bits 1 / 2 | true / true |
| `hMargin` / `vMargin` | `+0x154` / `+0x158` | 3 / 3 |
| `minLines` / `MaxLines` | `+0x15c` / `+0x160` | -1 / -1 |
| `MinWidth` | `+0x164` | 0 |
| `Text` | `+0x168` | empty FString |

Enabling accelerator text scans the first UTF-16 `|&` marker. The empty
initial string sets accelerator key `+0xb4` to zero; the table-dirty callback
runs only when that key changes.

## Setters reached by winName and winQueued

Installed UFunction metadata and native bodies establish the complete call
sequence:

| function | export / native | native body | behavior used here |
| --- | --- | --- | --- |
| `TextWindow.SetTextAlignments` | 1125 / 1556 | `0x10046050` | unconditional byte stores at `+0x14c/+0x14d` |
| `Window.SetFont` | 1856 / 1477 | `0x1004d840` | writes the same font to `+0x54/+0x58`, propagates it to XGC `+0x7c/+0x80`, asks parent to reconfigure |
| `Window.SetTextColor` | 1854 / 1476 | `0x1004d9e0` | stores packed RGBA at `+0x3d`, normalized RGB and zero W at `+0x44`, mirrors both to XGC `+0x68/+0x6c` |
| `TextWindow.SetTextMargins` | 1122 / 1557 | `0x10046070` | compares both floats with x87 C3 semantics, writes both and reconfigures when either differs |
| `TextWindow.SetText` | 1146 / 1550 | `0x10045d50` | case-insensitive unchanged guard, FString assignment, accelerator scan, parent reconfiguration |

The margin comparison treats unordered as equal, matching the native x87
branch. Color plane conversion uses the installed double constant
`0.00392156862745098` at `0x1005e3c0`, then stores float32 values. The title
contains no accelerator marker, so its final accelerator key remains zero.

Running the installed 736-byte CreateControls body produces this `winName`
state:

```text
position 94,15     size 293,15
alignment left,center     margins 0,0
font DeusExUI.FontMenuHeaders_DS
color 255,255,255,0
text "INCOMING TRANSMISSION..."
visible true     word wrap true     accelerator key 0
```

The following `winQueued` construction uses the same native TextWindow path
and produces the authored 200×15 control at `(187,15)`, right/center aligned,
with zero margins, `FontMenuHeaders`, color `(200,200,200,0)`, and an empty
initial string.

`scripts/validate-window-text.mjs` re-reads all five UFunction records, hashes
their unchanged exec wrappers and native bodies, checks the constructor/Init
and helper hashes, and exercises the translated state changes and branches.
`scripts/validate-infolink-shell.mjs` then runs the complete original
CreateControls body and checks both TextWindows together with the remaining
four authored controls.

The browser draws the recovered bounds, text and color as a diagnostic. The
original `FontMenuHeaders_DS` UFont renderer is still outside this slice, so
browser glyph rasterization is not evidence of font-rendering fidelity.
