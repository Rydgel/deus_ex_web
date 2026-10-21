# Actor.ParabolicTrace (native 722)

Authority: the installed GOTY `System/Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base `0x10300000`) and
`Core.dll` (`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`). The declaration is
Engine.u's

```
native(722) final function float ParabolicTrace(out vector finalLocation, optional vector startVelocity,
  optional vector startLocation, optional bool bCheckActors, optional vector cylinder, optional float maxTime,
  optional float elasticity, optional bool bBounce, optional float landingSpeed, optional float granularity);
```

Callers in the shipped scripts (`node scripts/dump-script-function.mjs DeusEx ScriptedPawn.AISafeToThrow
ScriptedPawn.GetProjectileList`): `AISafeToThrow` passes all ten arguments (`ParabolicTrace(pos1, RotatorToVector(rot1) *
ProjectileSpeed, TraceStart, true, Extent, 5, throwClass.default.elasticity, throwClass.default.bBounce, 60,
throwAccuracy)`, once per throw angle) and `GetProjectileList` nine (`ParabolicTrace(pos, curProj.Velocity,
curProj.Location, true, Extent, maxTime, elasticity, curProj.bBounce, 60)`) for a `PHYS_Falling` projectile. Both are
ScriptedPawn code reached in single player.

## Code map (all recovered from the binary)

| What | Address | Notes |
| --- | --- | --- |
| registration | `0x1037f490`: `GRegisterNative(722, cell 0x1047cc00)` | thunk `0x1030152d` -> exec |
| `AActor::execParabolicTrace` | `0x1036e190..0x1036e3af` | argument evaluation and defaults, then the worker |
| worker | `0x1036c0a0..0x1036c84a` (thunk `0x10301a73`) | the stepped trace; 10 stack arguments, `ret 0x28` |
| slide helper | `0x1036ca90..0x1036cf03` (thunk `0x1030240f`) | one step: trace, back off, move, PointRegion |
| `TwoWallAdjust` | `0x10323770..0x103239a0` (thunk `0x10301c8a`) | the sliding adjustment on a second hit |
| `UModel::PointRegion` | `0x103f5db0` (thunk `0x1030391d`) | `ret 0x14`: hidden FPointRegion, zone, location |
| `ULevel::MultiLineCheck` | `Level` vtable `+0xc8` | `ret 0x34`: Mem, End, Start, Extent, bCheckActors, Level, extra |
| `AActor::IsOwnedBy` | `0x1034c8d0` (thunk `0x103020db`) | walks `Owner` (`+0xc4`) from the hit actor, equality included |
| Core `FVector` ops | ctor `0x10117690`, `operator*=` `0x101179f0`, `operator+=` `0x10117950`, `SizeSquared` `0x10117b70`, `SafeNormal` `0x10144be0`, `appSqrt` `0x10123290` | read, not assumed (below) |

## The exec

`execParabolicTrace(FFrame& Stack, RESULT_DECL)` first zeroes `GPropAddr`, then steps the ten parameters in order.
Each optional parameter's buffer is filled from the actor **immediately before** its expression is stepped, so an
omitted argument (EX_Nothing) keeps the default and an expression sees the actor as it is at that point:

| # | parameter | buffer default (exec instruction) |
| --- | --- | --- |
| 0 | `out vector finalLocation` | `GPropAddr` if the expression set it, else a private stack temporary (`0x1036e1c3..0x1036e1d3`) |
| 1 | `startVelocity` | `Velocity` (`+0x144`) |
| 2 | `startLocation` | `Location` (`+0x114`) |
| 3 | `bCheckActors` | `bCollideActors` (`+0x1dc & 1`) |
| 4 | `cylinder` | `(CollisionRadius, CollisionRadius, CollisionHeight)` (`+0x1d4, +0x1d4, +0x1d8`) |
| 5 | `maxTime` | `5.0f` (`0x40a00000`) |
| 6 | `elasticity` | `0.9f` (`0x3f666666`) |
| 7 | `bBounce` | `bBounce` (`+0x1ec >> 4 & 1`) |
| 8 | `landingSpeed` | `60.0f` (`0x42700000`) |
| 9 | `granularity` | `0.025f` (`0x3ccccccd`) |

It then consumes EX_EndFunctionParms (`Stack.Code++`), calls the worker with `this` in ECX, and `FSTP`s the worker's
float to `*Result` (`0x1036e3aa`). The worker's pointer arguments are the buffers of parameters 0, 1, 2 and 4; the
by-value arguments are `maxTime, elasticity, bBounce, landingSpeed, granularity, bCheckActors`.

Translation: `execParabolicTrace` in `src/runtime/script-actor-parabolic-trace.mjs`. The script VM passes an omitted
argument as `undefined` and may pass fewer arguments than ten (`GetProjectileList` passes nine); both read as EX_Nothing.

## The worker

All floats below are float32 words; `ext` marks a value kept unrounded in the x87 register (64-bit significand, the
game thread's control word as the other translations assume; see "Precision"). `St(x)` is an FST/FSTP float32 store.

1. **Granularity clamp** (`0x1036c0ef..0x1036c13b`): `g < 0.005f` (`0x3ba3d70a`, the value stored too) or unordered ->
   `0.005f`; else `g >= 1.0f` -> `1.0f`; else unchanged. NaN therefore becomes 0.005.
2. State: `Pos = *startLocation`, `Vel = *startVelocity`, `Hit` = a zeroed 44-byte FCheckResult with `Time = 1.0` and
   `Item = -1`, step counter `i = 0`, `done = 0`. `Region = Model->PointRegion(Actors(0), Pos)` once, before the loop
   (`0x1036c1ba`; `GetLevelInfo` asserts at `0x1036c16c..0x1036c1b4`, `appFailAssert` lines 0xf1 and 0xf2).
3. **Loop** (until `done`), `zone = Region.Zone`:
   1. `Vel += g * ZoneGravity` (`ZoneInfo +0x31c`): X and Y products are stored (`St(g*Gx)`, `St(g*Gy)`) before the add,
      Z's product `g*Gz` stays `ext`. New `Vel = (St(Vx+..), St(Vy+..), St(Vz+..))`, but the Z sum stays `ext` too.
   2. `Delta = (St(St(Vx + Zvx) * g), St(St(Vy + Zvy) * g), St((Vz_ext + Zvz) * g))` with `ZoneVelocity` at `+0x328`; the
      Z lane uses the unrounded sum from step 1 (`0x1036c28e`).
   3. **Slide** (below) with `(this, &Pos, Delta, &cylinder, bCheckActors, &Region, &Hit)`. It moves `Pos`, replaces
      `Region` and fills `Hit`.
   4. If the **new** `Region.Zone` has `bWaterZone` (`+0x388` bit 0): `i = 0`, `Pos = *startLocation`, `done` (continue at 7).
   5. Else if `Hit.Time < 1.0` (the double `0x104298a0`; unordered counts as a hit), `hitStep = 1`:
      * If `Hit.Normal.Z > 0.7` (the double `0x1042adc0`; `lt`, equal and unordered all mean "wall"): a floor-like
        hit ends the trace unless `bBounce`, and with `bBounce` ends it when `landingSpeed*landingSpeed > |Vel|^2` with
        `|Vel|^2 = (Vz*Vz + Vy*Vy) + Vx*Vx` in `ext` (`0x1036c33d..0x1036c36b`).
      * Otherwise (a wall, a fast bounce) reflect: `d = (Ny*Vy + Vz*Nz) + Vx*Nx`; `Vel' = (Vel - 2 d N) * elasticity`
        built as `t = N*d` (X lane `ext`), `St(t * -2.0f)` (`0x1042adb8`), `St(Vel + t)`, `St(. * elasticity)` per lane.
        The remainder of the step slides along the wall: `Rem = St(St(Delta - St(N * (Delta.N))) * (1 - Hit.Time))` with
        `1 - Time` an `ext` double minus float, and `Delta.N = (Dy*Ny + Dz*Nz) + Dx*Nx`.
      * If `Rem . Delta >= 0` (`(Rz*Dz + Ry*Dy) + Rx*Dx`; negative or unordered skips this): **second slide** of `Rem`
        from the new `Pos`. If it hits again (`Hit.Time < 1.0`): reflect `Vel` on the new normal M the same way
        (`d = (My*Vy + Vz*Mz) + Vx*Mx`, then `St(Vel + St(St(M*d) * -2.0f))`, `* elasticity`); then the floor test
        again with `M.Z` (not bounce -> `done`; bounce -> `done` when `ls^2 > St(|Vel|^2)`, `|Vel|^2 = (x*x+y*y)+z*z`
        as Core's `SizeSquared`); then **always** `TwoWallAdjust(SafeNormal(Delta), &Rem, M, N_first, Hit.Time)` and a
        **third slide** of `Rem`; if not `done`, `Hit.Time < 1.0` and `Hit.Normal.Z > 0.7`: not bounce -> `done`,
        bounce -> `done` when `ls^2 > St(|Rem|^2)`.
   6. (not in water and no hit: nothing.)
7. **Terminal velocity** (`0x1036c74a`), unless `bBounce && hitStep`: `St(|Vel|^2)` against `TV*TV` (the current
   `Region.Zone`'s `ZoneTerminalVelocity`, `+0x33c`, product `ext`); if larger (ordered), `Vel = SafeNormal(Vel)` then
   `*= TV` (`operator*=`: `St(TV * c)`).
8. `i++`. Terminate (`i = 0`, `Pos = *startLocation`, `done`) when `Region.ZoneNumber == 0` (the byte at the region's `+8`:
   outside every zone), or `i * g > maxTime` (`fild i; fmul g` against `maxTime`, strictly greater), or
   `SizeSquared(Delta) > 2500000.0f` (`0x1042adb4`, the register value, not the stored one: a step longer than 1581 units).
   `maxTime` NaN never ends the original; the translation throws after 5,000,000 iterations instead.
9. Return `*finalLocation = Pos` and `St(i * g)` (`fild`, `fmul`, the caller stores it).

Consequences worth stating, all measured against the original:

* A trace that never lands (free flight, timeout, water, outside the world, step too long) returns **time 0** and
  `finalLocation = startLocation`. A landing returns `i * g` where `i` counts the step in which the impact happened,
  and is **still subject to the step-8 tests after the increment** (a landing step can fail the `maxTime` test).
* Entering water returns time `g` (step 4 sets `i = 0`, step 8 increments it), not 0, unless the step-8 tests fail.
* A step whose slide returns early (below) keeps the **previous** `Hit` and `Region`: the third slide's follow-up tests
  can read the second hit's time and normal.
* Walls always reflect, `bBounce` only matters for floors (normal Z > 0.7) and for skipping the terminal clamp.

## The slide helper (`0x1036ca90`)

`slide(Level, Actor, Start*, Delta, Extent*, bCheckActors, Region*, Hit*)`, cdecl, returns 0 when the final `Hit.Time` is
not above 0 (`fcomp qword 0.0`), else 1. The worker ignores the return value.

1. **Early out**: if each of `|dx|, |dy|, |dz|` is below `0.0001` (the double `0x1042ac40`; `fchs` on negative, NaN counts
   as below) return 1 at once: `Start`, `Region` and `Hit` are untouched.
2. `*Hit` = zeroed FCheckResult (`Time = 1.0`, `Item = -1`). `len2 = (dz*dz + dy*dy) + dx*dx`, stored to a double
   (`fstp qword`), `r = appSqrt(len2)` (`fld qword; fsqrt`, `ext`), `Size = St(r)`, `inv = 1.0 / r` (`fdivr qword`, `ext`).
3. Unit direction `dir = (St(dx*inv), St(dy*inv), St(dz*inv))` (X's product `dx*inv` is also kept `ext`).
   `E = Delta + 2 dir` is the length asked of the level: `Ez = St(dz + St(dir.z + dir.z))`, `Ey = St(dy + St(dir.y +
   dir.y))`, `Ex = St((dx*inv)_ext*2 + dx)`: Y and Z double their stored direction, X doubles the unrounded product.
4. `End = (St(Ex + Sx), St(Ey + Sy), St(Ez + Sz))` (the stored `E`), then `Level->MultiLineCheck(GMem, End, *Start,
   *Extent, bCheckActors, Actors(0), 0)`. The first result `r` in list order for which `Actor` is not owned by the
   caller (`r.Actor->IsOwnedBy(Actor)` false) and either `r.Actor == Actors(0)` or `bBlockActors` (`+0x1dc` bit 2)
   is set is copied into `*Hit` (44 bytes).
5. `Move = Delta`. If `Hit.Time < 1.0` (unordered counts): `T' = (2.0f + Size) * Hit.Time` (`ext`, also stored as `Tf`);
   if not `T' > 2.0f`: `Move = 0`, `Hit.Time = 0`; else `Move = St(St(E * Hit.Time) - St(dir * 2.0f))` per lane and
   `Hit.Time = St((Tf - 2.0f) / Size)`: the hit is backed off by two units and `Hit.Time` becomes the fraction of
   `Delta` actually moved.
6. `Start += Move` (`operator+=`: `St(Move + Start)`), `*Region = Model->PointRegion(Actors(0), *Start)`, and
   `FMemMark::Pop`.

## TwoWallAdjust (`0x10323770`)

`TwoWallAdjust(Desired, &Delta, HitNormal C, OldHitNormal D, HitTime t)`. `dot = (Cy*Dy + Dz*Cz) + Cx*Dx`.

* `dot <= 0` or unordered (a crease): `cross = C x D` (each lane `St(a*b - c*d)`, the original's operand order),
  `n = SafeNormal(cross)`, `s = ((nz*Bz + ny*By) + nx*Bx) * (1.0 - t)` (`ext`), `Delta = St(n * s)` per lane; then
  `Desired . Delta = (Wz*Bz + Wy*By) + Wx*Bx < 0` for Desired W (unordered flips) negates every lane (`St(B * -1.0f)`, signed zeros included).
* `dot > 0`: `into = (Cy*By + Bx*Cx) + Bz*Cz`; `tz = St(into*Cz)`, `ty = St(into*Cy)`, `tx = into*Cx` (`ext`);
  `r = (St(Bx - tx_ext), St(By - ty), St(Bz - tz))`; `m = St(1.0 - t)`; `Delta = St(r * m)`; and the result is zeroed
  unless `Desired . Delta > 0`.

## Evidence

`scripts/native-parabolic-trace-oracle.py` runs the real exec, worker, slide helper, TwoWallAdjust and the Core vector
routines from the hash-checked DLLs in Unicorn (x87 control word `0x037f`). Only the two level services are doubles,
recorded per call: **PointRegion** (a fixture zone table answering by position) and **MultiLineCheck** (a fixture of
half-spaces and vertical cylinders swept by the extent, returned as an FCheckResult list in time order). The filter loop
that consumes the list (IsOwnedBy, the bBlockActors bit, the LevelInfo exemption) is the original's. The harness
therefore establishes the arithmetic, branch order, argument defaults, EX_Nothing handling and the exact sequence and
arguments of the level calls; it does not establish world collision (see "Scope").

`scripts/validate-parabolic-trace.mjs` replays those recorded answers into the translation and compares float32 words:

| group | cases | compared |
| --- | --- | --- |
| `execParabolicTrace` (the whole native) | 832 | result word, finalLocation words (through `GPropAddr` or a temporary), every PointRegion and MultiLineCheck call in order with its float32 arguments, all ten parameters consumed |
| slide helper alone | 367 | return value, `Start`, `Region`, every `Hit` field (including a stale `Hit` kept across an early return) |
| TwoWallAdjust alone | 706 | `Delta` words |

The exec corpus covers: defaults with and without out-reference, the `GetProjectileList` and `AISafeToThrow` argument
shapes (nine and ten arguments), free flight, floors, ramps with a normal Z at, just below and just above 0.7, bounces at
each elasticity, landing-speed termination, `maxTime` expiry and edge values, 260 two-wall and corner scenes (the second
hit, TwoWallAdjust and the third slide), terminal-velocity clamps (zone limits 150..4000), water entry, a zone number 0
region, a step above 1581 units, granularity clamps (below 0.005, at 1, above 1, NaN, infinities, a denormal, -0), actor
hits (blocking, non-blocking, owned-by-self, self cylinder, owner chains), NaN and infinite velocities and elasticity, a
zero-gravity zone, and the rounding at PC24 (the model follows `x87-precision.mjs`; the model has no 53-bit width, so
`0x027f` is not exercised). 142,162 recorded level-service calls are replayed; 449 of the 832 exec cases return a time and
383 return 0 (1,905 cases in all).

Instruction coverage inside the three original bodies (`--coverage`): worker 583 of 593, slide helper 341 of 351,
TwoWallAdjust 197 of 197. The 20 uncovered instructions are the four `appFailAssert` blocks of `GetLevelInfo`
(`Actors(0)` null, or not an `ALevelInfo`), which a valid level never reaches; the translation does not model them.

`validate-parabolic-trace.mjs` also plants eleven mutations in a copy of the translation (floor normal 0.7 -> 0.71, Z kept
as a float instead of in the register, the 2-unit backoff dropped, `>=` for the `maxTime` test, the terminal clamp
skipped on a bounce, a sign test of TwoWallAdjust, its normals swapped, one ulp of its time, the elasticity dropped on
one lane, the 0.0001 threshold changed, IsOwnedBy skipped) and requires every one to fail the corpus: 11 of 11 caught.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-parabolic-trace.mjs [--coverage] [--no-mutants]
```

## Precision

Every `St` above is one of the worker's FST/FSTP stores, and every value the original leaves on the x87 stack is kept
`ext` by the translation (`x87add`/`x87mul`/`x87div`/`x87sqrt` of `script-vm.mjs`, rounding the exact result once to
the precision control and to float32 at each store). The places the original does **not** store (and a JavaScript double
would round differently): the Z product and sum of the gravity step and Z's `(V + Zv) * g`; the slide's `dir.X * 2` and
`Ex`; `1.0 - Hit.Time` before it multiplies the remainder; the reflection's X lane `N.x * d * -2`; TwoWallAdjust's
`into * Cx`, its crease scale `s`, and every dot product compared against 0 or `ls^2`; `SizeSquared(Delta)` against
`2500000.0f`; and `TV * TV`. The floats stored and reloaded (`Size`, `Tf`, `E`, `dir`, `|Vel|^2` for the landing test, the
reflected velocity) are stored exactly where the original stores them. Float32 words travel as integers throughout, so a
NaN payload cannot be changed by a JavaScript array.

The game thread's control word is the one the other translations use (`0x037f`, 64-bit significand) and is **not
measured**; with PC24 the original and the translation also agree on every PC24 case run.

## In Play

`src/runtime/script-runtime.mjs` routes index 722 (listed in the registry's `runtime-invoke` entry) to
`execParabolicTrace` with the receiver's fields, `level.pointRegion` (the BSP zone lookup of [zone](zone.md)), the
collision hash's `multiLineCheck` ([level queries](level-queries.md)), `Owner` chains and the collision-view actors'
`collisionBits`. The zone's `ZoneGravity`, `ZoneVelocity`, `ZoneTerminalVelocity` and `bWaterZone` are read from the zone
actor each step.

`scripts/validate-parabolic-trace-play.mjs` (Liberty Island, headless, 38 s) drives both callers through the original
UnrealScript and then re-runs the original exec and worker in Unicorn over the **live level's** recorded service
answers:

* `GetProjectileList`: Terrorist22 in state `AvoidingProjectiles`, a LAM spawned beside it (`PHYS_Falling`, `bBounce`).
  The state's `PickDestination` calls `GetProjectileList`, which calls native 722 with nine arguments; the arguments are
  the LAM's `Location`/`Velocity`/`Elasticity`/`bBounce`, `maxTime` 2, `landingSpeed` 60 (asserted). In the run the
  second call returned 0.3 s and the point (3056.9, -267.5, 1046.1), where the LAM then came to rest (3057, -266, 1046).
* `AISafeToThrow`: the same pawn holding a spawned `WeaponLAM` (`ProjectileClass` LAM), called by name for five targets and
  three throw accuracies; 15 calls compute both throw angles and call native 722 ten-argument, 30 native calls in all.
* All 32 native calls match the original on result, finalLocation and the order, count and arguments of the 5,188
  recorded PointRegion and MultiLineCheck calls; 31 return a positive time. A call takes about 2 ms.

## Scope and unsupported

* **World collision and zone lookup are not re-established here.** PointRegion and MultiLineCheck are the existing
  translations (the validators above hand the original code their own answers). Their evidence is in their documents.
* **Not driven:** the AI's own choice to throw (the `Attacking` state selecting a thrown weapon and calling
  `AISafeToThrow` unprompted) was not run; `AISafeToThrow` is reached by calling it on a real pawn. The worker passes
  `bCheckActors` through as the raw int; a script bool is 0 or 1, and the translation hands the level 1 for any truthy value.
* **Unsupported:** the `GetLevelInfo` assertion branches (above); precision controls other than 24 and 64 bits; a NaN
  `maxTime` (the original loops forever; the translation throws after 5,000,000 iterations); a network game's actor
  replication or any multiplayer behaviour.
* `Hit.Primitive`/`Item` are carried verbatim and nothing in the original reads them here.
