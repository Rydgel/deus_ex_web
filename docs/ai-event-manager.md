# The AI event manager (UEventManager)

Pawns hear and see events through one level object, `LevelInfo.EventManager` (a `UEventManager`, Engine.dll). Scripts register reactions
with `AISetEventCallback` (native 710, `AIClearEventCallback` 711), announce events with `AISendEvent` (713), `AIStartEvent` (714),
`AIEndEvent` (715) and `AIClearEvent` (716), and `ULevel::Tick` calls the manager's `Tick` after the actors. Everything a
`ScriptedPawn` does about a loud noise, a gunshot, an alarm, a distress call, a hacker or a drawn weapon (`HandleLoudNoise`,
`HandleShot`, `HandleAlarm`, `HandleDistress`, `HandleWeapon`, `HandleFutz`, `HandleHacking`, `HandleProjectiles`) is reached through
it. Until 2026-10-13 Play answered 713-716 with a recorded no-op (`script-doors.mjs`), so no pawn ever heard anything: this is the
"NPCs don't hear me" of the perception pilot (docs/visual-acceptance.md "Perception").

## Original contract (recovered before the translation)

Authority: Engine.dll SHA-256 `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`; the SDK's `UnEventManager.h` gives
the layouts (a research reference until the retail bytes confirmed them, which they did, offset for offset).

| Entry | Thunk | Body |
| --- | --- | --- |
| `UEventManager::Destroy` | `0x10303d6e` | `0x10382550` (clears `level`) |
| `DestroyActor` | `0x10301032` | `0x10382760` (called from `ULevel::DestroyActor`, `0x1039679a`) |
| `Tick` | `0x10301843` | `0x103828f0` = `AIProcess(); CleanupEvents();`, called from `ULevel::Tick` at `0x103a5a2b` |
| `AISetEventCallback` / `AIClearEventCallback` | `0x10303d0a` / `0x103015e6` | `0x10382990` / `0x10382b90` |
| `AISendEvent` / `AIStartEvent` / `AIEndEvent` / `AIClearEvent` | `0x1030218a` / `0x10301e24` / `0x10302a5e` / `0x10301dd9` | `0x10382c60` / `0x10382fe0` / `0x103831e0` / `0x103832c0` |
| `FindEvent`, `SafeDelete`, `CompareEventNames` | `0x10302171`, `0x1030236f`, `0x10303d4b` | `0x103834b0`, `0x10383780`, `0x103833d0` |
| `ComputeSenseDetection`, `AIComputeScore`, `AIEvent` | `0x10302f1d`, `0x10303f80`, `0x10302216` | `0x103837b0`, `0x10383f50`, `0x10384980` |
| `AIProcess`, `CleanupEvents`, `CleanupSlot` | `0x10303959`, `0x10303940`, `0x10303de1` | `0x10384080`, `0x10383d80`, `0x10383cb0` |
| settings update / merge | `0x1030308a` / `0x10303283` | `0x10382e60` (+ `0x10382fa0`) / `0x10383bc0` |
| `APawn::AICanHear`, `AICanSmell` | natives 706 / 707 | `0x103c7680`, `0x103c7880` (returns 0.0) |
| exec wrappers (710, 711, 713-716) and `InitEventManager` | | `0x1036d440`, `0x1036d660`, `0x1036d750`, `0x1036d8e0`, `0x1036da70`, `0x1036dba0`; `0x10384a90` |

Data. The manager (`0x43c` bytes): `level` +0x28, `refProcessing` +0x2c, `deleteCount` +0x30, `currentSlot` +0x34, `firstProcess`
+0x38, `eventTable[256]` +0x3c. An event type (`0x3c`): `eventName`, `eventHash`, `senders`, `receivers`, `nextEventType`. A sender
event (`0x14c`): `eventType`, `eventActor`, `bBeingDestroyed`, `nextEvent`, `holdScore` +0x38, `settings[16]` +0x3c (each: visual,
audio, audioRadius, smell), `currentSettings` +0x13c. A receiver event (`0x84`): the same header, then `callback` +0x38,
`scoreCallback`, `bInvokeCallback` +0x40, `eventState` +0x44, `bCheckVisibility/Dir/Cylinder/LOS` +0x48..0x54, `bEventOn` +0x58,
`bestScore`, `bestSender`, `nextSlot` +0x64, `params` (an `XAIParams`: bestActor, score, visibility, volume, smell) +0x68, and the
process ring links `nextProcess` +0x7c, `prevProcess` +0x80.

* **Types.** `FindEvent` hashes the name with `appStrihash` (UTF-16, a-z upper-cased, Core's CRC table, low byte then high byte of
  each unit), takes the low 8 bits as the bucket and keeps each bucket's types sorted by `CompareEventNames` (equal FName: 0,
  otherwise `appStricmp` of the text). A missing type is created only when the caller passes `ppEventType` or `pppPrev`
  (SetCallback, Send, Start do; Clear, End, ClearCallback do not). Within a type, a sender or receiver is found by its actor
  (skipping destroyed events); a new one is **appended** at the list's end, and a new receiver is also linked into the ring just
  before `firstProcess` (a one-element ring when there is none).
* **Senders.** `SendEvent` and `StartEvent` do the same (a deleted actor sends value and radius 0); `SendEvent` raises the current
  slot's setting to the maximum (`settings[currentSlot]`, mode 1), `StartEvent` also writes the value into `currentSettings` (mode
  0). Audio sets both the volume and its radius, visual and smell one value. `EndEvent` zeroes `currentSettings` for one type,
  `ClearEvent` for all three (audio, visual, smell). Defaults of the exec wrappers: value 1.0, radius 800.0.
* **AIProcess** (once a tick, after the actors; skipped while `level` is null). `refProcessing` is raised. For each receiver in the
  ring, from `firstProcess`: a receiver whose actor is `bDeleteMe` is deleted; otherwise its `params` and `bInvokeCallback` are
  cleared; if its actor is not in stasis and was rendered within 5 s (the level's double clock against `LastRenderTime`) or is
  within 1200 of the player, every sender of the type is considered, otherwise only senders within squared distance 160000 (a float32
  of the three squared differences, summed x, y, z at x87 precision). Each candidate (not the receiver itself) gets
  `AIComputeScore` = (squared distance + 1.0), or the receiver's score callback (`LoudNoiseScore`, `WeaponDrawnScore`,
  `DistressScore`: 0 culls the sender); candidates with a score above 0 (at most 256) are sorted ascending (ties in list order),
  and the first one whose `ComputeSenseDetection` gives a visibility, volume or smell above 0 is the receiver's best sender:
  `params` = (its actor, its score, visibility, volume, smell). The event state follows from `bEventOn`: off to on is `Begin` (0) if
  the sender's current settings are nonzero (a started event) and `Pulse` (2) otherwise; on to on with another best sender is
  `ChangeBest` (3); on to off is `End` (1); a pulse leaves the event off. Then `currentSlot` advances; every sender copies its current
  settings into the new slot and is deleted when none of the 16 slots holds a visual, audio or smell above 0; a receiver whose
  `nextSlot` equals the new slot is advanced by one (a log warning, "not cycling quickly enough"). Last, the callbacks run, in ring
  order, for the receivers flagged to invoke: `AIEvent` finds the receiver's function by name (the receiver's `callback`, or `AIEvent`
  when none) and, if the actor has it, `ProcessEvent`s it with (event name, state, `XAIParams`); each receiver's `nextSlot` becomes
  the new slot; `firstProcess` becomes the receiver after the last one visited. No reference is held across the script calls
  (callbacks register, clear and send events).
* **ComputeSenseDetection.** The sender's settings are the maxima over the slots from the receiver's `nextSlot` through
  `currentSlot` (so an event between two of a time-sliced receiver's visits is not lost). An inventory sender with an owner is
  replaced by its owner, scaling the visual setting by sqrt(height x radius of the item / the owner's) (the double square root,
  the item's alone if the owner's is 0). Visibility: scale x visual; for a pawn receiver above 0, `AICanSee(sender, visibility,
  the receiver's four check flags)`; for another receiver a `SingleLineCheck` (flags 6) from the receiver to the sender and 0 when
  blocked. Volume: the audio setting; above 0, for a pawn `AICanHear(sender, volume, radius)` and for another receiver the volume
  when within the radius, else 0. Smell: `AICanSmell` is 0.0. `AICanHear` is `clamp((1 - sqrt(d) / radius) x volume - HearingThreshold,
  0, 1)` with d = dx^2 + dy^2 + (2 dz)^2 (the deltas stored float32, dz doubled), radius 800 if not above 0, 0 for an undetectable
  other or a volume not above 0, no line check.
* **CleanupEvents** (after AIProcess, in `Tick`). Only when nothing is processing and a deletion is pending: the ring is relinked
  past destroyed receivers (`firstProcess` too), then destroyed senders and receivers are unlinked and freed.

## Translation

`native/script-vm/src/aievent.rs`: the tables (a pool the host allocates in the object arena: the module's statics are nearly all of
the arena's reserved region), `FindEvent`, the natives, `AIProcess`, `ComputeSenseDetection`, `AIComputeScore`, `AICanHear`,
`CleanupEvents`, in the original's order and arithmetic (`Ext`, one rounding per operation, a float32 store where the original has
an `fst`/`fstp`). The host (`src/runtime/script-vm-aievent.mjs`) supplies what the original reads from actors and runs in script: an
actor's flags (`bDeleteMe`, Pawn, Inventory, `bDetectable`), location, collision size, `LastRenderTime`, `DistanceFromPlayer`,
`HearingThreshold`, owner and level clock, `AActor::InStasis`, `APawn::AICanSee`, `ULevel::SingleLineCheck`, and the script calls
`AIEvent` and `AIComputeScore` make. AIProcess's rdtsc time budget (below, "The time budget") is host time: a replay gives it as a
measured input (`ai_set_process_stop`).

## Verification

* `scripts/native-event-manager-oracle.py` executes the original `UEventManager` methods (the bodies above) over a synthetic level
  under Unicorn: the real `FindEvent`, `ComputeSenseDetection`, `AIProcess`, the real `AICanHear` and `AICanSmell` and the real
  `bDeleteMe` getter run unchanged. The boundaries are explicit leaves that log their arguments: the event classes' allocator and
  deleting destructor, `FindFunction`, `AActor::ProcessEvent`, `AActor::InStasis`, `AICanSee`, `SingleLineCheck`, `appQsort` (an
  ordering by score and slot, checked against the original comparator `0x10382420` by the `comparator` scenario), `appStricmp`,
  the FName table and `GCRCTable` (UE1's values).
* `scripts/validate-event-manager.mjs` (cases in `scripts/event-manager-cases.mjs`: 18 hand-written scenarios and 80 seeded random
  ones): per operation, the boundary logs and the manager's tables (types in bucket order, senders and receivers in list order, the
  16 slots of every sender, the ring, `deleteCount`) of the Rust port equal the original's.

## Host integration

* **Start-up.** `LevelInfo.PreBeginPlay` calls native 650 (`InitEventManager`). Play makes a **new** manager at every call
  (`AiEventHost.init` resets the pool): a Player start re-runs the startup on the same `LevelInfo` (the original's `LoadMap` makes a
  new level, `LevelInfo` and manager), and the old generation's events named released actors. The manager is a pool in the object
  arena, outside the JavaScript heap; `EventManager` on the `LevelInfo` is a token for the scripts' `!= None` tests and for
  `ULevel::Tick`.
* **Natives.** 710/711 and 713-716 reach `ScriptRuntime.aiEventNative` with the exec wrappers' defaults (checks `[1,1,0,1]`, value
  1.0, radius 800.0; an `EX_Nothing` argument keeps the default). The Rust VM's handbacks take the same route.
* **Tick.** `ULevel::Tick` calls the manager's `Tick` after the actors (`script-doors.mjs` `tickEventManager` -> `AiEventHost.tick`), and
  `CleanupDestroyed` calls `DestroyActor` (`destroyActorEvents`), as the original's `ULevel::DestroyActor` does.
* **What Rust reads from the image.** Actor flags (`bDeleteMe`, Pawn, Inventory, `bDetectable`) and locations come from the object
  image (`percep.rs`) when the perception table is ready; otherwise the host reads them. `APawn::AICanSee` runs in Rust
  (`ai_can_see_direct`, the same body as the script native 705) with a JavaScript fallback; the score callbacks
  (`LoudNoiseScore`, `WeaponDrawnScore`, `DistressScore`) run in Rust through the dispatch tables, enabled per manager tick (the
  EVENTS enable word is set only inside the actor tick, so the manager keeps its own).
* **Callbacks.** `AIEvent` finds the receiver's function by name and runs it through the script dispatcher (`ProcessEvent` with the
  event name, state and an `XAIParams`); this is the one JavaScript crossing per delivered event.

* **UObject slots (2026-10-14).** Each event type, sender and receiver is a UObject: `FindEvent`'s, `SetCallback`'s and
  `SendEvent`/`StartEvent`'s `new` run `AddObject`, and `CleanupSlot`'s deleting destructor `~UObject`, so the objects
  take and give back GObjObjects slots that sounds created later reuse (LIFO). `aievent.rs` `alloc`/`release` call the host's
  `js_ai_slot(table, index, op)` at those points and `AiEventHost.slot` hands them to the slot model
  (`original-object-index.mjs`). The Weapon scene's 361 creations and 211 releases of event objects interleave with the
  spawns' in the original's order ([object-index-captures](object-index-captures.md) "Runtime spawns").

## Verification of the translation in play

* `validate-event-manager` (oracle, above), `validate-pawn-perception` (AICanSee, 756 scenes and 14 mutations bit-exact, see
  [pawn perception](script-pawn-perception.md#aicansees-x87-placement-found-live-2026-10-13)), `validate-perception-kernel`.
* The live acceptance ([visual acceptance](visual-acceptance.md#perception-pilot-2026-10-13)): per-tick state of every watched NPC
  against the original, with a visible player allied to mj12 (hostile to the civilians).

## Open items

* The rdtsc time budget `AIProcess` checks while `GTimestamp` is set is host time: Play processes the whole ring each tick unless a
  replay gives the original's stop (below).
* `AICanSmell` is the original's constant 0.0; smell events are carried and never detected, as in the original.
* A player-fired weapon is compared with the original ([Weapon noise](visual-acceptance.md#weapon-noise-2026-10-14)): `WeaponFire`,
  `LoudNoise`, `Projectile`, `Futz`, the hit objects' noises, `HandleShot` / `HandleDistress` deliveries and the callbacks' parameters equal,
  with the CRT state at every call, for a pistol and an assault shotgun. Not compared: the player's footsteps (the harness cannot hold a key), the
  player's own `TakeDamage` `Distress`, weapons with a silencer or projectiles.

## The time budget (2026-10-16)

`GTimestamp` is not a profiling flag in play: Core sets it when the CPU has RDTSC, and every machine that runs the game has. AIProcess
(`0x10384080`) reads rdtsc at its start (`0x103840ec`) and computes its budget as `1 - ftol(-0.002 / GSecondsPerCycle)` cycles, 2 ms
(the double `-0.002` at `0x1042d170`, `0x103840ba..0x103840e5`). After each receiver that did work (`[ebp-0x44]` set at `0x103842b9`)
it reads rdtsc again and leaves the receiver loop when more than the budget has passed (`0x10384470..0x1038449a`, an unsigned compare of
the low words). The slot update and the callbacks then run for the receivers visited, and `firstProcess` is left at the next one: the
rest of the ring waits for the next tick, and a receiver reached more than 16 ticks after a send misses it.

So how far AIProcess gets in a tick is the host's speed. The Underworld sound captures show it: under the tracer's breakpoints the
original runs about 210 ms of wall clock per tick, and in `sndm2` (with a breakpoint inside AICanSee) the shot's HandleShot callbacks
reached one receiver per tick (Businessman1 at 212, Female6's HandleDistress at 215, Female7 at 216, ...) where Play delivered them all at
211; in `sndm` Female6 never reacted. The tracer now records, at each tick's exit, the receiver `firstProcess` was left at
(`tools/dx-live-win.c` `aiFirst`: ALevelInfo `+0x550` is the manager, `+0x38` firstProcess, a receiver's eventType `+0x28` and
eventActor `+0x2c`), and the replay hands it to the next AIProcess (`live-probe.mjs`, `AiEventHost.setProcessStop`, `aievent.rs`
`ai_set_process_stop`): the loop stops before that receiver, and a stop the ring does not reach counts in `ai_process_stop_misses`
(the replay's row `aiStopMissed`). In `sndm3` the ring made whole laps except at ticks 212 and 213; with the stops replayed every AI
callback, NPC reaction and Galaxy PlaySound of the scene matched in tick, emitter, sound, volume, radius and pitch.

The sender the player's landing leaves in the manager before the scene, which Play does not hold, is freed in the original by
CleanupEvents at the end of the manager's Tick, after the objects that tick's actors create; the replay now releases its slot
there (`AiEventHost.afterTick`) instead of at the start of the tick.

