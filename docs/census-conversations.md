# The conversation census (Stage 6, rows 6.4.\*.3)

Status 2026-10-24: both passes are complete and clean on the Linux host (`node scripts/validate-conversations-census.mjs --slots --jobs 4`): every own conversation
of the 14 mission lists runs from a cold open of its map or is a named boundary, and from the latest real desktop save slot of each map that has one every conversation
runs, or the original's own code refuses it in that played state, or its owner is no longer in that level. Evidence class **P**: Play against itself. The census finds the conversations that stop in Play; it does not
compare their content with the original (the placed-chain rows 6.4.\*.1 do that for each mission's required chain).

## What it does

`node scripts/census-conversations.mjs [--missions 00,01] [--maps ...] [--only Name,...] [--jobs 2] [--slots] [--rerun result.json]` plans the census from
the campaign inventory (`scripts/inventory-campaign.mjs`, output `.work/campaign-inventory`, regenerated when missing), then runs one Play child process per
map (`scripts/census-conversations-child.mjs`, Node, headless, the stage-5 session) and writes `.work/census-conversations.json` and a by-family summary. The
output holds conversation names, flags and states, never the game's text, and stays under `.work/`. The validator `scripts/validate-conversations-census.mjs
[--missions ..] [--slots] [--results file]` runs it (or reads a result) and fails on any conversation that neither ran nor is named in
`scripts/census-conversations-boundaries.mjs`.

**The plan.** 1,623 own conversations in the 14 lists (ConList_Mission16's 384 shared AI barks excluded): 398 InfoLinks, 398 talks, 827 first-person
non-interactive ones. Each is assigned to the first map of its mission where its starter exists: a DataLinkTrigger by tag, a ConversationTrigger, the mission
script's `StartDataLinkTransmission`, or the owner and every speaker (`BindName`/`BarkBindName`, stored or class default). 52 have no actor that could bind
them (below).

**The start, as the original starts it** (`via` in each result). InfoLink: the player walks into its DataLinkTrigger (269) or the trigger's Touch/Trigger event (58),
the mission script's call (13), a direct call where the data has no starter (46). Talk: the right button on the owner through the view trace (844) or the pawn's
Frob event (19); the radius invocation by `ScriptedPawn.Tick`'s own `StartConversation(IM_Radius)` (124); by name for the ones with no invocation flag (47).
AI barks (`Owner_BarkFutz`, `..AllianceHostile/Friendly`): the AI's own calls (`PlayFutzSound`, `StartAIBarkConversation`) (36). Which conversation a frob or
radius picks is asked of the original's `GetActiveConversation`; the ones before it in the owner's chain are put out of the way by their own conditions.

**Harness steps, all labelled in the result's notes** (not behaviour under test): the flags a conversation needs (its `flagRefList`) set through the FlagBase;
the player placed (dry ground, inside the radius); `EnterWorld()` on a pawn the map keeps out of the world, as the mission script does (40); the map's
`OrdersTrigger` fired as a Trigger call for a pawn authored with Orders Idle (4); the other speakers set down within 90 units of the owner after the original's
`CheckActorDistances` refused (16); god mode; the level started again once if the first attempt was refused (35 ran that way, and the second try sets the player down
and calls at once, before any pawn has seen it). Third-person conversations are advanced by Enter every half second, a choice takes its first option and a choice met
again the next one so that menus end (84 conversations have choices). First-person ones and InfoLinks play with no input. A frame is 1/30 s of Level time.

**One more start for a refusal.** A conversation the original's code refused in the full pass (a refusal family: the speakers apart, the owner in a state that
cannot converse, the player busy, the owner absent) is started once more in a fresh child holding only the refused ones: the conversations before it in the same
session had moved, alerted or killed a speaker, a refusal of the harness's own history. A run there counts (`validate-conversations-census.mjs`; the 2026-10-23 result
merged its full pass with a second run of the 66 conversations that had not run, `census-final-merged.json`). A Play stop or a child that died is never started again, so a rerun cannot hide one. The flags a conversation needs are set for its start
only: each one's state before is put back after the attempt unless the conversation changed it itself.

**What "ran" means.** The conversation was on the screen (`conPlay`/`dataLinkPlay` with it as `startCon`) and ended with its `<name>_Played` flag set (`TerminateConversation`;
an `AbortConversation(True)` ends one without it, which is how a start the original refused shows), or ended in a cinematic hand-over (state Interpolating). 4,729
events and about 9,860 s of conversation time ran in the final pass.

## Result (cold pass, `.work/census-final-merged.json`)

1,520 ran (all 398 InfoLinks, 374 talks, 748 first-person), 102 are named boundaries, 0 stop. By mission (ran / boundaries): 00 82/4, 01 106/4, 02 180/13, 03 166/21,
04 125/11, 05 55/6, 06 278/18, 08 45/5, 09 52/6, 10 168/6, 11 70/1, 12 64/2, 14 51/2, 15 78/3.

## Result (second pass, the real slots, 2026-10-24)

The latest slot of each map (34 slots of `.work/internet-saves`, missions 1 to 6, 8 to 10, 12, 14 and 15), loaded as the Load Game screen loads it, each map's own
conversations started as in the cold pass: 823 conversations, 777 ran, 29 refused by the original's code in the slot's state (a once conversation played, an owner hostile,
dead or busy), 17 whose owner the played game no longer has (no actor in the level carries the BindName: the Hong Kong market brawl's fighters, Walton Simons in the
bunker, the MiB of Area 51), 0 stops. By mission (ran / refused / owner gone): 01 52/1/0, 02 68/0/10, 03 58/3/0, 04 44/0/0, 05 51/7/0, 06 153/8/3, 08 17/1/0, 09 34/1/1,
10 98/5/0, 12 47/0/0, 14 51/1/0, 15 104/2/3. Missions 0 and 11 have no slot. The validator judges the slot pass by itself: a run in the cold pass does not hide a stop
from a slot.

The cold pass of the same run: 1,520 ran (6 of them on the second start: two Liberty Island overheard conversations, a subway hostage, Gunther's futz bark, a heli base
troop bark, a catacomb hostage), 102 named boundaries, 0 stops.

## Play stops the census found, and their fixes

1. `ConPlayBase.SetupEventTransferObject` reads `cast<Pawn>(Event.fromActor).FindInventoryType(..)`; an InfoLink whose `fromActor` is a bound non-Pawn (DL_no_carla) made
   the cast null. The original's `execContext` zeroes the call's encoded result width ("Accessed None"), but Play's prepared Context results typed only property receivers
   and stopped with "Unsupported null Context result". A DynamicCast (0x2e) receiver now gives the call's class (`src/runtime/script-context-results.mjs`; commit 6ff485e4).
2. The classes an InfoLink's TransferObject events name (`Image02_NYC_Warehouse`, ...) were prepared only for actor-bound conversations; `ConEventTransferObject.BindActor`'s
   `StaticLoadObject` of an unprepared DeusEx class reached the first-load linker (8 InfoLinks). The preparation loop covers the player's InfoLinks too
   (`src/runtime/script-conplay-live.mjs`; same commit; `validate-datalink-transfer-object`, `validate-conversation-transfer-object-bind` pass).
3. `MoveActor` with a changed rotation, riders and a nonzero Delta under 0.0001 on every axis (a pawn turning a hair with a rider carrying a rider: the Metro's special
   guards) was an explicit "not linked" error in `playerMove`. The DLL (`ULevel::MoveActor`, Unicorn oracle `scripts/native-set-rotation-riders-oracle.py`, new case
   `tiny-nonzero-delta-changed-rotation-with-rider` in `validate-native-set-rotation-riders`) runs the rider pass and moves the source by exactly that Delta (no line check);
   `moveQuery`'s tiny gate gave zero. `playerMove` now uses the requested Delta as FinalDelta in that case; position, rotation, the rider call's arguments, the hash and zone
   order and the encroachment calls equal the DLL's. The 51 movement unit tests pass; `SpecialGuardsChatting` no longer stops (it now refuses at `CheckActorDistances`, a named boundary).

4. **A conversation's item meshes** (slot pass, `DefoeConvos` from Save0025, its second option): the weapon mod a choice hands over runs a mesh native in its own frames,
   and nothing had prepared `deusexitems.weaponmod` in that level (`Original mesh resource is not prepared`). The conversation player prepared the TransferObject classes'
   code only; it now prepares their item meshes too (Mesh, PlayerViewMesh, PickupViewMesh, ThirdPersonMesh, as a carried item's at a travel arrival:
   `src/runtime/script-conplay-live.mjs`, `prepareItemViewMeshes` of `script-doors.mjs`).
5. **Harness, not Play: a requirement leaked into the next conversations.** `HeliosFree`, set so that `DL_Final_Helios07` could start, stayed set; `MeetHelios`'s approach
   later put the player inside Final's `FlagTrigger3`, which fired `Merge_helios_exit` and left for `99_Endgame2` (cold and slot passes). The flags the harness sets
   are put back after each conversation (`census-conversations-child.mjs` `restoreRequired`).
6. **Harness, not Play: dropped sessions stayed alive.** A slot level is reopened for each retry (`game.reset()` refuses a restored level), and every dropped
   session kept about 425 MB: the process-wide handle table (`script-object-handles.mjs`) is the strong reference to a runtime's objects until its range is released,
   which only the page's map host did (`sim-host.mjs` dispose). `02_NYC_Street@Save4` and `05_NYC_UNATCOMJ12lab@Save13` ran out of the 7 GB heap. The headless session
   now has the same `dispose(end)` (`census-stage5-session.mjs`: audio, simulation session, handle range, image arena listeners), the child disposes of a replaced
   session and turns the event loop after each conversation (a `WeakRef` dereferenced in a job keeps its target until the job ends: the heap snapshot's retainer path
   was `weak_refs_keep_during_job -> RustScriptVm -> ScriptRuntime`). Freed levels go a collection or two late (a FinalizationRegistry's held values wait for its
   cleanup task), so a run of retries can still hold several; a child keeps the 7 GB cap and the census runs 4 jobs on the 30 GB host.

## Observations, not fixed

* **PHYS_Interpolating leaves the player's collision-hash registration at the old Location.** After a conversation hands the player to a camera path (Jock's helicopter in
  the Metro, `JockReady`), a later `RemoveActor` of the player throws "Remove actor before changing its registered location", and once the fixture has registered a player
  without collision, the next `SetCollision(true)` throws "Actor is already registered (JCDentonMale0)". Deterministic: `CC_HASHCHECK=2 node scripts/census-conversations.mjs
  --child 10_Paris_Metro --only JockReady` prints the first frame the player is stale (state Interpolating); the harness restarts the level after a cinematic and after a player
  without collision. Whether the original's `physPathing` MoveActor keeps the hash current for the player is not checked (the level normally ends in the cinematic).
* **A restored level's speaking decoration** (`PlaySound 264` for NYPoliceBoat0 and BlackHelicopter0 of a loaded save, missions 1 and 3, seen on 2026-10-23) no longer
  stops: the placed-chain work's restored-object sound index (commit 7c96b145, docs/travel.md Unresolved 10, unverified as a value) is on master.
* `collision-hash.mjs` now names the actor in "Actor is already registered".

## The named boundaries (`scripts/census-conversations-boundaries.mjs`)

Not Play stops: the original's own code or data refuses the start, and Play runs that code. **data** (the census finds the same family every run): 52 conversations
whose owner is the BindName or BarkBindName of no actor in the mission's maps (the owner exists in other missions' maps only, or in none), 2 of them excluded by the native
bind gate (`Disgruntled_Guy_Final_Barks`, `Canal_Pilot_Barks`: BarkBindName set and `_Bark` in the name; ConSys `BindConversations` 10010b70), 7 whose speaker has no actor in the
map (`Conversation.CheckActors`). **state** (any refusal accepted, the pawns' reactions vary): speakers more than 300 units apart (20, `CheckActorDistances`), the owner
Attacking/Alerting/Fleeing/Dying/TakingHit/Paralyzed or Idle by its authored Orders (`ScriptedPawn.CanConverse`), the player unable to start one. Several of the 20 are
`...Hack` conversations whose requirement flag (`AlwaysFalse`, `NeverTrue`) nothing sets.

## Left open

* The census is Play against itself (evidence class P): it finds stops, not differences; the placed chains (rows 6.4.\*.1) compare the required conversations with the
  original. A refusal accepted in a slot's state, or on the second start, is the original's own code answering in Play; whether the original refuses the same ones in
  the same states is not measured.
* Only the latest slot of each map is loaded (`--all-slots` takes the 41); missions 0 and 11 have none.
