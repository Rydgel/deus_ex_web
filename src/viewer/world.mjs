import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { readModel, triangulateModel } from '../unreal/model.mjs';
import { buildSurfaceGeometry, POLY, toView, fromView } from '../unreal/geometry.mjs';
import { brushMatrix } from './transforms.mjs';
import { createLighting, pointZone } from '../unreal/lighting.mjs';
import { LightAtlas, applyLightAtlas } from './light-atlas.mjs';
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
import { loadScriptVmKernel } from '../runtime/script-vm-kernel.mjs';

export async function createWorld(map, asset, assets, onProgress = () => {}, {batchOpaque = true} = {}) {
  const root = new THREE.Group(), textures = new TextureStore(assets), textureGPU = new Map(), materials = new Map();
  const notes = new Set(), errors = [], textureNames = new Set(), moverGroups = new Map(), rotatedMovers = new Set();
  const lighting = await createLighting(map, asset, assets), lightAtlas = new LightAtlas();
  const movingLights = createMovingLights(lighting, map.model);
  lighting.setMovingApplier(movingLights.apply);
  const lightingEnabled = { value: 1 };
  const displayGamma = { value: 1 / 1.5 };
  const mirrors = createMirrors(notes, displayGamma);
  // Volumetric fog maps (docs/volumetric-fog.md); the per-texel loop runs in
  // the Rust core when its kernel loads.
  let fogKernel = null;
  try { fogKernel = await loadScriptVmKernel(); } catch { fogKernel = null; }
  const fog = createFogPass({ lightAtlas, levelBrightness: lighting.levelBrightness, hsv: lighting.hsv, displayGamma, notes, kernel: fogKernel });
  const counts = { triangles: 0, degenerate: 0, corrected: 0, movers: 0, surfaces: 0 };
  const flagProperties = { bInvisible: 1, bMasked: 2, bTranslucent: 4, bTwoSided: 256,
    bNoSmooth: 2048, bUnlit: POLY.Unlit, bModulated: POLY.Modulated };

  function gpuTexture(data, flags) {
    const texKey = `${data.key}:${Boolean(flags & POLY.Masked)}:${Boolean(flags & POLY.NoSmooth)}`;
    if (!textureGPU.has(texKey)) {
      const first = data.mips[0];
      const tex = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = flags & POLY.NoSmooth ? THREE.NearestFilter : THREE.LinearFilter;
      const last = data.mips.at(-1), complete = last.width === 1 && last.height === 1;
      if (complete && data.mips.length > 1) tex.mipmaps = data.mips;
      tex.generateMipmaps = !complete;
      tex.minFilter = flags & POLY.NoSmooth ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
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

  async function materialFor(surface, tile, mirror, pan = null) {
    let flags = surface.flags;
    const source = await surfaceTexture(surface);
    const decoded = await textures.get(source.asset, source.ref, Boolean(flags & POLY.Masked));
    for (const [name, flag] of Object.entries(flagProperties)) if (decoded.values[name]) flags |= flag;
    const data = flags & POLY.Masked && !decoded.masked ? await textures.get(source.asset, source.ref, true) : decoded;
    if (data.procedural && !data.fire && !data.wet) notes.add(`${data.key}: ${data.procedural}. Ripple simulation is not active.`);
    textureNames.add(data.key);
    const key = `${data.key}:${flags}:${tile.page.index}:${mirror?.key ?? ''}${pan ? `:pan:${pan.key}` : ''}`;
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
        !mirror && !(flags & POLY.Translucent) && Boolean(flags & POLY.Modulated));
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
    let done = 0;
    for (const { surfaceIndex, zone, ts, pan } of bySurface.values()) {
      const surface = model.surfaces[surfaceIndex];
      if (surface.flags & (POLY.Invisible | POLY.FakeBackdrop)) continue;
      try {
        const lightmap = surface.flags & POLY.Unlit ? null : lighting.surface(model, surfaceIndex, zone, transform, transformNormal, actorName);
        const tile = lightAtlas.add(lightmap);
        const mirror = mirrors.surface(model, surfaceIndex, actorName);
        const { material, flags, key } = await materialFor(surface, tile, mirror, pan);
        if (flags & POLY.Invisible) continue;
        const lit = tile.enabled && !(flags & (POLY.Unlit | POLY.Modulated));
        lighting.stats[lit ? 'litSurfaces' : 'unlitSurfaces']++;
        const g = buildSurfaceGeometry(model, ts, surfaceIndex, material.userData.width, material.userData.height);
        counts.degenerate += g.degenerate; counts.corrected += g.corrected;
        if (!g.positions.length) continue;
        if (!batches.has(key)) batches.set(key, { material, mirror, positions: [], normals: [], uvs: [], lightUV: [], lightBounds: [], lightLayer: [], faces: [] });
        const batch = batches.get(key);
        batch.positions.push(...g.positions); batch.normals.push(...g.normals); batch.uvs.push(...g.uvs);
        for (let i = 0; i < g.positions.length; i += 3) {
          batch.lightUV.push(...(lit ? lightAtlas.coordinates(tile, fromView(g.positions.slice(i, i + 3))) : [0, 0, 0]));
          batch.lightBounds.push(...(tile.bounds ?? [0, 0, 1, 1]));
          batch.lightLayer.push(tile.page.index);
        }
        for (let i = 0; i < g.positions.length / 9; i++) batch.faces.push(surfaceIndex);
        counts.triangles += g.positions.length / 9; counts.surfaces++;
        if (!actorName && lightmap && lit && (await zoneActor(zone)).fog) {
          const fogUV = [], fogBounds = [];
          for (let i = 0; i < g.positions.length; i += 3) {
            fogUV.push(...lightAtlas.coordinates(tile, fromView(g.positions.slice(i, i + 3))));
            fogBounds.push(...(tile.bounds ?? [0, 0, 1, 1]));
          }
          lightmap.fogGrid ??= () => ({ grid: lighting.gridFor(lightmap) });
          fog.addSurface(lightmap, tile, g.positions, fogUV, fogBounds);
        }
      } catch (error) {
        errors.push({ actor: actorName, surface: surfaceIndex, message: error.message });
      }
      if (++done % 100 === 0) { onProgress(`Preparing ${actorName ?? 'world'} surfaces`, done, bySurface.size); await new Promise(resolve => setTimeout(resolve, 0)); }
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
      mesh.userData = { actor: actorName, faces: batch.faces, model: model.entry.name };
      parent.add(mesh);
      batch.mirror?.meshes.push(mesh);
    }
  }

  await addModel(map.model, map.triangles, root);
  for (const actor of map.actors) {
    if (!(actor.values.VolumeRadius > 0)) continue;
    fog.addLight(await classDefaults.forActor(asset, actor));
  }
  if (fog.stats.surfaces && fog.stats.lights) {
    root.add(fog.root);
    notes.add(`${fog.stats.surfaces} fog-zone surfaces draw volumetric fog from ${fog.stats.lights} volumetric lights each frame. Every light is linked to every fog surface (the original's culls drop only lights that add nothing); volumetric brightness is steady; mover surfaces and meshes get no fog.`);
  }
  for (const actor of map.actors.filter(a => /Mover$/.test(a.className) && a.values.Brush > 0)) {
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
      counts.movers++;
    } catch (error) { errors.push({ actor: actor.name, message: error.message }); }
  }
  const submissionBatches = batchOpaque ? batchWorldMeshes(root, lightAtlas, lightingEnabled, displayGamma) : null;
  const markerPositions = map.actors.filter(a => a.values.Location && a.className !== 'Brush').flatMap(a => toView(a.values.Location));
  const markerGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(markerPositions, 3));
  const markerMaterial = new THREE.PointsMaterial({ color: '#efc176', size: 5, sizeAttenuation: false, depthTest: false });
  const markers = new THREE.Points(markerGeometry, markerMaterial); markers.visible = false; markers.renderOrder = 100;
  root.add(markers);
  notes.add(`${map.summary.unknownLevelBytes} trailing Level bytes and ${map.summary.undecodedActorProperties} property values remain opaque.`);
  for (const note of lighting.notes) notes.add(note);
  if (mirrors.stats.surfaces) notes.add('Mirrored BSP and mover surfaces render reflected world and actor views. Mirror/sky combinations remain unverified.');
  if (lighting.stats.missingLightmaps) notes.add(`${lighting.stats.missingLightmaps} surfaces have no stored lightmap and retain their base texture brightness.`);
  if (errors.length) notes.add(`${errors.length} surfaces or moving brushes could not be rendered. See diagnostics details.`);
  if (panned.length) notes.add(`${panned.length} auto-panned surface groups follow Level.TimeSeconds and their viewer-side zone's pan speeds.`);
  if (animatedHeads.size) notes.add(`${animatedHeads.size} animated surface textures advance every frame; the original advances only those its BSP occlusion draws.`);
  const sky = map.actors.find(a => a.className === 'SkyZoneInfo' && a.values.Location)?.values.Location ?? null;
  // The appFrand draws of the light noise come from a host stream: the
  // original's position in the process-wide CRT stream is not reproduced.
  const lightFrame = createLightFrame(createNativeRng(0x11647).frand), lightAnimation = { changed: 0 };
  if (lighting.animatedRecords().length) notes.add(`${lighting.animatedRecords().length} light maps carry animated lights (pulse, flicker, strobe, torch/fire/watery waver), merged each frame; their noise draws come from a host stream.`);
  function updateLighting(changes) {
    const update = lighting.invalidate(changes);
    for (const lightmap of update.lightmaps) lightAtlas.update(lightmap);
    return { ...update, uploaded: update.lightmaps.length };
  }
  const world = { root, markers, counts, textures: textureNames.size, materials, mirrors, fog, submissionBatches, notes: [...notes], errors, sky,
    syncMovers(movers) {
      for (const mover of movers) {
        const group = moverGroups.get(mover.name); if (!group) continue;
        const authored = mover.values.Rotation ?? [0, 0, 0], rotation = mover.rotation ?? authored;
        if (rotation.some((v, i) => (v | 0) !== ((authored[i] ?? 0) | 0))) {
          // A rotating key (physMovingBrush's NewRotation): the brush matrix of
          // the live Location and Rotation, as ABrush::ToWorld poses it.
          group.matrix.copy(brushMatrix({ ...mover.values, Location: mover.position, Rotation: rotation }));
          if (!rotatedMovers.has(mover.name)) {
            rotatedMovers.add(mover.name);
            const note = 'Moving lights on a rotated mover use its authored orientation; only its translation reaches them.';
            if (!notes.has(note)) { notes.add(note); world.notes.push(note); }
          }
        } else {
          group.matrix.copy(group.userData.baseMatrix);
          const offset = toView(mover.collider.offset);
          for (let i = 0; i < 3; i++) group.matrix.elements[12 + i] += offset[i];
        }
        group.matrixWorldNeedsUpdate = true;
      }
    },
    updateLighting,
    /** Play's per-frame moving lights (game.movingLights()) over the current
     * mover offsets; changed tiles upload on the next flushLighting. */
    syncMovingLights(lights, movers = []) {
      const offsets = new Map(movers.map(mover => [mover.name, mover.collider.offset]));
      const changed = movingLights.update(lights, offsets);
      for (const { lightmap, region } of changed) lightAtlas.update(lightmap, { partial: true, region });
      for (const note of movingLights.notes) if (!notes.has(note)) { notes.add(note); world.notes.push(note); }
      return { lightmaps: changed.length, surfaces: movingLights.surfaces };
    },
    /** URender's Texture->Get(Viewport->CurrentTime) for every animated
     * surface texture, once per drawn frame (UViewport::Lock's clock). The
     * original updates only the textures of surfaces in its draw list; BSP
     * occlusion is not recovered, so every animated texture of the world
     * advances each frame here. */
    updateTextureAnimation(time = clock(), { timeSeconds = 0, zoneSpeeds = null, viewpoint = null, frustum = null } = {}) {
      // Light animation: the light manager's noise with Level.TimeSeconds,
      // then the animated class 1 light maps (docs/static-lighting.md). The
      // original merges only drawn surfaces; with a `frustum` the level's
      // light maps outside it wait (their merge does not depend on what is
      // drawn), brush light maps always update.
      if (lighting.animatedRecords().length) {
        const visible = frustum ? record => record.owner || frustum.intersectsSphere(record.viewSphere ??=
          new THREE.Sphere().setFromPoints(record.points.map(point => new THREE.Vector3(...toView(point))))) : undefined;
        const start = performance.now(), changed = lighting.animate(lightFrame.advance(timeSeconds), visible);
        lightAnimation.mergeMs = performance.now() - start;
        for (const { lightmap, region } of changed) lightAtlas.update(lightmap, region ? { partial: true, region } : undefined);
        lightAnimation.changed = changed.length; lightAnimation.ms = performance.now() - start;
      }
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
    },
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
    lightAnimation: () => ({ records: lighting.animatedRecords().length, changed: lightAnimation.changed,
      ms: lightAnimation.ms, mergeMs: lightAnimation.mergeMs,
      time: lightFrame.timeSeconds, step: lightFrame.noise.last }),
    lighting: { ...lighting.stats, atlasPages: lightAtlas.pages.length }, lightingEnabled, displayGamma,
    dispose() { root.traverse(o => o.geometry?.dispose()); for (const m of materials.values()) m.dispose();
      for (const t of textureGPU.values()) t.dispose(); markerMaterial.dispose(); lightAtlas.dispose(); mirrors.dispose(); fog.dispose(); },
  };
  return world;
}
