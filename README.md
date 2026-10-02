# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. **Stage 3 is complete within its adopted scope:**
Training passes all five runtime criteria across 95 probes, and all 83
single-player maps reach only boundaries assigned to later stages in the startup
census. **Stage 4 presentation is in progress**: original mesh, static, animated
and moving lighting, mirrors, Fire.dll textures, particles, coronas, lasers,
volumetric fog, ambient sound and the conversation camera with lip sync already
run from original evidence (see below). See the [completion record and coverage
limits](docs/stage-3-exit-criteria.md#stage-3-beyond-training-the-all-maps-startup-census).

The target is **100% original fidelity**. Every supported behavior needs original
data, script, native-code or measured evidence. Unverified substitutes remain
incomplete work. See [the project rule](AGENTS.md).

Delivery is **local only**, as requested. No website is deployed; do not publish
or push further hosting updates unless the user asks.

## What works

- A JavaScript UE1 package reader shared between Node and browser APIs. All 219
  installed packages validate, with no unresolved package dependencies.
- Tagged actor properties and compiled BSP world geometry decode across all 88 maps.
- A Three.js/WebGL2 viewer with palettes, mipmaps, texture mapping, basic surface
  flags, static mover transforms, and an original sky-zone pass.
- Training renders 24,427 triangles, 70 textures, and 25 static movers without
  render errors. Diagnostics show original surface/texture references, actor
  positions, wireframe, and unsupported data.
- Browser folder selection reads the user's local installation without uploading
  game files. The development server can also read this workspace's installation.
- Static lighting from original shadow masks, inherited light defaults, zone
  ambient and mover polygon lightmaps, compared at two original-game cameras.
- Play mode with gravity, jumping, crouching, stairs, BSP and actor collision,
  translating TriggerToggle doors, and pushed decorations that run their original
  `DeusExDecoration.Bump`/physics ([rolling evidence](docs/rolling.md)).
- Using a door runs the original `DeusExMover.Frob` bytecode, so Training's
  locked and non-frobbable doors refuse as the original does, and like-tagged
  double doors open through its own `AllActors` fanout
  ([mover frob evidence](docs/script-mover-frob.md)).
- Training's light switch runs its original four-light `TriggerToggle` fanout;
  steady brightness changes rebuild dependent lightmaps and update their atlas
  tiles ([lighting evidence](docs/script-light-cache.md)).
- Selected mission and damage triggers, player augmentation startup, and all 18
  Training direct Speech-to-End DataLink routes execute against the Play actor
  graph. The InfoLink lifecycle constructs and destroys its six-control shell;
  selected conversation inventory transfers also run through original scripts
  ([DataLink scope](docs/script-datalink-live.md),
  [transfer evidence](docs/script-datavault-image.md)).
- From Training `PlayerStart1`, held forward movement reaches the spawn
  door. Use opens that unlocked pair. The Train nano key north of the east
  wall is picked up into the key ring, and Enter with the ring in hand
  unlocks the trainer door before a second use opens it
  ([nano key](docs/script-nanokey.md)). The munitions instructor is farther
  east and is not reached by this walk.
- Frobbing a Training munitions instructor runs the original first-person
  `ConPlay` conversation: the speaker name and speech-text subtitle panel show
  when the `bSubtitles` preference is on (a discoverable diagnostics toggle,
  seeded from the installed globalconfig) and hide when off, both with original
  speech. `Mission00.Timer` — spawned by `DeusExLevelInfo.SpawnScript` and
  ticked through the shared scheduler — confiscates and destroys the player's
  remaining inventory while standing at the instructor
  ([conversation](docs/script-instructor-conversation.md),
  [window layer](docs/script-window-bounds-update.md),
  [mission timer](docs/script-mission-timer.md)).
- Play constructs the original DeusExHUD: health/energy/compass, the ten-slot
  object belt, ammo, AugLight, frob brackets and log read live state through
  original scripts and native window/GC translations. InfoLink transmissions
  use the original frame textures, portraits and bitmap fonts, replacing the
  browser-styled dialog ([visible HUD scope](docs/script-play-hud.md)). Walk
  forward from Training's spawn to see Jaime's transmission.
- Training automatically shows **every visible actor mesh** in Play and Inspect —
  18 original character/bot meshes plus 46 prop meshes (crates, the crowbar and
  combat-knife pickups, ammo, plants, datacubes, keypads, security cameras, lights
  and the nanokey), so the collidable props JC walks into are no longer invisible.
  **NPC mesh preview → Focus** jumps the inspection camera between the characters.
  The meshes stay visible after returning to Play or resetting to Player start.
  They are lit by the original DrawLodMesh lighting (see Stage 4 below);
  distance LOD remains unfinished, and one procedural NanoKey effect face is
  skipped. See [preview scope and evidence](docs/npc-mesh-preview.md).
- Frobbing a Training weapon, ammo, tool, food or key **picks it up** into JC's
  inventory through the original `HandleItemPickup`/`DoFrob`/`Pickup.Frob` give,
  and the item's world mesh disappears; a carried item follows JC as a based
  rider while walking, and **Player start** returns items to the world. See
  [item pickup](docs/script-item-pickup.md).
- **Selecting** a picked-up weapon draws it in hand through the original
  `PutInHand`/`UpdateInHand`/`SwitchWeapon`/`BringUp`/`PlaySelect` path (number
  keys invoke the original `ActivateBelt N`; the `Crowbar preview` button places
  JC beside the Training weapons, picks up the crowbar, equips its actual
  belt slot and faces the stacked crates). Left click or Enter swings the crowbar through the original
  ticked weapon states and mesh notify. Two hits break a Training crate,
  spawning its original wood fragments and Lockpick contents; fragments
  bounce, fade and expire, and Player start restores the crate. The first-person
  mesh follows original RenderOverlays/CalcDrawOffset and GetFrame and takes the
  original mesh lighting. See [weapon equip](docs/script-weapon-equip.md),
  [weapon fire evidence](docs/script-weapon-fire.md),
  [crate destruction](docs/script-crate-destruction.md), and
  [weapon rendering](docs/script-weapon-rendering.md).
- Walking bob executes the original `Engine.PlayerPawn.CheckBob` bytecode from
  the local installation through the bounded script VM.
- Unit/format tests, real-data validation commands, and browser regression tests.
- An optional local native-DLL comparison checks collision directly against the
  original. Combined world/actor queries match 10,980 rays, 7,320 extent traces,
  and 402 complete placement chains across Training and Liberty Island.
  Original walking, falling, landing, camera math and support-base routines have
  separate native comparisons and are connected to the dry-player slice. Combined
  physics matches 63 original frames/2,547 queries, and nine moving-door scenes
  match ordered geometry, movement and events. Whole-scene acceptance remains. See
  [movement evidence](docs/movement.md) and [level queries](docs/level-queries.md).

**Current boundaries:** Stage 3 completion covers the measured runtime paths,
not every interaction or full campaign compatibility. Remaining Stage 4 work
includes fog on meshes and movers, mirror/sky combinations, SpriteAnimOnce
frames, animated mesh skins, decals, music, zone reverb and Galaxy's mixer,
time-varying moving lights, BSP occlusion and remaining native UI
presentation. Training is the visual acceptance target; other maps expose
unsupported-content diagnostics. The final original camera/motion comparison
and actual window/tab pause acceptance deferred from Stage 2 remain open. See
[rendering](docs/rendering.md) and [movement](docs/movement.md).

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
  weapon ([mesh lighting](docs/mesh-lighting.md)), with GetFrame and lighting
  on the GPU, bit-exact with the CPU kernels ([GPU mesh](docs/gpu-mesh.md)).
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
  laser beams ([lasers](docs/lasers.md)) and volumetric fog on BSP surfaces
  ([volumetric fog](docs/volumetric-fog.md)).
- **Sound and conversations:** Galaxy's ambient and script sounds
  ([galaxy audio](docs/galaxy-audio.md)), the third-person conversation camera
  and letterbox ([conversation camera](docs/conversation-camera.md)) and
  speech-driven lip sync ([lip sync](docs/lip-sync.md)).

Several of these effects run every frame. The heavy loops (mesh posing and
lighting, Fire.dll ticks, the fog loop, lip sync) run in the Rust/WebAssembly
core or on the GPU with exact results; the per-map frame cost, the A/B
measurements and the remaining work toward the 120 fps target are in
[play frame cost](docs/play-frame-cost.md) and [Rust core](docs/rust-core.md).

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

Development, production builds and unit tests compile the small authored
Rust mesh kernel automatically. Play uses it for exact per-vertex animation
math; scripts and simulation remain JavaScript. If Wasm cannot load, the
existing JavaScript pose path remains available. See the
[measurements and fidelity checks](docs/lodmesh-wasm.md).

Drag to look around, or double-click to lock the mouse. In **Play**, WASD/arrow
keys move, Space jumps, Ctrl crouches, Shift walks, and F/right-click uses a door.
In **Inspect**, WASD/arrow keys fly, Q/E move down/up, and Shift increases speed.
Escape releases the mouse. **Player start** resets the player and doors in Play,
or the inspection camera in Inspect. **Diagnostics** provides wireframe, actor markers,
surface inspection, counts, and format notes. It also offers an original-lighting
toggle, separate display brightness, and exact reference-camera coordinates.
Brightness follows the original D3D display curve: 0.60 is the default; 0.40
leaves framebuffer values unchanged for capture comparisons.

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
validators while developing a Stage 3 slice; a full sweep is not required
after every small change. The runner locates the local native-probe Python
environment automatically and reports failures and skipped checks separately.
It also bounds memory. Validators run in their own process groups. A validator
starts only while the recorded peaks fit the budget (`--mem-budget`, default
half of physical memory up to 8 GiB). One that passes the per-validator cap
(`--mem-cap`, default 6 GiB) is killed and reported as failed. On macOS the
runner measures memory footprint, including compressed and swapped pages, and
it admits fewer jobs under system memory pressure.

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
original data, UnrealScript bytecode, and native behavior. The current reader does
not execute Windows binaries. Gameplay uses our own VM and native function
implementations; SurrealEngine's capabilities do not define our support targets.

## Layout

| Path | Purpose |
| --- | --- |
| `src/unreal/` | Binary package, object, map, texture, and geometry decoding |
| `src/viewer/` | Browser rendering, transforms, camera, controls, and diagnostics |
| `src/runtime/` | Collision, player/door prototype and bounded original-bytecode VM |
| `scripts/` | Inventory, validation, inspection, and geometry exports |
| `test/`, `browser-tests/` | Synthetic binary fixtures and browser regression checks |
| `docs/` | Findings, rendering conventions, sources, and roadmap |
| `vite.config.mjs` | Code-only build and local development data adapter |
| `game/`, `reports/`, `.cache/` | Local data, generated output, references; ignored |

## Format references

The readers were written for this project. Serialized layouts were checked against
SurrealEngine's open-source package, object, model, texture, and palette readers.
[Data findings](docs/extracted-data.md) and [rendering notes](docs/rendering.md)
record the source links and limits. SurrealEngine is a reference, not a runtime
dependency. Three.js supplies the browser renderer.
