# Dry landing decisions

The dry Pawn path of `AActor.processLanded` was traced in the original DLL before
translation. `landing.mjs` preserves its queries, fitting decisions, event order
and remaining-time dispatch. It is connected through the persistent dry-player
scene, including real queries,
FarMove, support callbacks and the shared random stream. The controlled corpus
below proves its decision logic; composed scene evidence is linked in
[player-sequence.md](player-sequence.md) and [far-move-scene.md](far-move-scene.md).

| Original instructions / data | Required behavior |
| --- | --- |
| `0x103cf1c5`–`0x103cf36f`; float `0x10431c38`, doubles `0x1042b8e8`, `0x104314c0` | Probe from Location down by `float(Radius * 0.2 + 8)`, using 0.9f times the collision extent, trace flags 0x37 and final option 0. |
| `0x103cf375`–`0x103cf4d4`; float `0x10431c34` | Only an exactly clear probe (Time = 1) invokes FindSpot with 1.1f times the extent and options 0, 0. Failed fitting or an unchanged fitted position proceeds to the normal landing event. |
| `0x103cf4da`–`0x103cf58d`; floats `0x10431c30`, `0x1042eae0` | A changed fitted position requests FarMoveActor with options 0, 0. Ignore its success result, add `appFrand() * 60 - 30` to each horizontal velocity component, and return without firing Landed or switching to walking. |
| Core `appFrand`, `0x101232e0`; float `0x10176d70` | Multiply the CRT rand integer by float32 `1 / 32767`. The original returns the product in x87 without rounding it to float32; preserve that intermediate precision in the landing expression. |
| `0x103d02ab`–`0x103d03ba` | Dispatch Landed first. Only if Physics remains Falling, call setPhysics(Walking, HitActor). Respect changes made by the event. |
| `setPhysics`, `0x103c95f0` | The Falling-to-Walking transition requests support basing and does not zero vertical velocity. `physWalking` does that later at `0x103ca5f0`. |
| `0x103d03ba`–`0x103d0488`; double `0x10429858` | If Physics is Walking, replace Acceleration with its SafeNormal. Invoke physWalking with the same iteration count only when RemainingTime is greater than double 0.01. |

The current fixed 120 Hz tick has less than 0.01 seconds available, so ordinary
landings at that tick rate defer walking physics until the next tick. Original
variable actor deltas can exercise the same-tick continuation branch. Re-entering
the full browser Player.tick would incorrectly repeat input, bob and camera work;
the verified walking physics entry point must be used directly.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-landing.mjs
```

The harness executes original processLanded, setPhysics, SafeNormal and appFrand.
World queries, FindSpot, FarMoveActor, Landed, support basing, walking and CRT rand
integers are explicitly controlled callbacks. All **294 cases** match exact state,
query parameters, callback order and arguments, including signed zero. Cases
cover the 0.01-second boundary, event-driven physics changes, unchanged/failed
fits, failed relocation, varying extents, random-integer endpoints, and seeded
positions/velocities/accelerations. The original corpus is saved separately before
comparison under ignored `reports/movement/native-landing/original.json`; hashes,
inputs and paired results are retained alongside it. Four unit regressions use
expectations captured from this corpus.

This establishes landing decisions under the supplied callback boundaries. Real
query, fitting, relocation, basing and random-stream implementations have separate
native comparisons and are connected in Play. Original source supplies JC's
bJustLanded change; animation, audio and damage remain explicit later-stage
callbacks. Water is outside the dry slice.

## Non-Pawn sources and the bBounceVelocity zone

`processLanded` is class-dependent only through inlined IsA walks and bIsPawn:

| Original instructions | Source | Behavior |
| --- | --- | --- |
| `0x103cef92`–`0x103cf11f` | any with bIsPawn (`+0x28` bit `0x800000`) clear | in a zone with bBounceVelocity (ZoneInfo `+0x388` bit 9) and a ZoneVelocity with any component that does not compare equal to 0 (`-0`/NaN count as 0): `Velocity = (0+ZV.X, 0+ZV.Y, 80+ZV.Z)`, return. No Landed, no physics change, no counter reset. |
| `0x103cf124` | IsA(Pawn) | the dry Pawn path above (`processLanded`) |
| `0x103cf597`–`0x103d02a1` | IsA(ADecoration `0x10578d48`) | while `numLandings` (`+0x324`) < 5 (signed), the footprint block below, which can push the decoration and return; otherwise, or after it, reset the counter to 0 (`decorationLanded`) |
| `0x103d02ab`–`0x103d03b5` | all | `Landed(HitNormal)`; if still PHYS_Falling: `setPhysics(IsA(Pawn) ? Walking : None, HitActor)` |
| `0x103d03ba`–`0x103d0488` | IsA(Pawn) and Walking | SafeNormal Acceleration, `physWalking` if remaining > 0.01 |

For an Inventory (a dropped Lockpick) or a Projectile/Fragment, IsA(Decoration)
is false, so `actorLanded(host, hit, {zone})` is: the bBounceVelocity branch, then
Landed, then `setPhysics(PHYS_None, HitActor)` only while still falling. `+0x324`
is a subclass field there and is never touched; a Landed that selects Walking does
not start walking for a non-Pawn. `decorationLanded` and `actorLanded` accept an
optional `{zone: {bBounceVelocity, ZoneVelocity}}` for the first branch;
`zoneBounceLanding` is exported. Fragments normally bounce (bBounce) and never
call processLanded (docs/actor-physics.md).

`scripts/native-landing-oracle.py` now also runs fake Lockpick/WoodFragment
script classes chained to the DLL's `AInventory` (`0x10576f70`) and `AProjectile`
(`0x10578850`) static classes, bIsPawn per case, and a separate ZoneInfo with
bBounceVelocity and ZoneVelocity (signed zeros included). The full corpus is **506
cases, maxError 0**: 122 inventory/projectile landings (Landed physics changes,
bases, normals, the `+0x324` sentinel unchanged), 15 bounced non-Pawn landings
(inventory, projectile and decoration; a bounced decoration keeps its counter),
zero/`-0` zone velocities that land normally, and 14 bIsPawn Pawn cases (7 in
bBounceVelocity zones) that take the ordinary Pawn path.

### The decoration footprint block (2026-10-18)

An earlier version of this page called the block read-only. That was wrong: the
oracle's SingleLineCheck stub never set `Hit.Actor` or the UBOOL return the block
reads, so its corner tests never fired. The Island capture `exp1` showed the push:
CrateExplosiveSmall4, summoned at tick 35, lands half off CrateExplosiveSmall1 at
tick 45 and the original gives it Velocity (0, −210, 52.5) and leaves it falling
with no Base, where Play based it on the other crate. Disassembly of
`0x103cf5f7`–`0x103d0284` (constants: `0x10431418` 0.8 double, `0x1042b148` 8,
`0x10426d74` 0.5, `0x1042ac10`/`0x1042abd8` ±0.5 double, `0x104298f0` −1,
`0x1042eae0` 30, `0x10430aac` 2, `0x1042f570` 0.9 double, `0x1042b8e8` 0.2 double,
`0x10431c2c` 120):

1. **Centre probe** (`0x103cf60a`–`0x103cf803`): a zeroed FCheckResult,
   `SingleLineCheck(Hit, this, End, Start, 0x37, (0,0,0), 0)` from
   `Location − (0, 0, f32(H·0.8))` down to `Location − (0, 0, f32(H + R + 8))`
   (R, H the collision radius and height). `Hit.Actor` set jumps to step 4.
2. **Corner probes** (`0x103cf809`–`0x103cffb4`): four box sweeps, extent
   `(0.5R, 0.5R, H)` (the halved `(R, R, H)` with Z doubled back), flags `0x17`,
   from `Location + (±0.5R, ±0.5R, 0)` to `Location + (±0.5R, ±0.5R, −8)`, each
   component `f32(offset + Location)`, in the order (+,+) (−,+) (−,−) (+,−). Each
   keeps SingleLineCheck's return (1: clear, the corner unsupported) as a, b, c, d.
3. **Push** (`0x103cffba`–`0x103d0154`): with `a+b+c+d > 1`, `a+c ≠ 0` and
   `b+d ≠ 0`: `numLandings += 1`; `s = −Velocity.Z`, replaced by 30 when below 30 or
   unordered, else by `min(s, 30 + R)` (the second compare also takes `s` when
   unordered); `Velocity = (a+d−b−c, a+b−c−d, 0.5)·f32(2s)`, each product stored;
   then the function returns (`0x103d04cf`) **without Landed or setPhysics**, so the
   decoration keeps falling. exp1's crate: c = d = 1, s = min(142.5, 52.5).
4. **Carcass slide** (`0x103d0159`–`0x103d0284`), reached after a supported centre
   or a footprint that does not push: a Carcass (static class `0x10573db8`) with
   HitNormal.Z below 0.9 (or unordered) and bSlidingCarcass (`+0x348` bit 2, named
   through the class graph's linked offsets) calls appFrand, adds 1 to
   numLandings when the unrounded result is below 0.2, sets
   `Velocity = HitNormal·120` and `Velocity.Z = 70`, and returns without Landed.
5. Otherwise `numLandings = 0` (`0x103d0289`) and the common Landed/setPhysics tail.

physFalling's side of the counter (`0x103d1d1c`–`0x103d1d7b`): a blocked move of a
Decoration whose Hit.Actor IsA PlayerPawn (`0x1058c160`) sets
`numLandings = max(numLandings − 1, 0)` before the bounce test.

`decorationLanded` (`landing.mjs`) and `playerContactLanding` translate them; the
hosts supply SingleLineCheck with the decoration as SourceActor
(`script-actor-physics.mjs`, `decoration-physics.mjs`), and the Rust fall body
(`fall.rs`) calls `js_fall_blocked` for a decoration's blocked move. The oracle's
stub now sets `Hit.Actor` and the return per call (`lines` in a case) and runs a
Carcass class chained to ADecoration; `validate-native-landing` has **853 cases,
0 mismatches, maxError 0**, among them 161 pushes over all sixteen corner patterns,
counters 0 and 4, fall speeds below, inside and above the clamp, and 32 carcass
slides (appFrand on both sides of 0.2, normals at and around 0.9). The exp1-shaped
case gives the DLL's `(0, −210, 52.5)`, PHYS_Falling, numLandings 1, as captured.
