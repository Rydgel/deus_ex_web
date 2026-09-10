# Original script startup: CameraPoint

The startup validator executes the installed original bytecode for
`CameraPoint`'s inherited `Actor.PreBeginPlay`, including its relevance query.
It does not claim to reproduce native `SpawnActor` allocation or the later
native lifecycle sequence.

## Original contract

The source contract is in `.cache/reference/Actor.uc:1008-1027`:

* `CameraPoint` is a native class extending `Keypoint`
  (`.cache/reference/CameraPoint.uc:1-5`). It is therefore neither a
  `Decoration`, `Inventory`, nor `Pawn` for the first `PreBeginPlay` tests.
* `PreBeginPlay` first evaluates
  `(IsA('Decoration') || IsA('Inventory')) && CollisionHeight > 0.75`.
  A matching actor calls native 283, `SetCollisionSize`, with the current
  radius and the height reduced by `0.75`.
* If that branch is false, a `Pawn` with positive collision height calls the
  same native with either `CollisionHeight - 4.5` when height is greater than
  `9`, or `CollisionHeight * 0.5` otherwise.
* It then destroys a non-game-relevant actor when the level is not
  `NM_Client` and `Level.Game.IsRelevant(Self)` is false. Native 279,
  `Destroy`, is consequently a real branch of the original event; the
  validator does not return a fake result for it.

`CameraPoint` has no `PreBeginPlay` override. The fixture loads
`DeusExGameInfo` from the original `DeusEx.u` and confirms that its base is
the original `Engine.GameInfo`. The inherited `GameInfo.IsRelevant` body is
`.cache/research/pawn-startup/engine.gameinfo.uc:431-476`:

1. Call `BaseMutator.AlwaysKeep(Other)` and retain `true` immediately.
2. Otherwise call `BaseMutator.IsRelevant(Other, bSuperRelevant)`. A false
   return rejects the actor; a true return with `bSuperRelevant == 1` keeps it
   before the game filters.
3. Apply difficulty, standalone/server/client flags, and the `bNoMonsters`
   pawn filter.
4. Consume one `FRand()` and reject when it is greater than
   `Other.OddsOfAppearing`.
5. Increment `SecretGoals`, `ItemGoals`, and `KillGoals` for the corresponding
   actor flags, then return true.

The original Engine package has no `Mutator.CheckRelevance` export. The
function named by the source and bytecode is `Mutator.CheckReplacement`,
whose extracted `Engine.Mutator.ScriptText` body returns true. The three
methods used here are:

| Function | Engine export | Script bytes | Behavior reached here |
| --- | ---: | ---: | --- |
| `Actor.PreBeginPlay` | 207 | 204 | Tests class/collision branches, then relevance and possible Destroy |
| `GameInfo.IsRelevant` | 3741 | 542 | Calls mutator chain, filters, one `FRand`, goal counters |
| `Mutator.AlwaysKeep` | 3972 | 36 | Returns `NextMutator.AlwaysKeep` when non-null, otherwise false |
| `Mutator.IsRelevant` | 3975 | 86 | Calls `CheckReplacement`, then an optional `NextMutator` |
| `Mutator.CheckReplacement` | 5480 | 4 | Returns true and leaves `bSuperRelevant` unchanged |

With `NextMutator == None`, the reached function order is therefore:

```text
Actor.PreBeginPlay
  GameInfo.IsRelevant
    Mutator.AlwaysKeep              -> false
    Mutator.IsRelevant
      Mutator.CheckReplacement      -> true, bSuperRelevant remains 0
    FRand                            -> one native 195 call
  return true
```

The LevelInfo source declares `NM_Standalone` as enum value `0` and exposes
the `Game` pointer (`.cache/research/pawn-startup/engine.levelinfo.uc:91-106`).
The validator sets that identity on both LevelInfo and GameInfo, and sets
`GameInfo.BaseMutator` to the attached base Mutator identity.

## Validator fixture and result

`scripts/validate-script-startup.mjs` exports
`createStartupFixture({seed, trace})`. It loads actual class metadata from the
installed `Engine.u` and `DeusEx.u`, attaches four identities, prepares only
the five functions above, and returns the runtime plus
`{level, levelInfo, game, mutator, camera, rng}`. `trace:true` records the
function/native boundaries without replacing any original script result;
unknown native calls throw immediately. The factory does not dispatch
`PreBeginPlay`, so a later SpawnActor validator can install its own lifecycle
services first.

The focused command is:

```sh
node scripts/validate-script-startup.mjs
```

Its explicit inputs are `LevelInfo.NetMode=NM_Standalone`,
`GameInfo.Difficulty=0`, `GameInfo.bNoMonsters=false`, zeroed goal counters,
`CameraPoint.bGameRelevant=false`, all four difficulty flags true,
`bSinglePlayer=true`, `bNet=true`, `bNetSpecial=true`,
`CollisionRadius=10`, `CollisionHeight=32`, all goal flags false, and
`OddsOfAppearing=1`. These values make the CameraPoint collision and destroy
branches observable as conditions while selecting the keep path.

The run verifies the native sequence `[303, 303, 303, 195]` (the three `IsA`
tests followed by `FRand`), no native fallback, and the script call sequence
`GameInfo.IsRelevant → Mutator.AlwaysKeep → Mutator.IsRelevant →
Mutator.CheckReplacement`. `bDeleteMe` remains false and all three goal
counters remain zero.

The shared `createNativeRng(1)` stream advances from state `1` to `2745024`.
The original retained `FRand` product is
`0.0012512588873505592`; the runtime applies the native 195 float32 result
store, and the validator compares both the retained value and post-call state
with an independently advanced stream. This checks stream consumption order,
not a historic game-session seed.

Collision resizing for actual Decoration, Inventory, and Pawn fixtures still
requires native 283 and their original collision/hash effects. Rejection via
native 279 still requires the linked Actor destruction lifecycle. Those paths
remain explicit unsupported boundaries here rather than host stubs.
