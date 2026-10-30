# Development guide

How to run, debug, test and inspect the project locally. It was part of the
repository's README until 2026-10-30; the [README](../README.md) has the short
version. The rules every change follows are in [AGENTS.md](../AGENTS.md).

## How Play runs

- **Simulation in a worker.** By default the game simulation (script ticks,
  physics, the HUD's window tree, the render scans and Galaxy's Update) runs in
  a module Web Worker. Each frame it posts a plain-data snapshot that the page
  draws with three.js/WebGL2. `?sim=inline` keeps the simulation on the page;
  the Training previews, the NPC focus list and `?simVerify=1` need it. See
  [simulation worker](sim-worker.md).
- **Rust core.** Script bytecode runs in the Rust interpreter
  (`native/script-vm`, compiled to WebAssembly). The same crate holds the
  tick's event and state dispatch, pawn and actor physics, BSP occlusion, the
  render and light scans, particles, Fire.dll textures, the light-map merge,
  the volumetric fog loop and lip-sync analysis. New runtime work goes there
  first; JavaScript is host glue (three.js, DOM, Web Audio, validators). Each
  port keeps its JavaScript or oracle reference and a `js`/`verify` URL switch.
  See [Rust core](rust-core.md).
- **GPU meshes.** Actor GetFrame interpolation and DrawLodMesh lighting run as
  WebGL2 passes, bit-exact with the CPU kernels (`?gpuMesh=0` selects the CPU
  reference; software WebGL keeps it). See [GPU mesh](gpu-mesh.md).
- **Frame hitch recorder.** `?hitchlog=1` records every frame's page, worker and
  WebGL timings plus per-second heaps, wasm memories, renderer counts and shader
  programs; Ctrl+Shift+H saves a JSON for `scripts/analyze-hitchlog.mjs`. Off,
  it installs nothing. See [hitch recorder](hitch-log.md).
- **Music and sound.** Galaxy's sequencer and mixer run in Rust inside an
  AudioWorklet, fed directly by the simulation over a MessageChannel: music,
  sound-effect voices and zone reverb (`?sfx=webaudio` keeps the older Web
  Audio effects path). See [Galaxy music](galaxy-music.md) and
  [galaxy audio](galaxy-audio.md).

Frame cost and the 120 fps target are tracked in
[play frame cost](play-frame-cost.md) and the
[Play CPU plan](play-cpu-plan.md).

## Run the game locally

Use Node 22.12 or newer (or a newer supported Node LTS release), and a Rust
toolchain with the WebAssembly target (tested with Rust 1.99):

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run dev
```

Open `http://127.0.0.1:5173`. The page starts as the original does: the splash, then
the logo map with its camera flight, in the original's 4:3 shape; Escape opens the main menu,
whose Training button travels to training (docs/boot.md, docs/travel.md). The first click takes
the mouse, as the original captures it; the page stays in its window. Alt+Enter, the original's
fullscreen toggle (or the Display menu's Full-Screen choice), takes fullscreen and the mouse, and
gives them back: in Chrome or Edge, in fullscreen, Escape reaches the game and keeps the mouse (hold
Escape to leave fullscreen). In a window, or in Firefox and Safari, Escape also releases the mouse and the next click takes it back. Every binding of the
original's User.ini reaches the game: the keys, the three mouse buttons and the wheel (weapon and item switching), and in
fullscreen in Chrome or Edge the keys a browser reserves for itself (F1 to F12, Tab…) (docs/input-bindings.md). With the extracted
`Deus Ex GOTY Edition/` directory present this happens at once; otherwise choose the game
folder containing Maps, Textures, System and Help. The local production preview always uses
this folder picker. Your saves: the original's Load Game screen lists the saves the page keeps in the browser
(the page's own Saves window opens from a Saves button shown beside the picture while a menu is open, and from the folder screen), or in a
`Save` folder you pick (Chromium: the desktop game's own, or the game folder), and imports a desktop `Save` folder or
exports a zip in Firefox and Safari; the dev server also lists the game folder's `Save`, read-only (docs/save-storage.md).
Saving and loading work in the original's format (docs/travel.md "Play, step 4"): the Load Game screen, the QuickLoad key (numpad `/`) and the menu after a death load a slot, the desktop game's own slots included (41 of 41 real slots load; the AC fans of `09_NYC_ShipFan` spin as the original's do, [rotating brushes](rotating-brushes.md)).
`http://127.0.0.1:5173/?debug=1` is the debugging page described below:
the toolbar, Play/Inspect, the map list (training loads first) and the diagnostics.
Original data is kept outside source control and outside the website build.

`npm run dev`, `npm run build` and `npm test` first compile the three Rust
crates under `native/` to WebAssembly (`npm run build:wasm`): `script-vm` (the
simulation core and render kernels), `lodmesh-kernel` (mesh posing) and
`galaxy-kernel` (music). Rebuild after changing Rust code.

Each Vite server keeps its pre-bundled dependencies (three.js) in `.vite-cache/` under the
root it serves (`cacheDir` in `vite.config.mjs`; ignored), not in `node_modules/.vite`.
Worktrees often symlink `node_modules` to the main checkout's; with one shared cache, a
server started from another checkout deleted and rebuilt it (Vite's cache key includes the
root), and a page loading meanwhile got `504 (Outdated Optimize Dep)` for three.js.

On the debugging page (`?debug=1`): in **Play**, the installed key bindings apply: WASD moves, Space jumps, X
crouches, Shift walks, left click fires, right click uses, number keys select
belt items and Escape opens the main menu. Double-click locks the mouse. In
**Inspect**, WASD/arrow keys fly, Q/E move down/up, and Shift increases speed.
**Player start** reloads the map's player start in Play, or resets the
inspection camera in Inspect. **Give loadout** (Tools) gives JC the Dragon's
Tooth sword, the stealth pistol, assault rifle, assault shotgun, sniper rifle
and GEP gun, 10 lockpicks, 10 multitools, 5 medkits and 5 bioelectric cells,
every augmentation at its top level, the skills, full ammunition and 100,000
credits; `?debug=1&loadout=1` gives it at each Player start and each map opened
from the list (not after a travel or a loaded game, whose inventory is the
player's). It runs the original's own code through the console command chain
(`src/viewer/debug-loadout.mjs`): each item is `summon`ed and picked up by
`ParseRightClick`, then the cheats `AllAugs`, `AllSkills`, `AllAmmo` and
`AllCredits` run. Two fields are written by hand: `bCheatsEnabled` first, as
for `?cheat=`, and `FrobTarget` before each pickup, the stand-in for aiming at
the item. Training's mission script still confiscates the inventory where the
original does (Mission00, MunitionsTrooperReady). **Diagnostics** provides
wireframe, actor markers, surface inspection, counts, and format notes. It also offers an
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

`npm run test:browser` runs the browser suite once per Playwright project:
`chromium`, `firefox`, and `webkit` on macOS (install it there with
`npx playwright install webkit`); `npm run test:browser -- --project firefox`
runs one. The last run by browser is in
[the Stage 7 criteria](stage-7-exit-criteria.md#the-browser-suite-by-browser).
While the checkout is being edited (a dev server reloads the page when a
served file changes), `DX_SUITE_TREE=<worktree>` serves a frozen worktree of
the commit under test on ports 5195 and 5196 instead; it needs its own
`node_modules` link, game folder link, Wasm build and `dist`.

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
node scripts/validate-stage5-acceptance.mjs --jobs 4 --report .work/stage5-gate.json   # census and replays side by side
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
[Data findings](extracted-data.md) and [rendering notes](rendering.md)
record the source links and limits. SurrealEngine is a reference, not a runtime
dependency. Three.js supplies the browser renderer.
