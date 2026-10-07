# Conversation binding (ConBindEvents)

`ConBindEvents` attaches a mission's conversations to the actors they belong to.
It is `native(2101) final function ConBindEvents()` on **DeusExDecoration**
(called in `PostPostBeginPlay`) and `native(2100)` on **DeusExPlayer** (called in
its startup). Evidence: `.cache/reference/DeusExDecoration.uc` (49, 100),
`.cache/reference/DeusExPlayer.uc` (361, 562, 7739–8047), `.cache/reference/Actor.uc:458`
(`var transient Object ConListItems;`), and the `DeusExConText.u` package data.

## Data model (DeusExConText.u)

Each mission owns one conversation list, keyed by the level's mission number:

```
ConversationList  "ConList_Mission<NN>"  { conversations: <ConItem>, missionDescription }
ConItem                                  { ConObject: <Conversation>, Next: <ConItem> }   // linked list
Conversation                             { conName, conOwnerName, bInvokeFrob, bInvokeBump,
                                           bInvokeSight, bInvokeRadius, eventList, ... }
```

`conOwnerName` is the **bind key**: the `BindName` of the actor the conversation
belongs to (e.g. `WaltonSimons`, `MunitionsTrooper`). The `bInvoke*` flags say
how it may be triggered.

## Binding rule and corrected native scope

The initial descriptor prototype kept BindName/conOwnerName matches in reverse
mission-list order. A later direct trace of ConSys `10010b70` recovered
additional BarkBindName/`_Bark` gates, purge-before-bind, owner reference counts,
native ConListItem allocation, flags and deletion. See the authoritative
[native list contract](script-native-conversation-list.md). The prototype does
not implement those branches and cannot establish complete native binding.
The original StartConversation additionally applies invoke-method filtering.

## Training reference case (00_Training, Mission 0)

`00_Training`'s `DeusExLevelInfo` leaves `missionNumber` unauthored → class default
**0** → `DeusExConText.ConList_Mission00` (470 conversations). Cross-referencing
against the map's actors:

- The two UNATCO instructors `UNATCOTroop0` / `UNATCOTroop3` (both
  `BindName = MunitionsTrooper`) bind **`MunitionsTrooperFrob`** (`Conversation3`)
  then **`MunitionsTrooperTake`** (`Conversation4`) — both `bInvokeFrob/Bump/Radius`.
  The native prepends each match as it walks the list, so the `ConListItems`
  order is the reverse of mission-list order (`Take, Frob` in the list → `Frob,
  Take` bound). `UNATCOTroop1` / `UNATCOTroop2` have a different BindName and bind
  nothing. All confirmed against the live game (see below).
- **Every decoration binds nothing.** The `LightSwitch` (and all decorations) has
  `BindName = None`, and no conversation has `conOwnerName == "None"`. So
  `DeusExDecoration`'s `if (conListItems != None)` guard and the switch's
  `StartConversation → None` are **correct original behavior**, not a gap. This
  resolves the Stage-3 handoff's "empty switch binding / zero matches" note: the
  switch was never supposed to bind a conversation.

## Current shared integration

- `src/runtime/script-conversation-binding.mjs`: `loadMissionConversations(asset,
  missionNumber)` parses one mission list into ordered conversation descriptors;
  `matchConversations(bindName, conversations)` applies the rule.
- ScriptRuntime.prepareConversations now prepares the list's whole loaded
  graph (see [Loaded graph](#loaded-graph)), plus the ConListItem class. The
  descriptor helper remains an explicitly incomplete research prototype.
- Shared natives2100/2101/2102 now run the recovered
  [mission/package selection wrapper](script-conversation-wrapper.md), with an
  explicit synchronous StaticLoadObject service. The
  [native list binder](script-native-conversation-list.md) owns matching,
  purge, counts and prepend writes. New nodes use shared fresh allocation and
  the concrete ConListItem constructor; purge uses its scalar destructor and
  existing Core destruction/registry/free services.
- The Training validator supplies explicit loader, native Outer, name-table,
  allocation and release fixtures. The attached switch initially binds none;
  giving it MunitionsTrooper binds typed Frob→Take nodes with counts1, native
  vtables, RF_Public and package Outer. Restoring its original BindName and
  rebinding releases both nodes, returns counts to0 and clears the actor head.
  These fixtures do not establish complete Play native-loader bootstrap.

## Loaded graph

ConBindEvents loads `ConList_Mission<NN>` through StaticLoadObject
([wrapper](script-conversation-wrapper.md), step 6). Preloading an export
serializes its tagged ObjectProperty references through IndexToObject, whose
CreateExport appends each new export to GObjLoaded, and EndLoad preloads
every appended entry until none is left
([linker imports](script-linker-imports.md), [EndLoad](script-end-load.md)).
So before BindConversations runs, every object the list reaches in
DeusExConText is loaded: the ConItem chain, all its Conversations, their
ConFlagRef and ConEvent chains, ConSpeech, ConChoice and jumpCon targets.
Which of them a script later reads does not depend on how the conversation
starts: ConPlay, DataLinkPlay and ConPlayBark all walk `eventList`.

Play's object attachment is asynchronous, so `prepareConversations` attaches
that same closure at load and records it in `conversationListObjects`.
Measured from the package bytes: in every one of the 18 lists the exports'
Outers are the package root, and every reference they serialize is a tagged
ObjectProperty. The only payload tail is ConEventRandomLabel's `labels`
(script-conversation-random-label.mjs). The closures range from 46
objects (Mission98) to 13452 (Missions 06 and 07); ConList_Mission01 reaches
8714. Before this, only the face-to-face candidates
(script-conversation-face-live.mjs) and the player's DataLinks had their
graphs attached, and a bark's head event was not.

Reference case (`scripts/validate-island-bark.mjs`): on 01_NYC_UNATCOIsland,
with the player in front of ComputerSecurity1, Terrorist18 (BarkBindName
`Terrorist`) attacks at tick 527 and ScriptedPawn.Attacking calls
DeusExPlayer.StartAIBarkConversation -> BarkManager.StartBark. StartBark finds
`Terrorist_BarkTargetAcquired` (Conversation1810) in the pawn's ConListItems;
ConPlayBark.GetBarkSpeech starts at its ConEventRandomLabel1085 head (labels
A1-A5, no cycle flags, so GetRandomLabel draws from appRand) and returns
ConSpeech9492, "Fascist!". GetSpeechAudio loads
`DeusExConAudioAIBarks.ConAudioAIBarks_911`; the pawn's PlaySound returns
channel 572010; GetSpeechLength gives 0.65 s; and HUDBarkDisplay.AddBark shows
the line. Before the closure, the GetBarkSpeech read threw "Object is not
attached to script runtime: deusexcontext.coneventrandomlabel1085" and paused
Play.

GetSpeechAudio is synchronous, so the speech it can load is prepared at load
as well (script-conplay-live.mjs). A bark's conversation is the one
FindConversationByName finds in the barking pawn's ConListItems under
BuildBarkName's `<BarkBindName or BindName>_Bark<mode>`. The prepared set is
therefore every conversation bound to a map actor whose conName contains
`_Bark` (FName comparison ignores case): 274 AIBarks sounds on
01_NYC_UNATCOIsland. In DeusExConText, every speech with a soundID other
than -1 has its `ConAudio<suffix>_<id>` export, including all 1505 bark
speeches.

In the browser (worker mode, headless Chromium, the same placement) the HUD
shows "NSF Terrorist: Fascist!" about 8 s after placement, and Play runs on
without a runtime error. The bark's PlaySound takes the general native 264
route (ClientHearSound, then Galaxy), not ConPlay's speech route. Whether the
line is audible is unverified: that browser never received the user gesture
that starts audio.

Open: a pawn spawned after load can bind a bark no map actor bound at load.
Its speech is not prepared, so GetSpeechAudio or GetSpeechLength stops with
an explicit error instead of loading it.
Player start restores the whole loaded graph to the values it had when the
face conversations were prepared (docs/script-loadmap-gc.md); that baseline
is taken after the map's ConBindEvents, so it includes their
`ownerRefCount` increments, as it already did for the face conversations.

## Confirmed vs open

- **Confirmed against the live game** (`tools/dump-conlist-win.c`, a sibling
  Win32 process reading `Actor.ConListItems` at **+0x2dc** and resolving each
  `ConListItem`'s `con`/`next` against the live object table): standing in
  `00_Training`, `UNATCOTroop0` and `UNATCOTroop3` bind `Conversation3`
  (`MunitionsTrooperFrob`) then `Conversation4` (`MunitionsTrooperTake`);
  `UNATCOTroop1`, `UNATCOTroop2` and `LightSwitch0` bind `None`. This confirms
  the `conOwnerName ↔ BindName` key, that only matching actors bind, and the
  **prepend order** (reverse of the mission list) — the implementation was
  corrected to match.
- **Confirmed from original data:** the serialized list structure. Broad claims
  about all matches binding are superseded by the native BarkBindName gates.
- **Stage 3 remains open:** full native package/world startup and conversation
  control flow. The bounded ConListItem construction/purge integration now uses
  explicit native services; their live host population remains incomplete.
  Audio/UI rendering is a separate presentation task.
