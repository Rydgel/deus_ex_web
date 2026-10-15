import * as THREE from 'three';
import { textureColorSpace, REENCODE_GLSL } from './original-sampling.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { frameProjection } from './frame-projection.mjs';

/** The page side of Play's light coronas (docs/coronas.md "Play"): the
 * simulation's corona icons (corona-scan.mjs) drawn as screen tiles with the
 * canvas's translucent blend (ONE, INVSRCCOLOR) after the world. An icon
 * draws once its skin has decoded here. The display gamma ramp applies per
 * fragment of the tile (host choice, noted).
 *
 * In a pass with a frame (main.mjs sets it around `render`, as for the first-person
 * weapon) the tile is the original's: the icon is DrawFrame's DrawIcon rectangle,
 * and the vertex shader builds UCanvas::DrawTile's clip and scale and D3DDrv's four
 * vertices from it (frameProjection.patchCorona, docs/coronas.md "On the tile
 * chain"). A pass without a frame (a ViewportWindow's) keeps the flat tile in
 * the orthographic overlay. */
export function createCoronaPass(assets, textures, { displayGamma }) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1, 1);
  const pool = [], textureCache = new Map(), notes = new Set();
  const stats = { leafLights: 0, visible: 0, drawn: 0 };
  let used = 0;

  function texture(reference) {
    const key = `${reference.package}:${reference.index}`;
    let entry = textureCache.get(key);
    if (!entry) {
      entry = { texture: null };
      textureCache.set(key, entry);
      const loaded = assets.loaded?.(reference.package);
      (loaded ? textures.get(loaded, reference.index, false)
        : assets.get(reference.package).then(asset => textures.get(asset, reference.index, false))).then(data => {
        const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
        gpu.colorSpace = textureColorSpace(); gpu.flipY = false; gpu.magFilter = gpu.minFilter = THREE.LinearFilter;
        gpu.generateMipmaps = false; gpu.needsUpdate = true;
        // UTexture::Lock at LOD 0: Info is mip 0, UScale = VScale = Scale (the packages' DrawScale); the
        // texture's own size is its USize and VSize (sprite-scene.mjs).
        Object.assign(entry, { texture: gpu, width: data.values.USize ?? first.width, height: data.values.VSize ?? first.height,
          infoWidth: first.width, infoHeight: first.height, scale: Math.fround(data.values.DrawScale ?? data.values.Scale ?? 1) });
      }).catch(error => notes.add(`Corona texture ${key}: ${error.message}`));
    }
    return entry.texture ? entry : null;
  }
  function tile() {
    if (used < pool.length) return pool[used++];
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    material.blending = THREE.CustomBlending; material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor;
    // This corona's tile inputs (frameProjection.patchCorona): the DrawIcon rectangle and the texture's sizes.
    material.userData.tile = { on: { value: 0 }, icon: { value: new THREE.Vector4() }, b: { value: new THREE.Vector4() }, c: { value: new THREE.Vector4() } };
    material.onBeforeCompile = shader => {
      shader.uniforms.deusDisplayGamma = displayGamma;
      frameProjection.patchCorona(shader, material.userData.tile);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
        .replace('#include <colorspace_fragment>', `${REENCODE_GLSL}
          ${displayRampGlsl('deusDisplayGamma', false)}`);
    };
    material.customProgramCacheKey = () => 'deus-corona-v2-fp1';
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.frustumCulled = false;
    scene.add(mesh); pool.push(mesh); used++;
    return mesh;
  }

  /** One main frame's corona frame (corona-scan.mjs update) at the drawn
   * size. */
  function update({ icons, stats: scanned }, width, height) {
    used = 0; stats.leafLights = scanned.leafLights; stats.visible = scanned.visible; stats.drawn = 0;
    for (const icon of icons) {
      const entry = texture(icon.skin);
      if (!entry) continue;
      const mesh = tile(), map = entry.texture, inputs = mesh.material.userData.tile;
      if (mesh.material.map !== map) { mesh.material.map = map; mesh.material.needsUpdate = true; }
      mesh.material.color.setRGB(...icon.color);
      // The flat overlay (no frame) and the tile chain's inputs (a frame): DrawIcon(Skin, X, Y, size, size, Z 1.0).
      mesh.position.set(icon.x + icon.size / 2, -(icon.y + icon.size / 2), 0);
      mesh.scale.set(icon.size, icon.size, 1);
      inputs.icon.value.set(icon.x, icon.y, icon.size, icon.size);
      inputs.b.value.set(entry.width, entry.height, 1, entry.scale);
      inputs.c.value.set(entry.infoWidth, entry.infoHeight, 0, 0);
      inputs.on.value = 1;
      mesh.visible = true; stats.drawn++;
    }
    camera.right = width; camera.bottom = -height; camera.updateProjectionMatrix();
    for (let i = used; i < pool.length; i++) pool[i].visible = false;
    return stats;
  }
  return {
    stats, notes, update,
    /** The tile meshes, for validators (validate-corona-tiles-play.mjs). */
    get pool() { return pool; },
    render(renderer) { if (used) renderer.render(scene, camera); },
    dispose() { for (const mesh of pool) { mesh.geometry.dispose(); mesh.material.dispose(); } for (const e of textureCache.values()) e.texture?.dispose(); },
  };
}
