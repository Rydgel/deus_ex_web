# TextWindow / TextLogWindow / LargeTextWindow text-display model

Authority is the installed `Extension.dll`, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, image base
`0x10000000` (oracle rebased to `0x12000000`).  This slice covers the
pure-state text-display controls: `XTextWindow` (a wrapped label), the
`XTextLogWindow` timed scrolling message log, and `XLargeTextWindow`.  Every
body below was disassembled from the real binary and validated bit-exact
against a Unicorn oracle that executes the original exec + method bodies.

Scope note: these natives set content/flags and request reconfigure.  They do
NOT compute the wrapped line layout — word-wrap runs in the window
reconfigure pipeline, a separate later slice that is out of scope here.  No
body in this family reaches the render device or the font-metrics scan.

## Recovered object layout

| field | offset | type | notes |
| --- | ---: | --- | --- |
| `windowType` | `+0x028` | byte | accelerator root walk stops at `>= 2` |
| `accelKey` | `+0x0b4` | dword | accelerator key code |
| `parent` | `+0x138` | ptr | window parent chain |
| `hAlign` / `vAlign` | `+0x14c` / `+0x14d` | byte | SetTextAlignments |
| `textFlags` | `+0x150` | dword | bit0 wordWrap, bit1 textAccelerator |
| `hMargin` / `vMargin` | `+0x154` / `+0x158` | f32 | SetTextMargins |
| `minLines` / `maxLines` | `+0x15c` / `+0x160` | i32 | -1 = unset |
| `minWidth` | `+0x164` | f32 | |
| `text` | `+0x168` | FString | `{data:+0, num:+4, max:+8}` |
| `lineSpacing` | `+0x174` | f32 | shared slot — TextLog `textTimeout`, LargeText `vSpace` |
| `log` | `+0x178/+0x17c/+0x180` | TArray | `{data,num,max}` of 0x14-byte records |
| `logFlags` | `+0x184` | dword | bit2 pause |
| `accelFlags` | `+0x584` | dword | on the `windowType>=2` ancestor: bit0 dirty |

Log record layout is `0x14` bytes: `+0x00` expire (f32), `+0x04..+0x0c` text
`FString`, `+0x10` color dword.

## Process globals / scratch cells

| cell | original | use |
| --- | ---: | --- |
| shared empty `L""` | `0x10099ea8` | text pointer when `num == 0` |
| log separator `L"\n"` | `0x10098e58` | join in the rebuild helper |
| convertPipes static FString | `0x100aead0` | exec `|n` -> LF result |
| convertPipes initialized flag | `0x100aeac8` | |
| convertPipes run scratch | `0x100add98` | flush every `0x800` bytes |
| Core `GPropAddr` | `0x101e32f8` | out-string lvalue |
| Core `GNatives` | `0x101f41b8` | marshal reader table |

## Helper bodies

| address | helper |
| ---: | --- |
| `0x10050710` | exec `convertPipes` (`|n` -> LF; `|` + non-`&`/`n` literal; trailing `|` kept; static result persists) |
| `0x1004e060` | `AskParentForReconfigure` leaf (intercepted -> event) |
| `0x1004fda0` | `GetTime` leaf (appSecondsSlow/rdtsc) — intercepted, returns the configured f64 `now` in ST0 |
| `0x10047dc0` | log->text rebuild: reset `text` to `L""`, append each line joined by `L"\n"`, then reconfigure |
| `0x1004f310` | `SetAcceleratorText` — scan for `\|&x`, key = char after `&` |
| `0x1004f3b0` | `SetAcceleratorKey` — `(arg & 0xffff) < 0xff ? that : 0`, dirty on change |
| `0x1004c580` | accelerator root walk — first ancestor/self `windowType >= 2` |
| `0x1004c1d0` | accelerator dirty — `root+0x584 \|= 1` |

Core `FArray`/`FString` helpers (`FArray::Empty`, `~FArray`, `FArray::Add`,
`FArray::Remove`, `FString::Mid`, `appStrlen`/`appStrcpy`/`appStrncpy`/
`appStricmp`) run the real Core.dll bodies in the oracle and are shared from
`script-window-list-model.mjs` / `script-edit-model.mjs` on the JS side.

## Recovered bodies

`execEnd` excludes the trailing SEH/register funclet.  For multi-return bodies
the range ends after the last native `ret` before the funclet tail / padding.

| native | function | exec body | method body |
| ---: | --- | --- | --- |
| 1550 | `TextWindow.SetText` | `0x10046a30..0x10046b52` | `0x10045d50..0x10045e2a` (vtable `+0x11c`) |
| 1551 | `TextWindow.AppendText` | `0x10046b80..0x10046ca2` | `0x10045e60..0x10045f74` (vtable `+0x120`) |
| 1552 | `TextWindow.GetText` | `0x10046cd0..0x10046d48` | inline |
| 1553 | `TextWindow.GetTextLength` | `0x10046d70..0x10046d9a` | inline |
| 1554 | `TextWindow.GetTextPart` | `0x10046dc0..0x10046f6d` | inline (uses `FString::Mid`) |
| 1555 | `TextWindow.SetWordWrap` | `0x10046f90..0x10046fd6` | `0x10045fb0..0x10046011` |
| 1556 | `TextWindow.SetTextAlignments` | `0x10047000..0x10047075` | `0x10046050..0x10046067` |
| 1557 | `TextWindow.SetTextMargins` | `0x100470a0..0x1004710f` | `0x10046070..0x100460e2` |
| 1558 | `TextWindow.SetLines` | `0x10047130..0x1004719f` | `0x10046120..0x10046194` |
| 1559 | `TextWindow.SetMinLines` | `0x100471c0..0x10047206` | `0x100461d0..0x10046233` |
| 1560 | `TextWindow.SetMaxLines` | `0x10047230..0x10047276` | `0x10046270..0x100462d3` |
| 1561 | `TextWindow.ResetLines` | `0x100472a0..0x100472af` | `0x10046310..0x10046371` |
| 1562 | `TextWindow.SetMinWidth` | `0x100472d0..0x10047316` | `0x100463b0..0x10046420` |
| 1563 | `TextWindow.ResetMinWidth` | `0x10047340..0x1004734f` | `0x10046450..0x100464ab` |
| 1564 | `TextWindow.EnableTextAsAccelerator` | `0x10047370..0x100473b6` | `0x100464e0..0x10046560` |
| 1570 | `TextLogWindow.AddLog` | `0x10048010..0x10048146` | `0x100476a0..0x100477da` (direct call) |
| 1571 | `TextLogWindow.ClearLog` | `0x10048170..0x1004817f` | `0x10047810..0x100478ad` |
| 1572 | `TextLogWindow.SetTextTimeout` | `0x100481a0..0x100481e6` | `0x100478e0..0x100478ed` |
| 1573 | `TextLogWindow.PauseLog` | `0x10048210..0x10048265` | inline |
| 1860 | `LargeTextWindow.SetVerticalSpacing` | `0x1002e7b0..0x1002e7f6` | `0x1002d7e0..0x1002d850` |

## Behavioral notes

`frame->Code` advances one opcode byte per marshalled param plus the
result-eat byte — the validators compare it as `args.length + 1`.

* `SetText`: `appStricmp` case-insensitive equal returns with no writes and no
  reconfigure; a data pointer equal to the argument skips the assign but still
  reconfigures; `textFlags` bit1 scans the NEW argument through
  `SetAcceleratorText`.
* `AppendText`: `num != 0` appends at `data + (num-1)*2` after
  `num += strlen` (the copy overwrites the old NUL); `num == 0` skips an empty
  argument entirely; both paths reconfigure; bit1 scans the ASSIGNED text.
* `SetWordWrap`: the guard compares `(flags & 1)` against the RAW dword arg —
  `2`/`3` still enter the write path; `flags ^= (flags ^ arg) & 1`.
* `SetTextMargins` / `SetMinWidth` / `SetVerticalSpacing`: x87 `fcomp`; a NaN
  makes its compare equal-or-unordered (suppressed), yet a NaN ARG still
  stores when the other margin/field differs.
* `EnableTextAsAccelerator`: guard compares `((flags>>1)&1)` to the raw dword;
  enabling scans current text, disabling scans NULL (key -> 0).
* `AddLog`: `expire = f32(now_f64 + f32(+0x174 timeout))`; records join with
  `L"\n"`, a trailing separator for an empty new line.
* `PauseLog`: `logFlags = (logFlags & ~4) | ((arg & 1) << 2)` inline.

## Unresolved / boundaries

The GNatives marshal readers are a documented boundary — the Core table is
runtime-initialised (zero in the file image), so the oracle services
parameter reads positionally and the out-string reader deep-copies into the
exec local + records `GPropAddr`, matching the observed contract.
Non-ASCII `appStricmp` case folding uses the CRT `towlower` table; only the
ASCII `A-Z` fold is modelled.  `GetTime` is nondeterministic (rdtsc) and is
the one intercepted leaf feeding `AddLog.expire`.
