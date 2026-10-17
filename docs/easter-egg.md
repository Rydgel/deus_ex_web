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
| Rydgel | `DeusEx.Businessman2` (HumanCivilian, mesh `GM_Suit`) | the GM_Suit mesh has a ponytail part (slot 7; the class holds the stock `PinkMaskTex` there, which hides it, and the mod leaves it so: he wears his hair loose), glasses slots (`GrayMaskTex`, `BlackMaskTex`, also the class's own), a jacket whose skirt is its own masked slot, a separate trousers slot |
| the crate | `CrateBreakableMedGeneral` (wood, 68 x 68 x 48) | set `bInvincible` and not pushable, so nothing moves her seat |
| her seat | `Chair1` (a stock `Seat`), `bHidden`, collision off, at the crate's centre, its sit point derived so the pose's seat plane meets the lid and moved 24 toward the room ("Her seat") | lets `ScriptedPawn.Sitting` run: she is spawned in the state that state ends in |
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

## Her seat

`ScriptedPawn.Sitting` places a pawn at `SitPosition = seat.Location + sitPoint rotated by the seat - (0,0,1) * newAssHeight`, and the mesh is
drawn from `Location + PrePivot` (lodmesh-frame.mjs), with `PrePivot.z` at its steady value `PrePivotOffset` = default collision height - sit height (9 for
Female1: stand height 38.5, sit height 29.5, DrawScale 1): `SetBasedPawnSize` first leaves full - sit height (13.5) and the state's own
`LoopAnimPivot('SitBreathe')` tweens it to `DesiredPrePivot = PrePivotOffset` within 0.15 s, so a pawn spawned in the steady state starts there. Her pose is the `SitBreathe` frame of `GFM_TShirtPants` (frame 305), measured on the
mesh's own vertices (`decodeLodMeshPayload` + `readLodMeshFrame`; mesh scale 1/256, origin z 11000, front = raw -y): the lowest seat vertices
are at raw z 6193, so **18.78 below the origin** (`hipDrop`); the back of the hips is 3.9 behind it, the heels (raw y -3847 to -4011) are
15.0 to 15.7 and the knees and toes 20.0 to 26.6 in front of it, the soles are 43.0 below it (24 above the floor when the seat plane is on a
48 high crate).

The first placement (`sitLift 28`, tuned on screen, crate centre) was wrong twice: the seat plane was 7.9 units above the lid (she
hovered; `Location.z + PrePivot.z - hipDrop` = -125.3 + 9 - 18.8 = -135.1 against the lid at -143.0) and the lower legs, 15 to 27 in front of the origin, were
inside the 68 wide crate (front face 34 from its centre). Now `easter-sim.mjs` derives her Location from the crate: the seat plane lies
`lidEmbed` (0.3) under the lid's top surface (Location.z = lid top - lidEmbed + hipDrop - PrePivotOffset, which makes the first sit point's
z, `sitPoint.z = Location.z - seat.z - (sitHeight - assHeight)`), and she sits `sitForward` = 24 toward the room from the crate's centre
(`sitPoint = (0, -24, z)` in the seat's frame, which is yawed a quarter turn from her facing), so her hips are over the front part of the
lid (back of the hips 20 from the centre, 14 inside the front face), the heels are 5 and the knees 10 to 16 in front of the face, and the
shins hang in the open. The validator asserts the seat plane against the lid, the heel clearance and the hip overlap from the config
numbers, and the side-on screenshots below show it (camera in ghost mode at the lid's height: the thighs lie along the lid's top line).

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
| Rydgel | 0 `Businessman2Tex0` -> pixels of `NathanMadisonTex0` (a clean-shaven GM_Suit head, auburn hair) | hair golden and loose (no ponytail: strands of the same hair carry on down over the nape, each column its own length), a tattoo on the neck's side below the hair, a gold ear stud |
| | 3 and 4 `Businessman2Tex1` (jacket; slot 4 is its masked skirt) | the suit's front (a deep V of black shirt with an orange tie, satin lapels with a notch, a double-breasted overlap, two buttons) becomes an olive field jacket worn open over a **plain dark brown-black crew-neck tee**: the V is cut down to a rounded jersey opening with a finely ribbed neckband (no tie, no collar, no shirt buttons), the lapels, overlap and buttons are blurred into flat jacket cloth, a zip runs from the opening's foot to the hem; two gold chains and a pendant hang over the tee, a round chest patch, a zipped sleeve pocket, a ribbed hem; the skirt cut at the hem so a bomber ends there and the belt shows. The neck's collar piece (the strip at the top of the texture) is the tee's rib |
| | 1 `Businessman2Tex2` (trousers) | dark charcoal, a mustard belt with a buckle at the waist band |
| | 7 (the ponytail part) | none: the class's own `PinkMaskTex`, drawn nowhere |

UV layouts (found with the mesh's own triangles drawn over each texture, frame 0 of `Still`; coordinates are fractions of the
texture): `GFM_TShirtPants` slot 0 is the head (face lower left, hair cap upper right, hands are on slot 7's texture bottom centre),
slot 6 the trousers with the shoes at the left strip and right edge, slot 7 the top (back left, sleeves middle, front right). `GM_Suit`
slot 0 head and hands (hands strip on top), slot 1 trousers (waist band on top, fly right), slot 3 the jacket (front on the right, the
black V opening at u ~0.83), slot 4 its skirt below v 0.66, slot 7 the ponytail (strands in the top ninth of the 64 x 32 `PonytailTex1`, unused now). On the jacket texture (256 x 128) the stock V runs from u 0.773 to 0.88 at the top to its tip at (0.827, 0.51), the lapel bands outside it, the overlap and two buttons below it, and the neck's collar piece is the strip u 0.31 to 0.53, v 0 to 0.04.
On `GM_Suit`'s head texture the hair is the band v 0.3 to 0.8, the face lower left, the neck below v 0.8 (hands on top).

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

## Voices

Every frob line and every reply is also spoken: 12 clips (`src/viewer/easter-audio/<id>.mp3`, ids `frob-<who>-<i>` and
`reply-<who>-<i>`, listed by `easterClips()` in `easter-config.mjs`), synthesised locally with Piper
(https://github.com/rhasspy/piper, the `piper-tts` PyPI package, 1.8.0 with onnxruntime 1.31.0 in a git-ignored virtualenv) and committed as
our own assets. The browser's speech API is not used.

| Speaker | Voice (rhasspy/piper-voices at revision `c10ece1a…`) | Training data and licence (its MODEL_CARD) | Size |
|---|---|---|---|
| Claudia | `en_US-kristin-medium`, 22.05 kHz, one speaker, median pitch of her clips about 163 Hz | LibriVox recordings, about 11.5 h, trained from scratch; **public domain** | 63.5 MB |
| Rydgel | `en_US-norman-medium`, 22.05 kHz, one speaker, median pitch about 100 Hz | LibriVox recordings, about 15.5 h, trained from scratch; **public domain** | 63.5 MB |

Both were picked for their licences: the model cards of 22 English voices were read, and these two have a public domain dataset and no
restricted base model (the LibriVox set by Bryce Beattie: `kristin`, `norman`, `john` (a finetune of Kristin), `bryce`, `cori`), so the
generated audio can be committed and redistributed freely. Passed over: `ryan` and `hfc_female`/`hfc_male` (CC BY-NC-SA 4.0), `lessac`
(Blizzard 2013 licence) and its finetunes `joe`, `amy`, `sam` and `kathleen` (a finetune of `ryan`), whatever the finetune data's own licence,
`amy`/`jenny_dioco`/`kusal`/`alan` (card says "See URL"), and the CC BY and CC BY-SA ones (`alba`, `libritts_r`, `southern_english_female`,
`northern_english_male`), which would need attribution or share-alike. The `piper-voices` repository is MIT; `piper-tts` itself is GPL-3.0,
which covers the program and not the audio it writes. Whether Kristin sounds "young" is not something the model card says; she is the clearest-licensed
female US voice (a measured median of 163 Hz is mid-range female). The model files (`en_US-<voice>.onnx` and `.onnx.json`, with their sha256 in
`EASTER_VOICES`) stay in `.cache/piper-voices` and are never committed.

Clips: mono, 44.1 kHz, **MPEG-1 Layer III at 48 kbps CBR with no tags or Xing frame**, so a file starts `FF FB 30 C4` like the game's own speech
(`DeusExConAudio*.u` frames, docs/lip-sync.md) and goes through the same transport; leading silence cut to 20 ms and trailing to 60 ms;
0.7 to 3.2 s each, 144,192 bytes in all (4.4 to 19.0 kB each). The level is matched to the game's speech, measured on 65 clips from
`DeusExConAudioMission01`..`04` and `AIBarks` (ffmpeg's decode, RMS over the voiced part): median **-13.4 dBFS** (p10 -16.6, p90 -11.2), sample
peaks 0.0 to +1.2 dBFS (the game's speech is mastered hot and its MP3s overshoot). The clips are at **-13.6 to -14.1 dBFS RMS** with peaks
-2.0 to 0.0 dBFS (a limiter at -2 dB before the encoder, tightened until the decoded MP3 stays under -0.3 where it can).

```
node scripts/easter-voices.mjs --download     # fetches the two models into .cache/piper-voices, sha256-checked (127 MB)
node scripts/easter-voices.mjs [--only ID]    # regenerates the clips and manifest.json from easter-config.mjs
node scripts/easter-voices.mjs --check        # measures the committed clips against manifest.json and the level target
```

The piper binary is `$EASTER_PIPER` or `.cache/piper-env/bin/piper`. Piper's decoder draws random noise, so a regeneration speaks the same words in
the same voice but is not byte-identical (durations move by a few tenths of a second); the committed clips and `manifest.json` (voice,
licence, sha256, duration, level per clip) are the artifact.

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
- Rydgel's jacket keeps `GM_Suit`'s tailored silhouette (padded shoulders, straight sleeves, a hip-length cut); with the V cut down, the lapels flattened and a zip it reads as an open field jacket over a tee in the pictures, not a suit. If it still reads too formal in the user's eye, the closest stock male meshes are `GM_Trench` (an open coat) and `GM_Jumpsuit` (a zip-up top); neither was tried.
- Rydgel's loose hair is the head mesh's own short cap plus painted strands over the nape: the mesh has no longer hair geometry.
- Rydgel's idle is the stock `BreatheLight`/head-turn loop, not hands in pockets (no such animation on `GM_Suit`).
- Hair length and shape are the meshes' (short on both heads): the bob and the loose strands are colour only; the neck tattoo sits where
  the mesh shows little neck under the tee collar.
- The skins are 128-wide recolours lit by the club's dim blue light; the colours in the pictures are the lighting's too.
- A spawned pawn that is pushed, shot at by a hostile or asked to move may reach the `movePawn` boundary above (not exercised); they are invincible and
  never asked to move.
