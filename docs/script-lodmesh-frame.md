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

## A zero DrawScale (2026-10-18)

Every explosion draws one: `ShockRing.Tick` sets
`DrawScale = size·(Default.LifeSpan − LifeSpan)/Default.LifeSpan`, and a ring
spawned in a tick is ticked in that tick before its LifeSpan is decremented
(script Tick precedes the LifeSpan block, [actor tick](script-actor-tick.md)),
so the frame that first draws it has DrawScale 0 (class default 1, LifeSpan 0.5).
FDynamicSprite::Setup takes it (the render bound `(v − Origin)·0 ∓ 1` stays
finite, `render-mesh-bounds.mjs`), DrawActorSprite stamps LastRenderTime and
DrawLodMesh calls GetFrame with mesh Scale·0. GetFrame composes Core's
`FCoords *= FScale` (`0x1011c0a0`), whose tail divides the origin by the scale
(`fdiv` at `0x1011c39d`, `0x1011c3a5`, `0x1011c3ae`) after multiplying the axes
by it: under the masked x87 control word the origin becomes ±inf (NaN for a zero
component) and every published point `(v − Origin)·(axis·0)` is the x87
indefinite (negative quiet NaN). DrawLodMesh's outcode block
(`0x10b0efd3`–`0x10b0f073`, the main vertices `0x10b0f0f2`–`0x10b0f192`) takes
each of the four terms' **sign bits** through the tables at
`0x10b2abbc`–`0x10b2abc8` (4, 8, 0x10, 0x20), so every point is flagged on all
four planes, every face's three outcodes share a bit and no face is drawn
([mesh lighting](mesh-lighting.md) "A face whose three outcodes share a bit is
skipped").

`lodMeshFrameMatrix` used to refuse a zero scale (Play paused at the first
explosion, Island scene `exp1`). It now runs the same arithmetic (JavaScript
division gives the same ±inf and NaN), so the cache work of the call is the
original's and its published points are NaN. Not reproduced bit for bit: the
NaN's sign (JavaScript publishes the positive quiet NaN where the x87 stores the
negative indefinite) and the draw path that consumes it: Play's GPU drops
triangles with NaN positions where DrawLodMesh flags them out. Both draw
nothing for that frame, and no simulation state reads the points. A nonfinite
DrawScale is still refused.

## The first GetFrame is the first draw's (2026-10-30)

**Report.** In 00_Intro, at the camera's cut to the clinic (the camera at
(301, -6503, -45), under "Why contain it?" and "...the underclasses are starting
to get desperate"), the six waiting pawns (BumMale1, Doctor0, BumFemale1,
JunkieMale0, BumMale7, Hooker1) stood with their arms out and relaxed into
their idle over about 0.3 s. The original shows them in their idle pose from
the first frame.

**The pawns' state is the original's.** All six are authored with
`bForceStasis` true. `ScriptedPawn.Standing`'s `Stand` label sets
`bStasis = True` and calls `PlayWaiting`, whose `LoopAnimPivot('BreatheLight', ,
0.3)` starts a tween (`AnimFrame` -0.2, `TweenRate` 0.667). The next tick's
`AActor::InStasis` ([actor tick](script-actor-tick.md): bForceStasis skips the
physics test, the pawn is far from the camera and never rendered) holds the
animation there. The original's trace `in2` (`.work/live-acceptance/00_Intro/
original-trace-in2.jsonl`) has BumFemale1 at `BreatheLight` -0.2, `bStasis` 1,
`bForceStasis` 1 and `LastRenderTime` -10 from unfrozen tick 52 to tick 2088,
the tick whose end cuts the camera to the clinic. Tick 2089 reads
`LastRenderTime` 114.599327, tick 2088's clock: the first frame after the cut
drew the pawns with `AnimFrame` -0.2, and the tween runs from tick 2089 (frame
-0.1889, then 0 at 2106). Play's simulation is the same: headless and in
the page, the pawns hold -0.2 until the cut and resume when stamped.

**What the original draws then.** That frame's DrawLodMesh is the pawn's first
GetFrame call. In Engine.dll the only reference to the body `0x10355360` is its
export thunk's `jmp` at `0x103013bb`; nothing in Engine.dll calls the thunk or
the body. Of the shipped DLLs, only Render.dll imports
`?GetFrame@ULodMesh@@QAEXPAVFVector@@HVFCoords@@PAVAActor@@AAH@Z` (non-virtual,
SDK `UnMesh.h`; Editor.dll imports the classic `UMesh::GetFrame`). Render's
IAT slot `0x10b5d6b4` is reached by `call [slot]` at `0x10b0ee0f`, in
DrawLodMesh, and by an import thunk `jmp [slot]` at `0x10b276e2` that nothing
calls, jumps to or stores. So no cache item exists before an actor's first
draw, and that call takes the normal path above: the negative frame clamps to
zero, the pose is the sequence's first frame (`BreatheLight`'s), and the cache
header keeps the creation values (frame 0, sequence None, completion 1). The
next draws tween from that pose toward the same frame, which shows no change.
(`python3 -I scripts/scan-lodmesh-getframe-callers.py` prints these sites.)

**What Play drew.** The actor layer made each binding's cache item at the
admission, at the map's load, when the pawns still held their serialized
`Fighter` frame 0: arms out, the T-pose. Two pieces made that item the one
the first draw found:

1. `meshBindingSteps` runs a GetFrame when it creates the binding, to have a
   first pose and bounds for the page. `update` already ran GetFrame only for
   drawn bindings (the main frame's Frame->Sprite or a child frame), but the
   admission's item was never thrown away.
2. The intro's first frame has an empty render viewport (`renderViewport`
   0×0: `drawWorld` false; the page draws no 3D, and `begin` runs no
   OccludeBsp). The session still ran the actor layer for it with no
   Frame->Sprite and, as mirrors might render, no culling at all. Every
   admitted binding took a drawn update: it was posed and lit, in `Fighter`
   frame 0.

At the cut the first real draw found that item, took the tween path (its
sequence None ≠ BreatheLight: reset, alpha 0) and drew `Fighter` frame 0, then
tweened to BreatheLight's first frame as the pawn's tween ran.

**The change.**

* `actor-mesh-sim.mjs`: a binding remembers whether a frame has drawn it. The
  first drawn update empties its cache before its GetFrame (CPU) or plan (GPU,
  `planGpu(requests, first)`, the same flush as the first-pass rule in
  [GPU mesh](gpu-mesh.md) "First pass"). It does so only when the pose (or the
  LOD's requested counts) changed since the admission. When nothing changed,
  the admission's call had the same inputs on an empty cache, so its output and
  cache are those of the first draw's call, and it stands: a binding first
  drawn before its pose changes (most of them, drawn from their admission
  frame) makes the same records as before.
* `actor-umesh-sim.mjs` (the classic meshes) applies the same rule. Render's
  DrawMesh calls UMesh::GetFrame through the vtable (`+0x70`, [UMesh](umesh.md)).
  Its other virtual call sites are **not traced**.
* `sim-session.mjs` `actors()`: a Play frame that draws no world gives the
  layer an empty Frame->Sprite. No binding is drawn, posed or lit in it, as
  DrawLodMesh and SetupForActor are not reached. The layer still admits new
  actors. This applies the existing "a frame whose render viewport is empty
  draws no 3D" ([sim worker](sim-worker.md)) to the actor layer. How the
  original reaches no actor draw in such a frame (DrawWorld skipped, or a
  zero-size frame) is the existing model and was not traced here.

**Against the original.** A new capture of the original under Wine (tag
`cl1`: `scripts/live-original.sh 00_Intro --ticks 2100 --delta 0.0166666675
--monitor 20 --tag cl1 --no-ghost --original-brightness 0.666667 --shot cl1z
--shot-ctrl --cmds "2088:@ctrlshot cl1a|2089:@ctrlshot cl1b"`, `DX_HYPRLAND=0`
under the prefix's virtual desktop) repeats `in2`: the cut at the end of
unfrozen tick 2088 and BumFemale1 at BreatheLight -0.2 in stasis until then.
Its frames are held after tick 2088 (level time 106.184181, the first clinic
frame), after 2089 and at 2100. In each, the pawns stand in their idle pose.
Play's replay of that trace (`live-acceptance.mjs play --tag cl1 --ticks N
--shot name --phonemes ... --no-ghost --keep-traveling`), compared with
`conversation-acceptance.mjs compare --scene intro` (whole frame, 1280×720):

| Frame | Tree | identical | over 10 off the edges | edge recall/precision | pawn regions, mean abs. difference (BumFemale1, BumMale1) |
| --- | --- | --- | --- | --- | --- |
| cl1a (2088) | before | .567 | 215,802 | .548/.517 | 3.87, 8.91 (the arms out, BumMale1 in `Fighter`) |
| cl1a (2088) | after | .959 | 66 | .998/.998 | 0.055, 0.045 |
| cl1z (2100) | before | .450 | 109,707 | .691/.664 | 2.09, 4.84 (mid-tween out of `Fighter`) |
| cl1z (2100) | after | .652 | 335 | .995/.995 | 0.36, 0.21 |

cl1a after the change is inside the conversation gate's thresholds (.94
identical, 150 off the edges, .99 edges). In cl1z the silhouettes agree. The
rest is a uniform one-level difference over the whole frame (mean absolute
R/G/B 0.32/0.24/0.17) and one flickering block at the right doorway (x 1240).
That is lighting state at the held frame, not pose. The original against
itself differs as much (`in2r` in3 .642, [visual acceptance](visual-acceptance.md)),
and it was not examined further. Stored: `.work/acceptance/00_Intro/cl1{a,b,z}-original.png` (and `-time.txt`), `.work/live-acceptance/00_Intro/*-cl1.*`.

**Checks.** `scripts/validate-first-draw-pose.mjs` (headless, the worker's
`createSimHost` and `session.frame`, 00_Intro): the first frame has `drawWorld`
false and no visible binding record. At each clinic pawn's first drawn frame,
the pawn is at BreatheLight -0.2, and the binding's pose equals GetFrame on an
empty cache word for word. The pose a cache made at the admission tweens from
must differ from it (more than one unit: 18 to 25 units here). On the tree
before the change the check fails: 60 bindings visible in the first frame,
and every pawn's first drawn pose is the tween from the admission's `Fighter`
cache. Play (worker, Chromium, the New Game path) frames
of the cut: `.work/hospital-tpose/shots-clinic-before/` (T-pose at frame 0,
relaxed by frame 8) and `shots-clinic-after/` (posed at frame 0).

Digests against the untouched tree (bf0a01ca, headless):

* frame-alloc-meter, identical: Island 600 frames after 900
  (`c8cf5fff928609c1`), Training 400 after 200 (`e4b017e7b1bc0439`), and
  `--warm 0` Island (`ff75e37ad00c6185`) and Training (`24dff4e600df8641`).
* frame-alloc-meter on 00_Intro `--warm 0` (400 frames): 27 frames differ, all
  from this change.
  * Frame 0, the empty viewport: 60 bindings drawn before, none now.
  * Frames 1, 139, 162 and 167: Earth1, the stealth pistol, MaggieChow0,
    BobPage0 and WaltonSimons0 send their first draw's material, groups and LOD
    records at their first real draw instead of at frame 0. Their GetFrame
    plans are equal.
  * Frames 140 to 161: only the frame's pack differs (the plans and
    SetupForActor results it carries), while MaggieChow0's first draw runs its
    course.
* bench-sim (it has no actor layer): Island `15e3720088490242` and Training
  `148077479825af78`.
* hud-stream-digest `--stream` (1500 frames): `16bfe2bd08ed1653`.

All but the `--warm 0` Island run are also the references in
[first frames](first-frames.md). Also passing:
validate-npc-mesh-preview, -spawn-mesh-binding, -actor-mesh-scene,
-mirror-plan-play (the collapsed canvas: 24 resizes and switches), -gpu-mesh,
-sim-split, -travel-newgame-play, and `node --test test/lodmesh-calls.test.mjs
test/hud-compositor.test.mjs`. The replays' frames are in
`.work/hospital-tpose/replay-before/` and `.work/acceptance/00_Intro/cl1{a,z}-play.png`.

**Not modelled, as before.** GCache's own eviction (`CacheSizeMegs=4`):
the original can lose an item of an actor not drawn for a long while and take
the normal path again, while Play keeps it. GCache's flushes at a map's load or
`FLUSH` were not traced (each binding's cache is new with the binding).

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
