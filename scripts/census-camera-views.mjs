#!/usr/bin/env node
/** What each security camera a ComputerSecurity terminal can show has in its
 * view (docs/camera-view-census.md; Stage 4 gate row 4.2.29): mirrors, sky,
 * volumetric fog and coronas, and the moving or host-driven content that would
 * stop a held frame of the original and of Play from matching. Read-only over
 * the shipped maps' data: no game, no browser.
 *
 * The terminal's cameras, as the original resolves them (DeusEx.u script text):
 *  - ComputerSecurity.Views[3] is `sViewInfo {titleString, cameraTag,
 *    turretTag, doorTag}`; the struct is serialized as SerializeBin (an FString,
 *    then three compact name indices), decoded here from the tagged property.
 *  - ComputerScreenSecurity.InitCameras: `foreach AllActors(class'SecurityCamera',
 *    camera, Views[i].cameraTag)` assigns every match, so the last SecurityCamera
 *    in Level.Actors order with that Tag is the window's; an empty tag leaves the
 *    window without a camera. bActive does not gate the view
 *    (ComputerSecurityCameraWindow.UpdateCameraStatus only labels it).
 *  - The window: ViewportWindow Init's fov 90 (SetFOVAngle is called only by the
 *    zoom slider), SetSize(200, 150), SetViewportActor(camera) without eye level;
 *    Draw takes the camera's Location and Rotation (it is not a Pawn).
 *  - SecurityCamera.Tick swings the yaw as origRot.Yaw + Sin(2 pi t / swingPeriod)
 *    * swingAngle when bSwing (and not tracking the player); this samples the
 *    swing at 16 equal steps of its phase (9 distinct yaws, weighted by the time
 *    spent at each). CheckPlayerVisibility (not bNoAlarm, the player within
 *    cameraRange and cameraFOV of the camera's Rotation, a clear trace) turns the
 *    camera toward JC: flagged as `tracks`.
 *  - Computers.userList[8] is `sUserInfo {userName, password, accessLevel}`:
 *    the first entry is the login of the capture command.
 *
 * What the view holds, with Play's own machinery where there is one:
 *  - Mirror and sky: URender::OccludeBsp in the Rust core (bsp-occlusion.mjs,
 *    the camera pass's call: CreateMasterFrame on a 1280x720 viewport, the
 *    render pass's ComputeRenderSize on the 200x150 rectangle, options
 *    SHOW_PLAYER_CTRL|SHINY_SURFACES, the child frames), with the moving brush
 *    tracker holding every mover at its map placement and every zone's SkyZone
 *    from LinkToSkybox (the last SkyZoneInfo, then the last whose bHighDetail is
 *    Level.bHighDetailMode, taken as True as Play's startup reads it). A child
 *    frame's span is the pixels it covers in the window.
 *  - Fog: Play's rule (fog-pass.mjs): a light-mapped surface drawn in a bFogZone
 *    zone, every VolumeRadius > 0 light linked to it; a texel's value is the fog
 *    loop's density integral over the eye segment's chord through the sphere
 *    R = (VolumeRadius + 1) * 25, times VolumeBrightness * brightness / 64
 *    (volumetric-fog.md; brightness taken as LightBrightness / 255, which the
 *    note does not define: an assumption of scale), here in doubles: `fog` counts the pixels at 2/255 or
 *    more, `fogStrong` at 0.1 or more. Measured on a ray grid (every 4th pixel)
 *    with ray.mjs traceRay over the tracked model: approximate (rays pass
 *    non-solid surfaces, a pixel is its ray's hit, no colour table).
 *  - Coronas: DrawFrame's corona pass in a camera frame visits the lights of the
 *    *player's* leaf (the viewport actor's Region.iLeaf: FLeaf.iPermeating into
 *    Model.Lights, and the leaf's moving lights), then checks the line from the
 *    camera frame's origin (TRACE_Level|TRACE_Movers clear, then
 *    TRACE_Pawns|TRACE_Others clear or hitting the player) and draws at z > 1
 *    (coronas.md). JC stands where terminalProbe `front` puts him (56 units along
 *    the computer's yaw), on the floor below (a trace down plus JCDentonMale's
 *    CollisionHeight). The moving-light list (LeafLights) is not built here: a map
 *    whose corona lights are moving-light candidates is flagged. The actor check
 *    takes the map's bCollideActors actors at their placement (primitive-
 *    collision.mjs primitiveLineCheck).
 *  - Confounders, approximate: pawns, movers and moving devices whose Location
 *    is in the frustum (the collision radius added) with a clear line; ray-grid
 *    pixels whose surface has a procedural or animated texture (FireTexture,
 *    WaterTexture and its subclasses, ScriptedTexture, AnimNext), or that a
 *    noise-driven light reaches (Flicker, TorchWaver, FireWaver, WateryShimmer:
 *    light-effects.md, the appFrand stream the programs do not share), or another
 *    time-varying light (matched at a held phase).
 *
 *   node scripts/census-camera-views.mjs [--text] [--maps A,B] [--step 4]
 *   node scripts/census-camera-views.mjs --maps M --probe x,y,z:pitch,yaw,roll [--player x,y,z]
 *     (one camera pose of the caller's choosing, for checking the pipeline against known views)
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { readObject, nameAt } from '../src/unreal/objects.mjs';
import { Reader } from '../src/unreal/package.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { pointZone } from '../src/unreal/lighting.mjs';
import { pointRegion } from '../src/runtime/zone.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { primitiveLineCheck } from '../src/runtime/primitive-collision.mjs';
import { getAxes } from '../src/runtime/camera.mjs';
import { isMovingLightCandidate } from '../src/runtime/dynamic-lighting.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { surfaceTextureFlags } from './occlusion-request.mjs';
import { gameDirectory } from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const kernel = (await loadScriptVmKernel()).occlusion;

// The camera window (ComputerSecurityCameraWindow, ViewportWindow) and the screen it is captured on (camera-acceptance.mjs).
const WINDOW = [200, 150], VIEWPORT = [1280, 720], FOV = 90;
const TAN_X = Math.tan(FOV * Math.PI / 360), TAN_Y = TAN_X * WINDOW[1] / WINDOW[0];
const STEP = Number(option('step', 4));
const GRID = [Math.floor(WINDOW[0] / STEP), Math.floor(WINDOW[1] / STEP)];
const GRID_PIXELS = GRID[0] * GRID[1], WINDOW_PIXELS = WINDOW[0] * WINDOW[1];
const LIGHT_STEP = 2;                 // the light-reach test runs on every 2nd ray of the grid in each direction
const FRONT = 56;                     // terminalProbe `front`: the player 56 units along the computer's yaw
const MIRRORED = 0x08000000, FAKE_BACKDROP = 0x80, UNLIT = 0x400000, POLY_AUTO_U_PAN = 0x200, POLY_AUTO_V_PAN = 0x400;
// LightType / LightEffect values whose output follows the shared appFrand noise (light-effects.md "Matched captures").
const NOISE_TYPES = new Set([4]), NOISE_EFFECTS = new Set([1, 2, 3]);
// Other time-varying ones (they match at a held phase): Pulse, Blink, Strobe, SubtlePulse, texture palette; the spatial effects that move.
const PHASE_TYPES = new Set([2, 3, 5, 7, 8, 9]), PHASE_EFFECTS = new Set([4, 5, 6, 7, 9, 10, 11, 16, 18]);
const TYPES = ['None', 'Steady', 'Pulse', 'Blink', 'Flicker', 'Strobe', 'BackdropLight', 'SubtlePulse', 'TexturePaletteOnce', 'TexturePaletteLoop'];
const EFFECTS = ['None', 'TorchWaver', 'FireWaver', 'WateryShimmer', 'Searchlight', 'SlowWave', 'FastWave', 'CloudCast', 'StaticSpot',
  'Shock', 'Disco', 'Warp', 'Spotlight', 'NonIncidence', 'Shell', 'OmniBumpMap', 'Interference', 'Cylinder', 'Rotor', 'Unused'];
const ANIMATED_TEXTURE_CLASSES = /^(FireTexture|WaterTexture|WaveTexture|WetTexture|IceTexture|FractalTexture|ScriptedTexture)$/;

const f32 = Math.fround;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;
const lowerName = v => (v == null ? '' : String(v)).toLowerCase();

/** sViewInfo / sUserInfo from a tagged struct property's bytes (UStruct::SerializeBin: FString, compact name indices, a byte). */
function readViewInfo(pkg, data) {
  const r = new Reader(data), titleString = r.string(pkg.version), tag = () => { const n = nameAt(pkg, r.compact()); return n === 'None' ? '' : n; };
  return { titleString, cameraTag: tag(), turretTag: tag(), doorTag: tag() };
}
function readUserInfo(pkg, data) {
  const r = new Reader(data);
  return { userName: r.string(pkg.version), password: r.string(pkg.version), accessLevel: r.u8() };
}

/** One volumetric light's fog-map value for a texel (volumetric-fog.md "Fog loop": the sign and miss tests, the chord between
 * the texel and the eye within the sphere, the density integral, the brightness B), in doubles: an estimate of what the
 * 24-bit fog loop gives before the 7-bit colour table. */
function fogValue(eye, point, light) {
  const P = sub(point, eye), L = sub(light.location, eye), LL = dot(L, L), d = dot(P, L), PP = dot(P, P), R2 = light.radius ** 2;
  if (LL >= R2 && d < 0) return 0;
  const h2 = LL - d * d / PP;
  if (R2 < h2) return 0;
  const p = Math.sqrt(PP), w = Math.sqrt(R2 - h2), t = d / p;
  const far = Math.min(t, w), near = Math.max(t - p, -w);
  if (near >= far) return 0;
  const c = 3 - 3 * h2 / R2, a = far / light.radius, b = near / light.radius;
  return Math.min(1, Math.max(0, (a * (c - a * a) - b * (c - b * b)) * light.brightness));
}

/** The camera-space point (forward, right, up) and whether a sphere at `p` of radius `r` overlaps the window's frustum. */
function inFrustum(eye, axes, p, r = 0) {
  const d = sub(p, eye), x = dot(d, axes[0]), y = dot(d, axes[1]), z = dot(d, axes[2]);
  const kx = Math.hypot(1, TAN_X), ky = Math.hypot(1, TAN_Y);
  return { x, y, z, inside: x > -r && Math.abs(y) - x * TAN_X <= r * kx && Math.abs(z) - x * TAN_Y <= r * ky };
}

async function census(mapName, probe = null) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const actors = [];
  for (const a of map.actors) {
    let values, lineage;
    try { values = await defaults.forActor(asset, a); lineage = await defaults.lineage(asset, asset.pkg.exports[a.index - 1].classIndex); }
    catch { continue; }
    actors.push({ ...a, values, lineage, location: values.Location ?? [0, 0, 0] });
  }
  const is = (a, cls) => a.lineage.includes(cls);
  const computers = actors.filter(a => is(a, 'deusex.computersecurity'));
  if (!computers.length && !probe) return null;
  const byIndex = new Map(actors.map(a => [a.index, a]));
  const levelInfo = actors.find(a => is(a, 'engine.levelinfo'));
  const zoneActors = model.zones.map(z => (z.actor > 0 ? byIndex.get(z.actor) ?? null : null));
  const zoneValues = i => (zoneActors[i] ?? levelInfo)?.values ?? {};
  const fogZone = model.zones.map((_, i) => Boolean(zoneValues(i).bFogZone));

  // LinkToSkybox: every zone's SkyZone.
  const skies = actors.filter(a => is(a, 'engine.skyzoneinfo'));
  const skyActor = skies.filter(a => a.values.bHighDetail).at(-1) ?? skies.at(-1) ?? null;
  const sky = skyActor ? { location: skyActor.location.map(f32), rotation: (skyActor.values.Rotation ?? [0, 0, 0]).map(v => v | 0),
    zone: pointZone(model, skyActor.location) } : null;

  // OccludeBsp with the movers at their placement.
  const textureFlags = await surfaceTextureFlags(assets, asset, model);
  const movers = await collectTrackerMovers(assets, asset, map);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
    rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: textureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: specs.length ? { movers: specs } : null });
  try {
    if (occlusion.tracker && occlusion.tracker.construct({ pc64: true }) !== 0) throw new Error(`${mapName}: tracker construction failed`);
    occlusion.setZoneSkies(model.zones.map(() => sky));
    const lineModel = occlusion.lineModel();
    // A surface's PolyFlags as OccludeBsp reads them (its own and its texture's word), level or tracker surface.
    const surfFlags = iSurf => { const u = new Uint32Array(kernel.memory.buffer), o = (occlusion.blocks.surfs >>> 2) + 2 * iSurf; return (u[o] | u[o + 1]) >>> 0; };
    const surfName = iSurf => {
      const owner = occlusion.tracker?.surfOwner(iSurf);
      return owner ? `${movers[owner.tag - 0x40000000].name}:${owner.ordinal}` : `surf ${iSurf}`;
    };
    const surfTexture = iSurf => {
      const owner = occlusion.tracker?.surfOwner(iSurf);
      return owner ? movers[owner.tag - 0x40000000].polys[owner.ordinal]?.texture : model.surfaces[iSurf]?.texture;
    };
    const lightMapped = iSurf => {
      const owner = occlusion.tracker?.surfOwner(iSurf);
      return !(surfFlags(iSurf) & UNLIT) && (owner ? true : (model.surfaces[iSurf]?.lightMap ?? -1) >= 0);
    };
    const textureKind = new Map();
    const animatedTexture = async ref => {
      if (!ref) return null;
      if (!textureKind.has(ref)) {
        let kind = null;
        try {
          const object = await assets.resolve(asset, ref), cls = object.asset.pkg.exports[object.index - 1].className;
          const values = readTexture(object.asset, object.index).values;
          kind = ANIMATED_TEXTURE_CLASSES.test(cls) ? cls : values.AnimNext ? `AnimNext ${object.asset.pkg.exports[object.index - 1].name}` : null;
          if (kind && kind === cls) kind = `${cls} ${object.asset.pkg.exports[object.index - 1].name}`;
        } catch { kind = null; }
        textureKind.set(ref, kind);
      }
      return textureKind.get(ref);
    };

    // Lights by role.
    const lit = actors.filter(a => a.values.LightType && a.values.LightBrightness);
    const volumetric = lit.filter(a => (a.values.VolumeRadius ?? 0) > 0).map(a => ({ name: a.name, location: a.location,
      radius: ((a.values.VolumeRadius ?? 0) + 1) * 25, brightness: (a.values.VolumeBrightness ?? 0) * (a.values.LightBrightness ?? 0) / 255 / 64,
      volumeBrightness: a.values.VolumeBrightness ?? 0, volumeFog: a.values.VolumeFog ?? 0,
      type: TYPES[a.values.LightType] ?? a.values.LightType, effect: EFFECTS[a.values.LightEffect ?? 0], class: a.lineage[0] }));
    const varying = lit.filter(a => NOISE_TYPES.has(a.values.LightType) || NOISE_EFFECTS.has(a.values.LightEffect ?? 0)
      || PHASE_TYPES.has(a.values.LightType) || PHASE_EFFECTS.has(a.values.LightEffect ?? 0)).map(a => ({ name: a.name, location: a.location,
      radius: ((a.values.LightRadius ?? 0) + 1) * 25, noise: NOISE_TYPES.has(a.values.LightType) || NOISE_EFFECTS.has(a.values.LightEffect ?? 0),
      kind: `${TYPES[a.values.LightType] ?? a.values.LightType}/${EFFECTS[a.values.LightEffect ?? 0]}` }));
    const coronaLights = actors.filter(a => a.values.bCorona && a.values.Skin);
    const movingCoronas = coronaLights.filter(a => isMovingLightCandidate(a.values)).map(a => a.name);
    // TRACE_Pawns|TRACE_Others: bCollideActors actors that are not LevelInfo, ZoneInfo or Mover (line-filter.mjs).
    const blockers = actors.filter(a => a.values.bCollideActors && !is(a, 'engine.zoneinfo') && !is(a, 'engine.mover') && !is(a, 'engine.brush'))
      .map(a => ({ name: a.name, location: a.location, radius: a.values.CollisionRadius ?? 0, height: a.values.CollisionHeight ?? 0 }));
    const lineClear = (from, to) => traceRay(lineModel, from.map(f32), to.map(f32)) === null;
    const actorBlock = (from, to, except) => blockers.find(b => b.name !== except && !primitiveLineCheck(b, from, to).outside)?.name ?? null;
    // Moving content placed in the level.
    // (Engine.Camera, a PlayerPawn placed as a level viewpoint, is not a moving pawn.)
    const moving = actors.filter(a => (is(a, 'engine.pawn') && !is(a, 'engine.camera')) || is(a, 'engine.mover') || (a.values.Physics === 5 && a.values.RotationRate?.some(Boolean))
      || a.lineage.some(c => /generator|securitycamera|autoturret|lasertrigger|beamtrigger|fan\d|rotating/.test(c)))
      .map(a => ({ name: is(a, 'engine.pawn') && a.values.Orders ? `${a.name}(${a.values.Orders})` : a.name,
        kind: is(a, 'engine.pawn') ? 'pawn' : is(a, 'engine.mover') ? 'mover' : a.lineage[0].replace(/^deusex\./, ''),
        location: is(a, 'engine.mover') ? a.location : a.location, radius: Math.max(a.values.CollisionRadius ?? 0, 16), hidden: Boolean(a.values.bHidden),
        pawn: is(a, 'engine.pawn') }));

    // JC's spot at a computer and the lights the corona pass would list for it.
    const jc = await defaults.get(await assets.get('DeusEx'), (await assets.get('DeusEx')).pkg.exports.findIndex(e => e.className === 'Class' && e.name === 'JCDentonMale') + 1);
    const playerSpot = (computer, placed = null) => {
      const yaw = (computer?.values.Rotation?.[1] ?? 0) * Math.PI / 32768, at = placed ?? computer.location;
      const front = placed ?? [at[0] + Math.cos(yaw) * FRONT, at[1] + Math.sin(yaw) * FRONT, at[2]];
      const floor = placed ? null : traceRay(model, front.map(f32), [front[0], front[1], front[2] - 1024].map(f32));
      const location = floor ? [front[0], front[1], floor.location[2] + (jc.CollisionHeight ?? 0)] : front;
      const region = pointRegion(model, location, levelInfo, zoneActors, model.zones.length);
      const leafLights = [];
      const permeating = region.leaf >= 0 ? model.leaves[region.leaf]?.permeating ?? -1 : -1;
      if (permeating >= 0) for (let i = permeating; model.lights[i]; i++) leafLights.push(model.lights[i]);
      return { location: location.map(v => round(v)), leaf: region.leaf, zone: region.zoneNumber, frontLeaf: pointRegion(model, front, levelInfo, zoneActors).leaf,
        lights: leafLights.map(i => byIndex.get(i)).filter(Boolean) };
    };

    let frameCounter = 0;
    const analyse = async (camera, spot, rotation) => {
      const eye = camera.location.map(f32), axes = getAxes(rotation);
      // OccludeBsp as the camera pass calls it.
      const built = occlusion.master({ location: eye, rotation, width: VIEWPORT[0], height: VIEWPORT[1], fov: FOV, render: { width: WINDOW[0], height: WINDOW[1] } });
      const words = [...built.frame];
      words[44] = ++frameCounter; words[45] = 0; words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES; words[47] = 0;
      const r = occlusion.run(words, [], { skipPoints: true, skipSpritePixels: true, children: { fov: FOV, orthoZoom: 0 } });
      const area = span => span.lines.reduce((n, line) => n + line.reduce((m, [a, b]) => m + Math.max(0, b - a), 0), 0);
      const mirrors = r.frames.filter(fr => fr.kind === 'mirror').map(fr => ({ surface: surfName(occlusion.nodeSurf(fr.iNode)), pixels: area(fr.span), depth: fr.recursion, parent: fr.parent }));
      const skyFrames = r.frames.filter(fr => fr.kind === 'sky').map(fr => ({ pixels: area(fr.span), parent: fr.parent }));
      const drawn = new Set(), fogDraws = new Set(), animated = new Map();
      for (const frame of [r, ...r.frames]) for (const list of frame.draw) for (const d of list) {
        drawn.add(d.iSurf);
        if (fogZone[d.iZone] && lightMapped(d.iSurf)) fogDraws.add(d.iSurf);
      }
      let panned = 0;
      for (const iSurf of drawn) {
        const kind = await animatedTexture(surfTexture(iSurf));
        if (kind) animated.set(kind, (animated.get(kind) ?? 0) + 1);
        if (surfFlags(iSurf) & (POLY_AUTO_U_PAN | POLY_AUTO_V_PAN)) panned++;
      }
      // The ray grid.
      const grid = { mirror: 0, sky: 0, fog: 0, fogStrong: 0, fogSaturated: 0, noiseLight: 0, phaseLight: 0, animated: 0, miss: 0 };
      const fogLights = new Set(), noiseLights = new Set(), phaseLights = new Set();
      let fogMax = 0;
      // The time-varying lights whose sphere overlaps the window's frustum.
      const reach = varying.filter(light => inFrustum(eye, axes, light.location, light.radius).inside);
      for (let gy = 0; gy < GRID[1]; gy++) for (let gx = 0; gx < GRID[0]; gx++) {
        const sx = ((gx + 0.5) * STEP - WINDOW[0] / 2) / (WINDOW[0] / 2) * TAN_X, sy = (WINDOW[1] / 2 - (gy + 0.5) * STEP) / (WINDOW[0] / 2) * TAN_X;
        const raw = [0, 1, 2].map(k => axes[0][k] + sx * axes[1][k] + sy * axes[2][k]), n = len(raw), dir = raw.map(v => v / n);
        const far = eye.map((v, k) => v + dir[k] * 32768);
        const hit = traceRay(lineModel, eye, far.map(f32));
        if (!hit) { grid.miss++; continue; }
        const iSurf = occlusion.nodeSurf(hit.node), flags = surfFlags(iSurf);
        if (flags & MIRRORED) grid.mirror++;
        if (flags & FAKE_BACKDROP) grid.sky++;
        const hitKind = await animatedTexture(surfTexture(iSurf));
        if (hitKind) { grid.animated++; if (!animated.has(hitKind)) animated.set(hitKind, 1); }
        const before = hit.location.map((v, k) => v - dir[k] * 2);
        if (fogZone[pointZone(model, before)] && lightMapped(iSurf)) {
          let value = 0;
          for (const light of volumetric) { const v = fogValue(eye, hit.location, light); if (v > 0) fogLights.add(light.name); value += v; }
          value = Math.min(1, value);
          // Visible: at least 2 of 255 in the light's brightest channel; strong: a tenth of full.
          if (value * 255 >= 2) grid.fog++;
          if (value >= 0.1) grid.fogStrong++;
          if (value >= 0.99) grid.fogSaturated++;
          fogMax = Math.max(fogMax, value);
        }
        // A time-varying light reaches the texel: within its radius, in front of the surface, nothing of the level between
        // (class 1 lights are recomputed with their shadows). Every LIGHT_STEP-th ray only; counted for that ray's block.
        if (gx % LIGHT_STEP || gy % LIGHT_STEP) continue;
        let noise = false, phase = false;
        const normal = hit.normal ?? [0, 0, 0];
        for (const light of reach) {
          const d = sub(light.location, before);
          if (len(d) >= light.radius || dot(d, normal) <= 0 || (light.noise ? noise : phase)) continue;
          if (traceRay(lineModel, light.location.map(f32), before.map(f32)) !== null) continue;
          if (light.noise) { noise = true; noiseLights.add(light.name); } else { phase = true; phaseLights.add(light.name); }
        }
        if (noise) grid.noiseLight += LIGHT_STEP * LIGHT_STEP;
        if (phase) grid.phaseLight += LIGHT_STEP * LIGHT_STEP;
      }
      // Coronas: the player's leaf's lights, the camera origin's lines, z > 1, the icon on the window.
      const coronas = [], coronasElsewhere = [];
      const icon = light => {
        const c = inFrustum(eye, axes, light.location);
        if (c.x <= 1) return null;
        const size = f32(WINDOW[0] * (light.values.DrawScale ?? 1) * 0.2), x = (WINDOW[0] / 2) / TAN_X * c.y / c.x + WINDOW[0] / 2,
          y = WINDOW[1] / 2 - (WINDOW[0] / 2) / TAN_X * c.z / c.x;
        if (x + size / 2 < 0 || x - size / 2 > WINDOW[0] || y + size / 2 < 0 || y - size / 2 > WINDOW[1]) return null;
        return { x: round(x), y: round(y), size: round(size), distance: round(c.x) };
      };
      const listed = new Set(spot.lights.map(l => l.name));
      for (const light of coronaLights) {
        const at = icon(light);
        if (!at || !lineClear(eye, light.location)) continue;
        const blocked = actorBlock(eye, light.location, camera.name);
        const row = { name: light.name, class: light.lineage[0].replace(/^(deusex|engine)\./, ''), ...at, blockedBy: blocked };
        (listed.has(light.name) ? coronas : coronasElsewhere).push(row);
      }
      // Moving content in the frustum with a clear line.
      const inView = moving.filter(m => m.name !== camera.name && !m.name.startsWith(`${camera.name}(`) && !(m.pawn && m.hidden) && inFrustum(eye, axes, m.location, m.radius).inside
        && len(sub(m.location, eye)) < 8192 && lineClear(eye, m.location)).map(m => `${m.kind}:${m.name}`);
      // Moving content that may show in a mirror: its reflection across a root mirror frame's plane lies in the frustum, the camera
      // and the actor are in front of the plane, and the lines from each to the point where the reflected line crosses the plane are clear.
      const inMirror = new Set();
      for (const fr of r.frames.filter(x => x.kind === 'mirror' && x.parent === 0)) {
        const plane = lineModel.nodes[fr.iNode]?.plane;
        if (!plane) continue;
        const n = plane.slice(0, 3), side = q => dot(n, q) - plane[3], dc = side(eye);
        if (dc <= 0) continue;
        for (const m of moving) {
          if (m.name === camera.name || (m.pawn && m.hidden)) continue;
          const d = side(m.location);
          if (d <= 0) continue;
          const image = m.location.map((v, k) => v - 2 * d * n[k]);
          if (!inFrustum(eye, axes, image, m.radius).inside || len(sub(image, eye)) > 8192) continue;
          const cross = eye.map((v, k) => v + (image[k] - v) * dc / (dc + d)), toward = (q, from) => q.map((v, k) => v + (from[k] - v) * 1e-3);
          if (lineClear(eye, toward(cross, eye)) && lineClear(m.location, toward(cross, m.location))) inMirror.add(`${m.kind}:${m.name}`);
        }
      }
      const px = n => Math.round(n * WINDOW_PIXELS / GRID_PIXELS);
      return { yaw: rotation[1], pitch: rotation[0],
        mirrors, mirrorPixels: mirrors.filter(m => m.parent === 0).reduce((n, m) => n + m.pixels, 0),
        skyPixels: skyFrames.filter(s => s.parent === 0).reduce((n, s) => n + s.pixels, 0), skyInMirror: skyFrames.some(s => s.parent !== 0),
        drawn: drawn.size, fogSurfaces: fogDraws.size, fogMax: round(fogMax, 3),
        grid: { mirror: px(grid.mirror), sky: px(grid.sky), fog: px(grid.fog), fogStrong: px(grid.fogStrong), fogSaturated: px(grid.fogSaturated), noiseLight: px(grid.noiseLight),
          phaseLight: px(grid.phaseLight), animated: px(grid.animated), miss: px(grid.miss) },
        fogLights: [...fogLights], noiseLights: [...noiseLights], phaseLights: [...phaseLights], animatedTextures: Object.fromEntries(animated),
        coronas, coronasElsewhere, inView, inMirror: [...inMirror], panned };
    };

    // The swing: 16 equal phase steps, 9 distinct yaws.
    const swingSamples = camera => {
      const v = camera.values, orig = (v.Rotation ?? [0, 0, 0]).map(x => x | 0);
      if (!v.bSwing) return [{ rotation: orig, weight: 1, offset: 0 }];
      const byYaw = new Map();
      for (let k = 0; k < 16; k++) {
        const offset = Math.trunc(Math.sin(2 * Math.PI * k / 16) * (v.swingAngle ?? 0));
        byYaw.set(offset, (byYaw.get(offset) ?? 0) + 1 / 16);
      }
      return [...byYaw].sort((a, b) => a[0] - b[0]).map(([offset, weight]) => ({ rotation: [orig[0], (orig[1] + offset) | 0, orig[2]], weight, offset }));
    };

    // --probe: one pose of a camera (and of the player) of the caller's choosing, for checking this pipeline against known views.
    if (probe) {
      const camera = { name: 'probe', location: probe.location, values: { Rotation: probe.rotation } };
      const spot = playerSpot(null, probe.player ?? probe.location);
      return { map: mapName, probe: { ...probe, playerLeaf: spot.leaf, playerLeafCoronas: spot.lights.filter(l => l.values.bCorona && l.values.Skin).map(l => l.name),
        ...(await analyse(camera, spot, probe.rotation)) } };
    }
    const rows = [];
    for (const computer of computers) {
      const object = readObject(asset.pkg, asset.bytes, computer.index);
      const views = [0, 1, 2].map(i => {
        const p = object.properties.find(q => q.name === 'Views' && q.arrayIndex === i);
        return p ? readViewInfo(asset.pkg, p.data) : { titleString: '', cameraTag: '', turretTag: '', doorTag: '' };
      });
      const users = object.properties.filter(q => q.name === 'userList').sort((a, b) => a.arrayIndex - b.arrayIndex).map(q => readUserInfo(asset.pkg, q.data))
        .filter(u => u.userName);
      const spot = playerSpot(computer);
      const cameras = [];
      for (const [index, view] of views.entries()) {
        const matches = view.cameraTag ? actors.filter(a => is(a, 'deusex.securitycamera') && lowerName(a.values.Tag) === view.cameraTag.toLowerCase()) : [];
        const camera = matches.at(-1) ?? null;
        const row = { map: mapName, computer: computer.name, computerTag: computer.values.Tag ?? '', view: index, title: view.titleString,
          cameraTag: view.cameraTag, turretTag: view.turretTag, doorTag: view.doorTag, camera: camera?.name ?? null, matches: matches.map(m => m.name),
          users: users.map(u => `${u.userName}/${u.password}`), player: spot.location, playerLeaf: spot.leaf, playerFrontLeaf: spot.frontLeaf,
          playerLeafCoronas: spot.lights.filter(l => l.values.bCorona && l.values.Skin).map(l => l.name) };
        if (camera) {
          const v = camera.values, region = pointRegion(model, camera.location, levelInfo, zoneActors);
          const toPlayer = sub(spot.location, camera.location), distance = len(toPlayer);
          const yawTo = Math.atan2(toPlayer[1], toPlayer[0]) * 32768 / Math.PI, pitchTo = Math.atan2(toPlayer[2], Math.hypot(toPlayer[0], toPlayer[1])) * 32768 / Math.PI;
          const samples = swingSamples(camera);
          const near = (a, b) => { let d = Math.abs(a - b) % 65536; if (d > 32767) d -= 65536; return Math.abs(d); };
          const sees = samples.some(s => near(s.rotation[1], yawTo) < (v.cameraFOV ?? 4096) && near(s.rotation[0], pitchTo) < (v.cameraFOV ?? 4096));
          Object.assign(row, { location: camera.location.map(x => round(x)), rotation: v.Rotation ?? [0, 0, 0], bSwing: Boolean(v.bSwing),
            swingAngle: v.swingAngle, swingPeriod: v.swingPeriod, bActive: Boolean(v.bActive), bNoAlarm: Boolean(v.bNoAlarm),
            cameraZone: region.zoneNumber, cameraLeaf: region.leaf,
            tracks: !v.bNoAlarm && distance <= (v.cameraRange ?? 1024) && sees && lineClear(camera.location, spot.location),
            samples: [] });
          for (const s of samples) row.samples.push({ offset: s.offset, weight: s.weight, ...(await analyse(camera, spot, s.rotation)) });
        }
        cameras.push(row);
        rows.push(row);
      }
    }
    return { map: mapName, sky: skyActor?.name ?? null, fogZones: fogZone.filter(Boolean).length, volumetricLights: volumetric.length,
      coronaLights: coronaLights.length, movingCoronas, movers: movers.length, rows };
  } finally { occlusion.dispose(); }
}

/** A camera's view of one effect over its swing: the pixels at the swing's centre, the least and most, and the share of the swing with any. */
function over(row, value) {
  if (!row.samples?.length) return null;
  const values = row.samples.map(s => ({ v: value(s), w: s.weight, offset: s.offset }));
  const centre = values.find(x => x.offset === 0)?.v ?? values[0].v;
  return { centre, min: Math.min(...values.map(x => x.v)), max: Math.max(...values.map(x => x.v)),
    share: round(values.filter(x => x.v > 0).reduce((n, x) => n + x.w, 0), 2) };
}
const EFFECT_VALUES = {
  mirror: s => s.mirrorPixels,
  sky: s => s.skyPixels,
  fog: s => s.grid.fog,
  corona: s => s.coronas.filter(c => !c.blockedBy).length,
};
function summarise(row) {
  if (!row.samples?.length) return null;
  const effects = Object.fromEntries(Object.entries(EFFECT_VALUES).map(([k, fn]) => [k, over(row, fn)]));
  const union = key => [...new Set(row.samples.flatMap(s => s[key]))];
  const any = fn => Math.max(...row.samples.map(fn));
  return { inMirror: union('inMirror').filter(x => !union('inView').includes(x)), panned: Math.max(...row.samples.map(s => s.panned)), effects, fogStrong: over(row, s => s.grid.fogStrong), fogSaturated: over(row, s => s.grid.fogSaturated), fogMax: Math.max(...row.samples.map(s => s.fogMax)), pawns: union('inView').filter(x => x.startsWith('pawn:')), movingInView: union('inView').filter(x => !x.startsWith('pawn:')),
    noisePixels: any(s => s.grid.noiseLight), phasePixels: any(s => s.grid.phaseLight), animatedPixels: any(s => s.grid.animated),
    animatedTextures: [...new Set(row.samples.flatMap(s => Object.keys(s.animatedTextures)))], fogLights: union('fogLights'),
    noiseLights: union('noiseLights'), phaseLights: union('phaseLights'),
    coronas: [...new Set(row.samples.flatMap(s => s.coronas.map(c => `${c.name}${c.blockedBy ? ` (blocked by ${c.blockedBy})` : ''}`)))],
    coronasElsewhere: [...new Set(row.samples.flatMap(s => s.coronasElsewhere.filter(c => !c.blockedBy).map(c => c.name)))],
    mirrorSurfaces: [...new Set(row.samples.flatMap(s => s.mirrors.map(m => m.surface)))], skyInMirror: row.samples.some(s => s.skyInMirror) };
}

/** How cleanly a camera would test `effect`: the effect in view over the whole swing (or a still camera), large, and nothing that the
 * programs do not share (pawns, noise-driven light, procedural textures) or that moves (movers, devices) in view; other effects count against. */
function score(row, summary, effect) {
  const e = summary.effects[effect];
  if (!e || e.max <= 0) return null;
  const others = Object.keys(EFFECT_VALUES).filter(k => k !== effect && summary.effects[k].max > 0);
  const penalties = [];
  if (e.share < 1) penalties.push(`in view over ${Math.round(e.share * 100)}% of the swing`);
  if (summary.pawns.length) penalties.push(`${summary.pawns.length} pawn(s) in view`);
  if (effect === 'mirror' && summary.inMirror.length) penalties.push(`${summary.inMirror.length} moving actor(s) may show in the mirror`);
  if (summary.noisePixels) penalties.push(`noise-driven light on ${summary.noisePixels} px`);
  if (summary.animatedPixels) penalties.push(`animated textures on ${summary.animatedPixels} px`);
  if (summary.movingInView.length) penalties.push(`${summary.movingInView.length} moving device(s)/mover(s) in view`);
  if (row.tracks) penalties.push('tracks JC at the terminal');
  if (others.length) penalties.push(`also ${others.join(', ')}`);
  const size = effect === 'corona' ? e.min * 1000 : e.min;
  return { penalties, rank: penalties.length * 1e6 - size };
}

const vector = text => text.split(',').map(Number);
if (option('probe', null)) {
  // --probe x,y,z:pitch,yaw,roll [--player x,y,z] --maps M
  const [where, how] = option('probe').split(':'), map = option('maps', '01_NYC_UNATCOIsland').split(',')[0];
  const result = await census(map, { location: vector(where), rotation: vector(how ?? '0,0,0').map(v => v | 0), player: option('player', null) && vector(option('player')) });
  const p = result.probe;
  console.log(JSON.stringify({ map, location: p.location, rotation: p.rotation, player: p.player, playerLeaf: p.playerLeaf, playerLeafCoronas: p.playerLeafCoronas,
    mirrors: p.mirrors, mirrorPixels: p.mirrorPixels, skyPixels: p.skyPixels, skyInMirror: p.skyInMirror, drawn: p.drawn, fogSurfaces: p.fogSurfaces,
    grid: p.grid, fogLights: p.fogLights, coronas: p.coronas, coronasElsewhere: p.coronasElsewhere, inView: p.inView }, null, 1));
  process.exit(0);
}
const selected = option('maps', null)?.split(',');
const maps = (await readdir(path.join(root, 'Maps'))).filter(n => n.toLowerCase().endsWith('.dx') && !/^dxmp_/i.test(n))
  .map(n => path.basename(n, '.dx')).filter(n => !selected || selected.includes(n)).sort();
const results = [];
for (const mapName of maps) {
  const started = Date.now();
  const result = await census(mapName);
  if (result) { results.push(result); process.stderr.write(`${mapName}: ${result.rows.length} views, ${((Date.now() - started) / 1000).toFixed(1)} s\n`); }
}
const rows = results.flatMap(r => r.rows);
const ranking = {};
for (const effect of Object.keys(EFFECT_VALUES)) {
  const seen = new Set();
  ranking[effect] = rows.filter(r => r.samples?.length).map(r => ({ r, s: summarise(r) })).map(({ r, s }) => ({ r, s, k: score(r, s, effect) }))
    .filter(x => x.k).sort((a, b) => a.k.rank - b.k.rank)
    .filter(x => { const key = `${x.r.map}:${x.r.camera}:${x.r.computer}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(({ r, s, k }) => ({ map: r.map, computer: r.computer, view: r.view, title: r.title, camera: r.camera, users: r.users, effect: s.effects[effect],
      penalties: k.penalties, swing: r.bSwing ? `${r.swingAngle}/${r.swingPeriod}s` : 'still' }));
}

if (argv.includes('--text')) {
  const reached = rows.filter(r => r.camera), cameras = new Set(reached.map(r => `${r.map}:${r.camera}`));
  console.log(`${maps.length} maps; ${results.length} with a ComputerSecurity; ${new Set(rows.map(r => `${r.map}:${r.computer}`)).size} terminals, ` +
    `${rows.length} views, ${reached.length} with a camera (${cameras.size} distinct cameras); grid every ${STEP} px (${GRID[0]}x${GRID[1]} rays)`);
  for (const result of results) {
    console.log(`\n== ${result.map}: sky ${result.sky ?? '-'}, ${result.fogZones} fog zones, ${result.volumetricLights} volumetric lights, ` +
      `${result.coronaLights} corona lights${result.movingCoronas.length ? ` (moving: ${result.movingCoronas.join(' ')})` : ''}, ${result.movers} movers`);
    for (const r of result.rows) {
      const head = `${r.computer}[${r.view}] "${r.title}" tag ${r.cameraTag || '-'}`;
      if (!r.camera) { console.log(`  ${head}: no camera${r.cameraTag ? ' (no SecurityCamera has the tag)' : ''}`); continue; }
      const s = summarise(r), e = s.effects, fmt = x => `${x.centre}/${x.min}-${x.max}${x.share < 1 ? ` (${Math.round(x.share * 100)}%)` : ''}`;
      console.log(`  ${head} -> ${r.camera}${r.matches.length > 1 ? ` (last of ${r.matches.join(',')})` : ''} at ${r.location.join(',')} rot ${r.rotation.join(',')} ` +
        `${r.bSwing ? `swing ±${r.swingAngle}/${r.swingPeriod}s` : 'still'}${r.bActive ? '' : ' inactive'}${r.tracks ? ' TRACKS-JC' : ''} zone ${r.cameraZone} leaf ${r.cameraLeaf}; ` +
        `login ${r.users[0] ?? '-'}; JC ${r.player.join(',')} leaf ${r.playerLeaf}`);
      console.log(`    mirror ${fmt(e.mirror)}${s.mirrorSurfaces.length ? ` [${s.mirrorSurfaces.join(' ')}]` : ''}${s.skyInMirror ? ' sky-in-mirror' : ''}; ` +
        `sky ${fmt(e.sky)}; fog ${fmt(e.fog)}${e.fog.max ? ` strong ${fmt(s.fogStrong)} saturated ${fmt(s.fogSaturated)} max ${s.fogMax}` : ''}${s.fogLights.length ? ` [${s.fogLights.join(' ')}]` : ''}; corona ${fmt(e.corona)}${s.coronas.length ? ` [${s.coronas.join(' ')}]` : ''}` +
        `${s.coronasElsewhere.length ? `; coronas not in JC's leaf: ${s.coronasElsewhere.join(' ')}` : ''}`);
      const extra = [s.pawns.length && `pawns ${s.pawns.join(' ')}`, s.inMirror.length && `in a mirror ${s.inMirror.join(' ')}`,
        s.panned && `${s.panned} panned surfaces (level time)`, s.movingInView.length && `moving ${s.movingInView.join(' ')}`,
        s.noisePixels && `noise light ${s.noisePixels} px [${s.noiseLights.join(' ')}]`, s.phasePixels && `phase light ${s.phasePixels} px [${s.phaseLights.join(' ')}]`,
        s.animatedPixels && `animated ${s.animatedPixels} px [${s.animatedTextures.join(', ')}]`].filter(Boolean);
      if (extra.length) console.log(`    ${extra.join('; ')}`);
    }
  }
  for (const [effect, list] of Object.entries(ranking)) {
    console.log(`\n-- ${effect}: ${list.length} camera views (pixels or coronas: centre/min-max, share of the swing)`);
    for (const x of list.slice(0, 15))
      console.log(`  ${x.map} ${x.computer}[${x.view}] ${x.camera} "${x.title}" ${x.swing}: ${x.effect.centre}/${x.effect.min}-${x.effect.max} (${Math.round(x.effect.share * 100)}%)` +
        `${x.penalties.length ? `; ${x.penalties.join('; ')}` : '; clean'}`);
  }
} else console.log(JSON.stringify({ window: WINDOW, viewport: VIEWPORT, fov: FOV, step: STEP, maps: maps.length, results, ranking }, null, 1));
