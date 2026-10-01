import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { readModel, triangulateModel } from '../unreal/model.mjs';
import { buildSurfaceGeometry, POLY, toView, fromView } from '../unreal/geometry.mjs';
import { brushMatrix } from './transforms.mjs';
import { createLighting, pointZone } from '../unreal/lighting.mjs';
import { LightAtlas, applyLightAtlas } from './light-atlas.mjs';
import { readPolys, withMoverLightmaps } from '../unreal/polys.mjs';
import { createMovingLights } from './moving-lights.mjs';
import { createMirrors } from './mirrors.mjs';
import { batchWorldMeshes } from './world-batches.mjs';
import { get as textureFrame } from '../runtime/texture-animation.mjs';

export async function createWorld(map, asset, assets, onProgress = () => {}, {batchOpaque = true} = {}) {
  const root = new THREE.Group(), textures = new TextureStore(assets), textureGPU = new Map(), materials = new Map();
  const notes = new Set(), errors = [], textureNames = new Set(), moverGroups = new Map(), rotatedMovers = new Set();
  const lighting = await createLighting(map, asset, assets), lightAtlas = new LightAtlas();
  const movingLights = createMovingLights(lighting, map.model);
  lighting.setMovingApplier(movingLights.apply);
  const lightingEnabled = { value: 1 };
  const displayGamma = { value: 1 / 1.5 };
  const mirrors = createMirrors(notes, displayGamma);
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

  async function materialFor(surface, tile, mirror) {
    let flags = surface.flags;
    const decoded = await textures.get(asset, surface.texture, Boolean(flags & POLY.Masked));
    for (const [name, flag] of Object.entries(flagProperties)) if (decoded.values[name]) flags |= flag;
    const data = flags & POLY.Masked && !decoded.masked ? await textures.get(asset, surface.texture, true) : decoded;
    if (data.procedural) notes.add(`${data.key}: ${data.procedural}. Ripple simulation is not active.`);
    textureNames.add(data.key);
    const key = `${data.key}:${flags}:${tile.page.index}:${mirror?.key ?? ''}`;
    if (!materials.has(key)) {
      const material = new THREE.MeshBasicMaterial({ map: gpuTexture(data, flags),
        side: flags & POLY.TwoSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: flags & POLY.Masked ? .5 : 0 });
      applyLightAtlas(material, tile.page, lightingEnabled, displayGamma, mirror,
        !mirror && !(flags & POLY.Translucent) && Boolean(flags & POLY.Modulated));
      if (mirror) {
        // The reflected child is composited by the shader, then PF_Occlude
        // writes floor depth. Ordinary translucent surfaces keep their blend.
        material.blending = THREE.NoBlending; material.depthWrite = true;
      } else if (flags & POLY.Translucent) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor;
      } else if (flags & POLY.Modulated) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
      }
      material.userData = { key: data.key, flags, width: data.mips[0].width, height: data.mips[0].height, mipCount: data.mips.length };
      if (data.values.AnimNext) {
        // The surface's texture is the chain head; Render draws its Get(Time).
        const head = await animationRecord(data);
        head.data.set(data.masked, data);
        head.uses.push({ material, frames: await animationFrames(head, data, flags) });
        animatedHeads.add(head);
        material.userData.animated = true;
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
      const zone = moverZone ?? model.nodes[t.node].zones[1];
      const key = `${t.surface}:${zone}`;
      if (!bySurface.has(key)) bySurface.set(key, { surfaceIndex: t.surface, zone, ts: [] });
      bySurface.get(key).ts.push(t);
    }
    const batches = new Map();
    let done = 0;
    for (const { surfaceIndex, zone, ts } of bySurface.values()) {
      const surface = model.surfaces[surfaceIndex];
      if (surface.flags & (POLY.Invisible | POLY.FakeBackdrop)) continue;
      try {
        const lightmap = surface.flags & POLY.Unlit ? null : lighting.surface(model, surfaceIndex, zone, transform, transformNormal, actorName);
        const tile = lightAtlas.add(lightmap);
        const mirror = mirrors.surface(model, surface, actorName);
        const { material, flags, key } = await materialFor(surface, tile, mirror);
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
  for (const actor of map.actors.filter(a => /Mover$/.test(a.className) && a.values.Brush > 0)) {
    try {
      const rawModel = readModel(asset.pkg, asset.bytes, actor.values.Brush);
      const model = withMoverLightmaps(rawModel, readPolys(asset.pkg, asset.bytes, rawModel.polygons));
      const group = new THREE.Group();
      group.matrix.copy(brushMatrix(actor.values)); group.matrixAutoUpdate = false;
      group.userData.baseMatrix = group.matrix.clone(); moverGroups.set(actor.name, group);
      root.add(group);
      await addModel(model, triangulateModel(model), group, actor.name, group.matrix);
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
  if (mirrors.stats.surfaces) notes.add('Static translucent mirror floors render reflected world and actor views. Recursive mirrors and mirror/sky combinations remain unverified.');
  if (lighting.stats.missingLightmaps) notes.add(`${lighting.stats.missingLightmaps} surfaces have no stored lightmap and retain their base texture brightness.`);
  if (errors.length) notes.add(`${errors.length} surfaces or moving brushes could not be rendered. See diagnostics details.`);
  if (animatedHeads.size) notes.add(`${animatedHeads.size} animated surface textures advance every frame; the original advances only those its BSP occlusion draws.`);
  const sky = map.actors.find(a => a.className === 'SkyZoneInfo' && a.values.Location)?.values.Location ?? null;
  function updateLighting(changes) {
    const update = lighting.invalidate(changes);
    for (const lightmap of update.lightmaps) lightAtlas.update(lightmap);
    return { ...update, uploaded: update.lightmaps.length };
  }
  const world = { root, markers, counts, textures: textureNames.size, materials, mirrors, submissionBatches, notes: [...notes], errors, sky,
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
    updateTextureAnimation(time = clock()) {
      for (const head of animatedHeads) {
        const frame = textureFrame(head, time);
        if (frame === head.shown) continue;
        head.shown = frame;
        for (const { material, frames } of head.uses) material.map = frames.get(frame);
      }
    },
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
    lighting: { ...lighting.stats, atlasPages: lightAtlas.pages.length }, lightingEnabled, displayGamma,
    dispose() { root.traverse(o => o.geometry?.dispose()); for (const m of materials.values()) m.dispose();
      for (const t of textureGPU.values()) t.dispose(); markerMaterial.dispose(); lightAtlas.dispose(); mirrors.dispose(); },
  };
  return world;
}
