# Scroll-area child families: construction through medical-screen initialization

Work scope: admit the recovered ScrollArea/ScaleManager/Scale/Clip construction
chain and execute original PersonaScrollAreaWindow.InitWindow. Later layout,
draw/input/cleanup overrides must have explicit boundaries until recovered.
Source of truth is Extension.dll (SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c), Extension.u
native declarations and installed PersonaScrollAreaWindow/medical screen scripts.
No guessed inherited overrides are allowed.

## Contract recorded before implementation

| Family | Constructor | Init | Vtable |
| --- | --- | --- | --- |
| ScaleManager | 0x100182d0 | 0x100419f0 | 0x1005bbd0 |
| Scale | 0x10016f20 | 0x1003d200 | 0x1005bab4 |
| Clip | 0x1000ce90 | 0x1000b320 | 0x1005aff0 |

All constructors invoke UObject and zero the six clip words. Clip also zeroes
the two inherited TabGroup arrays (+14c..160). Scale zeroes enumStrings
(+268..270); its valueFmt FString is ENoInit, so construction leaves it intact.
Manager Init calls Window.Init; +14c..15c=0; flags+160=(old&~1)|2;
+164..16c=0; alignment bytes+170/+171=1. Clip Init calls TabGroup.Init,
sets positions+174/+178=0, unit sizes+17c/+180=-1, flags+184=(old&~3)|12,
+188..194=0, +198/+19c=1.0, and clears TabGroup flag4 at+164.

Scale Init calls Window.Init then writes its original zero texture/sizing/range
fields, flags+164=(old&0xffffffe4)|4, style bytes+17c..17e=2, colors at
+174,+178,+17f,+183,+187 white with the parent pointer's high byte retained.
numPositions+1c4=10, currentPos+1c8=0, spanRange+1cc=1, thumbStep+1d0=1,
from/to+1d4/+1d8=0/1; valueFmt comes from literal 0x10098cf4. Delay/rate
+1e8/+1ec=0.5/float32(0.1), initialPos+1f0=-1; geometry+1f4..254=0,
flags+258 bit0 clears, repeatDir+260=0, remainingTime+264=0.

Manager.SetScaleButtons (41b30) accepts only descendants (self included);
SetScale (41bd0) applies that gate, stores changed scale, reconfigures then
ChangeValueField (41da0). The latter is a real no-op only when either value
text or scale is null; otherwise GetValueString and text virtual+11c are required.

Scale settings use their 3d680..3e990 methods and registered 40430..41620 execs.
Orientation always stores/reconfigures. Texture extents and margins clamp
negative/NaN to zero; texture/cap setters always reconfigure, margins only on
ordered inequality. Styles/colors are byte/unaligned dword stores.
StretchedScale updates flags bits3 and0 on change. NumTicks clamps >=1;
ThumbSpan changes flags4/1 and range. Both reach ChangeThumbPosition (3f170),
which clamps currentPos to the integer range, preserves callback ordering,
then ComputeThumbConfig (3ed60). ChangeScaleAttributes (3f6c0) first proves all
ancestors visible then bubbles virtual+100 with live numPositions/span/currentPos.
ComputeTextureSize (3ecb0) uses positive explicit extents else Texture+34/+38,
then adds twice the border. TickToPixel (3ea70) preserves x87 truncation and
span/nonspan denominator branches. Full thumb sizing retains the original
float stores, cap reduction, six-pixel minimum and range limit.

Visibility requests on Manager/Clip/ScrollArea set child visibility then ask
for reconfiguration (421e0/c2e0/43740). ForceChildSize (b9f0) updates only
Clip flags0/1 when raw booleans differ, then asks to reconfigure.

Original comparison cases will exercise complete constructor/Init images,
slider state transitions/geometry, settings execs and service ordering before
Play integration. Native allocation, inherited verified base methods, event
callbacks and resource identity remain explicit services in those probes.

## Verified delivery

The host now admits the four native families through these recovered constructors
and Init bodies, using original CreateNewWindow for all nine children. Their
serialized class handles are prepared before synchronous native creation.
PersonaScrollAreaWindow.InitWindow and StyleChanged both return in the Training
MedicalBot Frob route. Both authored sets of six health-region buttons subsequently
initialize; all 16 medical buttons retain the verified baseline/accelerator path.

The 16 newly compared Scale execs (1620–1622, 1624–1625, 1629–1635, 1637, 1641,
1651–1652) add 224 comparisons: the common runner now passes **683 cases across
49 natives**. Original instruction review also establishes optional defaults:
SetThumbSpan exec 0x10040e70 defaults to 1; EnableScrolling exec 0x10043e30
defaults both axes to TRUE. Body comparisons exercise those dispatcher defaults.
Button texture/color natives1592/1593 reuse the already recovered implementations
and their existing 8/4 original cases. Omitted colors retain an explicit boundary
because their stack-dependent alpha is not modeled; the original persona script
supplies all six colors.

`validate-window-scroll-children.mjs` passes **34 original body comparisons**:
12 constructor/Init full images with patterned memory, 12 slider geometry/range
cases, and 10 clip/manager wiring cases (including descendant rejection, identity
no-op and preserved high flags). The separate ScrollArea runner retains its ten
original composition/service-order cases. Core FString construction executes in
the oracle; base Init, reconfiguration and changed-position callbacks are explicit
services. These are bounded method comparisons, not an original full-screen run.

The Play integration checks original script completion, nine class identities and
parent links, manager scale links, orientation/range/scroll flags, thumb dimensions,
sound volume and the native layout/draw/tick guards. It also reruns the separate
RepairBot route, whose Actor.PlaySound264 boundary is unchanged.

## Remaining work

The construction/scrollbar-initialization slice is complete. The medical screen
as a whole is **not complete**: its next original call is
ScrollAreaWindow.ParentRequestedPreferredSize (0x100438f0), which requires
ComputeChildSizes (0x100432d0), Clip.QueryClipPreferredSize and manager/scale
layout. Reconfiguration, draw, mouse input, visible scale callbacks and cleanup
overrides remain explicitly unsupported. They cannot silently inherit the base
Window/TabGroup behavior. ScaleManager.ChangeValueField still stops when both its
value text and scale exist; initial scroll managers have no value text.

No full validator sweep or visual equivalence is claimed for this nonvisual
slice. Reproduce with the two scroll validators, the common window-native
validator, `node scripts/validate-window-baseline-play.mjs`, and `npm run build`.

Follow-up: [preferred sizing](script-window-scroll-layout.md) now implements the
four size overrides and the reached Tile granularity dependency. The medical
route's next boundary has moved from preferred size to ConfigurationChanged.

Follow-up: [child configuration](script-window-scroll-configuration.md) now
completes the reached placement/count/range/sensitivity chain. MedicalBot's next
boundary is Actor.PlaySound in SetMedicalBot; draw/input/cleanup remain guarded.

Follow-up (2026-10-06): XScaleWindow::Draw (0x1003fb10, with DrawScaleTexture
0x1003f250 and TickToPixel at render-pass precision 24) is translated in
`src/runtime/script-window-scale-draw.mjs` and compared with the original body
by `scripts/validate-window-list-family.mjs`; the persona lists reach it when
they overflow their scroll area. See [the ListWindow family](script-window-list-family.md).
