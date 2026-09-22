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
| `0x103cf597`–`0x103d02a1` | IsA(ADecoration `0x10578d48`) | read-only landing-footprint probes while `numLandings` (`+0x324`) < 5, else reset it to 0 (`decorationLanded`) |
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
bBounceVelocity zones) that take the ordinary Pawn path. The footprint invariance
pairs still hold.
