import * as THREE from 'three';
import { toView } from '../unreal/geometry.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { ensureRenderInterface, particleIteratorItems } from '../runtime/script-particles.mjs';
import { laserIteratorItems } from '../runtime/script-laser.mjs';
import { sharedProceduralTextures } from './procedural-textures.mjs';
import { RENDER_ITERATOR, RENDER_SPRITE } from '../runtime/script-vm-render.mjs';

/** Sprites in Play (docs/particles.md "Sprites"): URender::SetupDynamics'
 * actor scan in array order (docs/render-visibility.md admission), with
 * RenderIterator actors expanded through the iterator protocol, and
 * DrawActorSprite (0x10b25080) for each DT_Sprite item. A sprite is a
 * screen-aligned tile of Texture.USize·DrawScale by VSize·DrawScale centred
 * on its Location, unlit: white scaled by ScaleGlow and capped at 1 per
 * channel; Style picks masked, translucent (additive) or modulated
 * blending. Drawing one writes its actor's LastRenderTime (0x10b25150).
 *
 * A LaserIterator's items are DT_Mesh LaserProxy snapshots (docs/lasers.md);
 * update() returns them, in order, for the actor mesh scene to draw.
 *
 * Not translated yet, noted: DT_SpriteAnimOnce's frame choice, iterator
 * classes other than ParticleIterator and LaserIterator, the bHighDetail
 * rule and fog. */
export function createSpriteScene(runtime, textures, { player, displayGamma, constructIterator, frand }) {
  const root = new THREE.Group(), pool = [], textureCache = new Map(), notes = new Set();
  root.matrixAutoUpdate = false; root.name = 'Sprites';
  let used = 0;
  const STYLE_BLEND = { 2: 'masked', 3: 'translucent', 4: 'modulated' };

  function texture(reference, masked) {
    const key = `${reference.key ?? `${reference.asset?.name}:${reference.index}`}:${masked}`;
    let entry = textureCache.get(key);
    if (!entry) {
      entry = { texture: null, width: 0, height: 0 };
      textureCache.set(key, entry);
      textures.get(reference.asset, reference.index, masked).then(data => {
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

  function draw(actor, { location, drawScale, scaleGlow }, timeRef) {
    const reference = runtime.readNamed(actor, 'Texture');
    if (!reference) return;
    const style = runtime.readNamed(actor, 'Style') & 255, mode = STYLE_BLEND[style] ?? 'normal';
    const entry = texture(reference, mode === 'masked');
    if (!entry.texture) return;
    const object = sprite(), material = object.material;
    if (material.map !== entry.texture) { material.map = entry.texture; material.needsUpdate = true; }
    blend(material, mode);
    const glow = Math.max(0, Math.min(1, scaleGlow));
    material.color.setRGB(glow, glow, glow);
    object.position.fromArray(toView(location));
    object.scale.set(entry.width * drawScale, entry.height * drawScale, 1);
    object.visible = true;
    object.userData.feedback = () => runtime.writeNamed(actor, 'LastRenderTime', Math.fround(timeRef()));
  }

  /** One frame: the level actor array in order, after the tick. Returns the
   * iterator items that draw as meshes. */
  function update({ firstPerson = true } = {}) {
    used = 0;
    const meshItems = [];
    const viewer = player(), level = runtime.levelFor(viewer), info = level.actors[0];
    const time = () => runtime.readNamed(info, 'TimeSeconds');
    const read = (actor, name) => runtime.readNamed(actor, name);
    // The render scan (script-vm-render.mjs) leaves the actors visit()
    // would draw or iterate, plus those it hands back, and stops after an
    // iterator: an iterator may run script, so the scan resumes after it with
    // the viewer's ViewTarget read again. Without it, every actor in order.
    const actors = level.actors, render = runtime.scriptVm?.render ?? null;
    const visit = actor => {
      if (!actor || actor === viewer) return;
      let hidden;
      try { hidden = read(actor, 'bHidden'); } catch { return; }
      if (hidden) return;
      if (firstPerson && read(viewer, 'ViewTarget') === actor) return;
      if (read(actor, 'bOnlyOwnerSee')) {
        let owned = false;
        for (let owner = actor; owner; owner = read(owner, 'Owner')) if (owner === viewer) { owned = true; break; }
        if (!owned || !firstPerson) return;
      }
      if (read(actor, 'bOwnerNoSee') && firstPerson && read(actor, 'Owner') === viewer) return;
      if (read(actor, 'RenderIteratorClass')) {
        const iterator = ensureRenderInterface(runtime, actor, constructIterator);
        if (!iterator) return;
        const kind = runtime.instance(iterator).cls.record.key;
        if (kind === 'deusex.laseriterator') {
          for (const item of laserIteratorItems(runtime, iterator, actor, viewer, {
            processEvent: (receiver, name, args) => runtime.processNativeEvent(receiver, name, args), frand })) {
            const drawType = read(item.actor, 'DrawType') & 255;
            if (drawType === 2) meshItems.push(item);
            else if (drawType === 1 || drawType === 7) draw(item.actor, item, time);
          }
          return;
        }
        if (kind !== 'deusex.particleiterator') {
          notes.add(`RenderIterator ${kind} is not translated.`);
          return;
        }
        for (const item of particleIteratorItems(runtime, iterator, viewer, {
          processEvent: (receiver, name, args) => runtime.processNativeEvent(receiver, name, args),
          farMoveActor: (target, destination) => runtime.farMoveActor(target, destination, 0, 0) })) {
          if ([1, 7].includes(read(item.actor, 'DrawType') & 255)) draw(item.actor, item, time);
        }
        return;
      }
      const drawType = read(actor, 'DrawType') & 255;
      if (drawType !== 1 && drawType !== 7) return;
      if (drawType === 7) notes.add('DT_SpriteAnimOnce sprites draw their first frame; the LifeSpan frame choice is not translated.');
      draw(actor, { location: read(actor, 'Location').map(Math.fround), drawScale: Math.fround(read(actor, 'DrawScale')),
        scaleGlow: Math.fround(read(actor, 'ScaleGlow')) }, time);
    };
    for (let start = 0; ;) {
      const entries = render?.scan(actors, { start, kinds: RENDER_SPRITE | RENDER_ITERATOR, viewer,
        viewTarget: firstPerson ? read(viewer, 'ViewTarget') : null, firstPerson }) ?? null;
      if (!entries) { for (let i = start; i < actors.length; i++) visit(actors[i]); break; }
      for (const entry of entries) visit(actors[entry >>> 5]);
      const last = entries[entries.length - 1];
      if (!entries.length || !(last & RENDER_ITERATOR)) break;
      start = (last >>> 5) + 1;
    }
    for (let i = used; i < pool.length; i++) { pool[i].visible = false; pool[i].userData.feedback = null; }
    return meshItems;
  }

  return { root, update, notes, count: () => used,
    dispose() { for (const object of pool) object.material.dispose(); for (const entry of textureCache.values()) if (!entry.shared) entry.texture?.dispose(); } };
}
