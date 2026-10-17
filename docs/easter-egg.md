# The ?easter=1 mod

An opt-in extra for Play, designed with the user. It is **not** part of the faithful reimplementation and changes nothing when off: add
`?easter=1` to the page and, on **10_Paris_Club**, two extra people stand at the bar. **Claudia** sits on a wooden crate and **Rydgel**
leans on the counter beside her (they are teammates who built the place; the names live in `src/viewer/easter-config.mjs`, one place,
and are the pawns' own `FamiliarName`/`UnfamiliarName`, so the original HUD shows them over the target brackets). Right-click either
one and the original HUD log shows their line, spoken in their own voice with their mouth moving ("Voices", below); the other answers a quarter
of a second after the clip has ended, also spoken.

## What it touches (each hook is a no-op without the flag)

| Where | Change |
|---|---|
| `src/viewer/main.mjs` | `applyEaster()` (called first in `applyStartCheats`, i.e. after every Player start) reads `?easter=1` and, only then, imports `easter-page.mjs`; `deusExViewer.easterProbe(args)`, a validation probe like `viewProbe` |
| `src/viewer/sim-worker.mjs` | one `call` method, `easter`, that imports `easter-sim.mjs` on demand |
| `src/viewer/actor-mesh-draw.mjs` | after a face group's skin is decoded, `easterSkins.current` (null unless the mod registered) may swap the decoded skin; the await sequence of the stock path is unchanged |
| `src/runtime/script-audio-live.mjs` | `moddedSounds`, an empty WeakMap (synthetic Sound object -> MP3 bytes) that `decodeSample` asks first; the mod registers its twelve clips in it, nothing else does, so the stock path is unchanged |

Everything else is new and in its own modules: `easter-config.mjs` (names, classes, place, lines), `easter-sim.mjs` (spawning and the
frob and reply hooks, simulation side), `easter-page.mjs` (page side start), `easter-skins.mjs` (the registry the draw asks),
`easter-skin-art.mjs` (the skins), `easter-speech.mjs` (the clips and their playback, below), `easter-audio/` (the clips). The state digest of a flag-off run equals a run on master without the mod
(validate-sim-split, below).

## Built from the game's own pieces

| Piece | Stock thing | Why |
|---|---|---|
| Claudia | `DeusEx.Female1` (HumanCivilian, mesh `GFM_TShirtPants`, 64 sequences incl. `SitBegin`, `SitBreathe`) | the class of this map's own Female0; the mesh has glasses slots and a sitting pose |
| Rydgel | **one setting**, `RYDGEL_LOOK` in `easter-config.mjs`: `'trench'` (default) is `DeusEx.FordSchick` (HumanCivilian, mesh `GM_Trench`: a hip-length jacket, a separate undershirt, trousers, head), `'suit'` is `DeusEx.Businessman2` (HumanCivilian, mesh `GM_Suit`: a suit jacket whose V shows a shirt, trousers, head) | neither draws a ponytail: `GM_Suit` has a ponytail part (slot 7) that the class holds the stock `PinkMaskTex` for, and `GM_Trench` has none; the glasses slots hold the class's own `GrayMaskTex`/`BlackMaskTex` (the mod writes none of Rydgel's MultiSkins). FordSchick is the HumanCivilian `GM_Trench` class with the plainest jacket and undershirt (the other civilian ones are two bums, a scientist and a doctor, with a coat of rags or a lab coat) |
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
z, `sitPoint.z = Location.z - seat.z - (sitHeight - assHeight)`), and she sits toward the room by `crate radius - heelForward + heelClearance` = 34 - 15.0 + 0.8 = 19.8
from the crate's centre (`sitPoint = (0, -19.8, z)` in the seat's frame, which is yawed a quarter turn from her facing): the heels, the
rearmost points of the lower leg, are 0.8 in front of the front face and the shins hang in the open. The shin slopes back as it goes down
(the knee underside's rear vertices are 20.0 in front of the origin, the heels 15.0), so the backs of her knees end 5.8 past the face
and the kneecaps 12.6; 18.1 of the 23.9 units from the back of the hips to the back of the knees are on the lid. (A first version with
the sit point 24 forward had only the hips on the lid and the thighs over the edge; hanging the shins closer to the face would put the
ankles inside it.) The validator asserts the seat plane against the lid, the hips and thighs over it, the backs of the knees a few units past the edge and
the heels and ankles clear of the face, all from the live crate and the config numbers, and the side-on screenshots below show it (camera in ghost mode at the lid's height: the thighs lie along the lid's top line).

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
| Rydgel (role `head`) | `Businessman2Tex0` (suit look, slots 0 and 2) or `FordSchickTex0` (trench, slots 0 and 3) -> pixels of `NathanMadisonTex0` (a clean-shaven head, auburn hair; every male head texture shares one layout) | hair golden and loose (no ponytail: strands of the same hair carry on down over the nape, each column its own length), a tattoo on the neck's side below the hair, a gold ear stud |
| (role `jacket`, suit look) | 3 and 4 `Businessman2Tex1` (jacket; slot 4 is its masked skirt) | the suit's front (a deep V of black shirt with an orange tie, satin lapels with a notch, a double-breasted overlap, two buttons) becomes an olive field jacket worn open over a **plain dark brown-black crew-neck tee**: the V is cut down to a rounded jersey opening with a finely ribbed neckband (no tie, no collar, no shirt buttons), the lapels, overlap and buttons are blurred into flat jacket cloth, a zip runs from the opening's foot to the hem; two gold chains and a pendant hang over the tee, a zipped sleeve pocket, a ribbed hem (no chest patch); the skirt cut at the hem so a bomber ends there and the belt shows. The neck's collar piece (the strip at the top of the texture) is the tee's rib |
| (role `trousers`) | `Businessman2Tex2` or `PantsTex3` (slot 1 or 2) | dark charcoal, a mustard belt with a buckle at the waist band (the two textures share one layout) |
| (role `shirt`, trench look) | 4 `FordSchickTex1` (the undershirt, 64 x 128: the neck opening at the top, the chest from v 0.1, the waist at v 0.4) | the stock beige undershirt becomes the plain dark brown-black crew-neck tee: its shading scaled down to near black, a ribbed band round the neck opening, two gold chains and a pendant hanging from the neck over the chest |
| (role `coat`, trench look) | 1 and 5 `FordSchickTex2` (the jacket, 128 x 256: the body panel above, the sleeve below, collar and cuff in brown corduroy) | the stock denim becomes olive field-jacket cloth (the jacket's colour in the suit look too), the brown trim a darker olive-brown, the dark snap buttons left |
| | 7 (the ponytail part, suit look) | none: the class's own `PinkMaskTex`, drawn nowhere |

UV layouts (found with the mesh's own triangles drawn over each texture, frame 0 of `Still`; coordinates are fractions of the
texture): `GFM_TShirtPants` slot 0 is the head (face lower left, hair cap upper right, hands are on slot 7's texture bottom centre),
slot 6 the trousers with the shoes at the left strip and right edge, slot 7 the top (back left, sleeves middle, front right). `GM_Suit`
slot 0 head and hands (hands strip on top), slot 1 trousers (waist band on top, fly right), slot 3 the jacket (front on the right, the
black V opening at u ~0.83), slot 4 its skirt below v 0.66, slot 7 the ponytail (strands in the top ninth of the 64 x 32 `PonytailTex1`, unused now). On the jacket texture (256 x 128) the stock V runs from u 0.773 to 0.88 at the top to its tip at (0.827, 0.51), the lapel bands outside it, the overlap and two buttons below it, and the neck's collar piece is the strip u 0.31 to 0.53, v 0 to 0.04.
`GM_Trench` (found from the texture sizes and shapes, then in Play): slot 4 is the undershirt (64 x 128), slots 1 and 5 the jacket (128 x 256), slot 2 the trousers (128 x 128, the same layout as `GM_Suit`'s), slots 0 and 3 the head, 6 and 7 the glasses parts (masked by the class).
On the head texture (one layout for all male heads) the hair is the band v 0.3 to 0.8, the face lower left, the neck below v 0.8 (hands on top).

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

### Playback: the game's own speech path

A clip is played as the speech of its speaker actor, the path `ConPlay.PlaySpeech` takes (docs/galaxy-audio.md "Speech through Galaxy's voices",
docs/lip-sync.md), by `easter-speech.mjs` and the hooks in `easter-sim.mjs` (simulation side, the worker by default):

1. **The sound**: each clip is a synthetic `Sound` object (key `easter.<id>`) registered in `moddedSounds`; `decodeSample` finds it there and takes the
   same host-decoded MPEG record path an original speech MP3 takes (`hostSample`: the rate and frame count come from the MPEG header, a record
   in Galaxy's registry), because the clips are the game's own format.
2. **The call**: `Actor.PlaySound(Sound, SLOT_Talk, , , 1024)` on the speaker through the original native `execPlaySound` (script-sound.mjs:
   CheckHearSound, the player's `ClientHearSound`, Galaxy's `PlaySound`). The radius is `BarkManager.StartBark`'s 1024 (an ambient exchange, not
   a camera conversation; `ConPlay` uses 65536 for its forced speech). The channel id needs the speaker's global object index; a spawned pawn has
   none the runtime measured, so unless the object-index model has one (`soundObjectIndex`) the mod gives each speaker a fixed index far above any
   real one (0xfe0000 and 0xfe0001), used only to key its channel.
3. **The voice**: Galaxy's Update starts the voice on the next frame (a mono 44.1 kHz record, 0x4024); the page decodes the MP3 (`decodeSpeech`, an
   OfflineAudioContext at the clip's rate, the same for every speech MP3), the worklet plays it on the ring transport, and the voice's end clears
   the channel.
4. **The mouth**: Update's step 12 analyses a Talk-slot channel whose Actor IsA Pawn and whose `bIsSpeaking` is set, every 0.1 s of channel time, and
   writes the speaker's `nextPhoneme` (bit-exact with Galaxy.dll, docs/lip-sync.md). `ConPlay.StartSpeakingAnimation` sets `bIsSpeaking` and
   `bWasSpeaking` on the speaker, which the mod does (the same two writes) when the clip starts and clears `bIsSpeaking` (`StopSpeakingAnimation`)
   when the Galaxy channel is gone. The original `Pawn.LipSynch(deltaTime)` is called from the Tick of `ScriptedPawn`'s Conversation states only
   (the bytecode: nothing else calls it), and these pawns stand in Sitting/Standing, so the mod calls the same original bytecode body after each
   level tick while the clip plays, with the level's delta, and once more at the end (`bWasSpeaking`: it tweens the mouth closed). The letters
   take effect one tick after they are written, as in the original (Audio->Update runs after the level tick); the call is placed after the
   whole level tick instead of inside the actor's own, which changes only the order within a frame.
5. **The HUD and the reply**: the line shows through `ClientMessage` as the clip starts. When the Galaxy channel ends (the voice finished: the clip's
   length plus the decode and the ring's tail, about 0.9 s after the audible end for a 3 s line) the reply is scheduled `replyGap` (0.25 s) later and
   plays the same way for the other speaker. If the clips cannot be loaded, or a play fails, the exchange stays text-only with the old 1.6 s timing; if a clip
   never gets a channel its length plus 0.75 s ends it. A frob during an exchange does nothing.

What is ours: the arrangement, the voices, the radius choice, the mod's object indices, the call to `LipSynch` outside a Conversation state. What is
the game's: the speech chain from `PlaySound` to the ring voice, the lip-sync analysis, `LipSynch` and the `GFM`/`GM_*` mouth animations. Without
`?easter=1` nothing registers a modded sound and none of this runs.

## Verification

```
node scripts/validate-easter-egg-play.mjs [--shots DIR]
node scripts/validate-sim-split.mjs --a <server of the pre-mod build> --map 10_Paris_Club --frames 240 --every 60
```

`validate-easter-egg-play.mjs` (worker mode, Playwright, real right-clicks): with the flag both actors are at their places as the stock classes in the
original Sitting/Standing states with their names, MultiSkins and a hidden Chair1 under a wooden crate; each recipe's skin was drawn with
its design colour; a real right-click on each starts the speaker's clip as speech: its HUD line shows as the clip starts, the speaker's Galaxy channel holds the clip, its
mouth (letters and `Mouth*` blend sequences) changes while it plays and is closed after, the other one's mouth stays still, the answer's clip starts
`replyGap` after the line's clip has ended with its own HUD line, a frob during the exchange does nothing, a second frob takes the next line; before any frob,
six samples over 1.5 s show no letter, no `Mouth*` animation and `bIsSpeaking` clear; neither pawn
moves, changes state or loses health; without the flag a second page has no mod state, no skin hook and none of the mod's actors
among the mesh bindings; after the page's Reset (a Player start reloads the level) they are placed again and the speaker rotation
restarts. The second command is the digest comparison with a build without the mod (the pre-mod commit served from its own copy):
measured 2026-10-17 with `46f6e56` as A and this tree's flag-off page as B on 10_Paris_Club, `?hold=1&seed=1`, 240 frames: the four
state digests (frames 60, 120, 180, 240: `c6e1c86bc6d14e36`, `537a540d0fa0cff2`, `ea1cfbc800c1057b`, `c3442ba3627c793d`) and the last
frame's pixels (`877312b4d8bcc358`) are equal in both builds.

## Rough or open

- No laptop prop (none exists) and no typing animation: she sits in `SitBreathe`. Her pose is the chair-sit pose on a crate, not cross-legged.
- Rydgel's default look is `GM_Trench` on `FordSchick`: a hip-length jacket with a stand collar, open over a dark crew-neck tee, no lapels. The `'suit'` look (`GM_Suit`, tried first) keeps a suit's silhouette (padded shoulders, straight sleeves) and reads as an open field jacket only with its V cut down, lapels flattened and a zip painted; switch with `RYDGEL_LOOK`. Both pass the validator.
- `FordSchick` is a named character class (a unique NPC in the game, not a generic civilian): the mod clears its ConListItems and sets the same flags as the others, so no conversation, bark or reaction reaches him; nothing else of the class is used.
- Rydgel's loose hair is the head mesh's own short cap plus painted strands over the nape: the mesh has no longer hair geometry.
- Rydgel's idle is the stock `BreatheLight`/head-turn loop, not hands in pockets (no such animation on `GM_Suit` or `GM_Trench`).
- Hair length and shape are the meshes' (short on both heads): the bob and the loose strands are colour only; the neck tattoo sits where
  the mesh shows little neck under the tee collar.
- The skins are 128-wide recolours lit by the club's dim blue light; the colours in the pictures are the lighting's too.
- A spawned pawn that is pushed, shot at by a hostile or asked to move may reach the `movePawn` boundary above (not exercised); they are invincible and
  never asked to move.
