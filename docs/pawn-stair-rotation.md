# Pawn.FindStairRotation (native 524)

`native(524) final function int FindStairRotation(float DeltaTime)` is called by the base `PlayerPawn.PlayerWalking.PlayerMove`
(`if (bLookUpStairs) ViewRotation.Pitch = FindStairRotation(deltaTime)`, in the branch for a walking player who is not rotating the view
by key or mouse look). Play runs that bytecode. The installed `User.ini` and `DefUser.ini` set `bLookUpStairs=False`; the `StairLook`
exec command (or an edited ini) sets it, so the native is reached by configuration only, but then every walking tick asks for it.

Original: `APawn::execFindStairRotation`, Engine.dll `0x103bb880-0x103bbf42` (registered cell `0x1047caf8`, thunk `0x10303111`). The exec is
self-contained: the float comes through the GNatives evaluator, the rest is inline, with Core's `FCoords::operator/=(FRotator)`
(`0x10599b3c`), the `FVector` constructor (`0x10599b28`), the level's `SingleLineCheck` (vtable `+0xc0` of `Actor+0xac`:
`Hit, Source, End*, Start*, flags, Extent, extra`, `ret 0x24`) and the CRT `_ftol` (`0x10413652`).

Pawn fields read: Location `+0x114`, CollisionRadius `+0x1d4`, CollisionHeight `+0x1d8`, ViewRotation `+0x3dc` (Pitch, Yaw, Roll), EyeHeight
`+0x3f4`. The only write is the pitch normalisation below.

## Algorithm

`h = float32(CollisionHeight + EyeHeight)`, `R = CollisionRadius`, extent `(R, R, 1)`, `EyeSpot = (Location.X, Location.Y, float32(EyeHeight +
Location.Z))`. `Dir` is the X axis of `UnitCoords /= FRotator(0, Yaw, Roll)` (`getAxes`). `Hit` is an `FCheckResult` with Time 1.0; the
level's `SingleLineCheck` leaves Time 1.0 on a clear trace (`line-filter.mjs`), so each call's `Hit.Time` is its answer.

1. `DeltaTime > 0.33` (the double at `0x10431428`): return the stored `ViewRotation.Pitch` unchanged.
2. A stored Pitch above `0x8000` becomes `(Pitch & 0xffff) - 0x10000` (stored back).
3. Trace 1: `EyeSpot` to `EyeSpot + Dir * 2h`. `T = 2 * h * Hit.Time`. If `0.8 * h` is not below `T` (the wall is within 0.4 of the way), the target is 0.
4. Else trace 2 from `EyeSpot + Dir * (T * 0.5)` (the point half way to the wall) straight down by `3h` (`h3 = float32(3h)`); `floor = float32(h3 * Time)`.
   If `Time` is not below 1.0 the target is 0.
5. `p = 0.7 * h`. If `p - 6 > floor` (the floor is near: the ground rises): trace 3 from `EyeSpot + Dir * T` straight down by `h3`;
   target = the stored pitch if positive else 0, and `0x1518` (5400) when `floor - 10` is above `h3 * Time`.
6. Else if `p + 6 < floor` (the floor is far: the ground falls): trace 4 is a thin line (extent 0) from `Location` along `Dir * 0.9 T`; only if
   it is clear (`Time == 1.0`, the equality or unordered cases included) trace 5 runs from `EyeSpot + Dir * T` (the products stay extended
   into the sums) straight down by `h3`; target = the stored pitch if negative else 0, and `-5000` (`0xffffec78`) when `floor + 10` is below `h3 * Time`.
7. Otherwise the target is 0.
8. Ease: `d = |Pitch - target|`; if `d <= 0` return the target. The weight is `8.0` for `d >= 1000`, else `float(8000 / d)` (integer division);
   `w = weight * DeltaTime`, replaced by 1.0 if `1.0 <= w` or `w` is NaN. The result is `_ftol((1 - w) * Pitch + w * target)`.

Every store is a float32 `fstp`; the sums and products that stay on the x87 stack between stores are 80-bit values (the game thread's
control word is the repo's assumed 0x037f, as for the other translations; unmeasured). The look direction needs only X and Y of the rotator,
so `Dir.Z` is exactly 0 and the Z terms of the first two traces add nothing for any valid pitch.

## Translation and checks

`src/runtime/script-pawn-stair-rotation.mjs` (`findStairRotation`), routed from `ScriptRuntime.invokeNative` (the `runtime-invoke` entry of the
registry), with the live `ViewRotation` store and the level's `lineCheck` (flags 6).

* `scripts/validate-find-stair-rotation.mjs`: the exec runs unchanged in Unicorn (`native-find-stair-rotation-oracle.py`; Core's `FCoords`
  operator, the sine table GMath's constructor fills, `_ftol`; only the level's SingleLineCheck is a stub, answering `Hit.Time` per call from the case).
  6,198 cases (random pawns, rotations with pitches around the `0x8000` wrap, DeltaTime around 0.33 and NaN, Hit.Time pools around every threshold,
  hand-built ladders through every branch, and an exact-equality case for the last comparison) are identical: the result, the pitch store and every
  line check's End, Start, extent and flags as float words. Coverage: 0 to 4 line checks, rises, falls and eased results. Of 14 planted mutations
  10 are killed; the four survivors are equivalent (`<=` against `<` where both sides give the same value, an unordered comparison that
  gives the same weight, and the dead Z terms).
* `scripts/validate-find-stair-rotation-play.mjs`: in 00_Training with `bLookUpStairs` set, 240 live calls (walking, looking down and up, a wrapped
  pitch) are recorded with the pawn state and the level's answers and replayed through the original exec: every result and line-check count is the
  original's. With the flag False the native is never asked.

Not measured: the game thread's x87 precision control; world collision (the answers of `SingleLineCheck` are the level queries' own evidence).
