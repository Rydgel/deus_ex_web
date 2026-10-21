# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. **Stage 3 is complete within its adopted scope:**
Training passes all five runtime criteria across 95 probes, and all 83
single-player maps reach only boundaries assigned to later stages in the startup
census ([completion record and coverage limits](docs/stage-3-exit-criteria.md#stage-3-beyond-training-the-all-maps-startup-census)).
**Stage 4 presentation is complete** (2026-10-17): its gate passes 70 of 70 in one
run ([Stage 4 close](docs/stage-4-exit-criteria.md#stage-4-close)). **Stage 5
gameplay is in progress**: its gate passes all 50 criteria (2026-10-20; adopted by the user 2026-10-21), each on
original captures of Liberty Island and Training replayed tick by tick in Play (see below).

The target is **100% original fidelity**. Every supported behavior needs original
data, script, native-code or measured evidence. Unverified substitutes remain
incomplete work. See [the project rule](AGENTS.md).

Delivery is **local only**, as requested. No website is deployed; do not publish
or push further hosting updates unless the user asks.

## How Play runs

- **Simulation in a worker.** By default the game simulation (script ticks,
  physics, the HUD's window tree, the render scans and Galaxy's Update) runs in
  a module Web Worker. Each frame it posts a plain-data snapshot that the page
  draws with three.js/WebGL2. `?sim=inline` keeps the simulation on the page;
  the Training previews, the NPC focus list and `?simVerify=1` need it. See
  [simulation worker](docs/sim-worker.md).
- **Rust core.** Script bytecode runs in the Rust interpreter
  (`native/script-vm`, compiled to WebAssembly). The same crate holds the
  tick's event and state dispatch, pawn and actor physics, BSP occlusion, the
  render and light scans, particles, Fire.dll textures, the light-map merge,
  the volumetric fog loop and lip-sync analysis. New runtime work goes there
  first; JavaScript is host glue (three.js, DOM, Web Audio, validators). Each
  port keeps its JavaScript or oracle reference and a `js`/`verify` URL switch.
  See [Rust core](docs/rust-core.md).
- **GPU meshes.** Actor GetFrame interpolation and DrawLodMesh lighting run as
  WebGL2 passes, bit-exact with the CPU kernels (`?gpuMesh=0` selects the CPU
  reference; software WebGL keeps it). See [GPU mesh](docs/gpu-mesh.md).
- **Frame hitch recorder.** `?hitchlog=1` records every frame's page, worker and
  WebGL timings plus per-second heaps, wasm memories, renderer counts and shader
  programs; Ctrl+Shift+H saves a JSON for `scripts/analyze-hitchlog.mjs`. Off,
  it installs nothing. See [hitch recorder](docs/hitch-log.md).
- **Music and sound.** Galaxy's sequencer and mixer run in Rust inside an
  AudioWorklet, fed directly by the simulation over a MessageChannel: music,
  sound-effect voices and zone reverb (`?sfx=webaudio` keeps the older Web
  Audio effects path). See [Galaxy music](docs/galaxy-music.md) and
  [galaxy audio](docs/galaxy-audio.md).

Frame cost and the 120 fps target are tracked in
[play frame cost](docs/play-frame-cost.md) and the
[Play CPU plan](docs/play-cpu-plan.md).

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
  physics ([movement](docs/movement.md), [swimming](docs/swimming.md),
  [rolling](docs/rolling.md), [doors](docs/doors.md)).
- Using things runs the original frob paths: doors, light switches, keypads,
  DataCubes, the nano key ring, and item pickup into the inventory and object
  belt ([mover frob](docs/script-mover-frob.md),
  [item pickup](docs/script-item-pickup.md)).
- Weapons: number keys run the original `ActivateBelt N`; weapons draw in
  first person through `PutInHand`/`BringUp` and fire and swing through the
  original ticked weapon states. Two crowbar hits break a Training crate into its
  original fragments and contents ([weapon equip](docs/script-weapon-equip.md),
  [crate destruction](docs/script-crate-destruction.md)). On Liberty Island the
  player's pistol hurts and kills Terrorists, hostile NPCs aim and fire back
  (Tracers, hit regions, armor), batons and crowbars knock out, explosions run
  `HurtRadius`, and the player's death runs to the level's end, each compared
  with the original ([Stage 5](docs/stage-5-exit-criteria.md)).
- DataLinks, InfoLink transmissions and first-person and third-person
  conversations run the original ConPlay scripts, with subtitles, speech and
  mission timers ([DataLink scope](docs/script-datalink-live.md),
  [conversation](docs/script-instructor-conversation.md),
  [conversation camera](docs/conversation-camera.md)).
- Every visible actor mesh draws with original lighting
  ([NPC mesh preview](docs/npc-mesh-preview.md), [mesh lighting](docs/mesh-lighting.md))
  and DrawLodMesh's distance LOD ([LOD](docs/script-lodmesh-lod.md); `?meshLod=off`
  draws full detail). An armed pawn holds its gun in every frame that draws him
  (the main frame, mirrors, a security camera's window), posed from its mesh's
  special triangle as Render.dll does and lit right after the pawn in the original's
  order ([weapon attachment](docs/weapon-attachment.md)); on the GPU mesh path
  ([GPU mesh](docs/gpu-mesh.md#a-pawns-weapon-2026-10-15)) unless `?weapons=cpu`;
  `?weapons=off`, `?weaponMirrors=0`).
- Unit/format tests, real-data validation commands, and browser regression
  tests. Optional local native-DLL comparisons check translated routines against
  the original DLLs under an emulator ([native exec diff](docs/native-exec-diff.md),
  [level queries](docs/level-queries.md)).

**Current boundaries:** Stage 3 completion covers the measured runtime paths,
not every interaction or full campaign compatibility. Stage 5 gameplay is
proven only where its gate passes (below); the other gameplay rows play in Play
but have no original capture yet. Saves and map travel are Stage 6 (map travel
stops at a labeled `ClientTravel` boundary). Other maps expose
unsupported-content diagnostics. The final original camera/motion comparison
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

The [exit criteria and measured results](docs/stage-3-exit-criteria.md) are the
current status. The [September 20 audit](docs/stage-3-completion-audit.md) and
[earlier handoff](docs/stage-3-handoff.md) are historical checkpoints.

## Stage 4 presentation — complete 2026-10-17

The adopted gate (`scripts/validate-stage4-acceptance.mjs`) passes 70 of 70
criteria in one run, and 26 maps match the original's own frames at matched
cameras and level time (122 of 130 views, [visual acceptance](docs/visual-acceptance.md)).
Each item runs in Play from translated original code, with the evidence and
limits in the linked document. The [roadmap](docs/roadmap.md#4-restore-the-remaining-presentation)
keeps the dated record.

- **Meshes:** original LOD-mesh lighting for NPCs, props and the first-person
  weapon, with every LightType ([mesh lighting](docs/mesh-lighting.md)), with
  GetFrame and lighting on the GPU, bit-exact with the CPU kernels
  ([GPU mesh](docs/gpu-mesh.md)); DrawLodMesh's distance LOD (count
  selection, vertex morph, collapsed faces and interpolated UVs, bit-equal to
  Render.dll at the pass's 24 bits) on both paths ([LOD](docs/script-lodmesh-lod.md)).
- **Visibility:** Render.dll's OccludeBsp, master frame, dynamics, moving
  brush tracker and mirror/sky child frames in the Rust core, bit-exact; Play
  draws each frame's polygons, mirrors, sky and fog surfaces from its own
  result ([BSP occlusion](docs/bsp-occlusion.md)), and decals and fog on movers
  ([brush tracker](docs/brush-tracker.md)).
- **Light maps:** Render.dll's static path, DefaultTexture for untextured
  surfaces ([static lighting](docs/static-lighting.md)); pulse, flicker,
  strobe and waver lights re-merged each frame; moving lights such as AugLight
  and security cameras on BSP and mover light maps
  ([moving lights](docs/moving-normal-lighting.md)); movers drawn from their
  brush polygons.
- **Mirrors:** every static and mover mirror plane, nested to the original
  recursion depth, with the player in reflections
  ([mirror surfaces](docs/mirror-surfaces.md)).
- **Textures and effects:** Fire.dll fire and water textures
  ([fire textures](docs/fire-texture.md)), animated and auto-panned surfaces
  ([texture animation](docs/texture-animation.md)), particles and sprites
  ([particles](docs/particles.md)), light coronas ([coronas](docs/coronas.md)),
  laser beams ([lasers](docs/lasers.md)), volumetric fog on BSP surfaces
  ([volumetric fog](docs/volumetric-fog.md)) and decals such as the Shadow
  blobs under pawns ([decals](docs/decals.md)).
- **Sound and music:** Galaxy's ambient and script sounds, effect voices and
  zone reverb through its own mixer ([galaxy audio](docs/galaxy-audio.md)),
  and each map's music, from the original loader, sequencer, mixer and Update
  music section, bit-exact with Galaxy.dll ([Galaxy music](docs/galaxy-music.md)).
- **Conversations:** the third-person conversation camera and letterbox
  ([conversation camera](docs/conversation-camera.md)) and speech-driven lip
  sync ([lip sync](docs/lip-sync.md)).
- **Options menus:** Esc > Settings opens the original Controls, Customize
  Keys, Game options, Display, Brightness, Sound and Adjust Colors screens.
  They run the original scripts over the translated ScaleWindow value-string
  natives, Core casts and `get`/`set ini:` on the engine's native config
  classes ([settings menus](docs/settings-menus.md),
  [native config](docs/script-native-config.md)). Brightness drives the display
  ramp, the volume sliders the Galaxy mixer, Decals the decal pass, Mouse
  Sensitivity and Invert Mouse the original `PlayerInput`. INI files are not
  written back (Stage 6); UI Background = Snapshot and Toggle Full-Screen are
  explicit boundaries.

**Carried past the close** (no gating row holds them): the security cameras'
window views, a pointer focus difference, the Wine brightness gap, the gate's
concurrency flakes (the official run is `--jobs 1`) and speech's decoded audio,
excluded by decision ([Stage 4 close](docs/stage-4-exit-criteria.md#stage-4-close)).

## Stage 5 gameplay — in progress

The [Stage 5 exit criteria](docs/stage-5-exit-criteria.md) define 50 scenarios on
the three Training maps and Liberty Island, each with the original-side evidence
that would prove it. `scripts/census-stage5.mjs` drives them all in Play (50 play
as of 2026-10-19), and `scripts/validate-stage5-acceptance.mjs` is the gate.

**Gate: 50 of 50 pass, none fail** (2026-10-20). The passing
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
2026-10-21 ([decisions](docs/stage-5-exit-criteria.md#what-the-user-decided-2026-10-21)); the placed approaches were re-captured with held keys on 2026-10-21 (`air2`, `obs1`, `swm3`; [held keys](docs/stage-5-exit-criteria.md#held-keys-2026-10-20)).
Swimming, ladders, pawn navigation, doors opened by NPCs and the intro cinematic
also run from translated original code ([roadmap](docs/roadmap.md#5-implement-the-full-gameplay-systems)).

## Open the viewer

Use Node 22.12 or newer (or a newer supported Node LTS release), and a Rust
toolchain with the WebAssembly target (tested with Rust 1.99):

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run dev
```

Open `http://127.0.0.1:5173`. With the extracted `Deus Ex GOTY Edition/` directory
present, training loads automatically. Otherwise choose the game folder containing
Maps, Textures, and System. The local production preview always uses this folder picker.
Original data is kept outside source control and outside the website build.

`npm run dev`, `npm run build` and `npm test` first compile the three Rust
crates under `native/` to WebAssembly (`npm run build:wasm`): `script-vm` (the
simulation core and render kernels), `lodmesh-kernel` (mesh posing) and
`galaxy-kernel` (music). Rebuild after changing Rust code.

In **Play**, the installed key bindings apply: WASD moves, Space jumps, X
crouches, Shift walks, left click fires, right click uses, number keys select
belt items and Escape opens the main menu. Double-click locks the mouse. In
**Inspect**, WASD/arrow keys fly, Q/E move down/up, and Shift increases speed.
**Player start** reloads the map's player start in Play, or resets the
inspection camera in Inspect. **Diagnostics** provides wireframe, actor markers,
surface inspection, counts, and format notes. It also offers an
original-lighting toggle, separate display brightness, conversation subtitles
and exact reference-camera coordinates. Brightness follows the original D3D
display curve: 0.60 is the default; 0.40 leaves framebuffer values unchanged
for capture comparisons. **Hide UI** gives the game view the whole window, and
**Screen shape** selects the original 4:3 view.

To run the production build locally:

```sh
npm run build
npm run preview
```

The preview uses `http://127.0.0.1:5174` and requires folder selection.

## Validate and inspect data

```sh
npm test
npm run inventory
npm run validate:game
npm run validate:viewer
node scripts/validate-gameplay.mjs
npm run export:training
npx playwright install chromium firefox
npm run test:browser
```

For a full validator sweep, use `npm run validate` (four parallel validator
jobs by default), or explicitly `npm run validate -- --jobs 4`. Use focused
validators while developing a slice; a full sweep is not required after every
small change. The runner locates the local native-probe Python environment
automatically and reports failures and skipped checks separately. It also
bounds memory. Validators run in their own process groups. A validator starts
only while the recorded peaks fit the budget (`--mem-budget`, default half of
physical memory up to 8 GiB). One that passes the per-validator cap
(`--mem-cap`, default 6 GiB) is killed and reported as failed, as is one that
exceeds its time limit. On macOS the runner measures memory footprint,
including compressed and swapped pages, and it admits fewer jobs under system
memory pressure.

The stage gates and the Stage 5 census:

```sh
node scripts/validate-stage4-acceptance.mjs --jobs 1
node scripts/census-stage5.mjs --json .work/stage5-census.json
node scripts/validate-stage5-acceptance.mjs --census .work/stage5-census.json --report .work/stage5-gate.json
node scripts/validate-stage5-live.mjs --scene cmb1
```

They need the stored original captures under `.work/` (kept outside Git); a check
whose capture is absent reports SKIP. New captures need the original game under
CrossOver (`scripts/live-original.sh`, one capture at a time).

Build before browser testing. One mouse-lock check opens a focused Chromium window;
that check requires a desktop session. Browser screenshots go into `reports/browser/`.
The tools discover `Deus Ex GOTY Edition/`, then `game/`, or use `DEUS_EX_GAME_DIR`.

```sh
node scripts/inventory.mjs "/path/to/Deus Ex"
node scripts/validate-game.mjs "/path/to/Deus Ex"
node scripts/validate-viewer.mjs 00_Training
npm run inspect -- "/path/to/Deus Ex/Maps/00_Training.dx"
node scripts/export-map.mjs "/path/to/Deus Ex/Maps/00_Training.dx" reports/training
```

Use the `node` commands directly when redirecting JSON to files; npm adds a status
banner. Create `reports/` before redirecting. Missing input, malformed packages,
or failed validation produce nonzero exit statuses.

The diagnostic training export writes `world.obj`, `summary.json`, `actors.json`,
and `footprint.svg`. It keeps original Unreal units with Z up. Its 25,674 triangles
are the untextured world-only diagnostic mesh, before renderer filtering and
static doors. The footprint overlays every height and is not a game screenshot.

## Roadmap

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
  in progress (gate 21 of 50, 2026-10-19).
- **Stage 6:** persist saves and map state, then validate the full campaign.
- **Stage 7:** meet browser compatibility, performance, and reliability targets.

The numbered stages and acceptance criteria are in [the roadmap](docs/roadmap.md).
We are building an independent browser runtime through reverse engineering of the
original data, UnrealScript bytecode, and native behavior. The runtime does not
execute Windows binaries; the original DLLs run only in the optional local
comparison tools. Gameplay uses our own VM and native function implementations;
SurrealEngine's capabilities do not define our support targets.

## Layout

| Path | Purpose |
| --- | --- |
| `src/unreal/` | Binary package, object, map, texture, and geometry decoding |
| `src/runtime/` | Script runtime host, natives, collision, physics, Galaxy audio and the Wasm kernel wrappers |
| `src/viewer/` | Browser rendering, the simulation worker and its page client, HUD, audio output and diagnostics |
| `native/` | Rust crates compiled to WebAssembly: `script-vm`, `lodmesh-kernel`, `galaxy-kernel` |
| `scripts/` | Inventory, validators, native oracles, censuses and profiling |
| `tools/` | Native capture helpers for the original game |
| `test/`, `browser-tests/` | Synthetic binary fixtures and browser regression checks |
| `docs/` | Findings, recovered contracts, evidence, and the roadmap |
| `vite.config.mjs` | Code-only build and local development data adapter |
| `game/`, `reports/`, `.cache/` | Local data, generated output, references; ignored |

## Format references

The readers were written for this project. Serialized layouts were checked against
SurrealEngine's open-source package, object, model, texture, and palette readers.
[Data findings](docs/extracted-data.md) and [rendering notes](docs/rendering.md)
record the source links and limits. SurrealEngine is a reference, not a runtime
dependency. Three.js supplies the browser renderer.
