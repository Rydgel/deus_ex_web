# Actor AI lighting and visibility

## Original contract (recovered before translation)

Authority: installed GOTY Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
Core.dll `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`,
and embedded Actor/ZoneInfo/LevelInfo declarations. Original files and captures
remain outside Git. This is the AI scalar query, independent of surface rendering.

| Entry | Original body |
| --- | --- |
| AIGetLightLevel, native 700 | exec `1036d350`, worker `1036b980` (thunk `10303ee0`) |
| AIVisibility, native 701 | exec `1036d3d0`, worker `1036bca0` (thunk `10302135`) |
| WorldLightRadius | virtual +60, `1030d6a0` (thunk `10303f7b`) |
| Brightness/saturation scalar | `1036bc50` (thunk `10303c15`) |
| AICanSee internal visibility call | `103c6e81..103c6e93`, calls AIVisibility(other,1) |

AIGetLightLevel snapshots receiver Region.Zone (+c8) and XLevel (+ac) at entry.
Unlit (+194 bit 1) starts with 1 and skips lights. Otherwise it walks live
Level.Actors (+2c/+30), reloading the array/count on each iteration. Null, self,
LightType=0 (+1e0), and LightBrightness=0 (+1e2) entries are skipped. There is
no Light class test, dynamic-prefix gate, or hidden/deleted filter.

WorldLightRadius is `(LightRadius byte + 1) * 25` (double at `10426988`),
including radius zero. Radius squared and point distance squared are stored f32;
coordinate differences and `(dx²+dy²)+dz²` retain x87 precision until that store.
Only radiusSquared > distanceSquared admits a light (unordered is rejected).
Static lights (+28 bit 1) call ULevel::SingleLineCheck virtual +c0, with receiver
as source, light.Location as start, input point as end, flags 6, zero extent,
extra 0. Nonzero means clear. Nonstatic lights do not trace. Trace output is
unused. Attenuation is f32(1 - double(sqrt(double(distSq/radiusSq)))).
Brightness and saturation are read **after** the trace. Their scalar is:

`((saturation + 127.5) * 0.00261437908496732) * (brightness * 0.00392156862745098)`.

Constants are doubles at `1042ad88/1042ad78/1042ad68`. The scalar remains x87
extended, multiplies attenuation and adds to an f32 accumulator, stored f32 per
light. The sum is halved/stored f32. AmbientBrightness (+38c) and
AmbientSaturation (+38e) from the **entry-snapshotted** zone use the same scalar,
doubled and added to the sum. Clamp [0,1] treats unordered as below zero.
The worker returns extended; native 700 stores f32. Hue is unused.

AIVisibility validates Actors[0] as LevelInfo and reads its **reflected f32**
TimeSeconds (+478), not ULevel's double clock. Elapsed is f32(time -
VisUpdateTime +2e8). In call order:

- Elapsed > .5 (or unordered): stamp VisUpdateTime **before** querying light at
  current Location; f32-store result to both CurrentVisibility (+2ec) and
  LastVisibility (+2f0). Base is this stored result.
- Otherwise elapsed > .25: copy CurrentVisibility to LastVisibility, stamp time,
  query light, reload LastVisibility **after** the query, store new CurrentVisibility.
  Base is reloaded LastVisibility.
- Otherwise interpolate `(CurrentVisibility - LastVisibility) * (elapsed/.25) +
  LastVisibility`, retaining x87 precision. Negative elapsed extrapolates.

Base is stored f32 but retained extended. If includeVelocity is nonzero, discard
extended base and compute speed from the double-stored squared velocity. The
original appSqrt returns extended. Clamp `(speed-30)/170` to [0,1], then compute
`ratio * storedBase * .5 + storedBase` extended. Clamp final result [0,1].
The exec wrapper defaults its optional bool to true before argument evaluation;
EX_Nothing leaves it unchanged. It stores f32; the AICanSee internal caller
retains extended AIVisibility through multiplication by its f32 accumulator.

## Verification and runtime integration

`scripts/native-ai-visibility-oracle.py` executes the complete workers,
WorldLightRadius, scalar helper and original Core appSqrt in the hash-checked
images. It also runs both exec wrappers with original Core VectorConst,
IntConst and Nothing evaluators. Only SingleLineCheck is a recorded leaf.
The bridge captures both the exact ten-byte x87 return and the original
FST/FMUL/FSTP caller pattern, so a premature f32 conversion cannot pass.
Native reference cases were captured before the JS translation was written.

`node scripts/validate-ai-visibility.mjs` passes **41 cases**, comparing returned
bits, full actor storage, ordered query/cache state and callback mutations.
`node scripts/validate-pawn-perception.mjs` passes **55 cases + 13 existing
mutations**, now also comparing every actor's visibility-cache fields. Four
focused cases exercise this chain through the complete original native 705.

`node scripts/validate-ai-visibility-runtime.mjs` checks original linked property
offsets, the live Training actor graph, original LightSwitch.Frob/TriggerLight
bytecode and actual BSP/mover flag-6 rays. Three map snapshots match the original
worker using 42 recorded live traces. Sampled light changes from
0.16667550802230835 to 0 and back; exact .25/.5 boundaries and interpolation
through native 701 preserve the old/new values. The snapshot removes only
LightType=0 entries, which cannot reach another read or call in this body.
`validate-gm-trench-play-anim.mjs` also reaches this path through canonical
Jaime/player identities and native 705. The build passes.

Runtime services use Region.Zone and **reflected** LevelInfo.TimeSeconds.
Controlled fixtures initialize these via original BSP PointRegion and explicit
clock values; the full Level.Tick entry already writes TimeSeconds before
actor execution. The current selected Play host loop does not yet synchronize
all reflected Region/clock/velocity state or enroll NPCs after original startup.
These services therefore do not establish full NPC startup, physics, or mesh
rendering. The default radius binding is the recovered Actor virtual body;
unmodeled custom overrides, fatal assertions and native exception unwinding
remain outside scope. There is no full-illumination fallback.

Original captures live under `.cache/research/ai-visibility-*` (ignored),
including extracted Actor, ZoneInfo and LevelInfo declarations and the Training
snapshots. No original assets or binaries are committed.
