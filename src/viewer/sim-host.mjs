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
  onProgress('Preparing original actor meshes…');
  try {
    const exportIndexByName = new Map(asset.pkg.exports.map((entry, i) => [entry.name, i + 1]));
    meshLighting = createMeshLightingView(runtime, () => runtime.levelFor(player()),
      { exportName, exportIndex: name => exportIndexByName.get(name) });
    // Player start logs in a new player; the layer follows the current one.
    actorSim = await createActorMeshSim(runtime, assets, asset, { player, lighting: meshLighting, childFrames,
      layout: gpu ? createGpuMeshLayout(gpu) : null,
      onCreate: creation => events.push({ kind: 'mesh-create', creation }), onRelease: id => events.push({ kind: 'mesh-release', id }),
      ...(meshBackend === 'javascript' ? { kernel: null } : {}) });
    meshLighting.kernel = actorSim.kernel;
    notes.push(`${actorSim.summary.npcs} NPC and ${actorSim.summary.props} prop meshes render live original poses and original mesh lighting in Play. Distance LOD, Fatness, fog/volumetric lights and animated/procedural mesh skins remain unsupported.`);
    for (const error of actorSim.summary.errors) notes.push(`${error.actor}: ${error.message}`);
  } catch (error) { notes.push(`Actor meshes unavailable: ${error.message}`); }
  const session = createSimSession(game, { assets, events });
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
    session.setOcclusion(createBspOcclusion(kernel, map.model, { surfaceTextureFlags,
      zoneActors: map.model.zones.map(zone => (zone.actor > 0 ? zone.actor : 0)) }));
  } catch (error) { notes.push(`BSP occlusion unavailable: ${error.message}`); }
  session.setLipSync(lipSync);
  session.setPanZones(panZones);
  let audioDisposed = false;
  const disposeAudio = () => { if (audioDisposed) return; audioDisposed = true; runtime.audio?.dispose?.(); };
  return { game, session, actorSim, meshLighting, lipSync, notes, events, hudTextures, disposeAudio,
    dispose() { disposeAudio(); session.dispose(); actorSim?.dispose(); } };
}
