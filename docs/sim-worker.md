# Simulation worker (Play CPU plan, Phase 7)

The simulation runs in a module Web Worker while the page's main thread draws
the previous frame. Today a frame costs the sum of both halves; overlapped,
it costs the longer one. This is a host change: the simulation's sequence of
original operations per frame stays exactly as it is now. The plan and its
earlier phases are in [Play CPU plan](play-cpu-plan.md) ("Threads").

## Why

Measured on 2026-10-04 on the Linux host (headless Chromium, `--angle gl`,
UNATCO Island at Player start, 1920×1080, `profile-play-browser.mjs
--no-profile`):

| Run | ms/frame |
|---|---:|
| Play | 25.5–27.5 |
| Play with the simulation off (`--no-simulation`) | 12.9 |

The tick is 11.3 ms: 2.3 ms in Rust and about 9 ms of JavaScript spread over
about 30 files, with no function above 0.45 ms of self time. Bench-sim's
import timing (`SCRIPT_VM_IMPORT_TIME=1`) shows no family above 2 ms: the
walking prelude's 1.66 ms is mostly the 36-trace surface scan, which already
runs in the collision kernel's Wasm instance, and `js_eval`'s 1.97 ms is
spread over about a dozen natives of at most 0.27 ms per tick each. Ports
each save tenths of a millisecond; overlapping the two halves saves the
shorter half.

The CPU profile splits the frame as follows (profiled milliseconds; an
unprofiled frame is about 7% shorter):

| Side | Work | ms |
|---|---|---:|
| Simulation | tick 11.6; actor reads, GetFrame planning and the drawn-set decision 3.2; HUD scripts 1.55; Galaxy update 0.83; render iterators 0.9; moving-light scan, corona line checks, PlayerCalcView 0.6 | ~18.7 |
| Drawing | three.js 4.35; light finish and GPU mesh passes about 2.2; HUD batching and GL 0.47; texture animation, light maps, movers, ramp 0.6 | ~7.6 |

Overlapped, the frame is the simulation side: about 37 → 55 fps on this
machine. GetFrame planning stays with the simulation because the drawn set
decides LastRenderTime (below). After the split every Rust port of tick, HUD
or planning work shortens the frame directly, until the simulation side
reaches the drawing side's ~8 ms.

## What runs where

**Worker (simulation), in today's order within a frame** (main.mjs `animate`):

1. Apply the input queue (keys, buttons, mouse motion, window pointer
   samples, resets) in arrival order.
2. `game.tick(dt)`, including `hud.tick`; then `lipSync.update(dt)`, which
   writes `nextPhoneme`.
3. PlayerCalcView (`game.view()`), the root window's render viewport, the
   sky frame (`SkyZone`, `pointRegion`), the frob target label.
4. SetupDynamics' moving-light scan (`game.movingLights()`) and the mesh
   lighting frame (`meshLighting.beginFrame`, the Rust light context).
5. The sprite scan with the render iterators: RenderInterface construction,
   `Init`, FarMoveActor of the proxies, the shared random stream.
6. The actor mesh scan: admission, `mesh_reads`, item overrides (the laser
   DT_Mesh items, which today are written into the live proxy and restored),
   GetFrame planning, SetupForActor.
7. The drawn set for every pass (mirror children, sky, main) and the
   LastRenderTime stamps, at the point where the main render stamps today.
8. Corona visibility (two collision line checks per leaf light).
9. The weapon's `RenderOverlays` and its draw decision and stamp.
10. The HUD paint (`host.draw`: DrawWindow/PostDrawWindow, GC natives on the
    arena heap) and Galaxy's `update(view)`, in that order as today
    (UGameEngine::Draw updates audio after the frame).
11. The InfoLink accessibility text; status for `deusExViewer.status()`.
12. Publish the snapshot.

**Main thread (drawing):** three.js and every GL resource; textures, light
atlases, moving-light texels, texture animation, fog maps, mirrors' passes,
the GPU mesh passes, sprites and coronas from their lists, the HUD batches
from its command list, the display ramp; the DOM; input capture; Web Audio
(voices, speech, the AudioContext gesture); asset files for its own decoding.

No runtime file uses the DOM (`document`, `window`, canvas, Web Audio):
`createGame(..., {presentation: true})` already boots in Node with the HUD
(bench-sim, training-probe-lib). The window host's "canvas" and "windows" are
native-heap objects.

## Frame protocol

At requestAnimationFrame time `t`, the page:

1. computes `dt` from `t` as today;
2. posts `{frame, dt, input, canvas: {width, height}, audio positions}` to the
   worker, unless the worker is still working on the previous frame;
3. draws the newest snapshot it holds.

The worker runs the simulation frame and posts the snapshot, transferring its
buffers. Frame N's simulation overlaps frame N−1's drawing. The tick order,
`dt` and the stamps are unchanged; the picture shows frame N one display
frame later than today (one frame of added latency). When the simulation
side is longer than a display frame, the page posts a new frame only when
the previous snapshot has arrived, so ticks never queue up.

## The snapshot

Plain data only: numbers, strings, typed arrays, arrays of those. Actor
identities cross as handles (`handleOf`, u32, never reused). Texture and mesh
references cross as `{package, index, key}` and the page decodes them from
its own asset store; the worker never sends package bytes.

| Section | Contents |
|---|---|
| Header | frame, `actorsEpoch`, TimeSeconds, view `{location, rotation, fov}`, render rect, sky `{location, rotation}` or none, target label, runtime error `{name, message, stack, partial, travel}` |
| Movers | per mover: name, position, rotation, collider offset |
| Moving lights | the light records `game.movingLights()` returns, by handle |
| Surface pan | TimeSeconds and the zones' TexUPanSpeed/TexVPanSpeed |
| Lighting changes | the ordered `onLightingChanged` deltas since the last snapshot |
| Sprites | in Level.Actors order: handle, texture, style, location, DrawScale, ScaleGlow, drawn bits per pass |
| Actor meshes | per drawn preview: handle, mesh resource, the GetFrame plan (4×3 matrix and up to five channel ops), SetupForActor's result, material state (Style, ScaleGlow, environment), group visibility bits per pass; creation records (skins, environment textures) when a handle first appears |
| Weapon | the RenderOverlays DrawActor commands and the weapon's plan and lighting |
| Coronas | the corona icons `{x, y, size, color, skin}` after visibility |
| HUD | the GC command list `{texture, x, y, width, height, u, v, ul, vl, color, style}` (glyphs are already DrawTile commands) |
| Audio | Galaxy voice ops (sound bytes once per key), speech start and stop |
| DOM mirror | InfoLink `{visible, title, queued, text}`, notes |

The main thread keeps no reference to a runtime object.

## The drawn set and LastRenderTime

Render.dll copies TimeSeconds to the LastRenderTime of each submitted actor
(actor-render-feedback.mjs). Today three.js decides submission: its frustum
test on each object's bounding sphere, `onAfterRender` stamping in every pass
(mirror children, sky, main, weapon). Scripts and the tick read the stamps in
the next tick: stasis (`actor-tick.mjs`), the Rust tick, LastRendered (723),
ParticleGenerator's and LaserEmitter's freeze checks. A stamp posted back by
the page would arrive one tick late, so the worker decides the drawn set and
the page draws exactly that set.

The rule stays today's host culling ([render visibility](render-visibility.md):
the frustum sphere is host culling, not the original contract). The worker
runs three's own math (`Frustum`, `Sphere`, `Box3`; three imports without a
GL context) on the same inputs:

- movers: the brush mesh's bounding sphere (static, from the model) under the
  mover's matrix;
- sprites: three's sprite sphere (radius √½ × the larger scale) at the sprite's
  matrix;
- GPU-path meshes: the plan's group boxes (`certifyFrustum`), with the exact
  posed sphere when the box is ambiguous (`exactSpheres`, GetFrame on the
  worker);
- CPU-path meshes and the weapon: the posed vertices' sphere (GetFrame on the
  worker);
- mirror children: mirrors.mjs's child cameras, from the main camera and the
  static mirror surfaces.

The page draws with `frustumCulled = false` and the snapshot's visibility.
Stamps no longer depend on the page's asynchronous texture decoding (a sprite
was not drawn, so not stamped, until its texture had decoded); the original
loads textures synchronously, so this is closer to it, and it is a change in
host behavior.

## Modes

- `?sim=inline`: the worker's frame and the page's draw both run on the main
  thread, separated by the snapshot. Validators that patch main.mjs to reach
  `game` keep this mode.
- `?sim=clone`: inline, with the snapshot passed through `structuredClone`,
  proving that it carries only plain data.
- `?sim=worker`: the default once verified.
- `?simVerify=1` (inline only): every frame, the page also reads the live
  runtime the way the drawing modules read it today and compares with the
  snapshot, and three's own culling records the set `onAfterRender` would
  stamp and compares it with the worker's drawn set.

## Input, audio and the DOM

- **Input** becomes a FIFO drained at the start of the next simulation frame.
  DOM events arrive between frames today too, after frame N's draw scripts and
  before tick N+1, so the order is kept. The page needs two synchronous
  answers, `preventDefault` for a key and whether the root window holds the
  mouse grab; the snapshot carries the root's grab flags and the bound keys,
  one frame old.
- **Audio.** The simulation reads nothing back from Web Audio: voice "playing"
  state, PlaySound's result and GetSpeechLength come from bytes and a host
  clock. Voice and speech events cross as messages. Lip sync is the one loop:
  the page decodes speech PCM (`OfflineAudioContext`) and reads the mixer
  position; it sends `{id, pcm}` once and the position each frame, and
  `lipSync.update` runs in the worker.
- **Clocks.** `performance.now()` has a different origin in a worker; the
  Galaxy update and the window host use differences only. Cross-thread
  timestamps add `performance.timeOrigin`.
- **Errors** cross as plain objects; structured clone drops an Error's own
  properties (`partial`, `travel`).

## Boot

`new Worker(new URL('./sim-worker.mjs', import.meta.url), {type: 'module'})`,
with `worker: {format: 'es'}` in vite.config.mjs (script-doors.mjs imports two
modules dynamically). The page posts the game files (`File` objects, or the
dev server's `/__game__/` paths) and the URL switches, which main.mjs today
copies to `globalThis.DEUS_EX_*` before the runtime loads; four kernel
modules read them at evaluation, so the worker sets them before importing
the runtime. Both threads decode the map and hold their own asset store and
Wasm kernels; the simulation does not write the decoded model.

## Steps

| Step | Work | Check |
|---|---|---|
| 1 | Inline split: header, movers, lights, pan, sky, target, DOM mirror | `simVerify`, digests unchanged |
| 2 | HUD command list and Galaxy ops | `simVerify` (command list against a direct paint) |
| 3 | Sprites and render iterators | `simVerify`, validate-lasers-play, -particles-play |
| 4 | Actor meshes: sim-side planning and lighting, page-side drawing | `simVerify`, validate-gpu-mesh, -actor-mesh-scene, -mesh-lighting-play |
| 5 | Drawn set and stamps on the simulation side, mirrors included | `simVerify` drawn-set comparison on Island, Training, a mirror map |
| 6 | Coronas, weapon | validate-coronas-play, weapon view checks |
| 7 | `?sim=clone` | structured clone every frame |
| 8 | Worker boot, input queue, audio and lip-sync bridge | worker runs on Island, Training |
| 9 | Profile, A/B against inline | `ab-play.sh` |

## Open points

- The CPU mesh path (no GPU mesh, or a GPU setPose failure) needs GetFrame on
  the worker for its drawn set; it is the fallback path, so its cost matters
  less.
- Both threads hold their package bytes; sharing them needs SharedArrayBuffer
  and cross-origin isolation headers.
- The previews in main.mjs (Training helpers) call the runtime directly; in
  worker mode they become worker commands or stay inline-only.

## Progress

`scripts/validate-sim-split.mjs` is the check for every step: it loads a
map with `?hold=1&seed=1` under a paused Playwright clock, releases the
frame loop at a fixed time, steps 16 ms frames (walking) and compares the
state digest (`src/runtime/state-digest.mjs`, every script property of
every Level.Actors entry) at checkpoints and the last frame's pixels. The
same page twice gives identical digests and pixels, so the comparison
against the previous commit (served from `.work/base`) is exact.

| Step | Commit | Check |
|---|---|---|
| Harness: `?seed=`, `?hold=1`, state digest | f4fb698 | same page: identical; a different seed differs at the first checkpoint |
| 1 header, movers, lights, pan, sky, target | cfd0b02 | Island, Training: identical digests |
| 2 HUD command list, InfoLink text | 1547238 | Island, Training: identical digests and pixels |
| 3 sprite scan and render iterators | 29238ba | Island, Training, 02_NYC_Street: identical |
| 4 actor meshes: simulation and page halves | (this commit) | Island, Training, 02_NYC_Street, 02_NYC_Smug (mirrors): identical |

Step 4 split `npc-mesh-preview.mjs` into `actor-mesh-sim.mjs` (admission,
mesh_reads, GetFrame planning or the CPU GetFrame, the GPU path's group
bounds and frustum decisions, SetupForActor, the CPU lighting pass) and
`actor-mesh-draw.mjs` (three.js objects, batches, GPU slots, from creation
and frame records). `npc-mesh-preview.mjs` keeps `createActorMeshScene`,
`createTrainingNpcPreview` and `createActorMeshPreview` as wrappers that run
both halves in one thread, for Play and the validators. Details:

- `gpu-mesh-layout.mjs` holds the GPU mesh path's texel allocation and
  light limits without GL; the page's `gpu-mesh.mjs` and the simulation
  side each keep one. The simulation side plans the first GetFrame at
  admission and allocates the slot when the binding is complete, so both
  sides allocate in creation-record order; a binding whose slot does not
  fit materializes its plan (the output getLodMeshFrame gives).
- Both sides resolve a face group's skin with `resolveMeshSkin`
  (`actor-mesh-skins.mjs`), so a skin the page cannot draw drops the group
  on both sides; the page decodes the mesh payload from its own asset
  store (`decodeLodMeshPayload`, the runtime's serializer).
- The page allocates a binding's GPU slot and applies its first plan when
  the creation record arrives, synchronously when the package is loaded
  (`AssetStore.loaded`), so the GPU passes see every plan; textures and
  materials follow asynchronously and the binding draws with the latest
  record's state.
- Still on the main thread's side of the bridge until step 5: the
  LastRenderTime stamps (`onAfterRender` → `actorRenderFeedback`) and the
  mirror passes' per-camera decisions (`passVisibility`), which the page
  asks the simulation side for synchronously.

All Play's actors are on the GPU path on the maps checked (Training 65,
Island 305, 02_NYC_Street 272, 10_Paris_Catacombs 241, 15_Area51_Bunker 217;
`.work/tools/gpu-fallbacks.mjs`); the CPU path remains the reference and the
fallback (the weapon view model, the software renderer).
