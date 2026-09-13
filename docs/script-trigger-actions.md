# Orders, Flag, and Damage trigger actions

This slice prepares the original trigger UFunctions and supplies only the
native state needed for their VM execution. `src/runtime/script-triggers.mjs`
does not duplicate the UnrealScript event bodies. Play routes the prepared
`OrdersTrigger`, `FlagTrigger`, and `DamageTrigger` functions through
`ScriptRuntime.processEvent`/`callFunction`, including the bounded Training
radiation path through its first material state writes.

The evidence is local to the installed GOTY build:

* `Deus Ex GOTY Edition/System/DeusEx.u` TextBuffers contain the original
  UnrealScript source. `OrdersTrigger`, `DamageTrigger`, and `FlagTrigger` are
  class exports 19067, 20380, and 20162; their TextBuffers are exports 19066,
  20377, and 20154.
* `Deus Ex GOTY Edition/System/Extension.u` declares
  `native(1100) SetBool(Name,bool,optional bool,optional int)` and
  `native(1110) GetBool(Name)`. The installed `Extension.dll` contains the
  bodies at image addresses `0x10023c60` and `0x100243c0`; the `exec` wrappers
  are at `0x10024fc0` and `0x10025670`.
* `Deus Ex GOTY Edition/System/Engine.dll` exports `execGetPlayerPawn` for
  native 720 at image address `0x103028ce`, a thunk to the body at
  `0x1036d2a0`. The nearby `0x10302e4b` export is the separate C++
  `AActor::GetPlayerPawn` helper and is not the script native.
* `Deus Ex GOTY Edition/System/Core.u` declares
  `native(123) ... bool != (string A, string B)`. `Core.dll` exports the
  `Object.NotEqual_StrStr` thunk at image address `0x1010304e`, which jumps to
  the body at `0x1013b730`.
* The bounded radiation continuation is documented and oracle-checked in
  [Core damage primitives](script-core-damage-primitives.md): Core natives 144,
  169, 185, 213, and 223 are recovered from `Core-rng.asm` and the installed
  `Core.dll`.
* `scripts/validate-trigger-actions.mjs` re-reads those TextBuffers, checks the
  UFunction script sizes and native indices, checks the recovered native bytes,
  and runs the original bytecode in the live Play runtime against the
  `00_Training` actors.

## Original event bodies and call order

The exact `OrdersTrigger` source is:

```text
Trigger:       if (StartPatrolling()) { Super.Trigger(Other, Instigator); if (bTriggerOnceOnly) Destroy(); }
Touch:         if (!IsRelevant(Other)) return; if (StartPatrolling()) if (bTriggerOnceOnly) Destroy();
StartPatrolling:
               if (Event != '') foreach AllActors(class'ScriptedPawn', P, Event)
                   P.SetOrders(Orders, ordersTag, True);
               return True;
```

The recovered expanded script sizes are `Touch=41`, `Trigger=39`, and
`StartPatrolling=68`. The VM therefore performs the tagged `ScriptedPawn`
iteration before either the one-shot destroy or the inherited `Trigger` call.
`prepareTriggerFunctions` also prepares `ScriptedPawn.SetOrders`,
`FollowOrders`, `SetState`, `SetNextState`, `FindTaggedActor`, and
`FindOrderActor`; those bodies and their state writes remain VM-owned.

`SetOrders` treats `Attacking`, `Fleeing`, `Alerting`, and `Seeking` as the
hostile branch. That branch reaches `ChangeAlly`, `FindTaggedActor`, and
`SetEnemy`, so it remains an explicit broader AI dependency. The Training
`Patrolling`/`Leaving` cases are executed by the original bytecode, with no
nearest-target or state substitute in this module.

The exact `FlagTrigger` call order is:

* `Touch`: `IsRelevant`; cast `GetPlayerPawn` to `DeusExPlayer`; if
  `bSetFlag`, call `FlagBase.SetBool(flagName, flagValue)` when
  `flagExpiration == -1`, otherwise call it with explicit expiration; if
  `bTrigger` and `GetBool(flagName) == flagValue`, call `Super.Touch`.
* `UnTouch`: require `bWhileStandingOnly` and `IsRelevant`; test the flag and
  call `Super.UnTouch`; then, if `bSetFlag`, write `!flagValue` with the same
  expiration split.
* `Trigger`: get the player; set the flag first; test the flag; if enabled and
  `Event != ''`, iterate `AllActors(class'Actor', A, Event)` and call
  `A.Trigger(player, Instigator)`; then call `Super.Trigger`.
* `UnTrigger`: require `bWhileStandingOnly`; test the flag; fan out
  `A.UnTrigger(player, Instigator)` and call `Super.UnTrigger`; then write
  `!flagValue` if `bSetFlag`.

The recovered FlagTrigger sizes are `Touch=195`, `UnTouch=208`, `Trigger=249`,
and `UnTrigger=262`. `prepareTriggerFunctions` includes inherited
`Engine.Trigger.Touch`/`UnTouch`, `Engine.Trigger.IsRelevant`, and
`Engine.Actor.Trigger`/`UnTrigger`, so the VM can preserve the original
`Super` and tagged fanout calls.

The exact `DamageTrigger` source uses `SetTimer` and the broader damage path:

```text
Timer:    if (!bIsOn) { SetTimer(0.1, False); return; }
          if (damagee != None) damagee.TakeDamage(damageAmount, None, Location,
              vect(0,0,0), damageType);
Touch:    if (bIsOn && IsRelevant(Other)) { damagee=Other;
          SetTimer(damageInterval,bConstantDamage); Super.Touch(Other); }
UnTouch:  if (bIsOn) { damagee=None; SetTimer(0.1,False); }
Trigger:  if (!bIsOn) bIsOn=True; Super.Trigger(Other,Instigator);
UnTrigger:if (bIsOn) bIsOn=False; Super.UnTrigger(Other,Instigator);
```

Its recovered UFunction sizes are `Timer=80`, `Touch=69`, `UnTouch=31`,
`Trigger=37`, and `UnTrigger=35`. The installed Training map's `DamageTrigger1`
has `DamageAmount=10` and `DamageType=Radiation`. A prior browser host attached
the player without its standalone lifecycle, so its validators forced
`AugmentationSystem` to null. The current host runs
`PostBeginPlay -> InitializeSubSystems` first and proves the normal non-null
manager path in `scripts/validate-player-augmentation-startup.mjs`. The
prepared Timer call therefore begins this exact original chain:

```text
DamageTrigger1.Timer (15220, size 80)
  -> DeusExPlayer.TakeDamage (17205)
  -> AddDamageDisplay (17835)
  -> DXReduceDamage (17197)
  -> StopPoison (17902)
  -> UsingChargedPickup (17001)
  -> SetDamagePercent (17833)
  -> HealthLegLeft -= 10
  -> PlayAnim('HitLegLeft', , 0.1) -> AActor::execPlayAnim (259)
  -> GenerateTotalHealth (17220)
  -> GetLevelInfo (17962)
  -> PlayDXTakeDamageHit (17174, prepared)
  -> PlayHit (17166, prepared)
  -> Human.PlayTakeHitSound (16845, prepared)
  -> Actor.PlaySound (264, explicit audio boundary)
```

The startup defaults leave `AugEnviro` unowned, so its original
`GetAugLevelValue` sentinel is `-1.0`; live `DXReduceDamage` consequently
writes `adjustedDamage=10` and returns false for Radiation10. `StopPoison`,
`AddDamageDisplay`, and `SetDamagePercent` retain their source bodies. Because
the damage is not reduced, `SetDamagePercent` takes its zero-percent branch and
does not call `ClientFlash` in this case. The prior
`adjustedDamage=0`/`Health=100`/flash assertions described a browser lifecycle
gap rather than an authored Training state. The current host writes the left
leg to `90`, recomputes total `Health=98`, and reaches the source-backed hit
response. `PlayDXTakeDamageHit` and `PlayHit` are now prepared; the next exact
unsupported operation is `Human.PlayTakeHitSound -> Actor.PlaySound(264)`.

After those writes, the original `TakeDamage` path selects
`PlayAnim('HitLegLeft', , 0.1)`, which reaches AActor `execPlayAnim` native 259.
The canonical `DeusExCharacters.GM_Trench` resource is prepared during player
attachment, so the live native state is `AnimSequence=HitLegLeft`,
`AnimFrame=-4`, `AnimRate=2.5`, `TweenRate=0.4f`, and `AnimLast=-3`.
`Human.PlayTakeHitSound` then chooses its original pain-sound branch from the
shared RNG and reaches the existing recorded-audio boundary. The scene router
records the exact unsupported native as `DamageTrigger1.Timer mission script`
for normal Play ticks; the direct VM validator preserves the full boundary
message. No synthetic health, armor, damage type, timer, audio, mesh, or UI
behavior is substituted.

## Recovered native boundaries

`XFlagBase::SetBool` first looks up an existing bool flag. Its body applies only
bit 0 of the supplied value (`old ^ ((old ^ value) & 1)`), which is the same
logical result as the VM's typed UBOOL argument (`false`/`true`). A direct host
harness may pass an integer word and `createFlagBase` retains this low-bit
rule; other values are rejected rather than converted with JavaScript truthiness.
A missing bool is created only when optional `bAdd` is true; otherwise the call
returns false without insertion. The return value is true when a bool flag
object exists after the update. Optional expiration `-1` is replaced by
`XFlagBase`'s `defaultExpiration`; the constructor at `0x100239a0` writes zero
to that field. An explicit expiration is passed to `XFlag::SetExpiration`.

`XFlagBase::GetBool` looks up a bool flag, writes its stored logical value when
present, and returns false for a missing bool. The `execGetBool` wrapper zeros
the script result on that false return. `createFlagBase` models this add/update,
return, and `-1`/default split and records both requested and effective
expiration. It does not remove expired flags: the separate
`DeleteExpiredFlags`/clock path is outside this slice and must remain an
explicit host boundary. Native 1100/1110 calls are accepted only when their
receiver is the exact `FlagBase` service bound to the player's `flagBase`
property; a different or missing receiver is rejected as an unlinked native
object.

The script native 720 body is recovered from `Engine.dll` and the local
`.cache/reference/Engine.asm`. At `0x1036d2a0` it advances the `FFrame` code
pointer by one byte, then follows `Actor+0xac` (`XLevel`), `XLevel+0x40`
(`Engine`), and `Engine+0x44` (`Client`). It reads the client's viewport array
data at `Client+0x2c` and signed count at `Client+0x30`; a non-positive count or
null first viewport returns null. Otherwise it returns the first viewport's
`Actor` field at `Viewport+0x30`. The body does not test receiver class
ancestry or `Actor+0x5d4`; those belong to the separate C++ helper exported at
`0x10302e4b`.

`resolveNativeGetPlayerPawn(receiver, {read})` mirrors this pointer walk. The
host must expose the named `XLevel -> Engine -> Client -> Viewports` graph, with
`Viewports` represented as an array or `{data, count}` pair. A missing graph
field is an explicit integration error; a null native pointer returns null.
`createScriptTriggers` has no captured-player fallback. Its
`getPlayerPawnServices` option invokes this recovered walk, while an explicit
`getPlayerPawn` callback remains responsible for applying the same service at
an existing host boundary.

The base `Trigger.Touch` body also reaches Core native 123,
`Object.NotEqual_StrStr`, for its `Event != ''` gate. The original Core body at
`0x1013b730` advances both operand expressions, calls `appStrcmp`, and stores a
logical true exactly when the strings differ. `handleNative` implements only
this typed string comparison; non-string operands and wrong arity are explicit
errors. This closes the primitive needed before a trigger can reach its next
mission action boundary and does not claim broader Core string operations.

Core native 210, `ComplementEqual_FloatFloat` (`~=`), is now available in the
shared VM. It preserves the original float32 operands, strict `0.0001` x87
comparison, signed-zero result, and unordered/NaN result. The radiation path's
additional Core arithmetic (144, 169, 185, 213, and 223) is covered by the
focused [native oracle](script-core-damage-primitives.md); no broader Core
operator set is implied.

The other direct native declarations used by the original bodies are
`Actor.SetTimer` (280), `Actor.Destroy` (279), and the `AllActors` iterator
(304). Existing runtime code owns 279, 280, and 304; the trigger service
claims 123, 720, 1100, and 1110. The native callback must pass all other indices to
the normal runtime dispatcher.

## Training reference cases and validation

The validator confirms these serialized map values, then runs the original VM
functions in Play:

| Actor | Recovered values | Original VM check |
| --- | --- | --- |
| `OrdersTrigger0` | `Event=JaimeReyes2`, `Orders=Patrolling`, `ordersTag=gunroom`, one-shot false | `Touch` runs `StartPatrolling`/`SetOrders` and writes `JaimeReyes1.Orders=Patrolling`, `OrderTag=gunroom`, `NextState=Patrolling` |
| `JaimeReyes1` | `Tag=JaimeReyes2`, initial `Orders=Standing` | Tagged `ScriptedPawn` is selected by the original `AllActors` iterator |
| `FlagTrigger0` | `FlagName=MunitionsTrooperReady`, `flagValue=true`, `bSetFlag=true`, `bWhileStandingOnly=true`, `flagExpiration=-1` | VM `Touch` calls native 1100; VM `UnTouch` calls native 1100 with inverse value; the observed flag transitions true then false |
| `DamageTrigger1` | `DamageAmount=10`, `damageInterval=1`, `DamageType=Radiation`, `bIsOn=true` | Timer enters the prepared chain with the live AugmentationManager; `DXReduceDamage` writes `adjustedDamage=10`/false, body health becomes `HealthLegLeft=90`/`Health=98`, and GM_Trench stores the original `HitLegLeft` PlayAnim state before the exact `Human.PlayTakeHitSound -> Actor.PlaySound(264)` boundary |

Run the focused native/preparation tests with:

```sh
node --test test/script-trigger-actions.test.mjs
```

Run the package-backed original-VM validator with:

```sh
DEUS_EX_GAME_DIR='Deus Ex GOTY Edition' node scripts/validate-trigger-actions.mjs
```

## Play integration contract

The Play host binds the trigger service and prepared records during setup. Its
integration contract is:

1. After actor identities are attached, create one service with the live
   `playerActor` and a persistent `createFlagBase()` instance. Bind its player
   `flagBase` field with `actions.bindPlayerFlagBase(runtime, playerActor)`.
2. Call `prepareTriggerFunctions(runtime, assets)` before the first trigger
   event. Keep the returned records available for diagnostics; event dispatch
   itself should use `runtime.processEvent` so the original bytecode performs
   `AllActors`, `SetOrders`, inherited calls, and state writes.
3. In `nativeCall`, call `actions.handleNative(call)` before the final
   unimplemented-native error and return its `value` only when `handled` is
   true. Pass unclaimed indices to the existing runtime/native path.
4. Supply `getPlayerPawnServices: { read }` using the live native graph, so
   native 720 follows `receiver.XLevel -> XLevel.Engine -> Engine.Client ->
   Client.Viewports[0].Actor`. The callback form is also accepted when it
   delegates to `resolveNativeGetPlayerPawn`; a captured global player is not a
   valid replacement for this graph walk. The current Play host binds one
   viewport to its controlled JC through this graph before creating the script
   runtime.
5. Keep DamageTrigger on the original VM path. When `Timer` reaches
   `Pawn.TakeDamage`, allow the prepared Radiation10 chain to preserve its
   authored body-part and total-health writes with the live manager, then run
   the prepared `PlayDXTakeDamageHit`/`PlayHit`/`Human.PlayTakeHitSound` bodies.
   The first unsupported operation after those writes is the existing
   `Actor.PlaySound(264)` audio boundary; do not restore the former null-manager
   damage approximation or fabricate sound playback.

This slice does not establish hostile ScriptedPawn AI, the global FlagBase
expiration clock, later TakeDamage body effects, audible playback after the
`Actor.PlaySound(264)` boundary, mesh rendering, or UI rendering.
