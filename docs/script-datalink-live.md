# Live Training DataLink lifecycle

`src/runtime/script-datalink-live.mjs` now admits every one of the 18
`DataLinkTrigger` routes authored by `00_Training`. Startup loads the
source-backed catalog, resolves each Mission00 `Conversation`, its linked
`ConEventSpeech`/`ConSpeech`, and its direct `ConEventEnd`, then links those
canonical objects into the player's `ConListItems` chain. An unknown tag is
still rejected by the boundary rather than being assigned guessed content.

The first transmission follows the installed
`DeusExPlayer.StartDataLinkTransmission` body, including
`GetActiveDataLink`, DataLinkPlay spawning, `SetConversation`, `SetTrigger`,
and the inherited `ConPlayBase.StartConversation` gate. The live scheduler
then translates the recovered `DataLinkPlay.Timer` and `WaitForSpeech` order
for the catalog's verified direct Speech-to-End chains. When speech finishes,
the transition invokes the prepared original `DataLinkPlay.PlayNextEvent`;
its `ProcessAction(EA_NextEvent)` leaves `lastEvent` at the authored
`ConEventSpeech` and `currentEvent` at the linked `ConEventEnd`. The prepared
`DataLinkPlay.PlayEvent.SetupEvent` dispatches the End event to inherited
`ConPlayBase.SetupEventEnd`, whose `EA_End` result enters the prepared original
`DataLinkPlay.ProcessAction`. That body clears `currentEvent` and invokes the
prepared `DataLinkPlay.TerminateConversation`, which runs its trigger
notification and inherited `ConPlayBase.TerminateConversation` before the
existing end-transmission timer destroys or advances the HUD shell.
Each route supplies its authored speech string and exact Mission00 MP3 bytes,
SHA-256, and duration through `dataLinkPresentation().audio`; the start cue is
the original `DeusExSounds.DataLinkStart` payload. The common DataLinkPlay
defaults remain linked from the original class (`blinkRate = 0.5`,
`startDelay = 1.5`, `endDelay = 1`, `perCharDelay = 0.03`, and the 0.5-second
post-speech wait).

The scheduler also calls the prepared HUD methods at the source state edges:
`ShowTextCursor(False/True)`, `ShowDatalinkIcon` after an original
`Window.IsVisible` query during startup blinking, `ClearScreen`, `SetSpeaker`,
`ShowPortrait`, and `DisplayText` when Speech begins, then the original
`TextWindow.SetText` and `Window.Show(!Window.IsVisible())` end blink. The
installed 245-byte `HUDInfoLinkDisplay.SetSpeaker` body now runs directly. Core
native 128 `Left` executes its recovered clamp/copy behavior, producing
`InfoPortraits.JaimeReyes` with native string concatenation. The final
`DynamicLoadObject` now executes its installed Core wrapper: its two arguments
are evaluated in order, load flags `2` are passed to the recovered
`StaticLoadObject` path, `ResolveName` selects the canonical InfoPortraits
package, and the first `GetPackageLinker` call constructs one `ULinkerLoad`
with its measured archive/reader identity before the native 256-bucket
export/import-class walk reaches export 28. Existing `CreateExport` returns
the same canonical Texture identity before the original Texture cast assigns
`speakerPortrait`; original `TextWindow.SetText` then assigns the display
name. No DataLink-specific function boundary remains. Null-export
construction, native metaclass loads, nonempty post-load work and other
first-load file routes remain explicit loader boundaries; prepared grouped
paths use the same linker walk.

While one play is active, route admission first runs the original
`GetActiveDataLink` gate. Up to eight distinct eligible conversations are
kept in the DataLinkPlay fixed queue, and the original `PopDataLink` body
selects the next route after the end-transmission timer. The admission-side
call runs inside the shell lifecycle, so the prepared
`SetConversation`/`PushDataLink` and `HUDInfoLinkDisplay.MessageQueued` bodies
run on their original fixed queue. The adapter mirrors the queued route only
to retain its trigger/content/audio metadata; the active `DataLinkPlay` object
and route-specific timing/content remain one source-aligned queue. A queued
trigger is notified only when its own route reaches termination.

At the end-timer edge, the scheduler runs the installed 68-byte
`DeusExHUD.DestroyInfoLinkWindow` body. Its native `Window.Destroy` call follows
the recovered recursive removal path for the display and all six controls. The
shell lifecycle dispatches the original `DeusExHUD.DescendantRemoved` event,
which clears `hud.infoLink`; the play object's `dataLink` reference is then
cleared in the source order. With no queued route, the spawned play actor is
marked for deletion. With a queued route, the original `PopDataLink` selects
the next canonical Conversation and `HUDInfoLinkDisplay.CreateControls`
constructs a new display and control tree on the same root/HUD graph before
that route starts. The new display has a distinct object identity and the old
tree remains destroyed. `script-doors.infoLinkShell()` always returns the
current tree.

`reset()` destroys an active window through the same original HUD path,
reconstructs a clean shell, clears all 18 `*_Played` flags, removes a live play,
restores each authored trigger's collision and bookkeeping fields, and permits
a fresh session. The catalog intentionally leaves noncanonical Mission00 DataLinks,
multi-event branches, unsupported `ConEvent` actions, and the original native
ClientHearSound mixer outside this lifecycle. Browser playback consumes the
exact catalog bytes through its existing decoder boundary.

Focused checks:

    node scripts/validate-training-datalinks.mjs
    node scripts/validate-infolink-walking-trigger.mjs
    node scripts/validate-training-datalink-live.mjs

The first validator checks all 18 map/package/audio records. The second
checks movement into `DataLinkTrigger23`, recursive window destruction, and
fresh construction on reset. The focused live validator admits every canonical
route, checks its resolved chain and route-specific presentation/audio, and
proves that queue advance destroys the first shell and publishes a distinct
new shell around the original `PopDataLink` result. The live validator also
requires Jaime's package identity to be prepared while its first `ULinkerLoad`
is constructed only by the native `StaticLoadObject` boundary, then asserts
the end trace order `Speech -> End setup -> EA_End -> currentEvent None ->
termination` using the original object identities;
`test/script-dynamic-load-object.test.mjs` checks the complete successful
StaticLoadObject event order, export 28, `MayFail` flag `0x2000`, missing-linker
and class-mismatch boundaries.
