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
6. The actor mesh scan: admission, `mesh_reads`, then the main frame's
   dynamics and OccludeBsp (FDynamicSprite::Setup on the sprite records and
   the admitted bindings in Level.Actors order, `dynamics-candidates.mjs`;
   [BSP occlusion](bsp-occlusion.md) "Play"), then item overrides (the laser
   DT_Mesh items, which today are written into the live proxy and restored),
   GetFrame planning and SetupForActor for the actors the frames draw.
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
(voices, the speech MP3 decode, the AudioContext gesture); asset files for its own decoding.

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
| Coronas | the corona icons `{x, y, size, color, skin}` after visibility (and, for validation, each icon's placement inputs and the master frame's words) |
| HUD | the GC command list `{texture, x, y, width, height, u, v, ul, vl, color, style}` (glyphs are already DrawTile commands), posted as `stream`: the tiles as a Float64Array with short texture and colour tables, and the viewport, actor and clearZ commands as objects in place among them (`script-window-command-stream.mjs`); the page expands it to the list before it draws ([live heap](live-heap.md) "Cut: HUD step") |
| Audio | Galaxy voice ops under `?sfx=webaudio` (sound bytes once per key, a speech MP3's every start) and speech decode requests. Galaxy's music and effect voices do not travel in the snapshot: the library service talks to the music worklet on its own MessageChannel (below) |
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

The main frame follows the original: its actors are OccludeBsp's
`Frame->Sprite` ([BSP occlusion](bsp-occlusion.md) "Play"), which the worker
computes after the sprite scan and the actor layer's reads, and every one of
them is stamped. The page draws exactly those in the main pass (a binding
outside it is hidden, or drawn by mirror passes only; a sprite record carries
`main`, and `sprite-scene.mjs` `mainPass` hides the others for the main
render). The mirror children and the sky frame keep today's host culling
([render visibility](render-visibility.md): the frustum sphere is host
culling, not the original contract) until child frames run their own
dynamics; so do movers, which the original never stamps through
DrawActorSprite (a later step). `?actorOcclusion=frustum` restores the
frustum-tested drawn set for the main frame too. For the host-culled passes
the worker runs three's own math (`Frustum`, `Sphere`, `Box3`; three imports
without a GL context) on the same inputs:

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

- `?sim=worker` (the default since 2026-10-04, except in Firefox since
  2026-10-15): the simulation in the worker (step 8).
- Firefox defaults to `?sim=inline`: Gecko gives a worker that idles between
  frames a full compacting GC every ~5.5 s, a stall of the whole heap's cost,
  where the page's collections are incremental ([hitch log](hitch-log.md)
  "Firefox"). `?sim=worker` still selects the worker there.
- `?sim=inline`: the simulation frame and the page's draw both run on the
  main thread, separated by the snapshot. The Training previews, the NPC
  focus list and `?simVerify=1` drive or read the runtime on the page, so
  they need it (`?simVerify=1` implies it). The validators that patch
  main.mjs to read `game` load `?sim=inline`; validate-sim-split compares
  the worker with it.
- `?sim=clone`: inline, with the snapshot passed through `structuredClone`,
  proving that it carries only plain data.
- In every mode a travel arrival attaches to the script process of the level
  left (`src/runtime/script-process.mjs`; [class graph
  design](class-graph-design.md), migration step 3), so its classes and
  readiness are kept. A load from the map list or a page load starts a new
  process. `?process=new` starts a new one for every level, travels included,
  which is the comparison side of the load-time measurements.
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
  state, PlaySound's result and GetSpeechLength come from bytes, a host
  clock and the worklet's reports. Speech is the one loop through the page
  ([galaxy audio](galaxy-audio.md) "Speech through Galaxy's voices"): a
  speech voice's start asks for its decode (an `op: 'decode'` voice event
  with the MP3 bytes), the page decodes it (`OfflineAudioContext` at the
  MPEG header's rate, 16-bit) and queues a `speech-pcm {sound, pcm}`
  command; the worker attaches the PCM to Galaxy's record, which forwards it
  to the worklet, and keeps it for Update's lip-sync step, whose mixer
  position is the worklet's reported read head.
- **Music** ([Galaxy music](galaxy-music.md) "Phase 5: Output"). The Galaxy
  library runs in an AudioWorklet on the page's AudioContext (44100 Hz).
  The page creates one MessageChannel per simulation side and wires it once:
  one port to the worklet node, the other to the worker (`{type: 'music',
  port}`), whose library service (`galaxy-music-library.mjs`) lives as long
  as the worker. Update's critical sections cross as batches straight to
  the worklet (module bytes transferred once), and the worklet's
  `{batch, state}` reports come straight back for `order()`. Nothing about
  music crosses the page per frame; the page only resumes the context on a
  gesture and reads status on request. `?sim=inline` keeps the port on the
  page. `?music=0` leaves the worklet out (the simulation then uses the
  headless mirror library).
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

Until step 6 the pixels came from an element screenshot. Under the paused
clock Chromium did not present 00_Training's canvas, so those screenshots
were black on both sides, and steps 2–5's Training pixel checks compared
nothing. The harness now reads the drawing buffer (`readPixels`, with
`preserveDrawingBuffer` patched into the page) and `--shots` writes it.
With that, the pre-split commit f4fb698 and step 6 give identical digests
and identical frames on Training, walking and with the crowbar equipped
(`--preview weapon`), which covers steps 2–6 there. Island's screenshots
were real frames; 02_NYC_Street and 02_NYC_Smug (walking, 240 frames) also
give identical digests and frames from f4fb698 to step 6 with the buffer
read. `?simVerify=1` with the crowbar equipped finds no difference.

02_NYC_BatteryPark starts in a conversation. There the same page run twice
differs at some checkpoints, before step 6 too: the conversation's progress
depends on asynchronous loading. It is not a usable comparison map.

| Step | Commit | Check |
|---|---|---|
| Harness: `?seed=`, `?hold=1`, state digest | f4fb698 | same page: identical; a different seed differs at the first checkpoint |
| 1 header, movers, lights, pan, sky, target | cfd0b02 | Island, Training: identical digests |
| 2 HUD command list, InfoLink text | 1547238 | Island, Training: identical digests and pixels |
| 3 sprite scan and render iterators | 29238ba | Island, Training, 02_NYC_Street: identical |
| 4 actor meshes: simulation and page halves | 9bab54d | Island, Training, 02_NYC_Street, 02_NYC_Smug (mirrors): identical |
| 5 drawn set and stamps on the simulation side | adf3c68 | Island, Training, 02_NYC_Street, 02_NYC_Smug: identical; `?simVerify=1` on six maps (600 frames walking) and validate-mirrors-play's four mirror maps |
| 6 coronas and the view model on the simulation side; the view model on the GPU path | 26cf7c1 | against step 5: Island and 02_NYC_Smug walking, Training with the crowbar (CPU path before, GPU path now): identical; against f4fb698: Training (walking, crowbar), 02_NYC_Street, 02_NYC_Smug: identical frames (drawing buffer); `?simVerify=1` with the crowbar |
| 7 one `sim.frame()` per frame, events queue, `?sim=clone` | 6342c8e | against step 6, inline and `?sim=clone`: Island and 02_NYC_Smug walking, Training with the crowbar, 02_NYC_Smug in Inspect (free camera flying): identical; `?simVerify=1&sim=clone` with the crowbar |
| 8a frame plans and lighting packed into one buffer | a7a5b1d | against step 6: Island, Training with the crowbar, 02_NYC_Smug (inline and clone): identical |
| 8b `sim-host.mjs` builds the simulation side | ad6e73e | against step 6: Island, Smug (walking, Inspect), Training with the crowbar: identical |
| 8c `?sim=worker` | a66e55c | against step 6 inline: Island, Training, Smug walking and Inspect under the worker: identical digests and frames |
| 8d snapshots wait in order, posts on late arrival | aad53b8 | lockstep unchanged (Island identical) |
| 8e the worker merges posts | d4a934c | lockstep unchanged (Island, Training, Smug Inspect identical) |

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
- Until step 5 the LastRenderTime stamps (`onAfterRender` →
  `actorRenderFeedback`) and the mirror passes' per-camera decisions
  (`passVisibility`) still crossed back from the page synchronously.

All Play's actors are on the GPU path on the maps checked (Training 65,
Island 305, 02_NYC_Street 272, 10_Paris_Catacombs 241, 15_Area51_Bunker 217;
`.work/tools/gpu-fallbacks.mjs`); the CPU path remains the reference and the
fallback (the weapon view model, the software renderer).

Step 5 (`drawn-set.mjs`, `play-camera.mjs`, `mirror-passes.mjs`,
`mover-matrix.mjs`): the simulation side decides every pass's drawn set and
stamps LastRenderTime itself, before the corona pass, the weapon and the
HUD, where the page's draws stamped it. A HUD window reads LastRenderTime
in its DrawWindow (`ActorDisplayWindow`, lines 640–770), so stamps sent back
by the page and applied before the next tick would not be exact.

- The Play camera is a function of PlayerCalcView and the render rect
  whenever the world draws (`applyPlayFrame`); the session keeps its own and
  follows the page's resizes.
- The page sends its static brush and mirror meshes once
  (`world.stampScene`): bounding spheres, matrices, the mirror planes and
  their vertices. The simulation side poses the mover groups from the
  mover states with the page's code (`moverGroupMatrix`), plans the mirror
  passes with the page's planner (`planMirrorPasses`, now also used by
  `mirrors.mjs`), the sky pass and the main pass, and tests movers, sprites
  (three.js's sprite sphere, the texture size decoded on the simulation
  side) and the actor layer's bindings (`drawnIn`: the GPU path's group
  decisions, the CPU path's bounds) with three.js's frustum math.
- The actor layer's decision for each mirror pass is computed there and
  handed to the page in pass order, with the main frame's again after the
  passes, as `mirrors.mjs` calls `updateActors`.
- The page plans the passes it draws from the snapshot's frame, never from
  its own state at draw time (2026-10-15). With the worker a snapshot is
  drawn a display frame or more after its post, and a resize (or a Play/Inspect
  switch) can land in between: the page then planned at its new canvas size,
  or as Inspect with its free camera, and drew mirror passes the simulation
  side had not planned ("The page drew a mirror pass the simulation side did
  not plan", seen in sweeps under CPU load: a frame posted while the canvas
  was 1×0 and drawn at 1024×531). Now `stamps.plan` carries the inputs the
  simulation side planned with (`size`, the `mirrors` switch, `actors`:
  whether it made actor decisions) and `mirrors.mjs` plans with them; a
  snapshot draws as the mode it was simulated in, an Inspect one with the
  posted camera's whole projection (`projectionState`, its pixel centre's
  view offset included, which the session's camera now takes too); and
  each pass carries an `id` (mirror-passes.mjs: the OccludeFrame frame, or
  the groups it looks through) that the page checks against `passIds`, so
  a pass drawn with another pass's decisions throws instead of passing
  silently. A frame whose render viewport is empty draws no 3D
  ([conversation camera](conversation-camera.md): the session already ran
  no OccludeBsp, sky, corona pass or view model for it), so it has no
  mirror passes on either side either; before, both fell back to frustum
  planning with whatever aspect the camera kept, and stamped the actors
  those passes saw. `validate-mirror-plan-play` resizes the window across
  a collapsed canvas and back while facing the 02_NYC_Bar mirror, in Play
  and in Inspect, and switches Play to Inspect there, facing the mirror
  and turned away; at 7bca031 it fails with 8 page errors, no CPU load
  needed.
- A host change: a binding is stamped once the simulation side has it, and a
  sprite once its texture has decoded on the simulation side; before, both
  waited for the page's own decode. The original loads synchronously, and
  the simulation no longer depends on the page's timing. Under the fixed
  clock this lands in the same frames (identical digests).
- `?simVerify=1` compares the stamped set with what three.js's
  `onAfterRender` reports in every pass (bindings and sprites the page has
  not built yet are left out). It found one modelling error, fixed: an
  iterator item slot a frame does not use kept its last drawn state on the
  simulation side.
- The weapon view model still stamps from its own draw (step 6).

Step 6 (`corona-scan.mjs`, `weapon-overlay-sim.mjs`,
`weapon-overlay-draw.mjs`): the corona pass and the view model run on the
simulation side right after the stamps, in their order (DrawFrame's
coronas, then PostRender's RenderOverlays); the page draws their records
after the world, as before.

- Coronas: the line checks, the fade cache and the icon placement run on
  the simulation side, with the page's fade clock (`now`) and the drawn
  size from the render rect or the canvas and the pixel ratio. The page
  draws an icon once its skin has decoded, as before.
- The view model: Render.dll's gates, RenderOverlays with the scoped
  Canvas.DrawActor hook, and each submitted actor's mesh binding
  (`createMeshBinding`, as for level actors) run there. The binding's frame
  record and its decision for the main camera's frustum
  (`passVisibility`; the CPU path's posed bounds otherwise) cross to the
  page, and the session stamps the actors `drawnIn` says are drawn, before
  the HUD reads them. `createWeaponViewModel` keeps both halves in one
  thread for the Node display checks.
- GPU path (per "prefer GPU"): Play's view model has a GPU mesh instance of
  its own (`WEAPON_GPU_MESH_CAPACITIES`; DeusExItems' largest LodMesh has
  255 vertices and 17,596 keyframe texels), so its passes run once per
  frame after the overlay pass is planned, without rerunning the level's.
  The simulation side keeps the matching layout; a binding that does not
  fit takes the CPU path.
- The page applies the view model's records and runs its GPU passes before
  the world's draws: `gpu.run` resets three.js's state, which would drop
  the clipped viewport the overlay draws in.
- `?simVerify=1` compares the view model's stamped actors with the
  overlay pass's `onAfterRender`.
- Cost, inline: Training with the crowbar at 1920×1080, three interleaved
  pairs against step 5 (`.work/tools/ab-weapon.sh`): weapon phase median
  0.37 → 0.40 ms, frame 12.77 → 12.97 ms, both within run-to-run noise.
  The crowbar's cost is RenderOverlays and its draw, not GetFrame or
  lighting.

Step 7 (`sim-session.mjs` `frame`, `main.mjs` `simFrame`): animate() makes
one simulation call per frame, `sim.frame(input)`. It runs every step in the
order and with the gating animate() gave them and returns one snapshot:

- the begin frame (movers, view, render rect, moving lights, sky, frob
  target, surface pan);
- the sprite records, the actor layer's frame records, the drawn set's
  pass decisions, the corona icons and the view model's records;
- the HUD commands and the InfoLink text;
- Galaxy's update time, each step's time and the errors, in order;
- the events queued since the last frame: the mesh layers' creation and
  release records and the lighting changes.

The page applies the events, then draws only from the snapshot.

- `?sim=clone` passes the input and the snapshot, and the events at map
  load, through `structuredClone`. It first checks that they hold only
  plain data: no functions, and no class instances other than Map, Set and
  typed arrays.
- Creation records reach the page at the next frame's draw, not when the
  binding's preparation resolves. The page still allocates GPU slots in
  creation order, before that frame's passes. At map load the first records
  are applied, and the actor meshes built, before the first frame.
- A frame's simulation errors are known before any of it is drawn. A page
  error (a draw that throws) gates the simulation from the next frame on.
  So the gating differs from before only on a frame where a step fails.
- Audio events and lip sync still call the page directly; they cross in
  step 8.
- Timings: the simulation side times its steps, and the page adds them to
  `framePhases` under the same names; `clone` is the structured-clone cost.
- Cost: inline, Island at 1920×1080, three interleaved pairs against step
  6: frame median 27.95 → 27.95 ms. `?sim=clone` adds about 3.5 ms
  (`clone`), with the plain-data check.
- `structuredClone` of one Island snapshot takes 2.1 ms
  (`.work/tools/snapshot-cost.mjs`), and 2.0 ms of that is the actor
  records: 423 records, 311 with SetupForActor's lighting and 84 with a
  GetFrame plan, as many small nested objects and arrays. The HUD's 128
  commands take 0.2 ms. A worker would pay this every frame, so step 8
  packs the plans and lighting into typed arrays. Every value already goes
  into the GPU mesh path's Float32/Uint32 parameters, so packing loses
  nothing.

Step 8, first part (`mesh-frame-pack.mjs`): each frame's GetFrame plans
and SetupForActor results are packed into one buffer of 32-bit words. A
frame record carries an offset into it instead of nested objects. The GPU
mesh path's `setPose` and `setLighting` read the words directly, and plain
objects still work where nothing packs them (the validators' wrappers, a
binding's first plan in its creation record). Each frame gets a fresh
buffer, which a worker can transfer. `structuredClone` of the Island
snapshot drops from 2.1 to 0.5 ms (the bare records 0.2 ms, the HUD
commands 0.16 ms, the words 0.05 ms). Against step 6: Island walking
inline, Training with the crowbar and 02_NYC_Smug walking under
`?sim=clone` give identical digests and frames; validate-gpu-mesh passes.

Step 8, second part (`sim-host.mjs`): everything on the simulation side of
a map load now comes from one function, `createSimHost`, in Play's
construction order: the game, the mesh lighting view, the actor mesh
layer's simulation half, the session, the view model's simulation half, the
corona scan and the lip-sync channels. Its inputs are plain data from the
page's world: the stamp scene, the pan zones, whether the map has mirrors,
and the capacities of the page's GPU mesh instances. main.mjs builds only
the page halves around it (the actor draw, the view model draw, the
sprites, the coronas, the HUD). The worker will run the same function.
Against step 6: Island, 02_NYC_Smug (walking and Inspect) and Training with
the crowbar give identical digests and frames.

Step 8, third part (`sim-worker.mjs`, `sim-client.mjs`, `host-clock.mjs`):
`?sim=worker` runs the simulation side in a module worker.

- **Boot.** The page hands the worker its `DEUS_EX_*` switches and the
  game files (File objects from the folder picker, or the dev server's
  URLs). The worker imports the runtime after setting the switches, then
  builds each map with `createSimHost` from the same plain options the
  page uses inline. The page decodes the map for its own world.
- **Frames.** At most one frame is in flight. At a display frame the page
  posts frame N+1 if snapshot N has arrived, then draws N, so the worker
  simulates while the page draws. A display frame that posts nothing adds
  its dt to the next post. A display frame without a new snapshot draws
  nothing. Snapshots carry the id of their map load, and the page drops a
  snapshot of an earlier load (a frame that was in flight when another map
  loaded).
- **Clocks.** Galaxy's update clock, the window host's tick offset, the
  resource services' seconds and LevelInfo's date fields read
  `host-clock.mjs`. In the worker it follows the page's clocks at the
  frame's post, frozen for the frame; on the page it is the browser's own,
  as before.
- **Input.** Keys, buttons, mouse motion, window pointer samples and input
  resets queue on the page and run at the start of the worker's next
  frame, in arrival order. The page's synchronous decisions use the
  answers of the last snapshot: per key code, whether the last press was
  handled or consumed (a key not yet seen counts as handled, so it is
  prevented); for the pointer, whether a modal held the mouse.
- **Audio.** Galaxy's voice events (`?sfx=webaudio`) and speech decode
  requests cross with the snapshot. A voice's sound bytes cross once per
  sound key, a speech MP3's with each start (the page keeps no speech
  buffer) and with each decode request. They are sliced from the package's
  buffer. The decoded PCM comes back as a `speech-pcm` command with the
  next frame.
- **Calls.** Player start (`reset`, then the movers and PlayerCalcView),
  the mode change's PlayerCalcView and `stateDigest` are processed in order
  with the frames.
- **Inspect.** The snapshot carries the camera its frame was culled for,
  and the page draws it with that camera.
- **Page clocks.** The page's texture animation (procedural textures,
  texture frames) runs at the snapshot's post time, the time of the frame
  it draws; on the page modes it reads the clock as before.
- **Map load.** The map counts as ready once the worker's replies to the
  mode change and Player start (PlayerCalcView) have pointed the camera; on
  the page they are synchronous. A late reply had moved the free camera
  back one step after Inspect's first frame. The level's first tick is
  made ahead of the first frame (`call('preTick')` at the load's `host`
  mark, while the worker would idle; that frame is posted `preTicked` with
  no dt of its own): [first frames](first-frames.md) "Ahead of the first
  frame".
- **Checks.** Against step 6 inline (`.work/base`), `?sim=worker` gives
  identical digests and frames on Island and 02_NYC_Smug walking, Training,
  and Smug in Inspect with the free camera flying.
- **Page only.** The Training previews, the NPC focus list and
  `?simVerify=1` drive or read the runtime directly, so they stay on the
  page modes.
- **Lockstep.** With `?hold=1` the page draws each snapshot as it arrives,
  and `deusExViewer.settled()` resolves once no frame is in flight.
  validate-sim-split waits for it after each step. It awaits `stateDigest`
  (a promise in worker mode), hides the page bars so the canvas is the
  whole window in every mode, and sets the menus through the DOM.

Step 8, fourth part (the frame pipeline): arrived snapshots wait in order
and each display frame draws the oldest, so none is skipped (each one's
records and events apply exactly once). A frame posts at a display frame
when none is in flight or waiting. When a snapshot arrives after the
display frame that followed its post (the simulation is slower than the
display), the next frame posts at once, so the worker never idles. When
the simulation fits in a display frame, posts stay on display frames, one
frame ahead, with even dt. A post's dt is the page time since the last
post.

Measured on 2026-10-04 (Linux host, headless Chromium, `--angle gl`,
Island at 1920×1080, three interleaved pairs, `.work/tools/ab-worker.sh`;
time between drawn frames, the mean over 300 display frames):

| Run | Inline | Worker |
|---|---:|---:|
| 1 | 27.6 ms | 24.3 ms |
| 2 | 26.1 ms | 22.4 ms |
| 3 | 35.9 ms | 24.7 ms |

The main thread now spends about 4.3 ms per display frame (render 2.7,
actor records 0.6, HUD batches 0.4). The worker's frame takes about 22.5 ms
(its step times), so it is the bottleneck: about 36 → 43 fps here, short
of the ~55 fps estimated above, because the simulation side's planning
and stamps cost more than profiled. From here every simulation-side saving
(the tick's 12 ms first, then the actor layer's 5.5 ms and the HUD's
1.4 ms) shortens the frame directly, until the simulation reaches the
page's ~4–5 ms.

Step 8, fifth part (merged posts): the page posts a frame every display
frame. The worker merges the posts that arrive while it is busy into one
frame (the latest page state, their dts summed, every command in order),
so it starts the next frame as soon as it has sent a snapshot. Before, it
idled about 6 ms a frame waiting for a post that the page sends only after
its own draw. A call runs the frames posted before it first. A reply says
how many posts it consumed; `settled()` waits until every post has its
reply. Lockstep still posts one frame per display frame.

Worker step times per simulated frame (Island 1920×1080, `w.*` phases):
tick 12.4, actor layer 6.5, HUD 1.7, sprites 1.5, stamps 0.8, audio 0.8,
lighting 0.25, coronas 0.2, weapon 0.1, about 24 ms in all, with the
worker now busy for nearly the whole frame. In this batch the
drawn-frame interval was 23.8, 25.7 and 27.4 ms against 27.9, 30.4 and
31.1 ms inline: the simulation side's cost is the frame. A CPU profile of
the worker (`.work/tools/profile-worker.mjs`) puts its self time in the
script runtime's field access (4 ms), the Rust core (3.9), the actor
layer's simulation half (2.2), the script VM (1.9), SetupForActor's light
selection (1.1), script values (1.1) and the Rust VM bridge (0.9). That
is where the next savings are.

