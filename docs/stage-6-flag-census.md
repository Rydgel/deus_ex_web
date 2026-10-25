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
  own conversation. **Missions 14 and 15 are different**: chain 12 started provisionally from the real slot nicouzouf Save0028, so the pinned Save0112 and
  Save0114 (2026-10-24) carry that player's flags (`AmbrosiaTagged`, `FilbenGaveKey`, `M04MetWalton`, `M11MetWalton`, `GuntherRespectsPlayer` 0, `Ray_Dead`, ...);
  their units are written against that line. A missing flag reads as false (`XFlagBase::GetBool`), the same branch as a setter's explicit 0, so the census's
  other side is the setter's 1, or the flag taken away where the line has it set.
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

TABLE

## Readers not run, and why

NOT_RUN

## What Play showed (the reader's observable, unit against its other side)

FINDINGS

## Unverified and open

OPEN
