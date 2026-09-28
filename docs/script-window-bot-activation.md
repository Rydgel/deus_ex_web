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
  movement, show-area, and recursive cleanup assertions still pass;
* for the RepairBot, the drained player (Energy 10, set before `Frob` because
  `EnableButtons` has no later refresh) presses Recharge through the button's
  original `ActivateButton(IK_LeftMouse)` after a few ticks advance
  `Level.TimeSeconds` past `CanCharge`. `HUDRechargeWindow.ButtonActivated`
  passes the mismatched `btnClose` case by pointer identity, and
  `DeusExPlayer.ChargePlayer` adds `Min(EnergyMax - Int(Energy), chargeAmount)`.

## Button bar layout — 2026-09-28

The MedBot tabs (Health, Augmentations) and the RepairBot Recharge and Close
buttons drew 20 pixels wide with wrapped labels. `PersonaButtonBarWindow` with
`FillAllSpace(False)` gives each button its `QueryPreferredSize`, and
`PersonaBorderButtonWindow.ParentRequestedPreferredSize` returns

```
Max(minimumButtonWidth, Left_Textures[0].width + leftMargin + textWidth
    + rightMargin + Right_Textures[0].width) by buttonHeight + buttonVerticalOffset
```

The installed defaults are 20, 4, 6, 0, 8 and 16 + 0. `textWidth` comes from
`gc.GetTextExtent(maxTextWidth, textWidth, textHeight, buttonText)` after
`GetGC()` and `SetFont(fontButtonText)`. That GC measures with FontMenuHeaders
in both font slots, textFlags 3, textVSpacing 1.0 and destWidth 200. The script
dispatcher for native 1280 (`script-window-gc-dispatch.mjs`) read `width` and
`height` from a result that has `xExtent` and `yExtent`. Every script
GetTextExtent caller therefore got 0, and each text-sized button fell back to
`minimumButtonWidth`. The HUD's native layout adapter had already been fixed for
the same shape mismatch ([text parser](script-text-parser.md)); the script
path had not.

Evidence for the corrected contract:

* The exec body `0x1002c020` passes its out parameters 1 and 2 as the X and Y
  extent pointers. The Unicorn oracle runs that exec body.
* The oracle's `persona-button-*` cases use the real FontMenuHeaders glyphs in
  the captured GC state. They measure the labels as follows, all with height 11:
  Augmentations 107, Health 52, Exit 24, Close 47 and Recharge 68.
* The bar places the top child first, so the last button created is leftmost.
  `PersonaNavBarWindow` creates Logs through Inventory, and the original screen
  shows Inventory leftmost.

The expected `x, y, width, height` values (XWindow +0x78..+0x84, SDK layout)
are:

| screen | button | geometry |
| --- | --- | --- |
| MedBot | Health | 0, 0, 70, 16 |
| MedBot | Augmentations | 70, 0, 125, 16 |
| MedBot | Exit (fill-all bar, width 48) | 0, 0, 48, 16 |
| MedBot | nav filler | 195, 0, 339, 16 |
| RepairBot | Recharge | 0, 0, 86, 16 |
| RepairBot | Close | 86, 0, 65, 16 |
| RepairBot | filler | 151, 0, 40, 16 |

`validate-window-baseline-play.mjs` asserts this geometry for both bots. It
fails with the old marshalling (every text-sized button 20 wide). The same fix
reaches the other script GetTextExtent callers: FrobDisplayWindow,
MenuUIBorderButtonWindow, MenuUITitleWindow, HUDMissionStartTextDisplay,
DamageHUDDisplay and AugmentationDisplayWindow. They were measured as zero-width
text before. Those screens have not been compared visually with the original.

Both complete routes and the production build pass. This closes the reached
bot activation/audio-call boundary, not audible playback, Scale drawing, full
root input routing, value-field formatting, complete bot interaction, or visual
equivalence. Stage 3 remains incomplete.

Reproduce with `node scripts/validate-window-baseline-play.mjs` and
`npm run build`.
