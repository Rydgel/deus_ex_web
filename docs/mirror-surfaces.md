# Mirror surfaces

## Original contract, recovered before implementation

The installed `00_Training.dx` (SHA-256
`bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d`)
has 46 mirrored BSP surfaces. All have flags `0x08840004`, including
`PF_Mirrored=0x08000000` and `PF_Translucent=4`, normal `(0,0,1)`, and
Z in `-128,-144,-160,-176`. The entrance floor is Z=-128. The mirror
comes from the compiled model, not from material gloss or a guessed strength.

Authority is the local original DLLs, not another engine implementation:

| Binary | SHA-256 |
| --- | --- |
| Render.dll | `607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1` |
| Core.dll | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| D3DDrv.dll | `9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f` |

`URender::OccludeBsp` at `0x10b1886d–0x10b18b93` checks the mirror
flag, limits child-frame depth to below 3, checks viewport actor flags at
`+0x5fc` bit `0x800`, and checks render-device field `+0x5c` for translucent
mirrors. `+0x5c` is `ShinySurfaces` (see "All maps" below); the name of the
actor field is not yet established, and the browser's normal view takes the
enabled path. The disabled-device path clears translucency and sets
`PF_Occlude=0x80000000`.

The enabled path reflects the camera Origin across the node's world plane and
each of its three axes across the plane normal. With unit normal N and plane
equation `dot(N,P)=W`, these are `P'=P-2N(dot(N,P)-W)` and
`A'=A-2N dot(N,A)`. It preserves all three reflected axes, reversing handedness;
rebuilding a right-handed look-at camera loses that reversal. It negates
`FSceneNode.Mirror` (`+0x20`) and supplies the negative plane transformed into
the parent view as NearClip. Geometry on the original viewer's side of the
mirror survives. The child receives the surface span buffer and screen bounds.
`CreateChildFrame` (`0x10b15a40`) merges matching child frames, including exact
clip-plane equality. `DrawFrame` (`0x10b1a336–0x10b1a348`) draws children before
the parent. The translucent mirror face then gets `PF_Occlude` at `0x10b18b87`.

`UD3DRenderDevice::SetBlending` (`0x10008270`) selects, for Translucent:
render states `(27,1),(19,2),(20,4)` at `0x10008349–0x100083e1`: enable
blending, `D3DBLEND_ONE`, `D3DBLEND_INVSRCCOLOR`. `PF_Occlude` enables depth
writes via state `(14,1)` at `0x10008427–0x10008438`. Thus the texture/lightmap
source S composites over reflected destination R as **S+R(1-S)** per channel.
There is no extra reflection opacity, Fresnel term, blur, or roughness factor.
This happens in the original display-encoded framebuffer, before the display
gamma ramp. See [lighting](lighting.md) for that separate ramp.

## Original references

`scripts/native-mirror-oracle.py` executes unchanged Render.dll instructions
`0x10b188ce–0x10b18b55`, with original Core.dll vector/coordinate operations,
and reads the actual CreateChildFrame arguments. It also executes the complete
D3D SetBlending body, recording calls to a COM device stand-in (only the device
call is stubbed). `scripts/validate-mirrors.mjs --reference-only` records 12
frames (three camera orientations, the four actual Training planes) and blend
traces before the browser implementation. Camera inputs are float32 fixtures
derived from the saved positions/orientations, not a claim about native rotator
trigonometry. Original results stay in `.cache/stage4-mirror-original.json`.

The existing original-game capture `reports/lighting/start/native-frame.png`
establishes visible entrance-floor reflections
at the saved player eye `(-1149.24353,825.84393,-40.2)`, HFOV75, 926×603.
The user also supplied a native entrance screenshot with the emblem, door,
pillars and plants reflected in the floor. Assets and captures remain outside Git.
The saved side-view capture has a darkened "Saving" overlay and is **not** a
brightness acceptance reference. The game's Shot bitmap and native window
capture also differ in presentation; comparisons below use the native window
as in the existing lighting work.

## Browser translation and checks

`viewer/mirrors.mjs` groups supported coplanar faces, renders a full-resolution
reflected view, and clips against the original world plane. It preserves the
reflected matrix's negative determinant. For WebGL submission it negates the
child camera's local X axis and samples the target right-to-left; those two
screen-space reflections cancel, preserving the original view without changing
material culling state between child and parent draws. Marker overlays, HUD and first-person weapon draws are outside the
child. Actor geometry/UVs use the reflected eye and restore the parent eye after
the pass. One global clipping-plane shader shape stays active across both child
and parent submissions; the parent uses a zero normal, while each child receives
the original mirror plane. This avoids changing every material's three.js
program variant without changing clipping. Original textures and lightmaps use the same display-encoded colours
in the target as on screen; Three's default linear render-target output cannot
be used for this legacy blend. Gamma is 1 during the child draw. The floor
shader computes S+R(1-S), then applies the configured display gamma once and
writes depth. No opacity or exposure was fitted to the screenshot.

`node scripts/validate-mirrors.mjs` compares the actual adapter with the original
12 frames and clip planes, verifies handedness, the 46-surface census, and both
blend-state traces. Build and 16 existing lighting/render-data tests pass.
`browser-tests/lighting.spec.mjs` passes with both saved camera orientations,
brightness/lighting controls and authored unlit surfaces preserved.

At the saved entrance view, browser identity gamma versus the native window
capture gives mean absolute RGB error **3.328/255** for floor region
`[350,360,610,525]` and **5.281/255** for the reflected emblem region
`[440,462,490,511]`. Rectangles exclude HUD and plant meshes. The reflected
emblem's location, doorway and pillar boundaries align visually. These regional
measurements establish the restored reflection, not pixel-equivalent lighting.
`browser-tests/mirrors.spec.mjs` records the local captures/comparison under
`.cache/mirrors/` and checks clipping with geometry behind the mirror plane,
resizing and render-state restoration. All checks passed, including the native
capture comparison (3.756/255 floor, 5.594/255 emblem in that run). The visual
comparison requires the local native capture; without it the test annotates its
absence and runs only the integration checks. These tolerances accommodate the
existing static/moving-light reconstruction differences, not a reflection-strength
adjustment.

## Scope and unresolved branches

This slice targets static, upward-facing horizontal Translucent mirrored BSP
floors, including Training's four authored heights. Moving mirrors, nonparallel
recursive mirror views, portal/sky combinations and other mirror material modes
are not verified here. Original BSP span visibility and child merging are not
yet reproduced by the browser's depth-buffer renderer. Existing mesh lighting,
plant texture and lightmap precision differences remain separate fidelity gaps.
Do not treat this slice as complete Stage 4 acceptance.

## All maps (2026-10-02)

The shipped single-player maps have 211 mirrored static BSP surfaces in 49
maps. By orientation and treatment:

| Orientation | Composited (`flags & 0x47`) | Opaque |
| --- | --- | --- |
| Up (floors, Training's 46 among them) | 110 | 1 |
| Vertical (wall mirrors) | 84 | 13 |
| Down | 1 | – |
| Oblique | 2 | – |

Thirteen mover brushes also carry a mirrored polygon. Most are cabinet or
wardrobe doors.

**Plane.** OccludeBsp reflects across `[ebp-0x1c]`, the FBspNode, whose first
16 bytes are its FPlane. `mirrorPlanes()` in `viewer/mirrors.mjs` reads that
plane for each mirrored surface. All 211 surfaces have exactly one node plane,
giving 80 distinct planes across the maps (117 counted per map, because
repeated maps share them). The browser groups surfaces by the exact node
plane, the same equality CreateChildFrame uses to merge children. The
reflection itself (`MirrorByPlane`/`MirrorByVector`) has no orientation case.

**After the child frame.** `10b18b58–10b18b93` decides how the parent draws the
mirror surface. `[ebp-0x30]` holds `flags & 0x47`
(Invisible|Masked|Translucent|Modulated, set at `10b182d9–10b182de`) and
`[ebp-0x4c]` holds `Viewport->RenDev` (`Frame->Viewport+0x64`, at
`10b17489–10b174a0`).

- A composited mirror keeps its flags plus `PF_Occlude`.
- Otherwise, if `RenDev+0x48` is set, the code takes `10b19a53`.
- Otherwise the surface also becomes `PF_Invisible`: the parent draws nothing
  there, and the reflected child shows unmodified.

Engine's `URenderDevice::StaticConstructor` (`103713c0`) registers its config
properties at `+0x58` VolumetricLighting, `+0x5c` ShinySurfaces, `+0x60`
Coronas, `+0x64` HighDetailActors, `+0x38` Description, `+0x44` DescFlags and
`+0x78` DetailTextures. Those offsets match the SDK header's whole-DWORD
fields, which places `SpanBased` at `+0x48`. SpanBased is not a config
property, and no instruction in D3DDrv.dll writes `+0x48`, so on D3D it stays 0.
The shipped `Default.ini`/`DeusEx.ini` set `ShinySurfaces=True` for
`D3DDrv.D3DRenderDevice`.

`scripts/native-mirror-oracle.py` now also executes `10b18b58–10b18b93` for
every mirrored flag word in the maps, statics and movers alike.
`mirrorDrawFlags()` matches it, giving `flags|0x80000000` when
`flags & 0x47` is set and `flags|0x80000001` otherwise. The frame cases cover
3 cameras × the 80 map planes as well as Training's 12. The oracle's stack
now starts below the segment's deepest local (`ebp-0xd94`); before, pushes
from `ebp-0x400` could overlap locals. Adapter comparisons allow 4 float32 ulps
of the largest magnitude involved, because the original computes in float32
and the adapter in doubles. The Training frames still match within the old
absolute bounds.

**Browser.**

- **Static surfaces.** Static mirrored surfaces of every orientation
  render their plane's reflected child.
- **Composited mirrors** draw S+R(1−S) as before. **Opaque mirrors** draw R
  alone, with depth written as PF_Occlude.
- **Children first.** Every visible plane's child renders before any mirror
  shows its reflection, and each child hides only its own plane's faces.
  `mirrors.enabled = false` is a diagnostics switch that draws every
  mirror without its reflection.
- **Checks.** `scripts/validate-mirrors-play.mjs` faces the 02_NYC_Bar
  translucent wall mirror and the 02_NYC_Hotel opaque unlit bathroom mirror.
  It checks that a child renders, that the frame changes with the reflection
  and that no runtime error occurs. The Training spec still passes against the
  native capture. With the current static lighting it gives 2.04/255 for the
  floor region and 3.87/255 for the emblem.

**Mover mirrors.**

- **Groups.** A mover's polygons join the level BSP through the brush tracker
  (`0x1037b5c0`) whenever the brush moves, so a mirrored mover polygon
  reflects across its own world plane. Each such polygon is its own group
  (thirteen movers carry one).
- **Plane.** The group's plane is the brush-local `[N, N·base]` node plane
  under the mover's current transform, recomputed before every mirror pass.
  The tracker's exact float32 node plane is not reproduced: this plane is
  host-computed in doubles. The reflection itself is the verified one.
- **Check.** `validate-mirrors-play.mjs` faces 02_NYC_Smug's DeusExMover7
  (translucent): both of that map's planes render, and the frame changes
  with the reflection.

**Unsupported, explicitly noted in Play.**

- **Masked, modulated and two-sided mirrors** (none in the shipped maps) are
  likewise drawn as ordinary surfaces.
- **Nested reflections.** A mirror seen inside another mirror's reflection
  draws its surface without a nested reflection. The original nests children
  while `Frame->Recursion < 3`.
- **Opaque mirrors on a span-based device.** The `+0x48` SpanBased path is a
  software-renderer branch and is not translated.
- **No capture yet.** There is no original-game capture of a wall mirror.
