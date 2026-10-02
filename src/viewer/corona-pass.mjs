import * as THREE from 'three';
import { getAxes } from '../runtime/camera.mjs';
import { coordsTransform } from '../runtime/volumetric-fog.mjs';
import { createCoronaCache, coronaDecay, coronaSeen, coronaIcon } from '../runtime/coronas.mjs';
import { displayRampGlsl } from './light-atlas.mjs';

/** Light coronas in Play (docs/coronas.md "Play"): DrawFrame's corona pass
 * each main frame (top level only, D3D's default Coronas=True). The lights
 * permeating the player's leaf go through the original visibility helper
 * with Play's SingleLineCheck; live entries draw as screen tiles with the
 * canvas's translucent blend (ONE, INVSRCCOLOR) after the world.
 *
 * Host choices, noted: the fade clock is the host's (appSeconds is the CPU
 * clock in the original too); the frame precomputes (FX2, FY2, Proj.Z,
 * Frame.X) come from Play's canvas size and the view FOV; dynamic lights in
 * the leaf (LeafLights) are not visited; the display gamma ramp applies per
 * fragment of the tile. */
export function createCoronaPass(runtime, textures, { model, exportName, player, displayGamma }) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1, 1);
  const cache = createCoronaCache(), pool = [], textureCache = new Map(), notes = new Set(), byName = new Map();
  const stats = { leafLights: 0, visible: 0, drawn: 0 };
  let used = 0;
  const read = (actor, name) => runtime.readNamed(actor, name);

  function texture(reference) {
    const key = `${reference.asset?.name}:${reference.index}`;
    let entry = textureCache.get(key);
    if (!entry) {
      entry = { texture: null };
      textureCache.set(key, entry);
      textures.get(reference.asset, reference.index, false).then(data => {
        const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
        gpu.colorSpace = THREE.SRGBColorSpace; gpu.flipY = false; gpu.magFilter = gpu.minFilter = THREE.LinearFilter;
        gpu.generateMipmaps = false; gpu.needsUpdate = true;
        entry.texture = gpu;
      }).catch(error => notes.add(`Corona texture ${key}: ${error.message}`));
    }
    return entry.texture;
  }
  function tile() {
    if (used < pool.length) return pool[used++];
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    material.blending = THREE.CustomBlending; material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor;
    material.onBeforeCompile = shader => {
      shader.uniforms.deusDisplayGamma = displayGamma;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
        .replace('#include <colorspace_fragment>', `gl_FragColor = sRGBTransferOETF(gl_FragColor);
          ${displayRampGlsl('deusDisplayGamma', false)}`);
    };
    material.customProgramCacheKey = () => 'deus-corona-v1';
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.frustumCulled = false;
    scene.add(mesh); pool.push(mesh); used++;
    return mesh;
  }
  // Model.Lights holds export references in null-terminated lists.
  function leafLights(leaf) {
    const start = model.leaves[leaf]?.permeating ?? -1, out = [];
    if (start < 0) return out;
    for (let i = start; i < model.lights.length && model.lights[i]; i++) out.push(model.lights[i]);
    return out;
  }
  function actorFor(ref, level) {
    const name = exportName(ref);
    let actor = byName.get(name);
    if (!actor || !level.actors.includes(actor)) {
      actor = level.actors.find(candidate => candidate?.name === name) ?? null;
      byName.set(name, actor);
    }
    return actor;
  }

  /** One main frame: `view` {location, rotation, fov} and the drawn size. */
  function update(view, width, height) {
    used = 0; stats.leafLights = 0; stats.visible = 0; stats.drawn = 0;
    const viewer = player(), level = viewer ? runtime.levelFor(viewer) : null;
    const region = viewer ? runtime.regionValue(viewer) : null;
    if (!level?.hash || !region || region.leaf === -1 || !region.zone) return finish();
    const delta = coronaDecay(cache, performance.now() / 1000);
    const eye = view.location.map(Math.fround), slot = { next: 0 };
    for (const ref of leafLights(region.leaf)) {
      const light = actorFor(ref, level);
      if (!light) continue;
      stats.leafLights++;
      const location = read(light, 'Location').map(Math.fround);
      let visible = level.hash.lineCheck(eye, location, [0, 0, 0], 6, 0, null).outside;
      if (visible) {
        const hit = level.hash.lineCheck(eye, location, [0, 0, 0], 0x11, 0, null);
        visible = hit.outside || hit.actor === viewer;
      }
      if (visible) stats.visible++;
      coronaSeen(cache, slot, light, { visible, delta,
        qualifies: Boolean(read(light, 'bCorona')) && Boolean(read(light, 'Skin')) && !read(light, 'bDeleteMe'),
        actorIndex: () => level.actors.indexOf(light) });
    }
    const [x, y, z] = getAxes(view.rotation.map(v => v | 0));
    const coords = { origin: eye, x: y, y: z.map(v => -v), z: x };
    const fx2 = Math.fround(width / 2), fy2 = Math.fround(height / 2);
    const frame = { fx2, fy2, projZ: Math.fround(fx2 / Math.tan(view.fov * Math.PI / 360)), width };
    for (const entry of cache.entries) {
      if (entry.actor == null || level.actors[entry.index] !== entry.actor) continue;
      const light = entry.actor;
      const icon = coronaIcon(entry, coordsTransform(read(light, 'Location').map(Math.fround), coords), frame,
        { hue: read(light, 'LightHue'), saturation: read(light, 'LightSaturation'), drawScale: Math.fround(read(light, 'DrawScale')) });
      const skin = read(light, 'Skin'), map = icon && skin ? texture(skin) : null;
      if (!map) continue;
      const mesh = tile();
      if (mesh.material.map !== map) { mesh.material.map = map; mesh.material.needsUpdate = true; }
      mesh.material.color.setRGB(...icon.color);
      mesh.position.set(icon.x + icon.size / 2, -(icon.y + icon.size / 2), 0);
      mesh.scale.set(icon.size, icon.size, 1);
      mesh.visible = true; stats.drawn++;
    }
    camera.right = width; camera.bottom = -height; camera.updateProjectionMatrix();
    return finish();
  }
  function finish() {
    for (let i = used; i < pool.length; i++) pool[i].visible = false;
    return stats;
  }
  return {
    stats, notes, update,
    render(renderer) { if (used) renderer.render(scene, camera); },
    dispose() { for (const mesh of pool) { mesh.geometry.dispose(); mesh.material.dispose(); } for (const e of textureCache.values()) e.texture?.dispose(); },
  };
}
