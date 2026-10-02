import * as THREE from 'three';
import {fireTables, firePostLoad, fireConstantTimeTick} from '../runtime/fire-texture.mjs';
import {get as textureFrame} from '../runtime/texture-animation.mjs';
import {createNativeRng} from '../runtime/rng.mjs';

/** Procedural textures in the viewer (docs/fire-texture.md "Play"): one
 * record per FireTexture object with its load state (Serialize, PostLoad:
 * fire-texture.mjs) and UTexture's Update/Tick (texture-animation.mjs) whose
 * ConstantTimeTick is UFireTexture's. `update(time)` runs Get(time) for each,
 * as Render does for every drawn face with Viewport->CurrentTime, and uploads
 * the P8 buffer through the palette when a tick ran.
 *
 * Host choices, noted: every acquired texture updates each frame in
 * acquisition order (the original updates the drawn ones in draw order, and
 * they share one generator), and the module tables take their 512 appRand
 * bytes from a host-seeded MSVCRT stream (the original process's rand
 * position at Fire's first construction is not reproduced). */
export function createProceduralTextures({seed = 0x0f12e} = {}) {
  let globals = null;
  const records = new Map(), notes = new Set();
  const clock = () => performance.now() / 1000;

  function acquire(data) {
    if (data.procedural !== 'FireTexture') throw new Error(`Procedural texture ${data.procedural} is not translated`);
    let record = records.get(data.key);
    if (!record) {
      globals ??= fireTables(createNativeRng(seed).rand);
      const v = data.values, uSize = v.USize | 0, vSize = v.VSize | 0;
      const state = firePostLoad({uBits: v.UBits | 0, uSize, vSize, renderHeat: v.RenderHeat | 0, oldRenderHeat: 0,
        globalPhase: 0, auxPhase: 0, fxFrequency: v.FX_Frequency | 0, bRising: v.bRising ? 1 : 0,
        sparksLimit: v.SparksLimit | 0, activeSparkNum: v.NumSparks | 0, starStatus: 0,
        renderTable: new Uint8Array(1028), pixels: new Uint8Array(uSize * vSize)}, data.fire.sparks);
      const rgba = new Uint8Array(uSize * vSize * 4);
      const texture = new THREE.DataTexture(rgba, uSize, vSize, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
      // PostLoad clears PF_Masked from a fire's PolyFlags; P8 index 0 keeps
      // its palette colour (palette alpha is not surface alpha).
      const palette = data.fire.palette ?? new Uint8Array(1024);
      record = {key: data.key, state, texture, rgba, palette, changed: true,
        // UTexture's animation fields (texture-animation.mjs) with PostLoad's
        // Accumulator 0 and LastUpdateTime at the load clock.
        primeCount: (v.PrimeCount ?? 0) & 255, primeCurrent: 0,
        minFrameRate: Math.fround(v.MinFrameRate ?? 0), maxFrameRate: Math.fround(v.MaxFrameRate ?? 0),
        accumulator: 0, lastUpdateTime: clock(), animCur: null, animNext: null,
        constantTimeTick: r => { fireConstantTimeTick(r.state, globals); r.changed = true; }};
      upload(record);
      records.set(data.key, record);
      notes.add('Fire textures update every frame in acquisition order from a host-seeded generator (docs/fire-texture.md).');
    }
    return {texture: record.texture, release: () => {}};
  }

  function upload(record) {
    const {state, rgba, palette} = record;
    for (let p = 0, n = state.pixels.length; p < n; p++) {
      const c = state.pixels[p] * 4, o = p * 4;
      rgba[o] = palette[c]; rgba[o + 1] = palette[c + 1]; rgba[o + 2] = palette[c + 2]; rgba[o + 3] = 255;
    }
    record.texture.needsUpdate = true;
    record.changed = false;
  }

  return {
    acquire, notes,
    /** Get(Viewport->CurrentTime) for every fire, then the uploads. */
    update(time = clock()) {
      for (const record of records.values()) {
        textureFrame(record, time);
        if (record.changed) upload(record);
      }
    },
    records: () => [...records.values()].map(r => ({key: r.key, sparks: r.state.activeSparkNum, size: [r.state.uSize, r.state.vSize],
      phase: r.state.globalPhase, checksum: r.state.pixels.reduce((sum, value, index) => (sum + value * (index + 1)) >>> 0, 0)})),
    dispose() { for (const record of records.values()) record.texture.dispose(); records.clear(); },
  };
}
