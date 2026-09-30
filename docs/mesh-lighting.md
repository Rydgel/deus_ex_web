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
3. `LeafLights` (the moving lights filtered into this leaf), fade 255.

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
      visible = Model.LineCheck(End=Actor.Location, Start=L.Location, Extent=0) clear
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
per-frame random table at `0x10b4fa44`. The brightness is clamped to `[0, 1]`.

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

Play applies the gamma ramp per fragment. For modulated faces it emits
`pow(2·src, g)/2`, which blends to `pow(2·src·dst, g)`, exactly the ramp after
the blend (`displayRampGlsl` in `src/viewer/light-atlas.mjs`). A plain
`pow(src, g)` turned 128-gray into a visible bright band across every face.
Translucent faces are exact only for black or white sources: `pow(s,g) +
pow(d,g)·(1 − pow(s,g))` differs from `pow(s + d − s·d, g)` for other colours,
as it already does for world surfaces.

## Wasm translation boundary

The September 28 Island profile attributed about 19 ms/frame specifically to
the presence of this mesh-lighting pass. The repeated numeric portion now runs
in `native/lodmesh-kernel`: camera transforms, face normals and culling, marked
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

## Not reproduced / open

* Fog and volumetric lights (`PF_RenderFog`); Training's leaves have none.
* Flicker's random table and the texture-palette light types (8, 9).
* `GCache` eviction: an evicted item restarts the fades as a new cache.
* Spot cones: the per-vertex path ignores them in the original too.
