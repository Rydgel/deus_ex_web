# Player augmentation startup

Play's player is spawned by the original DeusExGameInfo.Login
([script-player-login.md](script-player-login.md)), so its own PostBeginPlay
builds the subsystem graph. `script-player-startup.mjs` prepares that bytecode
before Login and verifies the resulting graph afterwards. It calls none of it.
The earlier isolated path is removed. That path attached the browser's player,
called InitializeSubSystems directly and forced name counters.

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

The chain runs inside Login's `Spawn(JCDentonMale)`. Subsystem actors are
constructed by the general SpawnActor with their bound ClassConstructors and
run through the original VM lifecycle records. No replacement augmentation
algorithm is used.

## Recovered reference state

The installed GOTY `DeusEx.u` class defaults and the
`.cache/original-gobjects-20260912-training-start.txt` capture establish the
following manager state:

* The AugmentationManager owns the player, and its `Player` is the player.
  The capture names them `AugmentationManager1` and `JCDentonMale1`; see
  below for the suffix.
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
* Names come from MakeUniqueObjectName's live class counters. The reflected
  Unreal `Name` property is the authority, and the host identity mirrors it.
  The capture's session started at the DX.dxm menu, whose player took suffix
  0, so Training's objects there are `AugmentationManager1`, `AugSpeed1` and
  so on. Play's session starts at Training, so Login creates
  `AugmentationManager0` and `AugSpeed0` through `AugPower0`.

`AugEnviro` remains unowned, so the original `GetAugLevelValue` returns its
  `-1.0` sentinel. This is why the live Training Radiation10 reduction writes
  `adjustedDamage=10` and returns `false` before the later damage boundary.

## Explicit boundaries

`CreateKeyRing` now runs. `NanoKeyRing` is admitted by the script-only
Inventory spawn path (`GiveTo`, `AddInventory`, `GotoState('Idle2')`,
`SetBase`). The object belt UI is still absent; selecting the ring calls
`PutInHand` and `UpdateInHand` directly. See [the nano key contract](script-nanokey.md).
The default augmentation notification reaches the original
`PlayerPawnExt.ClientMessage` event during Login.

The installed-map validator checks all of these assertions against the live
Play host:

```sh
DEUS_EX_GAME_DIR='Deus Ex GOTY Edition' node scripts/validate-player-augmentation-startup.mjs
```

The current output proves `AugmentationManager0`, the 21-class list and names,
ownership and active defaults, location capacities/counts, the unowned
`AugEnviro` sentinel, and a spawned `NanoKeyRing` owned by JC.
