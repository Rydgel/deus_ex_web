import * as THREE from 'three';
import { textureColorSpace } from './original-sampling.mjs';
import {fireTables, firePostLoad, fireConstantTimeTick, waterConstruct, wetPostLoad, wetConstantTimeTick}
  from '../runtime/fire-texture.mjs';
import {get as textureFrame} from '../runtime/texture-animation.mjs';
import {createNativeRng} from '../runtime/rng.mjs';
import {scriptVmKernel} from '../runtime/script-vm-kernel.mjs';
import {createFireKernel} from '../runtime/fire-texture-kernel.mjs';

/** The ticks run in the Rust core (fire-texture-kernel.mjs) when the
 * script-VM kernel is loaded at the first acquisition; FIRE_KERNEL=js in
 * Node or ?fireKernel=js in the viewer keeps fire-texture.mjs's bodies. */
const fireKernelMode = () => (typeof process !== 'undefined' && process.env?.FIRE_KERNEL)
  || globalThis.DEUS_EX_FIRE_KERNEL || 'rust';

/** Procedural textures in the viewer (docs/fire-texture.md "Play"): one
 * record per FireTexture or WetTexture object with its load state
 * (constructor, Serialize, PostLoad: fire-texture.mjs) and UTexture's
 * Update/Tick (texture-animation.mjs) whose ConstantTimeTick is the class's.
 * `update(time)` runs Get(time) for each, as Render does for every drawn face
 * with Viewport->CurrentTime, and uploads the P8 buffer through the palette
 * when a tick ran.
 *
 * Host choices, noted: every acquired texture updates each frame in
 * acquisition order (the original updates the drawn ones in draw order, and
 * they share one generator), and the module tables take their 512 appRand
 * bytes from a host-seeded MSVCRT stream (the original process's rand
 * position at Fire's first construction is not reproduced).
 *
 * `kernel`: the script-VM kernel whose fire.rs runs the ticks, null for the
 * JavaScript bodies, or undefined to decide at the first acquisition (see
 * fireKernelMode). The choice holds for the set: its textures share one
 * generator. */
export function createProceduralTextures({seed = 0x0f12e, kernel} = {}) {
  let globals = null, rust = null, kernelGlobals = null, heldKind = null;
  const records = new Map(), notes = new Set();
  const clock = () => performance.now() / 1000;

  function fireState(data) {
    const v = data.values, uSize = v.USize | 0, vSize = v.VSize | 0;
    // The constructors' transient state (UFractalTexture 0x10507520,
    // UFireTexture 0x10507840): phases 0, OldRenderHeat -1 (so PostLoad
    // always builds RenderTable), StarStatus 1.
    const state = firePostLoad({uBits: v.UBits | 0, uSize, vSize, renderHeat: v.RenderHeat | 0, oldRenderHeat: -1,
      globalPhase: v.GlobalPhase | 0, auxPhase: 0, fxFrequency: v.FX_Frequency | 0, bRising: v.bRising ? 1 : 0,
      sparksLimit: v.SparksLimit | 0, activeSparkNum: v.NumSparks | 0, starStatus: 1,
      renderTable: new Uint8Array(1028), pixels: new Uint8Array(uSize * vSize)}, data.fire.sparks);
    // PostLoad clears PF_Masked from a fire's PolyFlags; P8 index 0 keeps
    // its palette colour (palette alpha is not surface alpha).
    const moved = rust?.fire(state, kernelGlobals);
    if (moved) return {state: moved.state, palette: () => data.fire.palette, tick: moved.tick, expand: moved.expand};
    return {state, palette: () => data.fire.palette, tick: () => fireConstantTimeTick(state, globals)};
  }

  function wetState(data) {
    // A masked use would need index 0 cut out of one shared state's upload.
    if (data.masked) throw new Error(`Masked WetTexture use is not supported: ${data.key}`);
    const v = data.values, uSize = v.USize | 0, vSize = v.VSize | 0, {source} = data.wet;
    // UWaterTexture/UWetTexture's constructors (WaveTable, OldWaveAmp -1,
    // no LocalSourceBitmap), Serialize's zeroed mip 0, then PostLoad.
    const state = waterConstruct({uBits: v.UBits | 0, vBits: v.VBits | 0, uSize, vSize, globalPhase: v.GlobalPhase | 0,
      waveAmp: v.WaveAmp | 0, numDrops: v.NumDrops | 0, drops: data.wet.drops, renderTable: new Uint8Array(1028),
      pixels: new Uint8Array(uSize * vSize), palette: data.wet.palette, oldSource: null, local: null,
      source: source && {uBits: source.uBits, vBits: source.vBits, palette: source.palette, pixels: source.pixels}});
    state.globalPhase = v.GlobalPhase | 0;
    wetPostLoad(state);
    const moved = rust?.wet(state, kernelGlobals);
    if (moved) return {state: moved.state, palette: () => moved.state.palette, tick: moved.tick, expand: moved.expand};
    return {state, palette: () => state.palette, tick: () => wetConstantTimeTick(state, globals)};
  }

  function acquire(data) {
    let record = records.get(data.key);
    if (!record) {
      if (!globals) {
        globals = fireTables(createNativeRng(seed).rand);
        const chosen = kernel !== undefined ? kernel : fireKernelMode() === 'js' ? null : scriptVmKernel;
        rust = chosen ? createFireKernel(chosen) : null;
        kernelGlobals = rust?.globals(globals);
      }
      const kind = data.procedural === 'FireTexture' ? fireState : data.procedural === 'WetTexture' ? wetState : null;
      if (!kind) throw new Error(`Procedural texture ${data.procedural} is not translated`);
      const {state, palette, tick, expand = null} = kind(data), uSize = state.uSize, vSize = state.vSize, v = data.values;
      const rgba = new Uint8Array(uSize * vSize * 4);
      const texture = new THREE.DataTexture(rgba, uSize, vSize, THREE.RGBAFormat);
      texture.colorSpace = textureColorSpace(); texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
      record = {key: data.key, kind: data.procedural, state, texture, rgba, palette, expand, changed: true,
        // UTexture's animation fields (texture-animation.mjs) with PostLoad's
        // Accumulator 0 and LastUpdateTime at the load clock.
        primeCount: (v.PrimeCount ?? 0) & 255, primeCurrent: 0,
        minFrameRate: Math.fround(v.MinFrameRate ?? 0), maxFrameRate: Math.fround(v.MaxFrameRate ?? 0),
        accumulator: 0, lastUpdateTime: clock(), animCur: null, animNext: null,
        constantTimeTick: r => { tick(); r.changed = true; }};
      upload(record);
      records.set(data.key, record);
      notes.add('Fire and wet textures update every frame in acquisition order from a host-seeded generator (docs/fire-texture.md).');
    }
    return {texture: record.texture, release: () => {}};
  }

  function upload(record) {
    const {state, rgba} = record, palette = record.palette() ?? BLACK;
    if (record.expand) record.expand(palette, rgba);
    else for (let p = 0, n = state.pixels.length; p < n; p++) {
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
        if (record.kind !== heldKind) textureFrame(record, time);
        if (record.changed) upload(record);
      }
    },
    /** A held frame against the original's (docs/visual-acceptance.md "04_NYC_Street's steam vents"): `hold({kind, pixels})` stops the
     * ticks of every texture of that kind, as the tracer's `fire hold` stops UFireTexture::ConstantTimeTick in the original, and writes
     * into the named textures (the object name, the key's last part) the P8 pixels read there (`dx-live-win fire read`, hex): a measured
     * host input, as the stream state of a replayed tick. `hold(null)` lets them tick again. Returns each name's written size or why not. */
    hold(spec) {
      heldKind = spec ? spec.kind ?? 'FireTexture' : null;
      const written = {};
      for (const [name, hex] of Object.entries(spec?.pixels ?? {})) {
        const record = [...records.values()].find(r => r.key.split('.').pop().toLowerCase() === name.toLowerCase());
        if (!record) { written[name] = 'not acquired'; continue; }
        const pixels = record.state.pixels;
        if (hex.length !== 2 * pixels.length) { written[name] = `${hex.length / 2} bytes for ${pixels.length}`; continue; }
        for (let i = 0; i < pixels.length; i++) pixels[i] = parseInt(hex.substr(2 * i, 2), 16);
        upload(record);
        written[name] = pixels.length;
      }
      return {held: heldKind, written};
    },
    /** Validation (validate-fire-texture-rust): the raw records in
     * acquisition order, the shared module state, and `step(record)`, one
     * ConstantTimeTick and its upload. */
    inspect: () => ({records: [...records.values()], globals, upload,
      step: record => { record.constantTimeTick(record); upload(record); }}),
    records: () => [...records.values()].map(r => ({key: r.key, kind: r.kind, backend: r.expand ? 'rust' : 'js',
      sparks: r.state.activeSparkNum, size: [r.state.uSize, r.state.vSize],
      phase: r.state.globalPhase, checksum: r.state.pixels.reduce((sum, value, index) => (sum + value * (index + 1)) >>> 0, 0)})),
    dispose() { for (const record of records.values()) record.texture.dispose(); records.clear(); },
  };
}

const BLACK = new Uint8Array(1024);
let shared = null;
/** The page's one procedural texture set: a texture object has one state
 * whether BSP surfaces or mesh skins draw it, as in the original. */
export function sharedProceduralTextures() { return shared ??= createProceduralTextures(); }
