# Original actor primitive collision

Contract reconstructed before translation from hash-gated GOTY Engine.dll:
`UPrimitive::PointCheck` export10301848 →103d87e0; `LineCheck`10301b9f →103d8af0.
Actor location is three floats at114; radius1d4; height1d8 (direct loads).
Point excludes exact radial/cap boundary. It returns SafeNormal(position-location),
then for normal.z outside[-.5,.5] sets location=(position.x,position.y,actor.z-extent.z)
on BOTH sides. Otherwise location.xy=actor.xy-extent.x*horizontalSafeNormal,
location.z=actor.z+position.z. Time is untouched.
Line first rejects same-side axis bounds; radius expands by extent.x (extent.y
only used by Y early bound), height by extent.z. Strict cap crossing updates
entry/exit; quadratic horizontal intersection updates the interval. Initial
radial C<1 and strictly inside height returns hit at time0 only if horizontal
movement dot radial offset < -.1, otherwise clear. Small horizontal A<1e-8
uses C<=0. Entry must be less than exit. Successful time clamps(entry-.001,0,1).
Outputs mutate even on some clear paths; callers must use outside before hit data.
Constants are binary doubles at1042abd8=-.5,1042ac10=.5,104298a0=1,
10430a80=4,10431ed8=-.1,1042d538=1e-8,1042ac20=.001.
UMesh::LineCheck1030259f→103a6d10 delegates both nonzero extent and zero extent
branches to UPrimitive at103a6db9; zero branch explicitly constructs zero vector
and rejoins at103a6e34. No mesh triangle or actor flag selection occurs.

## Verified translation and reproduction

`src/runtime/primitive-collision.mjs` exports
`primitiveLineCheck(actor,start,end,extent)` and
`primitivePointCheck(actor,position,extent)` in original Unreal coordinates.
Actor input is `{location:[x,y,z],radius,height}`; null actor clears. Results are
`{outside,location,normal,time}` with the oracle's initially zero result and time1.
No collision filtering or actor flags occur here; callers attach their actor
reference. Point hit time remains1. Do not treat point result location as a
conventional depenetration result: the surprising original behavior above is
preserved. `extent.y` asymmetry is preserved, including unequal extents.

Run `node scripts/validate-native-primitive.mjs`. It generates 5,353 deterministic
cases and runs the original Engine/Core plus hash-gated original MSVCRT.dll
(`e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210`).
Default game root is `Deus Ex GOTY Edition`; override with `DEUS_EX_ROOT` and
`NATIVE_PROBE_PYTHON` if needed. No collision/math callbacks are substituted.
All inputs and raw DLL outputs remain ignored under `.cache/primitive`.
The final comparison has **zero mismatches**, including every clear/hit boolean
and all float32 time/location/normal values on BOTH clear and hit paths.
The corpus includes 2,717 line hits and 232 point overlaps. Every original UMesh
output equals UPrimitive output in the same corpus. Standing20/20/43,
crouch20/20/16, zero and asymmetric extents, stationary/inward/outward overlap,
exact side/cap boundary and near-boundary cases are represented.
Small native-derived regression expectations are retained in the unit test;
`node --test test/primitive-collision.test.mjs` passes.

This establishes these two primitive methods against original DLL execution,
not full actor movement/events or all possible floating-point inputs. Inputs
must be finite ordinary game geometry with nonnegative radius/height/extents;
NaN/Infinity and arbitrary prefilled FCheckResult state are outside the API.
No runtime game capture or in-game movement comparison is claimed here.
