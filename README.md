# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. The current build delivers the **Stage 2 playable slice**: training and Liberty Island have player movement and collision,
and training's starting door pair opens, closes and pushes the player. Final
original camera/motion acceptance remains tracked. Stage 3 runtime and gameplay
work is in progress. The latest gameplay checkpoint recovers the base Trigger
touch path and VM Switch/ClassIsChildOf support. The current foundation work
connects original property copying and destruction to class defaults and logical
object cleanup; see the [Stage 3 handoff](docs/stage-3-handoff.md).

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
- Walking bob executes the original `Engine.PlayerPawn.CheckBob` bytecode from
  the local installation through a small VM prototype.
- Unit/format tests, real-data validation commands, and browser regression tests.
- An optional local native-DLL comparison checks collision directly against the
  original. Combined world/actor queries match 10,980 rays, 7,320 extent traces,
  and 402 complete placement chains across Training and Liberty Island.
  Original walking, falling, landing, camera math and support-base routines have
  separate native comparisons and are connected to the dry-player slice. Combined
  physics matches 63 original frames/2,547 queries, and nine moving-door scenes
  match ordered geometry, movement and events. Whole-scene acceptance remains. See
  [movement evidence](docs/movement.md) and [level queries](docs/level-queries.md).

**Current boundary:** the final original camera/motion comparison and actual
window/tab pause acceptance remain open. Broader script execution, mission events,
characters and other actor meshes, AI, audio, conversations and wider gameplay
remain future work. Script-controlled lighting still needs its original
brightness/cache invalidation and renderer update path in Stage 3; reflections
(including the polished training floor) and renderer polish remain Stage 4 work.
Procedural water displays its original source image statically. The training map
is the visual acceptance target; other maps expose diagnostics for unsupported
content. See the [rendering contract](docs/rendering.md) and [movement evidence
and open work](docs/movement.md).

## Open the viewer

Use Node 22.12 or newer (or a newer supported Node LTS release):

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. With the extracted `Deus Ex GOTY Edition/` directory
present, training loads automatically. Otherwise choose the game folder containing
Maps, Textures, and System. The local production preview always uses this folder picker.
Original data is kept outside source control and outside the website build.

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
- **Stage 3:** implement the original script/native runtime and object lifecycle —
  in progress; the current checkpoint includes live Training DataLinks, mission
  triggers, and the original player augmentation startup through the explicit
  NanoKeyRing boundary.
- **Stage 4:** restore animated actors, visual effects, audio, and original interfaces.
- **Stage 5:** complete movement, AI, combat, stealth, RPG systems, and conversations.
- **Stage 6:** persist saves and map state, then validate the full campaign.
- **Stage 7:** meet browser compatibility, performance, and reliability targets.

The numbered stages and acceptance criteria are in [the roadmap](docs/roadmap.md).
We are building an independent browser runtime through reverse engineering of the
original data, UnrealScript bytecode, and native behavior. The current reader does
not execute Windows binaries. Gameplay will use our own VM and native function
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
