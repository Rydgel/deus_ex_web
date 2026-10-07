# ScaleWindow and ScaleManagerWindow settings and values

This covers the Scale and ScaleManager natives that the scroll milestones
([children](script-window-scroll-children.md),
[movement](script-window-scroll-movement.md)) left out. The security
computer's pan slider (`MenuUISliderButtonWindow`, created by
`ComputerScreenSecurity.CreatePanSlider`) reaches them: `SetMarginSpacing`,
`SetScale`, `SetValueRange` (through `SetTicks`), and the `ScalePositionChanged`
broadcast that sets the screen's `panMod`.

Authority: installed Extension.dll (SHA-256 `93c35502…8b916d9c`, preferred base
0x10000000) and the Extension.u `ScaleWindow` / `ScaleManagerWindow`
declarations. Translation: `src/runtime/script-window-scale-settings.mjs`,
dispatched from `script-window-host-natives.mjs`.

## Contract

### ScaleWindow natives

| Native | Exec → body | Behaviour |
| --- | --- | --- |
| 1623 SetTickTexture | 0x10040670 → 0x1003d890 | Defaults: bDrawEndTicks TRUE, sizes 0. A negative or NaN width or height (fcomp 0, C0) becomes 0. Writes the texture to +0x158, the width to +0x19c (raw), the height to +0x1a0 and bDrawEndTicks to bit 2 of +0x164, then always calls AskParentForReconfigure. |
| 1626 SetBorderPattern | 0x10040910 → 0x1003db20 | Stores the texture at +0x168 and does not reconfigure. The body is COMDAT-folded with `XListWindow::SetFocusColor`. |
| 1627 / 1628 SetScaleBorder / SetThumbBorder | 0x10040980 / 0x10040a20 → 0x1003db30 / 0x1003dbd0 | Always stores the colour (+0x174 / +0x178). The size (+0x16c / +0x170) is stored, and the parent asked to reconfigure, only when the x87 compare is ordered and unequal (C3 clear). A NaN size is therefore never stored. |
| 1639 GetThumbSpan | 0x10040ee0 → 0x1003df20 | Returns the span (+0x1cc) in range mode (+0x164 bit 4), and 0 otherwise. |
| 1642 SetValueRange | 0x10040fd0 → 0x1003e070 | Stores both values (+0x1d4 / +0x1d8) and calls ChangeScalePosition(1) when either compare is ordered and unequal. |
| 1643 SetValue | 0x10041060 → 0x1003e120 | Calls `ChangeThumbPosition(ValueToTick(value), 0, 1)`. |
| 1644 GetValue | 0x100410d0 → 0x1003e1b0 | Returns TickToValue(position), stored as a float. |
| 1645 GetValues | 0x10041110 → 0x1003e230 | `from` is TickToValue(position). In range mode `to` is TickToValue(position + span); otherwise it is the +0x1d4 value (the range's *low* end). The exec passes the out properties through GPropAddr. |

**Omitted colours.** When the colour argument of SetScaleBorder or
SetThumbBorder is omitted, R, G and B are 0xff. The exec writes them over its
`FFrame*` argument slot, so the alpha byte is the high byte of that pointer.
It is modelled as 0, as for SetRawBackground (see
[native exec diff](native-exec-diff.md)).

**ValueToTick (0x1003ec20).**
1. `n` is the count in range mode, and count − 1 otherwise.
2. If the range's ends compare equal or unordered, the fraction is 0.
   Otherwise it is `n * (value − from) / (to − from)` at x87 precision.
3. The result is `_ftol(t − 0.5)` when `t` is below 0 or unordered, and
   `_ftol(t + 0.5)` otherwise.
4. ChangeThumbPosition then clamps it to the scale.

A negative or NaN tick always clamps to 0, so the choice between the two
rounding branches does not show for negative values.

### ScaleManagerWindow natives

| Native | Exec → body | Behaviour |
| --- | --- | --- |
| 1660 SetScaleButtons | 0x100427e0 → 0x10041b30 | Each button must be a descendant (`IsDescendant` 0x10041d10 walks `GetParent`), or it becomes none. Stores the second button (+0x150), then the first (+0x14c). |
| 1661 SetValueField | 0x10042870 → 0x10041c70 | Descendant check. When the field (+0x154) changes, stores it, calls AskParentForReconfigure, then runs ChangeValueField (0x10041da0). |
| 1662 SetScale | 0x100428e0 → 0x10041bd0 | The same as SetValueField, for the scale at +0x158. |
| 1663 SetManagerOrientation | 0x10042950 | Stores the byte as a dword at +0x15c and always reconfigures. |
| 1664 / 1665 StretchScaleField / StretchValueField | 0x100429c0 / 0x10042a40 | Default TRUE. Sets bit 0 / bit 1 of +0x160 and always reconfigures. |
| 1666 SetManagerMargins | 0x10042ac0 | Defaults 0, 0. Stores both values (+0x164 / +0x168) and reconfigures when either compare is ordered and unequal. |
| 1667 SetMarginSpacing | 0x10042b80 | Default 0. Stores +0x16c and reconfigures when the compare is ordered and unequal. |
| 1668 SetManagerAlignments | 0x10042c00 | Stores the bytes +0x171, then +0x170, and reconfigures, when either differs. |

**ChangeValueField.** It formats only when the manager has both a value field
and a scale: it calls `GetValueString` and then the field's vtable +0x11c
SetText. That formatting remains an explicit boundary. The security slider
has no value field, so it never formats.

## Reference cases

- **`scripts/validate-window-native-diff.mjs`** (the common exec-body harness)
  covers the leaves 1623, 1626–1628, 1639, 1644 and 1663–1668. It now passes
  1023 cases across 73 natives, all identical.
  - The receiver patterns are joined by focused x87 edges: a NaN or ±0 old or
    new value, infinities, the GetValue modes, an empty or one-tick count
    (the midpoint), and NaN or infinite ranges.
  - Two spot mutations (NaN treated as unequal, a plain `< 0` clamp) are
    detected.
- **`scripts/native-window-scale-settings-oracle.py` with
  `scripts/validate-window-scale-settings.mjs`** run the unchanged bodies
  through the movement probe. That gives complete ChangeScalePosition and
  ChangeThumbPosition chains, script events, and AskParentForReconfigure
  recorded.
  - Cases: SetValueRange (both modes, NaN, −0, equal ends), SetValue (13
    values on 7 ranges, in value mode and range mode), GetValues (each
    pointer null or present), and SetValueField / SetScale /
    SetScaleButtons (descendant, grandchild, self, unrelated, none,
    unchanged).
  - Result: 134 cases identical, and 8/8 mutations detected.
  - Two candidate mutations were dropped because no outcome can show them:
    rounding negatives up, and dividing an unordered range. ChangeThumbPosition
    clamps both to 0, and `_ftol` of NaN is 0.

## Play

`validate-terminals-play.mjs --terminal ComputerSecurity1` drives the
security screen through these natives. The slider's broadcast reaches
`ComputerScreenSecurity.ScalePositionChanged` and sets `panMod` to 1, which
the pan and zoom checks then use.

## Still unsupported

These are explicit errors if reached:

- GetValueString (1647), SetValueFormat (1646), SetEnumeration (1648) and
  ClearAllEnumerations (1649). They need the static value buffer, Core
  `appSprintf` → MSVCRT float formatting, and the FString / TArray
  enumeration storage.
- PlayScaleSound (1653).
- ChangeValueField's formatting.

The options menus (`MenuChoice_*`, `MenuUIChoiceSlider`) use the enumeration
natives and formats such as `%1.0f`.
