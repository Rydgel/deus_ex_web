# Training munitions-instructor conversation

The Training munitions instructors are `UNATCOTroop0` and `UNATCOTroop3`
(`00_Training`), both `BindName = MunitionsTrooper`. `ConBindEvents` binds them
`MunitionsTrooperFrob` (Conversation3) then `MunitionsTrooperTake`
(Conversation4) from Mission00 (see
[conversation binding](script-conversation-binding.md); confirmed live by
`tools/dump-conlist-win.c`). `UNATCOTroop1`/`UNATCOTroop2` have a different
BindName and bind nothing. This document records the recovered face-to-face
conversation contract, what is implemented, and the exact remaining boundary.

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
  `ConEventJump "Take"` → 30 `ConEventTransferObject` moving Multitool/Lockpick
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

## 3. ConPlay first-person presentation (recovered; the remaining boundary)

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

`scripts/validate-instructor-conversation.mjs` drives the **public Frob path**
and asserts, all through the original bytecode over the attached graph:
- both instructors bind `MunitionsTrooperFrob` → `MunitionsTrooperTake`;
- `GetActiveConversation` selects Frob when `MunitionsTrooperReady` is false and
  Take when true, for the invoking instructor (participant identity preserved
  across the shared BindName);
- a real Frob dispatch runs the whole `StartConversation` gate chain
  (`CanStartConversation`, `CanConverse`, `GetActiveConversation`, the
  participant `IsSpeakingActor` test) and reaches `Spawn(class'ConPlay')` with
  the correct conversation selected;
- the greeting's `ConEventRandomLabel` cycles A1..A5;
- public `game.reset()` restores the fresh (flag-false) selection;
- **walking the player into and out of the authored FlagTrigger** flips
  `MunitionsTrooperReady` (`FlagTrigger.Touch`/`UnTouch`) so the instructor
  selects Take while the player stands there and Frob after leaving — the Take
  path reached through ordinary movement, not a forced flag.

`ConEventRandomLabel`'s natives are compared against the recovered ConSys.dll
bodies in `scripts/validate-conversation-random-label.mjs`.

## Remaining boundary (measured, not yet implemented)

The first-person **presentation** past `Spawn(class'ConPlay')`. A host research
harness that composes a ConPlay spawn (through the recovered
`spawnScriptActor` path and the canonical registry) confirms ConPlay
constructs, `con` resolves to `MunitionsTrooperFrob`, `CreateConWindowFirst`
returns the window, `currentEvent` is set to the `ConEventRandomLabel` head, and
execution reaches `ConPlayBase.SetupHistory`, whose first unbuilt native is
**`DeusExPlayer.CreateHistoryObject` (native 3002, DeusEx.dll 0x10014640)** —
it constructs a `ConHistory` and links it to the player. Past that lie
`CreateHistoryEvent` (3003)/`ConHistory.AddEvent`, the conversation-speech font
lookups (window natives), `TurnSpeakingActors`, the first-person window
`Clear/DisplayName/DisplayText`, `PlaySpeech`/`GetSpeechAudio` with the
`ClientHearSound` audio boundary (Stage 4), the `WaitForSpeech` timer schedule,
and `TerminateConversation`. These are the explicit next dependencies; none is
stubbed or force-returned in the shipped runtime — a frobbed instructor runs the
real selection and stops at the `Spawn(class'ConPlay')` boundary.

## Host service inputs vs original evidence

- Original evidence: the two conversations' event graphs, flags and speeches; the
  FlagTrigger/Mission00 gate (`FlagTrigger.Touch`/`UnTouch` run live in Play); the
  frob→StartConversation→GetActiveConversation bytecode; `ConEventRandomLabel`
  intrinsics 2060/2061/2062 (ConSys.dll bodies).
- Host service input: the `flagBase` (Extension.FlagBase get/set) already present
  for the DataLink/trigger paths; the player's `rootWindow` shell.
- Unresolved: the ConPlay first-person presentation tail above, and the audible
  `ClientHearSound` speech playback (Stage 4).
