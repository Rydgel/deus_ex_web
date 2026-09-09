import * as THREE from 'three';
import { TextureStore } from '../unreal/textures.mjs';
import { readModel, triangulateModel } from '../unreal/model.mjs';
import { buildSurfaceGeometry, POLY, toView } from '../unreal/geometry.mjs';
import { brushMatrix } from './transforms.mjs';

export async function createWorld(map, asset, assets, onProgress = () => {}) {
  const root = new THREE.Group(), textures = new TextureStore(assets), textureGPU = new Map(), materials = new Map();
  const notes = new Set(), errors = [], textureNames = new Set();
  const counts = { triangles: 0, degenerate: 0, corrected: 0, movers: 0, surfaces: 0 };
  const flagProperties = { bInvisible: 1, bMasked: 2, bTranslucent: 4, bTwoSided: 256,
    bNoSmooth: 2048, bUnlit: 0x400000, bModulated: 0x4000000 };

  async function materialFor(surface) {
    let flags = surface.flags;
    const decoded = await textures.get(asset, surface.texture, Boolean(flags & POLY.Masked));
    for (const [name, flag] of Object.entries(flagProperties)) if (decoded.values[name]) flags |= flag;
    const data = flags & POLY.Masked && !decoded.masked ? await textures.get(asset, surface.texture, true) : decoded;
    if (data.procedural) notes.add(`${data.key}: ${data.procedural}. Ripple simulation is not active.`);
    textureNames.add(data.key);
    const key = `${data.key}:${flags}`;
    if (!materials.has(key)) {
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
      const material = new THREE.MeshBasicMaterial({ map: textureGPU.get(texKey),
        side: flags & POLY.TwoSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: flags & POLY.Masked ? .5 : 0 });
      if (flags & POLY.Translucent) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor;
      } else if (flags & POLY.Modulated) {
        material.transparent = true; material.depthWrite = false; material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
      }
      material.userData = { key: data.key, flags, width: data.mips[0].width, height: data.mips[0].height, mipCount: data.mips.length };
      materials.set(key, material);
    }
    return { material: materials.get(key), flags, key };
  }

  async function addModel(model, triangles, parent, actorName = null) {
    const bySurface = new Map();
    for (const t of triangles) {
      if (!bySurface.has(t.surface)) bySurface.set(t.surface, []);
      bySurface.get(t.surface).push(t);
    }
    const batches = new Map();
    let done = 0;
    for (const [surfaceIndex, ts] of bySurface) {
      const surface = model.surfaces[surfaceIndex];
      if (surface.flags & (POLY.Invisible | POLY.FakeBackdrop)) continue;
      try {
        const { material, flags, key } = await materialFor(surface);
        if (flags & POLY.Invisible) continue;
        const g = buildSurfaceGeometry(model, ts, surfaceIndex, material.userData.width, material.userData.height);
        counts.degenerate += g.degenerate; counts.corrected += g.corrected;
        if (!g.positions.length) continue;
        if (!batches.has(key)) batches.set(key, { material, positions: [], normals: [], uvs: [], faces: [] });
        const batch = batches.get(key);
        batch.positions.push(...g.positions); batch.normals.push(...g.normals); batch.uvs.push(...g.uvs);
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
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, batch.material);
      mesh.userData = { actor: actorName, faces: batch.faces, model: model.entry.name };
      parent.add(mesh);
    }
  }

  await addModel(map.model, map.triangles, root);
  for (const actor of map.actors.filter(a => /Mover$/.test(a.className) && a.values.Brush > 0)) {
    try {
      const model = readModel(asset.pkg, asset.bytes, actor.values.Brush);
      const group = new THREE.Group();
      group.matrix.copy(brushMatrix(actor.values)); group.matrixAutoUpdate = false;
      root.add(group);
      await addModel(model, triangulateModel(model), group, actor.name);
      counts.movers++;
    } catch (error) { errors.push({ actor: actor.name, message: error.message }); }
  }
  const markerPositions = map.actors.filter(a => a.values.Location && a.className !== 'Brush').flatMap(a => toView(a.values.Location));
  const markerGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(markerPositions, 3));
  const markerMaterial = new THREE.PointsMaterial({ color: '#efc176', size: 5, sizeAttenuation: false, depthTest: false });
  const markers = new THREE.Points(markerGeometry, markerMaterial); markers.visible = false; markers.renderOrder = 100;
  root.add(markers);
  notes.add(`${map.summary.unknownLevelBytes} trailing Level bytes and ${map.summary.undecodedActorProperties} property values remain opaque.`);
  if (errors.length) notes.add(`${errors.length} surfaces or moving brushes could not be rendered. See diagnostics details.`);
  const sky = map.actors.find(a => a.className === 'SkyZoneInfo' && a.values.Location)?.values.Location ?? null;
  return { root, markers, counts, textures: textureNames.size, materials, notes: [...notes], errors, sky,
    dispose() { root.traverse(o => o.geometry?.dispose()); for (const m of materials.values()) m.dispose();
      for (const t of textureGPU.values()) t.dispose(); markerMaterial.dispose(); },
  };
}
