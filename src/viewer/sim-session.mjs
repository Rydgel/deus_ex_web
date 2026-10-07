/** The simulation side of a Play frame (docs/sim-worker.md). Each step runs
 * where animate() ran it before the split, with the same error gating; the
 * frame's results come back as plain data for the drawing side. Steps not
 * yet moved here still run from main.mjs. */
import { handleOf, identityOfHandle } from '../runtime/script-object-handles.mjs';
import { createSpriteScan } from './sprite-scan.mjs';
import { constructRenderIterator, renderIteratorNativeClass } from '../runtime/script-render-iterator.mjs';
import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { fromView } from '../unreal/geometry.mjs';
import { createPlayCamera, applyPlayFrame, pointCamera, verticalFov, setPixelCentre } from './play-camera.mjs';
import { createDrawnSet } from './drawn-set.mjs';
import { createMeshFramePack } from './mesh-frame-pack.mjs';
import { createDecalDraw } from '../runtime/decal-draw.mjs';
import { OCCLUSION_POINTS, OCCLUSION_SPRITE_KEYS } from '../runtime/bsp-occlusion.mjs';
import { packDynamics, actorOcclusionMode } from './dynamics-candidates.mjs';
import { createLightNoise, lightNoiseSnapshot } from '../runtime/static-lighting.mjs';
import { lightGlobals } from '../runtime/light-globals.mjs';
import { filterMovingLight, surfaceLightClass, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
import { dynamicActorRoute } from '../runtime/render-visibility.mjs';
import { TRACKED_MOVER_MIRRORS, childFramesMode } from './mirror-passes.mjs';

/** A thrown error as plain data: structured clone drops an Error's own
 * properties (`travel`, `partial`). */
export const plainError = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error),
  stack: error?.stack ?? null, travel: error?.travel ?? null, partial: error?.partial ?? null });

/** A HUD texture reference as plain data: the page decodes it from its own
 * asset store. */
export const plainTexture = ref => ({ key: ref.key, package: ref.asset.name, index: ref.index });
/** The window host's GC draw commands (script-window-host.mjs callVirtual)
 * as plain data. */
export const plainHudCommands = commands => commands.map(command => command.kind === 'viewport'
  // A ViewportWindow's world pass (script-window-viewport.mjs): plain already.
  ? { kind: 'viewport', x: command.x, y: command.y, width: command.width, height: command.height,
    location: [...command.location], rotation: [...command.rotation], fov: command.fov, clearZ: command.clearZ,
    hidden: [...command.hidden], behindView: command.behindView }
  : ({ texture: plainTexture(command.texture),
  x: command.x, y: command.y, width: command.width, height: command.height, u: command.u, v: command.v,
  ul: command.ul, vl: command.vl, color: command.color, style: command.style }));

/** `assets` is the simulation side's asset store (sprite texture sizes).
 * `events` is the ordered queue of what the simulation hands the page
 * between frames (the actor mesh layer's and the view model's creation and
 * release records, lighting changes); each frame() snapshot takes it. */
export function createSimSession(game, { assets = null, events = [], exportName = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime;
  let failed = false, panZones = [], lastViewLocation = null, current = null, lipSync = null;
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
  // The original BSP occlusion (bsp-occlusion.mjs) and DrawWorld's frame
  // counter (0x10b5a700), which schedules its bound tests. Unless
  // ?actorOcclusion=frustum, the main frame's OccludeBsp waits for
  // SetupDynamics' candidates (`pendingOcclusion`, run by occludeMain) and
  // its Frame->Sprite decides the main frame's actors.
  let occlusion = null, drawWorlds = 0, pendingOcclusion = null;
  // The moving brush tracker's movers ({names, actors, indices: their
  // Level.Actors slots} in its order; null with ?moverTracker=off) and the
  // rebuild Player start's LoadMap needs.
  let trackerMovers = null, rebuildOcclusion = null;
  const actorOcclusion = actorOcclusionMode() !== 'frustum';
  // OccludeFrame's child frames (mirror and sky) with their own OccludeBsp;
  // ?childFrames=off keeps the frustum-tested passes.
  const childFrames = childFramesMode() !== 'off';
  // DrawFrame's decal block after the main frame's OccludeBsp
  // (decal-draw.mjs, docs/decals.md), with the kernel's frame words.
  let decalDraw = null, occlusionFramePtr = null;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const weaponFrustum = new THREE.Frustum(), weaponMatrix = new THREE.Matrix4();
  // The live records of this frame's moving-light scan, for the simulation
  // side's own consumers (the mesh lighting frame); the snapshot carries
  // handles instead of actors.
  const live = { lights: null, meshItems: [], sprites: [], iterators: null };
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
  let strobeSurfaces = null;
  function lightMapStrobe(visible, scanned, timeSeconds) {
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
      model.surfaces.forEach((surface, index) => {
        const lightMap = surface.lightMap >= 0 ? model.lightMaps[surface.lightMap] : null;
        if (!lightMap || lightMap.lightActors == null || lightMap.lightActors < 0) return;
        const found = [];
        for (let i = lightMap.lightActors; i < model.lights.length && model.lights[i]; i++) { const actor = isStrobe(model.lights[i]); if (actor) found.push(actor); }
        if (found.length) strobeSurfaces.set(index, found);
      });
    }
    // A new TimeSeconds is needed for a flip, and some Strobe light to call.
    timeSeconds = Math.fround(timeSeconds);
    if (lights.strobe.time === timeSeconds) return;
    let moving = null;
    for (const light of scanned ?? [])
      if ((light.values.LightType & 255) === 5 && surfaceLightClass(light.values) === 2) (moving ??= []).push(light);
    if (!strobeSurfaces.size && !moving) return;
    const live = actor => {
      const values = { LightType: read(actor, 'LightType'), LightBrightness: read(actor, 'LightBrightness'), bStatic: read(actor, 'bStatic'),
        bNoDelete: read(actor, 'bNoDelete'), bDynamicLight: read(actor, 'bDynamicLight'), LightEffect: read(actor, 'LightEffect') };
      return (values.LightType & 255) === 5 && surfaceLightClass(values) === 1;
    };
    // The level surfaces drawn (the brush tracker's fragment nodes, past the
    // level model's, are movers' polygons: their light maps are the movers').
    let any = false, drawn = null;
    for (const node of visible.nodes) {
      if (node >= model.nodes.length) continue;
      const actors = strobeSurfaces.get(model.nodes[node].surface);
      if (actors && actors.some(live)) { any = true; break; }
    }
    if (!any && moving) {
      drawn = new Set();
      for (const node of visible.nodes) if (node < model.nodes.length) drawn.add(model.nodes[node].surface);
      for (const light of moving) {
        for (const surface of filterMovingLight(model, light.location, worldLightRadius(light.values), Boolean(light.values.bSpecialLit)))
          if (drawn.has(surface)) { any = true; break; }
        if (any) break;
      }
    }
    // The Strobe function's test (0x10b05b30): a new TimeSeconds flips the flag.
    if (any) { lights.strobe.time = timeSeconds; lights.strobe.flag ^= 1; }
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
  const spriteScan = createSpriteScan(runtime, { player: () => game.player.collisionActor, constructIterator,
    frand: () => runtime.rng.frand() });
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
  const movers = () => game.collision.movers.map(mover => ({ name: mover.name, values: moverValues.get(mover.name),
    position: [...mover.position], rotation: mover.rotation ? [...mover.rotation] : null, offset: [...mover.collider.offset] }));
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
  // A zone's SkyZone for the sky child frame (occlude.rs sky_coords): its
  // Location, Rotation and Region.ZoneNumber.
  function skyRecord(sky) {
    if (!sky) return null;
    const region = runtime.readNamed(sky, 'Region');
    return { location: [...runtime.readNamed(sky, 'Location')], rotation: [...runtime.readNamed(sky, 'Rotation')],
      zone: region?.['engine.actor.pointregion.zonenumber'] ?? 0 };
  }
  // A frame's drawn nodes (Uint32Array) and the tracked movers' polygon
  // ordinals its draw lists hold, by mover name (null without the tracker),
  // with each draw item's iZone alongside (`moverZones`: SetupForSurf's
  // fog-zone test reads the item's zone) and each drawn polygon's surface
  // pBase and vectors as the tracker holds them (`moverFacets`, by ordinal:
  // SetupForSurf's light-map lattice of a dynamic surface).
  function drawnOf(draw) {
    const nodes = [];
    for (const list of draw) for (const entry of list) for (const poly of entry.polys) nodes.push(poly.iNode);
    let movers = null, moverZones = null, moverFacets = null;
    if (trackerMovers && occlusion.tracker?.live()) {
      movers = {}; moverZones = {}; moverFacets = {};
      for (const list of draw) for (const entry of list) {
        const owner = occlusion.tracker.surfOwner(entry.iSurf);
        if (!owner) continue;
        const name = trackerMovers.names[owner.tag - 0x40000000];
        (movers[name] ??= []).push(owner.ordinal);
        (moverZones[name] ??= []).push(entry.iZone);
        (moverFacets[name] ??= {})[owner.ordinal] ??= occlusion.tracker.surfaceFacet(entry.iSurf);
      }
    }
    return { nodes: Uint32Array.from(nodes), movers, moverZones, moverFacets };
  }
  // A span's pixel bounds [minX, startY, maxX, endY) (top-down), or null.
  function spanBounds(span) {
    let minX = Infinity, maxX = -Infinity, startY = Infinity, endY = -Infinity;
    span.lines.forEach((line, i) => {
      if (!line.length) return;
      minX = Math.min(minX, line[0][0]); maxX = Math.max(maxX, line.at(-1)[1]);
      startY = Math.min(startY, span.startY + i); endY = Math.max(endY, span.startY + i + 1);
    });
    return minX < maxX && startY < endY ? [minX, startY, maxX, endY] : null;
  }
  function visibility(view, width, height, setupCount = -1) {
    const level = runtime.levelFor(game.player.collisionActor), info = level.actors[0];
    const moversStarted = performance.now();
    updateMovers();
    const moversMs = performance.now() - moversStarted;
    occlusion.setZoneSkies(level.zoneModel.zoneActors.map(zone => skyRecord(runtime.readNamed(zone ?? info, 'SkyZone'))));
    const words = occlusion.master({ location: view.location, rotation: view.rotation, width, height, fov: view.fov }).frame;
    f32[0] = runtime.readNamed(info, 'TimeSeconds');
    // The decal block clips against the saved polygons' points (option
    // 0x100); Setup's sprites need only their keys (0x200).
    const decals = decalDraw?.wanted(level) ?? false;
    words[44] = ++drawWorlds; words[45] = u32[0];
    words[46] = 3 | (decals ? OCCLUSION_POINTS : 0) | (setupCount >= 0 ? OCCLUSION_SPRITE_KEYS : 0); words[47] = 0;
    const started = performance.now();
    const result = occlusion.run(words, [], { setupCount, skipPoints: true,
      children: childFrames ? { fov: view.fov, orthoZoom: 0 } : null });
    const { nodes, movers, moverZones, moverFacets } = drawnOf(result.draw);
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
      const drawnHere = drawnOf(frame.draw);
      const owner = frame.kind === 'mirror' && drawnHere.movers ? occlusion.tracker.surfOwner(occlusion.nodeSurf(frame.iNode)) : null;
      return { index: frame.index, parent: frame.parent, kind: frame.kind, iNode: frame.iNode, recursion: frame.recursion,
        group: owner ? `${trackerMovers.names[owner.tag - 0x40000000]}:${owner.ordinal}` : null,
        bounds: spanBounds(frame.span), nodes: drawnHere.nodes, movers: drawnHere.movers,
        sprites: frame.sprites.map(sprite => sprite.key) };
    });
    return { nodes, zone: words[42], mirrors, frames: childFrames ? frames : null, size: [width, height],
      sky: result.children.some(child => child.kind === 'sky'), decals: fragments, movers, moverZones, moverFacets,
      sprites: result.sprites.map(sprite => sprite.key),
      // Host timings (ms): the movers' Update, OccludeBsp with its decode
      // (and the movers' draw lists), then the decal block.
      ms: { movers: moversMs, occlusion: occluded - started, decals: performance.now() - occluded } };
  }
  // The main frame's dynamics and OccludeBsp (docs/bsp-occlusion.md "Play"):
  // this frame's sprite records and, from the actor mesh layer, its bindings
  // (`args`), as Setup candidates in SetupDynamics' order. Frame->Sprite
  // marks each sprite record's `main` and gives the drawn bindings' ids
  // (`visibility.main`); the frame's visibility and sky follow.
  function occludeMain(args = {}) {
    const pending = pendingOcclusion;
    pendingOcclusion = null;
    if (!pending) return null;
    const entries = packDynamics(occlusion, { sprites: live.sprites, iterators: live.iterators, ...args });
    const result = visibility(pending.view, pending.width, pending.height, entries.length), main = new Set();
    for (const sprite of live.sprites) { sprite.main = false; sprite.frames = null; }
    for (const key of result.sprites) {
      const entry = entries[key];
      if (entry.sprite) entry.sprite.main = true; else main.add(entry.binding.id);
    }
    result.main = main;
    delete result.sprites;
    // Each child frame's Frame->Sprite: its bindings (`main`) and, on the
    // sprite records, the frames that draw them; `children` every binding
    // some child frame draws.
    const children = new Set();
    for (const frame of result.frames ?? []) {
      frame.main = new Set();
      for (const key of frame.sprites) {
        const entry = entries[key];
        if (entry.sprite) (entry.sprite.frames ??= []).push(frame.index);
        else { frame.main.add(entry.binding.id); children.add(entry.binding.id); }
      }
      delete frame.sprites;
    }
    result.children = children;
    pending.frame.visibility = result;
    // DrawWorld draws the sky frame only when OccludeBsp made one.
    // The SkyZone view stays for the sky frames inside mirror frames.
    result.skyView = pending.frame.sky ?? null;
    if (!result.sky) pending.frame.sky = null;
    return result;
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
      return [...game.hud.host.resourceImages.values()].filter(resource => resource.kind === 'texture')
        .map(resource => plainTexture(resource.ref));
    },
    /** The HUD frame after the world's: the window tree's paint
     * (DrawWindow/PostDrawWindow and the GC natives) as plain GC commands,
     * Galaxy's update after it (game.mjs: UGameEngine::Draw updates audio
     * after the frame), then the InfoLink text the page mirrors for
     * accessibility. An error stops the simulation like the frame's other
     * steps. */
    hud({ width, height, view }) {
      const errors = [];
      let commands = [], infoLink = null;
      try {
        commands = plainHudCommands(game.hud.commands(width, height, view));
        infoLink = infoLinkText();
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, commands, infoLink };
    },
    /** SetupDynamics' sprite scan with the render iterators (sprite-scan.mjs):
     * the sprite records in draw order. The laser DT_Mesh items stay in
     * `live.meshItems` for the actor mesh scene. */
    sprites() {
      const errors = [];
      let sprites = [];
      live.meshItems = [];
      try {
        const scanned = spriteScan.scan(); sprites = scanned.sprites; live.meshItems = scanned.meshItems;
        live.iterators = scanned.iterators;
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
    setOcclusion(value, movers = null) { occlusion = value; trackerMovers = movers; },
    setOcclusionRebuild(rebuild) { rebuildOcclusion = rebuild; },
    /** Validation (mover-probe.mjs): each tracked mover's fragment count
     * and the polygons the last main frame drew, and that frame's drawn
     * node count, mover mirror requests, host timings and admitted
     * (updated) movers. */
    moverState() {
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
        polygons: drawn ? [...new Set(drawn[name] ?? [])].sort((a, b) => a - b) : null })) };
    },
    /** Validation (mover-probe.mjs): the last main frame's decal fragments
     * (decal-draw.mjs groups: texture, view-space triangle positions). */
    decalFragments() { return current?.visibility?.decals ?? null; },
    /** The kernel's decal facade and its frame-words pointer for the decal block. */
    setDecalKernel(kernel, framePtr) { decalDraw?.dispose(); decalDraw = kernel ? createDecalDraw(runtime, kernel) : null; occlusionFramePtr = framePtr; },
    setCoronas(scan) { coronaScan = scan; },
    setLipSync(channels) { lipSync = channels; },
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
      let inspect = null;
      if (input.inspect) {
        const c = input.inspect.camera;
        inspectCamera.position.fromArray(c.position); inspectCamera.quaternion.fromArray(c.quaternion);
        inspectCamera.fov = c.fov; inspectCamera.aspect = c.aspect; inspectCamera.near = c.near; inspectCamera.far = c.far;
        inspectCamera.updateProjectionMatrix(); inspectCamera.updateMatrixWorld();
        inspect = inspectCamera;
      }
      // The frame's packed GetFrame plans and SetupForActor results
      // (mesh-frame-pack.mjs), a fresh buffer each frame.
      const pack = createMeshFramePack();
      const snapshot = { errors, timings, begin: null, drawWorld: true, sprites: null, actors: null, stamps: null,
        coronas: null, weapon: null, hud: null, audioMs: 0, events: null, pack: null };
      let begun = null;
      if (input.play) {
        begun = this.begin({ dt: input.dt, run: input.run, halted: input.halted, width, height, lipSync,
          aspect: input.aspect, resizes: input.resizes });
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
      live.sprites = []; live.iterators = null;
      if (input.play && !stopped()) {
        const scanned = this.sprites();
        collect(scanned.errors);
        snapshot.sprites = { sprites: scanned.sprites, notes: scanned.notes };
        sprites = scanned.sprites;
      }
      time('sprites');
      if (actorScene && !stopped()) {
        const actors = this.actors({ camera: inspect, pack });
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
        const stamps = this.stamps({ size: { x: width, y: height }, drawWorld, sky, mirrors: input.mirrors, sprites, camera: inspect, requested,
          actorPasses: Boolean(actorScene) && !stopped(), frames, rect: begun?.renderRect ?? null });
        collect(stamps.errors);
        snapshot.stamps = { passDecisions: stamps.passDecisions, mainDecisions: stamps.mainDecisions, skyDecisions: stamps.skyDecisions };
      }
      time('mirrors');
      if (drawWorld && input.play && coronaScan && view && !stopped()) {
        const coronas = this.coronas({ pixelRatio: input.pixelRatio, now: input.now });
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
        const hud = this.hud({ width, height, view });
        collect(hud.errors);
        snapshot.hud = { commands: hud.commands, infoLink: hud.infoLink };
      }
      // Galaxy's Update runs inside the HUD draw (UGameEngine::Draw order).
      snapshot.audioMs = input.play ? game.takeAudioMs?.() ?? 0 : 0;
      time('hud');
      timings.hud -= snapshot.audioMs; timings.audio = snapshot.audioMs;
      // The frame's Strobe flag for the page's light maps, after every
      // simulation-side caller (light-globals.mjs).
      if (begun?.light) begun.light.strobe = { time: lights.strobe.time, flag: lights.strobe.flag };
      snapshot.events = events.splice(0);
      snapshot.pack = pack.words();
      return snapshot;
    },
    /** The queued events outside a frame (map load: the first creation
     * records before the first frame). */
    takeEvents() { return events.splice(0); },
    setWeapon(overlay) { weaponSim = overlay; },
    /** URender's per-frame mesh lighting setup for the main viewport
     * (mesh-lighting-view.mjs beginFrame) with this frame's moving lights;
     * `seconds` is the viewport clock (the page's frame time). */
    lightFrame(seconds, inspect = null) {
      if (!meshLighting) return [];
      const errors = [];
      const toUnits = radians => Math.round(radians * 32768 / Math.PI);
      const view = inspect ?? current?.view ?? { location: fromView(camera.position.toArray()),
        rotation: [toUnits(camera.rotation.x), toUnits(-camera.rotation.y), 0] };
      try { meshLighting.beginFrame({ location: view.location, rotation: view.rotation, seconds, lights: inspect ? null : live.lights }); }
      catch (error) { failed = true; errors.push(plainError(error)); }
      return errors;
    },
    /** The actor mesh layer's main-frame update (actor-mesh-sim.mjs) with
     * the frame camera's frustum; with mirrors that may draw, actors only
     * child frames draw are admitted and nothing is culled early. */
    actors({ camera: inspect = null, pack = null } = {}) {
      const errors = [], view = inspect ?? camera;
      let frame = null;
      try {
        view.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
        const requested = !inspect && current?.visibility ? new Set(current.visibility.mirrors) : null;
        const children = drawn ? drawn.mayRender(view, requested) : false;
        // The main frame's dynamics run after the layer's reads; mirror child
        // frames then follow OccludeBsp's requests.
        const occlude = !inspect && pendingOcclusion ? args => {
          const result = occludeMain({ ...args, childFrames });
          return { main: result.main, children: result.frames ? result.children
            : drawn ? drawn.mayRender(view, new Set(result.mirrors)) : false };
        } : null;
        frame = actorScene.update({ lit: Boolean(meshLighting?.frame), frustum, camera: view, cull: !children, children,
          items: inspect ? [] : live.meshItems, occlude, ...(pack ? { pack } : {}) });
      } catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, frame };
    },
    /** Render feedback for the frame (Render.dll 0x10b25150): the drawn set
     * of every pass (drawn-set.mjs), stamped where the page's draws stamped
     * it, before the corona pass, the weapon and the HUD. Returns the actor
     * layer's decision for each mirror pass in draw order and, when mirrors
     * drew, the main frame's again. `size` is the drawing buffer's. */
    stamps({ size, drawWorld, sky = null, mirrors = true, sprites = [], camera: inspect = null, actorPasses = true, requested = null,
      frames = null, rect = null }) {
      const errors = [], passDecisions = [];
      let mainDecisions = null, skyDecisions = null;
      stamped = { movers: new Set(), sprites: new Set(), actors: new Set(), occluded: new Set(), bindings: new Map(),
        weapon: new Set(), source: new Map(), drawn: new Set() };
      try {
        const { passes, mirrored } = drawn.passes({ camera: inspect ?? camera, sky, drawWorld, size, mirrors, requested,
          frames: inspect ? null : frames, rect });
        const byId = new Map((actorScene?.all() ?? []).map(binding => [binding.id, binding]));
        // `actorPasses`: the page applies the actor layer's mirror pass
        // decisions (no runtime error); otherwise its last state draws.
        const bindings = actorScene?.all() ?? [], lastMirror = passes.findLast(pass => pass.kind === 'mirror');
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
            const decisions = actorPasses && actorScene ? actorScene.framePasses(frustum, ids) : null;
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
              if (pass.kind === 'mirror') passDecisions.push(decisions); else skyDecisions = decisions;
              if (pass === lastMirror || pass.kind === 'sky') mainDecisions = actorScene.framePasses(null, null);
            }
            continue;
          }
          drawn.spritesIn(pass, sprites, stamped.sprites);
          if (pass.kind === 'sky' || !actorScene) continue;
          const frustum = drawn.frustum(pass.camera);
          const decisions = pass.kind === 'mirror' && actorPasses ? actorScene.passVisibility(frustum) : null;
          if (decisions) passDecisions.push(decisions);
          for (const binding of bindings)
            if (!stamped.bindings.has(binding.id) && binding.drawnIn(frustum, decisions?.get(binding.id) ?? null)) {
              stamped.actors.add(binding.actor); stamped.bindings.set(binding.id, binding.actor); stamped.source.set(binding.actor, pass.kind);
            }
          if (pass === lastMirror && actorPasses) mainDecisions = actorScene.passVisibility(null);
        }
        if (mirrored && actorPasses && !mainDecisions && actorScene) mainDecisions = actorScene.passVisibility(null);
        for (const name of stamped.movers) if (!moverActors.has(name)) stamped.movers.delete(name);
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
      return { errors, passDecisions, mainDecisions, skyDecisions };
    },
    /** DrawFrame's corona pass, which closes the world frame
     * (corona-scan.mjs): the icons over the drawn size, the render rect's or
     * else the canvas's in CSS pixels (`pixelRatio`). `now` is the fade
     * clock in seconds. */
    coronas({ pixelRatio, now }) {
      const errors = [], rect = current?.renderRect ?? { width: size[0], height: size[1] };
      const width = rect.width / pixelRatio, height = rect.height / pixelRatio;
      let frame = null;
      try { frame = coronaScan.update(current.view, width, height, now); }
      catch (error) { failed = true; errors.push(plainError(error)); }
      return { errors, frame, width, height };
    },
    /** PostRender's view model (weapon-overlay-sim.mjs) with the main
     * camera, and render feedback for the actors it draws. */
    weapon({ pack = null } = {}) {
      const errors = [];
      let frame = null;
      try {
        camera.updateMatrixWorld();
        weaponFrustum.setFromProjectionMatrix(weaponMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
          camera.coordinateSystem, camera.reversedDepth);
        frame = weaponSim.frame({ frustum: weaponFrustum, pack });
        if (frame) {
          const info = runtime.levelFor(game.player.collisionActor).actors[0];
          const time = Math.fround(runtime.readNamed(info, 'TimeSeconds'));
          for (const actor of frame.drawn)
            if (!runtime.readNamed(actor, 'bHidden') && !runtime.readNamed(actor, 'bDeleteMe'))
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
    reset() { game.reset(); failed = false; rebuildOcclusion?.(); },
    /** The session's own simulation-side objects (the view model's
     * bindings); the actor mesh layer belongs to its scene wrapper. */
    dispose() { weaponSim?.dispose(); decalDraw?.dispose(); },
    /** The frame's first steps: the tick (and lip sync), PlayerCalcView, the
     * render viewport, SetupDynamics' moving-light scan, the sky frame, the
     * frob target and the surface pan inputs. `run` is false while the page
     * pauses the simulation; `halted` while it stopped on an error of its
     * own. A step that throws stops the later gated steps, as
     * pauseForRuntimeError did. */
    begin({ dt, run, halted, width, height, lipSync = null, aspect = null, resizes = 0 }) {
      // The page's resize() since the last frame: the canvas aspect and the
      // default FOV, before PlayerCalcView points the camera.
      if (aspect !== null && resizes !== resizesSeen) {
        camera.aspect = aspect; camera.fov = verticalFov(75, aspect); camera.updateProjectionMatrix(); resizesSeen = resizes;
      }
      size = [width, height];
      const errors = [], stopped = () => halted || failed;
      const fail = error => { failed = true; errors.push(plainError(error)); };
      if (run && !stopped()) {
        try { game.tick(dt); lipSync?.update(dt); } catch (error) { fail(error); }
      }
      const frame = { errors, movers: movers(), view: null, renderRect: null, lights: null, light: null, sky: null, target: null, pan: null,
        visibility: null };
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
            try { frame.visibility = visibility(frame.view, w, h); }
            catch (error) { fail(error); }
            // DrawWorld draws the sky frame only when OccludeBsp made one.
            if (frame.visibility) frame.visibility.skyView = frame.sky ?? null;
            if (frame.visibility && !frame.visibility.sky) frame.sky = null;
          }
        }
      }
      try { const target = game.target(); frame.target = target ? { label: target.label } : null; } catch (error) { fail(error); }
      try {
        const pan = game.surfacePan();
        frame.pan = { timeSeconds: pan.timeSeconds, speeds: Object.fromEntries(panZones.map(name => [name, pan.zoneSpeeds(name)])) };
      } catch (error) { fail(error); }
      if (frame.view) {
        applyPlayFrame(camera, frame.view, frame.renderRect);
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
