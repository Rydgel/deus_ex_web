# Selected scene event bodies

## Batch 6 live dispatch

Live Play now bypasses the historical dry helper below and dispatches the
attached actor's original event bytecode. In particular, closing-door contact
calls `Mover.EncroachingOn` (`Mover.uc:584–651`) and consumes its bool result.
The recovered native caller/result-block contract already implemented by
`ScriptRuntime.dispatchSpawnedEvent` supplies the typed result slot and
preserves probe suppression. The scene router must use that entry, rather
than treating `processEvent`'s host dispatch-status bool as the script result.
The Stage 2 standalone helper remains for its isolated reference fixtures.

Source-first scope: ordinary JC PlayerWalking and Training's two TriggerToggle
panels. Original Actor declares empty HitWall, BumpWall, Touch, UnTouch,
BeginEvent and EndEvent. Pawn declares empty UnderLift and EncroachedByMover.
PlayerWalking explicitly ignores Bump; the audited JC ancestors do not override
the other listed empty bodies. Pawn.EncroachedBy calls gibbedBy only for a Pawn
argument, so receiving a mover has no body effects. Pawn.EncroachingOn rejects
an actor with Brush, a Brush subclass, or another Pawn when !bIsPlayer/bWarping.

Original Mover.Bump654–680 filters BumpType, triggers nonempty BumpEvent and
PlayerBumpEvent, then clears the pawn's SpecialGoal when it equals the mover.
For the two selected panels both event names are empty. TriggerToggle does not
override Bump. Do not generalize this absence to arbitrary movers or events.

Mover.EncroachingOn584–651 has destructive Decoration/Carcass/Fragment branches,
then accepts a based actor, applies nonzero EncroachDamage, optionally Bumps a
player, checks the MyMarker under-lift condition, and finally applies its policy.
The selected pair has no EncroachDamage, PlayerBumpEvent or MyMarker and uses
IgnoreWhenEncroach3. Pawn.UnderLift is empty for JC if a marker branch is later
reached, but unknown mover values/classes must not be silently accepted.

These hand-written branches cover recovered **native-semantics** cases (the empty
JC bodies, the `EncroachingOn` collision predicates, the TriggerToggle mover
policy) that are not plain script dispatch. Everything else now routes to the
**general VM router** (below) rather than an `unsupported()` pause. It is
independent from native dispatch ordering, which has original
MoveActor/CheckEncroachment captures.

## General VM router (item #2)

The scene adapter is the single event boundary, but its fallback no longer pauses:
any actor/event outside the native-semantics branches is delegated to
`hooks.dispatchEvent` (late-bound in `player-scene.mjs`, wired in `game.mjs` to the
door host's `dispatchEvent`, `script-doors.mjs`). That router resolves the event
function through the attached actor's class/state ancestry (`runtime.lookup`) and
runs its real bytecode via `runtime.processEvent`. It returns `{handled:false}`
when the ancestry declares no such function — the original empty-event no-op — and
`{handled:true,result}` when the real body ran. A prepared body that reaches a
not-yet-prepared function or an unbuilt native/subsystem throws the original
specific pause, so the boundary is now the **real bytecode**, not this adapter.
Because the movement/touch callers dispatch synchronously within the tick, event
functions are prepared at setup (per milestone), not on demand.

The decoration `Bump` special-case is folded into this router (its `SetTimer(0.2)`
push-sound lifetime tracking is preserved). `test/scene-events.test.mjs` covers the
delegation contract; the live path is exercised by `validate-plant-push`,
`validate-decoration-settle-roll` and `validate-gameplay`.

### Frob (item #2, M2; roadmap item #3)

`game.use()` sends every non-mover frob target through the original
right-click path, `DeusExPlayer.ParseRightClick` (dispatched through this router so
a pawn's conversation gets the presenter lifecycle). ParseRightClick checks
`RestrictInput`, grabs a pushable decoration (`GrabDecoration`), and otherwise calls
`DoFrob`: the target's `Frob(player, None)`, the owned-object `Futz` AI event and
`PlayPickupAnim` (`PushButton` within 16 units of height, else `Pickup`). Before
2026-09-23 the host called `Frob` directly, which skipped DoFrob and frobbed a
pushable decoration instead of grabbing it. Grabbing now reaches the explicit
carry boundary (`PutCarriedDecorationInHand`'s `SetLocation` of a map decoration).
A plain decoration's `Frob` is its real inherited `DeusExDecoration.Frob` — the empty
`Actor.Frob` base, `DeusExPlayer.StartConversation` (early-false while `ConListItems`
is null, the training case; **not** replaced with an unconditional false, per
docs/script-light-switch.md), then the `Event`/`AllActors` trigger fanout (skipped
when `Event` is None).

**LightSwitch → TriggerLights (roadmap item #3, done).** Frobbing a `LightSwitch`
runs its full override: `Super.Frob`'s `AllActors('cratelight')` fanout calls
`Actor.Trigger` on each tagged TriggerLight, and because the door host now shares a
`createScriptLights` controller that advances the four TriggerLights into their
`TriggerToggle` state at load (and ticks their Alpha each frame), that virtual call
dispatches to the real state `Trigger` — toggling the lights. The switch's
`PlayAnim` runs the real `execPlayAnim` native (its `AnimSequence` is set; only the
mesh rendering is a Stage-4 boundary); `PlaySound` (`264`) is recorded as a Stage-4
audio boundary. Verified by `scripts/validate-frob.mjs` (plants and the full
LightSwitch → 4 TriggerLight toggle, both directions).

### Trigger Touch/UnTouch (item #2, M3, record-as-boundary)

Trigger `Touch`/`UnTouch` route through the general router instead of being blindly
deferred. Trigger bodies reach mission subsystems that are not built, so the runtime
gained two mechanisms: (1) **`boundaryFunctions`** — a Map (parallel to
`boundaryNatives`) of scripted functions the host short-circuits with a recorded
effect and a host-selected return value; and (2) a **record-as-boundary fallback** in the
trigger branch — a body that reaches an unbuilt subsystem (an unprepared helper, or
a boundary/unimplemented native) is recorded as a deferred mission-script effect
rather than pausing play (real errors still throw). The trigger branch runs the real
available script instructions before deferring at an unbuilt call. This is not
a transaction: writes performed before that call remain applied. The fallback
does not establish faithful execution or safe continuation for arbitrary triggers.

**DataLinkTrigger (`DL_Start` live).** `DataLinkTrigger.Touch` runs its real
`EvaluateFlag` gating. The admitted Training `DL_Start` call then executes the
installed player selection/spawn path and returns true, so the original Touch
body writes `bStartedViaTouch` and `triggerOther`. Completion executes the
original `DatalinkFinished` and parent `Trigger.Touch`; the trigger's authored
one-shot flag reaches native `SetCollision(False)` and removes it from the live
hash. Other DataLink tags remain at an explicit false admission guard until
their authored event chains are linked. See
[live DataLink lifecycle](script-datalink-live.md). The VM also gained the pure
Core operators `==`/`!=` bool (natives 242/243).

**Base Trigger (done).** `Trigger.Touch` runs its real `IsRelevant` gate — the
`switch(TriggerType)` (the VM **EX_Switch/EX_Case** lowering; see the Core semantics
below) and the
native **`ClassIsChildOf`** (258) — then the `Event`/`AllActors` → `Actor.Trigger`
fanout (the validated mechanism the LightSwitch also uses). Training's only base
`Trigger0` is `TT_ClassProximity` for `Carcass` (a corpse-detection trigger that opens
its body doors), so the player is not relevant and its Touch is a real no-op — not the
false "mission script" deferral it produced before. The carcass fanout is not
exercised in the training start (no carcass present). Verified by
`scripts/validate-triggers.mjs` (datalink + base-Trigger gating across two
TriggerTypes).

**Orders and Flag triggers.** Play prepares and executes their original
Touch/UnTouch/Trigger helpers. OrdersTrigger0 finds JaimeReyes1 through the
original tagged iterator and queues `Patrolling`/`gunroom` through SetOrders
and FollowOrders. FlagTrigger0 sets MunitionsTrooperReady on Touch and clears
it on UnTouch through the recovered FlagBase bool natives. Native GetPlayerPawn
walks the explicit XLevel/Engine/Client/first-viewport graph. This does not
implement the subsequent AI patrol state or the global flag-expiration clock.

**DamageTrigger scheduling.** Its original Touch sets damagee and calls
SetTimer; the Play host advances its timer and dispatches the original Timer.
On Training's `Radiation10` case, Timer enters the prepared original chain
`DamageTrigger1.Timer -> DeusExPlayer.TakeDamage -> AddDamageDisplay ->
DXReduceDamage -> StopPoison -> UsingChargedPickup -> SetDamagePercent` with
the live `AugmentationManager1`. The prior browser host skipped player
subsystem startup and forced a null manager, so its `adjustedDamage=0` and
`Health=100` assertions described a lifecycle gap. The current default
`AugEnviro` is unowned: live `DXReduceDamage` writes `adjustedDamage=10` and
returns false. The original body then writes `HealthLegLeft=90`, recomputes
`Health=98`, and selects `PlayAnim('HitLegLeft',,0.1)` on the prepared
`DeusExCharacters.GM_Trench` mesh (`AnimFrame=-0.25`, `AnimRate=2.5`,
`TweenRate=2.5`, `AnimLast=0.75`; see the original-execution correction in
[animation controls](script-animation-controls.md)). These are native call-exit
values. The full scheduler runs the original Actor.Tick animation phase before
the controlled-player tail, so subsequent ticks advance the negative tween by
`f32(frame + f32(delta) * TweenRate)` ([original animation tick](script-animation-tick.md)).
The trigger validator captures native 259's start values and separately checks
each subsequent public-tick tween step; a final frame fixed at -0.25 would
incorrectly require player animation to stop. `PlayDXTakeDamageHit`, `PlayHit`, and
`Human.PlayTakeHitSound` are prepared from the installed bytecode. The next
exact unsupported operation is `Actor.PlaySound(264)` from
`Human.PlayTakeHitSound`; normal scene dispatch records it as the
`DamageTrigger1.Timer mission script` boundary, while the focused validator
retains the full caller path. UnTouch clears damagee. See
[trigger actions](script-trigger-actions.md), [player startup](script-player-augmentation-startup.md),
and the focused installed-map check in
`scripts/validate-player-augmentation-startup.mjs`.
Damage, gibbing, and mover policies beyond this slice remain explicit gaps.

Registering the player exposes original mission trigger contacts, beginning with
Training DataLinkTrigger23.Touch. Its original source sets a player reference,
checks mission flags and calls StartDataLinkTransmission; success controls later
trigger fields and its eventual parent Touch — the datalink is now run to that
boundary and recorded (above). General Trigger.Touch can dispatch named events and
disable collision; conversation/audio/datalink *presentation* stays Stage-4. Native
reciprocal touching bookkeeping still runs. What is not yet built (subsequent AI,
later damage effects, flag expiration and datalink transmission/completion) is recorded as a
deferred mission-script effect at its boundary rather than being invented — an
explicit, honest whole-game fidelity gap, closed incrementally per trigger type.

### EX_Switch / EX_Case (Core execSwitch 0x1012f850, execCase 0x1012fa20)

`execSwitch` owns the case scan. It reads the switch value's size byte, evaluates
the value, then walks the `EX_Case` chain: each case skips its token, reads the
next-case offset, stops at `0xffff` (default or terminator) or evaluates its value
and compares it (`appMemcmp` over the size, or `appStricmp` of the two FStrings for
size 0). A match enters the code after that case; a mismatch jumps to the next
case. `execCase`, reached only by falling into a case, just steps over its
expression. Stacked labels (`case 0: case 9: case 10:`) and case bodies without a
`break` therefore fall through. Until 2026-09-23 the VM compared at every
`EX_Case`, so a stacked label's body never ran: InformationDevices.ProcessTag lost
its text (`case 0`) and colour (`case 15`) tags.
