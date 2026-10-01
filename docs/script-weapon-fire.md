# Swinging the crowbar at a Training crate

This follows [weapon equip](script-weapon-equip.md). After JC picks up and
draws `WeaponCrowbar1`, a left click (or Enter) swings it through the
original bytecode. The swing hits `CrateBreakableMedGeneral1` and runs
`DeusExDecoration`'s original `Active.TakeDamage`. The host scripts no weapon
or damage logic. This page records the original evidence for each step, what
Play now executes, and the boundaries that still stand.

## Input: `ParseLeftClick|Fire`

The installed `System/User.ini` (and `DefUser.ini`) bind
`LeftMouse=ParseLeftClick|Fire` and `Enter=ParseLeftClick|Fire`. The `Fire`
alias is `Aliases[0]=(Command="Button bFire | Fire",Alias=Fire)`. A press
therefore:

1. runs the `DeusExPlayer.ParseLeftClick` exec, which handles the item in hand
   (a key ring or lockpick on a targeted door goes through `DoFrob(Self, inHand)`),
2. sets the `bFire` input byte to 1 (`Button`), then
3. runs the `Fire` exec: `DeusExPlayer.Fire` → `RestrictInput` →
   `PlayerPawn.Fire` → `bJustFired = true`, then, with a `Weapon`,
   `Weapon.bPointing = true; PlayFiring(); Weapon.Fire(F)`.

Releasing the button clears `bFire`. `DeusExWeapon.Finish` reads `bFire` and
fires again while it is held. `game.pressFire()` and `game.releaseFire()` are
exactly this binding. With the ring or lockpick on a door, the host keeps its
existing door route for step 1: the same `DoFrob` branch plus the door display
bookkeeping. Every other press runs the original `ParseLeftClick`. In
`main.mjs`, the edges come from the mouse button while the pointer is locked.
Unlocked, left-drag stays mouse look and a click without movement fires on
release. Enter fires too.

## The swing (original bytecode, now ticked)

`DeusExWeapon.Fire` takes the `bHandToHand` branch.
`GotoState('NormalFire')` comes first, then `PlaySelectiveFiring`. That draws
`FRand()` from the shared original stream and selects `Attack`, `Attack2` or
`Attack3` with `PlayAnim(anim,,0.1)`. Last comes `PlayFiringSound`, a deferred
audio boundary. `Human.PlayFiring` plays `Attack` on JC's own third-person
mesh.

The installed `DeusExItems.Crowbar` player-view LodMesh gives all three attack
sequences a notify `HandToHandAttack` at time 0.5. The sequences have 12, 12
and 14 frames at rate 28. `PlayAnim` sets `bAnimNotify`. The recovered
animation tick (`animation-tick.mjs`, oracle-validated) dispatches the notify
when the frame crosses 0.5. `HandToHandAttack` → `TraceFire(0.0)` then runs:

- `GetAxes(Pawn(Owner).ViewRotation)`.
- `ComputeProjectileStart`. For an instant-hit weapon this is Owner.Location
  plus BaseEyeHeight.
- `PlayerPawn.AdjustAim`: `Trace` 4000 units, then native `PickTarget` (531,
  already recovered). With `MyAutoAim` 1.0 and `bAlwaysMouseLook` it returns
  `ViewRotation`.
- `Pawn.TraceShot` → native `Trace` (277).
- `ProcessTraceHit`. The multiplier is `AugCombat`'s `GetAugLevelValue`
  (−1 → 1.0) minus 2 × `GetWeaponSkill`. `WeaponDamageType` is also read.

This reaches `Other.TakeDamage(HitDamage*mult, …)` and `SelectiveSpawnEffects`
→ `SpawnEffects` → `Spawn(TraceHitHandNonPenSpawner, Other, …)`.

`NormalFire.Begin` then runs `Sleep(GetShotTime())` (`ShotTime` 0.5),
`FinishAnim`, `ReadyToFire` and `Finish` → `Idle` under the latent scheduler.

### Why the weapon now ticks

Driving the fire state machine outside the ticked latent scheduler ran its
state code without suspension. It also recursed through
`Finish → Global.Fire`. That OOM is recorded in `validate-trace-shot.mjs` and
the weapon-equip doc. The fix is to tick the weapon exactly as
`ULevel::Tick` does:

- **Carried inventory ticks.** `script-doors.mjs` walks `Pawn.Inventory` each
  frame (`playerCarriedItems`). It runs each carried item's recovered
  `Actor.Tick` in `Level.Actors` order. The item's `Owner` is JC. The
  recovered owner test (`actor-tick.mjs`: `Owner.bTicked != TickTag` → defer)
  defers it onto the level's deferred list.
- **Player order.** The player's own route (the viewer's movement port) runs
  after the scripted actors, as before. `game.tick` now passes it into
  `doors.tick(dt, {tickPlayer})`. The host then writes JC's
  `bTicked = TickTag & 1`, which the player's `Actor.Tick` would have written.
  After that it replays `ULevel::Tick`'s deferred list
  (`0x103a56cd..0x103a570e`, `level-tick.mjs`): nodes are retried while
  progress is nonzero, and entries whose `bTicked` already equals `TickTag`
  are skipped. Nodes run in reverse deferral order. So the drawn crowbar ticks
  once per frame, after its owner. An owner that skipped its own tick (the
  stasis return precedes the `bTicked` write) keeps its items deferred, like
  the original.
- **Fresh `bTicked` after reset.** Player start sets JC's `bTicked` to
  `!TickTag`, the `SpawnActor` value (`script-spawn.mjs`).
- **The pawn tail.** After the player route, `Actor.Tick`'s pawn tail
  `FarMoveActor(Weapon, Location, 0, 0)` runs on the drawn weapon
  (`ScriptRuntime.farMoveActor`, [map-actor move](script-map-actor-move.md)).
  It is the recovered `FarMoveActor` body. For a non-colliding held item it
  sets `bJustTeleported`, writes
  `Location = OldLocation = destination` and runs `SetActorZone(item, 0, 0)`. The
  weapon therefore sits at JC's Location every frame instead of keeping its
  pickup offset.
- **Class chains at load.** A ticked `DeusExWeapon.Tick` (`CalculateAccuracy`,
  `GetWeaponSkill`) reaches the player's subsystems. So do `GetShotTime` and
  `ProcessTraceHit` through `GetAugLevelValue`. The `SkillManager`/skill and
  `AugmentationManager`/augmentation class chains therefore link at load. So
  do every carriable item's view meshes (`Mesh`, `PlayerViewMesh`,
  `PickupViewMesh`, `ThirdPersonMesh`). `BecomeItem` swaps the player-view
  mesh in, and the synchronous `meshPayload` boundary cannot await. The
  NanoKeyRing's `UseIt` state code, now reached, plays its use sound. That
  sound is recorded as a deferred audio boundary like the other effect sounds.

### Player view state

Original bodies read JC's `ViewRotation`, `EyeHeight`, `BaseEyeHeight`,
`WalkBob` and `bIsCrouching`. Examples: `TraceFire`'s `GetAxes`,
`CalcDrawOffset` and `HighlightCenterObject`. The viewer's camera integrates
look input in place of `PlayerPawn.UpdateRotation`, so these fields are bound
live to the movement port (`makeBinding`, controlled-player branch).
`UpdateRotation` stores `ViewRotation.Pitch & 65535` (PlayerPawn.uc:3342) and
leaves Yaw unmasked, and the binding reads the same representation. The host's
`HighlightCenterObject` port (`interaction.mjs`) now publishes its result to
the script `FrobTarget`/`FrobTime` every frame, as the original body assigns
them.

## Crates are in `Active` and tick

`DeusExDecoration`'s whole destruction logic is in `auto state Active`
(`TakeDamage`). Map decorations (`Engine.Decoration` ancestry) are now
admitted to the LoadMap startup passes (docs/script-loadmap-startup.md). That
runs `PreBeginPlay`..`PostPostBeginPlay`. `SetInitialState`'s
`GotoState('Auto')` enters `Active`, and `SecurityCamera` enters its own
`Active`. The startup draws no random numbers in Training. `bGenerateFlies` is
false, so `PreBeginPlay`'s `bGenerateFlies && FRand() < 0.1` short-circuits.
All 37 Training decorations reach their auto state with no boundary. On
Player start their serialized state is restored: store, position inside the
rebuilt hash, velocity and base.

Decorations also run the recovered `Actor.Tick` in `Level.Actors` order. That
covers the stasis gate, animation, the `DeusExDecoration.Tick` event, state
code, the Timer phase (a bump's push-sound lifetime) and physics. Physics is
the new **non-Pawn `AActor::performPhysics`** (`actor-physics.mjs`).

`AActor::performPhysics` (0x103c9770, vtable +0x8c) switches on `Physics - 2`
through the table at 0x103c99a4:

| Physics | Handler |
| --- | --- |
| 2 Falling | `physFalling` 0x103d0a50 |
| 6 Projectile | `physProjectile` 0x103d4600 |
| 7 Rolling | `physRolling` 0x103d4b80 |
| 8 Interpolating | `OldLocation = Location`, 0x103dd8a0, Velocity |
| 9 MovingBrush | `OldLocation = Location`, 0x103de690, Velocity |
| 11 Trailer | 0x103d7850 |

The tail then runs `physicsRotation` (0x103ca1e0) when any `RotationRate`
component is nonzero in its low 16 bits. After that comes one `PendingTouch`
`PostTouch` dispatch, followed by re-reading and unlinking the current
`PendingTouch`. A linked decoration's Falling/Rolling run the existing
oracle-validated routines (`runDecorationPhysics`) against the **live** level
hash. The old separate decoration-physics pass used the creation-time hash
closure, which a reset rebuilds. `physicsRotation` now uses the recovered, oracle-validated rotation body,
including the four SecurityCameras and spawned fragments. `physProjectile`
runs the recovered body ([projectile](projectile.md)); the remaining movement
modes are explicit boundaries.

`ULevel::Tick`'s DistanceFromPlayer pass (0x103a55c1–0x103a5698) now runs
first each frame. It writes `DistanceFromPlayer` for every slot from
FirstDynamicActor (+0x110, the LoadMap partition boundary) with the
recovered `playerDistance`. The map's serialized editor value (e.g. Plant7's
8672) is never current. The stasis gate and `ScriptedPawn.Tick` read it.

## Crate destruction continuation

The focused placement hits the upper stacked `CrateBreakableMedGeneral2`.
Two swings now run damage 10 → 4 → −2, hit-effect timers, Frag, Destroy and
Containers.Destroyed. Six wood fragments bounce, fade and expire; the
authored Lockpick falls and lands. Reset restores the crate and removes
spawned actors. See [crate destruction evidence and limits](script-crate-destruction.md).

## Focused checks

    node scripts/validate-weapon-select.mjs
    node scripts/validate-play-frame.mjs
    node scripts/validate-training-nanokey.mjs
    node scripts/validate-plant-push.mjs
    node scripts/validate-decoration-settle-roll.mjs
