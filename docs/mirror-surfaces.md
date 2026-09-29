# Training mirror floors

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
mirrors. The names of those last two fields are not yet established; the
browser's normal view takes the enabled path. The disabled-device path clears
translucency and sets `PF_Occlude=0x80000000`.

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
