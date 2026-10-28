import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { readModel, triangulateModel } from '../unreal/model.mjs';
import { buildSurfaceGeometry, POLY, toView, fromView } from '../unreal/geometry.mjs';
import { brushMatrix } from './transforms.mjs';
import { moverGroupMatrix } from './mover-matrix.mjs';
import { createLighting, pointZone } from '../unreal/lighting.mjs';
import { LightAtlas, applyLightAtlas } from './light-atlas.mjs';
import { frameProjection, FRAME_PROJECTION_KEY } from './frame-projection.mjs';
import { readPolys, moverModelFromPolys } from '../unreal/polys.mjs';
import { createMovingLights } from './moving-lights.mjs';
import { createMirrors } from './mirrors.mjs';
import { batchWorldMeshes } from './world-batches.mjs';
import { get as textureFrame, surfacePan } from '../runtime/texture-animation.mjs';
import { ClassDefaults } from '../unreal/classes.mjs';
import { sharedProceduralTextures } from './procedural-textures.mjs';
import { createLightFrame } from '../runtime/static-lighting.mjs';
import { createNativeRng } from '../runtime/rng.mjs';
import { createFogPass } from './fog-pass.mjs';
import { createWorldVisibility } from './world-visibility.mjs';
import { configureSampler } from './original-sampling.mjs';
import { loadScriptVmKernel } from '../runtime/script-vm-kernel.mjs';

/** Whether a light map record's texels meet a frustum, or any of a list of
 * frustums (the main frame's and a ViewportWindow frame's). */
function inFrustum(frustum, record) {
  record.viewSphere ??= texelSphere(record);
  return Array.isArray(frustum) ? frustum.some(each => each.intersectsSphere(record.viewSphere)) : frustum.intersectsSphere(record.viewSphere);
}
const texelBox = new THREE.Box3(), texelPoint = new THREE.Vector3();
/** THREE.Sphere.setFromPoints over a record's texel points in view space (each transform(basis.point(x, y)), in the order the
 * light map stores them), with the same box, centre and radius operations, without keeping a point per texel (docs/live-heap.md,
 * step 1; validate-texel-sphere.mjs compares it with the points the lighting cache used to keep). */
export function texelSphere({ width, height, basis, transform }) {
  const sphere = new THREE.Sphere(), each = visit => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) visit(texelPoint.set(...toView(transform(basis.point(x, y)))));
  };
  texelBox.makeEmpty();
  each(point => texelBox.expandByPoint(point));
  texelBox.getCenter(sphere.center);
  let maxRadiusSq = 0;
  each(point => { maxRadiusSq = Math.max(maxRadiusSq, sphere.center.distanceToSquared(point)); });
  sphere.radius = Math.sqrt(maxRadiusSq);
  return sphere;
}

export async function createWorld(map, asset, assets, onProgress = () => {}, {batchOpaque = true, movingLightsMode} = {}) {
  const root = new THREE.Group(), textures = new TextureStore(assets), textureGPU = new Map(), materials = new Map();
  // Identity, never moved: no auto-update cascade (main.mjs, the scene).
  root.matrixAutoUpdate = false;
  const notes = new Set(), errors = [], textureNames = new Set(), moverGroups = new Map(), rotatedMovers = new Set();
  // The script-VM kernel runs the animated light-map merge (light.rs) and
  // the volumetric fog loop (fog.rs) when it loads.
  let scriptKernel = null;
  try { scriptKernel = await loadScriptVmKernel(); } catch { scriptKernel = null; }
  const lighting = await createLighting(map, asset, assets), lightAtlas = new LightAtlas();
  const movingLights = createMovingLights(lighting, map.model, movingLightsMode ? { mode: movingLightsMode } : undefined);
  lighting.setMovingApplier(movingLights.apply);
  const lightingEnabled = { value: 1 };
  const displayGamma = { value: 1 / 1.5 };
  const mirrors = createMirrors(notes, displayGamma);
  // Volumetric fog maps (docs/volumetric-fog.md); the per-texel loop runs in
  // the Rust core when its kernel loads.
  const fog = createFogPass({ lightAtlas, levelBrightness: lighting.levelBrightness, hsv: lighting.hsv, displayGamma, notes, kernel: scriptKernel });
  const counts = { triangles: 0, degenerate: 0, corrected: 0, movers: 0, surfaces: 0 };
  const flagProperties = { bInvisible: 1, bMasked: 2, bTranslucent: 4, bTwoSided: 256,
    bNoSmooth: 2048, bUnlit: POLY.Unlit, bModulated: POLY.Modulated };

  function gpuTexture(data, flags) {
    const texKey = `${data.key}:${Boolean(flags & POLY.Masked)}:${Boolean(flags & POLY.NoSmooth)}`;
    if (!textureGPU.has(texKey)) {
      const first = data.mips[0];
      const tex = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
      tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const last = data.mips.at(-1), complete = last.width === 1 && last.height === 1;
      if (complete && data.mips.length > 1) tex.mipmaps = data.mips;
      tex.generateMipmaps = !complete;
      configureSampler(tex, Boolean(flags & POLY.NoSmooth));
      tex.needsUpdate = true;
      textureGPU.set(texKey, tex);
    }
    return textureGPU.get(texKey);
  }

  // Animated textures (docs/texture-animation.md): one record per texture
  // object with UTexture::PostLoad's state (Accumulator 0, LastUpdateTime the
  // load-time clock; AnimCur and PrimeCurrent are transient zeros) and its
  // AnimNext record. The clock is the host's (appSeconds is the CPU's
  // timestamp counter; only differences reach the animation).
  const animated = new Map(), animatedHeads = new Set();
  const clock = () => performance.now() / 1000;
  async function animationRecord(data) {
    if (animated.has(data.key)) return animated.get(data.key);
    const v = data.values;
    const record = { key: data.key, data: new Map([[data.masked, data]]), animNext: null,
      primeCount: (v.PrimeCount ?? 0) & 255, minFrameRate: Math.fround(v.MinFrameRate ?? 0), maxFrameRate: Math.fround(v.MaxFrameRate ?? 0),
      animCur: null, primeCurrent: 0, accumulator: 0, lastUpdateTime: clock(), shown: null, uses: [], load: null };
    animated.set(data.key, record);
    if (v.AnimNext) {
      const load = masked => textures.get(data.asset, v.AnimNext, masked);
      const next = await animationRecord(await load(data.masked));
      next.load ??= load;
      record.animNext = next;
    }
    return record;
  }
  // Every frame of the chain as a GPU texture of this material's variant.
  async function animationFrames(head, data, flags) {
    const masked = Boolean(flags & POLY.Masked), frames = new Map();
    for (let frame = head; frame && !frames.has(frame); frame = frame.animNext) {
      let decoded = frame.data.get(masked);
      if (!decoded) { decoded = await frame.load(masked); frame.data.set(masked, decoded); }
      if (decoded.mips[0].width !== data.mips[0].width || decoded.mips[0].height !== data.mips[0].height)
        notes.add(`${decoded.key}: animation frame size differs from ${data.key}; its UVs keep the first frame's scale.`);
      frames.set(frame, gpuTexture(decoded, flags));
    }
    return frames;
  }

  // Zone actors for auto-pan: Model.Zones[i].ZoneActor, else the LevelInfo
  // (GetZoneActor), with class defaults for TexUPanSpeed/TexVPanSpeed.
  const classDefaults = new ClassDefaults(assets), zoneActors = new Map();
  const levelInfoActor = map.actors.find(actor => actor.className === 'LevelInfo') ?? null;
  async function zoneActor(zone) {
    if (zoneActors.has(zone)) return zoneActors.get(zone);
    const ref = map.model.zones?.[zone]?.actor;
    const actor = (ref > 0 && map.actors.find(candidate => candidate.index === ref)) || levelInfoActor;
    const values = actor ? await classDefaults.forActor(asset, actor) : {};
    // ZoneInfo +0x388 bit 1 (bFogZone) gates SetupForSurf's fog map.
    const record = { name: actor?.name ?? null, speeds: [Math.fround(values.TexUPanSpeed ?? 0), Math.fround(values.TexVPanSpeed ?? 0)],
      fog: Boolean(values.bFogZone) };
    zoneActors.set(zone, record);
    return record;
  }
  const panned = [];

  // Render.dll's surface pass draws Level.DefaultTexture (LevelInfo +0x508)
  // for a surface without a texture (docs/texture-animation.md).
  let defaultTexture;
  async function surfaceTexture(surface) {
    if (surface.texture) return { asset, ref: surface.texture };
    if (defaultTexture === undefined) {
      const levelInfo = map.actors.find(actor => actor.className === 'LevelInfo');
      defaultTexture = levelInfo?.values.DefaultTexture ? { asset, ref: levelInfo.values.DefaultTexture }
        : levelInfo ? await classDefaults.objectDefault(asset, asset.pkg.exports[levelInfo.index - 1].classIndex, 'DefaultTexture') : null;
    }
    if (!defaultTexture) throw new Error('Surface without a texture and no Level.DefaultTexture');
    return defaultTexture;
  }

  async function materialFor(surface, tile, mirror, pan = null, mover = false) {
    let flags = surface.flags;
    const source = await surfaceTexture(surface);
    const decoded = await textures.get(source.asset, source.ref, Boolean(flags & POLY.Masked));
    for (const [name, flag] of Object.entries(flagProperties)) if (decoded.values[name]) flags |= flag;
    const data = flags & POLY.Masked && !decoded.masked ? await textures.get(source.asset, source.ref, true) : decoded;
    if (data.procedural && !data.fire && !data.wet) notes.add(`${data.key}: ${data.procedural}. Ripple simulation is not active.`);
    textureNames.add(data.key);
    const key = `${data.key}:${flags}:${tile.page.index}:${mirror?.key ?? ''}${pan ? `:pan:${pan.key}` : ''}${mover ? ':mover' : ''}`;
    if (!materials.has(key)) {
      // A panned material owns its texture objects (shared image data), whose
      // offset carries the pan.
      const own = texture => pan ? Object.assign(texture.clone(), { needsUpdate: true }) : texture;
      // A FireTexture or WetTexture surface draws the page's live texture
      // (docs/fire-texture.md).
      const fire = data.fire || data.wet ? sharedProceduralTextures().acquire(data).texture : null;
      const material = new THREE.MeshBasicMaterial({ map: own(fire ?? gpuTexture(data, flags)),
        side: flags & POLY.TwoSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: flags & POLY.Masked ? .5 : 0 });
      // An opaque mirror draws PF_Invisible after its child frame
      // (mirrors.mjs mirrorDrawFlags): the shader shows the reflection alone.
      applyLightAtlas(material, tile.page, lightingEnabled, displayGamma,
        mirror && { ...mirror, opaque: !(flags & 0x47) },
        !mirror && !(flags & POLY.Translucent) && Boolean(flags & POLY.Modulated), null, mover);
      if (mirror) {
        // The reflected child is composited by the shader, then PF_Occlude
        // writes the mirror's depth. Ordinary translucent surfaces keep their blend.
        material.blending = THREE.NoBlending; material.depthWrite = true;
      } else if (flags & POLY.Translucent) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor;
      } else if (flags & POLY.Modulated) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
      }
      if (mover) {
        // The brush tracker appends a mover polygon coplanar with a level
        // node to the end of that node's coplanar chain (Engine 0x1037bb5d,
        // linked at 0x1037bf66), and OccludeBsp walks a chain in order
        // (Render 0x10b19a53), so the level polygons claim their spans
        // first: a mover polygon loses every coplanar tie. Offsetting its
        // depth away from the eye changes the winner only at equal depth.
        // See mirror-surfaces.md, "Coplanar mover polygons".
        material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1;
      }
      material.userData = { key: data.key, flags, width: data.mips[0].width, height: data.mips[0].height, mipCount: data.mips.length,
        animated: Boolean(fire) };
      if (data.values.AnimNext) {
        // The surface's texture is the chain head; Render draws its Get(Time).
        const head = await animationRecord(data);
        head.data.set(data.masked, data);
        const frames = await animationFrames(head, data, flags);
        if (pan) for (const [frame, texture] of frames) frames.set(frame, own(texture));
        head.uses.push({ material, frames });
        animatedHeads.add(head);
        material.userData.animated = true;
      }
      if (pan) {
        material.userData.animated = true;
        panned.push({ material, surface, zones: await Promise.all(pan.zones.map(zoneActor)), plane: pan.plane,
          width: data.mips[0].width, height: data.mips[0].height, last: null });
      }
      materials.set(key, material);
    }
    return { material: materials.get(key), flags, key };
  }

  async function addModel(model, triangles, parent, actorName = null, matrix = null) {
    await lighting.prepare(model);
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
    const transform = matrix ? p => fromView(new THREE.Vector3(...toView(p)).applyMatrix4(matrix).toArray()) : p => p;
    const transformNormal = normalMatrix ? n => fromView(new THREE.Vector3(...toView(n)).applyMatrix3(normalMatrix).toArray()) : n => n;
    const moverZone = matrix ? pointZone(map.model, transform(model.bounds.min.map((n, i) => (n + model.bounds.max[i]) / 2))) : null;
    const bySurface = new Map();
    for (const t of triangles) {
      const node = model.nodes[t.node], zone = moverZone ?? node.zones[1];
      // An auto-panned surface pans with the zone on the viewer's side of
      // its node (Render.dll's draw-list zone), so both zones are kept.
      const panned = model.surfaces[t.surface].flags & (POLY.AutoUPan | POLY.AutoVPan);
      const zones = panned ? (moverZone === null ? node.zones : [moverZone, moverZone]) : null;
      const key = `${t.surface}:${zone}${zones ? `:${zones[0]}` : ''}`;
      if (!bySurface.has(key)) bySurface.set(key, { surfaceIndex: t.surface, zone, ts: [],
        pan: zones ? { zones, plane: node.plane, key: `${actorName ?? ''}:${key}` } : null });
      bySurface.get(key).ts.push(t);
    }
    const batches = new Map();
    // Fake-backdrop surfaces draw the sky zone's view in their spans, and
    // like every BSP surface they occlude what lies behind them (Render.dll's
    // span buffer): drawn depth-only after the sky pass, so other parts of the
    // level beyond a sky opening stay hidden.
    const backdrop = { [THREE.FrontSide]: [], [THREE.DoubleSide]: [] };
    let done = 0;
    for (const { surfaceIndex, zone, ts, pan } of bySurface.values()) {
      const surface = model.surfaces[surfaceIndex];
      if (surface.flags & POLY.Invisible) continue;
      if (surface.flags & POLY.FakeBackdrop) {
        if (!actorName) backdrop[surface.flags & POLY.TwoSided ? THREE.DoubleSide : THREE.FrontSide]
          .push(...buildSurfaceGeometry(model, ts, surfaceIndex, 1, 1).positions);
        continue;
      }
      try {
        const lightmap = surface.flags & POLY.Unlit ? null : lighting.surface(model, surfaceIndex, zone, transform, transformNormal, actorName);
        const tile = lightAtlas.add(lightmap);
        const mirror = mirrors.surface(model, surfaceIndex, actorName);
        const { material, flags, key } = await materialFor(surface, tile, mirror, pan, Boolean(actorName));
        if (flags & POLY.Invisible) continue;
        const lit = tile.enabled && !(flags & (POLY.Unlit | POLY.Modulated));
        lighting.stats[lit ? 'litSurfaces' : 'unlitSurfaces']++;
        const g = buildSurfaceGeometry(model, ts, surfaceIndex, material.userData.width, material.userData.height);
        counts.degenerate += g.degenerate; counts.corrected += g.corrected;
        if (!g.positions.length) continue;
        if (!batches.has(key)) batches.set(key, { material, mirror, positions: [], normals: [], uvs: [], lightUV: [], lightBounds: [], lightLayer: [], faces: [], nodes: [], tracked: [] });
        const batch = batches.get(key);
        batch.positions.push(...g.positions); batch.normals.push(...g.normals); batch.uvs.push(...g.uvs);
        // A mover's vertices: each one's place among the brush tracker's transformed vertices.
        if (actorName) for (const source of g.sources) batch.tracked.push(model.trackedIndex[source]);
        for (let i = 0; i < g.positions.length; i += 3) {
          batch.lightUV.push(...(lit ? lightAtlas.coordinates(tile, fromView(g.positions.slice(i, i + 3))) : [0, 0, 0]));
          batch.lightBounds.push(...(tile.bounds ?? [0, 0, 1, 1]));
          batch.lightLayer.push(tile.page.index);
        }
        for (let i = 0; i < g.positions.length / 9; i++) batch.faces.push(surfaceIndex);
        // Each triangle's BSP node (world-visibility.mjs).
        batch.nodes.push(...g.nodes);
        counts.triangles += g.positions.length / 9; counts.surfaces++;
        // A level surface in a fog zone; every lit mover polygon of a map
        // with fog zones, whose draw items are gated by their own zones
        // (fog-pass.mjs, the brush tracker).
        if (lightmap && lit && actorName && anyFogZone) {
          fog.addMoverPolygon(lightmap, actorName, surfaceIndex);
        } else if (lightmap && lit && !actorName && (await zoneActor(zone)).fog) {
          const fogUV = [], fogBounds = [];
          for (let i = 0; i < g.positions.length; i += 3) {
            fogUV.push(...lightAtlas.coordinates(tile, fromView(g.positions.slice(i, i + 3))));
            fogBounds.push(...(tile.bounds ?? [0, 0, 1, 1]));
          }
          lightmap.fogGrid ??= () => ({ grid: lighting.gridFor(lightmap) });
          fog.addSurface(lightmap, tile, g.positions, fogUV, fogBounds, surfaceIndex);
        }
      } catch (error) {
        errors.push({ actor: actorName, surface: surfaceIndex, message: error.message });
      }
      if (++done % 100 === 0) { onProgress(`Preparing ${actorName ?? 'world'} surfaces`, done, bySurface.size); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    for (const [side, positions] of Object.entries(backdrop)) {
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      const backdropMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: Number(side) });
      // Depth only, at the depth the world's polygons have (docs/frame-projection.md).
      backdropMaterial.customProgramCacheKey = () => `deus-ex-backdrop:${FRAME_PROJECTION_KEY}`;
      backdropMaterial.onBeforeCompile = shader => frameProjection.patch(shader);
      const mesh = new THREE.Mesh(geometry, backdropMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.userData = { actor: actorName, backdrop: true, model: model.entry.name };
      mesh.renderOrder = -1; // before anything it hides
      parent.add(mesh);
      counts.backdropTriangles = (counts.backdropTriangles ?? 0) + positions.length / 9;
    }
    for (const batch of batches.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
      geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(batch.lightUV, 3));
      geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(batch.lightBounds, 4));
      geometry.setAttribute('lightLayer', new THREE.Float32BufferAttribute(batch.lightLayer, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, batch.material);
      // World-space geometry: an identity local matrix, never moved itself (a
      // mover's group carries the transform and forces its children).
      mesh.matrixAutoUpdate = false;
      mesh.userData = { actor: actorName, faces: batch.faces, nodes: Int32Array.from(batch.nodes), model: model.entry.name };
      if (actorName) {
        // The vertices the original projects (docs/frame-projection.md "Movers"): the brush
        // tracker's points in Unreal's axes. Until the simulation sends them (and without a
        // tracker) the group matrix poses them.
        mesh.userData.tracked = Int32Array.from(batch.tracked);
        geometry.setAttribute('deusTracked', new THREE.BufferAttribute(new Float32Array(batch.positions.length), 3).setUsage(THREE.DynamicDrawUsage));
      }
      parent.add(mesh);
      batch.mirror?.meshes.push(mesh);
    }
  }

  // Each zone's bFogZone (SetupForSurf's gate), for the movers' fog.
  const fogZones = new Uint8Array(Math.max(1, map.model.zones?.length ?? 0));
  for (let zone = 0; zone < fogZones.length; zone++) fogZones[zone] = (await zoneActor(zone)).fog ? 1 : 0;
  const anyFogZone = fogZones.some(Boolean);
  await addModel(map.model, map.triangles, root);
  for (const actor of map.actors) {
    if (!(actor.values.VolumeRadius > 0)) continue;
    fog.addLight(await classDefaults.forActor(asset, actor));
  }
  // A mover is an actor whose class descends from Engine.Mover (the class chain, as IsA follows it), not one whose name ends
  // in "Mover": BreakableGlass and BreakableWall extend DeusExMover and the simulation tracks them as movers.
  const moverActors = [];
  for (const actor of map.actors) {
    if (!(actor.values.Brush > 0)) continue;
    try {
      const lineage = await classDefaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
      if (lineage.includes('engine.mover')) moverActors.push(actor);
    } catch (error) { errors.push({ actor: actor.name, message: error.message }); }
  }
  for (const actor of moverActors) {
    try {
      const rawModel = readModel(asset.pkg, asset.bytes, actor.values.Brush);
      // The brush tracker's surfaces: one per polygon (polys.mjs).
      const { model, triangles } = moverModelFromPolys(rawModel, readPolys(asset.pkg, asset.bytes, rawModel.polygons),
        { specialLit: Boolean((await classDefaults.forActor(asset, actor)).bSpecialLit) });
      const group = new THREE.Group();
      group.matrix.copy(brushMatrix(actor.values)); group.matrixAutoUpdate = false;
      group.userData.baseMatrix = group.matrix.clone(); moverGroups.set(actor.name, group);
      root.add(group);
      await addModel(model, triangles, group, actor.name, group.matrix);
      // The group's and its meshes' world matrices now; syncMovers redoes
      // this on a change (nothing cascades from the root).
      group.updateMatrixWorld(true);
      group.userData.trackedVertices = Math.max(0, ...model.trackedIndex) + 1;
      poseFromMatrix(group);
      counts.movers++;
    } catch (error) { errors.push({ actor: actor.name, message: error.message }); }
  }
  if ((fog.stats.surfaces || fog.stats.moverPolygons) && fog.stats.lights) {
    root.add(fog.root);
    notes.add(`${fog.stats.surfaces} fog-zone surfaces and ${fog.stats.moverPolygons} mover polygons draw volumetric fog from ${fog.stats.lights} volumetric lights each frame. Every light is linked to every fog surface (the original's culls drop only lights that add nothing); volumetric brightness is steady; meshes get no fog (D3D's shipped configuration).`);
  }
  const submissionBatches = batchOpaque ? batchWorldMeshes(root, lightAtlas, lightingEnabled, displayGamma) : null;
  // The main frame's BSP visibility (world-visibility.mjs), after batching.
  const visibility = createWorldVisibility(root, map.model.nodes.length);
  const markerPositions = map.actors.filter(a => a.values.Location && a.className !== 'Brush').flatMap(a => toView(a.values.Location));
  const markerGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(markerPositions, 3));
  const markerMaterial = new THREE.PointsMaterial({ color: '#efc176', size: 5, sizeAttenuation: false, depthTest: false });
  const markers = new THREE.Points(markerGeometry, markerMaterial); markers.visible = false; markers.renderOrder = 100;
  markers.matrixAutoUpdate = false;
  root.add(markers);
  notes.add(`${map.summary.unknownLevelBytes} trailing Level bytes and ${map.summary.undecodedActorProperties} property values remain opaque.`);
  for (const note of lighting.notes) notes.add(note);
  if (mirrors.stats.surfaces) notes.add('Mirrored BSP and mover surfaces render reflected world and actor views. Mirror/sky combinations remain unverified.');
  if (lighting.stats.missingLightmaps) notes.add(`${lighting.stats.missingLightmaps} surfaces have no stored lightmap and retain their base texture brightness.`);
  if (errors.length) notes.add(`${errors.length} surfaces or moving brushes could not be rendered. See diagnostics details.`);
  if (panned.length) notes.add(`${panned.length} auto-panned surface groups follow Level.TimeSeconds and their viewer-side zone's pan speeds.`);
  if (animatedHeads.size) notes.add(`${animatedHeads.size} animated surface textures advance every frame; the original advances only those its BSP occlusion draws.`);
  // Inspect's sky: what LinkToSkybox (ZoneInfo.uc, called for every zone by
  // GameInfo) gives every zone: the last SkyZoneInfo in the Level's Actors
  // order, then the last whose bHighDetail matches Level.bHighDetailMode,
  // taken as True (the value Play's startup reads). Play reads the zones'
  // SkyZone from the running scripts instead.
  const skies = map.actors.filter(a => a.className === 'SkyZoneInfo' && a.values.Location);
  const skyActor = skies.filter(a => a.values.bHighDetail).at(-1) ?? skies.at(-1) ?? null;
  const sky = skyActor?.values.Location ?? null, skyRotation = skyActor?.values.Rotation ?? [0, 0, 0];
  // The appFrand draws of the light noise come from a host stream: the
  // original's position in the process-wide CRT stream is not reproduced.
  // Play hands each frame the simulation's noise (beginLightFrame); a world
  // without a simulation (headless checks) advances its own from this stream.
  const lightFrame = createLightFrame(createNativeRng(0x11647).frand), lightAnimation = { changed: 0 };
  // `simFed`: the simulation supplies every frame's inputs (a display frame
  // without a new simulation frame keeps the last one).
  let lightFrameBegun = false, simFed = false;
  if (lighting.animatedRecords().length) notes.add(`${lighting.animatedRecords().length} light maps carry animated lights (pulse, flicker, strobe, torch/fire/watery waver, the time-varying spatial effects), merged each frame; in Play their noise comes from the simulation's shared appFrand stream (a world without one draws from a host stream).`);
  function updateLighting(changes) {
    const update = lighting.invalidate(changes);
    for (const lightmap of update.lightmaps) lightAtlas.update(lightmap, { partial: true });
    return { ...update, uploaded: update.lightmaps.length };
  }
  const moverMatrix = new THREE.Matrix4();
  // The vertices a mover's meshes project (docs/frame-projection.md "Movers"),
  // in Unreal's axes: the brush tracker's points once the simulation sends
  // them (`setMoverPoints`), else the group matrix's product with the rest
  // positions. `trackedMovers`: the simulation runs the tracker, so a matrix
  // change waits for its points instead of posing the vertices itself.
  let trackedMovers = false, trackerVertices = true;
  const lastMoverPoints = new Map();
  function applyMoverPoints(name, points) {
    const group = moverGroups.get(name);
    if (!group || points.length !== 3 * group.userData.trackedVertices) return;
    for (const mesh of group.children) {
      const attribute = mesh.geometry?.getAttribute('deusTracked');
      if (!attribute || !mesh.userData.tracked) continue;
      const index = mesh.userData.tracked, out = attribute.array;
      for (let v = 0; v < index.length; v++) {
        const at = 3 * index[v];
        out[3 * v] = points[at]; out[3 * v + 1] = points[at + 1]; out[3 * v + 2] = points[at + 2];
      }
      attribute.needsUpdate = true;
    }
  }
  function poseFromMatrix(group) {
    for (const mesh of group.children) {
      const attribute = mesh.geometry?.getAttribute('deusTracked');
      if (!attribute) continue;
      const m = Float32Array.from(mesh.matrixWorld.elements), p = mesh.geometry.getAttribute('position').array, out = attribute.array;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        // Three's axes [y, z, -x] of Unreal's.
        out[i] = -(m[2] * x + m[6] * y + m[10] * z + m[14]); out[i + 1] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 2] = m[1] * x + m[5] * y + m[9] * z + m[13];
      }
      attribute.needsUpdate = true;
    }
  }
  const world = { /** Validation access: the light maps (unreal/lighting.mjs); `lighting` below is their statistics. */ lightMaps: lighting, root, markers, counts, textures: textureNames.size, materials, mirrors, fog, submissionBatches, notes: [...notes], errors, sky, skyRotation,
    visibility,
    /** Whether a zone's actor (or the LevelInfo) is bFogZone. */
    fogZone: zone => Boolean(fogZones[zone]),
    /** BSP node → surface index of the world model (bsp-occlusion.mjs results). */
    nodeSurface: Int32Array.from(map.model.nodes, node => node.surface),
    /** Each mover group's brush matrix; a changed one updates its own and
     * its meshes' world matrices at once. A flag alone is not enough: a
     * mesh's updateWorldMatrix(true, false) (mirrors.mjs) recomputes the
     * flagged group and clears its flag without updating the group's other
     * children. `movers` are the simulation's mover states
     * (sim-session.mjs): name, the static brush values, position, rotation
     * (null when unset) and the collider offset. */
    syncMovers(movers) {
      for (const mover of movers) {
        const group = moverGroups.get(mover.name); if (!group) continue;
        if (moverGroupMatrix(mover, group.userData.baseMatrix, moverMatrix) && !rotatedMovers.has(mover.name)) {
          rotatedMovers.add(mover.name);
          const note = 'Moving lights on a rotated mover use its authored orientation; only its translation reaches them.';
          if (!notes.has(note)) { notes.add(note); world.notes.push(note); }
        }
        if (moverMatrix.elements.every((value, i) => Object.is(value, group.matrix.elements[i]))) continue;
        group.matrix.copy(moverMatrix);
        group.updateMatrixWorld(true);
        if (!trackedMovers || !trackerVertices) poseFromMatrix(group);
      }
    },
    /** Validation (main.mjs moverVertexProbe): for each `{name, points}` mover, how many mesh vertices
     * hold exactly the tracker's point (as float bits), the largest distance of a vertex from the group
     * matrix's product with its rest position, and the number of vertices. */
    moverVertices(movers) {
      const f = new Float32Array(1), u = new Uint32Array(f.buffer), bits = v => (f[0] = v, u[0]);
      return movers.map(({ name, points }) => {
        const group = moverGroups.get(name), out = { name, vertices: 0, equal: 0, maxMatrixDistance: 0, meshes: 0 };
        if (!group) return out;
        for (const mesh of group.children) {
          const attribute = mesh.geometry?.getAttribute('deusTracked');
          if (!attribute || !mesh.userData.tracked) continue;
          out.meshes++;
          const index = mesh.userData.tracked, a = attribute.array, p = mesh.geometry.getAttribute('position').array, m = mesh.matrixWorld.elements;
          for (let v = 0; v < index.length; v++) {
            out.vertices++;
            const at = 3 * index[v];
            if (bits(a[3 * v]) === bits(points[at]) && bits(a[3 * v + 1]) === bits(points[at + 1]) && bits(a[3 * v + 2]) === bits(points[at + 2])) out.equal++;
            const x = p[3 * v], y = p[3 * v + 1], z = p[3 * v + 2];
            const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
            out.maxMatrixDistance = Math.max(out.maxMatrixDistance, Math.hypot(-wz - a[3 * v], wx - a[3 * v + 1], wy - a[3 * v + 2]));
          }
        }
        return out;
      });
    },
    /** The brush tracker's transformed vertices of the movers it rebuilt
     * (sim-session.mjs `visibility().moverPoints`: mover name -> flat
     * Float32Array in the brush polygons' vertex order, Unreal's axes). The
     * meshes project them with the frame's vertex chain. */
    setMoverPoints(update) {
      trackedMovers = true;
      for (const [name, points] of Object.entries(update ?? {})) {
        lastMoverPoints.set(name, points);
        if (trackerVertices) applyMoverPoints(name, points);
      }
    },
    /** ?moverVertices=matrix (and deusExViewer.moverVertices(false)): the movers' meshes keep the group matrix's product with the rest positions, as before the tracker's points. */
    useTrackerVertices(on) {
      trackerVertices = Boolean(on);
      for (const [name, group] of moverGroups) {
        if (trackerVertices) { const points = lastMoverPoints.get(name); if (points) applyMoverPoints(name, points); }
        else poseFromMatrix(group);
      }
    },
    updateLighting,
    /** What the simulation side needs to know which brush meshes each pass
     * draws (drawn-set.mjs): each mover group's authored matrix and its
     * meshes' bounding spheres (identity local matrices), and each mirror
     * plane with its meshes' bounds and positions. Static for the map. */
    stampScene() {
      const ownerOf = new Map([...moverGroups].map(([name, group]) => [group, name]));
      const meshData = mesh => ({ actor: mesh.userData.actor ?? null, visible: mesh.visible,
        matrix: [...mesh.matrix.elements], sphere: [...mesh.geometry.boundingSphere.center.toArray(), mesh.geometry.boundingSphere.radius],
        positions: mesh.geometry.getAttribute('position').array.slice(), owner: ownerOf.get(mesh.parent) ?? null });
      return {
        root: [...root.matrixWorld.elements],
        movers: [...moverGroups].map(([name, group]) => ({ name, base: [...group.userData.baseMatrix.elements],
          meshes: group.children.filter(child => child.isMesh && child.userData.actor).map(mesh => ({ ...meshData(mesh), positions: null })) })),
        mirrors: mirrors.groups().map(group => ({ key: group.key, moving: group.moving,
          plane: { normal: group.plane.normal.toArray(), constant: group.plane.constant },
          localPlane: group.localPlane ? { normal: group.localPlane.normal.toArray(), constant: group.localPlane.constant } : null,
          meshes: group.meshes.map(meshData),
          // The world BSP nodes of a static group's polygons: OccludeBsp's
          // mirror child requests name one of them.
          nodes: group.moving ? null : [...new Set(group.meshes.flatMap(mesh => mesh.userData.actor ? [] : [...(mesh.userData.nodes ?? [])]))] })),
      };
    },
    /** The frame's light animation inputs from the simulation
     * (sim-session.mjs `frame.light`: Level.TimeSeconds, the noise
     * URender::PreRender advanced from the shared stream and the frame's
     * Strobe flag), before the frame's moving lights and texture animation
     * use them. */
    beginLightFrame({ timeSeconds, noise, strobe = null }) {
      lightFrame.advance(timeSeconds, noise);
      // The simulation decides the frame's Strobe flag (light-globals.mjs):
      // with the frame's own time stored, the page's Strobe calls keep it.
      if (strobe) { lightFrame.strobe.time = Math.fround(timeSeconds); lightFrame.strobe.flag = strobe.flag; }
      lightFrameBegun = simFed = true;
      return lightFrame;
    },
    /** Play's per-frame moving lights (game.movingLights()) over the current
     * mover offsets, with this frame's light animation inputs when
     * beginLightFrame supplied them; with `drawn` (the level surfaces
     * OccludeBsp's frame draws) or a `frustum`, the light maps not drawn
     * wait. Changed tiles upload on the next flushLighting. */
    syncMovingLights(lights, movers = [], { frustum = null, drawn = null } = {}) {
      // `frustum` may be a list (the main frame's and a ViewportWindow
      // frame's): a light map in any of them is drawn.
      const offsets = new Map(movers.map(mover => [mover.name, mover.offset]));
      // The drawn light maps, as for the light animation below.
      const visible = drawn ? record => record.owner || drawn.has(record.surfaceIndex)
        : frustum ? record => record.owner || inFrustum(frustum, record) : null;
      // With OccludeBsp's drawn surfaces the drawn light maps are listed
      // (brush light maps are always drawn).
      const drawnRecords = drawn ? [...lighting.ownedRecords()] : null;
      if (drawn) for (const surfaceIndex of drawn) for (const record of lighting.recordsFor(map.model, surfaceIndex)) drawnRecords.push(record);
      const changed = movingLights.update(lights, offsets, lightFrameBegun ? lightFrame : null, visible, drawnRecords);
      for (const { lightmap, region } of changed) lightAtlas.update(lightmap, { partial: true, region });
      for (const note of movingLights.notes) if (!notes.has(note)) { notes.add(note); world.notes.push(note); }
      return { lightmaps: changed.length, surfaces: movingLights.surfaces };
    },
    /** URender's Texture->Get(Viewport->CurrentTime) for every animated
     * surface texture, once per drawn frame (UViewport::Lock's clock). The
     * original updates only the textures of surfaces in its draw list; BSP
     * occlusion is not recovered, so every animated texture of the world
     * advances each frame here. */
    updateTextureAnimation(time = clock(), { timeSeconds = 0, zoneSpeeds = null, viewpoint = null, frustum = null, drawn = null,
      phase = null } = {}) {
      // Light animation: the light manager's noise with Level.TimeSeconds,
      // then the animated class 1 light maps (docs/static-lighting.md). The
      // original rebuilds the per-frame map of drawn surfaces only; with
      // `drawn` (the level surfaces OccludeBsp's frame draws) the other
      // level light maps wait, else with a `frustum` those outside it (their
      // merge, spatially dynamic bytes included, depends only on the frame's
      // inputs, not on what is drawn); brush light maps always update.
      if (lighting.animatedRecords().length) {
        const inView = drawn ? record => record.owner || drawn.has(record.surfaceIndex)
          : frustum ? record => record.owner || inFrustum(frustum, record) : () => true;
        let merged = 0;
        const visible = record => inView(record) && ++merged > 0;
        const start = performance.now();
        const changed = lighting.animate(lightFrameBegun || simFed ? lightFrame : lightFrame.advance(timeSeconds), visible);
        lightAnimation.mergeMs = performance.now() - start;
        // A light map composed with moving lights changes as a whole (no
        // region): its whole tile is resent, not the whole atlas. Otherwise
        // lighting.animate has just set the region's samples to texels/255,
        // so the page takes the merged bytes themselves.
        for (const { lightmap, region } of changed)
          lightAtlas.update(lightmap, region ? { partial: true, region, bytes: lightmap.texels } : { partial: true });
        lightAnimation.changed = changed.length; lightAnimation.ms = performance.now() - start;
        lightAnimation.merged = merged;
        lightAnimation.changedSpatial = changed.filter(({ lightmap }) => lightmap.animated.some(light => light.spatialDynamic)).length;
      }
      lightFrameBegun = false;
      phase?.('lightAnimation');
      // Fire textures, BSP and mesh skins alike, once per frame.
      sharedProceduralTextures().update(time);
      for (const head of animatedHeads) {
        const frame = textureFrame(head, time);
        if (frame === head.shown) continue;
        head.shown = frame;
        for (const { material, frames } of head.uses) material.map = frames.get(frame);
      }
      // Auto-pan with the zone on the viewer's side of the node plane
      // (IsFront = Plane·Viewpoint - W > 0) and Level.TimeSeconds; without a
      // running level TimeSeconds stays 0 and so does the pan.
      for (const entry of panned) {
        const side = viewpoint && entry.plane[0] * viewpoint[0] + entry.plane[1] * viewpoint[1] + entry.plane[2] * viewpoint[2] - entry.plane[3] > 0 ? 1 : 0;
        const zone = entry.zones[viewpoint ? side : 1];
        const [speedU, speedV] = (zone.name && zoneSpeeds?.(zone.name)) ?? zone.speeds;
        const { surface } = entry;
        const pan = surfacePan({ panU: surface.pan[0], panV: surface.pan[1], flags: surface.flags,
          speedU: Math.fround(speedU), speedV: Math.fround(speedV), timeSeconds: Math.fround(timeSeconds) });
        // The geometry's UVs already carry Surf.PanU/PanV.
        const u = (pan.u - surface.pan[0]) / entry.width, v = (pan.v - surface.pan[1]) / entry.height;
        if (entry.last && entry.last[0] === u && entry.last[1] === v && entry.last[2] === entry.material.map) continue;
        entry.material.map.offset.set(u, v);
        entry.last = [u, v, entry.material.map];
      }
      phase?.('textures');
    },
    /** The zone names whose live pan speeds the auto-panned surfaces read. */
    panZoneNames: () => [...new Set(panned.flatMap(entry => entry.zones.map(zone => zone.name)).filter(Boolean))],
    pannedSurfaces: () => panned.map(entry => ({ flags: entry.surface.flags, pan: [...entry.surface.pan],
      zones: entry.zones.map(zone => zone.name), speeds: entry.zones.map(zone => zone.speeds), plane: entry.plane,
      width: entry.width, height: entry.height, offset: [entry.material.map.offset.x, entry.material.map.offset.y] })),
    animatedTextures: () => [...animatedHeads].map(head => {
      const chain = [];
      let frame = head;
      for (; frame && !chain.includes(frame.key); frame = frame.animNext) chain.push(frame.key);
      // ConstantTimeTick wraps to the head when AnimNext is None.
      return { key: head.key, frame: head.shown?.key ?? null, chain, wrap: frame?.key ?? head.key,
        drawn: head.uses.every(({ material, frames }) => material.map === frames.get(head.shown ?? head)) };
    }),
    flushLighting(renderer) { lightAtlas.flush(renderer); },
    movingLightRecords: () => movingLights.records(),
    /** Validation: the current light frame's inputs, and whether the
     * simulation supplied them. */
    lightFrameInputs: () => ({ simFed, frameIndex: lightFrame.frameIndex, timeSeconds: lightFrame.timeSeconds,
      A: Array.from(lightFrame.noise.A), W: Array.from(lightFrame.noise.W), strobe: { ...lightFrame.strobe } }),
    /** The light atlas pages' bytes (validators compare them). */
    lightAtlasPages: () => lightAtlas.pages.map(page => page.pixels),
    lightAnimation: () => ({ records: lighting.animatedRecords().length, changed: lightAnimation.changed,
      merged: lightAnimation.merged, changedSpatial: lightAnimation.changedSpatial,
      spatialRecords: lighting.animatedRecords().filter(record => record.animated.some(light => light.spatialDynamic)).length,
      ms: lightAnimation.ms, mergeMs: lightAnimation.mergeMs,
      time: lightFrame.timeSeconds, step: lightFrame.noise.last }),
    lighting: { ...lighting.stats, atlasPages: lightAtlas.pages.length }, lightingEnabled, displayGamma,
    dispose() { root.traverse(o => o.geometry?.dispose()); for (const m of materials.values()) m.dispose();
      for (const t of textureGPU.values()) t.dispose(); markerMaterial.dispose(); lightAtlas.dispose(); mirrors.dispose(); fog.dispose(); lighting.dispose(); },
  };
  return world;
}
