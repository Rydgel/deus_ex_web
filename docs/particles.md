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
- It draws one tile through the render device: `Texture.USize·DrawScale`
  by `VSize·DrawScale` times the projection, centred on the projected
  Location. That equals a screen-aligned quad of that world size.
- Its colour is white (an editor-selection tint in the editor), times
  ScaleGlow when that is not 1, each channel capped at 1, with no fog. The
  flags are the texture's PolyFlags, the style flags and `0x100`.
- The style flags come from `0x10b26230`: Style 2, 3 and 4 give PF_Masked,
  PF_Translucent and PF_Modulated. PF_Unlit is set unless the actor is
  lit-capable in the software renderer, so sprites are unlit here.

## Play

- **Native 3017** runs `execUpdateParticles` in the VM on the shared
  appFrand stream, the script FRand's.
- **The sprite scene** (`src/viewer/sprite-scene.mjs`) runs after each Play
  tick. It walks the level actor array in order with SetupDynamics'
  admission: bHidden, the first-person ViewTarget, bOnlyOwnerSee and
  bOwnerNoSee.
- **Iterators.** An actor with a RenderIteratorClass gets its
  RenderInterface built the way StaticConstructObject does it (Outer = the
  actor, class defaults). It then runs the iterator protocol: the script
  `Init(Camera)`, Observer and Index, and CurrentItem's proxy DrawScale and
  ScaleGlow writes and FarMoveActor (`particleIteratorItems`).
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
- **Not translated yet.** DT_SpriteAnimOnce's LifeSpan frame choice (the
  first frame is drawn), iterator classes other than ParticleIterator and
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
