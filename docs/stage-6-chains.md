# Stage 6 chains: a mission's required chain, each step placed, in Play and under Wine

Rows 6.4.NN.1 of [the exit criteria](stage-6-exit-criteria.md): *the mission's required chain ([the inventory's "Progression path"](stage-6-inventory.md)), each step placed, runs in
Play from the arrival to the exit, and the flags, goals, notes and travel text at the exit equal the original's under Wine from the same start.* This note is the harness every
mission row reuses, what the two missions run with it so far (0 and 1), and what each found.

## The step format

A chain is a list of steps in `scripts/chains/mission<NN>.mjs` (data, no game text: positions, names of actors and flags, the labels a choice's branch jumps to). Two drivers read the
same file and write the same result:

| Driver | Runs | How |
| --- | --- | --- |
| `scripts/chain-play.mjs` | Play's headless session (`openSession`, as the transition and New Game validators), one session per map | the menu driver for the start, key presses through the root window and the bindings (`pressKey`: the root window is offered the key first, as XInputExt::Process does), console lines as the original's console takes them (`typeLine`: the T key goes to the root window first, so a conversation swallows a line as it does in the original), Level time passing |
| `scripts/chain-original.mjs` | the installed DeusEx.exe under Wine | `scripts/travel-probe.sh` in `follow` mode (it takes the Wine lock, launches the game, restores `Save/` and quits it), then the steps through `scripts/travel-step.sh` (dxinput's clicks, keys and held keys, typed console lines) and the dump tools (`tools/dump-actor-win.c`, `dump-flags-win.c`, `dump-travel-win.c`, `dump-gobjects-win.c`), read **between** steps so each step knows when it took effect (a map change, a flag, a conversation's current event) |

The ops (`scripts/chain-lib.mjs` documents them):

| Op | Meaning |
| --- | --- |
| `start` | `menu-training` (the logo map, Escape, the Training button), `new-game` (New Game, a difficulty, Start Game, the intro left by Escape, as travel step 2 measured), `open` (the console's `LocalTravel <map>`, for probes) |
| `place` | **a labelled harness step**: `ghost`, `set Location`, `walk`, `set ViewRotation` (the lines Stage 5's captures type). `drop: true` puts the player above a Teleporter's or exit's cylinder with the view set first: a placement inside a cylinder raises no Touch, the fall into it does |
| `walk` | the forward key held for N seconds (the original's through the Wine input queue: Stage 5 "Held keys") |
| `frob`, `click`, `belt`, `key`, `line` | the right button (`ParseRightClick`, what `RightMouse` is bound to), the left button (Enter), `ActivateBelt n`, key presses, any console line |
| `conv` | a conversation played **as it comes** (no key skips a speech: a skip races the choice that follows); the listed choices are picked when the current event is a `ConEventChoice` (ArrowDown by index, Enter), by the label the branch jumps to |
| `wait` | Level seconds in Play, real seconds under Wine, or until a flag is (not) set |
| `travel` | the map change a step caused; the arrival is awaited and the travel text it exported is the leg's |
| `snap` | the flags (name, type, expiration, value, the default expiration) |
| `gobjects`, `report` | the original's object table, and a place (not compared) |

`scripts/chain-plan.mjs` finds the placements in Play's world so that both programs are given the same numbers: `approach` (a held forward key reaches an actor's cylinder), `drop`
(a fall into it), `stand` (a place at a distance from an NPC with a clear line, landed first and aimed from the landed eye), `face` (the view trace selects the actor). NPCs with
Sitting or Wandering orders walk to their places first: `stand` settles 900 frames before it measures them.

## Running

```bash
# once per checkout: the dump tools are not in Git (ad/build is ignored). tools/dump-travel-win.exe is the one the Linux host did not have:
i686-w64-mingw32-gcc -O2 -o ad/build/dump-travel-win.exe tools/dump-travel-win.c -lpsapi
# (dump-actor-win, dump-flags-win, dump-gobjects-win and dxinput.exe are built the same way, ad/README.md)

node scripts/chain-original.mjs --mission 00        # the original under Wine (the Wine lock, minutes); writes .work/chains/m00/ (outside Git: it holds the game's texts)
node scripts/chain-play.mjs --mission 00             # Play alone, printing every step
node scripts/validate-stage6-chain.mjs --mission 00  # Play against the stored capture: PASS/FAIL (SKIP without the capture)
node scripts/validate-stage6-chain.mjs --mission 00 --capture   # capture first
node scripts/chain-plan.mjs stand 01_NYC_UNATCOHQ SamCarter0 --distances 70 --lift 15
```

## What is compared

At every `snap` the flags (equal as sets of `name|type|expiration|value`, and the default expiration), and for every map change the **travel text** the leg exported, after the
travel step's normalization (pointers by first appearance, instance numbers, and the two frame-time properties' values): the flags with their expirations, the goals, the notes, the
inventory with its ammo and belt positions, the skills, the conversation history, everything the original carries into the next map. The original's text is the TravelInfo the next
level kept (`dump-travel-win`), found through the player's own `XLevel` (a level object that is still in memory from an earlier visit is not mistaken for the arrival).
