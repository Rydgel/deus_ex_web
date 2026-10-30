/** The simulation side of a Play frame (docs/sim-worker.md). Each step runs
 * where animate() ran it before the split, with the same error gating; the
 * frame's results come back as plain data for the drawing side. Steps not
 * yet moved here still run from main.mjs. */
import { handleOf, identityOfHandle } from '../runtime/script-object-handles.mjs';
import { plainTexture } from '../runtime/script-window-plain-texture.mjs';
import { createSpriteScan } from './sprite-scan.mjs';
import { constructRenderIterator, renderIteratorNativeClass } from '../runtime/script-render-iterator.mjs';
import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { fromView } from '../unreal/geometry.mjs';
import { createPlayCamera, applyPlayFrame, pointCamera, projectionOf, projectionOfFields, setFrameProjection, verticalFov, setPixelCentre,
  setProjectionState } from './play-camera.mjs';
import { createDrawnSet } from './drawn-set.mjs';
import { viewportFlash } from '../runtime/screen-flash.mjs';
import { LEVEL_ACTION } from '../runtime/script-console-level-action.mjs';
import { createMeshFramePack, PACK_WORDS } from './mesh-frame-pack.mjs';
import { createDecalDraw } from '../runtime/decal-draw.mjs';
import { OCCLUSION_DETAIL, OCCLUSION_POINTS, OCCLUSION_SPRITE_KEYS, SETUP, SETUP_OUT_WORDS, SETUP_STATUS, meshRecordFields } from '../runtime/bsp-occlusion.mjs';
import { packDynamics, patchDynamics, candidateWords, actorOcclusionMode, childFrameSprites, iteratorSpritesByOrder } from './dynamics-candidates.mjs';
import { createLightNoise, lightNoiseSnapshot } from '../runtime/static-lighting.mjs';
import { lightGlobals } from '../runtime/light-globals.mjs';
import { filterMovingLight, movingLightInView, surfaceLightClass, viewPlanesOf, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
import { dynamicActorRoute } from '../runtime/render-visibility.mjs';
import { TRACKED_MOVER_MIRRORS, childFramesMode, iteratorFramesMode } from './mirror-passes.mjs';

/** A thrown error as plain data: structured clone drops an Error's own
 * properties (`travel`, `partial`). */
export const plainError = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error),
  stack: error?.stack ?? null, travel: error?.travel ?? null, partial: error?.partial ?? null });

/** A HUD texture reference as plain data: the page decodes it from its own
 * asset store. */
export { plainTexture };
/** The window host's GC draw commands (script-window-host.mjs callVirtual)
 * as plain data. */
export const plainHudCommands = (commands, tilesPlain = false) => commands.map(command => command.kind === undefined && tilesPlain ? command
  : command.kind === 'clearZ' ? { kind: 'clearZ' }
  // GC.DrawActor's mesh draw (script-window-host.mjs, docs/gc-draw-actor.md): the planner's binding id, frame record and decision.
  : command.kind === 'actor' ? { kind: 'actor', actor: command.actor, draw: command.draw }
  : command.kind === 'viewport'
  // A ViewportWindow's world pass (script-window-viewport.mjs): plain already.
  ? { kind: 'viewport', x: command.x, y: command.y, width: command.width, height: command.height,
    location: [...command.location], rotation: [...command.rotation], fov: command.fov, clearZ: command.clearZ,
    hidden: [...command.hidden], behindView: command.behindView, pass: command.pass ?? null }
  : ({ texture: plainTexture(command.texture),
  x: command.x, y: command.y, width: command.width, height: command.height, u: command.u, v: command.v,
  ul: command.ul, vl: command.vl, color: command.color, style: command.style }));

// Words of an array or a typed array as a plain array (Array.from over a typed array goes through its iterator, which makes a result
// object per element below TurboFan), and the same words as float32 values.
const wordsArray = (words, from, count) => {
  const out = new Array(count);
  for (let k = 0; k < count; k++) out[k] = words[from + k];
  return out;
};
const bitWords = new Uint32Array(64), bitFloats = new Float32Array(bitWords.buffer);
const floatWords = (words, from, count) => {
  for (let k = 0; k < count; k++) bitWords[k] = words[from + k];
  const out = new Array(count);
  for (let k = 0; k < count; k++) out[k] = bitFloats[k];
  return out;
};
const wordFloat = word => (bitWords[63] = word, bitFloats[63]);

/** The dt of a level's first frame: the page posts it with no earlier post to measure from (main.mjs postSimFrame). */
export const FIRST_FRAME_DT = 1000 / 60 / 1000;
/** The Frame->Sprite of a frame that draws no world (actors): no binding ids. */
const NO_SPRITES = new Set();

/** `assets` is the simulation side's asset store (sprite texture sizes).
 * `events` is the ordered queue of what the simulation hands the page
 * between frames (the actor mesh layer's and the view model's creation and
 * release records, lighting changes); each frame() snapshot takes it. */
export function createSimSession(game, { assets = null, events = [], exportName = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime;
  let failed = false, panZones = [], lastViewLocation = null, current = null;
  // The travel step's request (travel.mjs) for the next level, handed to the page once; the level it left does not tick again.
  let travelled = false;
  // The first tick, run ahead of the first frame (preTick): its errors and travel request, which that frame takes.
  let preTicked = null;
  // Inspect's free camera, from the page's plain camera state.
  const inspectCamera = createPlayCamera();
  // Play's camera, pointed as the page points its own (play-camera.mjs); the
  // page's resize count says when its canvas aspect reset the camera.
  const camera = createPlayCamera();
  let resizesSeen = -1;
  // The drawn set (drawn-set.mjs) from the page's static brush and mirror
  // meshes, the actor mesh layer (actor-mesh-sim.mjs) and the mesh lighting
  // view (mesh-lighting-view.mjs), all simulation-side.
  let drawn = null, actorScene = null, meshLighting = null, moverActors = new Map(), stamped = null;
  // The corona scan (corona-scan.mjs) and the view model's simulation half
  // (weapon-overlay-sim.mjs), the frame's last world steps.
  let coronaScan = null, weaponSim = null, size = null;
  // The console's canvas for LoadMap's PaintProgress frame (script-console-level-action.mjs, docs/loading-frame.md).
  let levelAction = null;
  // SaveCurrentLevel's PaintProgress frame (travel-save.mjs, docs/loading-frame.md "Saving"), drawn in the save, between frames or in a
  // tick: the flash PaintProgress swaps in and the console's DrawLevelAction tiles for the last frame's size. Its world and HUD are the
  // frame the page drew last, which the page draws again under them (main.mjs drawProgressFrame).
  const savingFrame = () => {
    const viewer = game.player.collisionActor, [width, height] = size;
    let flash = null;
    const { console } = levelAction.paintProgress({ player: viewer, width, height,
      hudPaint: () => { flash = viewportFlash({ flashScale: runtime.readNamed(viewer, 'FlashScale'), flashFog: runtime.readNamed(viewer, 'FlashFog') }); } });
    return { action: LEVEL_ACTION.saving, width, height, flash, console };
  };
  // The original BSP occlusion (bsp-occlusion.mjs) and DrawWorld's frame
  // counter (0x10b5a700), which schedules its bound tests. Unless
  // ?actorOcclusion=frustum, the main frame's OccludeBsp waits for
  // SetupDynamics' candidates (`pendingOcclusion`, run by occludeMain) and
  // its Frame->Sprite decides the main frame's actors.
  let occlusion = null, drawWorlds = 0, pendingOcclusion = null;
  // ViewportWindow world frames (planViewportPass): how many the last HUD
  // frame drew, and their camera.
  let viewportFrames = 0;
  const viewportCamera = createPlayCamera();
  // The moving brush tracker's movers ({names, actors, indices: their
  // Level.Actors slots} in its order; null with ?moverTracker=off) and the
  // rebuild Player start's LoadMap needs.
  let trackerMovers = null, rebuildOcclusion = null, dropOcclusion = null;
  const actorOcclusion = actorOcclusionMode() !== 'frustum';
  // OccludeFrame's child frames (mirror and sky) with their own OccludeBsp;
  // ?childFrames=off keeps the frustum-tested passes.
  const childFrames = childFramesMode() !== 'off', iteratorMode = iteratorFramesMode(), iteratorFrames = iteratorMode !== 'off';
  // DrawFrame's decal block after the main frame's OccludeBsp
  // (decal-draw.mjs, docs/decals.md), with the kernel's frame words.
  let decalDraw = null, occlusionFramePtr = null;
  // D3DDrv's detail-texture pass over the main frame and its child frames (detail-draw.mjs); null without a detail table.
  let detailDraw = null;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const weaponFrustum = new THREE.Frustum(), weaponMatrix = new THREE.Matrix4();
  // The live records of this frame's moving-light scan, for the simulation
  // side's own consumers (the mesh lighting frame); the snapshot carries
  // handles instead of actors.
  const live = { lights: null, meshItems: [], sprites: [], iterators: null, iteratorIndex: null };
  // URender::PreRender's light noise (0x10b13080, called at 0x10b146ae on
  // every drawn frame with Level.TimeSeconds, docs/dynamic-lighting.md
  // "Time-varying moving lights"): its appFrand draws come from the game's
  // shared stream, after PlayerCalcView and before the PreRender event and
  // DrawWorld's draws. The page's light frame takes its tables.
  const lightNoise = createLightNoise(() => runtime.rng.frand()), lights = lightGlobals(runtime);
  lights.noise = lightNoise;
  // SetupForSurf's Strobe calls (light-globals.mjs `strobe`): the drawn
  // surfaces whose light list holds a Strobe light (a class 1 light, set up
  // every frame), and the moving Strobe lights that reach a drawn surface.
  // Scripts never set Strobe (scripts/census-moving-lights.mjs), so the
  // lists are taken once, from the lights that are Strobe at load.
  // `strobeMainOnly` is a validation switch (strobeReach): the main frame's surfaces alone, as the first version of lightMapStrobe scanned.
  // `strobeAlways` scans although an earlier caller flipped the flag this frame (the scan is then only recorded, never flipped).
  let strobeSurfaces = null, strobeVisible = null, strobeMainOnly = false, strobeAlways = false;
  function lightMapStrobe(visible, scanned, timeSeconds) {
    strobeVisible = visible;
    const started = performance.now();
    const level = runtime.levelFor(game.player.collisionActor), model = level.model;
    const read = (actor, name) => runtime.readNamed(actor, name);
    if (!strobeSurfaces) {
      strobeSurfaces = new Map();
      const byName = new Map();
      for (const actor of level.actors) if (actor && !byName.has(actor.name)) byName.set(actor.name, actor);
      const strobeOf = new Map();
      const isStrobe = ref => {
        if (!strobeOf.has(ref)) {
          const actor = exportName ? byName.get(exportName(ref)) : null;
          strobeOf.set(ref, actor && (read(actor, 'LightType') & 255) === 5 ? actor : null);
        }
        return strobeOf.get(ref);
      };
      for (let index = 0; index < model.surfaces.length; index++) {
        const lightMapIndex = model.surfaces.lightMap(index);
        const lightActors = lightMapIndex >= 0 && lightMapIndex < model.lightMaps.length ? model.lightMaps.lightActors(lightMapIndex) : -1;
        if (lightActors < 0) continue;
        const found = [];
        for (let i = lightActors; i < model.lights.length && model.lights[i]; i++) { const actor = isStrobe(model.lights[i]); if (actor) found.push(actor); }
        if (found.length) strobeSurfaces.set(index, found);
      }
    }
    // A new TimeSeconds is needed for a flip, and some Strobe light to call.
    timeSeconds = Math.fround(timeSeconds);
    const already = lights.strobe.time === timeSeconds;
    if (already && !strobeAlways) return;
    let moving = null;
    for (const light of scanned ?? [])
      if ((light.values.LightType & 255) === 5 && surfaceLightClass(light.values) === 2) (moving ??= []).push(light);
    if (!strobeSurfaces.size && !moving) return;
    // (a Strobe light's liveness is read once per scan, not once per node)
    const liveOf = new Map();
    const live = actor => {
      let alive = liveOf.get(actor);
      if (alive === undefined) {
        const values = { LightType: read(actor, 'LightType'), LightBrightness: read(actor, 'LightBrightness'), bStatic: read(actor, 'bStatic'),
          bNoDelete: read(actor, 'bNoDelete'), bDynamicLight: read(actor, 'bDynamicLight'), LightEffect: read(actor, 'LightEffect') };
        liveOf.set(actor, alive = (values.LightType & 255) === 5 && surfaceLightClass(values) === 1);
      }
      return alive;
    };
    // DrawFrame (0x10b1a2d0) draws the frame's child frames first (the loop
    // at 0x10b1a339 calls itself on Frame->Child and its siblings), then
    // sets up its own surfaces (SetupForSurf through the light manager,
    // 0x10b1aa99), so every frame's drawn surfaces count: the main frame's
    // and each mirror and sky child frame's. The level surfaces drawn (the
    // brush tracker's fragment nodes, past the level model's, are movers'
    // polygons: their light maps are the movers').
    const frames = [{ nodes: visible.nodes, planes: visible.master?.planes ?? null },
      ...(strobeMainOnly ? [] : visible.frames ?? []).map(frame => ({ nodes: frame.nodes, planes: frame.planes ?? null }))];
    const counts = [], movingCounts = [];
    let any = false;
    for (const { nodes, planes } of frames) {
      let found = 0, reached = 0;
      const drawn = moving ? new Set() : null;
      for (const node of nodes) {
        if (node >= model.nodes.length) continue;
        const surface = model.nodes.surface(node);
        drawn?.add(surface);
        const actors = strobeSurfaces.get(surface);
        if (actors && actors.some(live)) found++;
      }
      // A moving Strobe light is set up for a frame when SetupDynamics takes
      // it (its sphere against the frame's four ViewPlanes) and Filter puts
      // it on one of the frame's drawn surfaces.
      if (moving) {
        const viewPlanes = planes ? viewPlanesOf(planes) : null;
        for (const light of moving) {
          if (viewPlanes && !movingLightInView(light.location, light.values, viewPlanes)) continue;
          for (const surface of filterMovingLight(model, light.location, worldLightRadius(light.values), Boolean(light.values.bSpecialLit)))
            if (drawn.has(surface)) { reached++; break; }
        }
      }
      counts.push(found); movingCounts.push(reached);
      if (found || reached) any = true;
    }
    // Validation (liveProbe `strobe`): the Strobe-lit surfaces each frame drew at the last call.
    lights.strobeScan = { time: timeSeconds, frames: counts, moving: movingCounts, already, ms: performance.now() - started };
    // The Strobe function's test (0x10b05b30): a new TimeSeconds flips the flag.
    if (any && !already) { lights.strobe.time = timeSeconds; lights.strobe.flag ^= 1; }
  }
  // RenderIterator construction for the sprite scan: the iterator's
  // RenderInterface object, owned by the actor's native object. A pre-placed
  // actor hashes its owned objects by its measured GObjObjects index
  // (docs/object-index-captures.md). The class constructor and Destroy are
  // the recovered native ones (script-render-iterator.mjs).
  const iteratorNatives = {
    write: (identity, name, value) => runtime.writeNamed(identity, name, value),
    isActor: record => runtime.classIsA(runtime.instance(record.identity).cls, runtime.actorClass.record),
    destroyObjectBase: receiver => runtime.destroyObjectBase(receiver),
  };
  const constructIterator = (cls, outer) => {
    const linked = [...runtime.linkedClasses].find(candidate => candidate.record.key === (cls.key ?? cls.record?.key));
    if (!linked) throw new Error(`RenderIteratorClass ${cls.key} is not linked`);
    const row = renderIteratorNativeClass(linked);
    const base = runtime.actorLifecycle.construction, native = runtime.instance(outer).nativeObject;
    if (!native) throw new Error(`${outer.name} has no native object to own its RenderInterface`);
    if (!Number.isInteger(native.index) && !Number.isInteger(native.hashIndex)) {
      const measured = runtime.measuredObjectIndex(outer);
      if (!Number.isInteger(measured)) throw new Error(`${outer.name} has no measured object index for its RenderInterface`);
      native.hashIndex = measured;
    }
    return runtime.constructObject(linked, { outer: native, name: 'None', flags: 0, template: null }, {
      ...base, validate: () => true, initNativeProperties: () => {},
      nativeConstructor: object => constructRenderIterator(object, row, iteratorNatives) });
  };
  // Validation (iteratorProbe, scripts/validate-iterator-frames-play.mjs): the
  // render iterators' runs per frame, their draws from the shared stream and
  // each frame's mesh items.
  const iteratorStats = { scans: 0, rescans: 0, visited: 0, drawsScan: 0, drawsRescan: 0, draws: 0, lastFrames: [], msRescan: 0, msPack: 0, msScan: 0, msVisibility: 0,
    patched: 0, packed: 0 };
  const spriteScan = createSpriteScan(runtime, { player: () => game.player.collisionActor, constructIterator,
    frand: () => { iteratorStats.draws++; return runtime.rng.frand(); },
    // validation only: viewProbe({rngPin}) sets game.rngPin, the state every SetupDynamics run starts from
    pin: () => { if (game.rngPin != null) game.random.seed(game.rngPin); } });
  // A sprite's texture size (Texture.USize/VSize, else its first mip), as
  // the page's sprite scene sizes it; a sprite draws once its texture has
  // decoded, here as on the page (sprite-scene.mjs).
  const spriteTextures = assets ? new TextureStore(assets) : null, spriteSizes = new Map();
  const spriteSize = (reference, masked) => {
    const key = `${reference.key ?? `${reference.package}:${reference.index}`}:${masked}`;
    let entry = spriteSizes.get(key);
    if (!entry) {
      spriteSizes.set(key, entry = { size: null });
      assets.get(reference.package).then(asset => spriteTextures.get(asset, reference.index, masked)).then(data => {
        entry.size = [data.values.USize ?? data.mips[0].width, data.values.VSize ?? data.mips[0].height];
      }).catch(error => { entry.failed = error.message; });
    }
    return entry.size;
  };
  // Each mover's brush-matrix inputs that never change (class defaults
  // merged), shared by every frame's mover states.
  const moverValues = new Map(game.collision.movers.map(mover => [mover.name, {
    MainScale: mover.values.MainScale, PostScale: mover.values.PostScale, PrePivot: mover.values.PrePivot,
    Rotation: mover.values.Rotation }]));
  // A bDynamicLightMover (no script writes it: Mover.uc only declares it) also sends its Region.iLeaf, which SetupForSurf
  // reads (+0xcc) for its surfaces' lights (lighting.mjs relightMover).
  const dynamicLightMovers = new Set(game.collision.movers.filter(mover => mover.values.bDynamicLightMover).map(mover => mover.name));
  const leafOf = mover => runtime.readNamed(mover, 'Region')?.['engine.actor.pointregion.ileaf'] ?? -1;
  const movers = () => game.collision.movers.map(mover => ({ name: mover.name, values: moverValues.get(mover.name),
    position: [...mover.position], rotation: mover.rotation ? [...mover.rotation] : null, offset: [...mover.collider.offset],
    leaf: dynamicLightMovers.has(mover.name) ? leafOf(mover) : undefined }));
  const plainView = view => ({ location: [...view.location], rotation: [...view.rotation], fov: view.fov });
  const plainLight = light => ({ handle: handleOf(light.actor), name: light.name, location: light.location,
    values: light.values, levelBrightness: light.levelBrightness, flickerKey: light.flickerKey });
  // Render.dll's sky frame (0x10b18410): only when LevelInfo.SkyZone (+0x384)
  // is set; the frame zone's ZoneInfo (LevelInfo when the zone has none)
  // supplies its SkyZone, whose Location is the sky frame's origin and whose
  // Rotation detransforms the view coords. In Play the zones' SkyZone is what
  // the original LinkToSkybox set at startup.
  function sky(location) {
    const level = runtime.levelFor(game.player.collisionActor), info = level.actors[0];
    if (!runtime.readNamed(info, 'SkyZone')) return null;
    const zone = level.pointRegion(location)?.zone ?? info;
    const sky = runtime.readNamed(zone, 'SkyZone') ?? runtime.readNamed(info, 'SkyZone');
    return { location: [...runtime.readNamed(sky, 'Location')], rotation: [...runtime.readNamed(sky, 'Rotation')] };
  }
  // DrawWorld's OccludeBsp for the main frame (docs/bsp-occlusion.md
  // "Play"): the master frame from the view at the render viewport's size,
  // each zone's SkyZone, the frame counter and TimeSeconds. The nodes whose
  // polygons the draw lists keep, the mirror child requests' nodes and
  // whether a sky frame was made. ShowFlags 0x800 and the D3D device's
  // ShinySurfaces are set in Play.
  // With `setupCount`, Setup runs on that many packed candidates first and
  // `sprites` lists Frame->Sprite's keys (RenderNext order).
  // SetupDynamics' moving brushes (0x10b230d5): Update for every mover its
  // level-actor pass admits (render-visibility.mjs dynamicActorRoute,
  // 0x10b22e1f-0x10b22f2d), in Level.Actors order, at 24 bits, with the
  // Location and Rotation the frame renders. A hidden mover, the
  // first-person view target and DrawWorld's excluded actor (0x10b1a161:
  // none behind the view, else the ViewTarget or the view actor) are not
  // updated and stay where they were last rendered; so does a mover no
  // longer in Level.Actors. Only the main frame runs it here: a mirror's
  // child frame would find every mover where the main frame left it.
  // HighDetailActors is taken as set (the render device's default).
  function updateMovers() {
    const tracker = occlusion?.tracker;
    if (!trackerMovers || !tracker?.live()) return;
    const viewer = game.player.collisionActor, level = runtime.levelFor(viewer);
    const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch { return undefined; } };
    const behindView = Boolean(read(viewer, 'bBehindView')), viewTarget = read(viewer, 'ViewTarget') ?? null;
    const route = { viewActor: viewer, excludedActor: behindView ? null : (viewTarget ?? viewer), read, isBrush: () => true,
      behindView, viewTarget };
    const { actors, indices } = trackerMovers;
    trackerMovers.admitted = 0;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      if (indices[i] < 0) continue;
      if (level.actors[indices[i]] !== actor) {
        // Moved by the array's compaction, or gone for good (-1).
        indices[i] = level.actors.indexOf(actor);
        if (indices[i] < 0) continue;
      }
      if (dynamicActorRoute(actor, route) !== 'moving-brush') continue;
      trackerMovers.admitted++;
      const location = read(actor, 'Location');
      for (let k = 0; k < 3; k++) f32b[k] = location[k];
      tracker.setMover(i, { locationBits: [u32b[0], u32b[1], u32b[2]], rotation: read(actor, 'Rotation') });
      tracker.update(i);
    }
  }
  const f32b = new Float32Array(3), u32b = new Uint32Array(f32b.buffer);
  // The tracker's transformed polygon vertices of the movers it rebuilt since
  // the last frame the page received (revision by revision; everything again
  // after a rebuild of the tracker): `visibility.moverPoints`, mover name ->
  // flat Float32Array (brush-tracker.mjs moverPoints). The page poses the
  // movers' meshes with them (docs/frame-projection.md "Movers"); null without
  // a tracker.
  let sentRevisions = null;
  function attachMoverPoints(result) {
    const tracker = occlusion?.tracker;
    if (!trackerMovers || !tracker?.live()) { result.moverPoints = null; return; }
    sentRevisions ??= new Array(trackerMovers.names.length).fill(-1);
    const out = {};
    trackerMovers.names.forEach((name, i) => {
      const revision = tracker.revision(i);
      if (revision === sentRevisions[i]) return;
      sentRevisions[i] = revision;
      out[name] = tracker.moverPoints(i).points;
    });
    result.moverPoints = out;
  }
  // A zone's SkyZone for the sky child frame (occlude.rs sky_coords): its
  // Location, Rotation and Region.ZoneNumber.
  function skyRecord(sky) {
    if (!sky) return null;
    const region = runtime.readNamed(sky, 'Region');
    return { location: [...runtime.readNamed(sky, 'Location')], rotation: [...runtime.readNamed(sky, 'Rotation')],
      zone: region?.['engine.actor.pointregion.zonenumber'] ?? 0 };
  }
  // Every zone's SkyZone record, a sky actor's read once for the zones that share it (most zones name the same one; each read of
  // its Region, Location and Rotation is a copy). The array and the records are used by setZoneSkies before the next call.
  const skiesScratch = [], skySeen = [], skyMade = [];
  function zoneSkies(zoneActors, info) {
    let distinct = 0;
    skiesScratch.length = zoneActors.length;
    for (let i = 0; i < zoneActors.length; i++) {
      const zone = zoneActors[i], sky = runtime.readNamed(zone ?? info, 'SkyZone');
      let k = 0;
      while (k < distinct && skySeen[k] !== sky) k++;
      if (k === distinct) { skySeen[distinct] = sky; skyMade[distinct] = skyRecord(sky); distinct++; }
      skiesScratch[i] = skyMade[k];
    }
    skySeen.fill(null, 0, distinct); skyMade.fill(null, 0, distinct);
    return skiesScratch;
  }
  // A frame's drawn nodes (Uint32Array) and the tracked movers' polygon
  // ordinals its draw lists hold, by mover name (null without the tracker),
  // and its mover draw items (`moverItems`, in draw-list order): each one's
  // mover, polygon, iZone (SetupForSurf's fog-zone test reads the item's
  // zone), its surface's pBase and vectors as the tracker holds them (the
  // light-map lattice of a dynamic surface) and its fragments' points
  // (the polygons the item draws, world floats).
  // A frame's drawn polygons' nodes (draw lists 0 to 2, each in OccludeBsp's order) and the tracked movers' polygons among them,
  // from its flat draw lists (bsp-occlusion.mjs `flatDraw`: per list, each entry's iSurf, iZone and polygon count, and the
  // polygons' nodes).
  // The bindings by id, kept while the list is the same bindings in the same order (a Map of all of them, 300 on the Island, made
  // again every frame was most of what the stamps step allocated).
  let idIndex = { list: [], map: new Map() };
  function bindingsById(bindings) {
    const list = idIndex.list;
    let same = list.length === bindings.length;
    for (let i = 0; same && i < list.length; i++) if (list[i] !== bindings[i]) same = false;
    if (same) return idIndex.map;
    const map = new Map();
    for (let i = 0; i < bindings.length; i++) map.set(bindings[i].id, bindings[i]);
    idIndex = { list: bindings.slice(), map };
    return map;
  }
  function concatenated(listNodes, total) {
    const nodes = new Uint32Array(total);
    nodes.set(listNodes[0]); nodes.set(listNodes[1], listNodes[0].length); nodes.set(listNodes[2], listNodes[0].length + listNodes[1].length);
    return nodes;
  }
  function drawnOf({ entries, nodes: listNodes }) {
    // The decode's three lists are consecutive views of one exact buffer (bsp-occlusion.mjs flatLists): the whole list is a view of it.
    const first = listNodes[0], total = first.length + listNodes[1].length + listNodes[2].length;
    const nodes = first.byteOffset === 0 && first.buffer.byteLength === 4 * total && listNodes[2].buffer === first.buffer
      ? new Uint32Array(first.buffer) : concatenated(listNodes, total);
    let movers = null, moverItems = null;
    if (trackerMovers && occlusion.tracker?.live()) {
      movers = {}; moverItems = [];
      const facets = new Map();
      for (let list = 0; list < 3; list++) {
        const listEntries = entries[list], polyNodes = listNodes[list];
        for (let e = 0, first = 0; e < listEntries.length; e += 3) {
          const iSurf = listEntries[e], zone = listEntries[e + 1], count = listEntries[e + 2], from = first;
          first += count;
          const owner = occlusion.tracker.surfOwner(iSurf);
          if (!owner) continue;
          const name = trackerMovers.names[owner.tag - 0x40000000];
          (movers[name] ??= []).push(owner.ordinal);
          if (!facets.has(iSurf)) facets.set(iSurf, occlusion.tracker.surfaceFacet(iSurf));
          const fragments = [];
          for (let p = from; p < from + count; p++) fragments.push(occlusion.nodePolygon(polyNodes[p]));
          moverItems.push({ mover: name, polygon: owner.ordinal, zone, facet: facets.get(iSurf), fragments });
        }
      }
    }
    return { nodes, movers, moverItems };
  }
  // A span's pixel bounds [minX, startY, maxX, endY) (top-down), or null (decodeFrames computes them with skipSpritePixels).
  function spanBounds(span) {
    if (span.bounds !== undefined) return span.bounds;
    let minX = Infinity, maxX = -Infinity, startY = Infinity, endY = -Infinity;
    span.lines.forEach((line, i) => {
      if (!line.length) return;
      minX = Math.min(minX, line[0][0]); maxX = Math.max(maxX, line.at(-1)[1]);
      startY = Math.min(startY, span.startY + i); endY = Math.max(endY, span.startY + i + 1);
    });
    return minX < maxX && startY < endY ? [minX, startY, maxX, endY] : null;
  }
  // The main frame's coordinates and ViewPlanes, which SetupDynamics reads
  // (the mesh lighting's leaf lists, mesh-lighting-view.mjs): the master frame
  // built before the frame's lighting setup, once per frame. Its words and
  // planes depend on the view and the render rectangle alone, so visibility()
  // builds the same ones later, after the moving brush tracker's update has
  // moved the zone lookup's model. Null without OccludeBsp or a drawn rectangle.
  const frameMasters = new WeakMap();
  function frameMaster(frame = current) {
    if (!occlusion || !frame?.view || !size) return null;
    const rect = frame.renderRect ?? { width: size[0], height: size[1], render: true };
    if (!(rect.render && rect.width > 0 && rect.height > 0)) return null;
    let master = frameMasters.get(frame);
    if (!master) {
      const built = occlusion.master({ location: frame.view.location, rotation: frame.view.rotation, width: size[0], height: size[1],
        fov: frame.view.fov, render: { width: rect.width, height: rect.height } });
      master = { words: wordsArray(built.frame, 0, built.frame.length), planes: wordsArray(built.fields, 41, 16), prj: wordsArray(built.fields, 25, 4) };
      frameMasters.set(frame, master);
    }
    return master;
  }
  // `movers` false (a ViewportWindow's frame) keeps the tracker as the main
  // frame left it: the original updates the moving brush tracker on the game
  // thread (64 bits) when a mover moves, never inside a render-pass DrawWorld,
  // where the x87 model now runs at 24 bits (render-precision.mjs).
  function visibility(view, width, height, setupCount = -1, { decals: decalBlock = true, movers: moverUpdate = true, frameDynamics = null,
    detail: detailBlock = true, origin = null } = {}) {
    const level = runtime.levelFor(game.player.collisionActor), info = level.actors[0];
    const moversStarted = performance.now();
    if (moverUpdate) updateMovers();
    const moversMs = performance.now() - moversStarted;
    occlusion.setZoneSkies(zoneSkies(level.zoneModel.zoneActors, info));
    // CreateMasterFrame at the viewport's size, then the render pass's
    // ComputeRenderSize at 24 bits on the render rectangle (XRootWindow::
    // PreRender for the main frame, ViewportWindow's Draw for a camera's;
    // docs/render-pass-precision.md "The 3D frame's projection").
    const [viewportWidth, viewportHeight] = size ?? [width, height];
    const built = occlusion.master({ location: view.location, rotation: view.rotation, width: viewportWidth,
      height: viewportHeight, fov: view.fov, render: { width, height } });
    const words = built.frame;
    f32[0] = runtime.readNamed(info, 'TimeSeconds');
    // The decal block clips against the saved polygons' points (option
    // 0x100); Setup's sprites need only their keys (0x200).
    const decals = decalBlock && (decalDraw?.wanted(level) ?? false);
    // The detail pass takes the saved points of the polygons it can use (a ViewportWindow's frames keep the camera's
    // projection and draw none: docs/frame-projection.md "Detail textures").
    const details = detailBlock && detailDraw && origin;
    words[44] = ++drawWorlds; words[45] = u32[0];
    words[46] = 3 | (decals ? OCCLUSION_POINTS : 0) | (setupCount >= 0 ? OCCLUSION_SPRITE_KEYS : 0) | (details ? OCCLUSION_DETAIL : 0); words[47] = 0;
    const started = performance.now();
    const result = occlusion.run(words, [], { setupCount, skipPoints: true, skipSpritePixels: true, flatDraw: true,
      children: childFrames ? { fov: view.fov, orthoZoom: 0, frameDynamics } : null });
    const { nodes, movers, moverItems } = drawnOf(result.drawn);
    const detail = details ? detailDraw.frames(built, origin, result) : null;
    // The mirror requests: a level node, or a tracked mover's polygon
    // (mirror-passes.mjs requestedGroup).
    const mirrors = [];
    for (const child of result.children) {
      if (child.kind !== 'mirror') continue;
      const owner = movers ? occlusion.tracker.surfOwner(occlusion.nodeSurf(child.iNode)) : null;
      mirrors.push(owner ? `${trackerMovers.names[owner.tag - 0x40000000]}:${owner.ordinal}` : child.iNode);
    }
    if (movers) mirrors.push(TRACKED_MOVER_MIRRORS);
    const occluded = performance.now();
    const fragments = decals ? decalDraw.frame(level, game.player.collisionActor, occlusionFramePtr(), result.stream) : null;
    // OccludeFrame's child frames: each one's visible nodes and mover
    // polygons, its Frame->Sprite keys, the group a mirror frame looks
    // through (a tracked mover's polygon) and its span's bounds.
    const frames = result.frames.map(frame => {
      const drawnHere = drawnOf(frame.drawn);
      const ownerOf = node => frame.kind === 'mirror' && drawnHere.movers ? occlusion.tracker.surfOwner(occlusion.nodeSurf(node)) : null;
      const keyOf = owner => owner ? `${trackerMovers.names[owner.tag - 0x40000000]}:${owner.ordinal}` : null;
      const owner = ownerOf(frame.iNode);
      // Every mirror request that made or merged into this frame (the original's
      // mirror requests all pass iSurf 0, 0x10b18b4a: coplanar mirrors in one zone,
      // e.g. three panes side by side, share one frame), each with its tracked
      // mover polygon's key when it has one.
      const requests = frame.requests.map(node => ({ iNode: node, group: keyOf(ownerOf(node)) }));
      // Its DrawLodMesh inputs: the frame's Coords and FX (ComputeRenderSize
      // fields +0x34 and +0xb8; docs/script-lodmesh-lod.md "Play").
      return { index: frame.index, parent: frame.parent, kind: frame.kind, iNode: frame.iNode, recursion: frame.recursion,
        group: keyOf(owner), requests,
        bounds: spanBounds(frame.span), nodes: drawnHere.nodes, movers: drawnHere.movers,
        moverItems: drawnHere.moverItems,
        // The frame's Coords (origin, X, Y, Z), as its fog maps read them,
        // its Mirror (+0x20, a float) and its four ViewPlanes' words (+0x12c;
        // SetupDynamics' moving-light test, mesh lighting's LeafLights).
        coords: floatWords(frame.fields, 0, 12),
        mirror: wordFloat(frame.mirror), planes: wordsArray(frame.fields, 41, 16),
        // Its projection (Proj.Z, RProj.Z, FX15, FY15, Coords) for the page's vertex stage
        // (docs/frame-projection.md); the rectangle is the root's.
        projection: projectionOfFields(frame.fields, width, height),
        sprites: spriteKeys(frame.sprites), spriteScreens: frame.spriteScreens,
        lod: { coords: floatWords(frame.fields, 0, 12), fx: wordFloat(frame.fields[12]) },
        // Its PrjXM..PrjYP (+0xec..+0xf8): the planes DrawLodMesh's outcodes of a pawn's special vertices read in this frame
        // (docs/weapon-attachment.md "Mirror frames"); a child's are those of its own clipped window, not the main frame's.
        prj: floatWords(frame.fields, 25, 4) };
    });
    // DrawLodMesh's inputs from the master frame: Frame->Coords and FX
    // (docs/script-lodmesh-lod.md "Play").
    const lod = { coords: floatWords(words, 0, 12), fx: wordFloat(words[18]) };
    // The master frame as OccludeBsp got it, with the inputs that made it
    // (validate-master-frame-play.mjs; docs/render-pass-precision.md).
    // `planes`: the frame's four ViewPlanes (+0x12c), as words.
    const master = { words: wordsArray(words, 0, words.length), planes: wordsArray(built.fields, 41, 16), prj: wordsArray(built.fields, 25, 4), location: wordsArray(view.location, 0, view.location.length), rotation: wordsArray(view.rotation, 0, view.rotation.length), fov: view.fov,
      viewport: [viewportWidth, viewportHeight], render: [width, height] };
    return { nodes, zone: words[42], mirrors, frames: childFrames ? frames : null, size: [width, height], lod, master, detail,
      sky: result.children.some(child => child.kind === 'sky'), decals: fragments, movers, moverItems,
      sprites: spriteKeys(result.sprites), spriteScreens: result.spriteScreens,
      // Host timings (ms): the movers' Update, OccludeBsp with its decode
      // (and the movers' draw lists), then the decal block.
      ms: { movers: moversMs, occlusion: occluded - started, decals: performance.now() - occluded } };
  }
  // DrawFrame's order over OccludeFrame's child frames (0x10b1a336-0x10b1a348
  // recurses into each child, in list order, before the frame's own sprites;
  // the list is newest first and OccludeFrame numbers the frames in that
  // visiting order): children before their parent, siblings in index order.
  function drawFrameOrder(frames) {
    const byParent = new Map(), order = [];
    for (const frame of frames) { if (!byParent.has(frame.parent)) byParent.set(frame.parent, []); byParent.get(frame.parent).push(frame); }
    const visit = parent => { for (const frame of (byParent.get(parent) ?? []).sort((a, b) => a.index - b.index)) { visit(frame.index); order.push(frame); } };
    visit(0);
    return order;
  }
  // Each child frame's lighting frame (mesh-lighting-view.mjs childFrame) with
  // its Frame->Sprite's binding ids, in DrawFrame's order, for the actor
  // layer's per-frame SetupForActor and Light.
  // Each child frame's DrawLodMesh inputs (its Coords and FX) with its
  // Frame->Sprite's binding ids, in DrawFrame's order (docs/script-lodmesh-lod.md
  // "Child frames"): the actor layer selects the LOD and calls GetFrame for an
  // actor in each frame that draws it.
  function lodFramesOf(frames, fov) {
    if (!frames) return null;
    return drawFrameOrder(frames).map(frame => ({ index: frame.index, ids: frame.main ?? new Set(), lod: { ...frame.lod, fov } }));
  }
  // A frame's lighting camera for the page's lightRun: Coords and Mirror.
  const lightCameraOf = frame => ({ origin: frame.coords.slice(0, 3),
    axes: [frame.coords.slice(3, 6), frame.coords.slice(6, 9), frame.coords.slice(9, 12)], mirror: frame.mirror });
  function lightFramesOf(frames) {
    if (!frames || !meshLighting?.frame) return null;
    return drawFrameOrder(frames).map(frame => ({ index: frame.index, kind: frame.kind, ids: frame.main ?? new Set(), prj: frame.prj ?? null,
      ctx: meshLighting.childFrame({ coords: frame.coords, mirror: frame.mirror, planes: frame.planes }) })).filter(entry => entry.ctx);
  }
  // SetupDynamics for a child frame (docs/bsp-occlusion.md "Child frames"),
  // called by the Rust recursion before the frame's Setup: the iterating
  // actors' protocol runs again (sprite-scan.mjs `rescan`: Init, CurrentItem,
  // the shared random stream) and the frame's candidates are the root's
  // with the iterators' new items. A sprite item equal to the root frame's
  // (same order, texture, place and scale: a particle's) is the root's
  // record, drawn by the frames whose Frame->Sprite holds it; a different
  // one (a random beam's) is a record of its own, drawn in those frames
  // alone. A mesh item takes its slot's binding when it equals the root's
  // item there, else a binding of its own (actor-mesh-sim.mjs itemCandidates).
  // A frame's iterator item claims (validation, iteratorState and viewportState): each candidate's
  // binding with its item, the actor and the item's slot among that actor's items in the frame.
  const claimsOf = (candidates, frameItems) => {
    const counts = new Map(), slotOf = new Map();
    for (const item of frameItems) { const slot = counts.get(item.actor) ?? 0; counts.set(item.actor, slot + 1); slotOf.set(item, slot); }
    return candidates.map(({ binding, item }) => ({ id: binding.id, actor: item.actor.name, slot: slotOf.get(item), location: [...item.location],
      rotation: [...item.rotation], drawScale: item.drawScale, scaleGlow: item.scaleGlow }));
  };
  // Whether the iterators' rescans follow the first-person viewer rules (a
  // ViewportWindow's frame plans with Draw's bBehindView on: false).
  let rescanFirstPerson = true, planningCamera = false;
  function childDynamics(frame, args, own, known, root) {
    const drawsBefore = iteratorStats.draws, started = performance.now(), scanned = spriteScan.rescan(live.iteratorIndex, { firstPerson: rescanFirstPerson });
    iteratorStats.rescans++; iteratorStats.drawsRescan += iteratorStats.draws - drawsBefore; iteratorStats.msRescan += performance.now() - started;
    const row = { frame: frame.index, kind: frame.kind, items: scanned.meshItems, ...(planningCamera ? { camera: true } : {}) };
    iteratorStats.lastFrames.push(row);
    const { sprites, added } = childFrameSprites(live.sprites, scanned.sprites, known, record => {
      record.size = spriteTextures ? spriteSize(record.texture, record.style === 2) : undefined;
      record.main = false; record.frames = null; record.childOnly = true;
    });
    for (const record of added) live.sprites.push(record);
    const packed = performance.now(), items = args.itemCandidates?.(scanned.meshItems, frame.index) ?? [];
    row.candidates = items;
    const full = () => packDynamics(occlusion, { ...args, sprites, iterators: live.iterators, items, childFrames });
    // Only the iterator-made candidates changed: the root's packed words with
    // those packed again (patchDynamics); ITERATOR_FRAMES=verify packs the
    // frame from scratch too and compares, =full always packs from scratch.
    let entries = iteratorMode === 'full' ? null : patchDynamics(occlusion, root.entries, root.words, { items, sprites, reads: args.reads });
    if (entries) {
      iteratorStats.patched++;
      if (iteratorMode === 'verify') {
        const views = occlusion.setupCandidates(entries.length), patched = views.u32.slice(views.at, views.at + SETUP.WORDS * entries.length);
        const fresh = full(), after = occlusion.setupCandidates(fresh.length);
        const same = fresh.length === entries.length && patched.every((v, k) => v === after.u32[after.at + k])
          && fresh.every((e, i) => e.order === entries[i].order && e.binding === entries[i].binding && e.item === entries[i].item);
        if (!same) throw new Error('ITERATOR_FRAMES=verify: the patched candidates differ from the frame packed from scratch');
      }
    } else { entries = full(); iteratorStats.packed++; }
    occlusion.useFrameCandidates(entries.length);
    iteratorStats.msPack += performance.now() - packed;
    own.set(frame.index, entries);
  }
  // The main frame's dynamics and OccludeBsp (docs/bsp-occlusion.md "Play"):
  // this frame's sprite records and, from the actor mesh layer, its bindings
  // (`args`), as Setup candidates in SetupDynamics' order. Frame->Sprite
  // marks each sprite record's `main` and gives the drawn bindings' ids
  // (`visibility.main`); the frame's visibility and sky follow.
  // A frame's Setup results for the sprite records its Frame->Sprite holds
  // (bsp-occlusion.mjs `spriteScreens`): record.screens[frame] = [Z, ScreenX,
  // ScreenY, Persp] as float32 (the sprite draw's inputs, docs/frame-projection.md "Sprites").
  const screenBits = new Uint32Array(4), screenFloats = new Float32Array(screenBits.buffer);
  // A decode's sprites as their keys: Play's decode (bsp-occlusion.mjs compactSprites) already gives a Uint32Array of them.
  const spriteKeys = list => list instanceof Uint32Array ? list : list.map(sprite => sprite.key);
  function noteSpriteScreens(entries, frameIndex, screens) {
    if (screens instanceof Uint32Array) {
      // Five words a sprite: key, Z, ScreenX, ScreenY, Persp (all as float32 bits).
      for (let at = 0; at < screens.length; at += 5) {
        const record = entries[screens[at]]?.sprite;
        if (!record) continue;
        screenBits[0] = screens[at + 1]; screenBits[1] = screens[at + 2]; screenBits[2] = screens[at + 3]; screenBits[3] = screens[at + 4];
        (record.screens ??= {})[frameIndex] = [screenFloats[0], screenFloats[1], screenFloats[2], screenFloats[3]];
      }
      return;
    }
    for (const { key, zBits, screenBits: bits } of screens ?? []) {
      const record = entries[key]?.sprite;
      if (!record) continue;
      screenBits.set([zBits, bits[0], bits[1], bits[2]]);
      (record.screens ??= {})[frameIndex] = [...screenFloats];
    }
  }
  // The main frame's candidate entries: made in this pool and reused (packDynamics); nothing keeps them past the frame.
  const mainDynamics = { objects: [], list: [], sorted: [], used: 0 };
  function occludeMain(args = {}) {
    const pending = pendingOcclusion;
    pendingOcclusion = null;
    if (!pending) return null;
    const entries = packDynamics(occlusion, { sprites: live.sprites, iterators: live.iterators, ...args, pool: mainDynamics });
    if (iteratorStats.lastFrames[0]) iteratorStats.lastFrames[0].candidates = args.items ?? [];
    // Each child frame's own SetupDynamics (OccludeFrame, 0x10b1a188): with
    // iterators in the level, their items are built again for every frame
    // (`childDynamics`); `own` holds each frame's candidates by visit index.
    const iterating = childFrames && iteratorFrames && live.iterators?.size && live.iteratorIndex;
    const own = new Map(), known = iterating ? iteratorSpritesByOrder(live.sprites) : null;
    const root = iterating ? { entries, words: candidateWords(occlusion, entries.length) } : null;
    const frameDynamics = iterating ? frame => childDynamics(frame, args, own, known, root) : null;
    const probing = game.liveReplay?.setupProbe;
    if (probing && game.liveReplay.index >= probing.first && game.liveReplay.index <= probing.last)
      occlusion.childSetupDebug.watch(entries.flatMap((entry, i) => entry.binding?.actor && probing.names.has(entry.binding.actor.name) ? [i] : []));
    else occlusion.childSetupDebug.watch([]);
    const occludeStarted = performance.now();
    const rect = pending.frame.renderRect;
    const result = visibility(pending.view, pending.width, pending.height, entries.length, { frameDynamics, origin: [rect?.x ?? 0, rect?.y ?? 0] }), main = new Set();
    iteratorStats.msVisibility += performance.now() - occludeStarted;
    iteratorStats.visited += result.frames?.length ?? 0;
    for (const sprite of live.sprites) { sprite.main = false; sprite.frames = null; sprite.screens = null; }
    for (const key of result.sprites) {
      const entry = entries[key];
      if (entry.sprite) entry.sprite.main = true; else main.add(entry.binding.id);
    }
    // Each frame's Setup centre and scale for the sprite records it draws (frame 0 the root's).
    noteSpriteScreens(entries, 0, result.spriteScreens);
    result.main = main;
    delete result.sprites; delete result.spriteScreens;
    // Each child frame's Frame->Sprite: its bindings (`main`) and, on the
    // sprite records, the frames that draw them; `children` every binding
    // some child frame draws.
    const children = new Set();
    for (const frame of result.frames ?? []) {
      frame.main = new Set();
      const frameEntries = own.get(frame.index) ?? entries;
      for (const key of frame.sprites) {
        const entry = frameEntries[key];
        if (entry.sprite) (entry.sprite.frames ??= []).push(frame.index);
        else { frame.main.add(entry.binding.id); children.add(entry.binding.id); }
      }
      noteSpriteScreens(frameEntries, frame.index, frame.spriteScreens);
      delete frame.sprites; delete frame.spriteScreens;
    }
    result.children = children;
    // Which claimed iterator items each child frame's Frame->Sprite holds (validation: iteratorState).
    for (const frame of result.frames ?? []) {
      const row = iteratorStats.lastFrames.find(entry => entry.frame === frame.index);
      if (row) row.drawnIds = frame.main;
    }
    // Validation (live-probe.mjs setupProbe): FDynamicSprite::Setup's root-frame result for the named actors in this frame, and
    // which frames' Frame->Sprite hold them.
    const setupProbe = game.liveReplay?.setupProbe;
    if (setupProbe && game.liveReplay.index >= setupProbe.first && game.liveReplay.index <= setupProbe.last) {
      const out = occlusion.setupResults(entries.length), f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
      const level = runtime.levelFor(game.player.collisionActor);
      entries.forEach((entry, i) => {
        const actor = entry.binding?.actor;
        if (!actor || !setupProbe.names.has(actor.name)) return;
        const at = SETUP_OUT_WORDS * i, bits = word => { u32[0] = word; return f32[0]; };
        setupProbe.rows.push({ tick: game.liveReplay.index, time: runtime.readNamed(level.actors[0], 'TimeSeconds'), name: actor.name,
          status: out[at], rect: [out[at + 1], out[at + 2], out[at + 3], out[at + 4]].map(v => v | 0), z: bits(out[at + 5]),
          children: occlusion.childSetupDebug.rows().filter(r => r.candidate === i).map(r => ({ frame: r.frame, status: r.words[0], rect: r.words.slice(1, 5).map(v => v | 0), z: bits(r.words[5]) })),
          main: main.has(entry.binding.id), frames: (result.frames ?? []).map(frame => ({ index: frame.index, kind: frame.kind, iSurf: frame.iSurf, in: frame.main.has(entry.binding.id) })),
          size: [pending.width, pending.height], location: [...runtime.readNamed(actor, 'Location')], rotation: [...runtime.readNamed(actor, 'Rotation')],
          anim: [runtime.readNamed(actor, 'AnimSequence'), runtime.readNamed(actor, 'AnimFrame')] });
      });
    }
    pending.frame.visibility = result;
    attachMoverPoints(result);
    // DrawWorld draws the sky frame only when OccludeBsp made one.
    if (!result.sky) pending.frame.sky = null;
    return result;
  }
  // A ViewportWindow's DrawWorld (Render.dll 0x10b1cb90 on the master frame
  // XViewportWindow::Draw made, docs/script-window-viewport.md "Camera
  // pass"), planned inside the window host's DrawWorld while Draw holds the
  // origin's bHidden and the player's bBehindView, after the main frame's
  // DrawWorld, as a root frame of its own: OccludeFrame's SetupDynamics (the
  // iterators' items rebuilt), OccludeBsp from the frame's camera at the
  // window's size with its mirror and sky child frames (each with its own
  // SetupDynamics) and the decal block, the corona pass, render feedback for
  // the actors and sprites every frame draws, and the actors updated now as
  // the main frame's update does (actorScene.updateFrame): posed, with
  // DrawLodMesh's LOD and SetupForActor's lighting from each frame's own
  // Coords, in this same frame.
  let lastViewportPlans = [], coronaClock = null, mirrorsOn = true;
  // The HUD frame's packed mesh records (mesh-frame-pack.mjs): the camera
  // frames' late actor updates add to the frame's own (frame()).
  let framePack = null;
  // Pack buffers the page sent back (recyclePack): each frame's pack is
  // transferred to the page, which sends it back with a later post.
  const packSpares = [];
  // A frame's Frame->Sprite as sets: the binding ids and the sprite records
  // (OccludeBsp's keys over the frame's own candidate entries).
  function frameMembers(seen, entries, own) {
    const of = (keys, list) => {
      const ids = new Set(), records = new Set();
      for (const key of keys) { const entry = list[key]; if (entry.sprite) records.add(entry.sprite); else ids.add(entry.binding.id); }
      return { ids, records };
    };
    const root = of(seen.sprites, entries), frames = new Map(), children = new Set();
    for (const frame of seen.frames ?? []) {
      const here = of(frame.sprites, own.get(frame.index) ?? entries);
      frames.set(frame.index, here);
      for (const id of here.ids) children.add(id);
    }
    return { root, frames, children };
  }
  /** What a Canvas.DrawActor submission in the master frame needs (the view model's, and GC.DrawActor's from the HUD paint):
   * the main camera's frustum (weaponFrustum), the master frame's DrawLodMesh inputs and Canvas.DrawActor's render feedback,
   * FDynamicSprite::Setup in the canvas frame (Canvas->Update's, the master frame), one candidate packed as SetupDynamics
   * packs an actor (weapon-overlay-sim.mjs `admit`), after this frame's OccludeBsp has run. */
  function canvasDrawInputs() {
    camera.updateMatrixWorld();
    weaponFrustum.setFromProjectionMatrix(weaponMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem, camera.reversedDepth);
    const lodInputs = current?.visibility?.lod && current.view?.fov !== undefined ? { ...current.visibility.lod, fov: current.view.fov } : null;
    const master = current?.visibility?.master;
    const admit = master && occlusion?.setupSupported ? binding => {
      const record = occlusion.meshRecord(binding.mesh.key, meshRecordFields(binding.payload));
      const views = occlusion.setupCandidates(1);
      binding.packSetup(views, views.at, 0, record, null, null);
      views.u32[views.at + SETUP.FLAGS] = 0;
      return occlusion.setupOnly(master.words, 1)[0] === SETUP_STATUS.ACCEPTED;
    } : null;
    return { lodInputs, admit };
  }
  /** GC.DrawActor from the HUD paint (docs/gc-draw-actor.md; the window host calls this inside its render service, with the
   * actor in the state XGC::DrawActor set): the actor's binding updated in the master frame, and URender::DrawActor's render
   * feedback (DrawActorSprite stamps LastRenderTime with the level clock, whatever the actor's bHidden) for an actor
   * FDynamicSprite::Setup admits. The draw is null while the binding is being prepared or when Setup rejects the actor. */
  function planHudActor(actor) {
    if (!weaponSim || !current) return null;
    const { lodInputs, admit } = canvasDrawInputs();
    const result = weaponSim.drawHudActor(actor, { frustum: weaponFrustum, lodInputs, settings: actorScene?.lodSettings?.(), admit });
    if (!result?.drawn) return null;
    if (!runtime.readNamed(actor, 'bDeleteMe'))
      runtime.writeNamed(actor, 'LastRenderTime', Math.fround(runtime.readNamed(runtime.levelFor(game.player.collisionActor).actors[0], 'TimeSeconds')));
    return { id: result.id, record: result.record, decision: result.decision };
  }
  function planViewportPass(command) {
    if (!(command.width > 0 && command.height > 0)) return null;
    viewportFrames++;
    const planStarted = performance.now();
    const view = { location: command.location, rotation: command.rotation, fov: command.fov };
    applyPlayFrame(viewportCamera, view, { render: true, width: command.width, height: command.height });
    setPixelCentre(viewportCamera, command.width, command.height);
    viewportCamera.updateMatrixWorld();
    const pass = { visibility: null, sky: null, decisions: null, late: null, frames: null, stamps: null, sprites: null, decals: null,
      coronas: null, projection: null };
    // The camera frame's own SetupDynamics candidates (the actor layer's
    // bindings read live under Draw's flags, the sprite records and the
    // iterators' items made again), then OccludeBsp from its camera with
    // Frame->Sprite's keys for it and each child frame: exactly those actors
    // and sprites are drawn and stamped, as for the main frame.
    let seen = null, members = null, cameraItems = [], cameraScanned = [];
    if (occlusion && occlusion.setupSupported && actorScene) {
      actorScene.beginFrameItems(live.meshItems);
      const args = { ...actorScene.setupArgs(live.meshItems), childFrames };
      const rescanning = iteratorFrames && live.iterators?.size && live.iteratorIndex;
      const known = rescanning ? iteratorSpritesByOrder(live.sprites) : null;
      let sprites = live.sprites, frameArgs = args;
      rescanFirstPerson = !command.behindView; planningCamera = true;
      try {
        if (rescanning) {
          // SetupDynamics for this root frame (0x10b22d90 from OccludeFrame): every
          // iterator's protocol again, from the shared random stream.
          const drawsBefore = iteratorStats.draws, started = performance.now(), scanned = spriteScan.rescan(live.iteratorIndex, { firstPerson: rescanFirstPerson });
          iteratorStats.rescans++; iteratorStats.drawsRescan += iteratorStats.draws - drawsBefore; iteratorStats.msRescan += performance.now() - started;
          const made = childFrameSprites(live.sprites, scanned.sprites, known, record => {
            record.size = spriteTextures ? spriteSize(record.texture, record.style === 2) : undefined;
            record.main = false; record.frames = null; record.childOnly = true;
          });
          for (const record of made.added) live.sprites.push(record);
          sprites = made.sprites; cameraScanned = scanned.meshItems; frameArgs = { ...args, items: args.itemCandidates(scanned.meshItems, 'camera') };
        }
        if (rescanning) cameraItems = frameArgs.items;
        const entries = packDynamics(occlusion, { sprites, iterators: live.iterators, ...frameArgs });
        const own = new Map(), root = rescanning ? { entries, words: candidateWords(occlusion, entries.length) } : null;
        const frameDynamics = childFrames && rescanning ? frame => childDynamics(frame, frameArgs, own, known, root) : null;
        seen = visibility(view, command.width, command.height, entries.length, { decals: true, movers: false, frameDynamics, detail: false });
        members = frameMembers(seen, entries, own);
      } finally { rescanFirstPerson = true; planningCamera = false; }
    } else if (occlusion) seen = visibility(view, command.width, command.height, -1, { decals: true, movers: false, detail: false });
    const ids = members?.root.ids ?? new Set(), childIds = members?.children ?? new Set(), updateIds = new Set([...ids, ...childIds]);
    if (seen) {
      pass.visibility = { nodes: seen.nodes, movers: seen.movers, moverItems: seen.moverItems };
      pass.decals = seen.decals?.length ? seen.decals : null;
      pass.projection = projectionOf(seen.master.words, seen.master.prj);
      if (pass.projection) setFrameProjection(viewportCamera, pass.projection);
      if (seen.sky) pass.sky = sky(view.location);
      for (const frame of seen.frames ?? []) frame.main = members?.frames.get(frame.index)?.ids ?? new Set();
      if (seen.frames?.length) pass.frames = seen.frames.map(frame => ({ index: frame.index, parent: frame.parent, kind: frame.kind,
        iNode: frame.iNode, group: frame.group, requests: frame.requests, bounds: frame.bounds, nodes: frame.nodes, movers: frame.movers, moverItems: frame.moverItems,
        coords: frame.coords, mirror: frame.mirror }));
    } else pass.sky = sky(view.location);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(viewportCamera.projectionMatrix, viewportCamera.matrixWorldInverse));
    const info = runtime.levelFor(game.player.collisionActor).actors[0];
    const time = Math.fround(runtime.readNamed(info, 'TimeSeconds'));
    if (actorScene) {
      // The Frame->Sprite actors are updated as a second DrawWorld would
      // draw them: DrawLodMesh's LOD choice and GetFrame call, SetupForActor
      // and Light with each frame's Coords (the viewport actor's FovAngle is
      // the window's while Draw holds it). The others are hidden in this pass.
      const lit = Boolean(meshLighting?.frame);
      pass.late = actorScene.updateFrame({ lit, frustum, camera: viewportCamera, cull: false, main: ids, children: childIds,
        ...(seen ? { lod: { ...seen.lod, fov: command.fov },
          lodFrames: childFrames ? lodFramesOf(seen.frames, command.fov) : null, lightFrames: childFrames ? lightFramesOf(seen.frames) : null,
          // the camera frame's own PrjXM..PrjYP (its outcodes of a pawn's special vertices, docs/weapon-attachment.md)
          prj: seen.master.prj,
          lightRoot: lit ? meshLighting.childFrame({ coords: seen.lod.coords, mirror: 1, planes: seen.master.planes }) : null } : {}),
        ...(framePack ? { pack: framePack } : {}) }, updateIds);
      // (a pawn's weapon is in the frame when its pawn is and had a hand there: it is in no Frame->Sprite of its own)
      pass.decisions = new Map(actorScene.all().filter(binding => !(binding.attachedTo ? actorScene.weaponInRoot(binding, ids) : ids.has(binding.id)))
        .map(binding => [binding.id, { root: false }]));
      // The child frames' passes, as the main frame's stamps() decides them:
      // each frame draws the actors its Frame->Sprite holds, lit and LOD-chosen
      // for it, in DrawFrame's order, and the camera's own frame again after.
      if (drawn && seen?.frames?.length && size) {
        const { passes } = drawn.passes({ camera: viewportCamera, sky: pass.sky, drawWorld: false, size: { x: size[0], y: size[1] },
          mirrors: mirrorsOn, frames: seen.frames, rect: { x: command.x, y: command.y, width: command.width, height: command.height } });
        const passDecisions = [], passIds = [], passFrames = [], passSky = [], stamps = { passDecisions, passIds, passFrames, passSky, mainDecisions: null,
          skyDecisions: null, skyFrame: null, plan: { size: [size[0], size[1]], mirrors: mirrorsOn, actors: true } };
        let insideSky = [];
        for (const one of passes) {
          const frame = one.frame;
          if (!frame) continue;
          const frameIds = frame.main ?? new Set();
          // A sky frame inside a mirror frame that draws no actor needs no decisions.
          if (one.within && !frameIds.size) continue;
          const decisions = actorScene.framePasses(drawn.frustum(one.camera), frameIds, frame.index);
          if (one.within) insideSky.push({ frame: frame.index, decisions, light: lightCameraOf(frame) });
          else if (one.kind === 'mirror') {
            passDecisions.push(decisions); passIds.push(one.node.id); passFrames.push(lightCameraOf(frame)); passSky.push(insideSky); insideSky = [];
          }
          else { stamps.skyDecisions = decisions; stamps.skyFrame = lightCameraOf(frame); }
        }
        // The camera frame's own decisions again after its child passes.
        if (passDecisions.length || stamps.skyDecisions) stamps.mainDecisions = actorScene.framePasses(null, ids);
        pass.stamps = stamps;
      }
      // DrawActorSprite stamps every Frame->Sprite actor of every frame, drawn
      // or occluded by the three.js cull (the main frame's `occluded` set).
      for (const binding of actorScene.all()) if (updateIds.has(binding.id)) runtime.writeNamed(binding.actor, 'LastRenderTime', time);
    }
    // The sprite records each frame draws, as indices into the frame's sprite
    // list (the page's sprite scene numbers its records the same way).
    const records = new Set(members?.root.records);
    for (const here of members?.frames.values() ?? []) for (const record of here.records) records.add(record);
    if (members) {
      const index = new Map(live.sprites.map((record, at) => [record, at])), at = set => [...set].map(record => index.get(record)).filter(i => i !== undefined);
      pass.sprites = { root: at(members.root.records), frames: Object.fromEntries([...members.frames].map(([frame, here]) => [frame, at(here.records)])) };
    }
    for (const record of records) runtime.writeNamed(identityOfHandle(record.handle), 'LastRenderTime', time);
    // DrawFrame's corona pass closes the frame (corona-scan.mjs): the player's
    // leaf's lights, seen from this frame's origin, in this frame's pixels, on
    // the same cache and clock the main frame's pass uses.
    if (seen && coronaScan && coronaClock) {
      const frame = coronaScan.update(view, { width: command.width, height: command.height }, seen.master, live.lights,
        coronaClock.now + (performance.now() - coronaClock.at) / 1000);
      pass.coronas = { frame, width: command.width, height: command.height };
    }
    const names = ids => actorScene ? actorScene.all().filter(b => ids.has(b.id)).map(b => b.actor.name) : [];
    lastViewportPlans.push({ rect: [command.x, command.y, command.width, command.height],
      location: [...command.location], rotation: [...command.rotation], fov: command.fov, ms: +(performance.now() - planStarted).toFixed(2), nodes: pass.visibility?.nodes.length ?? null,
      sky: Boolean(pass.sky), actors: names(ids), sprites: records.size, stamped: names(updateIds), time, late: pass.late?.records.length ?? 0,
      frames: (seen?.frames ?? []).map(frame => ({ index: frame.index, parent: frame.parent, kind: frame.kind, nodes: frame.nodes.length,
        actors: names(frame.main ?? new Set()),
        // The frame's own iterator items with their bindings and whether its Frame->Sprite holds them (validation, viewportState).
        rawItems: iteratorStats.lastFrames.findLast(row => row.camera && row.frame === frame.index) ?? null, drawnIds: frame.main ?? new Set() })),
      itemExtras: actorScene ? actorScene.itemScopeUsed() : 0,
      // The camera frame's own iterator items with the bindings they draw through (validation, viewportState).
      rawItems: { candidates: cameraItems, frameItems: cameraScanned, drawnIds: updateIds },
      decals: pass.decals ? pass.decals.reduce((n, group) => n + group.positions.length / 9, 0) : 0,
      coronas: pass.coronas ? { icons: pass.coronas.frame.icons.length, ...pass.coronas.frame.stats,
        // The frame DrawFrame's pass read and the icons it placed (validation).
        frameWords: pass.coronas.frame.frameWords, placed: pass.coronas.frame.icons.map(({ x, y, size, light }) => ({ x, y, size, light })) } : null });
    return pass;
  }
  // Accessibility mirrors native TextWindow contents: the window, its title
  // and queue (raw heap strings) and the displayBuffer's characters that
  // have actually appeared.
  function infoLinkText() {
    const host = game.doors.scriptRuntime.windowHost;
    if (!host?.hud) return null;
    const read = (object, name) => runtime.readNamed(object, name), info = read(host.hud, 'infoLink');
    if (!info) return { visible: false };
    return { visible: true, title: host.raw.read(read(info, 'winName'), 0x168, 'string'),
      queued: host.raw.read(read(info, 'winQueued'), 0x168, 'string'), text: host.computerText(read(info, 'winText')) };
  }
  return {
    live,
    /** Whether a step stopped the simulation (diagnostics). */
    get failed() { return failed; },
    /** The zone names whose live pan speeds the world's auto-panned surfaces
     * read (world.pannedZoneNames). */
    setPanZones(names) { panZones = [...names]; },
    /** The textures the HUD's construction already reached, for the page to
     * decode before the first frame (createPlayHud did the same). */
    hudTextures() {
      const textures = [...game.hud.host.resourceImages.values()].filter(resource => resource.kind === 'texture')
        .map(resource => plainTexture(resource.ref));
      // (the console's LargeFont pages: the loading frame is drawn once and kept, so its glyphs cannot wait for a later frame's decode)
      for (const texture of levelAction?.textures() ?? []) if (!textures.some(other => other.key === texture.key)) textures.push(texture);
      return textures;
    },
    /** The HUD frame after the world's: the window tree's paint
     * (DrawWindow/PostDrawWindow and the GC natives) as plain GC commands,
     * Galaxy's update after it (game.mjs: UGameEngine::Draw updates audio
     * after the frame), then the InfoLink text the page mirrors for
     * accessibility. An error stops the simulation like the frame's other
     * steps. `progress` (a LEVEL_ACTION): the frame is LoadMap's
     * PaintProgress draw of the level a travel leaves (docs/loading-frame.md):
     * the paint and its flash read PaintProgress's state, and `console` holds
     * the console's DrawLevelAction tiles, drawn after EndFlash. */
    hud({ width, height, view, stream = false, progress = LEVEL_ACTION.none }) {
      // (a live replay's frame after a window scene's typed command that the original's held frames did not draw after: live-probe.mjs `noPaint`)
      if (game.liveReplay?.noPaint) return { errors: [], commands: [], stream: null, infoLink: null, flash: null, console: null };
      const errors = [];
      let commands = [], hudStream = null, infoLink = null, flash = null, consoleTiles = null;
      const paint = () => {
        game.hud.host?.setViewportPlanner?.(planViewportPass);
        game.hud.host?.setActorDrawPlanner?.(planHudActor);
        viewportFrames = 0; lastViewportPlans = [];
        // (the window host builds the tile commands in this form already: draw's fourth argument). `stream`: the tiles as numbers
        // (script-window-command-stream.mjs), which the page expands where it draws them; the commands of the other kinds are
        // converted here, in place among them.
        if (stream) {
          hudStream = game.hud.commands(width, height, view, 'stream');
          hudStream.others = plainHudCommands(hudStream.others, true);
          commands = null;
        } else commands = plainHudCommands(game.hud.commands(width, height, view, true), true);
        infoLink = infoLinkText();
        // UGameEngine::Draw's flash planes for UD3DRenderDevice::EndFlash (docs/screen-flash.md), read where the
        // original reads them: the viewport actor's FlashScale and FlashFog after the tick, at the HUD draw.
        const viewer = game.player.collisionActor;
        flash = viewportFlash({ flashScale: runtime.readNamed(viewer, 'FlashScale'), flashFog: runtime.readNamed(viewer, 'FlashFog') });
      };
      try {
        if (progress !== LEVEL_ACTION.none && levelAction) {
          const viewer = game.player.collisionActor;
          consoleTiles = levelAction.paint({ player: viewer, levelInfo: runtime.readNamed(viewer, 'Level'), width, height, action: progress, hudPaint: paint }).console;
        } else paint();
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, commands, stream: hudStream, infoLink, flash, console: consoleTiles };
    },
    /** SetupDynamics' sprite scan with the render iterators (sprite-scan.mjs):
     * the sprite records in draw order. The laser DT_Mesh items stay in
     * `live.meshItems` for the actor mesh scene. */
    sprites() {
      const errors = [];
      let sprites = [];
      live.meshItems = [];
      try {
        const drawsBefore = iteratorStats.draws, started = performance.now(), scanned = spriteScan.scan(); sprites = scanned.sprites; live.meshItems = scanned.meshItems;
        iteratorStats.scans++; iteratorStats.drawsScan += iteratorStats.draws - drawsBefore; iteratorStats.msScan += performance.now() - started;
        iteratorStats.lastFrames = [{ frame: 0, kind: 'root', items: scanned.meshItems }];
        live.iterators = scanned.iterators; live.iteratorIndex = scanned.iteratorIndex;
      } catch (error) { failed = true; errors.push(plainError(error)); }
      if (spriteTextures) for (const sprite of sprites) sprite.size = spriteSize(sprite.texture, sprite.style === 2);
      live.sprites = sprites;
      return { errors, sprites, notes: [...spriteScan.notes] };
    },
    /** Render.dll 0x10b25150: a drawn actor's LastRenderTime is its level's
     * TimeSeconds (actor-render-feedback.mjs). */
    stamp(handle) {
      const actor = identityOfHandle(handle), info = runtime.levelFor(game.player.collisionActor).actors[0];
      runtime.writeNamed(actor, 'LastRenderTime', Math.fround(runtime.readNamed(info, 'TimeSeconds')));
    },
    /** PlayerCalcView outside a frame (mode changes, Player start). */
    view() { const view = plainView(game.view()); lastViewLocation = view.location; pointCamera(camera, view); return view; },
    camera,
    /** The page's static brush and mirror meshes (world.stampScene) and the
     * actor mesh layer: the drawn set's inputs. Movers stamp through their
     * Level.Actors entries by name. */
    setScene(scene, actors = null) {
      drawn = scene ? createDrawnSet(scene) : null;
      actorScene = actors;
      const level = runtime.levelFor(game.player.collisionActor);
      moverActors = new Map(level.actors.filter(Boolean).map(actor => [actor.name, actor]));
    },
    setMeshLighting(lighting) { meshLighting = lighting; },
    /** Validation (scripts/validate-terminals-camera-browser.mjs): the last
     * HUD frame's ViewportWindow world frames (planViewportPass): each one's
     * rectangle, OccludeBsp's drawn node count, whether it drew a sky frame,
     * the actors it draws and its sprite count. */
    viewportState() {
      const claims = (raw, ids) => raw?.candidates ? claimsOf(raw.candidates, raw.frameItems ?? raw.items).map(claim => ({ ...claim, drawn: ids.has(claim.id) })) : [];
      return lastViewportPlans.map(({ rawItems, ...plan }) => ({ ...plan, rect: [...plan.rect], actors: plan.actors && [...plan.actors],
        items: claims(rawItems, rawItems.drawnIds),
        frames: plan.frames.map(({ rawItems: rows, drawnIds, ...frame }) => ({ ...frame, items: claims(rows, drawnIds) })) }));
    },
    setOcclusion(value, movers = null) { occlusion = value; trackerMovers = movers; sentRevisions = null; },
    setOcclusionRebuild(rebuild, drop = null) { rebuildOcclusion = rebuild; dropOcclusion = drop; },
    /** Validation (strobeProbe in main.mjs, scripts/validate-strobe-child-frames-play.mjs): the Strobe lists of the
     * light-map Strobe calls. `mainOnly` scans the main frame's surfaces alone (the first version's behavior,
     * a failing baseline for the validator); `always` records the scan of frames in which a mesh or Galaxy flipped the flag first. `set` {name, LightType} writes a map light's LightType and takes the lists again (the
     * shipped scripts never set Strobe; the experiment makes a static light a Strobe light, as `set` would in the
     * original). `reach` returns, for the frame lightMapStrobe saw last, each frame's (the main frame, then the
     * child frames) drawn level surfaces whose static light list holds each light: {name: surfaces}. */
    strobeReach({ set = null, reach = false, mainOnly = null, always = null, bench = 0 } = {}) {
      if (mainOnly !== null) strobeMainOnly = Boolean(mainOnly);
      if (always !== null) strobeAlways = Boolean(always);
      const level = runtime.levelFor(game.player.collisionActor), model = level.model;
      if (set) {
        const actor = level.actors.find(candidate => candidate?.name === set.name);
        if (!actor) throw new Error(`strobeReach: no actor ${set.name}`);
        runtime.writeNamed(actor, 'LightType', set.LightType);
        strobeSurfaces = null;
      }
      const out = { scan: lights.strobeScan ?? null };
      // `bench`: the cost of the last frame's scan, `bench` repeated calls (performance.now is quantized to 0.1 ms), µs per call;
      // the Strobe state is put back, so the repeats flip nothing.
      if (bench && strobeVisible && lights.strobeScan) {
        const saved = { ...lights.strobe }, previous = strobeAlways, scanned = lights.strobeScan;
        strobeAlways = true;
        const started = performance.now();
        for (let i = 0; i < bench; i++) { lights.strobe.time = scanned.time; lightMapStrobe(strobeVisible, live.lights, scanned.time); }
        out.benchMicroseconds = (performance.now() - started) * 1000 / bench;
        Object.assign(lights.strobe, saved); strobeAlways = previous; lights.strobeScan = scanned;
      }
      if (!reach) return out;
      if (!strobeVisible) return { ...out, frames: null };
      const nameOf = new Map();
      const lightNames = lightMapIndex => {
        const names = [], lightActors = lightMapIndex >= 0 && lightMapIndex < model.lightMaps.length ? model.lightMaps.lightActors(lightMapIndex) : -1;
        if (lightActors < 0) return names;
        for (let i = lightActors; i < model.lights.length && model.lights[i]; i++) {
          const ref = model.lights[i];
          if (!nameOf.has(ref)) nameOf.set(ref, exportName ? exportName(ref) : String(ref));
          names.push(nameOf.get(ref));
        }
        return names;
      };
      const frames = [strobeVisible.nodes, ...(strobeVisible.frames ?? []).map(frame => frame.nodes)];
      out.frames = frames.map(nodes => {
        const counts = {}, seen = new Set();
        for (const node of nodes) {
          if (node >= model.nodes.length) continue;
          const surface = model.nodes.surface(node);
          if (seen.has(surface)) continue;
          seen.add(surface);
          for (const name of lightNames(model.surfaces.lightMap(surface))) counts[name] = (counts[name] ?? 0) + 1;
        }
        return counts;
      });
      return out;
    },
    /** Validation (iteratorProbe in main.mjs): the render iterators' per-frame
     * runs since the last reset. */
    iteratorState({ reset = false } = {}) {
      const iterating = live.sprites.filter(sprite => sprite.viaIterator);
      const state = { ...iteratorStats, lastFrames: iteratorStats.lastFrames.map(f => ({ frame: f.frame, kind: f.kind, camera: f.camera, items: f.items.map(item => [...item.location]),
        full: f.items.map(item => ({ location: [...item.location], rotation: [...item.rotation], drawScale: item.drawScale, scaleGlow: item.scaleGlow })),
        // The bindings the frame's items are drawn through, with the item each carries and whether the frame's Frame->Sprite holds it.
        bindings: f.candidates ? claimsOf(f.candidates, f.items).map(claim => ({ ...claim, drawn: f.drawnIds?.has(claim.id) ?? false })) : undefined })),
        iterators: live.iterators?.size ?? 0, itemStates: actorScene?.itemStates?.() ?? null,
        // The sprite records of the iterators' items in the last frame: all,
        // those in the root's Frame->Sprite, in a child frame's, and the ones
        // only a child frame's own run made.
        sprites: { iterating: iterating.length, main: iterating.filter(sprite => sprite.main).length,
          inChildren: iterating.filter(sprite => sprite.frames?.length).length, childOnly: iterating.filter(sprite => sprite.childOnly).length } };
      if (reset) Object.assign(iteratorStats, { scans: 0, rescans: 0, visited: 0, drawsScan: 0, drawsRescan: 0, draws: 0, msRescan: 0, msPack: 0, msScan: 0, msVisibility: 0, patched: 0, packed: 0 });
      return state;
    },
    /** Validation (mover-probe.mjs): each tracked mover's fragment count
     * and the polygons the last main frame drew, and that frame's drawn
     * node count, mover mirror requests, host timings and admitted
     * (updated) movers. */
    moverState({ points = false } = {}) {
      const tracker = occlusion?.tracker, last = current?.visibility ?? null;
      const frame = { nodes: last?.nodes?.length ?? null, moverMirrors: last?.mirrors?.filter(m => typeof m === 'string') ?? null,
        ms: last?.ms ?? null,
        // OccludeFrame's child frames: index, parent, kind, drawn nodes, actors and the group.
        frames: last?.frames?.map(f => ({ index: f.index, parent: f.parent, kind: f.kind, nodes: f.nodes.length,
          actors: f.main?.size ?? null, group: f.group ?? f.iNode, bounds: f.bounds })) ?? null };
      if (!trackerMovers || !tracker) return { tracker: false, ...frame };
      const drawn = last?.movers ?? null;
      return { tracker: tracker.live(), ...frame, admitted: trackerMovers.admitted ?? null, movers: trackerMovers.names.map((name, i) => ({ name,
        fragments: tracker.chain(i).length, drawn: drawn ? [...new Set(drawn[name] ?? [])].length : null,
        polygons: drawn ? [...new Set(drawn[name] ?? [])].sort((a, b) => a - b) : null,
        // `points`: the tracker's transformed vertices now (moverPoints) and their revision.
        ...(points ? { revision: tracker.revision(i), points: tracker.moverPoints(i).points } : {}) })) };
    },
    /** Validation (mover-probe.mjs): the last main frame's decal fragments
     * (decal-draw.mjs groups: texture, view-space triangle positions). */
    decalFragments() { return current?.visibility?.decals ?? null; },
    /** The detail pass over this occlusion (detail-draw.mjs createDetailDraw), or null. */
    setDetail(draw) { detailDraw?.dispose(); detailDraw = draw; },
    /** The kernel's decal facade and its frame-words pointer for the decal block. */
    setDecalKernel(kernel, framePtr) { decalDraw?.dispose(); decalDraw = kernel ? createDecalDraw(runtime, kernel) : null; occlusionFramePtr = framePtr; },
    setCoronas(scan) { coronaScan = scan; },
    /** One frame of the simulation side (docs/sim-worker.md "Frame
     * protocol"), its steps in the order and with the gating animate()
     * gave them, as one plain snapshot for the page. `input`: `play` (Play
     * mode with a game), `dt`, `run` (not paused), `halted` (the page
     * stopped on an error), `size` (the canvas's drawing buffer), `aspect`
     * and `resizes` (resize()'s), `seconds` (the viewport clock), `mirrors`
     * (the mirror toggle), `pixelRatio`, `now` (the corona fade clock,
     * seconds) and, in Inspect, `inspect` {camera: {position, quaternion,
     * fov, aspect, near, far}, view: {location, rotation}, sky}. A step's
     * error stops the gated steps after it; the errors come back in order. */
    frame(input) {
      const errors = [], timings = {}, collect = list => { for (const error of list) errors.push(error); };
      let mark = performance.now();
      const time = name => { const now = performance.now(); timings[name] = (timings[name] ?? 0) + now - mark; mark = now; };
      const stopped = () => input.halted || failed, [width, height] = input.size;
      mirrorsOn = input.mirrors; coronaClock = null;
      let inspect = null;
      if (input.inspect) {
        const c = input.inspect.camera;
        inspectCamera.position.fromArray(c.position); inspectCamera.quaternion.fromArray(c.quaternion);
        // The posted camera's whole projection (its pixel centre's view offset too): the page draws the snapshot with it.
        setProjectionState(inspectCamera, c); inspectCamera.updateMatrixWorld();
        inspect = inspectCamera;
      }
      // The frame's packed GetFrame plans and SetupForActor results
      // (mesh-frame-pack.mjs), a fresh buffer each frame.
      const pack = framePack = createMeshFramePack(PACK_WORDS, packSpares.pop() ?? null);
      const snapshot = { errors, timings, begin: null, drawWorld: true, sprites: null, actors: null, stamps: null,
        coronas: null, weapon: null, hud: null, audioMs: 0, events: null, pack: null, display: null };
      let begun = null;
      if (input.play) {
        begun = this.begin({ dt: input.dt, run: input.run, halted: input.halted, width, height,
          aspect: input.aspect, resizes: input.resizes, preTicked: input.preTicked === true });
        collect(begun.errors);
        const { errors: _, ...frame } = begun;
        snapshot.begin = frame;
      }
      time('tick');
      const view = begun?.view ?? null, rect = begun?.renderRect ?? null;
      const drawWorld = snapshot.drawWorld = !rect || (rect.render && rect.width > 0 && rect.height > 0);
      if (meshLighting && !stopped()) collect(this.lightFrame(input.seconds, input.inspect?.view ?? null));
      time('lighting');
      let sprites = [];
      live.sprites = []; live.iterators = null; live.iteratorIndex = null;
      if (input.play && !stopped()) {
        const scanned = this.sprites();
        collect(scanned.errors);
        snapshot.sprites = { sprites: scanned.sprites, notes: scanned.notes };
        sprites = scanned.sprites;
      }
      time('sprites');
      if (actorScene && !stopped()) {
        const actors = this.actors({ camera: inspect, pack, drawWorld: !input.play || drawWorld });
        collect(actors.errors);
        snapshot.actors = actors.frame;
      }
      // The main frame's OccludeBsp when the actor layer did not run it (no
      // actor meshes, or a step stopped the simulation): the sprites alone.
      if (pendingOcclusion) {
        try { occludeMain(); } catch (error) { failed = true; errors.push(plainError(error)); }
      }
      if (snapshot.begin && begun) { snapshot.begin.visibility = begun.visibility; snapshot.begin.sky = begun.sky; }
      // The light maps' Strobe calls in this frame (SetupForSurf on the main
      // frame's drawn surfaces), beside SetupForActor's and Galaxy's.
      if (begun?.visibility && begun.light && !stopped()) {
        try { lightMapStrobe(begun.visibility, live.lights, begun.light.timeSeconds); } catch (error) { failed = true; errors.push(plainError(error)); }
      }
      time('actors');
      if (drawn) {
        const sky = !drawWorld ? null : input.play ? begun?.sky ?? null : input.inspect?.sky ?? null;
        const requested = input.play && begun?.visibility ? new Set(begun.visibility.mirrors) : null;
        const frames = input.play ? begun?.visibility?.frames ?? null : null;
        // The mirror frames are DrawWorld's child frames: none without the
        // world frame (an empty render viewport draws no 3D).
        const mirrors = input.mirrors && drawWorld, actorPasses = Boolean(actorScene) && !stopped();
        const stamps = this.stamps({ size: { x: width, y: height }, drawWorld, sky, mirrors, sprites, camera: inspect, requested,
          actorPasses, frames, rect: begun?.renderRect ?? null });
        collect(stamps.errors);
        // `plan`: what the passes were planned with, which the page plans its
        // draw with too (the canvas may have changed since the post).
        snapshot.stamps = { passDecisions: stamps.passDecisions, passIds: stamps.passIds, passFrames: stamps.passFrames, passSky: stamps.passSky,
          mainDecisions: stamps.mainDecisions, skyDecisions: stamps.skyDecisions, skyFrame: stamps.skyFrame,
          plan: { size: [width, height], mirrors, actors: actorPasses } };
      }
      time('mirrors');
      if (drawWorld && input.play && coronaScan && view && !stopped()) {
        const coronas = this.coronas({ now: input.now });
        collect(coronas.errors);
        if (coronas.frame) snapshot.coronas = { frame: coronas.frame, width: coronas.width, height: coronas.height };
      }
      time('coronas');
      if (drawWorld && input.play && weaponSim && !stopped()) {
        const weapon = this.weapon({ pack });
        collect(weapon.errors);
        snapshot.weapon = weapon.frame;
      }
      time('weapon');
      if (input.play && game.hud && view) {
        // The frame whose tick travelled is the one LoadMap's PaintProgress draws before the load (docs/loading-frame.md).
        const hud = this.hud({ width, height, view, stream: true, progress: begun?.travel ? LEVEL_ACTION.loading : LEVEL_ACTION.none });
        collect(hud.errors);
        // `stream` (the tiles as numbers) or, after an error, `commands`: the page draws the list `expandHudStream` makes of the stream
        snapshot.hud = { commands: hud.commands ?? (hud.stream ? null : []), stream: hud.stream, infoLink: hud.infoLink, flash: hud.flash, console: hud.console };
      }
      // Galaxy's Update runs inside the HUD draw (UGameEngine::Draw order).
      snapshot.audioMs = input.play ? game.takeAudioMs?.() ?? 0 : 0;
      time('hud');
      timings.hud -= snapshot.audioMs; timings.audio = snapshot.audioMs;
      // The frame's Strobe flag for the page's light maps, after every
      // simulation-side caller (light-globals.mjs).
      if (begun?.light) begun.light.strobe = { time: lights.strobe.time, flag: lights.strobe.flag };
      snapshot.events = events.splice(0);
      snapshot.pack = pack.words(); framePack = null;
      // What the render device took from the client config (docs/script-native-config.md): the
      // Brightness of its last Flush and the last SetRes request.
      const display = game.hud?.host?.display;
      snapshot.display = display ? { brightness: display.brightness, flushes: display.flushes,
        resolution: display.resolution, resolutionVersion: display.resolutionVersion,
        fullscreenToggles: display.fullscreenToggles, relaunches: display.relaunches, relaunchArguments: display.relaunchArguments, exitRequests: display.exitRequests,
        // RootWindow.GenerateSnapshot (docs/root-snapshot.md): the page keeps its drawn frames while UIBackground is 1 (Snapshot), and
        // fills each requested texture from the frame before the one this snapshot draws.
        // Also kept while a window holds the mouse (the Save Game screen's preview is a GenerateSnapshot of the frame behind it, whatever UIBackground says)
        // and while a save waits for its picture (game-save.mjs: the picture is made from the next frame drawn).
        keepFrame: (game.player?.collisionActor ? Number(runtime.readNamed(game.player.collisionActor, 'UIBackground')) === 1 : false)
          || game.pendingSaveSnapshots() > 0 || game.windowMouseGrabbed(),
        snapshotRequests: display.snapshotRequests, snapshotReleased: display.snapshotReleased,
        // Textures the simulation made from bytes it holds (a save's snapshot, docs/save-storage.md): each goes to the page once.
        images: display.images.splice(0) } : null;
      return snapshot;
    },
    /** The queued events outside a frame (map load: the first creation
     * records before the first frame). */
    takeEvents() { return events.splice(0); },
    setWeapon(overlay) { weaponSim = overlay; },
    /** The console's canvas (script-console-level-action.mjs createConsoleLevelAction) for the loading frame, and `deliver(frame)`, which
     * receives SaveCurrentLevel's PaintProgress frame (docs/loading-frame.md "Saving") the moment the save draws it, before the save's work. */
    setLevelAction(value, deliver = null) {
      levelAction = value;
      game.doors.scriptRuntime.levelSaver?.setPaintProgress(value && deliver ? () => { if (size) deliver(savingFrame()); } : null);
    },
    /** URender's per-frame mesh lighting setup for the main viewport
     * (mesh-lighting-view.mjs beginFrame) with this frame's moving lights;
     * `seconds` is the viewport clock (the page's frame time). */
    lightFrame(seconds, inspect = null) {
      if (!meshLighting) return [];
      const errors = [];
      const toUnits = radians => Math.round(radians * 32768 / Math.PI);
      const view = inspect ?? current?.view ?? { location: fromView(camera.position.toArray()),
        rotation: [toUnits(camera.rotation.x), toUnits(-camera.rotation.y), 0] };
      try {
        meshLighting.beginFrame({ location: view.location, rotation: view.rotation, seconds, lights: inspect ? null : live.lights,
          master: inspect ? null : frameMaster() });
      }
      catch (error) { failed = true; errors.push(plainError(error)); }
      return errors;
    },
    /** The actor mesh layer's main-frame update (actor-mesh-sim.mjs) with
     * the frame camera's frustum; with mirrors that may draw, actors only
     * child frames draw are admitted and nothing is culled early. A Play
     * frame that draws no world (`drawWorld` false: the root window's render
     * viewport is empty, and begin ran no OccludeBsp for it) has an empty
     * Frame->Sprite: no binding is drawn, posed (GetFrame) or lit in it, as
     * DrawLodMesh is not reached (docs/script-lodmesh-frame.md "The first
     * GetFrame is the first draw's"). The layer still admits new actors. */
    actors({ camera: inspect = null, pack = null, drawWorld = true } = {}) {
      const errors = [], view = inspect ?? camera;
      let frame = null;
      try {
        view.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
        const requested = !inspect && current?.visibility ? new Set(current.visibility.mirrors) : null;
        const children = drawWorld && drawn ? drawn.mayRender(view, requested) : false;
        // The main frame's dynamics run after the layer's reads; mirror child
        // frames then follow OccludeBsp's requests.
        // The LOD's FovAngle is the viewport actor's (game.view()).
        const fov = !inspect ? current?.view?.fov : undefined;
        const lodOf = result => result?.lod && fov !== undefined ? { ...result.lod, fov } : null;
        const occlude = !inspect && pendingOcclusion ? args => {
          const result = occludeMain({ ...args, childFrames });
          return { main: result.main, children: result.frames ? result.children
            : drawn ? drawn.mayRender(view, new Set(result.mirrors)) : false, lod: lodOf(result),
            lightFrames: lightFramesOf(result.frames), lodFrames: fov !== undefined ? lodFramesOf(result.frames, fov) : null };
        } : null;
        frame = actorScene.update({ lit: Boolean(meshLighting?.frame), frustum, camera: view, cull: !children, children,
          items: inspect ? [] : live.meshItems, occlude, lod: inspect ? null : lodOf(current?.visibility),
          // the main frame's PrjXM..PrjYP, which DrawLodMesh's outcodes of a pawn's special vertices read (docs/weapon-attachment.md)
          prj: inspect ? null : frameMaster()?.prj ?? null, ...(pack ? { pack } : {}), main: drawWorld ? undefined : NO_SPRITES });
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, frame };
    },
    /** Render feedback for the frame (Render.dll 0x10b25150): the drawn set
     * of every pass (drawn-set.mjs), stamped where the page's draws stamped
     * it, before the corona pass, the weapon and the HUD. Returns the actor
     * layer's decision for each mirror pass in draw order with the pass's
     * `id` (mirror-passes.mjs), which the page checks against the pass it
     * draws, and, when mirrors drew, the main frame's again. `size` is the
     * drawing buffer's. */
    stamps({ size, drawWorld, sky = null, mirrors = true, sprites = [], camera: inspect = null, actorPasses = true, requested = null,
      frames = null, rect = null }) {
      const errors = [], passDecisions = [], passIds = [], passFrames = [], passSky = [];
      let mainDecisions = null, skyDecisions = null, skyFrame = null, insideSky = [];
      const lightCamera = lightCameraOf;
      stamped = { movers: new Set(), sprites: new Set(), actors: new Set(), occluded: new Set(), bindings: new Map(),
        weapon: new Set(), source: new Map(), drawn: new Set() };
      try {
        const { passes, mirrored } = drawn.passes({ camera: inspect ?? camera, sky, drawWorld, size, mirrors, requested,
          frames: inspect ? null : frames, rect });
        // `actorPasses`: the page applies the actor layer's mirror pass
        // decisions (no runtime error); otherwise its last state draws.
        const bindings = actorScene?.all() ?? [], lastMirror = passes.findLast(pass => pass.kind === 'mirror');
        const byId = bindingsById(bindings);
        // OccludeBsp's Frame->Sprite for the main frame (occludeMain); the
        // mirror and sky passes keep the frustum.
        const main = inspect ? null : current?.visibility?.main ?? null;
        for (const pass of passes) {
          // A tracked mover is drawn as level polygons, never through
          // DrawActorSprite: nothing stamps it (?moverTracker=off: the
          // frustum-tested set, as before).
          if (!trackerMovers) drawn.moversIn(pass, stamped.movers);
          if (pass.kind === 'main' && main) {
            for (const sprite of sprites) if (sprite.main) stamped.sprites.add(sprite.handle);
            const frustum = drawn.frustum(pass.camera);
            for (const binding of bindings) {
              if (!main.has(binding.id)) continue;
              if (!stamped.bindings.has(binding.id)) {
                stamped.occluded.add(binding.actor); stamped.bindings.set(binding.id, binding.actor); stamped.source.set(binding.actor, 'main');
              }
              if (binding.drawnIn(frustum, null)) stamped.drawn.add(binding.actor);
            }
            continue;
          }
          // A child frame's pass draws and stamps its own Frame->Sprite
          // (DrawActorSprite, 0x10b25150), whatever three.js culls: an actor
          // whose groups all lie outside the pass's view is stamped, not drawn.
          if (pass.frame) {
            const frame = pass.frame, ids = frame.main ?? new Set(), frustum = drawn.frustum(pass.camera);
            for (const sprite of sprites) if (sprite.frames?.includes(frame.index)) stamped.sprites.add(sprite.handle);
            // A sky frame inside a mirror frame that draws no actor needs no decisions (the page hides the actors for it).
            const decisions = actorPasses && actorScene && !(pass.within && !ids.size) ? actorScene.framePasses(frustum, ids, frame.index) : null;
            for (const id of ids) {
              const binding = byId.get(id);
              if (!binding) continue;
              if (!stamped.bindings.has(id)) {
                stamped.occluded.add(binding.actor); stamped.bindings.set(id, binding.actor);
                stamped.source.set(binding.actor, `${pass.kind} frame ${frame.index}`);
              }
              if (binding.drawnIn(frustum, decisions?.get(id) ?? { root: true })) stamped.drawn.add(binding.actor);
            }
            if (decisions) {
              // A sky frame inside a mirror frame: its decisions ride with
              // that mirror's pass (the page draws it into the mirror's
              // target first); a frame that draws no actor needs none.
              if (pass.within) insideSky.push({ frame: frame.index, decisions, light: lightCamera(frame) });
              else if (pass.kind === 'mirror') {
                passDecisions.push(decisions); passIds.push(pass.node.id); passFrames.push(lightCamera(frame)); passSky.push(insideSky); insideSky = [];
              }
              else { skyDecisions = decisions; skyFrame = lightCamera(frame); }
              if (pass === lastMirror || (pass.kind === 'sky' && !pass.within)) mainDecisions = actorScene.framePasses(null, null);
            }
            continue;
          }
          drawn.spritesIn(pass, sprites, stamped.sprites);
          if (pass.kind === 'sky' || !actorScene) continue;
          const frustum = drawn.frustum(pass.camera);
          const decisions = pass.kind === 'mirror' && actorPasses ? actorScene.passVisibility(frustum) : null;
          if (decisions) { passDecisions.push(decisions); passIds.push(pass.node.id); passFrames.push(null); passSky.push([]); }
          for (const binding of bindings)
            if (!stamped.bindings.has(binding.id) && binding.drawnIn(frustum, decisions?.get(binding.id) ?? null)) {
              stamped.actors.add(binding.actor); stamped.bindings.set(binding.id, binding.actor); stamped.source.set(binding.actor, pass.kind);
            }
          if (pass === lastMirror && actorPasses) mainDecisions = actorScene.passVisibility(null);
        }
        // A child frame OccludeBsp made that no pass draws (the page has no mirror group for its surface: a mover's
        // translucent glass, 06_HongKong_WanChai_Underworld) still stamps its Frame->Sprite: DrawFrame draws every
        // child frame, and DrawActorSprite (0x10b25150) stamps what it draws. The original's frame 1 of that map
        // (recursion 1, Mirror -1) stamped a pawn the main frame culls; without this Play never stamped it
        // (docs/visual-acceptance.md "Live scenes", pilot 3).
        if (!inspect && frames) {
          const planned = new Set(passes.filter(pass => pass.frame).map(pass => pass.frame.index));
          for (const frame of frames) {
            if (planned.has(frame.index)) continue;
            for (const sprite of sprites) if (sprite.frames?.includes(frame.index)) stamped.sprites.add(sprite.handle);
            for (const id of frame.main ?? []) {
              const binding = byId.get(id);
              if (!binding || stamped.bindings.has(id)) continue;
              stamped.occluded.add(binding.actor); stamped.bindings.set(id, binding.actor);
              stamped.source.set(binding.actor, `${frame.kind} frame ${frame.index} (not drawn)`);
            }
          }
        }
        if (mirrored && actorPasses && !mainDecisions && actorScene) mainDecisions = actorScene.passVisibility(null);
        for (const name of stamped.movers) if (!moverActors.has(name)) stamped.movers.delete(name);
        // Model.Zones[i].LastRenderTime: OccludeBsp stamps the zone of each frame and every zone a portal shows it
        // (0x10b1768d and the portal write in the same function; occlude.rs), in every frame it runs, child frames
        // included. AActor::InStasis reads it (a pawn in a zone seen within 5 s and within 1200 units of the player is
        // never in stasis, actor-tick.mjs). Play kept the table at zero, so a pawn with bStasis set whose LastRenderTime
        // was old went into stasis in a rendered zone and its animation and timers froze one tick after the script set
        // bStasis; the original kept ticking it (06_HongKong_WanChai_Underworld, Female1: Dist 1122, LRT -10).
        if (occlusion?.zoneTime) {
          const times = runtime.levelFor(game.player.collisionActor).zoneLastRenderTimes;
          if (times) for (let i = 0; i < times.length; i++) { u32[0] = occlusion.zoneTime(i); times[i] = f32[0]; }
        }
        const info = runtime.levelFor(game.player.collisionActor).actors[0];
        const time = Math.fround(runtime.readNamed(info, 'TimeSeconds'));
        const shown = actor => !runtime.readNamed(actor, 'bHidden') && !runtime.readNamed(actor, 'bDeleteMe');
        for (const name of stamped.movers) {
          const actor = moverActors.get(name);
          if (actor && shown(actor)) runtime.writeNamed(actor, 'LastRenderTime', time);
        }
        for (const handle of stamped.sprites) runtime.writeNamed(identityOfHandle(handle), 'LastRenderTime', time);
        for (const actor of stamped.actors) if (shown(actor)) runtime.writeNamed(actor, 'LastRenderTime', time);
        // DrawActorSprite (0x10b25150) stamps every Frame->Sprite actor; the
        // frame's admission already left hidden ones out (an iterator's items
        // draw whatever their own bHidden).
        for (const actor of stamped.occluded) if (!stamped.actors.has(actor)) runtime.writeNamed(actor, 'LastRenderTime', time);
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, passDecisions, passIds, passFrames, passSky, mainDecisions, skyDecisions, skyFrame };
    },
    /** DrawFrame's corona pass, which closes the world frame
     * (corona-scan.mjs): the icons over the render rect's size, or else the
     * canvas's, in drawing-buffer pixels, from the master frame OccludeBsp
     * read. `now` is the fade clock in seconds. */
    coronas({ now }) {
      // The camera frames' corona passes (planViewportPass) come later in the
      // same frame: their clock runs on from this one by the host's elapsed time.
      coronaClock = { now, at: performance.now() };
      const errors = [], rect = current?.renderRect ?? { width: size[0], height: size[1] };
      let frame = null;
      try { frame = coronaScan.update(current.view, rect, current.visibility?.master ?? null, live.lights, now); }
      catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, frame, width: rect.width, height: rect.height };
    },
    /** PostRender's view model (weapon-overlay-sim.mjs) with the main
     * camera, and render feedback for the actors it draws. */
    weapon({ pack = null } = {}) {
      const errors = [];
      let frame = null;
      try {
        const { lodInputs, admit } = canvasDrawInputs();
        frame = weaponSim.frame({ frustum: weaponFrustum, pack, lodInputs, settings: actorScene?.lodSettings?.(), admit });
        if (frame) {
          const info = runtime.levelFor(game.player.collisionActor).actors[0];
          const time = Math.fround(runtime.readNamed(info, 'TimeSeconds'));
          // (Canvas.DrawActor stamps a hidden actor too: actor-render-feedback.mjs `canvas`; a held item is bHidden since BecomeItem)
          for (const actor of frame.drawn)
            if (!runtime.readNamed(actor, 'bDeleteMe'))
              runtime.writeNamed(actor, 'LastRenderTime', time);
          if (stamped) stamped.weapon = new Set(frame.drawn.map(handleOf));
          frame = { target: frame.target, draws: frame.draws, camera: frame.camera, summary: { ...weaponSim.summary } };
        }
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, frame };
    },
    /** ?simVerify: the frame's drawn set against what three.js drew
     * (onAfterRender of mover meshes, sprites and actor meshes). The page
     * draws a binding once its meshes exist and a sprite once its texture
     * has decoded (`built(id)`, `skipped` sprite handles); the stamps do not
     * wait for the page, so those are left out of the comparison. */
    verifyStamps(drew, { built = () => true, skipped = new Set() } = {}) {
      if (!stamped) return null;
      const name = value => typeof value === 'number' ? identityOfHandle(value)?.name ?? String(value)
        : typeof value === 'string' ? value : value.name;
      // The actors three.js draws: a Frame->Sprite actor it culls in every
      // pass that stamps it is stamped, not drawn.
      const actors = new Set();
      for (const [id, actor] of stamped.bindings)
        if (built(id) && (!stamped.occluded.has(actor) || stamped.drawn.has(actor))) actors.add(actor);
      const want = { movers: stamped.movers, sprites: new Set([...stamped.sprites].filter(handle => !skipped.has(handle))), actors };
      for (const kind of trackerMovers ? ['sprites', 'actors'] : ['movers', 'sprites', 'actors']) {
        const a = new Set([...want[kind]].map(name)), b = new Set([...drew[kind]].map(name));
        const onlySim = [...a].filter(x => !b.has(x)), onlyPage = [...b].filter(x => !a.has(x));
        if (onlySim.length || onlyPage.length)
          return `${kind}: only the simulation side ${onlySim.map(n => {
            const source = kind === 'actors' ? [...stamped.source].find(([actor]) => actor.name === n)?.[1] : null;
            return source ? `${n} (${source})` : n;
          }).join(',') || '-'}; only the page ${onlyPage.join(',') || '-'}`;
      }
      return null;
    },
    /** ?simVerify: the view model's stamped actors against what three.js
     * drew in the overlay pass (`built(handle)`: the page has its meshes). */
    verifyWeapon(drew, built = () => true) {
      if (!stamped) return null;
      const name = handle => identityOfHandle(handle)?.name ?? String(handle);
      const a = new Set([...stamped.weapon].filter(built).map(name)), b = new Set([...drew].map(name));
      const onlySim = [...a].filter(x => !b.has(x)), onlyPage = [...b].filter(x => !a.has(x));
      return onlySim.length || onlyPage.length
        ? `weapon: only the simulation side ${onlySim.join(',') || '-'}; only the page ${onlyPage.join(',') || '-'}` : null;
    },
    movers,
    // LoadMap deletes the moving brush tracker before it loads the level (docs/brush-tracker.md "Lifetime"), so the reset's
    // actor start-up traces the static BSP; GNewBrushTracker follows the start-up (the rebuild).
    reset() { dropOcclusion?.(); game.reset(); failed = false; travelled = false; preTicked = null; rebuildOcclusion?.(); },
    /** The session's own simulation-side objects (the view model's
     * bindings); the actor mesh layer belongs to its scene wrapper. */
    /** A pack buffer back from the page, for a later frame. */
    recyclePack(buffer) {
      if (buffer instanceof ArrayBuffer && buffer.byteLength >= PACK_WORDS * 4 && packSpares.length < 4) packSpares.push(buffer);
    },
    dispose() { weaponSim?.dispose(); decalDraw?.dispose(); detailDraw?.dispose(); },
    /** The level's first tick, run ahead of the first frame (docs/first-frames.md "Ahead of the first frame"): the tick that frame would
     * make with `dt`, while the page still builds its draw side and the worker would idle. The viewport's size is set first, as begin
     * sets it, because the level's first tick reads it (UViewport SizeX, SizeY). The first frame then takes the tick's errors and
     * travel request (begin's `preTicked`). Returns whether the tick ran; a session that failed, travelled or follows a live replay
     * keeps the frame's own tick. */
    preTick({ dt, width, height, aspect = null, resizes = 0 }) {
      if (preTicked || failed || travelled || game.liveReplay) return false;
      if (aspect !== null && resizes !== resizesSeen) {
        camera.aspect = aspect; camera.fov = verticalFov(75, aspect); camera.updateProjectionMatrix(); resizesSeen = resizes;
      }
      size = [width, height];
      const ahead = { errors: [], travel: null };
      try {
        game.tick(dt);
        ahead.travel = game.clientTravel();
        if (ahead.travel) travelled = true;
      } catch (error) { failed = true; ahead.errors.push(plainError(error)); }
      preTicked = ahead;
      return true;
    },
    /** The frame's first steps: the tick (and lip sync), PlayerCalcView, the
     * render viewport, SetupDynamics' moving-light scan, the sky frame, the
     * frob target and the surface pan inputs. `run` is false while the page
     * pauses the simulation; `halted` while it stopped on an error of its
     * own. A step that throws stops the later gated steps, as
     * pauseForRuntimeError did. */
    begin({ dt, run, halted, width, height, aspect = null, resizes = 0, preTicked: ahead = false }) {
      // The page's resize() since the last frame: the canvas aspect and the
      // default FOV, before PlayerCalcView points the camera.
      if (aspect !== null && resizes !== resizesSeen) {
        camera.aspect = aspect; camera.fov = verticalFov(75, aspect); camera.updateProjectionMatrix(); resizesSeen = resizes;
      }
      // Validation (live-probe.mjs renderSize): the original's frame size (UViewport SizeX, SizeY) when a live replay holds it.
      const forced = game.liveReplay?.renderSize ?? null;
      if (forced) { width = forced[0]; height = forced[1]; }
      size = [width, height];
      const errors = [], stopped = () => halted || failed;
      const fail = error => { failed = true; errors.push(plainError(error)); };
      let travel = null;
      // The tick this frame's first post asked for ran ahead of it (preTick): its errors and travel request are this frame's, and the
      // frame ticks only for the posts merged into it after that one (their dt; none: no tick).
      const done = ahead ? preTicked : null;
      if (ahead) {
        preTicked = null;
        if (done) { errors.push(...done.errors); travel = done.travel; }
        else if (!(dt > 0)) dt = FIRST_FRAME_DT;   // (no tick ran ahead: the frame makes the first tick the post stood for)
      }
      if (run && !stopped() && !travelled && !(done && !(dt > 0))) {
        try {
          // Validation: liveProbe's replay of an original trace sets this tick's delta and
          // stream state, or holds the level (live-probe.mjs).
          const replay = game.liveReplay, delta = replay ? replay.before(dt) : dt;
          if (delta !== false) { game.tick(delta, replay?.windowSeconds ?? null); replay?.after(); }
          // UGameEngine::Tick's client travel, after the level's tick (held or not) and before the render: an OPEN's URL ends the level here.
          // (a session that travels returns the request for the next level, which the page loads; this level does not tick again)
          travel = game.clientTravel();
          if (travel) travelled = true;
          // Lip sync is Galaxy Update's step 12, after the HUD frame (script-audio-live.mjs).
        } catch (error) { fail(error); }
      }
      const frame = { errors, movers: movers(), view: null, renderRect: null, lights: null, light: null, sky: null, target: null, pan: null,
        visibility: null, travel };
      live.lights = null;
      try { frame.view = plainView(game.view()); lastViewLocation = frame.view.location; } catch (error) { fail(error); }
      if (!stopped()) {
        try {
          const timeSeconds = Math.fround(game.surfacePan().timeSeconds);
          // Galaxy's Update reads the table A this PreRender replaces.
          lights.previousA.set(lightNoise.A);
          lightNoise.update(timeSeconds);
          frame.light = { timeSeconds, noise: lightNoiseSnapshot(lightNoise) };
        } catch (error) { fail(error); }
      }
      if (frame.view && !stopped()) {
        // (a live replay's forced frame size is the original's window; the root window's own render viewport still clips it: a letterboxed
        // conversation draws the 3D view in the band between the bars, and projects from the band's centre)
        try { frame.renderRect = { ...game.renderViewport(width, height) }; } catch (error) { fail(error); }
      }
      if (!stopped()) {
        try { live.lights = game.movingLights(); frame.lights = live.lights.map(plainLight); } catch (error) { fail(error); }
      }
      const rect = frame.renderRect;
      // The page draws the world (and asks for the sky frame) unless the
      // root window's render viewport is empty.
      if (!rect || (rect.render && rect.width > 0 && rect.height > 0)) {
        try { frame.sky = lastViewLocation ? sky(lastViewLocation) : null; } catch (error) { fail(error); }
        pendingOcclusion = null;
        if (occlusion && frame.view && !stopped()) {
          const [w, h] = rect ? [rect.width, rect.height] : [width, height];
          // The dynamics wait for the sprite scan and the actor layer.
          if (actorOcclusion && occlusion.setupSupported) pendingOcclusion = { view: frame.view, width: w, height: h, frame };
          else {
            try { frame.visibility = visibility(frame.view, w, h, -1, { origin: [rect?.x ?? 0, rect?.y ?? 0] }); attachMoverPoints(frame.visibility); }
            catch (error) { fail(error); }
            // DrawWorld draws the sky frame only when OccludeBsp made one.
            if (frame.visibility && !frame.visibility.sky) frame.sky = null;
          }
        }
      }
      try {
        const pan = game.surfacePan();
        frame.pan = { timeSeconds: pan.timeSeconds, speeds: Object.fromEntries(panZones.map(name => [name, pan.zoneSpeeds(name)])) };
      } catch (error) { fail(error); }
      if (frame.view) {
        // The pass frame's projection (Proj.Z, FX15, FY15 over the render
        // rectangle: play-camera.mjs setFrameProjection), the page's own
        // when it receives it; the FOV's without OccludeBsp.
        try { const master = frameMaster(frame); frame.projection = master ? projectionOf(master.words, master.prj) : null; }
        catch (error) { frame.projection = null; fail(error); }
        applyPlayFrame(camera, frame.view, frame.renderRect, frame.projection);
        // The page's camera takes the original's pixel centres for the same
        // view size (main.mjs), so mirror planning sees the same bounds.
        const viewSize = rect?.render && rect.width > 0 && rect.height > 0 ? [rect.width, rect.height] : size;
        setPixelCentre(camera, ...viewSize);
      }
      drawn?.placeMovers(frame.movers);
      current = frame;
      return frame;
    },
  };
}
