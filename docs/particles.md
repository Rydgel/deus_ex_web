# Particles (ParticleGenerator)

Stage 4, 2026-10-02. DX's smoke, steam and spray come from 123 pre-placed
`ParticleGenerator`s and from runtime spawns. None are drawn in Play yet.
This note records the original chain as it is recovered.

Authority:
- DeusEx.dll `b91002f3…bee04` (base `0x10000000`);
- Engine.dll `0c3a8b18…c20b4`;
- Render.dll `607f1077…d75d1`;
- the DeusEx.u script (`ParticleGenerator`, `ParticleIterator`,
  `ParticleProxy`).

## The chain

1. **Script.** `ParticleGenerator.PostBeginPlay` sets its own DrawType to
   DT_None and spawns a `ParticleProxy` (Effects). SetProxyData gives the
   proxy its texture, Style (Modulated, Translucent or Masked) and bUnlit.
   Each Tick, the generator first decides `bFrozen`. It is not frozen when
   it is dying, when the proxy's DistanceFromPlayer is below 320, or when
   the proxy (or a non-level Base) was rendered within 2 s. If not frozen,
   the generator calls `ParticleIterator(RenderInterface).Update(dt)`, which
   copies the owner fields and calls native 3017. Every `checkTime`, with
   probability `frequency` (FRand), it adds `numPerSpawn` particles
   (AddParticle: `ejectSpeed·vector(pRot)`, plus `0.2·ejectSpeed·VRand()`
   when bRandomEject).
2. **Renderer.** `URender::SetupDynamics` (`0x10b22f42`-`0x10b230d3`) handles
   an actor with `RenderIteratorClass` (`+0x310`).
   - It constructs the iterator into `RenderInterface` (`+0x314`) with
     StaticConstructObject (Outer = the actor) when there is none.
   - Outside the editor it then calls `Init(Viewport.Actor)`, `First()`, and
     `CurrentItem()` until `IsDone()`, building an FDynamicSprite for each
     item and calling `Next()` in between.
   - Engine's URenderIterator: Init calls the script `Init(Camera)` and
     stores Observer; First sets Index 0; Next increments it; IsDone is
     `Index >= MaxItems`; CurrentItem returns Outer.
3. **CurrentItem** (`UParticleIterator::CurrentItem`, `0x1001ab20`). For an
   active particle, it copies DrawScale and ScaleGlow onto the proxy and
   `FarMoveActor`s the proxy to the particle's Location. It returns the
   proxy, or deletes the particle when the move fails. Otherwise it returns
   the generator, whose DT_None draws nothing. Drawing really moves the
   proxy through the level, and it ends each frame at the last particle.

## UpdateParticles (native 3017, `0x1001ac50`)

Iterator layout:
- 64 particles at `+0x34`, `0x34` bytes each (bActive bit 0, initVel,
  Velocity, Location, DrawScale, ScaleGlow, LifeSpan);
- nextFreeParticle `+0xd34`, proxy `+0xd38`;
- owner flags `+0xd3c` (gravity 1, scales 2, fades 4);
- OwnerZoneGravity, RiseRate, LifeSpan and DrawScale at `+0xd40`-`+0xd4c`.

For each active particle:
- LifeSpan counts down, becoming −1 once it reaches 0; a negative LifeSpan
  deletes the particle (`0x1001aaf0`: clears bActive, sets
  nextFreeParticle).
- X and Y velocity are `float(initVel + 2) − appFrand·5`.
- Z is `dt·ZoneGravity·0.2 + Vz` with gravity, otherwise
  `(appFrand·0.2 + 0.9)·((OwnerLifeSpan − LifeSpan)·RiseRate) + initVel.Z`.
- DrawScale is `(OwnerLifeSpan − LifeSpan + 1)·OwnerDrawScale` clamped to
  [0.01, 3] when scaling, else OwnerDrawScale.
- ScaleGlow is `LifeSpan/OwnerLifeSpan` when fading, else 1.
- Location advances by `dt·V` (X keeps the unrounded product).

The proxy's bHidden is then set when no particle survived. appFrand is the
process-wide CRT stream, the script FRand's; Play must draw from the same
shared stream.

`updateParticles` (`src/runtime/script-particles.mjs`) translates it, with
the chains on the x87 model. `validate-native-particles.mjs` runs the
original after its parameter fetch (`native-particles-oracle.py`: DeusEx.dll
alone, appFrand returning the case's doubles). It covers 24 iterators over
all eight owner flag combinations, with active, expired and zero-lifespan
particles over 12 updates each (zero dt included). All 288 updates match:
every particle field, nextFreeParticle, the proxy's bHidden and the number
of appFrand draws.

## Sprites (DrawActorSprite `0x10b25080`)

For a DT_Sprite or DT_SpriteAnimOnce item:
- The function first writes `Level.TimeSeconds` to the actor's
  LastRenderTime.
- It draws one tile through the canvas (UCanvas::DrawIcon, then the render
  device's DrawTile): `(USize·Persp)·DrawScale` by `(VSize·Persp)·DrawScale`
  centred on the sprite's projected centre (FDynamicSprite::Setup's ScreenX,
  ScreenY and Persp). That is a screen-aligned quad of that world size to
  within a pixel; Play draws it with the original's vertices, see
  [frame projection](frame-projection.md#sprites-the-tile-the-render-device-receives).
- Its colour is white (an editor-selection tint in the editor), times
  ScaleGlow when that is not 1, each channel capped at 1, with no fog. The
  flags are the texture's PolyFlags, the style flags and `0x100`.
- The style flags come from `0x10b26230`: Style 2, 3 and 4 give PF_Masked,
  PF_Translucent and PF_Modulated. PF_Unlit is set unless the actor is
  lit-capable in the software renderer, so sprites are unlit here.
- The drawn texture is `Texture->Get(Viewport->CurrentTime)`
  (`0x10b2547b`, Engine `UTexture::Get`, see
  [texture animation](texture-animation.md)), so a texture with an AnimNext
  chain advances as a BSP surface's does.

### DT_SpriteAnimOnce (`0x10b252ac–0x10b25392`, restored at `0x10b254d3`)

Before the size computation, for DrawType 7 only:
1. `Count` = 1 + the length of the AnimNext chain from Texture (`+0x8c`),
   stopping at None or at Texture itself.
2. The class default actor is asserted (`Class+0x4d8`, Defaults.Num) and
   read (`Class+0x4d4`). `F = Clamp(1.0 − LifeSpan / Default.LifeSpan,
   0.0, 1.0)`: `fld f32 LifeSpan (+0x50)`, `fdiv f32 Default.LifeSpan`,
   `fsubr` the double 1.0, passed as a double to Render's Clamp
   (`0x10b12bf0`: `V < Min` → Min, else `V < Max` → V, else Max; a NaN
   compares as less, so it gives 0).
3. `X = f32(Count · F)` (`fild`, `fmul`, `fstp dword`), then
   `Num = fistp(X − 0.5f)` (`0x10b30748` = 0.5f) under the current rounding,
   round-to-nearest-even: UE1's appFloor, so `X = 1.0` gives 0.
4. `Num` is clamped to `[0, Count − 1]` (negative → 0, `≥ Count − 1` →
   `Count − 1`), and the texture advances `Num` times along AnimNext.
5. The chosen frame's AnimNext and AnimCur (`+0x8c`, `+0x90`) are saved and
   set to None for the draw, so its `Get` returns the frame itself (its
   Update still runs and stamps LastUpdateTime), and restored after it.

The render pass runs at 24-bit precision, so steps 2–3 are binary32
operations. **Not reachable in the shipped game:** no class default, map
actor (all 88 maps; 39,787 sprites) or script assigns DT_SpriteAnimOnce,
and no script package imports a texture with an AnimNext chain (the 205
animated textures are imported only by maps, for their surfaces). Play
therefore keeps DT_SpriteAnimOnce sprites on their Texture and notes it;
the contract above is recorded for completeness, not implemented.

## Per frame

SetupDynamics runs the protocol above for every frame OccludeFrame visits
(`Init(Viewport->Actor)` is the same actor in each), so a child frame runs
it again. A particle's items come out the same in every frame: the child
frame's sprite records are the root's
([child frames](bsp-occlusion.md#each-child-frames-own-setupdynamics)).

## Play

- **Native 3017** runs `execUpdateParticles` in the VM on the shared
  appFrand stream, the script FRand's.
- **The sprite scene** (`src/viewer/sprite-scene.mjs`) runs after each Play
  tick. It walks the level actor array in order with SetupDynamics'
  admission: bHidden, the first-person ViewTarget, bOnlyOwnerSee and
  bOwnerNoSee.
- **Iterators.** An actor with a RenderIteratorClass gets its
  RenderInterface built the way StaticConstructObject does it (Outer = the
  actor, class defaults), then the class constructor
  (`script-render-iterator.mjs`). URenderIterator's constructor
  (`0x103d9cf0`) clears Index (`+0x2c`) and Observer (`+0x30`), stores its
  vtable and checks that the Outer is an Actor. Then the DeusEx default
  constructor stores the class vtable: ParticleIterator `0x10027a14`,
  LaserIterator `0x100283d0`. Both vtables' Destroy (`+0x24`) is
  `0x1001aec0`, a jump to `UObject::Destroy`. The scan then runs the iterator
  protocol: the script `Init(Camera)`, Observer and Index, and
  CurrentItem's proxy DrawScale and ScaleGlow writes and FarMoveActor
  (`particleIteratorItems`).
- **Release.** `AActor::Destroy` (`0x10368f60`) ConditionalDestroys a
  non-null RenderInterface and clears it before `UObject::Destroy`. Player
  start's collection therefore releases every iterator of the old level
  ([LoadMap collection](script-loadmap-gc.md)).
- **Drawing.** Each DT_Sprite item and each admitted sprite actor draws as
  a screen-aligned three.js sprite: Fire and Wet textures (SmokePuff1 is a
  FireTexture) from the page's shared live procedural textures, raw colours
  as for surfaces, and LastRenderTime written when it renders.
- **Feedback.** Those writes, with Play's existing DistanceFromPlayer,
  are what unfreeze a generator.
- **Name hash.** A map actor has no slot in Play's object registry.
  Constructing its iterator hashes the name by the actor's measured
  GObjObjects index (`hashIndex`, from the object-index captures), and
  registry lookup and registration accept it.

`validate-particles-play.mjs` checks this on 02_NYC_Street. With the player
by ParticleGenerator3's vent:
- the renderer builds the iterator;
- the drawn proxy unfreezes the generator;
- particles spawn, live and rise;
- drawing them keeps the proxy's LastRenderTime current;
- the steam draws, with no runtime error.

Host choices and limits, noted:
- **Lighting.** Three.js draws sprites without the original's software or
  D3D span clipping. Translucent sprites blend raw colours; the display
  ramp maps the finished frame ([lighting](lighting.md), "Display ramp").
- **Not translated yet.** DT_SpriteAnimOnce's LifeSpan frame choice and
  `Get` on sprite textures (no shipped content reaches either; see
  "DT_SpriteAnimOnce"), iterator classes other than ParticleIterator and
  LaserIterator (see [lasers](lasers.md)), and the bHighDetail rule.
- **Visibility.** Play has no BSP occlusion, so every admitted iterator
  runs each frame, as SetupDynamics does. Visibility only decides which
  sprites three.js draws, and so which proxies get a LastRenderTime.

## Rust update

`native/script-vm/src/particles.rs` runs execUpdateParticles' update on
the iterator's own image cells instead of copying its 64 sParticle structs
into JavaScript and back each call: the same x87 chains (`Ext`), the same
appFrand draws in the same order (one import per draw), DeleteParticle's
two stores, and the proxy's bHidden returned for the JavaScript write.
`script-vm-particles.mjs` checks the layout (the Particles fixed array of
64 structs and every member and scalar cell of the kinds the update reads)
and admits an iterator only when each spelling resolves on its class to
that cell and the object binds none of them. The JavaScript update copied
inactive particles back as well; the Rust update leaves them untouched,
which differs only in a NaN payload a copy would canonicalize.
`PARTICLES=js` (`?particles=js`) keeps the JavaScript update;
`PARTICLES=verify` runs it on the state read before the Rust update, with
the same appFrand values, and compares every particle, nextFreeParticle and
the proxy flag. Browser runs on 02_NYC_Street and Island (400 frames
walking) found no difference; `validate-particles-play` and
`validate-native-particles` pass. Island: 0.35 → 0.01 ms per frame.

## The loop in Rust (2026-11-06)

`particleIteratorItems` (script-particles.mjs) ran the CurrentItem loop of the protocol above in JavaScript for every iterating
generator, in the root frame's scan and again in every child frame's rescan (`occ_frame_dynamics` → `childDynamics` → `rescan`). On the
Area 51 bunker's slowest tenth of actor phases it was 0.85 ms a frame against 0.11 in the rest
([plan](firefox-60fps-plan.md#the-bunker-particle-loop-2026-11-06)): 0.50 of it FarMoveActor, 0.20 `readIteratorState` (64 particle
objects with their arrays built on each call) and 0.09 the script `Init`.

### Why the proxy's FarMoveActor was declined

DeusEx.u's ParticleProxy (read with `ClassDefaults`, the package's tagged defaults) is `bMovable` and `bCollideWorld` with CollisionRadius
0 and CollisionHeight 0; bCollideActors, bBlockActors and bBlockPlayers are clear and it has no Brush (the live bunker proxies show the
same fields). So CurrentItem's `FarMoveActor(proxy, Location, 0, 0)` (Test 0, NoCheck 0) takes the original's FindSpot branch
(`!NoCheck && bCollideWorld`, `0x10398ba0`, [relocation](relocation.md) step 2) with the extent `(CollisionRadius, CollisionRadius,
CollisionHeight)` = (0, 0, 0). `far_move` declined every actor with bCollideWorld or bCollideWhenPlacing and `no_check == 0`, so each
particle's move went to relocation.mjs: `findSpot` → `queries.pointCheck` → `singlePointCheck` (which builds a hit list), the
encroachment check, `setActorZone`, and the closures `relocationLevel` builds for the call. In the slow tenth that was 0.46 ms under
`farMoveActor`, FindSpot 0.24 of it (Gecko profile, `.cache/perf/bunker-actors`).

### What the original does with a zero extent

[Fitting](fitting.md#findspot--adjustspot-contract): "A zero extent performs one SinglePointCheck and succeeds only if its return is
exactly 1" (`0x103984c9`-`0x103985c5`); neither AdjustSpot's line checks nor the corner probes run, and the caller's location is
unchanged. FarMoveActor passes `checkActors` 0, so the check is Level->Model's `UModel::PointCheck` alone ([level
points](level-points.md): MultiPointCheck queries the actor hash only when `checkActors` is nonzero), with extra node flags 0 and,
for a zero extent, `UModel::PointCheck`'s single descent (`0x103f16c5`, [point check](point-check.md)): from node 0, front when
`p.z*n.z + p.y*n.y + p.x*n.x - d > 0`, outside `||= solid` going front and `&&= !solid` going back, a node being solid with vertices
and none of the flags `0x21`. The model is the moving brush tracker's while it lives (`worldModel()`). A false return fails the move
before any store: the actor is untouched, and CurrentItem deletes the particle. On success CheckEncroachment returns false for this
actor (no collision bits other than bCollideWorld, which `checkActorEncroachment`'s `0xd` mask does not count, and no Brush: it returns
before any query), and SetActorZone runs as before.

The chain of evidence: the original's FindSpot, its SinglePointCheck and the zero-extent descent equal the JavaScript reference on
the native validators ([fitting](fitting.md): 1,112 composed cases, [point check](point-check.md), the tracked-model NaN cases); the
Rust descent equals the reference (`validate-trace-kernel`: 78,798 point cases, 42,996 inside, at plane epsilons and on the chain that
exceeds the visit guard, 0 mismatches); the Rust move equals the reference body in `verify` mode, below. The descent runs in doubles
like the reference; whether the original's pass precision (24 bits, [render pass](render-pass-precision.md)) changes a point exactly
on a node plane is not measured (the row for "ParticleIterator FarMoveActor" there stays "not measured").

### The translation

* `trace.rs point_clear`: the descent over the node records the Rust line checks read (`trace_import_bsp` for a tracked model); a link
  or cycle the JavaScript throws on hands back.
* `render.rs far_plan` / `far_commit` / `far_move`: the former `far_move` split into the decision and the stores, with FindSpot's
  zero-extent case added; `far_move` returns 1 (moved), 2 (FindSpot refused: the original's false, nothing stored) or 0 (the
  JavaScript body runs). A nonzero extent, a model the core cannot read, a zone change (SetActorZone runs script events), riders,
  collision bits, a Brush and a non-finite destination still go to JavaScript before any store.
* `particles.rs particle_items`: the CurrentItem loop over the iterator's cells and the proxy's image: Index stored at each step, an
  active particle's DrawScale and ScaleGlow copied onto the proxy, `far_plan`, `far_commit`, the item recorded, a failed move deleting the
  particle (`bActive` cleared, `nextFreeParticle` = Index). A move `far_plan` declines stops the loop before that step's stores;
  `script-particles.mjs nativeItems` takes the step as the reference does (through `runtime.farMoveActor`, so the zone's events run
  where the original runs them) and the loop goes on after it. A proxy the image cannot address returns `NOT_RUN`, and the reference
  loop takes the iterator whole. The script `Init(Camera)` and the Observer write stay in JavaScript, in their order.
* `sprite-scan.mjs`: the records of an iterator's items are made from the proxy's DrawType, Texture and Style read once for the run
  instead of for every item. The items are one proxy's and are recorded after the run, with no script between them, so each item
  finds the fields as the first does.

Switches (`?particleItems=`, env `PARTICLE_ITEMS`; `?farMove=nofit` keeps the core as it was before FindSpot's point check):
`rust` (default); `js` (the reference loop and the per-item reads; with `farMove=nofit` this is the code before this step); `verify`:
every Rust run is repeated from the state before it by the reference loop with the recovered relocation body (`relocateSpawnedActor`,
not the core) as FarMoveActor, and the particles, `nextFreeParticle`, Index, the proxy's DrawScale, ScaleGlow, Location, OldLocation,
bJustTeleported and Region, and the items are compared; the sprite records are compared with the per-item reads.

### Checks (2026-11-06)

* `node scripts/validate-particle-items.mjs --map NAME --compare` boots a map, holds its proxies as drawn, ticks, and after each tick
  runs SetupDynamics' scan and a child frame's rescan through `sprite-scan.mjs`, in `js` (the reference with `FAR_MOVE=js`), `rust`
  and `verify`; the digest of every sprite record and of the iterators' and proxies' end state must be equal. Bunker, 240 ticks:
  34,991 sprite records, 4,780 iterator runs, 305,504 steps, 33,022 particles moved, 416 steps handed back to JavaScript (a zone
  change: 0.14% of the steps); `verify` compared 5,196 runs and 33,438 records, digest `8ef26156a3375408` in all three. 02_NYC_Street:
  23,512 records, 4,302 runs, 275,328 steps, 0 handed back, `0f1d56950a3b8be4` in all three.
* In the browser, the bunker's scan route for 40 s with `particleItems=verify&farMove=verify`: Firefox inline 2,452 drawn frames, 0 page
  errors, 4,042 runs and 258,688 steps compared, 50,044 particles moved; Chromium in worker mode 2,660 drawn frames, 0 page errors, 4,232
  runs and 270,848 steps compared (`--probe-switches` lists both switches in the worker's realm, so the page's flags reach it through
  `init`, and its counters come from the worker). Per frame on that route (twelve Firefox sessions of 60 s, 45,601 frames): one scan and one
  child frame's rescan, 1.24 non-frozen iterator runs (64 steps each), 18.4 particles moved, 0.027 deleted by a refused move (1,228 in
  all: the Failed path runs outside the injection test too), no step handed back.
