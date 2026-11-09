/** The simulation side of a loaded map (docs/sim-worker.md "Boot"): the
 * game, its frame session and the simulation halves of the actor mesh
 * layer, the view model and the corona pass, plus Galaxy's lip-sync
 * channels, built in the order Play built them. The page (?sim=inline,
 * ?sim=clone) and the worker (sim-worker.mjs) run this same code; its
 * inputs are plain data from the page's world:
 *
 * - `stampScene`, `panZones`, `childFrames`: world.stampScene(),
 *   world.panZoneNames() and whether the map has mirror planes;
 * - `scene`: a promise of those five (`stampScene`, `panZones`, `childFrames`, `gpu`, `weaponGpu`) when the page builds its world while this
 *   load runs (sim-client.mjs loadOverlapped); awaited after createGame, which reads none of them. Null: they are among the options.
 * - `gpu`, `weaponGpu`: the capacities of the page's GPU mesh instances
 *   (gpu-mesh.mjs), or null where the page has none (the CPU path);
 * - `meshBackend`: 'javascript' keeps the JavaScript GetFrame kernel;
 * - `meshLod`: 'off' draws every mesh at full detail (no DrawLodMesh
 *   distance LOD, docs/script-lodmesh-lod.md);
 * - `travel`: `{arrival, lastURL}` (docs/travel.md): the session runs map travel as recovered; `arrival` is the request of the travel that
 *   brought the player here (travel.mjs), null for a map opened directly;
 * - `musicLibrary`: Galaxy's music library service (galaxy-music-library.mjs
 *   connectMusicLibraryPort, the worklet's port), or null for the headless
 *   mirror. It outlives the map: `disposeAudio()` (also run by `dispose()`)
 *   lets the live audio unregister its music before the next map's runtime
 *   issues any library call.
 *
 * Everything the page must apply between frames goes to the session's
 * event queue (sim-session.mjs events). */
import { createGame } from './game.mjs';
import { primeSaveDirectoryHost } from './save-directory-host.mjs';
import { handleLimit, releaseHandleRange, releaseHandlesWhere } from '../runtime/script-object-handles.mjs';
import { forgetNoted } from '../runtime/base-epoch.mjs';
import { forgetTraceModel } from '../runtime/trace-kernel.mjs';
import { createSimSession } from './sim-session.mjs';
import { createActorMeshSim } from './actor-mesh-sim.mjs';
import { createGpuMeshLayout } from './gpu-mesh-layout.mjs';
import { createWeaponOverlaySim } from './weapon-overlay-sim.mjs';
import { createConsoleLevelAction } from '../runtime/script-console-level-action.mjs';
import { createCoronaScan } from './corona-scan.mjs';
import { createMeshLightingView } from './mesh-lighting-view.mjs';
import { createLipSyncAnalysis } from '../runtime/galaxy-lipsync-channels.mjs';
import { loadScriptVmKernel } from '../runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, moverTrackerMode, trackedCollisionMode, trackerDecalSource, trackerMoverSpec, trackerTextureFlags, TRACKER } from '../runtime/brush-tracker.mjs';
import { walkingSurfaceTextures } from '../runtime/walking-surface.mjs';
import { readTexture } from '../unreal/textures.mjs';
import { detailTable, detailTexturesOn, modelSurfaceDetails } from '../runtime/detail-pass.mjs';
import { createDetailDraw } from '../runtime/detail-draw.mjs';
import { warmAllocationSites } from '../runtime/allocation-site-warmup.mjs';
import { exportAt } from '../unreal/objects.mjs';

// The handle limit when each host started (script-object-handles.mjs): a
// host's identities are the handles from its start to the next host's.
const hostStarts = [];

export async function createSimHost(map, asset, assets, { randomSeed, subtitles, fullscreen = null, scene = null, stampScene, panZones, childFrames,
  gpu = null, weaponGpu = null, meshBackend = null, meshLod = null, weapons = null, weaponMirrors = null, weaponOrder = null, musicLibrary = null, travel = null, restore = false, onConversationSpeech = null, onAudioVoice = null,
  onProgress = () => {}, onPaintProgress = null, process = null }) {
  // Before the first load keeps what it reads: the allocation sites the frame loop shares with the load are decided here (allocation-site-warmup.mjs)
  warmAllocationSites();
  const events = [], notes = [], hostIndex = hostStarts.push(handleLimit()) - 1;
  // The load's steps on this thread's clock (performance.now()), for the page's load timeline (main.mjs loadTimings).
  const loadMarks = [['host', performance.now()]], loadMark = name => loadMarks.push([name, performance.now()]);
  let game;
  // GetSaveFreeSpace is synchronous: the browser's storage estimate is read here, once per session (save-directory-host.mjs)
  await primeSaveDirectoryHost();
  try {
    game = await createGame(map, asset, assets, { presentation: true, randomSeed, subtitles, fullscreen, musicLibrary, travel, restore: restore || null, process,
      onLightingChanged: changes => events.push({ kind: 'lighting', changes }),
      onConversationSpeech: event => onConversationSpeech?.(event), onAudioVoice: event => onAudioVoice?.(event) });
  } catch (error) { notes.push(`Play mode unavailable: ${error.message}`); return { game: null, notes, events, loadMarks }; }
  loadMark('game');
  if (scene) {
    const part = await scene;
    if (!part) throw new Error('The page did not build the world for this load');
    ({ stampScene, panZones, childFrames, gpu, weaponGpu } = part);
    loadMark('scene');
  }
  const runtime = game.doors.scriptRuntime.runtime, player = () => game.player.collisionActor;
  const exportName = ref => exportAt(asset.pkg, ref)?.name;
  let meshLighting = null, actorSim = null;
  // The BSP occlusion and brush tracker of the current level (buildOcclusion).
  let occlusionNow = null;
  onProgress('Preparing original actor meshes…');
  try {
    const exportIndexByName = new Map(asset.pkg.exports.map((entry, i) => [entry.name, i + 1]));
    // Its LineChecks see the movers where the brush tracker last left them
    // (`occlusionNow`, below).
    meshLighting = createMeshLightingView(runtime, () => runtime.levelFor(player()),
      { exportName, exportIndex: name => exportIndexByName.get(name),
        lineModel: () => occlusionNow?.tracker?.live() ? occlusionNow.lineModel() : null });
    // Player start logs in a new player; the layer follows the current one.
    actorSim = await createActorMeshSim(runtime, assets, asset, { player, lighting: meshLighting, childFrames, lod: meshLod !== 'off', weapons: weapons !== 'off', weaponMirrors: weaponMirrors !== '0', weaponOrder, weaponPath: weapons === 'cpu' ? 'cpu' : null,
      layout: gpu ? createGpuMeshLayout(gpu) : null,
      onCreate: creation => events.push({ kind: 'mesh-create', creation }), onRelease: id => events.push({ kind: 'mesh-release', id }),
      ...(meshBackend === 'javascript' ? { kernel: null } : {}) });
    meshLighting.kernel = actorSim.kernel;
    notes.push(`${actorSim.summary.npcs} NPC and ${actorSim.summary.props} prop meshes render live original poses and original mesh lighting in Play. ${meshLod === 'off' ? 'Distance LOD is off (?meshLod=off). ' : ''}Fatness, fog/volumetric lights and animated/procedural mesh skins remain unsupported.`);
    for (const error of actorSim.summary.errors) notes.push(`${error.actor}: ${error.message}`);
  } catch (error) { notes.push(`Actor meshes unavailable: ${error.message}`); }
  loadMark('actors');
  const session = createSimSession(game, { assets, events, exportName });
  session.setScene(stampScene, actorSim);
  if (meshLighting) session.setMeshLighting(meshLighting);
  // The console's canvas: LoadMap's PaintProgress frame, when a travel leaves this level, prints its DrawLevelAction message (docs/loading-frame.md);
  // SaveCurrentLevel's goes to `onPaintProgress` as the save draws it.
  if (game.hud) session.setLevelAction(await createConsoleLevelAction({ runtime, assets }), onPaintProgress);
  const hudTextures = game.hud ? session.hudTextures() : null;
  // The player's view model, with the layout of the page's own GPU mesh
  // instance for it.
  const weaponSim = await createWeaponOverlaySim(runtime, assets, player, { kernel: actorSim?.kernel ?? null, lighting: meshLighting, lod: meshLod !== 'off',
    layout: weaponGpu ? createGpuMeshLayout(weaponGpu) : null,
    onCreate: creation => events.push({ kind: 'weapon-create', creation }), onRelease: id => events.push({ kind: 'weapon-release', id }) });
  session.setWeapon(weaponSim);
  // The helper's TRACE_Level line check sees the movers where the brush tracker
  // last left them (`occlusionNow`, below), as the mesh lighting's does.
  session.setCoronas(createCoronaScan(runtime, { model: map.model, exportName, player,
    lineModel: () => occlusionNow?.tracker?.live() ? occlusionNow.lineModel() : null }));
  // Galaxy Update's step 12 analysis (script-audio-live.mjs, docs/lip-sync.md);
  // a replay fed the original's phoneme letters (live-probe.mjs `phonemes`)
  // does not run Galaxy's own analysis.
  const lipSync = createLipSyncAnalysis({ kernel: (await loadScriptVmKernel()).lipsync, ...game.lipSyncServices(),
    enabled: () => !game.liveReplay?.measuredSpeech });
  runtime.audio?.setLipSync(lipSync);
  // The original BSP occlusion (bsp-occlusion.mjs) over the map's model, with
  // each surface texture's PolyFlags (UTexture +0x80, the packed bools).
  // `releaseOcclusion` frees its kernel blocks when the host goes (dispose).
  let releaseOcclusion = () => {};
  try {
    const textureFlags = new Map(), surfaceTextureFlags = [];
    const surfaces = map.model.surfaces;
    for (let i = 0; i < surfaces.length; i++) {
      const texture = surfaces.texture(i);
      if (!texture) { surfaceTextureFlags.push(0); continue; }
      if (!textureFlags.has(texture)) {
        const object = await assets.resolve(asset, texture);
        textureFlags.set(texture, texturePolyFlags(readTexture(object.asset, object.index).values));
      }
      surfaceTextureFlags.push(textureFlags.get(texture));
    }
    const kernel = (await loadScriptVmKernel()).occlusion;
    if (!kernel) throw new Error('the script VM core predates it; run npm run build:wasm');
    // D3DDrv's detail-texture pass (detail-draw.mjs): the per-surface table from the map's textures, unless
    // ?detailTextures=0 models a device without BLENDDIFFUSEALPHA, where the original skips the pass.
    let detail = null;
    if (detailTexturesOn() && kernel.detailRun) detail = detailTable(map.model, await modelSurfaceDetails(assets, asset, map.model));
    else if (detailTexturesOn()) notes.push('Detail textures unavailable: the script VM core predates detail.rs; run npm run build:wasm');
    // Engine's moving brush tracker (brush-tracker.mjs, docs/brush-tracker.md)
    // on the same model: its movers with their polygons' texture PolyFlags.
    let trackerMovers = null;
    if (moverTrackerMode() !== 'off' && kernel.trackerHeaderPtr) {
      trackerMovers = await collectTrackerMovers(assets, asset, map);
      await trackerTextureFlags(assets, asset, trackerMovers,
        object => texturePolyFlags(readTexture(object.asset, object.index).values), textureFlags);
    }
    // The texture records (walkingSurfaceTextures) of every mover polygon, for
    // the tracker's FBspSurfs (AddBrush: Texture = the polygon's), which a
    // world hit on a fragment names: WalkTexture and TraceTexture read
    // Model->Surfs[Node.iSurf].Texture.
    const polygonTextures = new Map();
    if (trackerMovers) {
      const polygons = trackerMovers.flatMap(m => m.polys.map(p => p.texture));
      const records = await walkingSurfaceTextures(assets, asset, { surfaces: { length: polygons.length, texture: i => polygons[i] } });
      let k = 0;
      for (const m of trackerMovers) { polygonTextures.set(m, records.slice(k, k + m.polys.length)); k += m.polys.length; }
    }
    // A fresh model and tracker: at load, and at each LoadMap that Player
    // start makes (the original deletes the tracker and loads the level
    // anew, then GNewBrushTracker after the actor start-up, 0x1038dfb5).
    let current = null, builtLevel = null;
    // Before the reset's LoadMap: the tracker goes first, so the level model's collision, line checks and decals are the
    // static BSP's through the new level's actor start-up, until buildOcclusion's GNewBrushTracker.
    const dropOcclusion = () => {
      if (builtLevel) builtLevel.decalSource = null;
      current?.dispose();
      current = null;
      occlusionNow = null;
      session.setOcclusion(null);
    };
    const buildOcclusion = () => {
      current?.dispose();
      occlusionNow = null;
      const level = runtime.levelFor(player()), index = new Map();
      builtLevel = level;
      level.actors.forEach((actor, i) => { if (actor && !index.has(actor.name)) index.set(actor.name, i); });
      const movers = (trackerMovers ?? []).filter(m => index.has(m.name)).sort((a, b) => index.get(a.name) - index.get(b.name));
      const read = (actor, name) => runtime.readNamed(actor, name);
      const actors = movers.map(m => level.actors[index.get(m.name)]);
      const specs = trackerMovers ? movers.map((m, i) => trackerMoverSpec(m, i, { hidden: read(actors[i], 'bHidden'),
        location: read(actors[i], 'Location'), rotation: read(actors[i], 'Rotation'), prePivot: read(actors[i], 'PrePivot') })) : null;
      current = createBspOcclusion(kernel, map.model, { surfaceTextureFlags,
        zoneActors: Array.from({ length: map.model.zones.length }, (_, i) => (map.model.zones.actor(i) > 0 ? map.model.zones.actor(i) : 0)), tracker: specs ? { movers: specs } : null,
        detailTable: detail?.some(Boolean) ? detail : null });
      // The constructor's Update(NULL) at the game thread's control word,
      // unmeasured: PC64 is the assumption (docs/brush-tracker.md "Precision").
      if (specs) {
        const status = current.tracker.construct({ pc64: true });
        if (status) throw new Error(`the brush tracker's blocks are too small (status ${status})`);
      }
      // AttachDecal and the decal block over the level model as the tracker
      // holds it (script-decal.mjs levelDecals, docs/decals.md "Movers").
      level.decalSource = specs ? trackerDecalSource(current, map.model, kernel.memory, actors, read) : null;
      // Every UModel::FastLineCheck of the game (CheckHearSound, MakeNoise, FastTrace, the pawn natives, Galaxy's
      // Update) reads Level->Model, which the tracker extends in place: the movers' fragments block those lines too
      // (fast-line-check.mjs, docs/brush-tracker.md "Line checks"). Not enumerable: the model crosses no thread with it.
      if (level.model) Object.defineProperty(level.model, 'trackedLineNodes', { configurable: true, enumerable: false, writable: true,
        value: () => (occlusionNow?.tracker?.live() ? occlusionNow.lineNodes() : null) });
      // ULevel::MultiLineCheck's and MultiPointCheck's world checks (MoveActor, Trace, the AI and decal traces, FarMoveActor)
      // read Level->Model too (level-queries.mjs worldModel, docs/brush-tracker.md "Collision"). The tracker's surfaces take
      // their polygons' texture records after the level's own (`surfaceTexture`, as the level's walkingSurfaceTextures).
      if (specs && level.model) {
        const collision = current.collisionModel(), t = current.tracker;
        const textures = (level.surfaceTexture ?? []).slice(0, t.header(TRACKER.SURFS_TOP));
        for (let s = t.header(TRACKER.SURFS_TOP); s < t.header(TRACKER.SURFS_NUM); s++) {
          const owner = t.surfOwner(s);
          textures[s] = polygonTextures.get(movers[owner.tag - 0x40000000])?.[owner.ordinal] ?? null;
        }
        collision.surfaceTexture = textures;
      }
      if (level.model) Object.defineProperty(level.model, 'trackedCollision', { configurable: true, enumerable: false, writable: true,
        value: trackedCollisionMode() === 'off' ? () => null : () => (occlusionNow?.tracker?.live() ? occlusionNow.collisionModel() : null) });
      session.setOcclusion(current, specs ? { names: movers.map(m => m.name), actors, indices: movers.map(m => index.get(m.name)) } : null);
      session.setDetail(createDetailDraw(kernel, current));
      occlusionNow = current;
    };
    buildOcclusion();
    session.setOcclusionRebuild(buildOcclusion, dropOcclusion);
    releaseOcclusion = dropOcclusion;
    // DrawFrame's decal block runs over the same frames (decal-draw.mjs).
    const decals = (await loadScriptVmKernel()).decals;
    if (decals) session.setDecalKernel(decals, () => kernel.framePtr());
    else notes.push('Decals unavailable: the script VM core predates decal.rs; run npm run build:wasm');
  } catch (error) { notes.push(`BSP occlusion unavailable: ${error.message}`); }
  session.setPanZones(panZones);
  loadMark('occlusion');
  let audioDisposed = false;
  const disposeAudio = () => { if (audioDisposed) return; audioDisposed = true; runtime.audio?.dispose?.(); };
  return { game, session, actorSim, weaponSim, meshLighting, lipSync, notes, events, hudTextures, disposeAudio, loadMarks,
    // The script process this level's runtime attached to: a travel from here hands it to the next level (sim-worker.mjs, main.mjs).
    scriptProcess: runtime.process,
    // Measurement only (process-probe.mjs): the level interpreter's handle tables.
    handleTables: () => runtime.scriptVm?.handleTables() ?? null,
    // The current BSP occlusion (validation: scripts/validate-detail-play-sim.mjs runs a reference pass over it).
    occlusion: () => occlusionNow,
    // The page's WebGL context was lost and restored (docs/context-loss.md): the bindings whose cache poses the GPU mesh
    // instances held take the CPU path; the page applies these records before any later frame's.
    leaveGpu: reason => ({ actors: actorSim?.leaveGpu(reason) ?? [], weapon: weaponSim?.leaveGpu(reason) ?? [] }),
    // The next map's host replaces this one: nothing runs this runtime again,
    // so its identities leave the process-wide handle table, which would
    // otherwise keep the whole runtime alive (script-object-handles.mjs).
    // `keepProcess`, the script process the next level attaches to (a travel
    // arrival's: script-process.mjs), keeps its identities and their handles.
    dispose(keepProcess = null) {
      // The occlusion's blocks live in the script-VM kernel's memory, which outlives the level (one instance a realm): without
      // this, every map change kept its 32 MB work block and model tables (docs/long-session.md).
      disposeAudio(); releaseOcclusion(); session.dispose(); actorSim?.dispose();
      // (the interpreter leaves the process-wide WeakRef walks, which in Firefox kept every left level alive: docs/map-memory.md)
      runtime.scriptVm?.dispose();
      // (the rider pass's log of Base changes held this level's actors: base-epoch.mjs forgetNoted)
      forgetNoted();
      // (the realm's trace kernel's last model held this level's model, and through its trackedLineNodes this scope)
      forgetTraceModel();
      releaseHandleRange(hostStarts[hostIndex], hostStarts[hostIndex + 1] ?? handleLimit(), keepProcess ? identity => keepProcess.owns(identity) : null);
      // A process no level attaches to any more: the identities it kept through earlier levels go too.
      if (keepProcess !== runtime.process) releaseHandlesWhere(identity => runtime.process.owns(identity));
      // The image arena's views of the native heap are closures over this
      // runtime, and the process-wide FinalizationRegistry that returns image
      // ranges (script-runtime.mjs imageFinalizer) holds a token for each of
      // its objects: detached, neither keeps the runtime or its memory alive.
      runtime.arena.detach();
    } };
}
