# Training munitions-instructor conversation

## Local access while the Training route is incomplete

The viewer's **Instructor preview** button resets the Play scene and places JC
beside `UNATCOTroop3`, using the collision-safe position already exercised by
the instructor integration fixture (80 units west of the authored Location,
facing east with pitch -0.3 radians). This is explicitly viewer test navigation,
not original game travel or evidence that keys and the Training route work.
It does not unlock doors, grant items, set conversation flags, select a frob
target or start dialogue. Normal startup, targeting, **F**, and conversation
bytecode still own the interaction. Wait a few seconds for startup, then press
**F**. **Player start** restores the normal spawn. Subtitles remain incomplete.

Verified with the instructor browser regression entering through this button
and the real F key (including speech, termination and reset); production build
passes. This shortcut does not establish end-to-end Training progression.

> **Checkpoint update, 2026-09-21:** the subtitle window boundary is closed.
> `XWindow::ConfigureChild`'s two conditional leaves — BoundsUpdate `0x10051160`
> (recursive absolute-bounds/clip, GC copy, child recursion) and SortWindowLists
> `0x10045140` (inert on the shell's empty manager lists) — are recovered
> bit-exact against Extension.dll and wired into the conversation window service
> ([script-window-bounds-update.md](script-window-bounds-update.md)). Enabling
> `DeusExPlayer.bSubtitles` now runs `SetupEventSpeechPost → Show/Clear/
> DisplayName/DisplayText` to completion: the first-person panel shows the
> original speaker display name (via `GetDisplayName`, which needed the local
> viewport listener now bound to `PlayerPawn.Player`) and the original speech
> text, and hides with the original Hide branch when the preference is off while
> speech still plays. The preference is the original `bSubtitles` globalconfig
> (shipped `True` in User.ini), read at startup and toggled by a discoverable
> diagnostics checkbox; the class default is unchanged.
> `scripts/validate-instructor-conversation.mjs` now asserts hidden-by-default,
> enabled name/text, and toggle-off hiding, all with speech. The full native
> TileWindow reconfiguration/render tree remains Stage 4. Stage 3 remains open.

The Training munitions instructors are `UNATCOTroop0` and `UNATCOTroop3`
(`00_Training`), both `BindName = MunitionsTrooper`. `ConBindEvents` binds them
`MunitionsTrooperFrob` (Conversation3) then `MunitionsTrooperTake`
(Conversation4) from Mission00 (see
[conversation binding](script-conversation-binding.md); confirmed live by
`tools/dump-conlist-win.c`). `UNATCOTroop1`/`UNATCOTroop2` have a different
BindName and bind nothing. This document records the recovered face-to-face
conversation contract, live playback, and the remaining fidelity limits.

## Continuation contracts — 2026-09-21

The Liberty Island preparation failure is in the package string adapter.
Core FString archive operator `0x101459b0`, reached through
UStrProperty.SerializeItem `0x10167750`, loads negative-count strings as raw
16-bit units. It does not validate Unicode scalar values or strip a byte-order
mark. The existing original-DLL SerializeItem probe, supplied with
`[0x84,0xff,0xfe,0x00,0xd8,0x41,0x00,0,0]`, returns
`[0xfeff,0xd800,0x0041,0]` with Num/Max 4. The package Reader must preserve
those units too. See [the recovered serializer](script-property-serialize-item.md).

Public Player start restores a fresh browser scene. Conversation package
objects persist as host identities, so their mutable reflected values must be
restored from their pre-play values, along with the live flag-base state. A
flag set by FlagTrigger.Touch and RandomLabel.cycleIndex previously survived that
reset; both now restore their fresh values. Tests must observe reset directly, without clearing a flag or setting a
conversation field afterward. This host reset is distinct from original map
travel, which can deliberately carry flags and conversation history.

Original evidence is the installed data (`Deus Ex GOTY Edition`), the class
`ScriptText` sources embedded in `DeusEx.u`/`ConSys.u`/`DeusExConText.u`
(extracted to `.cache/reference/*.uc`, ignored), and the hash-pinned
`ConSys.dll` (`f20c4d89…`) / `DeusEx.dll` bodies.

## 1. Both authored conversations (DeusExConText, Mission00)

Both are **first-person, non-interactive** (`bFirstPerson=bNonInteractive=true`),
so the player keeps first-person control and the instructor speaks; there is no
letterbox camera and no player choices. `bInvokeFrob/Bump/Radius=true`.

### MunitionsTrooperFrob (Conversation3, conversationID 2, radiusDistance 160)
- `flagRefList`: one `ConFlagRef { FlagName=MunitionsTrooperReady }` — plays only
  when `MunitionsTrooperReady == False` (ConFlagRef.Value defaults false).
- `eventList`: `ConEventRandomLabel` (`bCycleEvents=bCycleRandom=true`, labels
  `A1..A5`) → five `ConEventSpeech` (labels A1..A5, `speakerName=MunitionsTrooper`,
  `speakingToName=JCDenton`, soundIDs 19,20,21,22,23) each followed by
  `ConEventEnd`. One frob plays one greeting line, then ends. Speech examples:
  A1 "You aren't done yet…", A2 "Got you running the course, huh? …".

### MunitionsTrooperTake (Conversation4, conversationID 3, radiusDistance 350)
- `flagRefList`: `ConFlagRef { FlagName=MunitionsTrooperReady, Value=true }` —
  plays only when `MunitionsTrooperReady == True`.
- `eventList`: `ConEventSetFlag` (clears `MunitionsTrooperReady` back to false) →
  `ConEventJump "Take"` → 29 `ConEventTransferObject` moving Multitool/Lockpick
  and every training weapon **from JCDenton to MunitionsTrooper** →
  `ConEventJump "Start"` → `ConEventRandomLabel "Start"` → three speeches
  (A1..A3) → `ConEventEnd`. This is the end-of-training "surrender your gear"
  path.

### The `MunitionsTrooperReady` gate (authored)
- `00_Training` places `FlagTrigger0`/`FlagTrigger1` at the two instructors
  (`FlagName=MunitionsTrooperReady`, `bWhileStandingOnly=true`,
  `CollisionRadius=300`; class defaults `bSetFlag=true`, `flagValue=true`,
  `bTrigger=false`). `FlagTrigger.Touch` (which overrides the base
  `Trigger.Touch`; `TT_PlayerProximity`) sets the flag **true** while the player
  stands within the trigger's cylinder; `UnTouch` sets it **false** on leaving
  (extracted `FlagTrigger.uc`, `.cache/reference/Trigger_engine.uc`).
  `FlagTrigger.Touch`/`UnTouch` are now prepared in `createScriptDoors`, and
  their `GetPlayerPawn` (720) and `FlagBase.SetBool` natives already route
  through the trigger native handler, so walking into the instructor's
  FlagTrigger during ordinary Play sets `MunitionsTrooperReady` — this is the
  authored condition that makes the Take conversation selectable, verified end to
  end by driving the player through the trigger in
  `scripts/validate-instructor-conversation.mjs`.
- `Mission00.Timer` (`Mission00.uc`) removes the player's remaining inventory
  while `MunitionsTrooperReady` is true. So the flag means "at the instructor,
  surrender the training gear": frob with the flag false → the Frob greeting;
  frob with it true → the Take confiscation.

## 2. Entry path (ordinary Play use)

`game.use()` dispatches the frob target's real `Frob` event. For a ScriptedPawn:

```
ScriptedPawn.Frob(Frobber, frobWith)              (.cache/research/ScriptedPawn.uc:8356)
  -> DeusExPlayer.StartConversation(Self, IM_Frob) (DeusExPlayer.uc:7739)
       CanStartConversation()                      (7535: conPlay/state/rootWindow gates)
       ScriptedPawn.CanConverse()                  (bCanConverse && bInterruptState && Physics∈{Walking,Flying})
       con = GetActiveConversation(invokeActor, IM_Frob)  (7906)
            per ConListItem in order: invoke-method filter, height/LOS,
            bDisplayOnce, CheckFlagRefs(con.flagRefList)  (8163)
       con.IsSpeakingActor(Self)                   participant test
       conPlay = Spawn(class'ConPlay')             (7846)  ← first-person branch
       conPlay.SetStartActor/SetConversation/SetForcePlay/SetInitialRadius
       conPlay.StartConversation(Self, invokeActor, false)   (7884)
```

`bCanConverse` becomes true only after the instructor's state machine has ticked
into its idle/standing state (~150 Play ticks from load); before that
`CanConverse` correctly refuses.

## 3. ConPlay first-person presentation (implemented selected path)

`ConPlay expands ConPlayBase expands Actor` (both in `DeusEx.u`, script-only,
inheriting `Engine.Actor`'s constructor through `UClass::Bind`). ConPlay.uc:

```
ConPlay.StartConversation                         (ConPlay.uc:53)
  Super (ConPlayBase.StartConversation:171): con.BindEvents, CheckActors,
      CheckActorDistances, rootWindow = player.rootWindow
  displayMode = DM_FirstPerson
  conWinFirst = rootWindow.hud.CreateConWindowFirst()
  playMode = PM_Passive; currentEvent = con.eventList
  SetupHistory(player.GetDisplayName(startActor, True))   ← DeusExPlayer.CreateHistoryObject (native 3002)
  GotoState('PlayEvent')
state PlayEvent.SetupEvent switches on EventType -> SetupEvent<Type>:
  ET_Random  -> SetupEventRandomLabel: nextLabel = event.GetRandomLabel() (native 2062) -> EA_JumpToLabel
  ET_Speech  -> SetupEventSpeechPre (EA_ConTurnActors) then SetupEventSpeechPost:
       TurnSpeakingActors, conWinFirst.Clear/DisplayName/DisplayText, AddHistoryEvent,
       PlaySpeech(soundID, speaker) -> EA_WaitForSpeech
  ET_End     -> SetupEventEnd -> EA_End -> TerminateConversation
state WaitForSpeech: PlaySpeech + SetTimer(con.GetSpeechLength(soundID)); on the
  timer, StopSpeakingAnimation, Sleep(0.5), PlayNextEvent -> next event.
TerminateConversation (ConPlay:142 -> ConWinFinished -> PostTerminateConversation):
  player.EndConversation() (DeusExPlayer.uc:7599). For a first-person convo the
  player was never put in the Conversation state, so no GotoState is forced —
  the player keeps ordinary first-person control throughout.
```

`ConEventRandomLabel` (`native noexport`, `var native private DynamicArray
labels`) and its intrinsics 2060/2061/2062 are recovered and implemented — see
`src/runtime/script-conversation-random-label.mjs` and
`scripts/validate-conversation-random-label.mjs`. `GetRandomLabel` (body
0x1000a270) cycles the labels sequentially (`cycleIndex`) until exhausted, then
draws `Core.appRand() % Num`; with `A1..A5` the first five frobs yield A1…A5.

## What is implemented and verified

`src/runtime/script-conversation-face-live.mjs` (`prepareFaceConversations`,
wired into `createScriptDoors`) prepares — data-driven by the map's
conversation-owning pawn BindNames, never by a hardcoded conversation name — the
full authored object graph (Conversation, `ConFlagRef` chain, `ConEvent` chain
including the `ConEventRandomLabel` head, `ConSpeech`) for every non-bark,
non-DataLink conversation a present pawn can invoke, and prepares
`Conversation.IsSpeakingActor`. In Training this is `MunitionsTrooperFrob`,
`MunitionsTrooperTake` and `JaimeBark`.

`scripts/validate-instructor-conversation.mjs` enters through actual
HighlightCenterObject targeting and public `game.use()`. It verifies both owners,
the two routes, original speech IDs and emitter identity, all 29 transfer events,
an owned Lockpick moving from JC to the invoking instructor, history creation,
original timer/Sleep/End termination, HUD rendering, and active reset followed
by another successful greeting. It also checks that all 18 Training NPC meshes
prepare, including all four environment-mapped guards. The fixture repositions
JC for approach setup; walking into FlagTrigger sets Ready naturally. It never
assigns frobTarget, Ready, event labels, timers or participant states.

The greeting rotates through the original random-label behavior. A repeated
use within one second of LastConEndTime is rejected by
DeusExPlayer.GetActiveConversation (source lines 7922–7923); the validator waits
past that original gate before repeating. First-person movement remains active
throughout; media-ended never advances the script.

### Remaining fidelity limits

This is a substantial playable conversation increment, **not completion of the
whole instructor assignment or Stage 3**. Mission00.Timer's independent
RemoveAllInventory enforcement has not been scheduled in Play. Normal inventory
pickup/equipment/belt support and a complete walk from the Training spawn to
both instructors remain broader dependencies; the current integration/browser
checks use explicit approach setup. No substitute mission timer is installed.

Browser speech decodes the original MP3 bytes and starts/stops from the original
PlaySound/StopSound channel, preserving its volume and pitch. Native mixer
spatialization and phoneme generation are not implemented. The DLL-derived
speech length and script Timer/Sleep sequence own progression. No original-game
audio mix or pixel-for-pixel conversation screenshot comparison has been made.
The layout/material comparisons below establish specific native calculations,
not whole-renderer fidelity (lighting, LOD and adaptive reflection subdivision
remain open).

Reset destroys active windows through Window.Destroy, destroys the ConPlay actor,
clears player ownership, stops pending or playing browser speech, destroys history
script properties/linker ownership, and restores authored conversation fields
and flags. Native final GC remains the existing runtime boundary: destroyed
objects can retain deferred registry slots. This is not save/load or map-travel
flag/history persistence.

### Host service inputs vs original evidence

The installed conversation graph, ConPlay scripts, original native constructors,
binders, speech lookup/duration, flag mutations and Actor.Tick establish runtime
behavior. Host services supply canonical registry identities, loaded package
resources, a viewport listener, browser audio transport and the bounded window
presentation adapter. Unsupported conversation/UI/mixer paths are not claimed
by the two successful Training routes.

## Playback continuation contracts

ConPlay's class is script-only (`ClassFlags=0x32`) and inherits ConPlayBase →
Engine.Actor. The recovered class linker gives PropertiesSize `0x404` (base
`0x3c0`, Actor `0x318`). It uses the same verified Actor constructor and
noncolliding SpawnActor startup as DataLinkPlay, with its own exact class gate.
The original ConPlay and ConPlayBase functions and states own event selection,
turning, history, timers, speech flags and termination; the host schedules the
spawned actor through the existing Actor.Tick implementation.

DeusEx.dll `execCreateHistoryObject` `0x10014640` and
`execCreateHistoryEvent` `0x100146d0` consume EndFunctionParms, allocate with
`GetOuter(Self)`, NAME_None and flags 0, then call ConSys constructors. Sizes
are `0x5c` and `0x48`. ConSys `0x1000ca00` zeros firstEvent/lastEvent/next at
`+0x50/+0x54/+0x58`; `0x1000cb70` zeros next at `+0x44`. Their vtables are
`0x10013568`/`0x100135bc`, replaced by the importing DeusEx wrappers with
`0x10027fe8`/`0x1002803c`. Reflected strings and scalar defaults come from
StaticAllocateObject/InitProperties. History.AddEvent is original bytecode.
The browser world allocation registry supplies the level package Outer for
preplaced actors, matching their original serialized ownership.

HUDConWindowFirst uses the existing XWindow constructor/Init and TextWindow
services. Its original InitWindow creates a TileWindow with ORDER_Down,
HALIGN_Full/VALIGN_Top, unequal widths/heights and margins 20/10. The native
TileWindow constructor `Extension.dll 0x100150a0` calls UObject, zeros the
rectangle at `+0xd4..+0xe8` and row array at `+0x168..+0x170`, and selects
vtable `0x1005b760`. Init `0x10048360` calls XWindow.Init and writes orientation
and directions zero, margins 3/3, spacing 1/1, alignment 3/3, flags
`(old & ~4) | 11`. Setter bodies `0x100150f0..0x10015260` write the corresponding
fields and call AskParentForReconfigure; SetOrder `0x10048560` maps the 12
orders to orientation/directions/wrapping. ORDER_Down selects 1/0/0 and clears
wrapping. Browser drawing remains a presentation adapter; the full native
TileWindow sizing/reconfiguration/render tree is not established by these
setter contracts.

The name separator reaches Window.SetHeight (1434): exec `0x10052260`
evaluates one float (initial zero), consumes End, then calls `0x1004d0e0`.
The worker clamps negative/unordered input to +0, compares against +0xa0
using x87 C3, writes only height and asks for reconfiguration when different.

The first speech finishes through the original timer and End event. Its NPC
LipSynch tail additionally reaches TweenBlendAnim (1012), Engine thunk
`0x10302a6d` → `0x103e1300`. The wrapper evaluates name, float time and optional
int slot (default zero), then checks slot 0..3, Mesh and FindAnimSeq. Success
writes BlendAnimSequence; zeros BlendAnimLast/MinRate/Rate/OldRate; positive
ordered time sets TweenRate=1/(NumFrames*time), Frame=-1/NumFrames, otherwise
both zero. SimBlendAnim stores Frame*10000, Rate*10000, TweenRate*1000,
Last*10000. Unlike TweenAnim it does not alter main animation flags. This is
needed even without the audio system's phoneme stream: bWasSpeaking makes
Pawn.LipSynch close the mouth when speech stops. Phoneme generation remains an
explicit audio-presentation limitation.

ConEventSetFlag's original body traverses its own flagRef chain (separate from
the conversation admission flags), calls SetBool, then FlagBase.SetExpiration
(1122). Extension exec `0x10025be0` reads Name, byte type, int expiration;
worker `0x10024990` calls FindFlag (`0x10023be0`) and writes +0x3c only on a
match. It does not add a missing flag or substitute default expiration for
-1. The live store admits FLAG_Bool (0); other flag types remain unsupported.

### Remaining native steps recovered during continuation

Core `execAssert` (`10101d61 -> 1012fcc0`) reads the uint16 source line,
executes one bool operand and reports NAME_Critical (`0x2f9`) on zero. The VM
now stops with that source line; it does not discard ConPlay's assertion.

The Take event script fabricates a missing giver item before transfer
(`ConPlayBase.SetupEventTransferObject`), including when the giver is JC.
All event-referenced inventory classes and their AmmoName classes must have
startup/state bytecode prepared before synchronous playback. This is original
behavior, not a host confiscation loop. Spawned ConPlay ticks in Level.Actors
order after the preplaced pawns, and items it spawns join that same traversal.

### Guard environment materials: recovered selected path

Hash-verified Render.dll SHA256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`:
DrawLodMesh `10b101d3..10b10314` accumulates normalized face cross products
into all three vertex normals, before visibility/backface rejection. Normalize
uses `FastInvSqrt(dot+0.001f)`, with the tables initialized by `10b024b0`
(pow exponent -0.5, 1024 mantissa and 512 exponent entries). The summed vertex
normal receives the same normalization at `10b10863..10b10912`.

PF_Environment texture selection at `10b10634` tries Actor.Texture, then
Region.Zone.EnvironmentMap, then Level.EnvironmentMap, retaining the last
nonnull ordinary skin if none supplies an environment map. Training guards
have Actor.Texture=DeusExItems.Skins.PinkMaskTex. No reflective flag is removed.

DrawGouraudPolygon `10b0bae9..10b0bbbc` computes D=UnsafeNormal(view vertex),
R=D-2*dot(D,N)*N, transforms R through Frame.Uncoords (+64), and writes
U=(1+R.x)*UScale*128, V=(1+R.y)*VScale*128. DrawLodMesh supplies texture
size*scale/256, so normalized sampler UV is (1+R.xy)/2. The world-space browser
calculation cancels the view/inverse-view rotation algebraically. Float-store
and cancellation differences are bounded in the focused original-DLL probe;
this does not establish native clipping, adaptive reflection subdivision,
lighting or complete DrawLodMesh fidelity. Those pre-existing renderer gaps
remain. The new probe executes actual normal/UV instructions and original
lookup-table initialization; only CRT math leaves are supplied by the harness.

The selected TileWindow `ORDER_Down`, FillParent, full-width/top-aligned,
no-wrap/no-equal-size path is recovered from `Extension 10048a90..10049181`.
With a specified width it queries each visible child's preferred height at
max(0,width-2*hMargin). A single row stores integer width and running integer
height (truncate after each child+minorSpacing, then subtract final spacing).
Preferred height adds both vertical margins. Configuration uses the original
float child heights for cumulative Y and the integer row width for full-width
children. `scripts/native-conversation-tile-oracle.py` executes that entire
method with explicit child query and allocator leaves, including fractional
cases that distinguish these stores.

TextWindow preferred-size `100465a0` uses GC.GetTextExtent at width minus both
text margins when wrapping; the selected min/max-lines=-1 branch adds both
margins at `10046768`. HUDConWindowFirst clamps to its authored minHeight.
DeusExHUD.ConfigurationChanged centers min(screenWidth-100,800), positions it
20 pixels above infoBottom (screen bottom when the unimplemented belt is
absent). Original DrawBackground/DrawBorder and GC.DrawBorders supply the art;
original bitmap fonts and GC text measurement/drawing supply the text.
General TileWindow wrapping, other orders and general window reconfiguration
remain unsupported; this is the recovered selected presentation adapter.
