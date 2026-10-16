# Original sound obstruction trace

Authority: installed GOTY Engine.dll, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
`.cache/reference/Engine.asm`. UModel.FastLineCheck export10301a37 enters
103f3280–103f3356; recursive helper is103f33a0–103f34fd.

The wrapper copies Model.Nodes.Data (+58) into the native traversal global
1058f350. No nodes returns RootOutside (+f0). Otherwise it calls the helper
with node0, the two by-value FVector arguments in their original order, and
RootOutside. This is a world-model query with no actor collision, extent,
owner transform or hit record.

The helper uses 64-byte BSP nodes. It computes the second endpoint's plane
distance first (103f33c4–103f33ea), then the first's (103f33ee–103f3418).
Each is float32((Z*nZ+Y*nY)+X*nX-W). It tests the **signed float bit pattern**
for nonnegative at103f3400/103f3420, not an epsilon or floating comparison.
The only flag consulted is node+37 bit1 (NF_NotCsg). Vertex count, NF_New
and the general LineCheck extra-node flags do not participate.

For equal endpoint sides, choose child+20 (back) or+24 (front). Update the
outside byte as `side ^ ((side ^ outside) & (flags & 1))`, at103f34cd–103f34e0.
For differing sides, retain secondDistance/(secondDistance-firstDistance)
in x87 and form each intersection component as
float32((first-second)*fraction+second), at103f342d–103f349b. The first-side
recursive call receives **intersection then first endpoint**, followed by
tail traversal of **intersection then second endpoint** on the second side.
Each side independently derives outside from the parent value. A false first
result returns immediately. A leaf index-1 returns its outside byte.

The JS translation uses an explicit stack in the same traversal order.
Float32 stores are retained; JS number arithmetic represents retained native
intermediates with the same bounded precision scope as the scene math.
Nonfinite input is explicitly unsupported. There is no movement-ray backoff
or 0.001 plane tolerance.

Before implementation, the existing NativeCollision emulator executed
103f3280 directly against one native node with plane[1,0,0,0], no vertices,
both children-1, RootOutside1. Results: front-to-front clear; back-to-back,
both crossing directions, and ±0.0001 crossing blocked; flags0x20 still
blocked; flags1 crossing clear; both endpoints on the plane clear. These
cases specifically distinguish this native from the existing general ray.
One two-node slab (root plane[1,0,0,1], back child plane[-1,0,0,1]) also
confirmed both crossing directions blocked between endpoints x=-2 and2,
while x=2 to3 stayed clear. This covers the recursive/intersection path with
two outside endpoints and an intervening solid region.
`test/fast-line-check.test.mjs` preserves that focused original reference.

Implementation: `src/runtime/fast-line-check.mjs`. The native sound helper
uses this as its default obstruction query; a supplied fastLineCheck service
can still bind an already translated native model representation. Audio
events and the complete live level graph remain separate requirements.

## Over the tracked model (2026-10-16)

The model the original traverses is `XLevel->Model` (`+0x98`), the one UModel the moving brush tracker extends in
place ([brush tracker](brush-tracker.md) "Line checks"): every mover's fragment nodes hang in it where the tracker last
left them, and FastLineCheck's link walk reaches them like any static node. Play's checks had read the map's static
BSP. Found by the Underworld sound capture `sndm` (row 4.3.6, [galaxy-audio](galaxy-audio.md)): the first shot broke
BreakableGlass0 and GlassFragment9's `GlassBreakLarge` (volume 2.0) reached Galaxy at 0.7 in the original, CheckHearSound's
blocked branch (x 0.35, `0x103e1bf3..0x103e1c13`), and at 2.0 in Play. On the static nodes both Engine.dll's
FastLineCheck under Unicorn and Play's say the line from the player to the fragment is clear, at control words 0x037f,
0x027f and 0x007f alike; on the tracked model both say blocked: the pane's fragments still stand between until the next
rendered frame updates the destroyed mover.

`fastLineCheck(model, first, second)` now reads the tracker's node block in place when the model carries
`trackedLineNodes()` (sim-host.mjs sets it on the level's model while the tracker lives; `bsp-occlusion.mjs` `lineNodes`:
the kernel's memory, the block, the node count the tracker holds and RootOutside, nodes in the original 64-byte FBspNode
layout). The traversal and its arithmetic are unchanged. Every caller follows: CheckHearSound, MakeNoise, FastTrace (native
548), the pawn natives (navigation, perception), the iterators and Galaxy's occlusion in Update.

`scripts/validate-fast-line-check-tracked.mjs` builds the tracker of 06_HongKong_WanChai_Underworld, 00_Training and
01_NYC_UNATCOIsland as sim-host does, and runs Engine.dll's FastLineCheck (`0x103f3280`,
`scripts/native-fast-line-check-oracle.py` over the NativeCollision harness) on every node of the tracked model and of
the static one: the capture's line (blocked, as the original's attenuation shows), four lines through each mover in random
directions and 400 random lines between placements per map. 1,493 lines are equal on both models; 26 are blocked only by a
mover's fragments.
