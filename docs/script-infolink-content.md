# DL_Start visible InfoLink content and lifetime

The Training preview reads its visible transmission content from the installed
GOTY packages. `DeusExConText.Conversation57` (`DL_Start`) links
`ConEventSpeech79` to `ConSpeech79`, then to `ConEventEnd77`. The speech event
binds `JaimeReyes`; `DataLinkPlay.infoLinkNames[9]` maps that bind name to
`Jaime Reyes`. The complete displayed sentence comes from `ConSpeech79.Speech`
and the voice remains sound ID 79.

`HUDInfoLinkDisplay.SetSpeaker` constructs
`InfoPortraits.JaimeReyes`, assigns it to `winPortrait`, and `ShowPortrait`
selects normal draw style and shows both the portrait and static window. The
installed SetSpeaker body now performs those writes in Play: recovered Core
native 128 supplies `Left(BindName,16)`, native concatenation builds the object
path, and the recovered `DynamicLoadObject` wrapper enters the prepared
InfoPortraits linker, export hash/import-class walk, and existing-object
`CreateExport` before the original Texture cast. First-load linker construction
and native metaclass loads remain loader boundaries. The
installed portrait is export 28, a 64×64 P8 texture. Its decoded opaque RGBA
SHA-256 is
`b2811f056a7c9af1990351a6593708bd4d0244402c1f6de2492b716d5954d0ef`.
The initial blink uses `DeusExUI.UserInterface.DataLinkIcon` export 1190, also
64×64 P8; masked decoding has RGBA SHA-256
`21b596984ce9a5298dfe2965244622d9abdcf63808d50fbc0712f41f3cb42788`.
`TextureStore` performs the existing palette and mask-index decoding in the
browser, and the canvas receives those pixels directly.

`DataLinkPlay` supplies `blinkRate=0.5`, `startDelay=1.5`, `endDelay=1.0`,
and `perCharDelay=0.029999999329447746`. Its repeating Timer increments by the
blink rate and uses a strict `>` comparison. Speech therefore begins on the
fourth tick at +2.0 seconds. Native MPEG timing gives speech79 a duration of
7.176000118255615 seconds. `WaitForSpeech` sleeps another 0.5 seconds before
the end event. The end title then blinks on the same 0.5-second Timer and the
strict end-delay comparison destroys the HUD window on the third tick. The
reference preview consequently removes itself at +11.176000118255615 seconds;
there is no close button in the original path.

`script-infolink-content.mjs` verifies the package identities, event chain,
authored values, defaults, texture exports, formats, and dimensions before
returning the content. `script-infolink-timeline.mjs` models the two strict
timer gates and presentation phases. The original ComputerWindow construction,
configuration and queued text operations now back `winText`; browser glyph
rasterization and final HUD texture drawing remain rendering adapters.

The Play scene now starts this presentation from normal movement. The original
`DataLinkTrigger23` is centered at
`(-811.6166381835938, 832.4313354492188, -75.06744384765625)` with collision
radius 300 and height 20. Player movement's recovered BeginTouch dispatch runs
the installed `DataLinkTrigger.Touch` and `EvaluateFlag` bytecode. The
supported call then runs the installed player selection/spawn path, publishes
the constructed InfoLink child on the HUD, returns true, and completes through
the original `DatalinkFinished` and base Trigger Touch bodies. The one-shot
trigger is removed from collision after completion. The header replay control
has been removed; walking forward from the original Training spawn is the only
normal entry. See [the live lifecycle](script-datalink-live.md).

Focused validation:

    node scripts/validate-infolink-content.mjs
    node scripts/validate-infolink-walking-trigger.mjs
