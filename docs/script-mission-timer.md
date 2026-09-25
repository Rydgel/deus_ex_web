# Mission00 timer — the linked inventory enforcement

The Training munitions instructors' `MunitionsTrooperTake` conversation
confiscates the player's training gear through 29 `ConEventTransferObject`
events ([script-instructor-conversation.md](script-instructor-conversation.md)).
`Mission00.Timer` enforces the same outcome independently: while
`MunitionsTrooperReady` is true it deletes the player's remaining inventory
"in case he tries to keep it". This records the recovered mission construction,
timer enrolment, execution order, and reset, and its live integration.

Original source: the embedded `ScriptText` of `MissionScript`/`Mission00` in
`DeusEx.u` (extracted to `.cache/research/conplay/`). Translation:
`src/runtime/script-mission-live.mjs`, wired into `src/runtime/script-doors.mjs`;
check `scripts/validate-mission-timer.mjs`.

## Construction and startup

`00_Training`'s `DeusExLevelInfo0` carries `Script = class'Mission00'`
(`mapName = 00_Training`, `missionNumber = 0`); no mission actor is pre-placed.
`DeusExLevelInfo.PostBeginPlay → SpawnScript` runs an
`AllActors(class'MissionScript')` dedup check and then `Spawn(Script)`. The
runtime spawns the actor through that original `SpawnScript` bytecode and the
general `SpawnActor` ([spawn](script-spawn.md)). The Info-derived, script-only
`Mission00` (`PropertiesSize 0x334` = Actor `0x318` + the mission's script
fields) is constructed through the ClassConstructor `UClass::Bind` copied from
its nearest native ancestor, `Engine.Info` (`0x1030348b`, vtable
`0x104272d0`). An earlier route constructed it through AActor's constructor,
which gave it the wrong native vtable. The dedup means a second `SpawnScript` never adds a second actor.

`MissionScript.PostPostBeginPlay` runs `SetTimer(checkTime, True)` with
`checkTime = 1.0`, so the actor's `TimerRate/bTimerLoop` enrol a one-second
looping timer. LoadMap's `PostPostBeginPlay` pass reaches the freshly spawned
mission actor; the runtime runs that startup explicitly after the spawn.

`MissionScript` overrides no earlier startup event (`PreBeginPlay`,
`BeginPlay`, `PostBeginPlay`, `SetInitialState` inherit the Info/Actor
behavior), so `PostPostBeginPlay` is the only startup bytecode that matters.

## Timer execution order

The shared `Actor.Tick` scheduler advances the timer (`updateActorTimer`) and
fires `Mission00.Timer` each second — the mission actor ticks in `Level.Actors`
order in the same `processActorTick` loop as the map pawns, not in a separate
host loop. Each `Mission00.Timer`:

1. `Super.Timer()` — base `MissionScript.Timer`. On the first tick `flags ==
   None`, so `InitStateMachine` runs: `Player = DeusExPlayer(GetPlayerPawn())`
   (native 720), `foreach AllActors(class'DeusExLevelInfo', info)` sets
   `dxInfo`, `flags = Player.FlagBase`, `flags.GetBool('PlayerTraveling')`
   (false in fresh Play, so `DeleteExpiredFlags` is skipped),
   `flags.SetDefaultExpiration(dxInfo.MissionNumber + 1)` (native 1125, writes
   the raw int to the XFlagBase `+0x128` default-expiration field — recovered
   from exec `0x10025dc0`), `localURL = Caps(dxInfo.mapName)` = `00_TRAINING`,
   and a `log` line (the GLog side channel). `FirstFrame` only runs when
   `PlayerTraveling`, so it is not reached in fresh Play.
2. `if (localURL == "00_TRAINING")`: `if (flags.GetBool('MunitionsTrooperReady'))
   RemoveAllInventory();` then the crate-broken `AllActors(class'Containers')`
   count (both crates present ⇒ no `DL_Lockpick`) and the holo-Bob hide (not
   played ⇒ skipped).

`RemoveAllInventory` walks `Player.Inventory`. A displayable item
(`bDisplayableInv`) or `Ammo` runs the class branches
(`DeusExWeapon.ScopeOff/LaserOff`, `DeusExPickup.Activate` if active,
`ChargedPickup` removal) and then `Player.DeleteInventory(item)` +
`item.Destroy()`. Anything else, including the non-displayable `NanoKeyRing`,
is left on the chain. The walk re-reads `Player.Inventory` until it is exhausted.

## Interaction with the Take conversation

`MunitionsTrooperReady` is the shared gate. Walking into the instructor's
`FlagTrigger` (`TT_PlayerProximity`) sets it true; the `MunitionsTrooperTake`
conversation's first event (`ConEventSetFlag`) clears it. So a player who frobs
promptly runs the conversation transfer (Ready cleared before the next timer
fire), while a player who lingers at the instructor has the timer confiscate and
destroy the gear — both authored outcomes.

## Reset

Player start re-spawns the mission actor. On reset the old mission actor is
destroyed (recovered `ULevel::DestroyActor`) before the map reload — a
runtime-spawned actor that is never re-introduced by the destroyed-actor ledger
— and a fresh one is spawned into the restored world after the LoadMap startup
passes, so the timer and state machine start over. The `SpawnScript` dedup keeps
exactly one `MissionScript` actor across resets.

## Verified and remaining

`scripts/validate-mission-timer.mjs` drives the whole path through public Play:
the canonical `SpawnScript` actor, a nonempty inventory surviving while Ready is
false, natural `FlagTrigger` entry, timer confiscation + destruction with
ownership cleared, and a single fresh mission actor after reset;
`scripts/validate-instructor-conversation.mjs` covers the Take transfer with the
mission active. The `00_TRAININGCOMBAT`/`00_TRAININGFINAL` branches, `FirstFrame`
(the traveling/knockout path), the crate `DL_Lockpick` trigger and holo-Bob/Jaime
`LeaveWorld`/`EnterWorld` are the same body but are not reached by fresh Training
Play and remain untested here. General inventory/belt presentation is Stage 5.
