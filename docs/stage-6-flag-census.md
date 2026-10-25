# Stage 6 carried-flag census: both sides of each carried flag where a later mission reads it

Rows 6.4.NN.2 of [the exit criteria](stage-6-exit-criteria.md) (missions 1, 2, 3, 4, 5, 8, 10 and 11): *both sides of each of its N carried flags, checked
where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original.* The 37 carried flags
are the inventory's ([the choices with lasting consequences](stage-6-inventory.md#the-choices-with-lasting-consequences-across-missions); `PlayerMetFilben`
counts for mission 1 and for mission 3). This note is the census's design on [the chain harness](stage-6-chains.md), its table and what Play does with it
(2026-10-25). **Nothing here is compared with the original yet**: every unit's Wine capture is the next step, and no row changes status before it.

## How a flag is checked

`scripts/stage6-flag-census.mjs` holds one table (the flags, their readers, the units) and generates every unit's chain file; the drivers run them unchanged.

* **A unit** is a short chain (`.work/chains/census/<unit>.mjs`, mission `c<NN>-<flag>-<side>`, NN the reading mission) that starts from its **base save**
  and brings the reader. The base is made in Play: a chain's pinned save (`.work/chains/exits/m<NN>/exit`, the previous mission's exit), the reading mission's
  own chain steps up to the reader's map, unchanged (the *prefix*), then the unit's flags written into the player's FlagBase and the console's `SaveGame`; it is
  pinned at `.work/chains/exits/census/<unit>/Save0NNN` (201 and up: no chain uses them) and both programs load it (`start` with `source: 'census'`). The
  chains already show that the original loads Play's saves taken at a mission's arrival; a base taken after a prefix (in the middle of a mission, with the
  mission's other levels filed) is new and unverified until the first capture.
* **What is written.** The census's flag with the expiration its setter gives it (a conversation's `SetFlag`: 0, `ConPlayBase.SetFlag`; a script's `SetBool`:
  its fourth argument; a `FlagTrigger`: its `flagExpiration`), and the other flags **the same setter branch** sets with it (the inventory's conversation data,
  `setFlags` by branch): `FilbenGaveKey` comes with `M01PlayerMetFilben` and `PlayerMetFilben` (MeetFilben's main branch), Lebedev's killer with
  `JuanLebedev_Dead`, `M03PlayerKilledAnna` with `AnnaNavarre_Dead`, `M02QuestionedGreen` with `MeetJoeGreen_Played` (MeetJoeGreen2 needs it), `GuntherRespectsPlayer`
  with `GuntherFreed`, `KnowsGuntherKillphrase` with `KnowsAboutKillphrase`. Goals, notes, items, credits and skill points the setter would give stay as the
  line has them: **a deviation** (only flags differ).
* **Sides.** The line's side is what the chain line holds at the reader, read from the bases' manifests (`.work/chains/census/bases/<family>.json`: the
  flags of each base when it was saved) and, for missions 1 to 4, the original's own chain captures. On the New Game line only `EscapeSuccessful` (1,
  expiration 7, until mission 8's entry deletes it) and `JacobsonRecruited` (1, from mission 5) of the 37 are set; `PlayerMetFilben` is set again by mission 8's
  own conversation. **Missions 14 and 15 changed under the census**: chain 12 first started from the real slot nicouzouf Save0028, so Save0112 and Save0114 as
  pinned on 2026-10-24 carried that player's flags (`AmbrosiaTagged`, `FilbenGaveKey`, `M04MetWalton`, `M11MetWalton`, `GuntherRespectsPlayer` 0, `Ray_Dead`,
  ...); the lead pinned both again from the New Game line on 2026-10-25 (none of those, Ray alive), the families of missions 14 and 15 were rebuilt from
  them, and their units write both sides of each flag explicitly. A missing flag reads as false (`XFlagBase::GetBool`), the same branch as a setter's
  explicit 0, so the census's other side is the setter's 1, or the flag taken away where the line has it set.
* **When the line's side needs a unit.** A reader on a chain has the line's capture as its other side (ManderleyDebriefing02, AnnaEntrance, DL_SeeManderley,
  ManderleyDebriefing03, TongSick, JockArea51). A reader off the chains, or a script reader whose pawn no chain step reads, has a `line` unit: the same base
  with no flag changed. Where the reader tests the flag only after another flag of the same setter, the other side is that unit (`against` in the table).
* **What is compared** (validate-stage6-chain.mjs, as for the chains): the flags at every snapshot (one after each reader block), the travel text of the
  map change after the reader (its conversation history: every conversation except `<Owner>_Bark*` and replays enters ConHistory,
  `ConPlayBase.SetupHistory`, so the branch played is in it), and for a mission script's reader the `state` of the pawn it acts on (`presence`, `bHidden`,
  `bInWorld`).
* **Families.** Units that share a prefix and steps form a family; one Play run of the prefix saves all its bases (each unit's flags written, `SaveGame` with
  no frame between, the flags put back; the line's base first, a base that deletes a flag last). A family's steps run every reader block of the family (a
  unit drops a block whose owner its flag keeps out of the world), so a unit for one flag also runs the family's other readers with the line's state.
* **Placements.** A reader on a chain is reached by that chain's own steps. A reader off the chains is reached by `placeNear` (each program reads the owner's
  place; the player is put `distance` units from it, aimed at it, ghosted until the last line), by the owner's radius, or by the right button through
  `frobNear` (placed again until the view selects the owner: Filben and Alex wander, Jaime walks to his seat); a first-person conversation is waited for by its
  `_Played` flag (no key: the chain's Enter is the fire key), a DataLink by the fall into its trigger.

```bash
node scripts/stage6-flag-census.mjs --list            # the table, from the script
node scripts/stage6-flag-census.mjs --table           # the table below, with what Play did
node scripts/stage6-flag-census.mjs --play [unit|family|a,b] [--rebuild]   # Linux host: bases when missing, unit files, each unit in Play (a child each)
node scripts/stage6-flag-census.mjs --report [unit|family]   # each unit against its other side: flags, states, traces, histories (owner, events, a hash)
node scripts/chain-original.mjs --file .work/chains/census/<unit>.mjs          # the original under Wine (the Wine lock): .work/chains/m<unit>/
node scripts/validate-stage6-chain.mjs --file .work/chains/census/<unit>.mjs   # Play against that capture
```

Harness additions this needed (each separate and small): `chain-lib.mjs` `slotDirectory` takes `source: 'census'`, `STATE_FIELDS` names `bDeleteMe` (0x28
mask 0x80) and `bInWorld` (0x910 mask 0x800; `chain-offsets.mjs`); the `state` op's `presence` and a `frobNear` op in `chain-play.mjs` and
`chain-original.mjs` (the original's presence takes the object of that name in the player's `XLevel` with `bDeleteMe` clear: a destroyed actor stays in
GObjObjects until the next purge); `validate-stage6-chain.mjs --file` without `--mission` takes the chain's own mission (the capture directory follows:
`.work/chains/m<unit>/`).

## The table

One row per flag and reading mission (`--table`; the setters with their value and expiration, the line's side, the reader run and its units with what Play
did; a unit's side `line` is the base with no flag written). 66 units in 17 families, bases at `.work/chains/exits/census/<unit>/Save0201` to `Save0266`.

| Flag (row) | Setters (value, expiration) | The line | Read in | Reader run | Units (side): Play |
| --- | --- | --- | --- | --- | --- |
| `BathroomBarks_Played` (6.4.01.2) | BathroomBarks SetFlag (1, never) | absent (BathroomBarks not on the chain) | 03 | M03ShannonBarks (? BathroomBarks_Played -> Fresh) | `c03-BathroomBarks_Played-1` (1): runs<br>`c03-hq-line` (line): runs |
| `BathroomBarks_Played` (6.4.01.2) | BathroomBarks SetFlag (1, never) | absent (BathroomBarks not on the chain) | 04 | M04ShannonBarks (? BathroomBarks_Played -> StillPissed) | `c04-BathroomBarks_Played-1` (1): runs<br>`c04-island-hq-line` (line): runs |
| `FilbenGaveKey` (6.4.01.2) | MeetFilben@GetKeyB (1, never), @NoKeyB (0, never) | absent (MeetFilben not on the chain; absent reads as false: XFlagBase::GetBool) | 03 | M03MeetFilben (NotAggressive: ? !FilbenGaveKey -> NoKey1; only after a first meeting) | `c03-FilbenGaveKey-1` (1): runs<br>`c03-batterypark-line` (line): runs |
| `GuntherFreed` (6.4.01.2) | 01_NYC_UNATCOIsland/FlagTrigger2 (1, mission 12) | absent | 11 | M11MeetGunther (? !GuntherFreed -> NotRescued; ? GuntherFreed & !GuntherRespectsPlayer -> PlayerRefusedToArmGunther) | `c11-GuntherFreed-1` (1): runs<br>`c11-cathedral-line` (line): runs |
| `GuntherRespectsPlayer` (6.4.01.2) | GuntherRescued@GiveSpeech (1), @GiveNothingNicely (1), @GiveNothing (0), all never; GuntherRescued needs GuntherFreed | absent | 02 | none: GuntherHermann_BarkFutz only: an AI bark (<Owner>_Bark*: the bark manager starts it, no ConHistory) | - |
| `GuntherRespectsPlayer` (6.4.01.2) | GuntherRescued@GiveSpeech (1), @GiveNothingNicely (1), @GiveNothing (0), all never; GuntherRescued needs GuntherFreed | absent | 03 | none: GuntherHermann_BarkFutz (an AI bark); TroopBarks2 requires NeverTrue (set nowhere) | - |
| `GuntherRespectsPlayer` (6.4.01.2) | GuntherRescued@GiveSpeech (1), @GiveNothingNicely (1), @GiveNothing (0), all never; GuntherRescued needs GuntherFreed | absent | 11 | M11MeetGunther | `c11-GuntherRespectsPlayer-1` (1): runs<br>`c11-cathedral-line` (line): runs |
| `M01PlayerAggressive` (6.4.01.2) | Mission01.Timer:91 (1, mission 6) | absent | 02 | PaulLeaving (needs PaulGaveGrenades: PaulBarricade first; A1: ? M01PlayerAggressive -> aggressive) | `c02-M01PlayerAggressive-1` (1): runs<br>`c02-street-line` (line): runs |
| `M01PlayerAggressive` (6.4.01.2) | Mission01.Timer:91 (1, mission 6) | absent | 03 | none: TroopBarks1 and TroopBarks2 require NeverTrue (set nowhere): no reader can start | - |
| `M01PlayerMetFilben` (6.4.01.2) | MeetFilbenAfterStatue, MeetFilben (main) (1, never; both set PlayerMetFilben too) | absent | 03 | M03MeetFilben (? !M01PlayerMetFilben & !PlayerMetFilben -> FirstMeeting) | `c03-M01PlayerMetFilben-1` (1): runs<br>`c03-batterypark-line` (line): runs |
| `PlayerMetFilben` (6.4.01.2) | MeetFilbenAfterStatue, MeetFilben (main) (1, never) | absent | 04 | M04MeetFilben (A1: ? PlayerMetFilben -> KnowsFilben) | `c04-PlayerMetFilben-1` (1): runs<br>`c04-bar-line` (line): runs |
| `AmbrosiaTagged` (6.4.02.2) | DL_AmbrosiaFound (1, never); 02_NYC_BatteryPark/FlagTrigger1 (1, mission 6) | absent | 03 | ManderleyDebriefing02 (? !AmbrosiaTagged -> NotTagged, NotTagged2) | `c03-AmbrosiaTagged-1` (1): runs |
| `BatteryParkSlaughter` (6.4.02.2) | Mission02.Timer:178 (1, mission 6) | absent | 03 | CarterGreeting03 (? BatteryParkSlaughter -> Slaughter) | `c03-BatteryParkSlaughter-1` (1): runs<br>`c03-hq-line` (line): runs |
| `EscapeSuccessful` (6.4.02.2) | 02_NYC_BatteryPark/FlagTrigger7, FlagTrigger8 (1, mission 7) | 1, expiration 7 (the chain's subway) | 03 | ManderleyDebriefing02 (? EscapeSuccessful & hostages alive -> Rescue) | `c03-EscapeSuccessful-absent` (absent): runs |
| `FordSchickRescued` (6.4.02.2) | Mission02.PreTravel:122 (1, mission 9; needs MS_FordFollowing, which nothing sets: the side 1 is not reachable from the data) | absent (the only side the data can give) | 03 | none: SmugglerThanks, MeetSmuggler, SckickThanks, FordBarks: their owners (the Smuggler, Ford) are in no map of mission 3 | - |
| `FordSchickRescued` (6.4.02.2) | Mission02.PreTravel:122 (1, mission 9; needs MS_FordFollowing, which nothing sets: the side 1 is not reachable from the data) | absent (the only side the data can give) | 04 | none: M04MeetSmuggler (04_NYC_Smug, off the chain, 14 choices): the side 1 cannot be set by the data | - |
| `FordSchickRescued` (6.4.02.2) | Mission02.PreTravel:122 (1, mission 9; needs MS_FordFollowing, which nothing sets: the side 1 is not reachable from the data) | absent (the only side the data can give) | 08 | Mission08.FirstFrame:28 (08_NYC_Smug: Ford enters the world) | `c08-FordSchickRescued-1` (1): runs<br>`c08-smug-line` (line): runs |
| `FordSchickRescueDone` (6.4.02.2) | Mission02.Timer:439 (1, mission 9) | absent | 03 | none: SmugglerWaiting and SmugglerThanks (the only readers) belong to the Smuggler, in no map of mission 3 | - |
| `HeardGrenadeTalk` (6.4.02.2) | UNATCOGrenade1Meet (main) (1, never) | absent | 03 | ManderleyDebriefing02 (resume2: ? HeardGrenadeTalk -> Grenades) | `c03-HeardGrenadeTalk-1` (1): runs |
| `KnowsOfJoJo` (6.4.02.2) | CounselWorker@Curious, MeetSandraRenton@CResume (1, never) | absent | 03 | ManderleyDebriefing02 (ReturnFromInterrupted: ? KnowsOfJoJo -> KnowsJoJo) | `c03-KnowsOfJoJo-1` (1): runs |
| `M02MechSlur` (6.4.02.2) | AnnaThanks@Cocky (1), @TeamPlayer (0), never | absent | 03 | AnnaEntrance (on the chain; its ? M02MechSlur follows ? !AnnaThanks_Played -> NoComment2, and AnnaThanks_Played has the default expiration 3: deleted at mission 3's entry, so the branch is unreachable) | `c03-M02MechSlur-1` (1): runs |
| `M02QuestionedGreen` (6.4.02.2) | MeetJoeGreen2@GreenQuestioned (1, never; needs MeetJoeGreen_Played) | absent | 03 | ManderleyDebriefing02 (bye: ? M02QuestionedGreen -> TalkedToPress) | `c03-M02QuestionedGreen-1` (1): runs |
| `M02QuestionedGreen` (6.4.02.2) | MeetJoeGreen2@GreenQuestioned (1, never; needs MeetJoeGreen_Played) | absent | 04 | M04MeetJoeGreen (DeadContinue: ? M02QuestionedGreen -> GotChewedOut; after ? !MeetJoeGreen_Played -> FirstMeeting) | `c04-M02QuestionedGreen-1` (1): runs<br>`c04-bar-line` (line): runs |
| `M02ViolenceInBar` (6.4.02.2) | Mission02.Timer:416 (1, mission 4) | absent | 03 | ManderleyDebriefing02 (bye, TalkedToPress: ? M02ViolenceInBar -> Violence) | `c03-M02ViolenceInBar-1` (1): runs |
| `MeetJoeGreen_Played` (6.4.02.2) | MeetJoeGreen (main) SetFlag (1, never; the _Played flag exists before ConPlayBase.SetPlayedFlag) | absent | 04 | M04MeetJoeGreen (? !MeetJoeGreen_Played -> FirstMeeting) | `c04-MeetJoeGreen_Played-1` (1): runs<br>`c04-bar-line` (line): runs |
| `SubTerroristsDead` (6.4.02.2) | Mission02.Timer:196 (1, mission 6) | absent | 03 | ManderleyDebriefing02 (? SubTerroristsDead & hostages alive -> Rescue, after the same check of EscapeSuccessful: the line's EscapeSuccessful hides it) | `c03-SubTerroristsDead-1` (1): runs<br>`c03-SubTerroristsDead-1-noescape` (1): runs<br>`c03-EscapeSuccessful-absent` (absent): runs |
| `TenderloinSlaughter` (6.4.02.2) | Mission02.Timer:285 (1, mission 6) | absent | 03 | ManderleyDebriefing02 (resume2: ? TenderloinSlaughter -> Slaughter) | `c03-TenderloinSlaughter-1` (1): runs |
| `AnnaKilledLebedev` (6.4.03.2) | Mission03.Timer:312 (1, mission 6; Lebedev's carcass killed by Anna: JuanLebedev_Dead by ScriptedPawn.Died) | absent (Lebedev lives on the chain) | 04 | M04LloydBarks (A1: ? AnnaKilledLebedev -> Dead) | `c04-AnnaKilledLebedev-1` (1): runs<br>`c04-island-hq-line` (line): runs |
| `M03PlayerKilledAnna` (6.4.03.2) | DL_AlexShocked (1, never; started once AnnaNavarre_Dead) | absent | 04 | ManderleyDebriefing03 (on the chain; ? M03PlayerKilledAnna -> KilledAnna) | `c04-M03PlayerKilledAnna-1` (1): runs |
| `PlayerKilledLebedev` (6.4.03.2) | Mission03.Timer:309, :322 (1, mission 6) | absent | 04 | DL_SeeManderley and ManderleyDebriefing03 (both on the chain, in one unit) | `c04-PlayerKilledLebedev-1` (1): runs |
| `PlayerMetFilben` (6.4.03.2) | M03MeetFilben@FirstMeeting (1, never) | absent | 04 | M04MeetFilben | `c04-PlayerMetFilben-1-m03` (1): runs<br>`c04-bar-line` (line): runs |
| `SimonsAssassination` (6.4.03.2) | SimonsBarks@A4 (1, never) | absent (both lines of mission 14) | 14 | DL_Simons2 (14_OceanLab_Lab/DataLinkTrigger6, needs schematic_downloaded; ? SimonsAssassination -> Assassination) | `c14-SimonsAssassination-1` (1): runs<br>`c14-SimonsAssassination-absent` (absent): runs<br>`c14-lab-line` (line): runs |
| `M04MetWalton` (6.4.04.2) | M04MeetWalton (main) (1, never) | absent on the New Game line; 1 on the first line of missions 14 and 15 (the real slot chain 12 first started from); both sides written | 14 | WaltonShowdown (? !M04MetWalton -> try2) | `c14-M04MetWalton-1` (1): runs<br>`c14-M04MetWalton-absent` (absent): runs<br>`c14-lab-line` (line): runs |
| `PlayerBailedOutWindow` (6.4.04.2) | 04_NYC_Hotel/FlagTrigger9 (1, mission 6) | absent | 05 | Mission05.FirstFrame:37 (05_NYC_UNATCOMJ12LAB: Paul destroyed) | `c05-PlayerBailedOutWindow-1` (1): runs<br>`c05-lab-line` (line): runs |
| `SandraWentToCalifornia` (6.4.04.2) | SandraAttackedByJoJoThanks, FamilySquabbleWrapUpGilbertDead (main), FamilySquabbleWrapUp@Hop (1, never) | absent | 08 | Mission08.FirstFrame:19 (Sandra destroyed in every map) | `c08-SandraWentToCalifornia-1` (1): runs<br>`c08-bar-line` (line): runs |
| `SandraWentToCalifornia` (6.4.04.2) | SandraAttackedByJoJoThanks, FamilySquabbleWrapUpGilbertDead (main), FamilySquabbleWrapUp@Hop (1, never) | absent | 12 | Mission12.FirstFrame:37 (12_VANDENBERG_GAS: Sandra enters the world) | `c12-SandraWentToCalifornia-1` (1): no base (step 65: conversation PageHostageBriefing: not over after 300s)<br>`c12-cmd-line` (line): no base (step 65: conversation PageHostageBriefing: not over after 300s) |
| `JacobsonRecruited` (6.4.05.2) | M05MeetAlexJacobson (main) (1, never) | 1 (the chain's M05MeetAlexJacobson) | 06 | Mission06.FirstFrame:86 (06_HONGKONG_TONGBASE: Alex enters the world) | `c06-JacobsonRecruited-absent` (absent): runs<br>`c06-tongbase-line` (line): runs |
| `JaimeRecruited` (6.4.05.2) | M05MeetJaime@Recruit (1, never) | absent | 06 | M06MeetAlexJacobson (? JaimeRecruited -> Recruited) | `c06-JaimeRecruited-1` (1): runs<br>`c06-tongbase-line` (line): runs |
| `JaimeRecruited` (6.4.05.2) | M05MeetJaime@Recruit (1, never) | absent | 10 | Mission10.FirstFrame:31 (10_PARIS_METRO: Jaime enters unless recruited) and DL_metrosewer (? !JaimeRecruited -> Jaime) | `c10-JaimeRecruited-1` (1): runs<br>`c10-metro-line` (line): runs |
| `KnowsAboutKillphrase` (6.4.05.2) | PaulInMedLab@Killphrase (1, never) | absent | 10 | M10MeetJaime (? KnowsAboutKillphrase -> Knows: sets KnowsGuntherKillphrase) | `c10-KnowsAboutKillphrase-1` (1): runs<br>`c10-metro-line` (line): runs |
| `GreenKnowsAboutDowd` (6.4.08.2) | M08MeetJoeGreen@TellsAboutDowd (1, never) | absent | 09 | none: Mission09.Timer:170 also needs suprisePoint (set nowhere) and acts on MJ12Commandos tagged paratroop (no map has one): no observable on either side | - |
| `HelpSailor` (6.4.08.2) | M08MeetSailor@GetPass (1, never) | absent | 09 | MeetFrontGuard (? HelpSailor & !Sailor_Dead -> Friendly) | `c09-HelpSailor-1` (1): runs<br>`c09-dockyard-line` (line): runs |
| `M08WarnedSmuggler` (6.4.08.2) | M08SmugglerConvos@GiveWarning (1, never) | absent (the chain picks NoWarning) | 09 | DL_BadNews (09_NYC_Dockyard/DataLinkTrigger4; ? M08WarnedSmuggler -> Warned) | `c09-M08WarnedSmuggler-1` (1): runs<br>`c09-dockyard-line` (line): runs |
| `KnowsGuntherKillphrase` (6.4.10.2) | M10MeetJaime@Continue (1, never) | absent | 11 | M11MeetGunther (Continue: ? !KnowsGuntherKillphrase -> NoKillswitch; else the Kill/Gentleman choice) | `c11-KnowsGuntherKillphrase-1` (1): runs<br>`c11-cathedral-line` (line): runs |
| `EverettMechanicComment` (6.4.11.2) | MeetEverett2@RayComment, @deadset (1, never) | absent; Ray_Dead set on the first line of missions 14 and 15 (the real slot's), absent on the New Game line pinned again on 2026-10-25: the units write the flag both ways with Ray alive | 12 | TongSick (on the chain; one CheckFlag of !Ray_Dead and !EverettMechanicComment -> Rattle) | `c12-EverettMechanicComment-1` (1): no base (step 65: conversation PageHostageBriefing: not over after 300s) |
| `EverettMechanicComment` (6.4.11.2) | MeetEverett2@RayComment, @deadset (1, never) | absent; Ray_Dead set on the first line of missions 14 and 15 (the real slot's), absent on the New Game line pinned again on 2026-10-25: the units write the flag both ways with Ray alive | 14 | JockArea51 (on the chain; the same check) | `c14-EverettMechanicComment-1` (1): runs<br>`c14-EverettMechanicComment-absent` (absent): runs<br>`c14-EverettMechanicComment-1-rayalive` (1): runs<br>`c14-EverettMechanicComment-absent-rayalive` (absent): runs |
| `EverettMechanicComment` (6.4.11.2) | MeetEverett2@RayComment, @deadset (1, never) | absent; Ray_Dead set on the first line of missions 14 and 15 (the real slot's), absent on the New Game line pinned again on 2026-10-25: the units write the flag both ways with Ray alive | 15 | M15MeetEverett (the same check -> Dead; Ray dead hides the flag, so the units write Ray alive) | `c15-EverettMechanicComment-1` (1): runs<br>`c15-EverettMechanicComment-absent` (absent): runs<br>`c15-entrance-line` (line): runs<br>`c15-EverettMechanicComment-1-rayalive` (1): runs<br>`c15-EverettMechanicComment-absent-rayalive` (absent): runs |
| `M11MetWalton` (6.4.11.2) | M11WaltonHolo (main) (1, never; needs GuntherHermann_Dead) | absent on the New Game line; 1 on the first line of missions 14 and 15 (the real slot); both sides written | 14 | WaltonShowdown (try2: ? !M11MetWalton -> try3; read only once !M04MetWalton jumped) | `c14-M11MetWalton-1` (1): runs<br>`c14-M11MetWalton-absent` (absent): runs |

## Readers not run, and why

One reader is run per flag and reading mission (the most directly reachable); the others are listed in the table's reader column and here. No reader runs
for these (flag, mission) pairs, by the data:

| Flag | Read in | Why no unit |
| --- | --- | --- |
| `GuntherRespectsPlayer` | 2, 3 | the only readers are `GuntherHermann_BarkFutz`, an AI bark (`<Owner>_Bark*`: the bark manager starts it, it enters no ConHistory), and `TroopBarks2`, which requires `NeverTrue` (set nowhere) |
| `M01PlayerAggressive` | 3 | `TroopBarks1` and `TroopBarks2` require `NeverTrue` |
| `FordSchickRescued` | 3 | `SmugglerThanks`, `MeetSmuggler`, `SckickThanks`, `FordBarks` belong to the Smuggler and Ford, who are in no map of mission 3 |
| `FordSchickRescued` | 4 | `M04MeetSmuggler` (04_NYC_Smug, off the chains, 14 choices) not run: the side 1 cannot come from the data (below); mission 8's script reader is run |
| `FordSchickRescueDone` | 3 | its only readers, `SmugglerWaiting` and `SmugglerThanks`, are the Smuggler's (NYC_Smug, not a map of mission 3) |
| `GreenKnowsAboutDowd` | 9 | `Mission09.Timer:170` also needs `suprisePoint` (set nowhere) and acts on MJ12Commandos tagged `paratroop` (no map has one): neither side can show anything |

Not run because another reader of the same mission is (the table names the one run): `AmbrosiaTagged`'s AnnaManderley1 and AnnaAtUNATCO (CarterGreeting03 runs
in the HQ family with the line's state); `BatteryParkSlaughter`'s CarterBarks (needs M03CarterDone) and AnnaManderley1/2; `EscapeSuccessful`'s and
`SubTerroristsDead`'s AnnaAtUNATCO; `M02MechSlur`'s AnnaAtUNATCO (behind the same expired AnnaThanks_Played); `TenderloinSlaughter`'s CarterGreeting03 and
PrivateLloydBark; `FilbenGaveKey`'s FilbenAngryBarks (needs the commander dead); `M03PlayerKilledAnna`'s GuntherShowdown (AnnaDead2) and CokeTroopBarks;
`PlayerKilledLebedev`'s M04TroopBarks, M04ScottBarks, M04MeetCarter, M04MeetJaime2, CokeTroopBarks and M04MeetAlex (M04LloydBarks runs in its family);
`SandraWentToCalifornia`'s M08MeetSailor, MeetBum_M and BumsOverheard(2); `JaimeRecruited`'s Mission06.FirstFrame:76 (needs Versalife_Done: Tong's base on
the second visit), Base_Guard_MiddleBarks, M07AlexJacobsonBarks and M06AlexJacobsonBarks; `HelpSailor`'s FrontGuardBarks, DoorGuardBarks, CafWorker1Help,
CafWorker1Barks(2) and the two FlagTriggers of 09_NYC_Dockyard and 09_NYC_Ship.

**Blocked in Play: the family `12-cmd`** (`c12-cmd-line`, `c12-EverettMechanicComment-1` through TongSick, `c12-SandraWentToCalifornia-1` through
Mission12.FirstFrame:37 at the gas station). Its base needs the mission 12 chain's prefix up to the return to the command centre, and the committed
`scripts/chains/mission12.mjs` stops there in Play: PageHostageBriefing never starts in 300 s (step 65), twice, from the Save0111 pinned now and from the one
before it. The Play source is the same as the Linux main checkout's (`rsync --checksum` of `src/` shows no difference) and so is the pinned Save0111; the
lead's uncommitted `mission12.mjs` there (it no longer fights the bots) passes PageHostageBriefing in its own run (`.work/chains/logs/m12-play.log`). So it is
the chain file, not Play: `node scripts/stage6-flag-census.mjs --play 12-cmd --rebuild` once that chain is committed. Its unit files exist; the chain's
unnamed `conv` step (TongTrigger, then TongSick) is in them, and `chain-original.mjs`'s conv calls `s.name.toLowerCase()` when it checks a `_Played` flag
between reads, so that step needs a name before the original runs it.

## What Play showed (the reader's observable, unit against its other side)

`--report`: the branch labels a conversation's trace passed, the conversation history of the last map change (owner, event count, a hash of the speeches:
no game text), the states and the flags beyond the written ones. These are Play's own results, the expectation the original's captures will be compared with.

| Read in | Reader | What the flag changes in Play |
| --- | --- | --- |
| 2 | PaulLeaving (after PaulBarricade) | `M01PlayerAggressive`: Paul's other speech (the data's `aggressive` branch; the trace shows no label, the history differs) |
| 3 | ManderleyDebriefing02 | `AmbrosiaTagged` 1: ThankYou instead of NotTagged2; `EscapeSuccessful` absent: NotTagged; `HeardGrenadeTalk`: Grenades; `KnowsOfJoJo`: KnowsJoJo; `TenderloinSlaughter`: Slaughter; `M02QuestionedGreen`: 18 history events instead of 16; `M02ViolenceInBar`: 21; `SubTerroristsDead`: nothing next to the line's `EscapeSuccessful` (the same Rescue jump is taken first), Rescue against NotTagged without it (`-noescape` against `EscapeSuccessful-absent`) |
| 3 | CarterGreeting03 | `BatteryParkSlaughter`: Slaughter (7 events instead of 9); `AmbrosiaTagged` changes it too (SkippedClinton not taken) |
| 3 | M03ShannonBarks | `BathroomBarks_Played`: Shannon's other speech (the data's Fresh branch; the history differs) |
| 3 | M03MeetFilben | the line meets him first (FirstMeeting); `M01PlayerMetFilben` (with `PlayerMetFilben`): NoKey1, 7 events instead of 8; `FilbenGaveKey` (with both): no NoKey1, against the previous unit; the choice is CheapChoices' "not interested" in all three |
| 3 | AnnaEntrance | `M02MechSlur` 1: NoComment2 as on the line, as the data predicts (`AnnaThanks_Played` expired at the mission's entry) |
| 4 | DL_SeeManderley, M04LloydBarks, ManderleyDebriefing03 | `PlayerKilledLebedev`: the InfoLink's other speech, Lloyd's other bark, KilledLebedev (14 events instead of 19); `AnnaKilledLebedev`: Lloyd's other bark; `M03PlayerKilledAnna`: KilledAnna (15) |
| 4 | M04ShannonBarks | `BathroomBarks_Played`: 4 events instead of 1 |
| 4 | M04MeetJoeGreen | `MeetJoeGreen_Played`: NotDead instead of the first meeting (4 events instead of 9); `M02QuestionedGreen` (with it): GotChewedOut (6) |
| 4 | M04MeetFilben | `PlayerMetFilben` (mission 1's or mission 3's setter): his other line |
| 5 | Mission05.FirstFrame | `PlayerBailedOutWindow`: PaulDenton0 destroyed (present 0; the line: present, in the world) |
| 6 | Mission06.FirstFrame:86 | `JacobsonRecruited` absent: AlexJacobson0 present and in the world as on the line. The map does not clear his `bInWorld` (06_HongKong_TongBase: Paul and Jaime start out of the world, Alex does not), so the script's EnterWorld changes nothing: **no observable on either side**, by the data |
| 6 | M06MeetAlexJacobson | `JaimeRecruited`: Recruited (15 events instead of 19) |
| 8 | Mission08.FirstFrame | `SandraWentToCalifornia`: SandraRenton0 destroyed in the bar; `FordSchickRescued`: FordSchick0 enters the world in the lair (`bInWorld` 1 instead of 0) |
| 9 | MeetFrontGuard, DL_BadNews | `HelpSailor`: Friendly (7 events instead of 9); `M08WarnedSmuggler`: the InfoLink's other speech (the data's Warned branch) |
| 10 | Mission10.FirstFrame:31, DL_metrosewer, M10MeetJaime | `JaimeRecruited`: JaimeReyes1 stays out of the world and DL_metrosewer takes its other branch; `KnowsAboutKillphrase`: Knows (and `KnowsGuntherKillphrase` is set) |
| 11 | M11MeetGunther | the line: NotRescued, NoKillswitch (he attacks); `GuntherFreed`: PlayerRefusedToArmGunther; `GuntherRespectsPlayer` (with `GuntherFreed`): neither; `KnowsGuntherKillphrase`: the choice, Kill: `KillGunther`, then `GuntherHermann_Dead` and `MS_GuntherKilled` at every later snapshot |
| 14 | DL_Simons2 | `SimonsAssassination`: the InfoLink's other speech (the data's Assassination branch), both sides written |
| 14 | WaltonShowdown | the line: try3; `M04MetWalton` 1: no jump; `M11MetWalton` 1 with `M04MetWalton` absent: try2 only |
| 14 | JockArea51 | the line (Ray alive): Rattle; `EverettMechanicComment` 1: no Rattle (4 events instead of 6) |
| 15 | M15MeetEverett | `EverettMechanicComment` 1: 10 events instead of 14 (Ray alive on the line) |

Mission 12's two readers (TongSick, Mission12.FirstFrame:37) have no Play result: their family is blocked (above).

## Unverified and open

* **Nothing here is compared with the original yet.** Every unit runs in Play (63 of 66; the 3 others are the blocked family); each needs its Wine
  capture (`chain-original.mjs --file`, then `validate-stage6-chain.mjs --file`) before any row 6.4.NN.2 moves.
* **Mid-mission bases.** Most bases are Play saves taken after a prefix, with the mission's other levels filed in the save; the chains so far showed the
  original loading Play's saves only at a mission's arrival. Unverified until the first capture.
* **Only flags are written.** A setter's goals, notes, items, credits and skill points stay as the line has them: a unit is the reader under the flag, not a
  played route. The Ray-alive units take `Ray_Dead` away (it is a death flag; on the re-pinned line Ray is alive anyway, so they equal their plain twins).
* **No observable by the data** (each still a unit, so the capture confirms it): `JacobsonRecruited` (Alex is in Tong's base either way), `M02MechSlur` in
  mission 3 (AnnaThanks_Played expired), and `SubTerroristsDead` next to the line's `EscapeSuccessful` (its own unit without the escape shows it).
  `GreenKnowsAboutDowd` has no unit (no observable at all).
* **`FordSchickRescued`'s side 1 is a state no play-through reaches** (`MS_FordFollowing` is set nowhere): its unit checks the reader under it anyway.
* **The line moved under the census.** The lead pinned the exits of missions 4 to 14 again while the bases were made (2026-10-25). Each base records the save
  it came from and that save's pin time (`bases/<family>.json`, `from.pinnedAt`); a base stays valid (both programs load the base itself), and `--play
  <family> --rebuild` makes it again from the current line. Missions 14 and 15 first came from the real slot nicouzouf Save0028 (chain 12's provisional
  start: Walton's two flags and `Ray_Dead` set); their families were rebuilt from the New Game line, and their units write both sides explicitly, so they do
  not depend on which line is pinned. The lead's uncommitted chain changes of missions 4, 5, 6 and 12 on the main checkout are not in these units (they use
  the committed chains: the prefixes and the steps are spans of them by label).
* **A family's bases can come from more than one prefix run** (`03-hq`: `c03-AmbrosiaTagged-1` from the first run, whose base chain typed the cheat lines
  and waited 3 s before the prefix, ten from the second, the no-escape unit from a third). Each base is valid on its own, but `--report`'s comparison of two
  units assumes their bases differ only by the written flags; the manifests record the source save's pin time, not the prefix run. The reports show no
  difference beyond the flags' readers.
* **Placements are harness steps.** `frobNear` may need a different number of tries in each program (a wandering owner); a radius conversation placed
  `placeNear` from a pawn that moves (the front guard patrols, Filben wanders in the bar) depends on where each program has it.
* **Flag spellings** are the setters' (the conversation and script sources); both programs resolve them through their own FName tables on load (unverified
  for these names, as for the chains: [the chains' finding 2](stage-6-chains.md#what-the-chains-found)).
