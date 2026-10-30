# Project status

The stage-by-stage record of what Play does and how each stage was closed. It was
the repository's README until 2026-10-30; the [README](../README.md) now gives the
public overview and links here. The numbered stages and their acceptance criteria
are in [the roadmap](roadmap.md); each stage's exit criteria document is the
authority for its rows.

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. **Stage 3 is complete within its adopted scope:**
Training passes all five runtime criteria across 95 probes, and all 83
single-player maps reach only boundaries assigned to later stages in the startup
census ([completion record and coverage limits](stage-3-exit-criteria.md#stage-3-beyond-training-the-all-maps-startup-census)).
**Stage 4 presentation is complete** (2026-10-17): its gate passes 70 of 70 in one
run ([Stage 4 close](stage-4-exit-criteria.md#stage-4-close)). **Stage 5
gameplay is complete** (2026-10-21): its adopted gate passes 50 of 50 on master
([Stage 5 close](stage-5-exit-criteria.md#stage-5-close)), each criterion on
original captures of Liberty Island and Training replayed tick by tick in Play (see below).
**Stage 6 saves, travel and the campaign are complete** (2026-10-26): all 54 of its
rows pass. Every mission's placed chain, both sides of each lasting choice and one Play
run from New Game to an ending equal the original under Wine
([Stage 6 below](#stage-6-campaign--complete-2026-10-26)).

The target is **100% original fidelity**. Every supported behavior needs original
data, script, native-code or measured evidence. Unverified substitutes remain
incomplete work. See [the project rule](../AGENTS.md).

Delivery is **local only**, as requested. No website is deployed; do not publish
or push further hosting updates unless the user asks.

## What works

- A JavaScript UE1 package reader shared between Node and browser APIs. All 219
  installed packages validate, with no unresolved package dependencies. Tagged
  actor properties and compiled BSP world geometry decode across all 88 maps.
- Browser folder selection reads the user's local installation without uploading
  game files. The development server can also read this workspace's installation.
  The map list offers every installed map; the 83 single-player maps are the
  measured scope.
- Original LoadMap startup and Login, the original DeusExHUD, the main menu
  (Escape) and the installed key bindings, routed through the recovered
  InputEvent → XInputExt → viewport Exec chain.
- Movement and collision through the original physics routines (walking,
  falling, landing, ladders, swimming), compared against original DLL execution.
  Doors and other movers run the original `DeusExMover` scripts and
  `physMovingBrush`. Pushed decorations run `DeusExDecoration.Bump` and their
  physics ([movement](movement.md), [swimming](swimming.md),
  [rolling](rolling.md), [doors](doors.md)).
- Using things runs the original frob paths: doors, light switches, keypads,
  DataCubes, the nano key ring, and item pickup into the inventory and object
  belt ([mover frob](script-mover-frob.md),
  [item pickup](script-item-pickup.md)).
- Weapons: number keys run the original `ActivateBelt N`; weapons draw in
  first person through `PutInHand`/`BringUp` and fire and swing through the
  original ticked weapon states. Two crowbar hits break a Training crate into its
  original fragments and contents ([weapon equip](script-weapon-equip.md),
  [crate destruction](script-crate-destruction.md)). On Liberty Island the
  player's pistol hurts and kills Terrorists, hostile NPCs aim and fire back
  (Tracers, hit regions, armor), batons and crowbars knock out, explosions run
  `HurtRadius`, and the player's death runs to the level's end, each compared
  with the original ([Stage 5](stage-5-exit-criteria.md)).
- DataLinks, InfoLink transmissions and first-person and third-person
  conversations run the original ConPlay scripts, with subtitles, speech and
  mission timers ([DataLink scope](script-datalink-live.md),
  [conversation](script-instructor-conversation.md),
  [conversation camera](conversation-camera.md)).
- Every visible actor mesh draws with original lighting
  ([NPC mesh preview](npc-mesh-preview.md), [mesh lighting](mesh-lighting.md))
  and DrawLodMesh's distance LOD ([LOD](script-lodmesh-lod.md); `?meshLod=off`
  draws full detail). An armed pawn holds its gun in every frame that draws him
  (the main frame, mirrors, a security camera's window), posed from its mesh's
  special triangle as Render.dll does and lit right after the pawn in the original's
  order ([weapon attachment](weapon-attachment.md)); on the GPU mesh path
  ([GPU mesh](gpu-mesh.md#a-pawns-weapon-2026-10-15)) unless `?weapons=cpu`;
  `?weapons=off`, `?weaponMirrors=0`).
- Unit/format tests, real-data validation commands, and browser regression
  tests. Optional local native-DLL comparisons check translated routines against
  the original DLLs under an emulator ([native exec diff](native-exec-diff.md),
  [level queries](level-queries.md)).

**Current boundaries:** Stage 3 completion covers the measured runtime paths,
not every interaction or full campaign compatibility. Stage 5 gameplay is
proven only where its gate passes (below); the other gameplay rows play in Play
but have no original capture yet. Stage 6's campaign
rows compare placed chains, not free play: the walk and the fights between the steps are
not part of them (the user's decision, [Stage 6 exit criteria](stage-6-exit-criteria.md)). The final original camera/motion comparison
and actual window/tab pause acceptance deferred from Stage 2 remain open.

## Stage 3 completion — 2026-09-28

- Training's gate passes startup, tick, interaction, object lifecycle and
  host-substitute checks. Its 95 probes include a continuous public-input route
  from PlayerStart1 through `DL_part2`.
- The all-maps census covers original LoadMap startup and Login, ten seconds of
  ticking, a Player-start reload and ten further seconds. All **83/83**
  single-player maps have no unclassified Stage 3 boundary, boot failure or crash.
  At the 2026-09-28 completion **53/83** ran without any boundary; after the
  conversation census of 2026-10-02 (up to ten conversations per map played to
  their end) **77/83** are clean and the rest stop only at Stage 5 AI navigation
  natives (518, 523) and the ReachablePathnodes iterator.
- Interactions outside Training remain unprobed. The census continues past
  deferred boundaries with declared zero results; behavior downstream of those
  returns is not original-game fidelity evidence. Implementing those features
  may expose additional runtime work.
- Saves, map travel and the measured fresh-entry `PlayerTraveling` marker remain
  explicit Stage 6 tolerances. AI navigation, broader movement, combat and other
  gameplay systems belong to Stage 5.

The [exit criteria and measured results](stage-3-exit-criteria.md) are the
current status. The [September 20 audit](stage-3-completion-audit.md) and
[earlier handoff](stage-3-handoff.md) are historical checkpoints.

## Stage 4 presentation — complete 2026-10-17

The adopted gate (`scripts/validate-stage4-acceptance.mjs`) passes 70 of 70
criteria in one run, and 26 maps match the original's own frames at matched
cameras and level time (122 of 130 views, [visual acceptance](visual-acceptance.md)).
Each item runs in Play from translated original code, with the evidence and
limits in the linked document. The [roadmap](roadmap.md#4-restore-the-remaining-presentation)
keeps the dated record.

- **Meshes:** original LOD-mesh lighting for NPCs, props and the first-person
  weapon, with every LightType ([mesh lighting](mesh-lighting.md)), with
  GetFrame and lighting on the GPU, bit-exact with the CPU kernels
  ([GPU mesh](gpu-mesh.md)); DrawLodMesh's distance LOD (count
  selection, vertex morph, collapsed faces and interpolated UVs, bit-equal to
  Render.dll at the pass's 24 bits) on both paths ([LOD](script-lodmesh-lod.md)).
- **Visibility:** Render.dll's OccludeBsp, master frame, dynamics, moving
  brush tracker and mirror/sky child frames in the Rust core, bit-exact; Play
  draws each frame's polygons, mirrors, sky and fog surfaces from its own
  result ([BSP occlusion](bsp-occlusion.md)), and decals and fog on movers
  ([brush tracker](brush-tracker.md)).
- **Light maps:** Render.dll's static path, DefaultTexture for untextured
  surfaces ([static lighting](static-lighting.md)); pulse, flicker,
  strobe and waver lights re-merged each frame; moving lights such as AugLight
  and security cameras on BSP and mover light maps
  ([moving lights](moving-normal-lighting.md)); movers drawn from their
  brush polygons.
- **Mirrors:** every static and mover mirror plane, nested to the original
  recursion depth, with the player in reflections
  ([mirror surfaces](mirror-surfaces.md)).
- **Textures and effects:** Fire.dll fire and water textures
  ([fire textures](fire-texture.md)), animated and auto-panned surfaces
  ([texture animation](texture-animation.md)), particles and sprites
  ([particles](particles.md)), light coronas ([coronas](coronas.md)),
  laser beams ([lasers](lasers.md)), volumetric fog on BSP surfaces
  ([volumetric fog](volumetric-fog.md)) and decals such as the Shadow
  blobs under pawns ([decals](decals.md)).
- **Sound and music:** Galaxy's ambient and script sounds, effect voices and
  zone reverb through its own mixer ([galaxy audio](galaxy-audio.md)),
  and each map's music, from the original loader, sequencer, mixer and Update
  music section, bit-exact with Galaxy.dll ([Galaxy music](galaxy-music.md)).
- **Conversations:** the third-person conversation camera and letterbox
  ([conversation camera](conversation-camera.md)) and speech-driven lip
  sync ([lip sync](lip-sync.md)).
- **Options menus:** Esc > Settings opens the original Controls, Customize
  Keys, Game options, Display, Brightness, Sound and Adjust Colors screens.
  They run the original scripts over the translated ScaleWindow value-string
  natives, Core casts and `get`/`set ini:` on the engine's native config
  classes ([settings menus](settings-menus.md),
  [native config](script-native-config.md)). Brightness drives the display
  ramp, the volume sliders the Galaxy mixer, Decals the decal pass, Mouse
  Sensitivity and Invert Mouse the original `PlayerInput`. INI files are not
  written back (Stage 6); UI Background = Snapshot and Toggle Full-Screen are
  explicit boundaries.

**Carried past the close** (no gating row holds them): the security cameras'
window views, a pointer focus difference, the Wine brightness gap, the gate's
concurrency flakes (the official run is `--jobs 1`) and speech's decoded audio,
excluded by decision ([Stage 4 close](stage-4-exit-criteria.md#stage-4-close)).

## Stage 5 gameplay — complete 2026-10-21

The [Stage 5 exit criteria](stage-5-exit-criteria.md) define 50 scenarios on
the three Training maps and Liberty Island, each with the original-side evidence
that would prove it. `scripts/census-stage5.mjs` drives them all in Play (50 play
as of 2026-10-19), and `scripts/validate-stage5-acceptance.mjs` is the gate.

**Gate: 50 of 50 pass, none fail** (the official run on master 3230773, 2026-10-21:
[Stage 5 close](stage-5-exit-criteria.md#stage-5-close)). The passing
rows are proven by live traces of the original game: `DeusEx.exe` runs under
CrossOver (the Mac) or Wine (the Linux host) with a tracer (`tools/dx-live-win.c`, `scripts/live-original.sh`) that
records the watched actors, the random stream, the AI events and every object
creation per tick. Play then replays the same inputs and must match them tick by
tick (`scripts/validate-stage5-live.mjs --scene <tag>`, stored scenes of the Island and the three Training maps). Two
rows on native movement bodies are O3 comparisons instead: every call of the ladder and
crate-stack scenes, replayed through Engine.dll on Play's recorded inputs
(`scripts/validate-stage5-o3.mjs`). Proven so far:

- **Combat:** the player's pistol against a Terrorist, NPCs firing at the player,
  knockouts, an explosion's damage and noise, the player's death to the level's end.
- **Stealth:** Training's stealth maze (a soldier sees the player, trips the alarm units,
  the soldiers turn neutral and the exit door closes until Switch0), a patrolling
  Terrorist seeing the player, a pawn finding a body,
  a broken laser beam raising the alarm, hacking the laser trap's control panel,
  a shot waking and drawing the guards, a run's footsteps heard by a guard where a walk's
  are not, a security camera raising the alarm that
  wakes the turret, an EMP grenade against the bot, the turret and the camera, and a
  Terrorist who sees the player in the light and not in the shadow.
- **Conversations:** Training's M00MeetPage and holo-Jaime, MeetPaul's weapon choice, Filben's key, Gunther's rescue and the
  weapon the player gives him, the commander's branches, overheard conversations and barks, and the
  flags that change the world.
- **Exploration:** breath and drowning under water, the contaminated pool with and without
  the HazMat suit, carrying and throwing a decoration, fall damage, jumping, the ladder,
  pushing and climbing a crate, AugLight in the dark room, items and skill points; Training's
  doors, key ring, lockpick, datacube, keypads and Multitool hack, the cadet's body carried to the
  table, the repair and medical bots' windows, and the Island's personal and security terminals
  and its ATM, driven by key edges, with the terminals' frames.
- **Combat (Training):** the crowbar breaking the crates (and the DataLink that follows),
  the pistol and rifle ranges (the scope's FOV, the skill the Mission00 timer grants), a
  LAM on the breakable wall, the instructor taking the inventory.
- **Routes and objectives:** the airshaft and water routes, the back entrance through
  a door blown open by a rocket, killing or sparing the commander, and the mission's completion.

Collision and line traces now read the moving brush tracker's level model, as the
original's do (doors and lifts block shots, moves and spawns where they were last
drawn; checked against Engine.dll). The dying player's camera starts from the body's
rotation, as the engine's draw passes it, and a breakable door's fragments are placed
as Engine.dll's FindSpot places them, NaN probes included. The user adopted the criteria on
2026-10-21 ([decisions](stage-5-exit-criteria.md#what-the-user-decided-2026-10-21)); the placed approaches were re-captured with held keys on 2026-10-21 (`air2`, `obs1`, `swm3`; [held keys](stage-5-exit-criteria.md#held-keys-2026-10-20)).
Swimming, ladders, pawn navigation, doors opened by NPCs and the intro cinematic
also run from translated original code ([roadmap](roadmap.md#5-implement-the-full-gameplay-systems)).

## Stage 6 campaign — complete 2026-10-26

The [Stage 6 exit criteria](stage-6-exit-criteria.md) define 54 rows (3 more are
excluded): the start and the menus, persistence (saves, loads, return visits), the
transitions, and per mission its required chain, both sides of its lasting choices and
every conversation, the three endings, and the campaign in one run.
`node scripts/stage6-criteria.mjs` prints the scoreboard. **All 54 pass.**

- **Mission chains** (6.4.NN.1, [chains](stage-6-chains.md)): each mission is a
  scripted route of placed steps (conversations and their choices, computers, keypads,
  map exits) run in Play (`scripts/chain-play.mjs`) and in the original under Wine
  (`scripts/chain-original.mjs`) from the same save. The flags, door states and travel
  text at every snapshot are compared (`scripts/validate-stage6-chain.mjs`).
- **Carried choices** (6.4.NN.2, [flag census](stage-6-flag-census.md)): 66 units, one
  for each side of each lasting flag, compared on what the later mission's reader observes
  (`scripts/validate-flag-census.mjs`).
- **The campaign in one run** (6.6.1): one Play process from New Game through all fourteen
  chains to ending 3 (86 map changes). Each mission's exit text equals the original's
  (`scripts/validate-full-run.mjs`).

What the original itself varies between runs is not compared: a flag a script draws with
`FRand` is checked by presence only, fights the placements would provoke are kept from
starting (the player is undetectable there), and doors that close again by themselves are
not read. Everything a chain's steps decide is compared exactly. Play fixes the comparisons
found: the camera's zone stamped every frame (pawns near the player stay awake), FName
spelling across levels (map actors' Name properties included), class defaults carried
across travel, a loaded level keeping its file's URL, and the first tick after a load
spanning the load (the page). The user closed the stage on 2026-10-26 on the rows' last
runs, without a gate that runs every proof together on one commit (Stages 4 and 5 had one);
the rows that last ran before the Play fixes above are named in
[the exit criteria](stage-6-exit-criteria.md#stage-6-close).

## Stage 7 browser runtime — in progress

The [Stage 7 exit criteria](stage-7-exit-criteria.md) (adopted 2026-10-28) define 34
rows plus 3 exclusions: supported browsers, frame time, loading time, memory and long
sessions, audio, window and input, graphics failures, files and storage, failure
recovery and regression coverage. `node scripts/stage7-criteria.mjs` prints the
scoreboard. At its adoption (2026-10-28) 1 row passed, 18 were partial, 2 failed
and 13 had no proof yet. The browser suite passes 41 of 41 in Chromium and Firefox
on Linux; WebKit, Safari and the Mac have not run it. Frame time, loading time and
memory still need their measurements on the reference machine.

## Roadmap summary

- **Stage 0:** validate original packages and dependencies — complete.
- **Stage 1:** render training with textures and an inspection camera — complete.
- **Stage 1.5:** restore original static lighting and shadows — complete.
- **Stage 2:** playable movement/collision/door slice delivered; remaining validation deferred.
- **Stage 3:** original script/native runtime and object lifecycle — complete for
  the Training gate and all 83 single-player maps' startup census; coverage limits
  are recorded above.
- **Stage 4:** restore animated actors, visual effects, audio, and original interfaces —
  complete (2026-10-17, gate 70 of 70).
- **Stage 5:** complete movement, AI, combat, stealth, RPG systems, and conversations —
  complete (2026-10-21, gate 50 of 50).
- **Stage 6:** persist saves and map state, then validate the full campaign —
  complete (2026-10-26, 54 of 54 rows).
- **Stage 7:** meet browser compatibility, performance, and reliability targets.

The numbered stages and acceptance criteria are in [the roadmap](roadmap.md).
We are building an independent browser runtime through reverse engineering of the
original data, UnrealScript bytecode, and native behavior. The runtime does not
execute Windows binaries; the original DLLs run only in the optional local
comparison tools. Gameplay uses our own VM and native function implementations;
SurrealEngine's capabilities do not define our support targets.
