# DataLink transmission contract

This document records the recovered Stage 3 boundary for
DataLinkTrigger.Touch/Trigger calling
DeusExPlayer.StartDataLinkTransmission. The authoritative bodies stay in the
installed DeusEx.u bytecode. The implementation in
src/runtime/script-datalink-transmission.mjs prepares those functions for
ScriptRuntime, decodes original conversation records, and exposes strict
ConSys native service inputs. It does not copy the UnrealScript state machine
into JavaScript.

The focused validator now executes selection readiness, case folding,
display-once, nonempty authored flag-reference lists, the eight-slot queue and
the original Dying-state rejection. Shared native1024 uses an explicitly
initialized FName table fixture. Canonical typed root-window/HUD and ConListItem
fixtures make these integration paths reachable without claiming native window
startup. The normal DataLinkPlay.StartConversation body reaches the original
Window.NewChild allocation boundary and records that boundary explicitly.
The [speech binder](script-conversation-speech.md) also writes and clears the
canonical Speech79 speaker references using original actor class defaults.

The evidence is the installed GOTY DeusEx.u/ConSys.u packages, the extracted
sources in .cache/reference/DeusExPlayer.uc and
.cache/reference/DataLinkTrigger.uc, and the installed
System/ConSys.dll. Original expanded script sizes used by the preparation
validator are:

| Function | Bytes |
| --- | ---: |
| DeusExPlayer.CheckFlagRefs | 97 |
| DeusExPlayer.GetActiveDataLink | 414 |
| DeusExPlayer.StartDataLinkTransmission | 218 |
| DataLinkTrigger.Touch | 162 |
| DataLinkTrigger.Trigger | 184 |
| DataLinkTrigger.DatalinkFinished | 50 |
| DataLinkPlay.SetConversation | 125 |
| DataLinkPlay.SetTrigger | 13 |
| DataLinkPlay.PushDataLink | 137 |
| DataLinkPlay.PopDataLink | 106 |
| DataLinkPlay.InsertDataLink | 70 |
| DataLinkPlay.StartConversation | 285 |
| DeusExRootWindow.GetTopWindow | 33 |
| DeusExHUD.CreateInfoLinkWindow | 75 |
| HUDInfoLinkDisplay.InitWindow | 27 |
| HUDBaseWindow.InitWindow | 37 |
| Extension.Window.InitWindow | 2 |
| DataLinkPlay.NotifyDatalinkTrigger | 28 |
| ConPlayBase.StartConversation | 393 |

## Original script gates

StartDataLinkTransmission(datalinkName, datalinkTrigger) first returns False
for Level.bPlayersOnly. It then calls GetActiveDataLink. GetActiveDataLink
returns None when either flagBase or rootWindow is null. Otherwise it walks the
player ConListItems chain in its existing native-bound order. A matching
conName is eligible only when its <conName>_Played flag is not set for a
display-once conversation and every linked flagRefList pair matches
FlagBase.GetBool. The first eligible conversation is returned. A matching but
ineligible name has no missing-name warning; a name with no match logs and
client-messages the original warning.

With an active conversation, the script reuses dataLinkPlay or calls
Spawn(class'DataLinkPlay'), then calls, in order:

    DataLinkPlay.SetConversation(activeDataLink)
    DataLinkPlay.SetTrigger(datalinkTrigger)
    DataLinkPlay.StartConversation(Self)

The installed DataLinkPlay.SetConversation bytecode stores the first
conversation in startCon and con when both con and dataLink are null. Otherwise
it calls the installed PushDataLink function, whose source has an eight-entry
duplicate/full guard. SetTrigger stores the trigger for later completion. If
SetConversation or StartConversation returns false, the player destroys and
clears only a newly spawned play object; an existing play object is retained.
No JavaScript helper supplies a missing Bool result.

`PushDataLink` scans indices 0–7, first rejecting `startCon`, then checking
each slot for the same conversation before checking for None. The first empty
slot is assigned and returns True; a duplicate or full queue returns False.
`PopDataLink` returns slot zero, shifts 1–7 down and clears slot seven only
when slot zero is nonnull. `InsertDataLink` shifts 6–0 up in descending order,
then writes slot zero, discarding the previous last entry. These original
137/106/70-byte bodies are prepared directly, preserving fixed-array identity
and evaluation order. A SetConversation call can enqueue successfully but
still return False when `dataLink` is null; its source checks the window only
after PushDataLink has run.

DatalinkFinished is deferred until termination. The live Training scheduler
then calls the installed trigger completion body, after which the trigger's
original Touch/Trigger bookkeeping continues. Selection and the direct
Speech-to-End lifecycle are connected to the six-control InfoLink shell and
exact encoded speech payloads; broader ConEvent forms and native audio mixing
remain outside this slice.

ConPlayBase.StartConversation (393 bytes) has additional Stage 3 gates before
DataLinkPlay's presentation body: null conversation/player and a player in
the original Dying state return false; otherwise it stores player and
invokeActor, calls native BindEvents, calls BindActorEvents when the
conversation owner reference count is greater than one, skips CheckActors for
a bDataLinkCon conversation, and runs CheckActorDistances with the player
excluded from the distance set. It then writes the mission/radius/conversation
state and sets bConversationStarted. DataLinkPlay.StartConversation adds its
InfoLink and sound/timer path after this gate. The return value and all those
state writes must come from the prepared original bodies; this module does not
substitute a success value while the object/native graph is incomplete.

## Root window and InfoLink boundary

The normal DataLinkPlay.StartConversation route calls the prepared original
DeusExRootWindow.GetTopWindow body immediately after its ConPlayBase superclass
returns true. Its recovered source is:

    if ( winCount > 0 )
        return winStack[winCount-1];
    else
        return None;

The installed metadata is export 14052 with 33 expanded script bytes. The
validator attaches a typed DeusExRootWindow with its six element winStack and
verifies both the empty result and the stack-top return. The route then calls
the prepared original DeusExHUD.CreateInfoLinkWindow body (export 19623, 75
expanded bytes): it returns None when infolink already exists, otherwise calls

    infolink = HUDInfoLinkDisplay(NewChild(Class'HUDInfoLinkDisplay'));

then hides msgLog when present, asks the new window to reconfigure, and returns
the assigned infolink. With the canonical HUD fixture's infolink and the root
window stack empty, the route reaches Extension.Window.NewChild (native
index 1410, export 2126). Shared native1410 now runs the recovered helper
to its explicit StaticConstructObject service. The validator checks its
canonical HUDInfoLinkDisplay class, HUD Outer, NAME_None, flags0, null
template and GError arguments, and confirms infolink remains unpublished
when allocation has not returned. The child allocation, lifecycle, and
AskParentForReconfigure implementation require the native UI object graph and
remain open Stage 3 integration work; no fake HUD window is reported as a
successful result.

## Original Mission 00 records

00_Training contains DataLinkTrigger23 with datalinkTag = dl_start.
DeusExConText.ConList_Mission00 contains 470 ConItem records. Conversation57
(export 1926, DL_Start) is owned by JCDenton, bDataLinkCon = true, and
bDisplayOnce = true; its authored flagRefList is absent, so the canonical
class default is used by the VM. Its first event is ConEventSpeech79
(export 32934), with JaimeReyes -> JCDenton, followed by ConEventEnd77.

loadDataLinkMissionDescriptors preserves absent authored fields as undefined
and throws on malformed or cyclic linked lists. It does not turn an absent
flag into false, claim root-window readiness, or filter candidates. The
canonical ScriptRuntime.prepareObject path supplies class defaults and
canonical object identity before original bytecode reads those fields.

## ConSys native 2052/2053

ConSys.u declares these Conversation natives:

| Native | Declaration | Metadata |
| ---: | --- | --- |
| 2052 | BindEvents(Actor conBoundActors[10], Actor invokeActor) | 2 arguments |
| 2053 | BindActorEvents(Actor actorToBind) | 1 argument |
| 2054 | ClearBindEvents() | 0 arguments |
| 2055 | GetSpeechAudio(int soundID) | 1 argument, Sound return |
| 2056 | GetSpeechLength(int soundID) | 1 argument, float return |

The native DLL is available outside Git. Its exported C++ symbols and
disassembly provide the following concrete call graph:

* DConversation::BindEvents at ConSys.dll+0xfec0 clears the ten-element actor
  output area, makes Pawn, Decoration and PlayerPawn passes over GObjObjects,
  and calls DConversation::BindEventsToActor for each selected entry.
* BindEventsToActor at +0x100f0 walks the conversation event chain rooted at
  DConversation + 0x58 and dispatches each event's virtual BindActor method at
  vtable slot +0x58.
* DConversation::BindActorEvents at +0x101d0 walks that same event chain and
  dispatches each event with actorToBind as both actor arguments.
* Event-specific speaker/speaking-to matching is implemented in the ConSys
  DLL virtual methods, such as DConEventSpeech::BindActor at +0xb070; it is
  not a safe place to infer a generic name-map result in JavaScript.

createDataLinkNativeService is the bounded host adapter for these calls. It
checks native index and arity, preserves VM references (including the fixed
array out reference for 2052), and delegates to a supplied native/host
service. Missing callbacks throw DataLinkNativeBoundaryError. It never
returns a fabricated Bool, empty actor list, zero sound, or default readiness.
Shared ScriptRuntime now supplies the recovered 2052/2053 event-chain service,
exact Speech/End virtual binding and native2054's no-write clear traversal.
See [conversation events](script-conversation-events.md) and
[speech binding](script-conversation-speech.md). Other event classes remain
unsupported.

## Shared VM integration status

The Play runtime now wires the supported Training routes as follows:

1. Load and prepare the original records with
   prepareDataLinkFunctions(runtime, { deusEx, conSys }). This prepares all
   eighteen DeusEx.u DataLink/ConPlayBase/UI functions, the empty
   Extension.Window.InitWindow event, and verifies ConSys
   native metadata 2052–2056.
2. Keep canonical Conversation, ConEvent, ConFlagRef, ConListItem, and actor
   identities in the runtime. Existing conversation binding supplies the
   player chain; descriptor fields such as bDisplayOnce, flagRefList, and
   eventList must be attached with original class defaults.
3. Supply the canonical live GObjObjects array through ScriptRuntime's
   conversationObjects provider. The shared 2052/2053 dispatch preserves typed
   array lvalues and executes the concrete supported event bodies.
4. Admit all 18 DataLink tags authored by `00_Training` into the installed
   player function, spawned DataLinkPlay, original ConPlayBase gates and the
   source-translated playback scheduler. Tags outside that map catalog still
   return false at the admission guard.

rootWindow.StringToName, name/string operations, and player/viewport wiring are
shared VM services; this module does not duplicate them. The constructed
six-control InfoLink child is published for each supported Training lifecycle,
which completes through the original trigger parent action. The live lifecycle
also runs original HUD destruction and reconstructs a fresh child for queue
advance or reset. Native rendering, native audio mixing and generic ConEvent
playback remain explicit downstream gaps.

The focused validator now executes positive ConPlayBase.StartConversation
against Mission00 Conversation57/Speech79/End77. It verifies native writes to
ConActorsBound, the bound speaker/listener, original distance checks, the
AllActors mission lookup, radius save, rootWindow assignment and successful
conversation-start flag. It then invokes normal DataLinkPlay.StartConversation
with player.conPlay = None, verifies the typed GetTopWindow result and asserts
the first unsupported StaticConstructObject leaf inside shared native1410 from the original
CreateInfoLinkWindow body. Actor/global arrays plus typed root-window/HUD
fixtures are explicit. That bounded transmission validator deliberately stops
at its original allocation seam; the later shell and live-lifecycle validators
cover child construction, recursive destruction, queue reconstruction and
presentation publication.

The separate child-event integration fixture now executes the original
HUDInfoLinkDisplay -> HUDBaseWindow -> Window InitWindow chain through
the recovered [ProcessScript bridge](script-window-script.md). Shared
GetRootWindow1425 walks the explicit child's native parent chain through the
HUD to the typed root. The original HUDBaseWindow event then assigns the
canonical root parentPawn to its player property.

The next source-backed script group is the style event. Installed DeusEx.u
contains HUDInfoLinkDisplay.StyleChanged (export 18668, 127 expanded bytes),
HUDBaseWindow.StyleChanged (1816, 232),
ColorThemeManager.GetCurrentHUDColorTheme (15038, 8),
ColorTheme.GetColorFromName (15178, 55), ColorTheme.GetColorIndex (13810, 87),
and DeusExPlayer.GetHUDBordersVisible/GetHUDBorderTranslucency/
GetHUDBackgroundTranslucency (17051/17042/17035, nine bytes each).
These original bodies are prepared and executed directly, with no replacement
theme logic. The base event first reads the manager's current HUD theme,
assigns background/border/normal/header colors by name, then reads the three
player preferences. The derived event calls the base event first, gets the
current theme again, assigns header/normal colors to name/line/queued, and
copies name to cursor. GetColorIndex scans the declared colorNames array;
GetColorFromName returns the indexed color or colBad for a missing name.

The focused child fixture supplies an explicitly initialized theme manager
and ColorThemeHUD_Default instance. The original defaults define the HUD name
mapping in ColorThemeHUD (export 123) and colors in ColorThemeHUD_Default
(11072): background (127,127,127,0), borders/header (255,255,255,0), and normal
text (200,200,200,0). Execution is checked against those authored values and
now runs native Window.SetSize (1431, export 2055) with the authored arguments
(431,114). The original HUDInfoLinkDisplay.CreateControls (export18646, 736
expanded bytes) now runs far enough to complete its first three children. It creates
`winPortrait` as an Extension.Window, sizes it to 64x64, positions it at
20,25, and selects `DSTY_Normal`. It then runs `StaticWindow.InitWindow` and
`RandomizeStatic`, positions the overlapping 64x64 `winStatic` at 20,25,
selects `DSTY_Modulated`, takes Raise's last-child no-op, and hides it. It then
constructs native Extension.TextWindow `winName`, applies left/center alignment,
293x15 size at 94,15, `FontMenuHeaders_DS`, the authored name color, zero margins,
and `INCOMING TRANSMISSION...`. The next `NewChild` request for the `winQueued`
TextWindow remains explicit; see [Window text](script-window-text.md).

The shared SetSize translation follows Extension's exec thunk at `0x100520d0`,
SetSize at `0x10003310`, and Resize at `0x1004cf70`. Resize compares the
requested sizes with native `+0x9c/+0xa0`, stores both when changed, then calls
the recovered AskParentForReconfigure at `0x1004e060`. Negative and unordered
inputs clamp to positive zero, supplied negative zero survives, and x87 C3
treats unordered comparisons as equal. The unchanged native body and the
translation match for ordinary changes, unchanged values, clamping, signed
zero and stored NaN; see [Window size](script-window-size.md).

`createInfoLinkShellPreview` composes the recovered Window constructor and
Init path with the installed InitWindow, StyleChanged and CreateControls
bytecode. It returns the typed shell state only after asserting the exact
`winQueued` TextWindow allocation boundary.
Normal Training movement now displays that diagnostic state when the player
enters original `DataLinkTrigger23`:
the localized `INCOMING TRANSMISSION...` string, authored 431x114 size and HUD
theme colors. The same user action resolves the first
authored `DL_Start` speech through Conversation57 -> ConSpeech79 ->
`ConAudioMission00_79`, checks the 43,056-byte MPEG payload and recovered
7.176-second duration, and plays those local bytes through the browser decoder.
It also resolves the exact `DataLinkIcon` and `InfoPortraits.JaimeReyes` pixels,
shows the authored display name and speech, applies the source timing, then
performs the end-title blink and automatic destruction at +11.176000118255615
seconds. See [InfoLink content and lifetime](script-infolink-content.md).
This transport does not claim the original ClientHearSound mixer; see
[InfoLink audio](script-infolink-audio.md). The live route publishes the shell
as the HUD's `infolink` and owns it through completion; it does not claim the
untranslated ComputerWindow/font and panel-background renderers. See
[live DataLink lifecycle](script-datalink-live.md).

Focused checks:

The installed DataLinkPlay.StartConversation source has a separate busy-window
branch: after Super.StartConversation succeeds, a non-null player.conPlay makes
the display-creation condition false and returns true immediately. This leaves
dataLink null and skips currentEvent, history, sound and timer setup. The player
StartDataLinkTransmission function propagates that true after its ordinary
Spawn, SetConversation and SetTrigger calls. This source-backed branch can be
verified without substituting results for the downstream UI functions.

    node --test test/script-datalink-transmission.test.mjs
    node scripts/validate-script-datalink-transmission.mjs
    node scripts/validate-window-size.mjs
    node scripts/validate-window-position.mjs
    node scripts/validate-window-background-style.mjs
    node scripts/validate-infolink-shell.mjs
    node scripts/validate-infolink-audio.mjs
    node scripts/validate-infolink-content.mjs
