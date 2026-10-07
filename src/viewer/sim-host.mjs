/** The simulation side of a loaded map (docs/sim-worker.md "Boot"): the
 * game, its frame session and the simulation halves of the actor mesh
 * layer, the view model and the corona pass, plus Galaxy's lip-sync
 * channels, built in the order Play built them. The page (?sim=inline,
 * ?sim=clone) and the worker (sim-worker.mjs) run this same code; its
 * inputs are plain data from the page's world:
 *
 * - `stampScene`, `panZones`, `childFrames`: world.stampScene(),
 *   world.panZoneNames() and whether the map has mirror planes;
 * - `gpu`, `weaponGpu`: the capacities of the page's GPU mesh instances
 *   (gpu-mesh.mjs), or null where the page has none (the CPU path);
 * - `meshBackend`: 'javascript' keeps the JavaScript GetFrame kernel;
 * - `musicLibrary`: Galaxy's music library service (galaxy-music-library.mjs
 *   connectMusicLibraryPort, the worklet's port), or null for the headless
 *   mirror. It outlives the map: `disposeAudio()` (also run by `dispose()`)
 *   lets the live audio unregister its music before the next map's runtime
 *   issues any library call.
 *
 * Everything the page must apply between frames goes to the session's
 * event queue (sim-session.mjs events). */
import { createGame } from './game.mjs';
import { createSimSession } from './sim-session.mjs';
import { createActorMeshSim } from './actor-mesh-sim.mjs';
import { createGpuMeshLayout } from './gpu-mesh-layout.mjs';
import { createWeaponOverlaySim } from './weapon-overlay-sim.mjs';
import { createCoronaScan } from './corona-scan.mjs';
import { createMeshLightingView } from './mesh-lighting-view.mjs';
import { createLipSyncChannels } from '../runtime/galaxy-lipsync-channels.mjs';
import { loadScriptVmKernel } from '../runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, moverTrackerMode, trackerMoverSpec, trackerTextureFlags } from '../runtime/brush-tracker.mjs';
import { readTexture } from '../unreal/textures.mjs';

export async function createSimHost(map, asset, assets, { randomSeed, subtitles, stampScene, panZones, childFrames,
  gpu = null, weaponGpu = null, meshBackend = null, musicLibrary = null, onConversationSpeech = null, onAudioVoice = null,
  onProgress = () => {} }) {
  const events = [], notes = [];
  let game;
  try {
    game = await createGame(map, asset, assets, { presentation: true, randomSeed, subtitles, musicLibrary,
      onLightingChanged: changes => events.push({ kind: 'lighting', changes }),
      onConversationSpeech: event => onConversationSpeech?.(event), onAudioVoice: event => onAudioVoice?.(event) });
  } catch (error) { notes.push(`Play mode unavailable: ${error.message}`); return { game: null, notes, events }; }
  const runtime = game.doors.scriptRuntime.runtime, player = () => game.player.collisionActor;
  const exportName = ref => asset.pkg.exports[ref - 1]?.name;
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
    actorSim = await createActorMeshSim(runtime, assets, asset, { player, lighting: meshLighting, childFrames,
      layout: gpu ? createGpuMeshLayout(gpu) : null,
      onCreate: creation => events.push({ kind: 'mesh-create', creation }), onRelease: id => events.push({ kind: 'mesh-release', id }),
      ...(meshBackend === 'javascript' ? { kernel: null } : {}) });
    meshLighting.kernel = actorSim.kernel;
    notes.push(`${actorSim.summary.npcs} NPC and ${actorSim.summary.props} prop meshes render live original poses and original mesh lighting in Play. Distance LOD, Fatness, fog/volumetric lights and animated/procedural mesh skins remain unsupported.`);
    for (const error of actorSim.summary.errors) notes.push(`${error.actor}: ${error.message}`);
  } catch (error) { notes.push(`Actor meshes unavailable: ${error.message}`); }
  const session = createSimSession(game, { assets, events, exportName });
  session.setScene(stampScene, actorSim);
  if (meshLighting) session.setMeshLighting(meshLighting);
  const hudTextures = game.hud ? session.hudTextures() : null;
  // The player's view model, with the layout of the page's own GPU mesh
  // instance for it.
  session.setWeapon(await createWeaponOverlaySim(runtime, assets, player, { kernel: actorSim?.kernel ?? null, lighting: meshLighting,
    layout: weaponGpu ? createGpuMeshLayout(weaponGpu) : null,
    onCreate: creation => events.push({ kind: 'weapon-create', creation }), onRelease: id => events.push({ kind: 'weapon-release', id }) }));
  session.setCoronas(createCoronaScan(runtime, { model: map.model, exportName, player }));
  const lipSync = createLipSyncChannels({ kernel: (await loadScriptVmKernel()).lipsync, ...game.lipSyncServices() });
  // The original BSP occlusion (bsp-occlusion.mjs) over the map's model, with
  // each surface texture's PolyFlags (UTexture +0x80, the packed bools).
  try {
    const textureFlags = new Map(), surfaceTextureFlags = [];
    for (const surface of map.model.surfaces) {
      if (!surface.texture) { surfaceTextureFlags.push(0); continue; }
      if (!textureFlags.has(surface.texture)) {
        const object = await assets.resolve(asset, surface.texture);
        textureFlags.set(surface.texture, texturePolyFlags(readTexture(object.asset, object.index).values));
      }
      surfaceTextureFlags.push(textureFlags.get(surface.texture));
    }
    const kernel = (await loadScriptVmKernel()).occlusion;
    if (!kernel) throw new Error('the script VM core predates it; run npm run build:wasm');
    // Engine's moving brush tracker (brush-tracker.mjs, docs/brush-tracker.md)
    // on the same model: its movers with their polygons' texture PolyFlags.
    let trackerMovers = null;
    if (moverTrackerMode() !== 'off' && kernel.trackerHeaderPtr) {
      trackerMovers = await collectTrackerMovers(assets, asset, map);
      await trackerTextureFlags(assets, asset, trackerMovers,
        object => texturePolyFlags(readTexture(object.asset, object.index).values), textureFlags);
    }
    // A fresh model and tracker: at load, and at each LoadMap that Player
    // start makes (the original deletes the tracker and loads the level
    // anew, then GNewBrushTracker after the actor start-up, 0x1038dfb5).
    let current = null;
    const buildOcclusion = () => {
      current?.dispose();
      occlusionNow = null;
      const level = runtime.levelFor(player()), index = new Map();
      level.actors.forEach((actor, i) => { if (actor && !index.has(actor.name)) index.set(actor.name, i); });
      const movers = (trackerMovers ?? []).filter(m => index.has(m.name)).sort((a, b) => index.get(a.name) - index.get(b.name));
      const read = (actor, name) => runtime.readNamed(actor, name);
      const actors = movers.map(m => level.actors[index.get(m.name)]);
      const specs = trackerMovers ? movers.map((m, i) => trackerMoverSpec(m, i, { hidden: read(actors[i], 'bHidden'),
        location: read(actors[i], 'Location'), rotation: read(actors[i], 'Rotation'), prePivot: read(actors[i], 'PrePivot') })) : null;
      current = createBspOcclusion(kernel, map.model, { surfaceTextureFlags,
        zoneActors: map.model.zones.map(zone => (zone.actor > 0 ? zone.actor : 0)), tracker: specs ? { movers: specs } : null });
      // The constructor's Update(NULL) at the game thread's control word,
      // unmeasured: PC64 is the assumption (docs/brush-tracker.md "Precision").
      if (specs) {
        const status = current.tracker.construct({ pc64: true });
        if (status) throw new Error(`the brush tracker's blocks are too small (status ${status})`);
      }
      session.setOcclusion(current, specs ? { names: movers.map(m => m.name), actors, indices: movers.map(m => index.get(m.name)) } : null);
      occlusionNow = current;
    };
    buildOcclusion();
    session.setOcclusionRebuild(buildOcclusion);
    // DrawFrame's decal block runs over the same frames (decal-draw.mjs).
    const decals = (await loadScriptVmKernel()).decals;
    if (decals) session.setDecalKernel(decals, () => kernel.framePtr());
    else notes.push('Decals unavailable: the script VM core predates decal.rs; run npm run build:wasm');
  } catch (error) { notes.push(`BSP occlusion unavailable: ${error.message}`); }
  session.setLipSync(lipSync);
  session.setPanZones(panZones);
  let audioDisposed = false;
  const disposeAudio = () => { if (audioDisposed) return; audioDisposed = true; runtime.audio?.dispose?.(); };
  return { game, session, actorSim, meshLighting, lipSync, notes, events, hudTextures, disposeAudio,
    dispose() { disposeAudio(); session.dispose(); actorSim?.dispose(); } };
}
