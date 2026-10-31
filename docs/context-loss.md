# Graphics context loss (Stage 7)

What Play does when the browser takes its WebGL context away (a GPU reset, a
driver update, the system sleeping, too many contexts) and gives it back. The
browser's `webglcontextlost` and `webglcontextrestored` events are the host's
counterpart of the original's lost DirectDraw device. The rule below is the
original's own, from `D3DDrv.dll`; the parts the browser forces on us, and what
is not yet verified, are listed after it.

## The original: D3DDrv's Lock waits, rebuilds, or stops

`UD3DRenderDevice::Lock` (`D3DDrv.dll` 0x10002fb0) begins every drawn frame. The
retail binary has the same shape as UT 432's public `und3d.cpp` (`Lock`,
`SetRes`, `UnSetRes`). The addresses below are the retail ones:

* **The test.** `IDirectDraw7::TestCooperativeLevel` (vtable +0x68 on
  `[esi+0x98c]`, 0x10003039..0x10003042). Anything but `DD_OK` logs
  "TestCooperativeLevel failed (%s)" (0x10003072) and jumps to the
  rebuild (0x100030b0 → 0x1000323f).
* **The wait.** It calls `Sleep(100)` (0x1000323f..0x1000324b) and tests again
  (0x10003256). It repeats for as long as the result is
  `DDERR_NOEXCLUSIVEMODE` (0x887600e1, 0x10003259) or
  `DDERR_EXCLUSIVEMODEALREADYSET` (0x88760245, 0x10003267). There is no
  limit and no timeout. `Lock` runs on the game thread inside the engine's
  draw, so the whole game stops: no tick, no input, no drawing.
* **The rebuild.** It logs "Resetting mode (%s)" (0x1000329a), then calls
  `SetRes(ViewportX, ViewportY, ColorBytes*8, Fullscreen)`: vtable +0x60
  with `[esi+0xd4]`, `[esi+0xd8]`, `[esi+0xe0]<<3`, `[esi+0xe4]`
  (0x100032d5..0x100032f8). `SetRes` begins with `UnSetRes(NULL,0)`
  (0x1000a582..0x1000a588). In the UT 432 source that flushes the device
  and releases every texture of every pixel format's pools ("ReleaseTextures",
  guard string at 0x100109d3 in the retail DLL), then the device, viewport,
  Z buffer, clipper and surfaces. The textures come back on demand, uploaded
  again from the engine's own copies, which a device loss never touches.
* **A failed rebuild is fatal.** If `SetRes` returns 0, the code calls
  `GError->Logf("Failed resetting mode")` (0x100032ff..0x1000330c), which is
  `appErrorf`.
* **The frame goes on.** After a successful rebuild, `Lock` continues with
  the Z clear (0x10003314 → 0x100030b5), and the frame whose tick has already
  run is drawn.
* **BeginScene.** A failed `IDirect3DDevice7::BeginScene` (vtable +0x14 on
  `[esi+0x9a4]`, 0x1000321d) takes the same wait and rebuild once
  (`++FailCount == 1`, 0x1000322d..0x10003237). A second failure is the
  "BeginScene failed" error.

**The time after it.** The game time of the tick after the freeze is wall
time. DeusEx.exe's main loop passes `NewTime - OldTime` to `Engine->Tick` and
does not reset `OldTime` (0x109147da..0x109148a6, as for a travel in
`main.mjs`). The freeze happens inside one iteration, so the next tick's delta
includes it. `ULevel::Tick` then advances `Level.TimeSeconds` by the whole
delta times TimeDilation, and clamps the actors' delta to 0.4 s
(`level-tick.mjs` `levelTickTime`, 0x103a5468..0x103a54df).

## Play

The canvas's two events map onto that rule
(`main.mjs` "Graphics context loss"):

* **`webglcontextlost`** (three.js calls `preventDefault`, which a restore
  needs). This is the failed test. Play stops simulating: no frame is posted
  to the worker, and inline mode calls no `sim.frame`. The page and worker
  clocks are not reset, so the first frame after the restore carries the
  whole frozen time in its `dt`, as the original's next tick does. A
  snapshot the worker had already simulated is still applied when it arrives.
  Its draws reach a lost context, where WebGL calls do nothing, and the
  page's bookkeeping stays in step with the simulation's. The toast says the
  game is waiting for the graphics device.
* **`webglcontextrestored`**. This is the rebuild. three.js has already made
  new GL state (its `initGLContext`). Every texture, buffer and program it
  manages is uploaded or built again from its CPU copy on first use, as
  D3DDrv's textures are. Play then rebuilds what three.js does not manage,
  in this order, before simulating again:
  1. **The GPU mesh instances** (the level's and the view model's,
     `gpu-mesh.mjs` `restore`). Their raw WebGL2 programs, textures and
     framebuffers are built again. The live mesh records' static data, the
     live slots' texel maps, the slot parameters and the lookup tables are
     uploaded again from the page's copies.
  2. **The actors on the GPU mesh path.** Their GetFrame cache poses (the
     state textures the pose pass ping-pongs, `docs/gpu-mesh.md` "Pose
     pass") lived only on the GPU, so they are gone. The original's caches are
     CPU memory, which the reset never touches. Each such binding, the
     view model's included, leaves the GPU path for the CPU path
     (`actor-mesh-sim.mjs` `leaveGpu`, the existing exact `toCpu`). Its plan
     log is replayed to the current pose, so the CPU cache holds what the GPU
     held. The page applies the conversions, in the simulation's order,
     before any later frame's records. Actors admitted later take the GPU
     path again, from a first GetFrame that reads no earlier cache.
  3. **The kept snapshot frame** (`frame-keeper.mjs`): its texture is dropped,
     and the next drawn frame keeps a new one.
  4. **The level's shader programs** are built again by the shader warm-up
     (`shader-warmup.mjs`), so the frames after the restore do not compile
     them one by one.
  5. **The `?gpuTimer` queries** are dropped.
* **A restore that fails** (an exception in the steps above) pauses Play with
  the error, the counterpart of "Failed resetting mode". A context the browser
  never gives back leaves the game waiting, as the original waits with no
  limit. Reloading the page is the host's way out: a new document gets a
  new context. `validate-context-loss-play.mjs --case never` loses the
  context for ten seconds of the page clock (nothing simulated, the toast
  saying so), reloads, and checks the page draws and simulates again
  (Chromium worker and inline, Firefox, 2026-10-31).

`deusExViewer.status().graphics` reports `{lost, losses, restores, converted,
lastRestore}`. `converted` counts the bindings each restore moved to the CPU
path. `lastRestore` holds `{converted, drawnLost, inFlight, ms}`:
`drawnLost` counts the snapshots applied while the context was lost, and
`inFlight` counts those the restore applied.

## Host differences, measured or open

* **Performance after a restore.** The actors present at the restore stay on
  the CPU mesh path (the reference) until the next map load builds new GPU
  instances. On the Island that path costs several milliseconds per frame
  (`docs/gpu-mesh.md` "Results"). Seeding the new state textures from the CPU
  shadow would keep them on the GPU, but it is not implemented.
* **The frame in flight.** The original draws the interrupted frame after
  the rebuild. Play applies a snapshot simulated before the loss when it
  arrives. If that is while the context is lost, it is drawn into nothing.
  That is what Chromium does even for `WEBGL_lose_context`'s immediate
  restore, which makes a new context and takes longer than a worker frame.
  If the browser restores the context before that snapshot arrives, the
  restore waits for it and applies it after step 1 and before step 2. Its
  GPU-path actors are then drawn once from the rebuilt, empty state
  textures. The frames after it are exact. The validator forces this case by
  holding the snapshot on the page.
* **Audio during the freeze.** Galaxy's own thread and DirectSound keep
  running while D3DDrv sleeps on the game thread. Play's music is fed by the
  simulation, which does not tick while the context is lost. What the
  original's music does during the wait is not measured.
* **A lost context during a map load.** The load goes on. `createGpuMesh`
  fails on a lost context, so that level takes the CPU path. The shader
  warm-up stops waiting for link status (a lost context never reports it).
  The restore runs once the load has finished.
* **Stale deletes.** three.js's dispose listeners registered before the
  loss still hold the lost context's objects. When such an object is
  disposed after the restore (for example, an actor batch rebuilt as its
  members leave the GPU path), it deletes them, and WebGL ignores the call
  with an "object does not belong to this context" warning. Nothing else
  changes. The validator counts these deletes and fails on any other GL
  error.
* **No context at start** (`webglcontextcreationerror`, no WebGL2) is a
  separate Stage 7 item and is not handled here.

## Validation

`scripts/validate-context-loss-play.mjs` loses and restores the canvas's
context with `WEBGL_lose_context` under a paused Playwright clock, in
Chromium's worker and inline modes and in Firefox's inline mode, against a
run of the same frames with no loss:

* **The loss** (10_Paris_Club's bar mirror, 30 frames, then the loss, then
  30 more, with the shader warm-up off on both sides). In worker mode the
  context is lost in the task that posted a frame, so that frame's snapshot
  arrives while the context is lost (`drawnLost` 1). It is restored without
  advancing the clock. The last frame equals the run with no loss byte for
  byte. That covers three.js's restore, the light atlas, fog, decals, the
  HUD, the mirror, and the GPU mesh actors' move to the CPU path. In
  Chromium, 118 bindings left the GPU path, and every binding reports the
  CPU path.
* **The race** (worker mode). The same, but the snapshot is held on the page
  until the context is back, so the restore applies it (`inFlight` 1). The
  last frame is again identical.
* **The freeze** (00_Training, shader warm-up on). While the context is lost,
  the clock runs two seconds. No frame is simulated: the state digest and
  `Level.TimeSeconds` do not change. The restore and its warm-up take
  further frames of the clock. Then the first tick advances
  `Level.TimeSeconds` by the whole time since the last tick (2096 ms for
  2096 ms in Chromium). There are no page, runtime or GL errors other than
  the stale deletes above.

These compare the page with itself. The original's side is the D3DDrv code
above; a device loss was not captured in the running original.
