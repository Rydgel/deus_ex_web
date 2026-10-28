import * as THREE from 'three';
import { displayRampGlsl } from './light-atlas.mjs';
import { DECAL_LAYER } from './render-layers.mjs';
import { configureSampler, REENCODE_GLSL } from './original-sampling.mjs';
import { frameProjection, FRAME_PROJECTION_KEY } from './frame-projection.mjs';


/** A texture's decal material (createDecalScene), the shader warm-up's too (decalWarmup). */
function decalMaterial(map, displayGamma) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false,
    depthFunc: THREE.LessEqualDepth, side: THREE.DoubleSide, fog: false });
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
  material.onBeforeCompile = shader => {
    shader.uniforms.deusDisplayGamma = displayGamma;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
      .replace('#include <colorspace_fragment>', `${REENCODE_GLSL}
        ${displayRampGlsl('deusDisplayGamma', true)}`);
    // ClipDecal's points through the original's vertex chain (docs/frame-projection.md "Decals").
    frameProjection.patch(shader, { decal: true });
  };
  material.customProgramCacheKey = () => `deus-decal:${FRAME_PROJECTION_KEY}`;
  return material;
}

/** A run's mesh: slot `k` of the frame's runs draws after slot k - 1. */
function decalMesh(material, k, geometry = new THREE.BufferGeometry()) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
  // Before the translucent world surfaces, which DrawFrame's later
  // passes draw after the occluding ones and their decals; the runs in their
  // order (three.js sorts transparent items by renderOrder first).
  mesh.renderOrder = -1 + k * 2 ** -20;
  mesh.layers.set(DECAL_LAYER);
  return mesh;
}

/** The shader warm-up's decal mesh (shader-warmup.mjs). */
export function decalWarmup({ displayGamma, texture, geometry }) { return [decalMesh(decalMaterial(texture, displayGamma), 0, geometry)]; }

/** Decals in Play, the page's side (docs/decals.md "Drawing"): the
 * simulation's fragments (decal-draw.mjs) drawn as D3DDrv draws PF_Modulated
 * polygons (DrawGouraudPolygon 0x100056b0 with SetBlending(0x40)):
 * DESTCOLOR/SRCCOLOR, so the frame takes 2·texel·dst; no depth write, depth
 * test LESSEQUAL, no bias (ClipDecal's 0.75-unit lift is the only offset),
 * no culling, white diffuse, WRAP addressing, bilinear with point mip
 * selection and LOD bias -0.5, and palette index 0 not transparent. The
 * fragments come as runs of one texture in the decal block's order, and each
 * run is one mesh drawn after the one before it: two decals of different
 * textures that overlap blend in the original's order (the 8-bit target
 * rounds and clamps each `2·texel·dst`). Textures decode from the page's own
 * asset store; a texture still decoding skips its fragments for that frame. */
export function createDecalScene(assets, textures, { displayGamma }) {
  const root = new THREE.Group(), entries = new Map(), notes = new Set(), slots = [];
  root.matrixAutoUpdate = false; root.name = 'Decals';
  let drawn = 0;

  function texture(reference) {
    const key = reference.key ?? `${reference.package}:${reference.index}`;
    let entry = entries.get(key);
    if (entry) return entry;
    entry = { texture: null, material: null };
    entries.set(key, entry);
    assets.get(reference.package).then(asset => textures.get(asset, reference.index, false)).then(data => {
      const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
      gpu.flipY = false;
      gpu.wrapS = gpu.wrapT = THREE.RepeatWrapping;
      const last = data.mips.at(-1), complete = last.width === 1 && last.height === 1;
      if (complete && data.mips.length > 1) gpu.mipmaps = data.mips;
      gpu.generateMipmaps = !complete;
      configureSampler(gpu, false);
      gpu.needsUpdate = true;
      Object.assign(entry, { texture: gpu, material: decalMaterial(gpu, displayGamma) });
    }).catch(error => { entry.failed = error.message; notes.add(`Decal texture ${key}: ${error.message}`); });
    return entry;
  }

  /** Slot `k`'s mesh, made in slot order (with the first material it draws). */
  function slot(k, material) {
    while (slots.length <= k) {
      const mesh = decalMesh(material, slots.length);
      root.add(mesh);
      slots.push({ mesh, capacity: 0 });
    }
    return slots[k];
  }

  /** Room for `vertices` in the slot's geometry, doubling; the old buffers
   * are deleted with the geometry's dispose (the geometry stays usable). */
  function reserve(entry, geometry, vertices) {
    let capacity = Math.max(64, entry.capacity ?? 0);
    while (capacity < vertices) capacity *= 2;
    geometry.dispose();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
    entry.capacity = capacity;
  }

  /** One frame: the runs of decal-draw.mjs in order, or null. */
  function update(runs) {
    drawn = 0;
    for (const { mesh } of slots) mesh.visible = false;
    let k = 0;
    for (const run of runs ?? []) {
      const entry = texture(run.texture);
      if (!entry.material) continue;
      const target = slot(k++, entry.material), mesh = target.mesh, geometry = mesh.geometry, vertices = run.positions.length / 3;
      mesh.material = entry.material;
      // The run's fragments are copied into attributes that keep their GL
      // buffers (a replaced attribute's buffer is never deleted by three.js,
      // so a new attribute each frame leaked two buffers per run per frame
      // until the page heap's next collection).
      if (!(target.capacity >= vertices)) reserve(target, geometry, vertices);
      const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
      position.array.set(run.positions); uv.array.set(run.uvs);
      for (const attribute of [position, uv]) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, attribute.itemSize * vertices); attribute.needsUpdate = true;
      }
      geometry.setDrawRange(0, vertices);
      mesh.visible = true;
      drawn += run.positions.length / 9;
    }
  }

  return { root, update, notes, count: () => drawn,
    dispose() {
      for (const { mesh } of slots) mesh.geometry.dispose();
      for (const entry of entries.values()) if (entry.material) { entry.material.dispose(); entry.texture.dispose(); }
    } };
}
