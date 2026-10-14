import * as THREE from 'three';
import { displayRampGlsl } from './light-atlas.mjs';
import { DECAL_LAYER } from './render-layers.mjs';
import { configureSampler } from './original-sampling.mjs';


/** Decals in Play, the page's side (docs/decals.md "Drawing"): the
 * simulation's fragments (decal-draw.mjs) drawn as D3DDrv draws PF_Modulated
 * polygons (DrawGouraudPolygon 0x100056b0 with SetBlending(0x40)):
 * DESTCOLOR/SRCCOLOR, so the frame takes 2·texel·dst; no depth write, depth
 * test LESSEQUAL, no bias (ClipDecal's 0.75-unit lift is the only offset),
 * no culling, white diffuse, WRAP addressing, bilinear with point mip
 * selection and LOD bias -0.5, and palette index 0 not transparent. One mesh
 * per texture. Textures decode from the page's own asset store; a texture
 * still decoding skips its fragments for that frame. */
export function createDecalScene(assets, textures, { displayGamma }) {
  const root = new THREE.Group(), entries = new Map(), notes = new Set();
  root.matrixAutoUpdate = false; root.name = 'Decals';
  let drawn = 0;

  function texture(reference) {
    const key = reference.key ?? `${reference.package}:${reference.index}`;
    let entry = entries.get(key);
    if (entry) return entry;
    entry = { texture: null, mesh: null };
    entries.set(key, entry);
    assets.get(reference.package).then(asset => textures.get(asset, reference.index, false)).then(data => {
      const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
      gpu.colorSpace = THREE.SRGBColorSpace; gpu.flipY = false;
      gpu.wrapS = gpu.wrapT = THREE.RepeatWrapping;
      const last = data.mips.at(-1), complete = last.width === 1 && last.height === 1;
      if (complete && data.mips.length > 1) gpu.mipmaps = data.mips;
      gpu.generateMipmaps = !complete;
      configureSampler(gpu, false);
      gpu.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({ map: gpu, transparent: true, depthWrite: false,
        depthFunc: THREE.LessEqualDepth, side: THREE.DoubleSide, fog: false });
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
      material.onBeforeCompile = shader => {
        shader.uniforms.deusDisplayGamma = displayGamma;
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
          .replace('#include <colorspace_fragment>', `gl_FragColor = sRGBTransferOETF(gl_FragColor);
            ${displayRampGlsl('deusDisplayGamma', true)}`);
      };
      material.customProgramCacheKey = () => 'deus-decal';
      const geometry = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
      // Before the translucent world surfaces, which DrawFrame's later
      // passes draw after the occluding ones and their decals.
      mesh.renderOrder = -1;
      mesh.layers.set(DECAL_LAYER);
      root.add(mesh);
      Object.assign(entry, { texture: gpu, mesh });
    }).catch(error => { entry.failed = error.message; notes.add(`Decal texture ${key}: ${error.message}`); });
    return entry;
  }

  /** One frame: the texture groups of decal-draw.mjs, or null. */
  function update(groups) {
    drawn = 0;
    for (const entry of entries.values()) if (entry.mesh) entry.mesh.visible = false;
    for (const group of groups ?? []) {
      const entry = texture(group.texture);
      if (!entry.mesh) continue;
      const geometry = entry.mesh.geometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(group.uvs, 2));
      entry.mesh.visible = true;
      drawn += group.positions.length / 9;
    }
  }

  return { root, update, notes, count: () => drawn,
    dispose() { for (const entry of entries.values()) if (entry.mesh) { entry.mesh.geometry.dispose(); entry.mesh.material.dispose(); entry.texture.dispose(); } } };
}
