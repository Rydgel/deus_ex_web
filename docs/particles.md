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

## Not yet done

- native 3017 in the VM;
- the render-iterator protocol and CurrentItem in Play;
- the proxy's FarMoveActor;
- sprite drawing (Render.dll's sprite path);
- the LastRenderTime and DistanceFromPlayer feedback that unfreezes a
  generator.
