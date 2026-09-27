# DataLinkPlay in the level scheduler

Batch 5 removes the live JavaScript playback scheduler and its two function
boundaries. Original package functions own admission, queues, timer updates,
state transitions, speech requests, history, trigger completion and destruction.
`script-datalink-live.mjs` only links original records/resources and reads state
for diagnostics. Its diagnostic observer does not execute or replace script.

## Original contract traced before integration

The installed `.cache/research/src/DeusEx/DataLinkPlay.uc` and compiled function
records in `DeusEx.u` establish these edges:

- `DeusExPlayer.StartDataLinkTransmission`: reject PlayersOnly; select through
  GetActiveDataLink; Spawn DataLinkPlay only when none exists; call
  SetConversation, SetTrigger, StartConversation in order; destroy a newly
  spawned play actor when admission fails. The normal player Login supplies
  ConListItems. Preparation must not replace it with a catalog subset.
- `Mission00.Timer` (installed source lines 76–90) counts the remaining
  `Cratepick1`/`Cratepick2` containers. When either has been destroyed, it calls
  `StartDataLinkTransmission("DL_Lockpick")` and sets `MS_CratesBroken`.
  Mission00's authored `Conversation35` is `DL_lockpick`; its event chain is
  `ConEventSpeech57` -> `ConEventEnd55`. It is absent from the 18 map-trigger
  catalog because the mission script invokes it. Synchronous playback therefore
  needs every DataLink conversation bound by the original Login prepared,
  including its event/flag/speech graph and original speech resource. The
  existing graph walker and speech loader provide this preparation; the bound
  list, admission and invocation remain original script/native behavior.
- DataLinkPlay.SetConversation queues against the existing conversation via
  PushDataLink; the eight-entry array and startCon duplicate check belong to
  the original script. SetTrigger also executes when queueing. No parallel
  host queue restores an earlier trigger identity.
- StartConversation first calls ConPlayBase.StartConversation. With a free
  HUD, no first-person conversation and no NetworkTerminal top window, it
  resets eventTimer and creates the HUDInfoLinkDisplay through the original
  DeusExHUD.CreateInfoLinkWindow. It assigns con.eventList, calls SetupHistory
  with bInfoLink=True, hides the text cursor, issues player.PlaySound(startSound,
  SLOT_None), sets bStartTransmission and SetTimer(blinkRate,True).
- Global Timer adds blinkRate and toggles the icon. The strict
  eventTimer > startDelay comparison stops the timer, enables the cursor and
  enters PlayEvent. PlayEvent.SetupEvent calls the event-specific original
  setup function, then ProcessAction. For Speech, SetupEventSpeech clears the
  display, selects the portrait, prints the original ConSpeech text and adds
  a history event, returning EA_WaitForSpeech.
- WaitForSpeech.Begin calls StopSpeech, PlaySpeech, then SetTimer with native
  Conversation.GetSpeechLength. It loops at Idle through Sleep(0.5). Its local
  Timer goes to SpeechFinished, which sleeps another 0.5 before PlayNextEvent.
  These latent resumes are owned by Actor.Tick/ProcessState. The sound request
  occurs at PlaySpeech's actual native 264 call, not a browser offset.
- End event returns EA_End; ProcessAction clears currentEvent and calls
  TerminateConversation. That stops sound, links the history to the player,
  starts the end blink timer, changes winName, sets bEndTransmission, notifies
  the authored trigger, and delegates to ConPlayBase termination. The global
  Timer's strict endDelay branch destroys the window, invokes FireNextDataLink,
  and destroys the actor if there is no queued conversation.

DeusExHUD.CreateInfoLinkWindow and HUDInfoLinkDisplay.CreateControls execute in
one native window host and byte-addressed heap. QueryPreferredSize and all
layout calls therefore use the existing recovered native dispatch. The
standalone InfoLink preview remains a historical fixture, with no live Play
import. ComputerWindow animation/rendering evidence belongs to its focused
native translation and DLL oracle, not the old host text timeline.

## Boundaries and verification

Conversation audio natives 2055/2056 use the existing original resource lookup
and duration implementation. Native PlaySound records ClientHearSound requests
for DataLinkStart and speech into the same transport used by ConPlay. Browser
Web Audio decoding/output remains Stage 4 presentation; it does not select
speech, control gameplay timers or schedule a future speech start.

StopSound interception is restricted to the live player's five original
conversation call sites: ConPlayBase.StopSpeech/TerminateConversation and
DataLinkPlay.TerminateConversation/AbortDataLink/AbortAndSaveHistory. Other
callers retain the normal native audio boundary, rejected by the speech
transport before any VM operand is consumed. The decoration Timer integration
check guards against swallowing its unrelated push-sound stop request.

The viewer submits InfoLink through the native HUD draw command list. Its
accessibility region reads native text storage. Neither pixels nor audio read
`liveDataLink.presentation` or `script-infolink-timeline.mjs`.

The focused integration validator compares actual script field/state edges,
canonical package identities, native window ownership, recorded sound requests,
history and destruction. Original source/bytecode establishes this nonvisual
contract; a self-consistency assertion alone is not additional original-game
evidence. Newly reached terminal paths must remain explicit unsupported native
boundaries until recovered. Browser walking/text/speech checks are recorded in
the batch scoreboard after execution; this document does not claim those checks
have run.

Focused checks executed under the validator RSS watchdog: original DataLink
start/end/queue integration passed, native Play HUD integration passed, and
walking-trigger integration passed through DL_Start, a later DL_Door, complete
window/actor destruction and a fresh Login reset. The all-route catalog
validator remains the original-data reference for the 18 Training entries;
focused live coverage uses start/door and their queue rather than rebuilding
an entire world 18 times. An earlier process using the pre-integration host
and 18-reset live probe was terminated by the memory watchdog; the current
focused run completed at 1.3 GiB and walking/HUD runs at 1.6 GiB. That old
terminated run is not fidelity evidence.

The public-input crowbar/crate validator also passed with the full Login list
and all bound DataLink graphs prepared (40 seconds, 626 MiB peak under a
2 GiB RSS watchdog). Its unchanged assertions cover tick-driven damage,
fragment physics/lifetime, dropped Lockpick landing, subsequent walking and
reset. That run reaches Mission00's original `DL_Lockpick` admission, which
previously stopped at the unattached `ConEventSpeech57` during native BindEvents.

The final focused DataLink run also enabled the live native window tick,
checked consumed ComputerWindow characters against the original speech prefix,
and checked that native HUD drawing submitted the canonical portrait. It
passed at 1.6 GiB. The existing instructor-conversation integration passed on
the same native HUD, and both ComputerWindow suites passed, including 28
original-DLL same-heap playback comparisons. Browser audio diagnostics report
successful Web Audio source starts, context state and original sound identity;
these observations do not establish physical audibility.
