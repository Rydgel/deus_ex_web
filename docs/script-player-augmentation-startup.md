# Player augmentation startup

The browser player now enters the original standalone subsystem path before
Training interaction. This closes the earlier browser lifecycle gap that left
`DeusExPlayer.AugmentationSystem` null. The implementation is limited to the
source-backed startup slice; it does not claim the later inventory or UI
branches.

## Original call chain

The extracted `DeusExPlayer.uc` (`PostBeginPlay`, `InitializeSubSystems`)
establishes this order:

```text
DeusExPlayer.PostBeginPlay
  -> Super.PostBeginPlay
  -> CreateShadow (standalone)
  -> InitializeSubSystems
       -> Spawn(BarkManager, Self)
       -> CreateColorThemeManager; ThemeManager.SetOwner(Self)
       -> Spawn(AugmentationManager, Self)
            -> CreateAugmentations(Self)
            -> AddDefaultAugmentations()
            -> SetOwner(Self)
       -> Spawn(SkillManager, Self)
            -> CreateSkills(Self)
       -> CreateKeyRing() (standalone)
```

The browser already owns the serialized player identity, so Play attaches that
identity to the live `LevelInfo`, prepares its mesh contract, and calls the
original `InitializeSubSystems` body. Subsystem actors are constructed through
the verified inherited `Engine.Actor` script constructor and then run through
the original VM lifecycle records. No replacement augmentation algorithm is
used.

## Recovered reference state

The installed GOTY `DeusEx.u` class defaults and the
`.cache/original-gobjects-20260912-training-start.txt` capture establish the
following manager state:

* `AugmentationManager1` owns the player and has `Player == JCDentonMale1`.
* `augClasses` is spawned in this exact order:

  ```text
  AugSpeed, AugTarget, AugCloak, AugBallistic, AugRadarTrans, AugShield,
  AugEnviro, AugEMP, AugCombat, AugHealing, AugStealth, AugIFF, AugLight,
  AugMuscle, AugVision, AugDrone, AugDefense, AugAqualung, AugDatalink,
  AugHeartLung, AugPower
  ```

* The `FirstAug`/`Next` chain preserves that order and each augmentation's
  `Owner` is the manager while `Player` is the player.
* `defaultAugs` is `AugLight`, `AugIFF`, `AugDatalink`. After the original
  `GivePlayerAugmentation` calls, those three are owned; `AugIFF` and
  `AugDatalink` are active and `AugLight` is inactive because only
  `bAlwaysActive` augs activate during this path.
* `AugLocs` retains the seven original capacities and key bases
  `[(1,0,4),(1,0,7),(3,0,8),(1,0,5),(1,0,6),(2,0,2),(3,0,11)]`, with the
  final location count at `3` after the defaults.
* Spawned identities use the captured canonical names `AugmentationManager1`
  and `AugSpeed1` through `AugPower1`. The reflected Unreal `Name` property is
  the authority; the host identity mirrors it so level scans and callbacks see
  the same canonical FName.

`AugEnviro` remains unowned, so the original `GetAugLevelValue` returns its
  `-1.0` sentinel. This is why the live Training Radiation10 reduction writes
  `adjustedDamage=10` and returns `false` before the later damage boundary.

## Explicit boundaries

`CreateKeyRing` is the first unsupported startup dependency in standalone
Training. Its `Spawn(class'NanoKeyRing')` / inventory `GiveTo` path is not
implemented, so the adapter reports the typed boundary
`deusex.nanokeyring / CreateKeyRing` after the manager, augmentations, themes,
and skills have been created. The default augmentation notification also
reaches `PlayerPawnExt.ClientMessage`; its localized `Sprintf` conversion is
kept as an explicit UI boundary while the original ownership, linked-list,
active-state, and location-count writes are retained.

The installed-map validator checks all of these assertions against the live
Play host:

```sh
DEUS_EX_GAME_DIR='Deus Ex GOTY Edition' node scripts/validate-player-augmentation-startup.mjs
```

The current output proves `AugmentationManager1`, the 21-class list and names,
ownership and active defaults, location capacities/counts, the unowned
`AugEnviro` sentinel, and the exact `NanoKeyRing.CreateKeyRing` boundary.
