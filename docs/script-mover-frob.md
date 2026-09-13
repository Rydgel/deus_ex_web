# Original DeusExMover.Frob

Using a door in Play now runs the original `DeusExMover.Frob` body. Before this,
`src/runtime/doors.mjs` decided by itself whether a door could be used: it
re-implemented the frobbable/destroyed, locked and one-way gates in JavaScript,
built the like-tagged group by filtering the viewer's own mover list, and
substituted its own `"It's locked"` string. That substitute is removed from the
script-runtime path; the body decides.

## Source of truth

* `DeusEx.u` export **16** `DeusExMover`, export **15897** `DeusExMover.Frob`,
  expanded script size **1324**, `FunctionFlags=0x2`, no native index.
* `Engine.u` export **37** `Mover` declares no `Frob`, so the body's `Super.Frob`
  resolves to `Engine.u` export **1860** `Actor.Frob`, expanded script size **2**
  — the empty base already prepared for the decoration route
  ([script-light-switch.md](script-light-switch.md)).
* Extracted source: `.cache/reference/DeusExMover.uc:487-665`.
* The `Frob` name and signature `Frob(Actor Frobber, Inventory frobWith)` are
  `Actor.uc:1182-1187`.

## Recovered branch order

The body is reached through `ProcessEvent`, so the order below is the original
statement order, not a host policy:

1. `if (!bFrobbable) return;` — no message is assigned yet, so a refusal here is
   silent.
2. `if (bDestroyed) return;`
3. `if (bSlave)` and a non-null `Leader` forward the frob to the leader.
4. `P = Pawn(Frobber); Player = DeusExPlayer(P);` then `bOpenIt=False`,
   `bDone=False`, `msg = msgLocked`. A null `P`, or an `Animal`, returns.
5. A non-player pawn opens any door (`bOpenIt=True`, `msg=""`, `bDone=True`).
6. `bPicking` reports `msgPicking` and sets `bDone`.
7. `(KeyNum != 0) || (PrevKeyNum != 0)` — a door that is not fully closed can
   always be closed: `bOpenIt=True`, `msg=""`, `bDone=True`. This is the
   original's "already open" test; the previous host substitute used its own
   `closed(mover)` helper in its place.
8. `if (!bDone && bOneWay)` runs `GetAxes(Rotation, X, Y, Z)` and
   `dotp = (Location - Frobber.Location) dot X`, refusing with `msgOneWayFail`
   when `dotp > 0.0`. The full rotation axis is the original's; the removed
   substitute used a yaw-only `cos/sin` approximation that ignored pitch and
   roll.
9. `if (!bDone)`: with a non-null `frobWith` the Lockpick and NanoKeyRing
   branches run; with `frobWith == None` the body takes `else if (!bLocked)`
   → `bOpenIt=True`, `msg=""`.
10. `if ((Player != None) && (msg != "")) Player.ClientMessage(msg);`
11. `if (bOpenIt)`: `Super.Frob(Frobber, frobWith)`, then `Trigger(Frobber, P)`
    on itself, then
    `foreach AllActors(class'DeusExMover', M, Tag) if (M != Self) M.Trigger(Frobber, P);`
    guarded by `(Tag != '') && (Tag != 'DeusExMover')`. The fanout is native
    iterator **304** over the complete level actor array, and the
    `Tag == 'DeusExMover'` exclusion is the original's own, not a host filter.

## Training data this exercises

All 25 `00_Training` `DeusExMover` actors are authored in like-tagged pairs
(`MedDoor` alone), every one with `bOneWay=False`, `bSlave=False` and
`KeyNum=PrevKeyNum=0` at load:

| Tag | Movers | bFrobbable | bLocked |
| --- | --- | --- | --- |
| `UN_maindoor`, `darkdoor`, `darkdoor2`, `crateroomdoors`, `cratedoormovers2`, `Body_Room_Entry` | pairs | true | false |
| `gundoor`, `keydoor`, `MedDoor` | pair, pair, single | true | true |
| `paddoor`, `hackdoor`, `bodydoorsopen` | pairs | false | true |
| `DeusExMover` | `DeusExMover49`, `DeusExMover32` | false | false |

The only movers outside the prepared TriggerToggle subset are the two tagged
`DeusExMover`, which the original's own fanout exclusion never reaches. Every
tag group the body can fan out to is therefore fully prepared, so the recovered
fanout is not silently truncated in this map.

## Runtime contract

`createScriptDoors` exposes `frob(mover, frobber = player, frobWith = null)`
(`src/runtime/script-doors.mjs`). It dispatches `Frob` through
`ScriptRuntime.processEvent` and returns `{messages, triggered}`:

* `triggered` is the movers whose prepared state the body actually changed,
  detected by diffing each prepared mover's interpolation endpoint/alpha and its
  `FStateFrame` latent/cursor across the call. `TriggerToggle.Trigger` selects a
  state label before any interpolation runs, so both halves are compared. A
  refused frob changes neither and reports nothing.
* `messages` are the strings the body passed to `ClientMessage`.

`Doors.use` keeps only the boundaries it owns: an unprepared (`!supported`)
mover, and the viewer's own `Opening door` / `Closing door` label for a door the
body just retargeted without a message.

## Explicit boundaries

* **`ClientMessage` is a recorded boundary, not delivered.** The player's
  `ClientMessage` resolves to `Extension.u` export **2269**
  `PlayerPawnExt.ClientMessage`, whose body offers the message to
  `rootWindow.ClientMessage(msg, type, bBeep)` and otherwise falls through to
  `Engine.PlayerPawn.ClientMessage`, which ends in
  `Player.Console.Message(PlayerReplicationInfo, S, Type)`. Both the root-window
  delivery and the console are Stage 4 presentation. The
  runtime records the exact string the bytecode selected from the class's
  localized defaults (`msgLocked` = `It's locked`), and does not fabricate one.
  `frob` installs this capture only for the duration of the call and restores the
  player-startup boundary afterwards
  ([script-player-augmentation-startup.md](script-player-augmentation-startup.md)).
* **`frobWith` is always `None` in Play.** The Lockpick branch
  (`AIStartEvent`, `SkillSystem.GetSkillLevelValue`, `LockPick.PlayUseAnim`,
  `SetTimer` lock picking) and the NanoKeyRing branch (`HasKey`, the like-tagged
  lock toggle) need Stage-5 inventory and are unreached, not implemented. A
  future inventory must admit them before a door can be picked or unlocked.
* **`bSlave`/`Leader` and `bOneWay` are unexercised in Training.** Both branches
  are in the executed body, but no `00_Training` mover sets either flag, so this
  map does not establish them.
* Movers outside the prepared TriggerToggle subset still cannot run the body;
  `Doors.use` refuses them with the existing unsupported label.

## Validation

```sh
node scripts/validate-mover-frob.mjs
node scripts/validate-stage3-dark-doors.mjs
node scripts/validate-gameplay.mjs
node scripts/validate-frob.mjs
```

`validate-stage3-dark-doors.mjs` now expects the original three-pass iterator
order for a darkdoor frob: one `AllActors(class'DeusExMover', 'darkdoor')` pass
matching both panels, then each panel's own `FinishedOpening`/`DoClose`
`AllActors(Event)` pass with zero matches.
