# Interactive-control model (Stage 3 Extension batch)

This note covers the recovered model shared by the interactive widget
natives — ButtonWindow, CheckboxWindow, RadioBoxWindow, the last
ToggleWindow entries, and the two base-Window stragglers
(`QueryPreferredSize`, `IsKeyDown`). Every statement below is backed by a
disassembled `Extension.dll` body (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`) executed
on the Unicorn oracle `scripts/native-controlwindow-probe.py`; each native's
module, oracle wrapper, mutation-tested validator, and per-native evidence
live beside it under `src/runtime/` and `scripts/`.

## Notify callbacks (ancestor walk)

Three natives dispatch a script-side callback through a window's own vtable
while walking the `+0x138` parent chain. The callback is always invoked with
the *current* ancestor as receiver and the *original* window as `source`;
the walk stops when a callback returns nonzero or the chain ends at null.

| Native | Vtable slot | Arguments | Notes |
| --- | --- | --- | --- |
| `ButtonWindow.ActivateButton` (1590, method `0x100077e0`) | `+0xe8`, or `+0xec` when `Key == 2` | `(source)` | starts at the receiver itself |
| `ToggleWindow.ChangeToggle` (1610, method `0x10049910`) | `+0xf0` | `(source, receiver.+0x174 & 1)` | does **not** flip the toggle bit — `+0x174` is re-read per dispatch; the task note claiming a flip was wrong |
| `ButtonWindow.PressButton` (1598, method `0x1000a9a0`) | `+0x124` | `(key & 0xff)` | single vcall on the receiver, no walk |

The oracle models each slot as a recorded event (order, receiver, `source`,
and scalar args are all part of the bit-exact comparison). Return values
come from per-case `vresults` queues keyed `windowLabel:slot`.

`ChangeToggle`'s ancestor dispatch is also what `SetToggle` uses after its
bit flip; the reconfigure path (`AskParentForReconfigure` at `0x1004e060`)
is a separate leaf recorded as an `AskParentForReconfigure` event with no
return value.

## Style table and refresh (`0x10008380`)

ButtonWindow keeps a six-entry style table at `+0x1a4` (stride `0x0c`,
entries `{tex, buttonColor, textColor}`). `SetButtonTextures` (1592),
`SetButtonColors` (1593), and `SetTextColors` (1594) write their six
arguments into the matching slot of each entry, then run the shared
refresh:

1. Climb `+0x138` while the current window's `+0x30` byte has bit 1 set.
   A chain that ends on an insensitive (or null-but-not-topmost) window
   leaves the state index at 2 ("insensitive"); only when every ancestor
   was sensitive and the chain ends at null does the refresh ask
   `IsFocusWindow(this)`.
2. `IsFocusWindow` = `GetRootWindow(this).+0x5c8 == this`, where
   `GetRootWindow` climbs `+0x138` to the topmost window and keeps it only
   when its `+0x28` type byte is `>= 3`.
3. `index = state*2 + (+0x174 & 1)` selects the entry (normal/pressed ×
   state). `tex = entry.tex`, falling back to `table[1].tex` when toggled
   or `table[0].tex` when the selected texture is null.
4. Writes `+0x18c = entry.textColor`, `+0x184 = tex`, `+0x188 =
   entry.color` (the active draw style).

The same refresh serves `ToggleWindow.SetToggle` (state ∈ {0,1,2}); the
`ecx=2` default survives when the sensitivity walk stops early, which is
why one body covers both classes.

## Input key-state field

`Window.IsKeyDown` (1470, method `0x1004c980`) calls `GetRootWindow` and,
when a root exists and the masked key byte is in `[0, 0xff)`, returns the
root window's key-state byte at `+0x630 + key` as a dword. Key `0xff` and a
missing root both yield 0. The root's `+0x630..+0x72f` range is the
keyboard state array; the exec masks the script argument to a byte before
the call, so the `[0,255]` domain is fully covered.

## Preferred-size computation

`Window.QueryPreferredSize` (1465) exec `0x10053160` routes two float out
parameters through `GPropAddr` and calls wrapper `0x1004e710` → helper
`0x1004e790(this, 0, 0, wOut, 0, 0, hOut)`. The helper is shared with other
layout callers (which pass real input sizes); the native path always sends
zeros. Recovered algorithm:

1. Effective width: `+0x9c >= 0.0` (ordered `fcomp` vs `0.0f`) means the
   dimension is provided and used as-is; otherwise the input is `-1.0f`
   and the dimension is "wanted". Same for height at `+0xa0`. Each
   provided field is read twice (once for the compare, once for the
   store) — the oracle trace shows both reads.
2. Both provided → write the outs and return; no cache access, no vcall.
3. Otherwise consult the cache: `+0xb8` bit 1 is a dirty flag that forces
   recompute; bits 3/4 must equal the current provided-flags, and `+0xbc`/
   `+0xc0` must ordered-equal the current inputs (`fcomp` semantics —
   unordered counts as "equal" for the `ah&0x40` test, though these fields
   can never hold NaN through the native path). On a hit the results come
   from `+0xc4`/`+0xc8` and still flow through the fallback tail.
4. On a miss the helper stores the inputs (`+0xc0` then `+0xb8` then
   `+0xbc`, clearing the dirty bit), increments the `.bss` recursion
   counter at `0x100aeb04`, dispatches vtable `+0x7c`
   `preferredSize(flagW, &width, flagH, &height)` so the script side can
   fill the wanted dimensions, decrements the counter, and stores the
   results at `+0xc8` then `+0xc4`. Wanted dimensions take the
   callback-written slot value; provided dimensions keep the input.
5. Fallback tail (both paths): width `< 0` or unordered → `int32` at
   `font(+0xec)+0x34` (`fild`) when a font is set, else the `+0x80` field;
   height → `font+0x38` or `+0x84`. Then `*wOut`/`*hOut` are written when
   the out pointers are non-null.

The `preferredSizeDepth` global lives in `Extension.dll` `.bss` and is
zero-initialized in the real process; the probe maps it and records every
read/write.

## Pure-state setters

| Native | Recovered body |
| --- | --- |
| `SetActivateDelay` (1591) | store f32 arg at `+0x178` |
| `EnableAutoRepeat` (1595) | `+0x174` bit 2 = flag; f32 delay/rate at `+0x17c`/`+0x180` (exec defaults `0.5`/`0.1`) |
| `EnableRightMouseClick` (1596) | `+0x174` bit 3 = flag |
| `SetButtonSounds` (1597) | press/click sound pointers at `+0x190`/`+0x194` |
| `SetToggleSounds` (1613) | enable/disable sound pointers at `+0x1ec`/`+0x1f0` |
| `ShowCheckboxOnRightSide` (1842) | `+0x208` bit 0 = flag |
| `SetCheckboxStyle` (1843) | byte store at `+0x20c` |
| `SetCheckboxColor` (1844) | **unaligned** dword store at `+0x20d` (bleeds into `+0x210`) |
| `SetCheckboxSpacing` (1841) | `fcomp` equal → no-op; else store `+0x204` + `AskParentForReconfigure` |
| `SetCheckboxTextures` (1840) | four-field compare (`+0x1f4`/`+0x1f8` tex, `+0x1fc`/`+0x200` f32), changed → store + reconfigure |
| `GetEnabledToggle` (1820) | leaf: return `+0x184` pointer |

The checkbox spacing/textures compares use real x87 `fcomp` semantics:
unordered (NaN) operands read as "equal" for `ah&0x40` and "below" for
`ah&1`. The oracle proves each `fst`/`fcomp`; no JS-double approximation
is used.

## Boundaries and unverified paths

- The `0x10008380` refresh computes the active draw style but drawing
  itself is out of scope (render device). The `+0x184`/`+0x188`/`+0x18c`
  fields are the boundary.
- `SetButtonSounds`/`SetToggleSounds` store sound **pointers** only;
  playing them is out of scope.
- `QueryPreferredSize`'s helper accepts caller-supplied dimensions
  (`a1/a4` nonzero) on other call paths; the native exec always passes 0,
  so only that path is implemented and verified.
- `IsKeyDown` reads whatever produced the `+0x630` byte array; writing the
  array (input event path) is a different native surface, not covered
  here.
- The SEH exception frames in several bodies (`appMsgf` + rethrow) are
  unreachable in the emulated flow and are not modeled.
- Cyclic `+0x138` chains and non-canonical receivers are rejected as
  boundary errors rather than emulated.
