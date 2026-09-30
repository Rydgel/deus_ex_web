import * as THREE from 'three';
import {POLY} from '../unreal/geometry.mjs';
import {applyLightAtlas} from './light-atlas.mjs';

const MAX_TEXTURES = 8;

/** Preserve r186's opaque material-ID order, including equal-depth winners.
 * Only consecutive static meshes with exclusive materials may merge. Movers,
 * mirrors and shared materials remain ordering barriers. See docs/lighting.md. */
export function batchWorldMeshes(root, lightAtlas, enabled, gamma) {
  const meshes = [], uses = new Map();
  root.traverse(object => {
    if (!object.isMesh || Array.isArray(object.material)) return;
    uses.set(object.material, (uses.get(object.material) ?? 0) + 1);
    if (!object.material.transparent) meshes.push(object);
  });
  const stats = {before: meshes.length, after: meshes.length, batches: 0};
  // Current world construction uses group/render order zero throughout. A
  // future custom order must be handled explicitly rather than misbatched.
  for (const mesh of meshes) {
    if (mesh.renderOrder !== 0) return stats;
    for (let parent = mesh.parent; parent; parent = parent.parent)
      if (parent.isGroup && parent.renderOrder !== 0) return stats;
  }
  meshes.sort((a, b) => a.material.id - b.material.id);
  const eligible = mesh => {
    const material = mesh.material;
    return mesh.parent === root && mesh.userData.actor === null && uses.get(material) === 1 &&
      !mesh.isInstancedMesh && !mesh.isSkinnedMesh &&
      !(material.userData.flags & (POLY.Mirrored | POLY.Modulated | POLY.Translucent)) &&
      material.blending === THREE.NormalBlending && material.depthTest && material.depthWrite &&
      material.depthFunc === THREE.LessEqualDepth && !material.polygonOffset && material.opacity === 1 &&
      material.color.equals(new THREE.Color(1, 1, 1)) && material.map &&
      material.map.offset.x === 0 && material.map.offset.y === 0 && material.map.repeat.x === 1 &&
      material.map.repeat.y === 1 && material.map.rotation === 0 && !geometryHasGroups(mesh.geometry);
  };
  const runs = [];
  let run = [], textures = new Set();
  const flush = () => { if (run.length > 1) runs.push(run); run = []; textures = new Set(); };
  for (const mesh of meshes) {
    if (!eligible(mesh)) { flush(); continue; }
    const material = mesh.material, first = run[0]?.material;
    if (first && (first.side !== material.side || first.alphaTest !== material.alphaTest ||
      (!textures.has(material.map) && textures.size === MAX_TEXTURES))) flush();
    run.push(mesh); textures.add(material.map);
  }
  flush();
  if (!runs.length) return stats;
  // WebGL2 guarantees 256 array layers. Keep the old path beyond that limit.
  if (lightAtlas.pages.length > 256) return stats;
  const array = lightAtlas.sealArray(), stride = lightAtlas.pages.length + 1;
  for (const meshes of runs) {
    const first = meshes[0], material = first.material, textures = [...new Set(meshes.map(mesh => mesh.material.map))];
    const geometry = new THREE.BufferGeometry(), names = Object.keys(first.geometry.attributes);
    const vertices = meshes.reduce((count, mesh) => count + mesh.geometry.getAttribute('position').count, 0);
    for (const name of names) {
      const source = first.geometry.getAttribute(name), data = new Float32Array(vertices * source.itemSize);
      let at = 0;
      for (const mesh of meshes) { const values = mesh.geometry.getAttribute(name).array; data.set(values, at); at += values.length; }
      geometry.setAttribute(name, new THREE.BufferAttribute(data, source.itemSize));
    }
    const lightUV = geometry.getAttribute('lightUV').array, layers = geometry.getAttribute('lightLayer').array;
    const faces = [], faceMaterials = [];
    let at = 0;
    for (const mesh of meshes) {
      const count = mesh.geometry.getAttribute('position').count;
      const selector = textures.indexOf(mesh.material.map);
      // Reuse the original varying layout. An added flat varying changed
      // base UV interpolation rounding on Metal at large world coordinates.
      // Each triangle carries one small integer, rounded before decoding.
      for (let i = at; i < at + count; i++)
        lightUV[i * 3 + 2] = selector * stride + (lightUV[i * 3 + 2] > .5 ? layers[i] + 1 : 0);
      at += count;
      faces.push(...mesh.userData.faces);
      for (let i = 0; i < mesh.userData.faces.length; i++) faceMaterials.push(mesh.material.userData);
    }
    geometry.computeBoundingSphere();
    // Keeping the first material object keeps its ID, so the merged draw
    // occupies exactly this run's old position in Three's opaque sort.
    applyLightAtlas(material, null, enabled, gamma, null, false, array);
    applyTextureSelection(material, textures, stride);
    first.geometry.dispose(); first.geometry = geometry;
    first.userData = {...first.userData, faces, faceMaterials, lightTextureStride: stride};
    for (const mesh of meshes.slice(1)) { mesh.removeFromParent(); mesh.geometry.dispose(); }
    stats.after -= meshes.length - 1; stats.batches++;
  }
  return stats;
}

function geometryHasGroups(geometry) {
  return geometry.index !== null || geometry.groups.length !== 0 || geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity;
}

function applyTextureSelection(material, textures, stride) {
  const lighting = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${key}:ordered-textures-${textures.length}`;
  material.onBeforeCompile = shader => {
    lighting(shader);
    for (let i = 0; i < textures.length; i++) shader.uniforms[`deusMap${i}`] = {value: textures[i]};
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      ${textures.map((_, i) => `uniform sampler2D deusMap${i};`).join('\n')}`)
      .replace('#include <map_fragment>', `
      // Implicit derivatives must execute in uniform control flow. Explicit
      // textureGrad differs at mip/alpha edges on Metal, so retain the exact
      // old lookup for every sampler before selecting this triangle's texel.
      ${textures.map((_, i) => `vec4 deusSample${i} = texture2D(deusMap${i}, vMapUv);`).join('\n')}
      highp int deusTextureIndex = int(floor(vDeusLightUV.z + 0.5)) / ${stride};
      vec4 sampledDiffuseColor;
      ${textures.map((_, i) => `${i ? 'else ' : ''}${i < textures.length - 1 ? `if (deusTextureIndex == ${i})` : ''}
        { sampledDiffuseColor = deusSample${i}; }`).join('\n')}
      diffuseColor *= sampledDiffuseColor;`);
  };
}
