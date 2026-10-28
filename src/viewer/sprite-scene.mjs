import * as THREE from 'three';
import { textureColorSpace, REENCODE_GLSL } from './original-sampling.mjs';
import { toView } from '../unreal/geometry.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { sharedProceduralTextures } from './procedural-textures.mjs';
import { frameProjection } from './frame-projection.mjs';
import { actorPassRenderOrder } from './render-layers.mjs';

const STYLE_BLEND = { 2: 'masked', 3: 'translucent', 4: 'modulated' };

/** A pooled sprite (createSpriteScene), the shader warm-up's too (spriteWarmup). */
function spriteObject() {
  const material = new THREE.SpriteMaterial({ color: 0xffffff, depthWrite: false, transparent: true, fog: false, side: THREE.DoubleSide });
  material.userData.blend = null;
  // This sprite's tile inputs for the pass being drawn (frameProjection.patchSprite).
  material.userData.tile = { on: { value: 0 }, a: { value: new THREE.Vector4() }, b: { value: new THREE.Vector4() }, c: { value: new THREE.Vector4() } };
  return new THREE.Sprite(material);
}

/** A sprite material's blending for its Style (`mode`: normal, masked, translucent or modulated). */
function spriteBlend(material, mode, displayGamma) {
  if (material.userData.blend === mode) return;
  material.userData.blend = mode;
  material.blending = THREE.CustomBlending; material.alphaTest = 0; material.depthWrite = false;
  if (mode === 'translucent') { material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcColorFactor; }
  else if (mode === 'modulated') { material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor; }
  else { material.blending = THREE.NormalBlending; material.depthWrite = true; material.alphaTest = mode === 'masked' ? 0.5 : 0; }
  material.onBeforeCompile = shader => {
    shader.uniforms.deusDisplayGamma = displayGamma;
    frameProjection.patchSprite(shader, material.userData.tile);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;')
      .replace('#include <colorspace_fragment>', `${REENCODE_GLSL}
        ${displayRampGlsl('deusDisplayGamma', mode === 'modulated')}`);
  };
  material.customProgramCacheKey = () => `deus-sprite-${mode}-fp1`;
  material.needsUpdate = true;
}

/** The shader warm-up's sprites (shader-warmup.mjs): one per Style's blending, with a map, as draw leaves them. */
export function spriteWarmup({ displayGamma, texture }) {
  return ['normal', ...Object.values(STYLE_BLEND)].map(mode => {
    const object = spriteObject();
    object.material.map = texture; spriteBlend(object.material, mode, displayGamma);
    return object;
  });
}

/** Sprites in Play (docs/particles.md "Sprites"), the page's side: the
 * simulation's sprite records (sprite-scan.mjs) drawn as DrawActorSprite
 * (0x10b25080) draws them. A sprite is a screen-aligned tile of
 * Texture.USize·DrawScale by VSize·DrawScale centred on its Location, unlit:
 * white scaled by ScaleGlow and capped at 1 per channel; Style picks masked,
 * translucent (additive) or modulated blending. Textures decode from the
 * page's own asset store. Drawing one stamps its actor's LastRenderTime
 * (0x10b25150) through `stamp(handle)`.
 *
 * In a pass with a frame (docs/frame-projection.md "Sprites") a record that
 * carries FDynamicSprite::Setup's floats for that frame (`screens`, the
 * simulation side's) is the original's tile instead: the vertex shader builds
 * DrawActorSprite's rectangle, UCanvas::DrawTile's clip and D3DDrv's four vertices
 * from them (frameProjection.patchSprite); the billboard remains for a pass without
 * a frame (a ViewportWindow's, Inspect). */
export function createSpriteScene(assets, textures, { displayGamma, stamp }) {
  const root = new THREE.Group(), pool = [], textureCache = new Map(), notes = new Set();
  root.matrixAutoUpdate = false; root.name = 'Sprites';
  let used = 0;
  // This frame's sprites whose texture has not decoded yet (not drawn).
  const skipped = new Set();

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
            infoWidth: data.values.USize, infoHeight: data.values.VSize, scale: Math.fround(data.values.DrawScale ?? data.values.Scale ?? 1), shared: true });
          return;
        }
        const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
        gpu.colorSpace = textureColorSpace(); gpu.flipY = false; gpu.magFilter = THREE.LinearFilter;
        gpu.minFilter = THREE.LinearFilter; gpu.generateMipmaps = false; gpu.needsUpdate = true;
        // UTexture::Lock at LOD 0: Info is mip 0, UScale = VScale = Scale (the packages' DrawScale).
        Object.assign(entry, { texture: gpu, width: data.values.USize ?? first.width, height: data.values.VSize ?? first.height,
          infoWidth: first.width, infoHeight: first.height, scale: Math.fround(data.values.DrawScale ?? data.values.Scale ?? 1) });
      }).catch(error => { entry.failed = error.message; notes.add(`Sprite texture ${key}: ${error.message}`); });
    }
    return entry;
  }

  function sprite() {
    if (used < pool.length) return pool[used++];
    const object = spriteObject();
    object.onAfterRender = () => object.userData.feedback?.();
    root.add(object); pool.push(object); used++;
    return object;
  }

  function draw({ handle, texture: reference, style, location, drawScale, scaleGlow, main, frames, screens }, number) {
    const mode = STYLE_BLEND[style] ?? 'normal';
    const entry = texture(reference, mode === 'masked');
    if (!entry.texture) { skipped.add(handle); return; }
    const object = sprite(), material = object.material;
    if (material.map !== entry.texture) { material.map = entry.texture; material.needsUpdate = true; }
    spriteBlend(material, mode, displayGamma);
    // DrawFrame's sprite pass for the actor's Style (render-layers.mjs ACTOR_PASS_RENDER_ORDER).
    object.renderOrder = actorPassRenderOrder(style);
    const glow = Math.max(0, Math.min(1, scaleGlow));
    material.color.setRGB(glow, glow, glow);
    object.position.fromArray(toView(location));
    object.scale.set(entry.width * drawScale, entry.height * drawScale, 1);
    // The tile's texture inputs; the Setup floats of the frame being drawn arrive with the pass (setFrame).
    const tile = material.userData.tile;
    tile.b.value.set(entry.width, entry.height, drawScale, entry.scale ?? 1);
    tile.c.value.set(entry.infoWidth ?? entry.width, entry.infoHeight ?? entry.height, 0, 0);
    object.userData.screens = screens ?? null;
    tile.on.value = 0;
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

  /** The Setup floats of `frame` (0 the root's) for every sprite that has them, as
   * the tile inputs of the next draw; null: the billboards. */
  function setFrame(frame) {
    for (let i = 0; i < used; i++) {
      const tile = pool[i].material.userData.tile, screen = frame === null ? null : pool[i].userData.screens?.[frame];
      if (screen) { tile.a.value.set(screen[0], screen[1], screen[2], screen[3]); tile.on.value = 1; } else tile.on.value = 0;
    }
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
    setFrame(on ? 0 : null);
  }
  /** A child frame's pass draws only its Frame->Sprite records (`index`
   * the frame's); null: every record again. */
  function framePass(index) {
    for (let i = 0; i < used; i++) pool[i].visible = index === null || Boolean(pool[i].userData.frames?.includes(index));
    setFrame(index);
  }

  /** A ViewportWindow frame's pass (root or child) draws only the records
   * its own Frame->Sprite holds (`numbers`, their places in the list
   * `update` was given); null: every record again. */
  function numberedPass(numbers) {
    const wanted = numbers ? new Set(numbers) : null;
    for (let i = 0; i < used; i++) pool[i].visible = !wanted || wanted.has(pool[i].userData.number);
    setFrame(null);
  }

  return { root, update, mainPass, framePass, numberedPass, notes, skipped, count: () => used,
    dispose() { for (const object of pool) object.material.dispose(); for (const entry of textureCache.values()) if (!entry.shared) entry.texture?.dispose(); } };
}
