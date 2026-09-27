# Authored Training route boundary

This route follows the installed `00_Training.dx` placements and Mission00
script through the first section's `DL_part2` threshold. It is an integration
probe, not an authored replacement level: the player starts at `PlayerStart1`,
uses installed User.ini input bindings and the original scheduler, and lets the
map's collision queries select every interactable. Route code must not teleport
the player, set `FrobTarget`/`FrobTime`, set angles directly, spawn a substitute
pickup, or force a trigger/door result. The fixture may use raw mouse-axis
feedback only to steer the ordinary Play input path; measured `ViewRotation`
response closes the control loop.

Walking waypoints are test-fixture guidance rather than claims about the
original player's exact trajectory. In the gundoor-to-Keypadroom transition,
a compiled-BSP sample found the direct north segment east of the gundoor
blocked; that sample is planning evidence, not a claim about the live pawn's
collision dimensions. The fixture skirts it through physical route points
`[1360,200]`, `[1760,200]`, and `[1760,850]`; every leg still uses the live game
movement and collision path. The map's serialized ReachSpec chain starts at
PathNode423/PatrolPoint2 and does not establish an ingress from the current
player position. Wall-mounted door crossings use points on the map-derived
brush centerlines: `paddoor`/`hackdoor`/`Body_Room_Entry`/`bodydoorsopen`/
`darkdoor` at Y=848, and `darkdoor2` at Y=544. The medical room's horizontal
door plane is crossed at X=3688. These coordinates guide the fixture; actual
movement and doors remain checked by live collision and mover state.

## Evidence and route contract

Original map evidence and all 18 route positions/speech/audio chains are
enumerated in [the DataLink catalog](script-training-datalinks.md). This
translation reuses those decoded exports rather than keeping a duplicate list.
The Training key and doors, both breakable crate tags, keypad code, cadet/table
and the dark-door mover pairs are decoded from `00_Training.dx`. The mission
script evidence is in [Mission00.Timer](script-mission-timer.md),
[crate destruction](script-crate-destruction.md), and [fresh mission entry and
cadet](script-training-mission-entry.md).

The exercised route is:

1. Walk from `PlayerStart1` through the open `UN_maindoor` pair, naturally
   entering `DL_Start` and `DL_door`.
2. Collect `NanoKey0` (`KeyID=Train`), use it on the authored `keydoor` pair,
   and continue through the trainer area to `DL_key` and `DL_F1F2`.
3. Reach `DL_crate`, take the placed crowbar, and destroy one of the original
   `Cratepick1`/`Cratepick2` actors through its real weapon notify path. The
   Mission00 timer observes either destroyed crate and queues `DL_Lockpick`;
   the second crate is not required for that condition. Enter the conditional
   `DL_lockstr` volume after the crate and lockpick stages.
4. Equip the Lockpick and use it on the locked `gundoor` pair
   (`bPickable=true`, initial `lockStrength=0.05`), then open and cross that
   door through its native timer/mover path. Follow the fixture's BSP skirt to
   the Keypadroom. Read `DataCube0` for code `0012`,
   enter it in `Keypad0`, and pass the `paddoor` pair. The fixture enters the
   `DL_keypad` trigger radius on the BSP skirt and waits for its authored
   conversation to finish after the keypad route resolves. Pick up a placed
   multitool and enter `DL_multitool`. Use that tool on `Keypad2` to hack the
   locked `hackdoor` pair; its map export has an empty `validCode` and a
   nonzero `hackStrength`, so the numeric `0012` route is not reused there.
5. Open and cross the unlocked `Body_Room_Entry` pair, then enter `DL_body`
   after Mission00's fresh-entry FirstFrame has knocked out
   the map `Test_Subject`. Search that same body for `Body_Search_Room`, unlock
   the medical door, carry the body to the placed table, and let the body's
   natural table touch open the two `bodydoorsopen` movers.
6. Open the `darkdoor` pair and wait for `DL_dark` while still on its west
   approach, then cross it. Open and cross the unlocked `darkdoor2` pair, pass
   the repair-bot area (`DL_repairbot`), and stop at `DL_part2`.

Each step is an assertion boundary: a missing target, missing expected
DataLink, failed pickup, locked/unopened authored door, absent crate contents,
missing cadet/body/key, or absent table exit opening fails the route. Existing
class-focused validators retain their exact assertions; the route does not
replace them or loosen the gate's unsupported-native classifications.

## Timed interaction contract

These are native lifecycle boundaries for the route fixture. They describe
what a fixture must wait for and assert; they do not claim that a particular
Play-mode route run has verified those transitions.

- Mission00 starts `DL_Lockpick` when fewer than two tagged crates remain, so
  destroying either one crate satisfies the condition. A conversation can be
  active before it is queued or marked played: `DataLinkPlay.SetConversation`
  stores the first conversation in `con`/`startCon`, while later ones enter
  `conQueue` (`.cache/reference/DataLinkPlay.uc`); `_Played` is set at
  termination (`.cache/reference/ConPlayBase.uc:243-251,311-330`). A route
  waiting for `DL_Lockpick` must therefore accept active, queued, or completed
  state, rather than requiring only queue membership or `_Played`.
  Mission00's one-crate condition is in
  `.cache/research/src/DeusEx/Mission00.uc:77-90`.
- Lockpicking is elapsed-work driven. In standalone,
  `DeusExMover.Frob` sets `numPicks=pickValue*100` and
  `TicksPerPick=(pickTime*10)/numPicks`, then schedules a 0.1-second timer
  (`.cache/reference/DeusExMover.uc:573-595`). The timer accumulates elapsed
  time, applies pick progress and reduces lock strength by 0.01 per completed
  interval; linked movers share the updated lock strength
  (`:379-423`). Completion unlocks the pair and `StopPicking` consumes one
  pick through `UseOnce` (`:469-481`); it does not itself open the door. The
  fixture should wait for picking to stop and the pair to unlock, then issue
  the ordinary open input and wait for both movers to finish their authored
  two-second interpolation. Exact pick duration depends on the original
  `pickTime` and the player's `SkillLockpicking` value; those values must come
  from the native class defaults/runtime rather than a fixed frame guess.
- Keypad0's map code is `0012`. The original keypad maps Numpad0 to key button
  10/string `0`, appends non-repeat digits, and validates when the input length
  reaches the code length (`.cache/reference/HUDKeypadWindow.uc:225-267,
  276-310`). A successful code runs its event and schedules `KeypadDelay` for
  one second later, when the modal is popped (`:319-375`). The fixture should
  wait for that modal to close, then assert both `paddoor` movers are unlocked
  and no longer interpolating; their map-authored `MoveTime` is two seconds.
- Keypad2's map code is empty and its `hackStrength` is nonzero. The original
  standalone hack starts with `numHacks=SkillTechValue*100` and
  `TicksPerHack=(hackTime*10)/numHacks`, using 0.1-second timer callbacks
  (`.cache/research/src/DeusEx/HackableDevices.uc:196-216`). Timer progress
  applies elapsed work until strength reaches zero, at which point HackAction
  runs; changing the target or tool aborts the operation
  (`:72-114`). Stopping consumes one multitool (`:138-150`). Keypad HackAction
  opens the keypad in instant-success mode, whose successful event still uses
  the one-second close timer (`.cache/reference/Keypad.uc:30-80`,
  `.cache/reference/HUDKeypadWindow.uc:319-375`). The fixture should wait for
  the hack to stop, the keypad modal to close, and both `hackdoor` movers to
  finish opening. Exact hack duration depends on native `hackTime` and
  `SkillTechValue`; a fixed short tick delay is not an evidenced substitute.
  Actor timers run only after ProcessState in the admitted Actor.Tick branches
  (`docs/script-actor-tick.md`); the original InStasis test can return before
  both phases. Training's headless probe painter updates HUD commands but does
  not submit actor meshes, so it leaves actor `LastRenderTime` at the LoadMap
  value `-10` and the transient model-zone timestamp at zero. Keypad2 is
  `bStasis=true`, `Physics=None`; once Level.TimeSeconds is over five seconds,
  these stale timestamps satisfy the recovered stasis gates even though
  `DistanceFromPlayer` is only about 122. In the bounded isolated capture
  (`.cache/batch6-keypad2-hack-result.json`), after 7.25 seconds the timer was
  armed at `0.1` looping, but 360 headless frames produced zero Timer dispatches
  and left strength at `0.05`. Calling the existing
  `actorRenderFeedback` only while the real `FrobTarget` remained Keypad2
  updated that actor's LastRenderTime; seven such observed-render frames
  produced one Timer callback and completed the hack while the zone stamp
  remained zero. This confirms the native timer path catches elapsed work when
  it resumes; it does not measure ordinary hack duration or establish original
  BSP/portal visibility. Keep any headless draw notification scoped to the
  continuously aimed-at actor; do not refresh all actors or fabricate zone
  timestamps. The original Render.dll actor and model-zone writes and browser
  callback limits are recorded in `docs/script-loadmap-startup.md:117-152`.
- Mission00's FirstFrame knocks out the authored test subject
  (`.cache/research/src/DeusEx/Mission00.uc:20-31`). Carcass auto-carry only
  applies when the carcass inventory and player's hand are both empty;
  otherwise Frob searches the body (`.cache/research/src/DeusEx/DeusExCarcass.uc:346-370`).
  Thus the body-held `Body_Search_Room` key must be searched before the empty
  body can be carried. Dropping a POVCorpse uses the throw/drop branch rather
  than target placement and spawns a physical falling carcass
  (`.cache/research/src/DeusEx/DeusExPlayer.uc:5870-5955`). The authored table
  trigger is a Carcass-class proximity trigger (class index `-177`, radius
  `60`) with event `bodydoorsopen`, so it is the spawned carcass that must
  overlap it. After that event, wait for both exit movers to finish their
  authored interpolation before treating the exit as open.

## Explicit coverage limit

`DL_part2` is the end of this Stage 3 route slice. The authored later course
continues to `DL_jump`, `DL_cratestack`, `DL_ladder`, `DL_swim`, and `DL_medbot`;
the `DL_swim` text warns that the water is contaminated and calls for the
hazmat suit, while the route intersects a damage zone. Swimming, ladders,
underwater movement and damage-zone traversal remain unsupported Stage 5
movement. This probe does not enter that water or claim completion of the full
Training course.
