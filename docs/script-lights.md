# Original training light-switch behavior

The installed `00_Training.dx` contains a concrete script-controlled lighting
case for Stage 3. The source is the original Engine/DeusEx package metadata,
bytecode and extracted UC in `.cache/reference`, with native anchors below.
The controller is checked against Play's shared actor/property host. Automatic
light ticking, player switch interaction and renderer updates are not enabled yet.

## Map actors and script path

`LightSwitch0` (map reference 1605) has `Event='cratelight'`. Four actors with
that Tag receive its event: TriggerLight0..3, map references 111, 113, 114, 110.
They use `InitialState='TriggerToggle'`, brightness 50/50/25/25, radius 40,
cone 255, hue 35 and saturation 125.

`LightSwitch.Frob` is DeusEx.u export 13691, expanded script size 77. Its
final Super.Frob call resolves to `DeusExDecoration.Frob` (export 129).
That original body uses Actor.AllActors native304 for Event fanout and calls
each target's virtual `Trigger(Self, P)`, so the target's `SavedTrigger` is the
actual LightSwitch actor. Decoration PlaySound264 and
PlayAnim259 are also required on the switch route.

Engine.u TriggerLight class is export 5296. Relevant bodies are:

| Body | Export | Expanded size | Original behavior |
| --- | ---: | ---: | --- |
| BeginPlay | 5217 | 85 | Disable Tick, save initial brightness, initialize Alpha/Direction from bInitiallyOn, set DrawType=DT_None; no Super.BeginPlay call. |
| TriggerToggle state | 5228 | — | Original selected state; probe mask `[64,0]`. |
| TriggerToggle.Trigger | 5229 | 74 | End the old SavedTrigger event, store Other, begin its event, reverse Direction, enable Tick. |
| Tick | 5218 | 302 | Advance Alpha by Direction*DeltaTime/ChangeTime, clamp endpoints, disable Tick/end the saved event at completion, apply bDelayFullOn brightness behavior, and swap corona Skin/MultiSkins[1] at zero brightness. |

The state handler uses native182 for Direction multiplication and native117
for Enable. Tick uses float arithmetic/comparisons including native180/181
(EqualEqual/NotEqual_FloatFloat), plus 117/118/119/130/132/154/171/172/176/177/182/184.
The recovered [float predicates](script-decoration-primitives.md#float-equality-and-inequality)
180/181 are now VM primitives, including the original float32 and unordered
comparison behavior. This closes that arithmetic dependency only.
`AActor::ProcessEvent` is `10302d74 ->10369100`; native script-event entry
wrappers include `eventTrigger` at `10323270` and `eventTick` at `103232c0`.

## ScriptRuntime controller

`src/runtime/script-lights.mjs` exports `createScriptLights({ runtime, assets,
lights })`. `lights` must contain raw identities already attached to the
supplied `ScriptRuntime`; the host remains responsible for map property bindings and
for attaching the LightSwitch identity used as `Other`. Class and state
preparation is asynchronous. Once preparation resolves, the returned methods
are synchronous:

* `reset()` runs the original TriggerLight `BeginPlay` body and then the
  prepared `Actor.SetInitialState` body for each light. `SetInitialState`
  chooses the authored `InitialState` through native `GotoState`; the
  controller never selects `TriggerToggle` by hand. On a repeated reset it
  first uses the original `GotoState('None')` transition to clear the old
  state's probe result before `BeginPlay` disables Tick. It restores the typed
  pre-startup fields written by these selected bodies, including the original
  LightBrightness and corona references, before re-running startup.
* `trigger(light, other, eventInstigator)` dispatches the original `Trigger`
  event through `ScriptRuntime.processEvent`. For the training route,
  `other` is `LightSwitch0` and the instigator is the player. The actual
  `TriggerToggle.Trigger` body performs `EndEvent`, `SavedTrigger` assignment,
  `BeginEvent`, direction reversal and `Enable('Tick')`.
* `tickActor(light, deltaTime)` performs the script phases of the generic
  `AActor::Tick`: the `Tick` probe/event, `ProcessState`, then the timer phase.
  `tick(deltaTime)` applies this in the supplied light order. The native
  actor's eligibility, physics, collision, networking and renderer work stay
  with the host; `tickActor` is the explicit boundary for that omitted part.
* `snapshot(light)` reads typed fields with `runtime.namedReference`, including
  `Alpha`, `Direction`, `InitialBrightness`, `DrawType`, byte `LightBrightness`,
  `SavedTrigger`, `Skin`, `MultiSkins`, state name and probe status.

The source-backed ordering is visible in the installed data. `Actor.uc`
defines `SetInitialState` at lines 1075--1081 as `GotoState(InitialState)` (or
`Auto` when the name is empty). `AActor::Tick` is Engine.dll body `103a1aa0`
(export thunk `10303daa`): the ordinary branch tests probe EName `0x150` at
`103a2653--2669`, calls ProcessEvent through the actor vtable at
`103a2671--268d`, then calls ProcessState through vtable slot `+0x14` at
`103a2690--2698` and enters the timer phase at `103a269b`. TriggerLight's
class probe mask is `[0, 0x10]`; its TriggerToggle state contributes
`[0x40, 0]`, so a successful initial-state transition enables both Trigger
(`0x132`) and Tick (`0x150`) after `BeginPlay`'s Disable('Tick').

The actual 00_Training actors have `ChangeTime` at the class default zero,
`bInitiallyOn=false`, and map brightness bytes `[50, 50, 25, 25]`. Therefore
the installed Tick body reaches its original float divide-by-zero/clamp branch
on the first enabled tick and writes the original byte brightness before
disabling Tick. The body uses serialized conversion opcode `0x43`
(`FloatToByte`, identified by the Core token table in `UStruct.cpp`) around the
non-delay brightness expression. The controller delegates this expression to
the VM and does not substitute a JavaScript brightness calculation; execution
requires the shared VM's source-backed `0x43` conversion case.

`scripts/validate-script-lights.mjs` now uses the actual `createGame` actor
identities and property bindings. It checks the complete original actor array,
inherited mesh identity and the four real lights. It executes the original
DeusExDecoration.Frob with JC, including the StartConversation early return
against this host's explicitly checked null ConListItems, then the original
AllActors fanout and each target's virtual Trigger. This does not establish
the conversation list after native ConBindEvents in a fully started game.
The same focused check covers Tick brightness/corona changes, reversal, reset
and a controlled nonzero ChangeTime interruption using the installed bytecode.

## Remaining integration

The generic iterator and the full map actor array are supplied by the shared
host. This controller intentionally leaves the LightSwitch `Frob` wrapper's
Decoration conversation, PlayAnim259 and PlaySound264 services to that host;
it exposes the original Trigger event directly so those boundaries cannot be
replaced by a hand-written toggle. The host must also add renderer invalidation
when `LightBrightness`, `Skin` or `MultiSkins` changes.

`unreal/lighting.mjs` and `viewer/world.mjs` currently compute/cache initial
lightmaps and upload a static atlas. Updating the script's LightBrightness does
not yet update that atlas. The atlas now supports replacing samples in existing
tiles with unchanged UVs and padding, but the recovered engine must determine
when and how to rebuild those samples. Actor.uc declares transient bLightChanged for lighting
recalculation, but its exact setter/invalidation path still needs original native
analysis. Render.dll entry points `GlobalLighting` (`10b010b4`) and
`SetupDynamics` (`10b0118b`) lead to the original lighting routines documented
in `lighting.md`. The [invalidation trace](script-light-invalidation.md) establishes
that the training lights use stored surface lists and do not enter SetupDynamics'
moving-light branch with their authored flags. Their surface-cache update remains
unresolved. The [switch trace](script-light-switch.md) records the separate native
conversation, sound and animation dependencies of the complete player Frob route.

DeusEx.CageLight offers another original Trigger body (export 13565, size 102):
after Super.Trigger it toggles bOn, LightType between LT_Steady/LT_None,
bUnlit, and ScaleGlow between 2/1. The training crate-light path is the chosen
integration case because it additionally exercises event fanout, state dispatch,
scheduled Tick, brightness changes and corona state.
