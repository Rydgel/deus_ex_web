# Training bot screen activation and deferred raise-arm sound

## Original contract recorded before admission

Authority is the embedded GOTY `DeusEx.u` UnrealScript plus the already
recovered Engine `Actor.PlaySound` native 264 contract in
[`script-sound.md`](script-sound.md). The installed package sources say:

* `HUDMedBotHealthScreen.SetMedicalBot` stores `medBot`, calls
  `MedicalBot.StandStill`, and, when its optional `bPlayAnim` is true, calls
  `PlayAnim('Start')` followed by
  `PlaySound(sound'MedicalBotRaiseArm', SLOT_None)`.
* `HUDRechargeWindow.SetRepairBot` stores `repairBot`, calls
  `RepairBot.StandStill`, calls `PlayAnim('Start')`, then calls
  `PlaySound(sound'RepairBotRaiseArm', SLOT_None)` before `UpdateInfoText`,
  `UpdateRepairBotWindows`, and `EnableButtons`.
* Both `StandStill` implementations enter `Idle` at label `Idle` and assign
  `Acceleration=Vect(0,0,0)`.
* Neither setter stores or otherwise observes PlaySound's integer channel id.

The original native evaluates Sound, Slot, Volume, bNoOverride, Radius and
Pitch in order and derives a channel id before listener delivery. That native
contract and the live measured-object-index route are unchanged. The normal
browser host deliberately retains one-shot native-264 effects at the existing
deferred-audio seam because `ClientHearSound`/audible playback is Stage 4.
Admitting these two callers therefore records the reached effect with channel
id zero; it does not pretend that the sound played.

## Play integration — 2026-09-24

Only the two exact caller paths
`HUDMedBotHealthScreen.SetMedicalBot` and
`HUDRechargeWindow.SetRepairBot` are admitted as `BotRaiseArmSound`. The
original argument expressions still execute before the boundary, and each
original setter continues from the native return. No actor-name exception,
forced animation, swallowed general PlaySound call, or fake audible result is
used.

`scripts/validate-window-baseline-play.mjs` runs each Training bot through its
real `Frob` route in a fresh Play host and verifies:

* exactly one native-264 call comes from the expected installed setter;
* its discarded boundary result is zero and exactly one named deferred effect
  is retained on the actual bot identity;
* `StandStill` clears `Acceleration`, `PlayAnim` selects `Start`, and the
  original setter returns;
* the previously verified button, accelerator, medical scroll layout,
  movement, show-area, and recursive cleanup assertions still pass.

Both complete routes and the production build pass. This closes the reached
bot activation/audio-call boundary, not audible playback, Scale drawing, full
root input routing, value-field formatting, complete bot interaction, or visual
equivalence. Stage 3 remains incomplete.

Reproduce with `node scripts/validate-window-baseline-play.mjs` and
`npm run build`.
