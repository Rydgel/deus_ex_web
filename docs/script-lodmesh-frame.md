# Original LodMesh animation frame evaluation

## Contract recovered before implementation

Precision (2026-10-06): GetFrame runs only from DrawLodMesh, inside the
render pass, at x87 precision control 24, so every operation below rounds to
a 24-bit significand; the "extended" notes say where a value stays on the x87
stack. The translation and the oracle follow that ([lodmesh-wasm](lodmesh-wasm.md)
"Precision control 24").

Authority: GOTY Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`
and Core.dll `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
ULodMesh::GetFrame thunk `103013bb` enters the complete body
`10355360..103568e5`. Arguments are output pointer, byte stride, FCoords by value,
render Actor, and in/out requested vertex count. Vertex-array Load runs first.

Actor bAnimByOwner (+28 bit 40) with nonnull Owner (+3c) selects the owner's
animation state; transforms still use the render actor. Requested count includes
mesh +184 special vertices, capped to FrameVerts +f0. The in/out count excludes
special vertices. Main cache key is `(renderActor.ObjectIndex << 8) + 0x1d`
(modulo u32). Blend cache keys are `(animationActor.ObjectIndex << 32) +
((slot+1) << 16) + 0x1d`, slots 0..3; the helper at `10413660` is integer64
multiply. GetFrame's inlined cache lookup locks an item; all reached normal paths
unlock it. A mesh-pointer mismatch unlocks/flushes that key, then creates a new
20 + 12*FrameVerts byte entry aligned to 8. Native cache allocation/eviction is a
separate service. The entry is mesh pointer, cached frame float, sequence FName,
valid vertex count, completion float, then cached local FVector vertices.
Creation initializes completion=1 and other header fields=0; vertex bytes are
unspecified until written.

Transform construction (`10355520..10355674`): use DrawScale (+17c) of the
render actor, except animationActor.bParticles (+194 bit4) forces 1. Multiply
mesh Scale (+100) per axis and store f32. Subtract render Location+PrePivot from
input FCoords origin with no intermediate store of that sum. Apply Core
FCoords *= render Rotation, *= mesh RotOrigin, then *= FScale(scale,0,SHEER_None).
Core rotation `1011ac80` composes yaw, pitch, roll; Core scale `1011c0a0` applies
identity shear, multiplies axes by scale and divides origin by scale. Per-pass
f32 stores and original sine-table values matter. Main output subtracts mesh
Origin (stored f32 per component), then TransformPointBy (coordinate-origin
subtraction remains extended through `(x*axis.x+y*axis.y)+z*axis.z`).

Main sequence lookup is mesh virtual +68, with animationActor.AnimSequence +54.
Normal frames (AnimFrame >=0, or no previous cache) clamp negative/unordered
frame to zero. If sequence exists, store f32(frame*NumFrames), compute integer
frame via FISTP-nearest-even of phase minus f32 .5 (`1047a158`), and fraction
f32(phase-integerFrame). Signed modulo NumFrames selects this and next frame,
wrapping within the sequence; missing sequence selects absolute frame zero.
Fraction <=0/unordered copies the first frame. Otherwise interpolate the two
signed-word vertex frames. X retains difference/product extended through final
addition; Y/Z each store difference and product f32 before the final addition.
Store local pose into cache, then transform output. This normal path updates
valid count but does **not** update cached frame/sequence/completion.

Negative/unordered AnimFrame with an existing cache enters tween mode. Clamp
requested count to the cached valid count initially and publish it. Target is
the sequence's first frame (or absolute zero); reset frame is -1/NumFrames (or
zero). Alpha=f32(1 - AnimFrame/cachedFrame). Sequence change clears completion.
If sequence changed, alpha<0/unordered, or alpha>1, store reset frame/sequence
and use alpha=0; otherwise preserve them. Completion is
f32((1-completion)*alpha+completion), compared **before rounding** to f32 .97
(`10429c4c`). Above .97, force alpha=0 and fill any newly requested vertices from
the target frame, expanding the valid count. Positive alpha updates cached
vertices with the same X/Y/Z precision asymmetry. Finally write cached frame
from the actor's current AnimFrame. There is no invented crossfade duration.

After the main pose, each non-None BlendAnimSequence (+68 array) runs the same
cache/frame/tween procedure with BlendAnimFrame (+78 array). Output is additive:
subtract the mesh's **absolute frame zero** vertex from each blend-cache vertex,
store f32, TransformVectorBy (no coordinate origin), add to existing output and
store f32. Slots execute in ascending order; each can reduce the in/out count
before the next slot. No additional blend weight field is read by this body.

## Called with a frame's Coords (2026-10-14)

DrawLodMesh passes the Frame->Coords of the frame that draws the actor, so
every call's output is in that frame's camera space; the addresses of the
call and every float store of the body are in
[LOD](script-lodmesh-lod.md) ("Camera space"). `validate-lodmesh-frame.mjs`
has 15 calls with such Coords (large origins, a pitched camera, a mirror
frame's reflected Coords with negative determinant) on LightSwitch and
GM_Trench: keyframes, a reduced count, tweens and four additive blends, all
bytes equal to the original's. `validate-lodmesh-lod.mjs --camera-chain` runs
the original GetFrame on 30 poses of the six LOD meshes and the original LOD
morph on its buffers.

Play keeps one cache per actor and publishes it once for each frame that
draws the actor: `publishLodMeshOps` runs an earlier call's operations
(`getLodMeshFrame`'s `ops`, a plan's `channels` once its cache is current)
as tweens with alpha 0, which republish the cached pose through another
matrix (`lodMeshCameraMatrix`) without touching it.

## Original comparisons and runtime integration

`scripts/native-lodmesh-frame-oracle.py` executes the complete unchanged original
function, actual mesh constructor/serializer/lazy vertex Load and original Core
coordinate/sequence helpers. Cache allocation/flush are recorded leaves;
original inlined lookup, lock counts and header/vector writes execute. Captures
were established before translating the function and remain outside Git.

`scripts/validate-lodmesh-frame.mjs` compares 46 complete calls using LightSwitch
and GM_Trench. Every output byte (including strided padding), cache header/vector
byte, in/out count, lock, Create/Flush request and archive/lazy position matches.
Cases cover repeated frames, wrapping, negative-frame tween progression and
regression, reduced/expanded counts, mesh changes, nontrivial transforms,
owner-driven animation/particle scaling and all four additive blend slots.
The pinned original sine table is reused by the translation.

`ScriptRuntime.getActorMeshFrame` binds the translation to the same prepared
canonical resource used by PlayAnim, linked actor fields and persistent cache.
Global identity uses the existing measured/modeled UObject index service; it
never substitutes a package export index. The GM_Trench runtime validator uses
Training's canonical JaimeReyes0/GM_Trench_F, with global index 34333 from the
local original GObjObjects capture. Original LoopAnimPivot/TweenAnimPivot and
animation Tick produce changing vertices and preserve the prior pose across a
new tween. The check also verifies linked transform offsets, 336 ordinary plus
three special output vertices, unchanged actor fields and released cache locks.
This is an explicitly prepared runtime fixture, not full NPC startup.

Focused commands: `node scripts/validate-lodmesh-frame.mjs` and
`node scripts/validate-gm-trench-play-anim.mjs`. `--reference-only` records the
native frame cases; `--captured` reuses them only when their complete input specs
match the current cases. Full native execution remains the default.

Full-resolution triangle/wedge interpretation and texture/skin selection are
now supplied by the separate [surface path](script-lodmesh-materials.md).
Reduced LOD, mesh lighting, NPC startup, draw submission and whole-world
enrollment remain unfinished. Cache heap allocation/eviction and native
exception unwinding remain explicit services.

For live Play, GetFrame now reuses exact loaded coordinate/origin operands
within a call and computes each vertex's origin subtraction once for all
three dot products. Interpolation also reuses loaded operands. Every x87
operation, float store, cache mutation and blend order is retained; the same
46 original captures still match byte for byte. The shared significand-width
helper counts exact uint32 limbs for values under 2^128, avoiding temporary
binary strings while preserving the wide-value fallback. This is arithmetic
overhead removal, not a change to precision, animation rate or mesh detail.

The optional [Rust/Wasm vertex kernel](lodmesh-wasm.md) now accelerates the
same inner loops in Play. JavaScript retains the GetFrame control flow and
caches. `validate-lodmesh-frame.mjs --captured --wasm` checks the same 46 native
references through the bulk-memory ABI; omitting `--wasm` checks the retained
JavaScript implementation.
