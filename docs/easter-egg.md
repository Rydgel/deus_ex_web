# The ?easter=1 mod

An opt-in extra for Play, designed with the user. It is **not** part of the faithful reimplementation and changes nothing when off: add
`?easter=1` to the page and, on **10_Paris_Club**, two extra people stand at the bar. **Claudia** sits on a wooden crate and **Rydgel**
leans on the counter beside her (they are teammates who built the place; the names live in `src/viewer/easter-config.mjs`, one place,
and are the pawns' own `FamiliarName`/`UnfamiliarName`, so the original HUD shows them over the target brackets). Right-click either
one and the original HUD log shows their line; the other answers about 1.6 s later.

## What it touches (each hook is a no-op without the flag)

| Where | Change |
|---|---|
| `src/viewer/main.mjs` | `applyEaster()` (called first in `applyStartCheats`, i.e. after every Player start) reads `?easter=1` and, only then, imports `easter-page.mjs`; `deusExViewer.easterProbe(args)`, a validation probe like `viewProbe` |
| `src/viewer/sim-worker.mjs` | one `call` method, `easter`, that imports `easter-sim.mjs` on demand |
| `src/viewer/actor-mesh-draw.mjs` | after a face group's skin is decoded, `easterSkins.current` (null unless the mod registered) may swap the decoded skin; the await sequence of the stock path is unchanged |

Everything else is new and in its own modules: `easter-config.mjs` (names, classes, place, lines), `easter-sim.mjs` (spawning and the
frob and reply hooks, simulation side), `easter-page.mjs` (page side start), `easter-skins.mjs` (the registry the draw asks),
`easter-skin-art.mjs` (the skins). The state digest of a flag-off run equals a run on master without the mod
(validate-sim-split, below).

## Built from the game's own pieces

| Piece | Stock thing | Why |
|---|---|---|
| Claudia | `DeusEx.Female1` (HumanCivilian, mesh `GFM_TShirtPants`, 64 sequences incl. `SitBegin`, `SitBreathe`) | the class of this map's own Female0; the mesh has glasses slots and a sitting pose |
| Rydgel | `DeusEx.Businessman2` (HumanCivilian, mesh `GM_Suit`) | the GM_Suit mesh has a ponytail slot (slot 7, the Triad `PonytailTex1`), glasses slots, a jacket whose skirt is its own masked slot, a separate trousers slot |
| the crate | `CrateBreakableMedGeneral` (wood, 68 x 68 x 48) | set `bInvincible` and not pushable, so nothing moves her seat |
| her seat | `Chair1` (a stock `Seat`), `bHidden`, collision off, at the crate's centre with its sit point raised 28 | lets `ScriptedPawn.Sitting` run: she is spawned in the state that state ends in |
| glasses | `FramesTex1` + `LensesTex2` in `GFM_TShirtPants` slots 3 and 4 (the pair the map's own Female1 wears on another mesh), through her MultiSkins; the frames texture itself is drawn round (below) | the mesh has the geometry, the stock Female1 skin masks it |
| laptop | **none**: no mesh in DeusEx.u or DeusExDeco.u is a laptop (the nearest are `ComputerPersonal`, a whole desktop, and `DataCube`, a frobbable text slate); she types at nothing | not invented |

Orders and behavior. Both are spawned with `SpawnActor` (script-spawn.mjs, the body `summon` reaches) after the Player start.
*Rydgel*: `Orders=Standing` (ScriptedPawn.Standing: the original idle loop, `BreatheLight` and head turns). *Claudia*: `Orders=Sitting`,
`bSitting`, `SeatActor` the hidden Chair1 and its slot taken, `PHYS_Flying` (SetPhysics 4, which Sitting sets as a pawn sits), the
sit-height collision box and PrePivots that `SetBasedPawnSize(radius, GetSitHeight())` leaves, so the state enters its own
`ContinueSitting` label: `SitBreathe` loop, then stasis. Both: `bInvincible`, `bFear*`/`bReact*` false (no flee or alarm), `bImportant`
false, `ConListItems` cleared (ScriptedPawn.Frob asks `StartConversation`, which returns at once without a list, so a frob never
starts an original conversation or its camera). Civilians have `AttitudeToPlayer` Ignore and no alliance with the player's enemies,
so nothing fights them.

Why Claudia is spawned seated: Play's `MoveActor` for a pawn is the recovered body for **serialized map pawns only**
(`ScriptRuntime.movePawn`), and `Sitting` walks to its seat with it, and calls `SetBasedPawnSize`, whose `Move` is the same call. A
spawned pawn that reaches either throws. The mod does not extend that boundary; it keeps both pawns off every `Move`. A spawned pawn that
wanders is unsupported by the same boundary, which is another reason they stand and sit.

Where they stand (measured on the map's collision with `level.hash.multiLineCheck`): the bar counter's front plane is x = -1127.5 (top
z = -143.5); in front of it the floor is z = -191.5 up to a 16-unit riser at x = -1008.5; the walls at y = -639.5 and y = -128.5. Crate
centre (-1090, -388, -167.5) (lid -143.5, level with the counter), Claudia on it facing the room (+x), Rydgel at (-1104, -448, -144)
facing the room, leaning on the counter beside the crate. The Bartender0 stands behind the counter at (-1233, -468). The spot is
`10_Paris_Club` player coordinates (x -1040, y -388 faces Claudia from the room, 50 units).

## Skins (`easter-skin-art.mjs`)

Original textures are never committed. The page decodes the stock skins as it always does (`TextureStore`); `easterSkins.current` is
asked for each face group once its skin is decoded and, for these two actors only, returns a copy with the recipe applied (recolouring
in HSV so the stock shading and weave survive, plus marks drawn in code) and a full mip chain made by box averages. Texture pool and
group keys differ per actor and recipe, so no other actor shares them. Starting points and what each does:

| Actor | Slot -> stock skin | Recipe |
|---|---|---|
| Claudia | 0 and 2 `Female1Tex0` (head, hair; slot 2 masked strands) | blond hair (hue ~45) goes near-black; a thin purple streak on the crown and fringe |
| | 6 `PantsTex2` (trousers and shoes) | olive, with thigh pocket patches; the two foot regions white |
| | 7 `Female1Tex1` (the knit top) | oversized purple hoodie: recoloured knit, darker hood gathering at the neck, two drawstrings, cuff bands, a front pocket |
| | 3 `FramesTex1` (modulated) | a round dark ring drawn over the neutral grey (the stock ring is a wayfarer) |
| Rydgel | 0 `Businessman2Tex0` -> pixels of `NathanMadisonTex0` (a clean-shaven GM_Suit head, auburn hair) | hair golden; a neck tattoo; a gold ear stud |
| | 3 and 4 `Businessman2Tex1` (jacket; slot 4 is its masked skirt) | grey suit -> olive field jacket over a dark brown-black tee (the stock black shirt; the orange tie darkened away), two gold chains and a pendant, a round chest patch, a zipped sleeve pocket, a ribbed hem; the skirt cut at the hem so a bomber ends there and the belt shows |
| | 1 `Businessman2Tex2` (trousers) | dark charcoal, a mustard belt with a buckle at the waist band |
| | 7 `PonytailTex1` (masked) | golden |

UV layouts (found with the mesh's own triangles drawn over each texture, frame 0 of `Still`; coordinates are fractions of the
texture): `GFM_TShirtPants` slot 0 is the head (face lower left, hair cap upper right, hands are on slot 7's texture bottom centre),
slot 6 the trousers with the shoes at the left strip and right edge, slot 7 the top (back left, sleeves middle, front right). `GM_Suit`
slot 0 head and hands (hands strip on top), slot 1 trousers (waist band on top, fly right), slot 3 the jacket (front on the right, the
black V opening at u ~0.83), slot 4 its skirt below v 0.66, slot 7 the ponytail (strands in the top ninth of the 64 x 32 texture).

## Frob lines and banter

A frob is the original RightMouse binding (`ParseRightClick` -> `DoFrob`) with `FrobTarget` on one of them; the line shows through
`PlayerPawnExt.ClientMessage` -> `DeusExRootWindow.ClientMessage` -> the HUD log, `Name: line`. Each speaker has three pairs, taken in
turn (the first on the first frob):

| Frobbed | Line | Answer after 1.6 s |
|---|---|---|
| Claudia | Shh, I'm chasing one last ulp. | Rydgel: She said that an hour ago. Don't tell her I noticed. |
| Claudia | Three bits off. Three. I can feel it. | Rydgel: That's how it starts. Then it's sunrise. |
| Claudia | Tell Rydgel the build is green. Do not tell him why. | Rydgel: I heard that. |
| Rydgel | Push when it's good. | Claudia: It's not good yet. |
| Rydgel | Bar's open. Mind the crate. | Claudia: The crate is load-bearing. |
| Rydgel | We built this place. Mostly she built it. | Claudia: He held the ladder. It counts. |

## Verification

```
node scripts/validate-easter-egg-play.mjs [--shots DIR]
node scripts/validate-sim-split.mjs --a <server of the pre-mod build> --map 10_Paris_Club --frames 240 --every 60
```

`validate-easter-egg-play.mjs` (worker mode, Playwright): with the flag both actors are at their places as the stock classes in the
original Sitting/Standing states with their names, MultiSkins and a hidden Chair1 under a wooden crate; each recipe's skin was drawn with
its design colour; a real right-click on each shows the line, the answer comes later, a second frob takes the next line; neither pawn
moves, changes state or loses health; without the flag a second page has no mod state, no skin hook and none of the mod's actors
among the mesh bindings; after the page's Reset (a Player start reloads the level) they are placed again and the speaker rotation
restarts. The second command is the digest comparison with a build without the mod (the pre-mod commit served from its own copy):
measured 2026-10-17 with `46f6e56` as A and this tree's flag-off page as B on 10_Paris_Club, `?hold=1&seed=1`, 240 frames: the four
state digests (frames 60, 120, 180, 240: `c6e1c86bc6d14e36`, `537a540d0fa0cff2`, `ea1cfbc800c1057b`, `c3442ba3627c793d`) and the last
frame's pixels (`877312b4d8bcc358`) are equal in both builds.

## Rough or open

- No laptop prop (none exists) and no typing animation: she sits in `SitBreathe`. Her pose is the chair-sit pose on a crate, not cross-legged.
- Rydgel's idle is the stock `BreatheLight`/head-turn loop, not hands in pockets (no such animation on `GM_Suit`).
- Hair length and shape are the meshes' (short on both heads): the bob and the loose strands are colour only; the neck tattoo sits where
  the mesh shows little neck under the tee collar.
- The skins are 128-wide recolours lit by the club's dim blue light; the colours in the pictures are the lighting's too.
- A spawned pawn that is pushed, shot at by a hostile or asked to move may reach the `movePawn` boundary above (not exercised); they are invincible and
  never asked to move.
