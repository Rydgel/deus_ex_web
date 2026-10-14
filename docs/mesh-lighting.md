# Mesh lighting: original contract

Stage 4 rendering increment, started 2026-09-28. Until now every actor mesh
(NPCs, props, the first-person weapon) was drawn texture-only at full
brightness. This note records how the original renderer lights LOD meshes,
from Render.dll and D3DDrv.dll instructions, before any browser translation.

Sources of truth are the hash-pinned GOTY binaries: Render.dll
`607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`, D3DDrv.dll `9e0f8a42…d8ac9f`.
Addresses are virtual addresses at each DLL's preferred base. Field names come
from the SDK layouts (`scripts/sdk-layouts.mjs`), which were checked against
these DLLs; see [SDK reference](sdk-reference.md).

## Call order

`URender::DrawActorSprite` (`0x10b25080`) calls `DrawMesh(Frame, Owner,
LightSink, Span, LightSink.Region.Zone, Coords, LeafLights, Volumetrics,
PolyFlags)`; `DrawMesh` (`0x10b0d1a0`) dispatches LOD meshes to
`URender::DrawLodMesh` (`0x10b0ea80`). The light manager is the static
`FLightManager` whose vtable `0x10b2a93c` is installed at `0x10b09990`:

| Slot | Function | Address |
| ---: | --- | --- |
| +0x08 | SetupForActor | `0x10b08c70` |
| +0x0c | SetupForSurf | `0x10b06c90` |
| +0x14 | FinishActor | `0x10b098d0` |
| +0x18 | Light | `0x10b027f0` |
| +0x1c | Fog | `0x10b02c00` |

Inside DrawLodMesh, for the normal (non-editor) render path:

1. `GetFrame` fills 0x58-byte vertex records in camera space (the caller's
   `Coords` already include the view).
2. For every LOD face: the face normal is the cross product of two edges,
   normalized by the table reciprocal square root below, and added to the
   `Normal` of all three vertices (`0x10b0fe60–0x10b0ff85`). This happens for
   every face, including back faces and faces outside the frustum.
3. A face whose three outcodes share a bit is skipped. Otherwise, unless the
   face's `PF_TwoSided` is set, `dot(faceNormal, v0) · Frame.Mirror < 0`
   keeps it (`0x10b0ff9b–0x10b0ffc9`). Kept faces mark their vertices with
   `Light.X = -1.0` (`0x10b0ffcf`) and join the draw list.
4. `SetupForActor(Frame, LightSink, LeafLights, Volumetrics)` returns extra
   poly flags (`0x40000000` when volumetric lights exist), ORed into
   `PolyFlags` (`0x10b107bd–0x10b107e2`).
5. For each marked vertex (`0x10b10834–0x10b10a9d`): normalize the summed
   normal with the table reciprocal square root of `|N|² + ε`
   (`0x10b2ac2c`), set `Normal.W = N·P`, apply Fatness when
   `Fatness ≠ 128`, then `Light = GLightManager->Light(vertex, PolyFlags)` and
   `Fog = GLightManager->Fog(vertex, PolyFlags)`.
6. Faces go to the face helper (`0x10b0bab0`) in draw-list order. For
   `PF_Unlit` faces it overwrites the three vertices' `Light` with the unlit
   colour (below) before drawing (`0x10b0bbbf–0x10b0bc04`). Vertices are shared,
   so a later lit face reuses an overwritten value.
7. `FinishActor` restores `GMem` and unlocks the cache items.

### Actor poly flags

`0x10b26230` derives the actor's flags: Style Masked/Translucent/Modulated give
`PF_Masked`/`PF_Translucent`/`PF_Modulated`; `bNoSmooth` gives `PF_NoSmooth`;
`bMeshEnviroMap` gives `PF_Environment`; `bMeshCurvy` clear gives `PF_Flat`.
`PF_Unlit` is set when `bUnlit` is set, `Region.ZoneNumber = 0`, the viewing
PlayerPawn's `RendMap ≠ 5` (REN_DynLight), or `UClient.NoLighting` is set.
DrawLodMesh ORs `PF_Flat` itself.

### Unlit colour

`0x10b0f6d2`: `c = AmbientGlow·(1/256) + ScaleGlow·0.5`, clamped to `[0, 1]`,
the same for R, G and B. All `PF_Unlit` faces use it.

## Moving-light collection and deferred records (September 30)

Before SetupForActor, SetupDynamics `0x10b230e8..0x10b2311c` rejects
LightType zero, then `(bStatic || bNoDelete) && !bDynamicLight`, then zero
LightBrightness or LightRadius. These gates precede radius calculation and
dynamic-light allocation; [the recovered light contract](dynamic-lighting.md#recovered-call-order)
records the original instructions. Static lights remain available through
the mesh's BSP-leaf permeating run during SetupForActor.

The host's per-frame mesh-light view previously constructed a full
light record for every non-deleted actor with a nonzero LightType, even when
the native moving-light gate rejected it. Apply that gate first and defer
the full static-light record until SetupForActor actually requests it. This
changes allocation/read work within a synchronous render phase; it does not
cache light state across frames, omit a selected light, or change BSP list
order. A live field edit is reconsidered next frame, including changing a
static light to bDynamicLight. Original view-plane rejection and BSP span
visibility retain their existing unsupported scope.

Verification: the real Island collection retains all 285 leaf entries in
the same order while eager full records fall from 436 to 16 and property
reads from 9,392 to 3,996. Three interleaved 300-frame Node samples after
warm-up measured collection at 1.92–2.05 ms before and 0.68–0.79 ms after.
This measures collection only: a static light subsequently requested for
mesh lighting still incurs its record construction then. The focused live
mutation test passes; `validate-mesh-lighting-play.mjs` passes all 24 cases
covering 12 actors, 100 selected lights and 2,512 vertices, with zero diffuse
byte differences against either Wasm or the original native Light routine.
A separate Island Play-start census ends the complete render frame with 273
light records: 257 were requested after the initial 16. Thus the collection
count is not the total lighting work. The live frame avoids 163 of the original
436 eager records, while moving the needed static-record work into actor
preparation. Whole-frame timing must include both phases.

One scan per frame (2026-10-03, [Play CPU plan](play-cpu-plan.md) step 1.2).
The original runs this gate once per drawn frame, in SetupDynamics, after
`PlayerCalcView`. Play used to scan Level.Actors twice: `game.movingLights()`
for the light maps, before `PlayerCalcView`, and `beginFrame` for the leaf
lists. `animate()` now calls `game.movingLights()` once, after
`PlayerCalcView` and the viewport sizing. `world.syncMovingLights` and
`beginFrame({ lights })` share that list: the same gate, level and Level.Actors
order, with the light fields and Location it already read seeded into each
record. `beginFrame` without `lights` (Inspect) still scans itself.
`validate-mesh-lighting-play.mjs` hands one view the scanned list and keeps
the other on its own scan, and requires identical leaf lists (actor, index,
location bits, light fields) and identical colours. Island browser A/B: the
`lighting` phase drops from 0.75 to 0.23 ms.

## SetupForActor (`0x10b08c70`)

State: `Actor` is the light sink. `Zone` is `Actor.Region.Zone`, or the
LevelInfo when that is null. If `Region.ZoneNumber = 0`,
`ULevel::SetActorZone(Actor, 1, 0)` (vtable `+0xac`) runs first, but the zone
already loaded is kept.

**Ambient** (`0x10b08d8e–0x10b08e43`):

```
glow = AmbientGlow == 255
     ? sin(Viewport.CurrentTime · 8) · 0.2 + 0.25     // x87 fsin on the double
     : AmbientGlow · (1/255)                          // double constant
glow = float(glow)
hsv  = FGetHSV(Zone.AmbientHue, Zone.AmbientSaturation, Zone.AmbientBrightness)
Ambient = (float(glow + hsv.X), float(glow + hsv.Y), float(glow + hsv.Z))
```

**Gates.** No light is gathered (only the ambient applies) when `bUnlit` is set,
`Region.iLeaf = -1`, the level model has no leaves, `RendMap ≠ 5`, or
`UClient.NoLighting` is set.

**Fade step.** `step = clamp(_ftol((Viewport.CurrentTime −
Viewport.LastUpdateTime) · 768), 0, 255)`.

**Per-actor cache.** `GCache` item id `(Actor.Index · 256) + 0x30`, 0xcc bytes:
a count and up to 16 twelve-byte entries `(light, fade byte, light Index)`. On a
hit, entries whose `GetIndexedObject(Index)` is no longer that light, or whose
light has `bDeleteMe`, are dropped. On a miss the item is created empty and
`newCache` is set.

**Candidates** (`0x10b09059–0x10b094ec`) are stored in the light actors'
own tag fields: `ExtraTag` (`+0x10c`) holds a per-call stamp (`0x10b49eb0`,
incremented each call) so each light is taken once, `LightingTag` (`+0x100`)
the sort key and `SpecialTag` (`+0x110`) the fade. At most 120, in this order:

1. cached entries, fade from the cache;
2. the leaf's permeating static lights (`Model.Leaves[iLeaf].iPermeating`
   into `Model.Lights`, null-terminated), fade 0;
3. `LeafLights` (the moving lights filtered into this leaf), fade 255: the
   candidates SetupDynamics took (its gate and the frame's ViewPlanes sphere
   test) in the order Filter's hop parity leaves them
   ([coronas](coronas.md#leaf-lights)).

A candidate is kept when its `bSpecialLit` equals the actor's and
`dist² < R²`, with `R = WorldLightRadius()`. For `LightEffect = LE_Cylinder`
(17) both brightness and R are multiplied by 0.75. The sort key is
`FISTP(float((1 − √dist²/R) · LightBrightness · 1024))`, with `√` from the
light-manager square-root table (`0x10b3e1b8`).

**Sort.** `0x10b0b830` is Core's `Sort<T>` template (insertion-by-maximum for
eight or fewer, middle-pivot partition otherwise) with
`Compare(A, B) = A.key > B.key ? −1 : 1`: descending keys, never equal.

**Selection** (`0x10b09506–0x10b09701`), over the sorted list:

```
count = staticCount = 0; threshold = -1
for L in sorted:
  n = L.bStatic ? staticCount : count
  if L.key >= threshold and n < 8:
    if !L.bStatic and L.bMovable: visible = 1
    elif !newCache and ((L.Index ^ Viewport.FrameCount) & 15) != 0:
      visible = L.fade & 1
    else:
      visible = Model.LineCheck(End=L.Location, Start=Actor.Location, Extent=0) clear
      if visible and newCache: L.fade = 255
    if visible:
      count++; if L.bStatic: staticCount++
      if threshold == -1: threshold = L.key / 8        // toward zero
      AddLight(Actor, L)
      L.fade = min(255, L.fade + step) | 1
      continue
  L.fade = max(0, L.fade - step) & ~1
  if L.fade > 0: AddLight(Actor, L)
```

Then the cache is rewritten with up to 16 lights whose fade is above 1, in
list order. Volumetric links get `+0x30 = 1` and set return flag
`0x40000000`.

**AddLight** (`0x10b08b30`) with a non-null owner rejects a full list,
`LightType = 0`, `LightBrightness = 0` and the owner itself, and otherwise
always makes a class 2 light. `UClient.NoDynamicLights` is not consulted for
actors.

**Per light** (`0x10b097c1–0x10b0982c`): `ComputeFromActor(0, Frame)`
(`0x10b05fa0`) stores the camera-space location
`(L.Location − Frame.Coords.Origin) · axes`, `R`, `1/R`, and the colour
`FGetHSV(Hue, Saturation, 255) · typeFunction(brightness) · Level.Brightness ·
LightBrightness/255`. With no facet it stops there (`0x10b0614b`). The colour is
then multiplied by `fade · (1/255)`.

**LightType functions** (`0x10b2a284`, from `URender::GlobalLighting`
`0x10b05e90`, realtime when `ShowFlags & 0x800`): None zeroes the brightness;
Steady and BackdropLight do nothing; Pulse and SubtlePulse scale it by a
`GMath` sine entry indexed by `Level.TimeSeconds`, `LightPeriod` and
`LightPhase`; Blink and Strobe zero it on alternate phases; Flicker reads a
per-frame random table at `0x10b4fa44`. The brightness is clamped to `[0, 1]`. Translated since 2026-10-07 ("LightType
functions, Strobe and the noise" below).

## Light (`0x10b027f0`)

For `PF_Unlit` the sum is `(0.5, 0.5, 0.5)`. Otherwise, with `P` the camera-space
vertex, `N` its unit normal plane and `|P|²` computed once:

```
for each light L (skipping class 3):
  D = L.Location − P;  d² = D·D;  d = tableSqrt(d²)
  c = (D·N.xyz)/d + 1
  f = max(0, c·c − 1.5)
  R' = L.Location − N.xyz · 2·(N·L.Location − N.W)     // light mirrored in the tangent plane
  s = R'·P − |P|²
  if s > 0: f += 6·s² / (d² · |P|²)
  a = (1 − d·(1/R)) · f
  if a > 0: sum += a · L.Color
Light = min(1, sum · ScaleGlow · 1.4 + Ambient)        // per channel
```

The specular term is `6·cos²` of the angle between the view ray and the
mirrored light direction. The per-vertex path does not apply spot cones or
light effects.

## D3D output (`UD3DRenderDevice::DrawGouraudPolygon`, `0x100056b0`)

Per vertex the diffuse colour is `FISTP(Light · MaxColor · 255)` per channel,
alpha `0xff`, specular 0. `MaxColor` is the texture's cached maximum colour
scaled by `1/255` (`0x10009441–0x10009492`). When the device supports 8888
textures (`this+0x1b0`), SetTexture uses `(255, 255, 255)` instead
(`0x10008ef9`), so the factor is `float(255·(1/255))`. `PF_Modulated` polygons
use diffuse `0xffffffff`. Fog adds a specular colour only with `PF_RenderFog`.

`SetBlending` (`0x10008270`) checks Translucent before Modulated. Translucent
sets `D3DBLEND_ONE`/`D3DBLEND_INVSRCCOLOR` (`0x10008349`). Modulated sets
render states `(27,1)`, `(19,9)`, `(20,3)` at `0x1000837a–0x100083a7`, which are
`D3DBLEND_DESTCOLOR`/`D3DBLEND_SRCCOLOR`. The framebuffer therefore stores
`2·src·dst` before the display gamma ramp.

Character meshes rely on this to hide their glasses. `GM_Trench` has frame
faces (skin slot 6, `PF_Modulated|PF_TwoSided`) and lens faces (slot 7,
`PF_Translucent|PF_TwoSided`). NPCs without glasses skin those slots with
`GrayMaskTex` (every texel 128) and `BlackMaskTex` (every texel 0), so both
blend back to the unchanged background.

Play applies the gamma ramp once to the finished frame ([lighting](lighting.md),
"Display ramp"), so modulated and translucent faces blend raw colours as
the original does. With `?gamma=material` the ramp runs per fragment; for
modulated faces it then emits `pow(2·src, g)/2`, which blends to
`pow(2·src·dst, g)`, exactly the ramp after the blend (`displayRampGlsl` in
`src/viewer/light-atlas.mjs`); a plain `pow(src, g)` turned 128-gray into a
visible bright band across every face. Translucent faces are exact there
only for black or white sources.

## Precision: the render pass's 24 bits

DrawLodMesh, SetupForActor, Light and D3DDrv's DrawGouraudPolygon run inside
the render pass, under x87 precision control 24
([render-pass precision](render-pass-precision.md)). Since 2026-10-06 the
translation follows it: one binary32 operation per x87 operation, double
constants rounded once from the exact value. From the instructions:
- **Face normal** (`0x10b0fe60–0x10b0ff85`): `a = p2 − p0` and `bx` on the
  stack, `by`, `bz` stored, `n = b × a`, `((n.x² + n.y²) + n.z²) + ε`. The
  back-face dot (`0x10b0ffa3–0x10b0ffbb`) sums `(x + z) + y`, times
  Frame.Mirror.
- **Vertex normal** (`0x10b10863–0x10b1090f`): `((x² + y²) + z²) + ε`, the
  scaled components, `W = (P.x·n.x + P.y·n.y) + P.z·n.z`.
- **Light** (`0x10b027f0`): every step of the x87 reference rounds to 24
  bits; `ScaleGlow·1.4` rounds the exact product of the double 1.4.
- **SetupForActor**: the candidate distance `(dz² + dy²) + dx²` of 24-bit
  differences, `R²` rounded before the compare, the key
  `((1 − √d²/R)·brightness)·1024` (`0x10b090a7–0x10b09194`); the glow
  `AmbientGlow·(1/255)` or `fsin(CurrentTime·8)·0.2 + 0.25` (doubles,
  `0x10b08da6–0x10b08dde`); the fade `tagFade·(1/255)` kept on the stack for
  the colour products (`0x10b097ed–0x10b0980c`); FGetHSV and ComputeFromActor
  as on light maps ([moving lights](dynamic-lighting.md) "Precision"); the
  camera-space light location is TransformPointBy at 24 bits; Blink's
  `TimeSeconds·2293760` rounds before the division.
- **D3D diffuse**: unchanged (`L·1.0·255` has one rounding either way).

`lightVertexX87` runs the reference on the BigInt model with each result
rounded to 24 bits; `lightVertex`, the kernel's `light_vertex`/
`light_mesh_job`, meshlight.rs `ml_select` and the GPU passes are binary32.

Evidence at `0x007f` (the mesh-light oracle's default now, tables at
`0x037f`): `validate-mesh-lighting`: the light-manager tables, 400 face and
400 vertex normal cases, 2,049 D3D diffuse cases, 52 SetupForActor calls
(220 light infos: ambient, camera-space location, 1/R, colour; visibility
caches) and 1,248 lit vertices match; `lightVertex` equals the reference on
22,048 vertices. The 64-bit translation differed in 278 face and 208 vertex
normal cases and 1,545 of 3,744 Light channels (no D3D byte).
`validate-mesh-lighting-play` (24 live Training passes, 100 lights, 2,520
vertices) and `validate-gpu-mesh` (Training and Island: 227,928 pose
components and 701,505 colour channels equal to the CPU kernels) pass.
Cost: the kernel's `light_speed` bench (800 vertices, 8 lights, native,
five alternating runs) went from 14.98 to 10.51 ns per vertex-light.

The environment-mapping normals and UVs (`mesh-environment.mjs`, the GPU's
`ENVIRONMENT_UV`) keep their f64 form within the stated tolerance; they are
not moved.

## Wasm translation boundary

The September 28 Island profile attributed about 19 ms/frame specifically to
the presence of this mesh-lighting pass. The repeated numeric portion now runs
in `native/lodmesh-kernel`: camera transforms (since 2026-10-14 only for world-space
points; the actor layer lights the camera-space buffer GetFrame fills for the frame,
`cameraSpace`), face normals and culling, marked
vertex lighting, ordered `PF_Unlit` replacement, and diffuse-byte conversion.
The Rust code consumes the validated table bits and retains the store order and
f32/f64 intermediates of the JavaScript translation. Face topology is immutable
per preview and is uploaded once; posed vertices, camera state and selected
lights cross the boundary in bulk.

`SetupForActor` deliberately remains in JavaScript. It reads live UObject
state, walks leaf light candidates, schedules and performs original line
checks, and mutates the fade/cache records. Moving it without first moving the
object representation would trade its measured work for per-field marshalling
and make the behavior boundary harder to verify.

`test/lodmesh-wasm.test.mjs` checks difficult face ordering and output bits.
`scripts/validate-mesh-lighting-play.mjs` also runs the JavaScript and Wasm
paths over two frames of 12 live Training actors: 24 passes, 100 selected
lights and 2,512 vertices, with zero diffuse-float bit differences. The
JavaScript path in that same validator remains the bridge to the original
native reference; JS/Wasm agreement by itself is not fidelity evidence.

### Constant-cache lookup cost

The September 30 Island profile attributes 0.18 ms/frame to looking up the
memoized `ComputeFromActor` constants. The lookup used a formatted string
containing two bytes, the level-brightness float bits, and a temporary array
of the three HSV float words. It now partitions by the internally cached,
immutable HSV array and packs the remaining 32+8+8 bits into one exact
48-bit integer. Signed-zero and nonfinite level-brightness patterns retain
distinct keys. The original numeric functions and all per-draw selection,
visibility, fade and light-type state updates still run as before.

A local paired Island workload at baseline `ef47f61` repeats SetupForActor
for 304 nonhidden mesh actors, including actors outside the viewport. All
64 frames have identical selected lights, traces, ambient, light constants,
colors and persistent visibility/fade records. Two alternating-block runs
measure 2.69 to 2.46 ms and 2.85 to 2.60 ms per complete setup workload.
These are isolated setup costs, not whole-frame FPS results. Native
validation still passes 52 setup cases and the 24 live Training passes
above, with zero diffuse-byte differences. Local captures are under
`.cache/perf/mesh-light-setup-memo*` and remain outside Git.

## LineCheck and the brush tracker (2026-10-07)

The visibility test is the level model's virtual `LineCheck` (vtable slot
22, `call [esi+0x58]` at `0x10b0961f`) with Owner None, End the light's
Location (`0x10b09604`–`0x10b09615`), Start the lit actor's
(`0x10b095e3`–`0x10b09601`), a zero Extent and no extra node flags
(`0x10b0958c`). The model is Level->Model, which the moving brush tracker
fills with the movers' polygons where they were last rendered
([brush tracker](brush-tracker.md)): once NF_IsNew clears they are ordinary
solid nodes, and LineCheck's node mask (`NF_NotCsg | NF_IsNew`) does not
exclude them. A mover therefore blocks a static light's line check.

Play's view (`mesh-lighting-view.mjs`) takes that model from the BSP
occlusion's memory (`bsp-occlusion.mjs` `lineModel`, the Rust tracker's
nodes as the tracker last left them) and runs ray.mjs `traceRayFast`, the
translated zero-extent LineCheck, over it; without the tracker
(`?moverTracker=off`) it keeps the static model.

`scripts/validate-tracked-linecheck.mjs` runs Engine's unchanged
UModel::LineCheck under Unicorn
(`native-tracked-linecheck-oracle.py`, on the tracker oracle's level model
after GNewBrushTracker) beside Play's: the line checks of Helibase's
BlackHelicopter0 and the 747's RepairBot0 to every light of their leaves'
permeating lists, and six segments through every mover of the two maps
(277 and 89 checks). All agree, on the static model and on the tracked one,
and the tracked model blocks 54 and 4 of them that the static model lets
through. In particular:
- **Helibase.** The hangar's roof doors (ElevatorMover0 and 1, `hangar_door_01`,
  at Z 736) block BlackHelicopter0's checks to Light55, Light167, Light58 and
  Light50 above them. SetupForActor then keeps TriggerLight4 alone (key
  158,224; Searchlight, hue 0, saturation 0: red; a movable light is never
  traced), and the helicopter is lit red, as in the original's frame; Play
  had added the three gold lights.
- **747.** The force field `field001` (DeusExMover13–16) around Light10
  blocks RepairBot0's check to it; Play had added Light10, the brightest of
  its candidates.

Still open: the other level traces (collision, AI sight, decals) use the
static model ([brush tracker](brush-tracker.md) "Collision"), and an actor
whose region is set after GNewBrushTracker (one that moves) takes its leaf
from the tracked BSP in the original.

## LightType functions, Strobe and the noise (2026-10-07)

**Contract.** ComputeFromActor (`0x10b05fa0`) calls URender::GlobalLighting
through the render vtable (`[0x10b5a718]+0x88`, at `0x10b0611c`) with
`animate = (ShowFlags >> 11) & 1` and the light's `LightBrightness·(1/255)`
as the in/out brightness, before the colour product. GlobalLighting
(`0x10b05e90`) indexes the type table `0x10b2a284`: Pulse `0x10b05a10`,
Blink `0x10b05a90`, Flicker `0x10b05af0` (table A of the light noise at
`0x10b4fa44`, at the low byte of the actor's address; below 0.5 the light is
dark, otherwise `A·brightness`), Strobe `0x10b05b30` (dark while the global
flag at `0x10b49ea8` is set; the flag flips whenever Level.TimeSeconds
differs from the time kept at `0x10b49ea4`), SubtlePulse `0x10b05b90`;
Steady and BackdropLight return the brightness. The clamp to `[0, 1]`
follows. Everything runs inside the render pass at precision control 24.
The same function and the same globals serve three callers: SetupForSurf's
light maps, SetupForActor's meshes and Galaxy's ambient volume
(Audio->Update, game thread, before PreRender, so at 64 bits and with the
previous frame's table A).

**Translation.** `static-lighting.mjs` `lightTypeBrightness` is the one
body for all three (`brightness` in/out, `precision: 'pc64'` for Galaxy);
the separate float form mesh-lighting.mjs had (Blink and Strobe only) is
gone, and `finishSetup` takes the shared body. `light-globals.mjs` keeps,
per runtime, what the original keeps in Render.dll's globals: one Strobe
state, the light noise (advanced in the simulation, sim-session.mjs
`begin`, from the game's shared appFrand stream), the previous frame's
table A (Galaxy's) and the Flicker key. The key stands in for the actor's
address (unreproducible: allocator history): the light's map export index
for a map actor, else its Level.Actors slot, low byte, the same key the
light maps use. The texture-palette types (8, 9) are not translated; mesh
lighting keeps them steady and notes it. Census (`census-moving-lights.mjs`
`lightTypes`): 122 Flicker, 128 Pulse, 13 SubtlePulse, 8 Strobe and 2
BackdropLight map lights; no Blink and no palette light.

**One Strobe flag.** The flag flips at most once per Level.TimeSeconds,
on the first Strobe call of a frame, and only frames that make such a call
flip it; every later call in the frame sees the flipped flag, so the order
of the callers within a frame does not matter, only whether one calls.
The simulation decides it for all three: SetupForActor's own calls (mesh
lighting runs in the simulation), Galaxy's, and the light maps' calls,
which `lightMapStrobe` (sim-session.mjs) derives from the main frame's
drawn level surfaces: a drawn surface whose static light list holds a live
class 1 Strobe light, or a moving class 2 Strobe light that the
SetupDynamics filter puts on a drawn surface. The frame's flag goes to the
page with the light noise (`frame.light.strobe`, world.mjs
`beginLightFrame`), whose class 1 merge then reads it without flipping.
Approximations: the movers' own polygons (the tracker's fragment nodes)
are not searched for Strobe lights, and the Strobe lists are taken once
from the lights that are Strobe at load (no script sets LightType to
Strobe, per the census).

**Evidence.**
- `validate-mesh-light-types` (native-mesh-light-oracle.py with per-frame
  TimeSeconds, noise table A, Strobe state, GMath sines and flicker keys):
  52 mesh actors on six maps (Wan Chai Underworld, MJ12 lab, Wan Chai canal,
  Training, the NYC hotel, Helibase), 416 frames (advancing, repeated and
  jumping TimeSeconds), 1,192 light infos (Pulse 64, Flicker 88, Strobe 64,
  SubtlePulse 64, BackdropLight 32) and the Strobe state after each call
  (56 flips) match at `0x007f`; at `0x037f` 1,017 of 2,026 comparisons fail.
- `validate-light-animation`: the `pc64` form against the oracle at
  `0x037f`, 2,560 frames, no mismatch (Galaxy's caller).
- `validate-mesh-light-types-play` (headless browser, worker mode,
  `meshLightProbe`): Training's ScientistFemale0 under the Flicker Light536,
  90 frames: every light info's brightness equals `lightTypeBrightness` of
  that frame's Level.TimeSeconds, the simulation's table A, the export-index
  key and the Strobe state before the call, every colour equals the
  constants at that brightness times the fade, the table changes every frame
  and the Flicker colour takes 43 values. With `--map
  06_HongKong_WanChai_Underworld --actor HKTukTuk2 --light Light227`: the
  Pulse light, 87 frames, a new colour each frame. Strobe is not exercised
  in Play by this check (the oracle covers it).
- `validate-gpu-mesh` (Training and Island, GPU equal to the CPU kernels
  with the type functions in the light infos), `validate-mesh-lighting`,
  `validate-mesh-lighting-play`, `validate-moving-light-effects(-play)`,
  `validate-light-spatial-play` and the unit tests pass.

**Cost** (headless Chromium in worker mode, 1920×1080, interleaved rounds,
medians; scratch `ab-browser.mjs`). 824a92b against 1869442 on UNATCO
Island, six rounds each: the worker's frame 14.99 → 15.51 ms (its actor
phase 3.51 → 3.72), the page 3.24 → 3.43 ms, within the run-to-run spread.
The follow-up (0c4ff1f: the Strobe scan returns early when no flip can
happen and builds the drawn-surface set only for a moving Strobe light;
Steady lights skip the type call) against 824a92b, five rounds each: Island
actor phase 4.05 → 3.89 ms (worker 16.00 → 15.90), Wan Chai Underworld
(Pulse, Flicker and Strobe lights) 3.32 → 3.05 ms (worker 15.83 → 15.56).
The type functions stay in JavaScript: no measurement names them.

## One call per frame: child frames' lighting (2026-10-08)

Evidence first, from the hash-pinned Render.dll (disassembled with Capstone,
addresses as in the rest of this note):

- **DrawFrame draws each frame's own sprites with that frame.** `DrawFrame`
  (`0x10b1a2d0`) first recurses into each child (`0x10b1a336-0x10b1a348`,
  `esi = [esi+0x10]`, next `[esi+0xc]`, each `call 0x10b0102d` back into
  DrawFrame), then walks its own `Frame->Sprite` list (`[frame+0xa4]`, next
  `[sprite+0x10]`, `0x10b1b3f6-0x10b1b44b`) and calls `DrawActorSprite`
  (`0x10b25080`, through the thunk `0x10b011c2` at `0x10b1b446`) with
  `(Frame, Sprite)` for every one. The only other caller (`0x10b26345`) draws
  one actor with a stack sprite, not a frame's list.
- **DrawActorSprite passes that Frame down.** It calls `DrawMesh`
  (`0x10b0d1a0`, thunk `0x10b01221`) at `0x10b25624` with `Frame`
  (`[ebp+8]`), `Coords = Frame+0x34` (`0x10b25615`), the sprite's LeafLights
  (`[sprite+0xb8]`, `0x10b25604`) and Volumetrics (`[sprite+0xb4]`).
- **DrawLodMesh calls SetupForActor per call, with the frame.** At
  `0x10b107da` (`call [edx+8]` through the light manager's vtable) the first
  argument is the Frame (`edi`, loaded from `[ebp+8]` at `0x10b1062b`; its
  `[edi]` is the Viewport at `0x10b10751`), then LightSink, LeafLights
  (`[ebp+0x20]`) and Volumetrics. SetupForActor keeps the frame in a global
  (`0x10b38a7c`, stored at `0x10b08ca2`) and calls `ComputeFromActor(0, Frame)`
  for each selected light (`0x10b097e0`): it reads **Frame->Coords**
  (`Frame+0x34`: Origin, then the three axes, `0x10b0600b-0x10b06095`) for
  the camera-space light position, the Viewport's clock for the fade, and
  nothing else of the frame. DrawLodMesh multiplies the back-face dot by
  **Frame->Mirror** (`+0x20`, `0x10b0ffbb`) before comparing it with zero.
  So the actor's lighting is a function of the frame it is drawn in: its
  Coords (camera-space light positions, vertex positions, normals, specular)
  and its Mirror (which faces are kept).
- **Each frame runs its own SetupDynamics and leaves its own LeafLights.**
  OccludeFrame (`0x10b19fc0`) calls SetupDynamics (`0x10b22d90`, thunk
  `0x10b0118b`) at `0x10b1a18e` and OccludeBsp at `0x10b1a19a` for the frame,
  then gives each of its sprites `LeafLights[the actor's Region.iLeaf]`
  (`[sprite+0xb8]`, `0x10b1a1ea-0x10b1a208`), clears the lists
  (`0x10b1a213-0x10b1a265`) and recurses into the children
  (`0x10b1a26a-0x10b1a27c`, newest first). The ViewPlanes SetupDynamics tests
  the moving lights against are the frame's own.
- **A frame's Mirror is Frame->Mirror = -parent's** (the Rust core's
  `emit_frame` words, Play's `visibility().frames[].mirror`); a mirror child's
  Coords have Origin and all three axes reflected, a negative determinant.

So an actor drawn in the main frame and in a mirror (or only in a mirror,
as the player is in a bar mirror: the camera sits in his head) has one
SetupForActor and Light pass **per frame**, in DrawFrame's order (the
children before their parent, siblings in OccludeFrame's visiting order, the
main frame last). The per-actor light cache is shared by those calls, so the
order matters for an actor in several frames.

**Play** (before this change: each actor once, with the main frame's Coords
and leaf lists, and the mirror passes reused those colours; a mirror's
reflection of the player lit his vertices by the *main* camera's back-face
test, from inside his head). Now:

- `sim-session.mjs`: OccludeFrame's child frames carry their Coords, Mirror
  and ViewPlanes words; `lightFramesOf` builds, in DrawFrame's order, each
  frame's lighting frame (`mesh-lighting-view.mjs childFrame`: Origin and axes
  from Coords, `mirror`, and the frame's own LeafLights from the gate's
  survivors filtered by its ViewPlanes) with its Frame->Sprite's binding ids.
- `actor-mesh-sim.mjs`: a binding lights itself once for each child frame
  that draws it (`setupMesh(actor, fields, frame)`, `lightMesh(..., frame)`),
  then for the main frame; the GPU path's light texels are reserved per
  frame (`reserveLights(count, frameIndex)`). A decision for a child pass
  (`framePasses`) carries the frame's lighting (GPU: the light records; CPU: the
  corner colours).
- `lightMesh` keeps a face when `faceDot(face, p0, Mirror) < 0` (JavaScript,
  Rust `light_mesh_job` with the Mirror in header word 3, GLSL `uMirror`).
- Page: before a child pass (`updateActors`), the actors it draws that have
  lighting for it take it (`applyPass`); the GPU path runs the face, vertex and
  corner passes for those slots only, in that frame's Coords and Mirror
  (`gpu-mesh.mjs beginLightRun`/`lightRun`, the same shaders keyed by a
  lighting stamp), and the main frame's pass gives them their own lighting
  back the same way. CPU-path bindings swap their corner colours.

**Verification.**

- `validate-mesh-lighting`: the back-face test's compare against the
  original's own `fmul [eax+0x20]; fcomp` (`0x10b0ffa3-0x10b0ffc9`) on 600
  random and degenerate faces, half with Mirror -1 (0 differences); a version
  that ignores Mirror fails.
- `validate-mesh-lighting-play`: besides its 12 Training actors in two main
  frames, the same actors lit in two child frames (a plane's reflected Coords
  with Mirror -1; one whose ViewPlanes reject every moving light, so its
  LeafLights are empty while the first has 16 leaf lists) against the original's
  SetupForActor and Light with those Coords and leaf lists (48 passes, 0
  differences, JavaScript and Wasm equal), and every face's kept/dropped test
  of the child frame against the original's compare (2,645 faces, 1,336 kept,
  the lit vertices equal). Mutations (Mirror ignored; the main frame's
  LeafLights in the child) fail it.
- `validate-gpu-mesh`: each compared actor is lit again through the page's
  lighting run in a reflected frame (all three axes reflected, Mirror -1) and
  restored; the corner bytes match the Wasm kernel (Training: 5 actors, 480
  corners; Island: 898 actor captures, 279,420 corners; max byte error 0, 0
  drawn disagreements and the restore exact in both).
- The matched capture ([visual acceptance](visual-acceptance.md#the-players-reflection-in-a-mirror-2026-10-08-fixed-per-frame-lighting)):
  JC's reflected face in the Paris Club's bar mirror, Play over the original
  1.86 → 1.34 (the frame's own gap is 1.33), mean abs. diff. 11.7 → 3.4, edge
  recall 0.64 → 0.99; the NPC and chairs in the same mirror from 1.19/1.03/0.69
  and 1.0/1.05/0.67 to the frame's R/G/B gap.
- `validate-mirrors-play` and `npm test` pass.

**Cost** (Paris Club mirror view, worker mode, five interleaved A/B rounds of
400 frames, medians, the Linux host's iGPU): the page's mirror phase 2.14 →
2.32 ms (a lighting run before the child pass and one restoring the main
frame's after it), the simulation side's actors 1.38 → 1.46 ms, the page's
frame work 5.34 → 5.50 ms; the 16.6 ms vsync interval, the draw calls (111)
and the mirror calls (60) are unchanged.

## Not reproduced / open

* Fog and volumetric lights (`PF_RenderFog`); Training's leaves have none.
* A child frame's LeafLights follow OccludeBsp's visited nodes only through
  the same approximation as the main frame's (every node visited). Its LOD
  choice and GetFrame count are its own since 2026-10-08
  ([LOD](script-lodmesh-lod.md#play)); its Volumetrics are not computed: the
  original passes each sprite's Volumetrics (`[sprite+0xb4]`) from DrawActorSprite
  to SetupForActor, which returns `0x40000000` and links the volumetric lights
  for `GLightManager->Fog`, for the sprites of every frame, so a child frame's
  would differ from the main frame's; Play computes no actor Volumetrics in
  any frame (above), so there is nothing per frame to reproduce yet.
* The texture-palette light types (8, 9), steady with a note; no map light
  uses them. Flicker's key is the export index or Level.Actors slot, not the
  actor's address.
* `GCache` eviction: an evicted item restarts the fades as a new cache.
* Spot cones: the per-vertex path ignores them in the original too.
