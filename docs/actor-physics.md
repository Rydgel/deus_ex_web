# Non-Pawn actor physics: bouncing falls, rotation, RotRand, landing

Recovered from the hash-pinned GOTY `Engine.dll`
(`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`) and `Core.dll`
(`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) before
translation, for crate fragments (`DeusEx.WoodFragment` → `DeusExFragment` →
`Engine.Fragment` → native `Engine.Projectile`; defaults `Physics=PHYS_Falling`,
`bBounce=True`, `bFixedRotationDir=True`, `Elasticity=0.4`) and dropped inventory
(`DeusEx.Lockpick` → … → native `Engine.Inventory`; `Physics=PHYS_Falling`,
`bBounce=False`). These are pure translations; wiring them into the Play host is
separate integration work.

Actor field offsets used below (from the disassembly, consistent with
`Actor.uc` declaration order): `+0x28` first bool word (bit `0x80` bDeleteMe,
`0x80000` bMovable, `0x800000` bIsPawn), `+0x30` Physics, `+0xc8` Region.Zone,
`+0xd0` Region.ZoneNumber, `+0xd8` StandingCount, `+0x114` Location, `+0x120`
Rotation (Pitch/Yaw/Roll int32), `+0x12c` OldLocation, `+0x144` Velocity, `+0x150`
Acceleration, `+0x178` Brush, `+0x1ec` bool word (bit `0x10` bBounce, `0x20`
bFixedRotationDir, `0x40` bRotateToDesired, `0x100` bJustTeleported), `+0x1f4`
Mass, `+0x1f8` Buoyancy, `+0x1fc` RotationRate, `+0x208` DesiredRotation,
`+0x21c` PendingTouch. ZoneInfo `+0x388` bool word: bit 0 bWaterZone, bit 9
bBounceVelocity.

## AActor::physFalling (0x103d0a50): non-Pawn path and bBounce

`src/runtime/falling.mjs` `falling(pawn, seconds, iterations = 0, options)`.

### Non-Pawn prelude

`0x103d0a7d`–`0x103d0aa7` computes `ThisPawn = IsA(APawn) ? this : NULL`. For a
non-Pawn the walking/surface prelude (`0x103cc450`) is not called and
`0x103d0bca` jumps straight to `0x103d0e0c`, skipping the whole air-control /
acceleration-clamp block: Acceleration is used unchanged (its Z is **not**
zeroed). The entry Acceleration is copied first (`0x103d0bb2`) and restored at
the normal loop exit (`0x103d245e`) for every actor. `options.nonPawn` selects
this path. Each integration re-reads the actor's Acceleration (`+0x150`), so the
translation reads `pawn.acceleration` per integration (the Pawn prelude stored
its clamped value there, so the Pawn path is unchanged).

### Wall-hit branch with bBounce

After the substep MoveActor (`call [vtable+0x88]` at `0x103d1c9c`):

1. `0x103d1ca2`: bDeleteMe (actor+0x28 bit `0x80`) → return (no restore). A move
   whose touch/bump destroyed the actor ends physics; `pawn.bDeleteMe` models it.
2. `0x103d1cb6`: Pawn in PHYS_Swimming → startSwimming (Pawn-only; not translated).
3. `0x103d1d08`: `Hit.Time < 1.0` (double) marks the substep blocked (local
   `-0x18 = 1`). A Decoration whose `Hit.Actor` IsA PlayerPawn then decrements
   `numLandings` (`+0x324`, floor 0; `0x103d1d1c`–`0x103d1d7b`). This decrement
   is **not translated** (it feeds only the read-only landing-footprint probes,
   docs/landing.md); fragments and inventory never take it.
4. `0x103d1d81`: bBounce (`+0x1ec & 0x10`, re-read here) selects the bounce branch:
   - `0x103d1d8c`–`0x103d1dcc`: `ProcessEvent(FindFunctionChecked(NAME_HitWall
     [0x10583714]), {HitNormal = Hit.Normal, Wall = Hit.Actor})` — the **direct
     script event**, not `processHitWall` (no Pawn or wall-class logic; only
     ProcessEvent's own probe gate). Modeled by `options.hitWallEvent(normal, actor)`.
   - `0x103d1dcf`: `Physics == PHYS_None` → return immediately (no Acceleration
     restore). Any other Physics value (even a change to Rolling) keeps falling.
   - `0x103d1dda`: only while the per-call bounce counter (local `-0x40`, zeroed at
     `0x103d0e1a`) is `< 2`: `RemainingTime += (1.0 - Hit.Time) * TimeTick`.
   - counter `++`, then `jmp 0x103d22ce`. No slide move and no Delta adjustment.
   - Floors are not special: a bouncing actor **never** reaches the
     `Normal.Z > 0.7` landing test, `processLanded` or `processHitWall`; the script
     HitWall must handle resting (DeusExFragment's `SetPhysics(PHYS_None)`).
5. `0x103d22ce`–`0x103d22e6` (end of every substep): bBounce and bJustTeleported
   are re-read. `bBounce && blocked` → next substep without the velocity
   recomputation, so Velocity is exactly what HitWall left. Otherwise the ordinary
   `(Location-OldLocation)/TimeTick - ZoneVel`, `2V-OldV` and terminal clamp run.
   A script that clears bBounce without stopping therefore gets the velocity
   update in that substep and the non-bounce paths afterwards; a non-bouncing
   script that *sets* bBounce in processHitWall skips it.
6. Iterations still count every substep; the loop bound (`remaining > 0 &&
   Iterations < 8`, `0x103d0e49`) is unchanged, so at most 8 HitWall events occur
   per call.

The refund `fld Hit.Time; fsubr qword 1.0; fmul dword TimeTick; fadd dword
RemainingTime; fstp dword` is identical at the bounce site (`0x103d1de0`) and
the floor-landing site (`0x103d1e0e`); both now use the exact x87 model
(`x87add/x87mul/x87store` from `script-vm.mjs`, 64-bit significand, control word
`0x037f` as in the oracle) instead of a double expression. All previously
validated cases are unchanged.

### Other physFalling branches seen (not translated)

| Site | Behavior | Status |
| --- | --- | --- |
| `0x103d0aca` | `Region.ZoneNumber == 0`: log (Role Authority and IsA Inventory/Decoration/Pawn), `FellOutOfWorld` event, return | `pawn.zoneNumber === 0` throws an explicit boundary |
| `0x103d0f35`→`0x103d125a` | water zone: `Velocity = OldV*(1 - 2*FluidFriction*dt) + 0.5*((1 - Buoyancy/max(1,Mass))*Gravity + Accel)*dt` | not translated (dry zones only) |
| `0x103d0f42` | `IsA(ADecoration) && bBobbing` (Decoration `+0x31c` bit 8): half gravity | not translated; this is the branch earlier notes called a "bounce class" branch |
| `0x103d1039` | PlayerPawn with foot zone bWaterZone and `OldV.Z < 0` | not translated |
| `0x103d1b39` | bIsPawn and not PlayerPawn: ZoneVelocity ignored when `SizeSquared <= 40000` | not translated (fragments/inventory/player always add ZoneVelocity) |
| `0x103d1cb6` | Pawn swimming transition | not translated |

### Validation

`scripts/native-falling-oracle.py` executes the unchanged physFalling. New case
fields: `bounce` (sets `+0x1ec` bit `0x10`), `ancestry` (`fragment`: fake
WoodFragment/DeusExFragment/Fragment classes chained to the DLL's own
`AProjectile` 0x10578850 → `AActor` 0x1057cdf0; `inventory`: four script classes
chained to `AInventory` 0x10576f70), `hitWallMode`, `elasticity`, `deleteAtMove`.
The direct HitWall `ProcessEvent` (return address `0x103d1dcf`) is intercepted,
its `{HitNormal, Wall}` parameters recorded, and a controlled script body applied:
`none`, `reflect` (`Velocity = Elasticity*((V dot N)*N*(-2) + V)` with a float32
store after every vector op), `stop` (PHYS_None, zero Velocity/Acceleration,
clear bBounce), `clearBounce`, and `fragment` (DeusExFragment.HitWall's stuck
test, reflection and `(speed < 60 && N.Z > 0.7) || speed == 0` rest). These are
test doubles for the script VM, not VM evidence.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-falling.mjs
node --test test/falling.test.mjs
```

Result: **1014 cases, maxError 0, 0 mismatches** (476 Pawn, 126 non-bouncing
non-Pawn, 414 bouncing — 412 fragment-ancestry and 2 bouncing Pawns — and 27
inventory-ancestry), comparing every float32 component bit-exactly (signed zero
included), the MoveActor deltas, and the ordered HitWall/processHitWall/
processLanded events. 376 cases dispatch at least one HitWall, up to 7 per call;
49 exceed the two-bounce refund cap; 82 end through PHYS_None. The original 562
cases are unchanged and still exact.

Unverified: the script bodies (reflection arithmetic, `SetPhysics`) are doubles;
the real ones run through the VM and native `setPhysics` at integration.
`Hit.Actor` is always the LevelInfo stand-in. The x87 control word is the
harness's `0x037f`; the game's runtime control word is not measured.
