import * as THREE from 'three';
import { toView } from '../unreal/geometry.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { sharedProceduralTextures } from './procedural-textures.mjs';

/** Sprites in Play (docs/particles.md "Sprites"), the page's side: the
 * simulation's sprite records (sprite-scan.mjs) drawn as DrawActorSprite
 * (0x10b25080) draws them. A sprite is a screen-aligned tile of
 * Texture.USize·DrawScale by VSize·DrawScale centred on its Location, unlit:
 * white scaled by ScaleGlow and capped at 1 per channel; Style picks masked,
 * translucent (additive) or modulated blending. Textures decode from the
 * page's own asset store. Drawing one stamps its actor's LastRenderTime
 * (0x10b25150) through `stamp(handle)`. */
export function createSpriteScene(assets, textures, { displayGamma, stamp }) {
  const root = new THREE.Group(), pool = [], textureCache = new Map(), notes = new Set();
  root.matrixAutoUpdate = false; root.name = 'Sprites';
  let used = 0;
  // This frame's sprites whose texture has not decoded yet (not drawn).
  const skipped = new Set();
  const STYLE_BLEND = { 2: 'masked', 3: 'translucent', 4: 'modulated' };

  function texture(reference, masked) {
    const key = `${reference.key ?? `${reference.package}:${reference.index}`}:${masked}`;
    let entry = textureCache.get(key);
    if (!entry) {
      entry = { texture: null, width: 0, height: 0 };
      textureCache.set(key, entry);
      assets.get(reference.package).then(asset => textures.get(asset, reference.index, masked)).then(data => {
        // Fire and wet textures (smoke puffs) are the page's live procedural
        // textures, as on BSP surfaces and mesh skins.
        if (data.procedural === 'FireTexture' || data.procedural === 'WetTexture') {
          Object.assign(entry, { texture: sharedProceduralTextures().acquire(data).texture, width: data.values.USize, height: data.values.VSize,
            shared: true });
          return;
        }
        const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
        gpu.colorSpace = THREE.SRGBColorSpace; gpu.flipY = false; gpu.magFilter = THREE.LinearFilter;
        gpu.minFilter = THREE.LinearFilter; gpu.generateMipmaps = false; gpu.needsUpdate = true;
        Object.assign(entry, { texture: gpu, width: data.values.USize ?? first.width, height: data.values.VSize ?? first.height });
      }).catch(error => { entry.failed = error.message; notes.add(`Sprite texture ${key}: ${error.message}`); });
    }
    return entry;
  }

  function sprite() {
    if (used < pool.length) return pool[used++];
    const material = new THREE.SpriteMaterial({ color: 0xffffff, depthWrite: false, transparent: true, fog: false });
    material.userData.blend = null;
    const object = new THREE.Sprite(material);
    object.onAfterRender = () => object.userData.feedback?.();
    root.add(object); pool.push(object); used++;
    return object;
  }

  function blend(material, mode) {
    if (material.userData.blend === mode) return;
    material.userData.blend = mode;
    material.blending = THREE.CustomBlending; material.alphaTest = 0; material.depthWrite = false;
    if (mode === 'translucent') { material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor; }
    else if (mode === 'modulated') { material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor; }
    else { material.blending = THREE.NormalBlending; material.depthWrite = true; material.alphaTest = mode === 'masked' ? 0.5 : 0; }
    material.onBeforeCompile = shader => {
      shader.uniforms.deusDisplayGamma = displayGamma;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
        .replace('#include <colorspace_fragment>', `gl_FragColor = sRGBTransferOETF(gl_FragColor);
          ${displayRampGlsl('deusDisplayGamma', mode === 'modulated')}`);
    };
    material.customProgramCacheKey = () => `deus-sprite-${mode}`;
    material.needsUpdate = true;
  }

  function draw({ handle, texture: reference, style, location, drawScale, scaleGlow, main, frames }, number) {
    const mode = STYLE_BLEND[style] ?? 'normal';
    const entry = texture(reference, mode === 'masked');
    if (!entry.texture) { skipped.add(handle); return; }
    const object = sprite(), material = object.material;
    if (material.map !== entry.texture) { material.map = entry.texture; material.needsUpdate = true; }
    blend(material, mode);
    const glow = Math.max(0, Math.min(1, scaleGlow));
    material.color.setRGB(glow, glow, glow);
    object.position.fromArray(toView(location));
    object.scale.set(entry.width * drawScale, entry.height * drawScale, 1);
    object.visible = true;
    // Whether the main frame's Frame->Sprite holds it (OccludeBsp,
    // sim-session.mjs occludeMain); without occlusion every record is.
    object.userData.main = main !== false;
    // The child frames whose Frame->Sprite holds it (OccludeFrame).
    object.userData.frames = frames ?? null;
    // The record's place in the simulation's list: a ViewportWindow's frames
    // name the records they draw by it (sim-session.mjs planViewportPass).
    object.userData.number = number;
    object.userData.feedback = () => stamp(handle);
  }

  /** One frame: the simulation's sprite records, in its scan order. */
  function update(sprites) {
    used = 0; skipped.clear();
    sprites.forEach((record, number) => draw(record, number));
    for (let i = used; i < pool.length; i++) { pool[i].visible = false; pool[i].userData.feedback = null; }
  }

  /** The main frame draws only its Frame->Sprite records (`on`); the
   * mirror and sky passes draw every record (`on` false). */
  function mainPass(on) {
    for (let i = 0; i < used; i++) pool[i].visible = !on || pool[i].userData.main;
  }
  /** A child frame's pass draws only its Frame->Sprite records (`index`
   * the frame's); null: every record again. */
  function framePass(index) {
    for (let i = 0; i < used; i++) pool[i].visible = index === null || Boolean(pool[i].userData.frames?.includes(index));
  }

  /** A ViewportWindow frame's pass (root or child) draws only the records
   * its own Frame->Sprite holds (`numbers`, their places in the list
   * `update` was given); null: every record again. */
  function numberedPass(numbers) {
    const wanted = numbers ? new Set(numbers) : null;
    for (let i = 0; i < used; i++) pool[i].visible = !wanted || wanted.has(pool[i].userData.number);
  }

  return { root, update, mainPass, framePass, numberedPass, notes, skipped, count: () => used,
    dispose() { for (const object of pool) object.material.dispose(); for (const entry of textureCache.values()) if (!entry.shared) entry.texture?.dispose(); } };
}
