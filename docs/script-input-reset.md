# LoadMap resets the viewports' input (2026-10-22)

Found measuring the AC fan of retromaggedon `Save0021` under the original ([rotating-brushes](rotating-brushes.md)): the loaded player stood in the original and stayed
crouched in Play. The save holds the pawn in a duct at Z -491.1 with `bDuck` 1, `bIsCrouching`, CollisionHeight 16. The original, sampled 7 to 60 s after `LoadGame 21`
(`.work/travel/fan4`, `JCDentonMale2`), has Z **-464.100006** (+27, the crouch undone: 43 - 16), `Health` 82, unchanged otherwise. Play kept `bDuck` 1 for as long as it ticked.

## Where the original resets the input

`UInput::ResetInput` is `UInput` vtable slot `+0x68` (`node scripts/sdk-layouts.mjs --vtable UInput`), body Engine.dll `0x10394910`
([script-console-command](script-console-command.md), "Original input sampling"). Callers in Engine.dll that reach a `UInput`:

| Site | Where | Viewport's Actor at the call |
| --- | --- | --- |
| `0x1038dff3` | **`UGameEngine::LoadMap`, its tail**: right after `GNewBrushTracker` (`0x1038dfb5`, the log line `Initialized moving brush tracker for Level ...`) and the audio subsystem's `SetViewport` calls (`0x4c(%ebx)`, vtable `+0x84`/`+0x5c`), a loop over `Client->Viewports` (`0x44(%ebx)` -> `+0x2c` data, `+0x30` count): `Viewports[i]->Input->ResetInput()` | the player `Login` just gave the viewport (the log shows `Possessed PlayerPawn` before the tracker line); `ResetInput` reads `Actor->Class` (`0x10394976..0x10394979`) with no null test, so the Actor is not null here |
| `0x10393d65` | a `UInput` method (probably `Init`) that stores the viewport at `+0xea0` and then calls `ResetInput()` | none yet |
| WinDrv focus loss | the window procedure ([script-console-command](script-console-command.md)) | the local player |
| `0x10405370` | `0x10405290`, a `UNetConnection`-state function (`+0x60` 2 -> 3, `SetPlayer`): the demo spectator, not the standalone path | n/a |

Extension.dll imports the function (thunk `0x10054642`) but nothing in it calls the thunk; DeusEx.dll's callers were not listed (the `LoadMap` site covers every level change:
new game, `LocalTravel`, `Browse ?loadgame`, Player start).

## What `ResetInput` clears (`0x10394910`)

In order: the 255 held-key bytes at `UInput+0xeb0`; with the viewport (`+0xea0`) and its Actor (`+0x30`): every `CPF_Input` (`0x4`) **ByteProperty** of the Actor's class chain, derived to
base, one byte each (`bRun`, `bDuck`, `bFire`, `bStrafe`, ...), then in a second pass every `CPF_Input` **FloatProperty**, four bytes each (`aForward`, `aTurn`, ...); array properties only
element 0; then `Action` and `Delta` (`UInput+0xea8/+0xeac`); then `viewport->UpdateInput(1)` (vtable `+0x7c`), which replays the physical keys that are down.

## What Play does

The recovered body already existed (`script-console-command.mjs resetInput`, reached from the page's focus/visibility handlers through `windowHost.resetInput`). Play never called it
at the end of a LoadMap: `script-doors.mjs loginPlayer`, the last step of level entry (it already writes the `Initialized moving brush tracker` line, every `createScriptDoors` and
every Player start run it), now calls `windowHost.resetInput()` right after that line, in the original's order. A cold start, a travel and a New Game begin with the input bytes at zero anyway;
only a restored player carries saved values, which is why only a loaded game showed it.

## Validation

* `scripts/validate-load-input-reset.mjs`, A (Play only): bDuck, bRun and aForward are set on the Training player (crouched), the level is saved and loaded; the loaded player holds
  all three at zero and stands (CollisionHeight 16 -> 43 within 20 ticks). Mutation check: without the call the loaded `bDuck` stays 1.
* B (needs the outside-Git slot and the Wine capture): Save0021 loaded in Play, 60 ticks later the player is at
  `(27.833505630493164, 2181.841064453125, -464.1000061035156)`, **bit for bit the original's dump** (`Location=(27.8335056,2181.84106,-464.100006)`), `Health` 82.
* With the measured captures present: `validate-load-game` (796 records equal), `validate-travel-restore` (5 scenarios), `validate-travel`, `validate-travel-newgame`, `validate-load-ui` and `validate-loadmap-startup` pass with the call in place.

## Unverified

* The order against the audio `SetViewport` calls that precede it in `LoadMap`, and the `0x64(%esi)` call after it (`vtable +0x68` with argument 1: not `UInput`; unidentified), have no Play equivalent
  here; neither touches the player.
* A held key at the instant of a level change (the browser): `UpdateInput(1)` re-delivers it as a press; not compared with the original.
