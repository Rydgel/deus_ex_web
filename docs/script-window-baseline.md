# Window.SetBaselineData — Stage 3 bounded milestone

Scope: close native 1484 during original PersonaBorderButtonWindow initialization,
including its null-context branch and optional arguments. Completing the medical
and repair bot screens or their rendering is outside this milestone.

## Original contract (recorded before implementation)

Installed Extension.u declares Window.SetBaselineData with two optional float
parameters, newBaselineOffset and newUnderlineHeight, and no return value.
Extension.dll SHA-256 is
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
The registered exec body `0x10053de0..0x10053e4f` evaluates the parameters in
order with defaults 2.0 (`0x40000000`) and 1.0 (`0x3f800000`), consumes the
end-parameters token and calls `0x1004dd30`.

The method reads Window+0x130 once. If null it returns without writing anything.
Otherwise it calls UGC.SetBaselineData (`0x10027680`) on that existing context:
arg1 is copied to GC+0x8c, then arg2 to GC+0x88. There is no allocation,
window field update, layout notification, equality test or clamping. The
ordinary method returns at `0x1004dd7f`; its trailing SEH error reporter is
outside this successful-call contract. The existing GC translation and
[GC evidence](script-gc-state.md) are reusable.

Installed PersonaBorderButtonWindow.InitWindow runs Super.InitWindow,
EnableTextAsAccelerator(False), resolves the root's parentPawn, sets button and
focus sounds and volume, calls SetBaselineData(fontBaseLine,
fontAcceleratorLineHeight), then calls StyleChanged. MedicalBot.Frob's
single-player no-canister branch constructs HUDMedBotHealthScreen; RepairBot.Frob
calls ActivateRepairBotScreens to construct HUDRechargeWindow. Both reach this
button initializer. Original sources are local under `.cache/research/src` and
remain outside Git.

## Verification plan

Extend the existing exec-body oracle with explicit pointer-linked memory
images, executing the real GC callee rather than replacing it with a hook.
Compare the complete window and context images, parameter consumption, untouched
return storage and event stream for default, skipped, signed-zero, negative,
subnormal and extreme float arguments with/without an existing context.
Then run installed button initialization via the Play host for both bot routes,
asserting the native writes and return to original StyleChanged. Any later
screen boundary stays explicit and is not waived as completed screen behavior.

## Result — complete, 2026-09-24

Native1484 is dispatched through the existing GC translation. All 22 reference
cases match the original exec and GC callee over full memory images, including
null GC, both/one omitted parameters, negative values, signed zero, subnormals,
extreme finite values, infinities and NaN. Argument evaluation precedes the GC
lookup. No context is allocated and no layout event is invented.

`validate-window-baseline-play.mjs` boots a fresh presentation-enabled Training
host for each bot and executes the installed Frob. MedicalBot creates a
PersonaNavButtonWindow; RepairBot creates a PersonaActionButtonWindow. Both
supply their authored `[1, 1]` values, write the existing context, execute
StyleChanged and return from PersonaBorderButtonWindow.InitWindow. Both then
stop explicitly at native1439, Window.SetAcceleratorText, inside the original
SetButtonText. The validator asserts that boundary; it does not suppress it or
claim either screen is fully usable.

Validation passed:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-baseline.mjs`
- `node scripts/validate-window-baseline-play.mjs`
- Existing `validate-window-native-diff.mjs`: 406 comparisons across 30 natives,
  checking the shared oracle extension did not change existing leaf behavior.
- `npm run build` (existing bundle-size warning) and `git diff --check`.

No visual comparison or full sweep was needed for this nonvisual native/script
boundary. Stage 3, bot screen completion and original glyph rendering remain
unfinished. Work stops at this milestone.


### Subsequent accelerator milestone

[Native1439 is now dispatched](script-window-accelerator-text.md). The integration
validator retains these baseline assertions and now follows both bot paths to
their later explicit boundaries: ScrollAreaWindow construction for MedicalBot,
and RepairBotRaiseArm PlaySound for RepairBot. The native1439 stop above records
the baseline milestone's historical result.
