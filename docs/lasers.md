# Laser beams (LaserIterator)

Stage 4, 2026-10-02. DX's security lasers and beam triggers draw their beams
through a render iterator. The single-player maps hold 141 `LaserTrigger`s in
18 maps and 49 `BeamTrigger`s in 11.

Authority:
- DeusEx.dll `b91002f3…bee04`;
- Render.dll `607f1077…d75d1`;
- Core.dll `8bf3039e…`;
- the DeusEx.u script (`LaserTrigger`, `LaserEmitter`, `LaserProxy`,
  `LaserIterator`, `LaserSpot`).

## The chain

1. **Script.** `LaserTrigger.PostBeginPlay` spawns a `LaserEmitter`.
   - The emitter's PostBeginPlay spawns a `LaserProxy`: DT_Mesh `LaserBeam`
     (a DeusExItems LodMesh), STY_Translucent, skin `LaserBeam1`.
   - `LaserEmitter` is DT_None with `RenderIteratorClass=LaserIterator`.
   - **Tick.** Each Tick (unless frozen: the proxy is over 960 units away
     and was last rendered more than 2 s ago), CalcTrace traces with
     TraceTexture and reflects off PF_Mirrored surfaces up to twice. It calls
     `LaserIterator(RenderInterface).AddBeam` for each leg and moves a
     LaserSpot to each hit. `AddBeam` stores the beam 8 units forward with
     `numSegments = len/16 + 1` (`len/15 + 1` for bRandomBeam).
   - **No beam before the first render.** Until the renderer has built the
     RenderInterface, no beam is added.
2. **Renderer.**
   - SetupDynamics builds the iterator, as for particles (docs/particles.md),
     and the script `Init` sets MaxItems: the active beams' segments plus
     one ("render the last one"), or 0 when frozen or hidden.
   - SetupDynamics then calls CurrentItem for each Index.
   - **Snapshot.** Each item's FDynamicSprite is built by SetupSprite
     (`0x10b23910`), which snapshots the returned actor's ScaleGlow
     (`+0x18c`→`+0xbc`), DrawScale (`+0x17c`→`+0xc0`), Location
     (`+0x114`→`+0xc4`) and Rotation (`+0x120`→`+0xd0`).
   - **Deferred draw.** DrawFrame later calls DrawActorSprite for every
     sprite. For a mesh, `0x10b2556a–0x10b25655` writes the snapshot into the
     actor, calls DrawMesh and restores the actor's own values. Every segment
     therefore draws, and is lit, where CurrentItem put the proxy.
   - **Proxy's own draw.** The proxy is also an ordinary level actor: it is
     drawn once more, from the copy its frame's SetupDynamics took of it after
     the iterator last moved it ([the proxy's own sprite](#the-proxys-own-sprite-2026-11-06)).
3. **CurrentItem** (`ULaserIterator::CurrentItem`, `0x1001a1a0`; First, Next
   and IsDone are URenderIterator's). With no proxy, it returns Outer through
   the base CurrentItem. Otherwise it proceeds in four steps:
   - **Beam and alpha.** Active beams accumulate numSegments (int32). The
     beam holding Index is chosen, or beam 0 with the whole total past the
     last. The position along it is
     `α = clamp(1 − (cumulative − Index)/numSegments, 0, 1)`; FCOM against
     the doubles 0.0 and 1.0, with unordered clamping to 0.
   - **Position.** `pos = Loc + (End − Loc)·α` with
     `End = Loc + XAxis(GMath.UnitCoords / Rotation)·Length`. Y and Z store
     the end point to float32, while X keeps the 80-bit product on the stack.
   - **bRandomBeam.**
     - A rejection-sampled `(2·appFrand − 1)³` inside the unit sphere. The Z
       square multiplies the unrounded value by its float32 store.
     - Its `UnsafeNormal` (Core `0x10117dd0`) plus prevRand is added to pos.
     - The proxy faces `(prevLoc − (2·pos − prevLoc)).Rotation()`.
     - prevLoc becomes `2·pos − prevLoc`, with Z taken from the unrounded
       sum, and prevRand becomes the normal.
   - **Moves.** `XLevel->FarMoveActor(proxy, pos, 0, 0)` and then
     `MoveActor(proxy, 0, rotation, Hit)`.
   - **savedLoc.** While savedLoc still equals Outer's Location (FCOMP C3,
     so equal or unordered), a float32 appFrand is drawn. If
     `nextItem/MaxItems` exceeds it, savedLoc and savedRot take this item.
   - **Last item.** nextItem increments. On the last item the proxy is moved
     to savedLoc/savedRot, so the last item's snapshot sits there too.

`laserCurrentItem` (`src/runtime/script-laser.mjs`) translates CurrentItem
on the x87 model at the render pass's precision control 24 (since
2026-10-06): CurrentItem runs from SetupDynamics, between URender::PreRender
and PostRender ([render-pass precision](render-pass-precision.md)).
- Every add, multiply, divide and FSQRT rounds to 24 bits with the x87's wide
  exponent (`x87-pc24.mjs` `p24*`); loads and the float stores are unchanged.
- Core's FRotator::Vector is `rotatorToVector` (table lookups, unaffected by the
  precision control; the table's entry 8192 is the real x87 FSIN's, not a host sine:
  [fitting](fitting.md)).
- UnsafeNormal is translated in place: FSQRT and the double store (exact of
  a 24-bit value).
- `FVector::Rotation` (Core `0x10144390`) is `vectorToRotator24`: the root
  `√(y² + x²)` at 24 bits, FPATAN as the host's `Math.atan2` (precision
  control does not affect FPATAN), and the product with the embedded double
  `10430.219195527361` (`0x10178050`) rounded once from the exact value
  before the truncating `ftol`. The 64-bit `vectorToRotator` stays the
  game-thread form (docs/script-pawn-locomotion.md).

`validate-native-laser.mjs` runs the unchanged DeusEx.dll body with Core's
FGlobalMath, UnsafeNormal and Rotation (`native-laser-oracle.py`), under
control word `0x007f` (`ORACLE_CW` overrides it). appFrand returns the
case's doubles, and XLevel's two moves are recording stubs.
- **Coverage.** 160 iterators: 1–3 active beams with inactive slots
  between, straight and random beams, zero segments, Index past every
  beam, MaxItems 0, a moved savedLoc and no proxy.
- **Result.** All 5,348 items match: every move argument, prevLoc, prevRand,
  savedLoc, savedRot, nextItem and appFrand draw. The 64-bit translation
  matched the oracle at `0x037f` but failed 8,021 of 42,785 checks at
  `0x007f` (prevRand, prevLoc, the proxy moves, savedLoc and savedRot).
- **Cost.** Over the same 5,348 items, seven interleaved rounds (Node, Linux
  host): median 8.98 µs per item for the 64-bit model, 7.87 µs at 24 bits.
  Island's five doorway beams have 55 items.
- **Sensitivity.** Rounding X's end point to float32 fails the comparison.
- **Limitation.** Unicorn evaluates FPATAN in double precision, so the
  oracle's Rotation agrees with the host's only away from integer boundaries.

## CurrentItem in Rust (2026-11-05)

`native/script-vm/src/laser.rs` translates `laserCurrentItem` statement for statement onto the Rust x87 model (x87.rs) at
precision control 24, set for the call and restored after it; `laser-kernel.mjs` runs it in the script VM kernel instance,
passing the state through its `LASER_IO` words, with appFrand from the caller's stream and FPATAN as `Math.atan2`, as
`vectorToRotator24` takes it. `laserIteratorItems` calls it once the kernel is loaded; `?laser=js` (LASER=js in Node) keeps the
JavaScript body, and `?laser=verify` also runs that body on a copy of the state with the same appFrand values and throws on a
difference in the moves, the state or the draws.

- **Against the original.** `validate-native-laser.mjs` runs both bodies over its 160 iterators: all 5,348 items match the DLL's
  CurrentItem in each (10,544 proxy moves, 2,805 random-beam items, 17,551 appFrand draws).
- **In Play.** `?laser=verify` held for 40 s of the frame-time route on the Airfield and the Island; `validate-lasers-play` and
  `validate-iterator-frames-play` pass.
- **Cost.** On the Airfield CurrentItem took 0.65 ms of the worker frame in JavaScript (about 8 µs an item) and takes 0.18 ms in
  Rust, the state's crossing included; the sprite phase went from 1.02 to 0.60 ms. The rest of the loop is the proxy's
  FarMoveActor (its zone update, 0.11 ms) and the script `Init` (0.11 ms).

## Per frame

OccludeFrame runs SetupDynamics again for every child frame, so a frame in
a mirror or sky pass runs this chain again: `Init` resets nextItem, prevLoc,
prevRand, savedLoc and savedRot, and CurrentItem draws the stream again, so
the last item (the one saved at a random place along the beam) is elsewhere
in each frame ([child frames](bsp-occlusion.md#each-child-frames-own-setupdynamics)).
Each frame draws its own items: an item that differs from the root frame's at its
slot is a binding of its own, posed and lit in the frames that hold it (2026-10-11).

## The proxy's own sprite (2026-11-06)

A LaserProxy is drawn twice by SetupDynamics: as its iterator's items (above) and as the level actor it is. The second is an
ordinary FDynamicSprite, built when the frame's SetupDynamics visits the proxy in Level.Actors order, after its emitter (the
emitter's PostBeginPlay spawns it; on 03_NYC_Airfield the ElectricityEmitters are Level.Actors 1068-1071 and LaserProxy0-3
1193-1196).

**Original.**
- `FDynamicSprite::Setup` (`0x10b23910`, bytes read from Render.dll) loads the sprite's actor from `[this+0x94]` and copies, for
  any actor, ScaleGlow (`+0x18c` to sprite `+0xbc`), DrawScale (`+0x17c` to `+0xc0`), Location (`+0x114` to `+0xc4`) and Rotation
  (`+0x120` to `+0xd0`), before the DrawType test.
- `DrawActorSprite`'s mesh branch (`0x10b2556a..0x10b25655`, one body for every DT_Mesh sprite) saves the actor's four fields,
  writes the sprite's copies into the actor, calls DrawMesh and restores the actor's.
- So a frame draws the proxy's own sprite from the fields the frame's SetupDynamics found, which are the fields its emitter's
  last CurrentItem left (the last item moves the proxy to savedLoc/savedRot). `URender::OccludeFrame` runs SetupDynamics for the
  root frame, OccludeBsp, then OccludeFrame for each child frame (its own SetupDynamics, the iterators again), and only then
  does DrawFrame draw, so when it does the proxy's live Location is the last SetupDynamics', the last child frame's.
  The root frame's own sprite still draws from the root frame's copy.

**The failure.** `?renderScan=verify` on the Airfield stopped on `LaserProxy3 word 4 differs in mesh_reads` (Firefox inline;
`LaserProxy0` in Chromium's worker) in the fourth frame of the authored view (position 5118.8, -2438.2, 87.75, yaw -16396), and in
sim-split's paused-clock run of the same view. An instrumented Firefox run (counters and both values in the message, not kept) showed
the order: the root scan had moved the proxy to x = 5040.54 and `meshReads` read that into the block; one child frame's
SetupDynamics (`rescans` 2 at the reads, 3 at the update), run by `occlude` between the reads and the binding's update, had moved it
on to x = 5069.32, the last item of that rescan (the `scan` count had not moved); the binding's JavaScript reads then saw the later
one. So the block holds the root frame's copy, which is the value the original draws the root frame's sprite with, and it is the
update's reads that are late: a real stale read, not an artifact of the check. The default path used both values in one update. The
block's Location chose the LOD, the SetupForActor fields, the cull sphere and whether the pose changed, while GetFrame's matrix and
the lighting passes' camera matrix (`lodMeshCameraMatrix`) read the actor's live Location, the last child frame's;
`?renderScan=js` read the live fields throughout. It reaches the pixels whenever the proxy's own sprite is drawn in the root frame in
such a frame: with the player centred on `LaserProxy3` under sim-split's clock, 2 of the 24 updates over four views of six frames
found the live fields different from the root's copy and 1 drew the proxy in the root frame; that frame's pixels were `3ccf6f17...`
(both the Rust and the JavaScript reads, drawn at the last child frame's place), and are `b19cfe6a...` with the fix (both reads
again equal); the other 23 frames' pixels are unchanged. (At the authored view the proxies are behind the player: the check
failed, nothing drawn changed. The draw-state digest of `validate-sim-split --draw-state` holds visibility flags only, and was the
same with and without the fix.)

**Fix.** The sprite scan keeps the copy each iterator run leaves (`proxies`, sprite-scan.mjs: the proxy's fields as
`laserProxySnapshot` reads them after the run, with the emitter's Level.Actors index), for the root scan and for each rescan;
the mesh layer's update of a level-actor binding whose actor has a copy, when the live fields differ from it, writes the copy into
the actor for the update and restores the fields after (`updateSprite`, the swap the items already use), as DrawActorSprite does.
The block and the JavaScript reads then see the root frame's copy, which is the value `verifyReads` compares: the check now
compares the Rust read with the scan's copy, not with whatever a later SetupDynamics left. The camera frames of a
ViewportWindow (`updateFrame`) pass their own root rescan's copies. A proxy that precedes its emitter in Level.Actors would be
copied as the previous run left it (not translated: the swap is skipped, and `verify` throws).

**Checks (2026-11-06).** `?renderScan=verify` on the Airfield for 60 s of the scan route (four headings): Firefox inline 3,141
frames and Chromium's worker 4,411 frames with no runtime error (30 s without the fix: stopped in the first frames, both
browsers); `validate-render-scan-verify-play` (new: the authored view and each proxy centred, 8 frames each, under verify) passes
and fails without the fix; the state digests of `bench-sim --render-feedback` are those of master on the Island, Training, the
Airfield, WanChai Market and the Area 51 Bunker; `validate-lasers-play`, `-iterator-frames-play`, `-actor-mesh-scene`,
`-native-laser`, `-sprite-setup` and `-spawn-mesh-binding` pass. The original is not measured here: the order of the copies and
the draw is read from Render.dll's bytes (`0x10b23910`, `0x10b2556a..0x10b25655`, OccludeFrame/DrawFrame, above), with no capture
of a beam compared.

**Not translated.** A child frame's own sprite of the proxy: the original gives the proxy's sprite in each child frame the fields
that frame's run left, so its Setup candidate (visibility in the child frame), its LOD, pose and lighting in that frame differ
from the root's. The port updates a binding once per tick, so the proxy's own sprite in a child frame takes the root frame's copy
(and the child frame's candidate is the root's packed words, `patchDynamics`); the proxy's items are exact in every frame. A
fix would treat the proxy's own sprite as one more item slot of its iterator (an extra binding per differing copy).

## Play

- **Construction.** The LaserIterator is built with its recovered class
  constructor and Destroy, as the ParticleIterator is
  ([particles](particles.md), "Iterators"). Player start releases it with
  the old level (`validate-island-player-start.mjs`).
- **Iterator pass.** The sprite scene's SetupDynamics pass runs a
  LaserIterator through `laserIteratorItems` on the shared appFrand stream,
  using `setScriptRotation`, the zero-Delta MoveActor path. It returns the
  DT_Mesh item snapshots.
- **Frame order.** The pass now runs before the actor mesh scene's update,
  so the proxy's own draw sees this frame's iterator result. A spawned
  proxy follows its emitter in Level.Actors.
- **Drawing.** The actor mesh scene keeps one LaserProxy preview per item
  slot. Each preview updates with the proxy's ScaleGlow, DrawScale, Location
  and Rotation swapped to its snapshot, then restored, as DrawActorSprite
  does. GetFrame and mesh lighting therefore see the snapshot. Items draw
  whatever the proxy's bHidden.

`validate-lasers-play.mjs` checks this on 01_NYC_UNATCOIsland, with the
simulation in the worker (the default; decal-probe.mjs `placeProbe` and
`laserProbe` act and read on the simulation side, the page's actor mesh
draw reports which item bindings it shows). Beside LaserTrigger0–4's
doorway beams:
- each emitter has its LaserIterator;
- CalcTrace adds 158-unit beams (10 segments, MaxItems 11);
- the segments in view draw (33 of 55 in the validator's view since BSP
  occlusion; the same with the 64-bit model and with `--query sim=inline`);
- drawn proxies keep a current LastRenderTime;
- there is no runtime error.

The beam out of view is culled, which Play takes from the frustum as
SetupSprite's visibility does.

Not translated yet, noted:
- DrawActorSprite's appFrand use on other mesh branches;
- BeamTrigger visuals beyond the shared emitter (BeamTrigger hides its
  beam unless the player has a visor);
- LaserSpot's FlatFX draw, which uses the ordinary mesh path;
- original-game captures of a beam.
