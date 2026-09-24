# Checkbox window and text-family granularity — 2026-09-24

The [reach census](stage-3-exit-criteria.md) stopped two persona screens on
window natives:

- the Goals screen, whose "show completed goals" control is a
  `PersonaCheckboxWindow` (`Extension.CheckboxWindow`);
- the Inventory screen, whose item detail reached the Text-family
  `ParentRequestedGranularity`.

The retail vftables named the exact functions
([SDK reference](sdk-reference.md)).

## Checkbox family

`??_7XCheckboxWindow@@6B@` (`0x1005a8f0`) differs from `XToggleWindow`'s table
only at five slots: the destructor, `Init` `+0x54`, `CleanUp` `+0x58`,
`ParentRequestedPreferredSize` `+0x7c` and `Draw` `+0xd8`. The host therefore
dispatches a checkbox as a toggle and handles those slots itself
(`FAMILIES['extension.checkboxwindow'].dispatch`).

| Body | Behavior |
| --- | --- |
| constructor `0x1000a040` | `XWindow::XWindow` (`0x10003130`), `FString(ENoInit)` at `+0x168`, then the checkbox vtable |
| `Init` `0x1000a710` | See below. |
| `CleanUp` `0x1000a7d0` | Calls `XToggleWindow::CleanUp` `0x100498a0`, which calls `XButtonWindow::CleanUp` |
| destructor `0x10009f00` | The vtable chain down to `~XTextWindow`'s `FString` finalization; toggle and checkbox share the button destroy entry |
| extent `0x1000a9c0` | See below. |
| preferred size `0x1000acb0` | See below. |
| `Draw` `0x1000aad0` | See below. |

`Init` `0x1000a710` runs `XToggleWindow::Init`, then stores, in this order:

- `textureWidth`/`textureHeight` 0;
- `bRightSide` cleared;
- `checkboxColor` (unaligned `+0x20d`) set to R/G/B 0xff. Its alpha is the
  surviving high byte of the parent argument word, as in `XButtonWindow::Init`;
- `checkboxSpacing` 3.0f;
- `checkboxStyle` 2.

The extent `0x1000a9c0` works per axis. It keeps a positive
`textureWidth`/`textureHeight`. Otherwise it takes a positive `toggleOn`
USize/VSize, then a larger `toggleOff` one. The horizontal extent adds
`checkboxSpacing` only when the width is positive.

The preferred size `0x1000acb0` works in stages:

1. Nonempty text with a line limit and no specified height is measured at
   width 0. A specified width is measured through a temporary x-extent slot,
   so the width is kept. The font-height line limits apply as in
   `XTextWindow`.
2. Other text is measured at the width less both margins and the extent when
   word-wrapping.
3. The margins and the extent are added.
4. Empty text uses the background texture, or `XTextWindow`'s `0x100465a0`
   when there is none.
5. Each axis is raised to the box size plus both margins.

`Draw` `0x1000aad0` runs in this order:

1. GC alignments, then word wrap.
2. Script `DrawWindow`.
3. `toggleOn`/`toggleOff` is chosen by the pressed bit.
4. The box top is `_ftol((height - boxHeight) * 0.5)`.
5. The label is drawn at `vMargin + 1.0f`, beside the box on the side
   `bRightSide` selects.
6. With a texture, `checkboxStyle` and `checkboxColor`, then the tile gate
   `0x10028770`.

The script natives `SetCheckboxTextures` (1840, `0x1000a840`),
`SetCheckboxSpacing` (1841, `0x1000a910`) and `ShowCheckboxOnRightSide`
(1842) join `SetCheckboxStyle`/`SetCheckboxColor` (1843/1844) in
`validate-window-native-diff.mjs`. That makes 735 identical cases across 52
natives. The two setters skip an unchanged value; NaN counts as unchanged,
because x87 C3 is set for equal and for unordered.

## Text-family granularity and SetTextColors

`XTextWindow::ParentRequestedGranularity` `0x10046880` fills the `+0x80` slot
of the Text, Button, Toggle, Checkbox and TextLog vftables. With a GC, the
vertical unit is `GetFontHeight(1)` (fst/fstp) and the horizontal unit 1.0f.
The GC is released, and `XWindow`'s script bridge `0x10050450` always follows.
The host's bridge list already matched the retail `0x10050450` group exactly.

`ButtonWindow.SetTextColors` (1594) is now dispatched with its existing
translation, which `validate-window-set-text-colors.mjs` checks. An omitted
colour keeps a stale stack alpha, as in 1593, so it stays an explicit
boundary.

## Evidence

`scripts/native-window-checkbox-oracle.py` runs `0x1000acb0`, `0x10046880`,
`0x1000a710` and `0x1000aad0` unchanged. The GC, script-bridge and toggle
`Init` leaves are recorded services with controlled responses.

```bash
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-checkbox.mjs
```

All 140 cases match: result bits, ordered leaf calls with their argument bits,
and the full receiver image. They are 80 preferred-size, 40 draw, 8 init and
12 granularity cases. Planted mutations fail it: dropping the spacing (33
cases), the label's +1.0 (40) and the stale alpha byte (6). Comparing the
rounded instead of the unrounded line product is not observable. No float
lies strictly between an x87 product and its nearest float, so it is not a
gap in the cases.

The check covers each body's control flow, x87 arithmetic, store order and
call ABI. It does not cover font measurement or rasterization.

## Play integration

- `PlayerPawn.ShowMenu` begins with `WalkBob = vect(0,0,0)`. `WalkBob` now
  writes the recovered `CheckBob` state instead of refusing the write.
- `TextWindow.SetText` on accelerator text reaches `SetAcceleratorKey`, so
  the host's text services supply `MakeAcceleratorTableDirty`.

With these, the census shows the **Goals screen opening and closing through
Escape** on original code. Closing it still reaches `SaveConfig` (536) and
`DeusExPlayer.UnloadTexture` (3016). The **Inventory screen opens**. Closing
it stops at `XRadioBoxWindow::DescendantRemoved` `0x10038cb0`.
