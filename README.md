# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. **Stage 3 is complete within its adopted scope:**
Training passes all five runtime criteria across 95 probes, and all 83
single-player maps reach only boundaries assigned to later stages in the startup
census. **Stage 4 presentation is in progress**: original mesh, static, animated
and moving lighting, BSP occlusion, mirrors, Fire.dll textures, particles,
coronas, lasers, volumetric fog, ambient sound, Galaxy music and the conversation
camera with lip sync already run from original evidence (see below). See the
[completion record and coverage limits](docs/stage-3-exit-criteria.md#stage-3-beyond-training-the-all-maps-startup-census).

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
- Weapons: number keys run the original `ActivateBelt N`; the crowbar draws in
  first person through `PutInHand`/`BringUp` and swings through the original
  ticked weapon states. Two hits break a Training crate into its original
  fragments and contents ([weapon equip](docs/script-weapon-equip.md),
  [crate destruction](docs/script-crate-destruction.md)).
- DataLinks, InfoLink transmissions and first-person and third-person
  conversations run the original ConPlay scripts, with subtitles, speech and
  mission timers ([DataLink scope](docs/script-datalink-live.md),
  [conversation](docs/script-instructor-conversation.md),
  [conversation camera](docs/conversation-camera.md)).
- Every visible actor mesh draws with original lighting
  ([NPC mesh preview](docs/npc-mesh-preview.md), [mesh lighting](docs/mesh-lighting.md)).
  Distance LOD remains unfinished.
- Unit/format tests, real-data validation commands, and browser regression
  tests. Optional local native-DLL comparisons check translated routines against
  the original DLLs under an emulator ([native exec diff](docs/native-exec-diff.md),
  [level queries](docs/level-queries.md)).

**Current boundaries:** Stage 3 completion covers the measured runtime paths,
not every interaction or full campaign compatibility. AI navigation, combat and
the other gameplay systems are Stage 5; saves and map travel are Stage 6 (map
travel stops at a labeled `ClientTravel` boundary). Remaining Stage 4 work is
listed below. Training is the visual acceptance target; other maps expose
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

## Stage 4 presentation — in progress

Each item runs in Play from translated original code, with the evidence and
limits in the linked document. The [roadmap](docs/roadmap.md#4-restore-the-remaining-presentation)
keeps the dated record.

- **Meshes:** original LOD-mesh lighting for NPCs, props and the first-person
  weapon, with every LightType ([mesh lighting](docs/mesh-lighting.md)), with
  GetFrame and lighting on the GPU, bit-exact with the CPU kernels
  ([GPU mesh](docs/gpu-mesh.md)).
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

**Still open in Stage 4:** UnrealScript inside the render events at the
pass's 24-bit precision; distance LOD in Play (Render.dll's selection, morph
and reduced faces are translated bit-exact, [mesh LOD](docs/script-lodmesh-lod.md),
not yet drawn); the security computers' camera views (the ViewportWindow
family runs, its world pass is not drawn, [computer terminals](docs/script-window-computer-terminals.md));
per-frame fog maps in mirror and sky frames; the darkest-pixel rounding and
live scenes left by [visual acceptance](docs/visual-acceptance.md) (26 maps
compared with the original's own frames at matched cameras and level time).

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
  in progress; see the Stage 4 section above.
- **Stage 5:** complete movement, AI, combat, stealth, RPG systems, and conversations.
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
