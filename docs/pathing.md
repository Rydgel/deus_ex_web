# PHYS_Interpolating: AActor::physPathing

Helicopters, cinematic actors and anything an `InterpolateTrigger` sends along
an InterpolationPoint path move under `PHYS_Interpolating` (8). The census
stopped ten maps there ("Non-Pawn performPhysics PHYS_Interpolating
(0x103dd8a0) is not linked", and "APawn::performPhysics Physics=8" for a pawn).

The source is Engine.dll SHA256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`:
`AActor::physPathing`, thunk `0x10301a5a`, body `0x103dd8a0`–`0x103de3af`.
`src/runtime/pathing.mjs` translates it; the scripts it runs with are the
original `InterpolationPoint` (Engine) and `InterpolateTrigger` (DeusEx).

## How an actor gets on a path

`InterpolateTrigger.SendActorOnPath` takes every non-InterpolationPoint
actor tagged with its Event and, for each, the InterpolationPoint tagged with
that actor's Event at `Position == 1`: it clears the actor's collision and
bCollideWorld, sets `Target`, `SetPhysics(PHYS_Interpolating)`, `PhysRate =
1`, `PhysAlpha = 0`, `bInterpolating = True`, `bStasis = False` and
`GotoState('Interpolating')`. An actor whose Event is None matches every
InterpolationPoint (AllActors does not filter a None tag): BatteryPark's
helicopter and 04 Island's FlagTrigger5, which shares the helicopter's Tag,
are sent along whichever path has a Position 1 point, as in the original.
`InterpolationPoint.BeginPlay` links each point to Position-1 and
Position+1 of its Tag, the last one wrapping to Position 0.
`InterpolationPoint.InterpolateEnd` ends the trip on a `bEndOfPath` point:
the actor stops interpolating and falls (a player regains collision).

## The body

SDK offsets: AActor Level `+0xa8`, XLevel `+0xac`, Target `+0xb8`,
Location `+0x114`, Rotation `+0x120`, bInterpolating `+0x1ec` bit 7,
PhysAlpha `+0x214`, PhysRate `+0x218`; APawn ViewRotation `+0x3dc`, FovAngle
`+0x410`; APlayerPawn FlashScale `+0x610`, FlashFog `+0x61c`,
DesiredFlashScale `+0x638`, DesiredFlashFog `+0x644`; LevelInfo TimeDilation
`+0x474`; AInterpolationPoint RateModifier `+0x31c`, GameSpeedModifier
`+0x320`, FovModifier `+0x324`, bEndOfPath/bSkipNextPath `+0x328` bits 0/1,
ScreenFlashScale `+0x32c`, ScreenFlashFog `+0x330`, Prev `+0x33c`, Next
`+0x340`. Constants: double 0.0, 1.0, 2.0, 0.0625, 0.5; float 0.0, 1.0.

Each pass of the loop (`0x103dd8cd`):

1. Return when PhysRate compares equal to 0 (or unordered), bInterpolating
   is clear, or DeltaTime is not greater than 0.
2. `Dest` is Target when it IsA InterpolationPoint. The body then reads
   `Dest.Next` and `Next.GameSpeedModifier` without a null test: a Target
   that is not an InterpolationPoint, or one without Next, is an access
   violation in the original. The translation throws there.
3. With `a` = PhysAlpha: `RateModifier` and Level's `TimeDilation` are
   `(1-a)*Dest + Next*a` in extended precision, stored float32.
4. On a PlayerPawn: `DesiredFlashScale` and all three `FlashScale` components
   are `Next.ScreenFlashScale*a + Dest.ScreenFlashScale*(1-a)`; `FlashFog`
   and `DesiredFlashFog` add the float-stored products `(1-a)*Dest.Fog` and
   `a*Next.Fog`; `FovAngle` is the extended FovModifier blend times the class
   default object's FovAngle (after the `Defaults.Num ==
   GetPropertiesSize` check).
5. `PhysAlpha += RateModifier*PhysRate*DeltaTime` (extended), stored float32
   as the unclamped value; the extended sum below 0 (or unordered) clamps to
   0, the stored value at or above 1 clamps to 1, and the clamped value `t`
   is written to PhysAlpha.
6. With both `Dest.Prev` and `Next.Next`, the new Location is a normalized
   kernel blend over Prev, Dest, Next and NextNext with weights
   `w(x) = (1 + x⁴/16) - x²/2 = (1 - x²/4)²` at `x = t+1, t, t-1, t-2`, each
   weight stored float32 and `norm = float32(1/(((w3+w2)+w1)+w0))`. X and Y
   store every product and partial sum; Z keeps the first three products
   and their sum extended before one store. The rotation sums the
   `_ftol(Rotation_k * w_k)` rotators as int32, then `_ftol(sum * norm)`.
   Otherwise it is linear between Dest and Next with float-stored `t` and
   `1-t`.
7. `MoveActor(this, NewLocation - Location, NewRotation)` with every flag
   clear; the result is ignored. A Pawn then copies Rotation to ViewRotation.
8. Past the end (PhysRate > 0 and the stored unclamped alpha > 1): DeltaTime
   becomes `float32((u-1)/(u-old)*DeltaTime)`, PhysAlpha 0, and if Target is
   set, `Target.InterpolateEnd(self)` then `self.InterpolateEnd(Target)`
   (re-read), and Target steps from Dest along Next while the reached point
   is an InterpolationPoint with bSkipNextPath. Before the start (PhysRate
   < 0 and the unclamped alpha < 0, or unordered): DeltaTime becomes
   `float32((-u)/(old-u)*DeltaTime)`, PhysAlpha 1, the same two events and a
   walk along Prev, and then always `self.InterpolateEnd(None)`. Otherwise
   DeltaTime becomes 0. The loop then starts again.

A closed path on which every point has bSkipNextPath never leaves that walk
in the original; the translation throws instead of hanging the tab.

## Play wiring

`AActor::performPhysics` (`actor-physics.mjs`) brackets the body with
`OldLocation = Location` and `Velocity = (Location - OldLocation) /
DeltaTime` (`interpolationVelocity`, the same arithmetic as APawn's
`0x103c9b49`). Non-Pawn actors run `runActorPathing`
(`script-actor-physics.mjs`): fields through the runtime, the generic
MoveActor with NewRotation, and InterpolateEnd through each actor's original
body. Pawns run APawn::performPhysics case 8 (`0x103c9b20`) in
`script-pawn-physics.mjs` with the pawn's own MoveActor, then the usual
physicsRotation tail. The controlled player's own movement port does not
take PHYS_Interpolating yet.

## Validation

`scripts/native-pathing-oracle.py` executes the original body over
controlled paths of up to eight points, with UObject::IsA running from Core
against the static classes (PlayerPawn's chain reaching APawn, its default
object holding FovAngle). MoveActor, FindFunctionChecked and ProcessEvent
are recorded leaves; a case can block moves and clear bInterpolating or
change PhysRate at a given event. A read or write past `fs:[0]` in the null
page is reported as the access violation Windows raises there.
`scripts/validate-native-pathing.mjs` compares 296 cases bit for bit:
linear and cubic segments, forward and reverse crossings, bSkipNextPath runs,
every modifier and the screen flash on PlayerPawn, Pawn and plain actors,
blocked moves, event effects, rotator wraparound, the two null dereferences
and the skip loop, and 250 seeded random paths. All match: 444 MoveActor
calls and 418 InterpolateEnd events, with every delta, NewRotation, Location,
Rotation, PhysAlpha, PhysRate, Target, TimeDilation, FovAngle, ViewRotation,
FlashScale, FlashFog and their desired values.

`scripts/validate-warehouse-helicopter.mjs` runs Warehouse's
`InterpolateTrigger0` through its original SendActorOnPath in a booted map
and follows BlackHelicopter1 for 739 frames: Target steps through Positions
1 to 13 in order, the helicopter covers 18,265 units and turns on every
frame, both sides receive the original InterpolateEnd (24 events), Velocity
follows the performPhysics bracket on all 738 interpolating frames, and the
bEndOfPath point's InterpolateEnd drops it to PHYS_Falling. The conversation
census then has Intro, both UNATCO Islands, Warehouse, Airfield and
BatteryPark clean, and the Training and Island digests are unchanged.

## Actor fields outside a mover

PhysAlpha, PhysRate and bInterpolating are Actor fields. Play used to bind
them, by name, to a mover's interpolation state on every actor; on a
helicopter the setter dropped SendActorOnPath's `PhysRate = 1` and the getter
returned 0, so physPathing returned at once. Those bindings now apply only
to movers, and other actors keep the fields in their own storage.
`execPollFinishInterpolation` (`0x103e0100`) clears the latent action when
the actor's bInterpolating bit is clear; the poll reads that field on any
actor, not only a mover's state.
