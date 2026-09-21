# Deus Ex on the web

The aim is to make the original Deus Ex playable in a browser using its original
maps, assets, and game behavior. Training and Liberty Island have the **Stage 2
playable movement/collision slice**. **Stage 3 is in progress:** original scripts
now drive Training doors, light switches, selected mission/damage triggers,
player augmentation startup and the direct DataLink lifecycle. Current native
work covers UI controls and NPC movement, perception and navigation. These are
documented subsets; general script compatibility and complete NPC behavior are
still unfinished. See the current checkpoint below and the
[Stage 3 completion audit](docs/stage-3-completion-audit.md).

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
- Play now shows the original health silhouette, energy meter and turning
  compass. Original HUD bytecode reads live player state. InfoLink transmissions
  use the original frame textures, portraits and bitmap fonts, replacing the
  browser-styled dialog ([visible HUD scope](docs/script-play-hud.md)). Walk
  forward from Training's spawn to see Jaime's transmission.
- Training automatically shows **14 original character/bot meshes** in Play and
  Inspect, including the people beside and behind Jaime. **NPC mesh preview →
  Focus** jumps the inspection camera between them. The meshes stay visible after
  returning to Play or resetting to Player start. These are static, texture-only previews; NPC startup,
  lighting and AI remain unfinished. The four guards currently require unsupported
  reflective materials. See [preview scope and evidence](docs/npc-mesh-preview.md).
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

**Current boundary:** the final original camera/motion comparison and actual
window/tab pause acceptance remain open. Broader script execution, the complete
live object/resource graph, NPC behavior and generic conversations remain
unfinished. The verified light-switch brightness path does not establish every
light effect or cache-invalidation branch. Animated characters, the remaining
native UI presentation, audio mixing, reflections (including the polished training floor)
and renderer polish remain Stage 4 work.
Procedural water displays its original source image statically. The training map
is the visual acceptance target; other maps expose diagnostics for unsupported
content. See the [rendering contract](docs/rendering.md) and [movement evidence
and open work](docs/movement.md).

## Stage 3 checkpoint — 2026-09-19

- **Toward visible NPCs:** the runtime now reads the complete original v68
  LodMesh payload and resolves its texture references. GM_Trench exposes all
  366 vertex frames and 71 sequences on the same resource used by PlayAnim.
  Deferred loading, remapping and signed vertex unpacking are compared with
  original DLL execution. GetFrame now produces transformed, interpolated
  vertices with persistent tween caches and all four additive blend channels;
  46 complete original-DLL calls match byte for byte. Jaime's original helpers
  and animation tick feed this same pose path. The browser now draws 14
  Training NPC meshes through the shared frame/material path, re-posed live
  from the runtime's animated fields. Reduced LOD, original mesh lighting and
  the four environment-mapped troop surfaces remain unfinished
  ([mesh payload](docs/script-mesh-payload.md),
  [frame evaluation](docs/script-lodmesh-frame.md)).
- **NPC startup-to-display integration:** the Play host runs the original
  `PreBeginPlay → BeginPlay → PostBeginPlay → SetInitialState →
  PostPostBeginPlay` chain for every pawn-ancestry map actor, ticks them
  through the recovered `ULevel::Tick`/`APawn::performPhysics` path, and the
  renderer resamples live `AnimSequence`/`AnimFrame` through GetFrame every
  frame — NPCs are visible and animating in ordinary Play, across Inspect →
  Play and player reset. `Pawn.PreBeginPlay`'s native `AddPawn` owns
  `Level.PawnList` membership; Shadow spawn reaches the recovered `AttachDecal`
  BSP sweep with `Engine.Client.Decals = true`. Remaining explicit boundaries:
  weapon `SpawnActor` for armed NPCs, `PlayerReplicationInfo` for cameras, the
  `IsValidEnemy`/`FindPathToward` natives, the root-window conversation check,
  and environment-mapped surfaces for the four UNATCO troops
  ([exact boundary and evidence](docs/script-npc-startup-animation.md),
  [Decal startup](docs/script-decal-startup.md)).
- **NPC surfaces and skins:** full-resolution triangle/material/UV decoding
  matches original Render instruction ranges for all 629 LightSwitch/GM_Trench
  faces. Skin selection and GetMeshTexture1013 match 28 full native calls.
  Jaime's authored skins and original SetSkinStyle/ResetSkinStyle now work
  through this runtime boundary ([surface/skin evidence](docs/script-lodmesh-materials.md)).
- **Native mesh loading:** LodMesh construction and serialization now use one
  shared implementation for inspection and the loader graph. Original native
  class defaults, constructor bytes and deferred arrays match the DLL. GM_Trench
  and LightSwitch complete their full 1-object and 733-object EndLoad scopes,
  including the latter's texture dependencies. Play now prepares meshes through
  its existing class-loader records and retained archives, with canonical
  texture references. The larger Play load queue and native release remain open
  ([native mesh loading](docs/script-mesh-load-graph.md)).
- **NPC animation controls:** original PlayAnim, LoopAnim and TweenAnim now
  match 37 complete DLL executions. This also fixes reciprocal frame/tween
  errors that prevented valid FinishAnim waits. Jaime's original animation
  helper bytecode reaches these controls through linked flags and SimAnim
  ([animation evidence](docs/script-animation-controls.md)).
- **NPC animation progression:** main and four-slot blend ticking now match
  38 original-DLL cases, including notifies, AnimEnd, looping and leftover time.
  Jaime's runtime check completes an animation and releases FinishAnim through
  the real linked fields. Full-world admission/state startup and visual
  playback remain open ([tick evidence](docs/script-animation-tick.md)).
- **Actor tick path:** standalone authority Actor.Tick now matches 37 original
  executions, including owner deferral, stasis, animation/script/timer/physics
  order, expiry and Pawn timers. Training's LightSwitch runs its original Frob
  and inherited Tick through this runtime entry in the focused check. NPC
  startup remains open ([actor tick evidence](docs/script-actor-tick.md)).
- **World scheduling:** standalone level scheduling now matches 31 complete
  original-DLL references for live actor-array changes, deferred retries,
  clocks/distances, pause/input and event/cleanup order. The runtime composes
  actual Actor.Tick and CleanupDestroyed; a two-frame Training fixture checks
  owner dependencies and animation completion. Full-world enrollment, native
  host services and NPC startup remain open
  ([level tick evidence](docs/script-level-tick.md)).
- **Tick visibility callbacks:** ShowSelf and CheckEnemyVisible now match
  24 complete original-DLL cases including the real LOS worker. Actor.Tick uses
  these helpers by default; the linked Training check reaches Jaime's original
  SeePlayer function through BSP sight checks and preserves his class's disabled
  EnemyNotVisible probe ([visibility evidence](docs/script-pawn-tick-visibility.md)).
- **NPC perception lighting:** AIGetLightLevel and AIVisibility now match 41
  original-DLL cases, including static-light occlusion, zone ambience, cache
  interpolation and movement sensitivity. AICanSee calls this original chain.
  Training light-switch off/on changes reach the query through real BSP traces;
  three map snapshots also match the DLL. Full startup and Region/clock
  synchronization remain open ([AI lighting evidence](docs/script-ai-visibility.md)).
- **Visible progress:** the health/energy/compass and InfoLink rendering bridge
  connects selected original scripts to the browser. Window.SetConfiguration
  now has ten original-DLL comparisons; bitmap text uses the recovered native
  glyph path and real font pages. Full HUD lifecycle, root scaling, static
  interference and whole-renderer visual equivalence remain open
  ([evidence and boundaries](docs/script-play-hud.md)).
- **Object/runtime foundation:** recovered class/property linking, construction,
  serialization and GC components support the selected live paths. Absent-export
  loading now reaches `CreateExport` and `Preload`; seven classes are checked
  field-for-field against their package bytes, including indexed defaults and
  structs with strings. Play now loads classes and serialized defaults through
  the shared graph: recovered import matching, lazy construction through the
  owning linker, `Preload`, and native property linking. VM/resource identities
  remain canonical. The shared load helper now implements original two-pass
  EndLoad, metadata PostLoad and import cleanup, checked against 17 original
  DLL cases. Function binding has 12 original-DLL comparisons; the shared graph
  finalizes Core.Object's full 652-object metadata queue and 164 functions with
  original native-table inputs. Texture/palette loading now has nine original-DLL
  reference cases; two real textures and their palettes load through the shared
  graph, including nine deferred mip levels and PostLoad. Native-only Sound
  defaults and WAV/MP3 loads now match the DLL too: their load queues finalize,
  lazy bytes retain the canonical archive, and WAV duration matches exactly.
  Meshes and procedural textures still block the full resource lifecycle in Play.
  Native constructor defaults, config/localization, resource
  lifetimes and live-world collection remain incomplete
  ([loader evidence](docs/script-linker-preload.md),
  [original import comparisons](docs/script-linker-imports.md),
  [EndLoad/PostLoad evidence](docs/script-end-load.md),
  [function binding](docs/script-function-bind.md),
  [texture/palette loading](docs/script-texture-loading.md),
  [Sound loading](docs/script-sound-load-graph.md),
  [Play integration](docs/script-load-graph.md)).
- **UI natives:** window layout, text, drawing-command and interactive-control
  translations have original-DLL comparisons. Their scoped host services do not
  establish a complete original UI renderer/input loop
  ([controls](docs/script-window-controls.md),
  [drawing](docs/script-gc-draw-model.md)).
- **NPC natives:** `MoveTo`, `MoveToward`, `TurnTo`, `TurnToward` and
  `WaitForLanding`, including their latent polls, are wired into script dispatch.
  Six perception/target-selection natives and the original AI light/visibility
  natives are wired. AICanSee now preserves the target's cache, movement boost
  and extended return precision. Original NPC physics integration, startup and
  full-world field/clock synchronization remain open
  ([locomotion](docs/script-pawn-locomotion.md),
  [perception](docs/script-pawn-perception.md)).
- **Navigation frontier:** `checkMove`, `walkReach`, physics dispatch,
  `pointReachable`'s worker, `reachMask`, `directReach` and `actorReachable`'s
  worker/exec are translated and compared with original instructions using
  scripted collision boundaries. `flyMove`/`flyReach` now also run through the
  physics dispatcher and walking flight fallback, with 30 original-DLL cases
  checking ordered calls and exact argument/state bits. Navigation is not yet
  wired into script dispatch; swimming/jump helpers and graph pathfinding
  remain open
  ([navigation evidence and next work](docs/script-pawn-nav.md)).

The [completion audit](docs/stage-3-completion-audit.md) records the broader
Stage 3 gates and current loader boundaries. The
[historical handoff](docs/stage-3-handoff.md) predates the latest native batches.
Native counts and passing focused checks describe scoped coverage, not a Stage 3
completion percentage.

## Open the viewer

Use Node 22.12 or newer (or a newer supported Node LTS release), and a Rust
toolchain with the WebAssembly target (tested with Rust 1.95):

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
  in progress; live Training script paths and scoped object lifecycles work,
  UI and NPC native coverage is expanding, and navigation reachability is the
  current implementation frontier. See the checkpoint above for integration gaps.
- **Stage 4:** restore animated actors, visual effects, audio, and original interfaces.
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
