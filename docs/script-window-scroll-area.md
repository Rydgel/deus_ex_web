# ScrollAreaWindow construction and setup

## Scope and original contract (before implementation)

Recover the constructor, complete Init call order, EnableScrolling, and the
three scalar settings natives. This is a prerequisite milestone, not admission
of a working scroll area into Play. ScaleManagerWindow, ScaleWindow and
ClipWindow construction/lifecycle/layout must be recovered before that admission;
no inherited-window substitute is permitted.

Authority: installed Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, its
annotated disassembly, and Extension.u ScrollAreaWindow source/properties.

Constructor `0x100186e0..0x10018719` calls UObject construction, zeroes the six
clip dwords +0xd4..+0xe8, and installs vtable `0x1005bcec`. It leaves authored
fields and the rest of the object untouched. Class native size is 0x180.

Init `0x10042d80..0x100430b8` first calls Window.Init. It sets marginWidth,
marginHeight and scrollbarDistance (+0x170/+0x174/+0x178) to 3.0, clears flag
bits 1/2 and sets bit0 at +0x17c, preserving all other bits. CreateNewWindow
then runs in this exact order (class, parent, third argument, result field):

| Class | Parent | Argument | Field |
| --- | --- | --- | --- |
| ScaleManagerWindow | Self | 0 | +0x14c |
| ScaleManagerWindow | Self | 0 | +0x150 |
| ClipWindow | Self | 1 | +0x16c |
| ButtonWindow | hScaleMgr | 1 | +0x15c |
| ScaleWindow | hScaleMgr | 1 | +0x154 |
| ButtonWindow | hScaleMgr | 1 | +0x160 |
| ButtonWindow | vScaleMgr | 1 | +0x164 |
| ScaleWindow | vScaleMgr | 1 | +0x158 |
| ButtonWindow | vScaleMgr | 1 | +0x168 |

Horizontal manager +0x15c becomes 0, then reconfigure, SetScaleButtons(left,
right), SetScale(hScale), manager +0x160 bit0 set, reconfigure. Vertical repeats
with +0x15c=1 and up/down/vScale. Each scale receives orientation 0/1,
SetSelectability(0), SetNumTicks(1), SetThumbSpan(1), EnableStretchedScale(1).
Each button in left/right/up/down order receives SetSelectability(0) and
EnableAutoRepeat(1, 0.5, float32(0.1)). Finally EnableScrolling(0,1) and
Self.SetSelectability(0).

EnableScrolling `0x10043160` reads each child pointer at the time of its call:
horizontal manager visibility, vertical manager visibility, then Clip.ForceChildSize
with logical negations of the two arguments. Null children are skipped.
Native1700 exec defaults both arguments to true (`0x10043e30`).

Native1701 (`0x10043ec0`, method `0x10018720`) stores scrollbarDistance and
requests reconfiguration only when the old/new x87 comparison is ordered and
unequal. Native1702 (`0x10043f40`, method `0x10018750`) writes both margins and
requests once if either comparison is ordered/unequal; equal or NaN pairs do
not trigger that comparison. Native1703 (`0x10044000`, method `0x10018790`)
defaults to true, compares the raw UBOOL to old bit0, then replaces bit0 and
reconfigures only on inequality. Remaining flag bits survive. No clamping.

## Reference plan

Execute unchanged constructor and Init against patterned complete images with
explicit recorded services for UObject/Window initialization, child creation,
and child-method calls. Compare all bytes and ordered service arguments. Execute
EnableScrolling with null/present children and callback mutations to test live
pointer reads. These comparisons establish this body's composition contract;
they do not establish child service internals. Use the existing native exec
harness for all three scalar settings, including optional arguments and floating
comparison edges. Keep Play admission closed pending child families and virtual
overrides.

## Result — prerequisite milestone complete, 2026-09-24

`script-window-scroll-area.mjs` translates constructor, complete Init, and
EnableScrolling with explicit child-family services. Ten unchanged-DLL
comparisons pass: two patterned constructor images, two full initialization
runs (nine children each), and six visibility cases, including null pointers
and a callback that clears later child references. Complete receiver/child
images and ordered service calls match. The native constructor vtable is
normalized from the probe's rebase to its original address. UObject/Window
initialization and child-method effects remain declared service boundaries;
these cases do not validate their internals.

Natives1701/1702/1703 are dispatched through the new setup module. Fifty-three
new exec-body comparisons pass, including omitted auto-hide, negative values,
signed zero, NaN, infinity, and mixed equal/unequal margins. The common window
native validator now passes 459 cases across 33 natives. In particular, NaN
must not be treated as ordinary JavaScript inequality: a NaN comparison alone
does not cause the original x87 branch to store or request layout.

The production build and syntax/diff checks pass. There is no visual gate for
this nonvisual composition milestone and no full sweep was run.

## Admission requirements at this checkpoint (superseded below)

Play still rejects ScrollAreaWindow construction; constructor/Init are deliberately
not registered as a partially working family. Native1700's wrapper is likewise
not dispatched while Clip.ForceChildSize lacks a host service. Next work is
ScaleManagerWindow, ScaleWindow and ClipWindow constructors/Init, reached
settings, and the scroll area's own layout/event/cleanup overrides. Its vtable
must not silently inherit Window implementations for those overrides. MedicalBot
still has the same explicit scroll-area boundary, and RepairBot's sound boundary
is unchanged. Stage 3 remains incomplete.

Reproduce:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-scroll-area.mjs`
- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-native-diff.mjs`

## Follow-up: child-family integration

The [child-family milestone](script-window-scroll-children.md) now supplies
ScaleManager/Scale/Clip construction and initialization, dispatches native1700,
and completes original PersonaScrollAreaWindow.InitWindow in Play. The host
explicitly guards every unrecovered override; the first medical-screen boundary
is now ScrollAreaWindow.ParentRequestedPreferredSize. The earlier admission
restriction above describes the prerequisite checkpoint, not the current host.
