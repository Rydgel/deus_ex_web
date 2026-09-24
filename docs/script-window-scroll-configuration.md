# Scroll-area child configuration

Contract recorded from original Extension.dll (SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c) before host
wiring. Existing preferred-size/geometry evidence is reused; no guessed layout.

ScrollArea.ConfigurationChanged (437c0) computes child holds with both current
sizes fixed, then configures visible horizontal manager, vertical manager, clip,
in that order, rereading pointers/visibility after each call.

Manager.ConfigurationChanged (42260) queries visible children bottom-up, builds
holds through ComputeChildConfig (41ea0), distributes remaining length to direct
visible scale/value children enabled by flags0/1, then configures children in the
same order. Both stretch recipients split the remainder with a float32 half
store; scale alone gets all. Negative remainder shrinks them. Alignment 0/1/2 is
start/center/end; other bytes fill. The original vertical fill branch writes
**child height** from manager width minus horizontal margins (41f7b), not width.
ComputeChildOffset (42070) shifts positions and adds each allocated delta to size
and cumulative offset. Preserve every temporary float store and live lookup.

Scale.ConfigurationChanged (3f8f0) computes scale texture extents, stretches the
along axis when flag8 is set, truncates centered offsets via _ftol, derives tick
bounds from start/end offsets and border, collapses reversed bounds to their
midpoint with retained x87 intermediates, then runs existing ComputeThumbConfig.
It finally computes tick texture size/center. No script callback in this override.

Clip.ConfigurationChanged (c560) selects GetChild and walks visible children
top-down. Selected content uses GetChildPreferredSize with both clip dimensions
fixed, then ReconfigureChild (c0e0); other children receive zero rectangles.
ReconfigureChild obtains live granularity, calculates negative pixel positions
from integer column/row and units, uses original Core.appCeil for total/visible
unit counts, applies flag8 minimum content sizes, and ClampChildPosition (bdf0)
limits positions to [clipSize-contentSize,0]. It configures the child before
storing new counts. Changed counts bubble ClipAttributesChanged (+104), with
live count reads and parent lookup on each iteration; unchanged counts omit it.
Callbacks are explicit services in the method comparisons; the reached
ScrollArea/Manager overrides are recovered below. Full-screen rendering/input are outside this placement slice.

Reference cases compare original full images and ordered configuration/
callback services, including both orientations, alignments, stretching, clamp
and rounding branches, and visibility changes during configuration, before Play
admission.

Reached range callback: ScrollArea.ClipAttributesChanged (43b50) first executes
its original script event with a false result seed. If source equals the live
clip pointer it clamps total columns/rows to >=1, calls SetRanges on existing
horizontal then vertical scales, and returns true; unrelated sources preserve
the script result. SetRanges (3df40) clamps only span to >=1, preserves the raw
count, writes changed span/count, then ChangeThumbPosition(current,1,1). Existing
original comparisons establish that helper. Hidden ancestors suppress attribute
broadcast; changed-position callbacks retain explicit boundaries.

Visible ranges also reach Manager.ScaleAttributesChanged (42640). It calls the
script event first, preserving its result, then for its own scale sets the first
button sensitive iff position>0 and the second iff signed32(position+span)<count.
The second pointer is reread after the first sensitivity call. Window's inherited
ScaleAttributesChanged bridge (3eb0) returns the original script result. These
complete the reached range-attribute propagation; movement callbacks stay gated.

## Verified delivery

All four configuration overrides and the reached clip/scale attribute callbacks
are now bound in the host. The original medical script passes scroll-area
configuration and reaches Actor.PlaySound264 in HUDMedBotHealthScreen.SetMedicalBot.
The separate RepairBot route retains PlaySound264 in HUDRechargeWindow.SetRepairBot.
No audio is suppressed to get past either boundary.

`validate-window-scroll-configuration.mjs` passes **29 original-DLL chains**,
comparing full object images and ordered query/configuration/script/sensitivity
services. Cases cover all four manager alignments in both orientations, scale
and value stretching (including negative remaining space), scale centering and
reversed bounds, clip clamping/minimum sizes, unchanged counts, a manager hidden
during the earlier configure call, matching/unrelated clip sources, and visible
scale -> manager -> ancestor attribute propagation. SetRanges adds three full
original-body cases to the child validator (37 total). The prior 29 preferred
sizing comparisons also pass after the shared oracle extraction.

The oracle runs original Core.appCeil and its integer conversion. Its unavailable
MSVCRT.ceil import is an explicit mathematical-library bridge implemented with
x87 rounding toward positive infinity and restored caller control word.
ConfigureChild, script results and SetSensitivity are recorded services; the
Play host binds the existing recovered ConfigureChild/SetSensitivity bodies.
These are bounded native-method comparisons, not full original screen captures.

The integration test asserts all four reached families return from configuration,
the clip has actual positive dimensions, live row counts reach the vertical
scale's tick/span fields, thumb bounds are ordered, and the up button becomes
insensitive at the first row. Existing baseline/accelerator/initialization checks
remain, along with explicit guards for draw, tick and show-area behavior.

Focused comparisons, both bot integration routes, syntax/diff checks and the
production build pass (existing bundle-size warning). No full sweep was run.

The reached layout/configuration slice is complete. Full bot screens remain
incomplete: Actor.PlaySound, Scale drawing/tick/mouse behavior, manager activation,
clip scrolling/show-area and position/range movement notifications, plus cleanup
are still explicit boundaries. Stage 3 and visual fidelity are not complete.

Reproduce with `node scripts/validate-window-scroll-configuration.mjs`,
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-scroll-children.mjs`,
`node scripts/validate-window-scroll-layout.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.
