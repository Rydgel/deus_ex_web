# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. The current milestone is a working **original-map
viewer**: explore the training map with original textures and static doors, using
a free-flying inspection camera. Collision and gameplay come next.

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
- 23 unit/format tests, real-data validation commands, and browser regression tests.

**Current boundary:** flat inspection lighting; camera passes through walls;
characters and other actor meshes are absent; doors do not animate. Class defaults,
UnrealScript execution, collision, physics, AI, audio, conversations, and gameplay
are future work. Procedural water displays its original source image statically.
The training map is the visual acceptance target; other maps expose diagnostics
for unsupported content. See the [rendering contract](docs/rendering.md).

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

Drag to look around, or double-click to lock the mouse. WASD/arrow keys fly,
Q/E move down/up, Shift increases speed, and Escape releases the mouse. **Player
start** resets the camera. **Diagnostics** provides wireframe, actor markers,
surface inspection, counts, and format notes.

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
npm run export:training
npx playwright install chromium
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

1. Validate original packages and dependencies — complete.
2. Render the original training map with textures and an inspection camera — complete.
3. Add player spawning, gravity, BSP collision, and one original interaction.
4. Implement original game behavior, then expand toward full missions.

The numbered stages and acceptance criteria are in [the roadmap](docs/roadmap.md).
This project does not execute Windows binaries. A general UnrealScript VM or
WebAssembly engine port requires a separate prototype before choosing the runtime.

## Layout

| Path | Purpose |
| --- | --- |
| `src/unreal/` | Binary package, object, map, texture, and geometry decoding |
| `src/viewer/` | Browser rendering, transforms, camera, controls, and diagnostics |
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
