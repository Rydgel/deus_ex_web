# Window.SetAcceleratorText — Stage 3 milestone

Scope: dispatch native1439 and verify both Training bot scripts pass their
SetButtonText calls. Full bot screens and accelerator keyboard activation are
outside this milestone.

## Original contract, before implementation

Extension.u Window.SetAcceleratorText declares one required string and no result.
The registered Extension.dll exec is `0x100524a0`: it initializes an empty
FString, evaluates its argument, consumes the end-parameters token, passes the
string data (or the shared empty string for ArrayNum=0) to `0x1004f310`, then
cleans up its temporary FString. It does not call ConvertScriptString.
DLL SHA-256: `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.

The already recovered scanner at `0x1004f310..0x1004f37d` scans UTF-16 until
NUL and selects the unit following the first `|&`. A pipe followed by another
character consumes both characters: `||&k` yields no key. The setter at
`0x1004f3b0..0x1004f410` maps units >=255 to zero, stores the resulting dword
at Window+0xb4 and calls MakeAcceleratorTableDirty only if it changed. That
recovered parent walk marks bit0 of +0x584 in the nearest window with type>=2.
Case is preserved. There is no reconfiguration request in this native.
A final pipe can read beyond the string allocation in the original; that
unverified heap-dependent path remains an explicit unsupported boundary.

Installed PersonaBorderButtonWindow.SetButtonText assigns buttonText, invokes
SetAcceleratorText(newText), then AskParentForReconfigure. Both bot screens
reach this body after the completed baseline initialization milestone.

## Verification plan

Reuse the shared native text-window probe, which executes original Extension,
Core FString cleanup and MSVCRT bodies with recorded allocator services. Add
native1439 to that probe. Compare complete window/parent memory changes for
empty strings, ordinary strings, markers, repeated pipes, byte-range edges,
unchanged keys and nearest-modal parent selection. The GNatives string evaluator
and allocator remain the existing probe services, not newly recovered heap
behavior. Establish original reference cases before adding the dispatcher.

## Result — 2026-09-24

Native1439 now routes through the existing scanner and real parent-table dirty
service. The scanner's UTF-16 termination now honors embedded NUL, as the
original does (`a\0|&z` selects no key). The wrapper does not convert pipes or
invent layout events. The following original SetButtonText script still makes
its own AskParentForReconfigure call.

Sixteen differential cases pass using the full original exec, scanner,
SetAcceleratorKey and MakeAcceleratorTableDirty bodies. Complete receiver and
parent images match with only parent pointer relocation normalized, including
unchanged-key, no-modal, self-modal and intervening-parent cases. The existing
406 window-native comparisons pass; the shared text-window probe's existing
EnableTextAsAccelerator validator also passes its nine cases and three mutation
checks. The build passes with its existing bundle-size warning.

The extended `validate-window-baseline-play.mjs` preserves the baseline checks
and verifies return from original SetButtonText for every reached button. The
installed DeusEx.int labels supply the independent expected accelerator keys:
HUDMedBotNavBarWindow's Augmentations/Health are 65/72, inherited
PersonaNavBarBaseWindow's Exit is 120, and HUDRechargeWindow's Close/Recharge
are 67/82. Label spacing and case are retained.

Both Training bot paths cross the milestone. Their next explicit boundaries are:

- MedicalBot: PersonaScrollAreaWindow construction (`extension.scrollareawindow`
  is not admitted).
- RepairBot: original HUDRechargeWindow.SetRepairBot reaches native264 PlaySound
  for RepairBotRaiseArm, outside the Play host's admitted sound paths.

Neither exception is suppressed. Full bot interaction, key activation, rendering,
and Stage 3 completion are not claimed. No visual gate or full validator sweep
was needed for this native/script boundary. Stop after this milestone.

Reproduce with:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-accelerator-text.mjs`
- `node scripts/validate-window-baseline-play.mjs`
