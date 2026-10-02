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
     drawn once more at whatever position the iterator left it in.
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
on the x87 model:
- Core's FRotator::Vector is `rotatorToVector`.
- UnsafeNormal is translated in place: FSQRT and the double store.
- `FVector::Rotation` is `vectorToRotator`, the hardware-validated
  FPATAN path (docs/script-pawn-locomotion.md).

`validate-native-laser.mjs` runs the unchanged DeusEx.dll body with Core's
FGlobalMath, UnsafeNormal and Rotation (`native-laser-oracle.py`). appFrand
returns the case's doubles, and XLevel's two moves are recording stubs.
- **Coverage.** 160 iterators: 1–3 active beams with inactive slots
  between, straight and random beams, zero segments, Index past every
  beam, MaxItems 0, a moved savedLoc and no proxy.
- **Result.** All 5,348 items match: every move argument, prevLoc, prevRand,
  savedLoc, savedRot, nextItem and appFrand draw.
- **Sensitivity.** Rounding X's end point to float32 fails the comparison.
- **Limitation.** Unicorn evaluates FPATAN in double precision, so the
  oracle's Rotation agrees with the host's only away from integer boundaries.

## Play

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

`validate-lasers-play.mjs` checks this on 01_NYC_UNATCOIsland. Beside
LaserTrigger0–4's doorway beams:
- each emitter has its LaserIterator;
- CalcTrace adds 158-unit beams (10 segments, MaxItems 11);
- the segments in view draw (44);
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
