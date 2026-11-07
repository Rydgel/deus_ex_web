/** The per-frame class 1 light-map merge in the Rust core
 * (native/script-vm/src/light.rs, docs/static-lighting.md "Rust kernel").
 *
 * static-lighting.mjs `animateLightMap` stays the reference. `register`
 * copies a light map's static bytes, current texels and its animated lights'
 * cached spatial bytes into a block of the script-VM kernel's memory;
 * `animate` then has the reference's contract: it writes the record's texels
 * (the JavaScript array, from the block, when a byte changed) and returns the
 * changed union rectangle or null.
 *
 * What stays in JavaScript, and why it is the same:
 * - The GlobalLighting constants: `animatedLightConstants`, the reference's
 *   own function and per-frame cache, called for every light of each merged
 *   light map in list order, so Strobe's shared flag flips on the same
 *   frames.
 * - The memo: the reference compares a string of each light's three colour
 *   steps and its noise input (`A<frameIndex>` for Torch/FireWaver,
 *   `W<noise version>` for WateryShimmer, nothing otherwise). For numbers
 *   String(a) === String(b) exactly when a === b or both are NaN, and a
 *   light's token kind is fixed by its effect, so the same test runs on the
 *   numbers kept in a Float64Array. A spatially dynamic light's token is
 *   the frame's TimeSeconds (`T<timeSeconds>`).
 * - Which light maps merge, and the float samples (lighting.mjs).
 *
 * Moved: the colour tables (built from the steps in light.rs when they are
 * int32 integers, else the reference's lazy `tables` are copied), the
 * modulation tables (reset by the reference's rule: a new frame object, or
 * a new frameIndex for effects 1-2 or noise version for effect 3, from the
 * frame's factors at that first use), the union reset, the merge and the
 * comparison, and the spatially dynamic lights' bytes (spatial.rs, rerun
 * inside the merge when TimeSeconds changes, from a parameter record and
 * the light's illumination bytes kept in the block).
 *
 * Blocks come from a per-instance pool of 1 MiB chunks of `kernel.light`
 * memory, all freed by `dispose`. validate-light-animation-rust compares the
 * two every frame. */
import { animatedLightConstants } from './static-lighting.mjs';

// An effect's modulation block (moving.rs): its 256 factors (doubles), a byte a table entry that says it is made this frame, and
// the entries; the merge makes the entries it reads (light.rs). Offsets of the table's bytes within the block.
const MOD_VALUE = 2048 + 65536, MOD_BYTES = 2048 + 2 * 65536;
// ?lightModulation=table (LIGHT_MODULATION=table in Node) makes the whole table of an effect at once, as the reference does, where the
// default makes the entries a merge reads (docs/static-lighting.md "Rust kernel"). Read when the frame's table is reset.
const wholeTables = () => ((typeof process !== 'undefined' && process.env?.LIGHT_MODULATION) || globalThis.DEUS_EX_LIGHT_MODULATION) === 'table';

const HEADER = 8, LIGHT_WORDS = 8, CHUNK = 1 << 20;
// spatial.rs's per-texel cache (eight words a texel) for rectangles up to
// this many texels; a larger one is recomputed whole every frame.
const CACHE_TEXELS = 1 << 16;
// Two numbers with the same String() (the reference's memo signature).
const equal = (a, b) => a === b || (a !== a && b !== b);
const INT32 = step => Number.isInteger(step) && step >= -0x80000000 && step <= 0x7fffffff;

export function createLightAnimationKernel(kernel) {
  const light = kernel.light, memory = light.memory, spatial = kernel.spatial;
  const timeBits = new Uint32Array(1), timeFloat = new Float32Array(timeBits.buffer);
  let buffer = null, u8 = null, u32 = null, f64 = null;
  const sync = () => {
    if (memory.buffer !== buffer) {
      buffer = memory.buffer; u8 = new Uint8Array(buffer); u32 = new Uint32Array(buffer); f64 = new Float64Array(buffer);
    }
  };
  // The pool: whole chunks (or one block for a larger request), bumped.
  const blocks = [];
  let next = 0, end = 0, disposed = false;
  const take = bytes => {
    if (disposed) throw new Error('The light animation kernel was disposed');
    bytes = (bytes + 15) & ~15;
    if (bytes > CHUNK) { const at = light.alloc(bytes); blocks.push(at); return at; }
    if (next + bytes > end) { next = light.alloc(CHUNK); end = next + CHUNK; blocks.push(next); }
    const at = next;
    next += bytes;
    return at;
  };
  // One colour-table slot (3·256 bytes) per light actor, with the constants
  // object whose tables it holds.
  const slots = new Map();
  // Effects 1-3's modulation blocks, one after the other.
  let modulation = 0;
  const built = { 1: { frame: null, version: -1 }, 2: { frame: null, version: -1 }, 3: { frame: null, version: -1 } };
  let scratch = 0, scratchBytes = 0;
  // The atlas words of `pack`: a block that grows, and a view of it.
  let packAt = 0, packCapacity = 0, packView = null;

  function upload(slot, constants) {
    const { steps } = constants;
    if (steps.length !== 3) throw new Error(`A light's colour has ${steps.length} steps`);
    if (INT32(steps[0]) && INT32(steps[1]) && INT32(steps[2])) light.colourTables(slot.at, steps[0], steps[1], steps[2]);
    else { sync(); const [r, g, b] = constants.tables; u8.set(r, slot.at); u8.set(g, slot.at + 256); u8.set(b, slot.at + 512); }
    slot.constants = constants;
  }

  function ensureModulation(frame, effect) {
    const version = effect === 3 ? frame.noise.version : frame.frameIndex, state = built[effect];
    if (state.frame === frame && state.version === version) return;
    sync();
    const block = modulation + (effect - 1) * MOD_BYTES;
    f64.set(frame.factors[effect], block >> 3);
    light.modulationBegin(block);
    if (wholeTables()) light.modulationFill(block);
    state.frame = frame; state.version = version;
  }

  return {
    /** A light map's kernel state from its static bytes, current texels and
     * staticLightMap's `animated` list, or null when the block layout cannot
     * hold it exactly (the reference then keeps merging it). `previous` (the
     * record's last handle) lends its block when the new layout fits. */
    register(base, width, animated, texels, previous = null) {
      if (!Number.isInteger(width) || width < 1 || !(base instanceof Uint8Array) || !(texels instanceof Uint8Array)
        || base.length !== texels.length || base.length % (width * 3) || !animated.length) return null;
      const height = base.length / (width * 3);
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
      for (const { rect, spatial: bytes, effect, spatialDynamic } of animated) {
        const { minU: u0, maxU: u1, minV: v0, maxV: v1 } = rect;
        if (![u0, u1, v0, v1].every(Number.isInteger) || !(u0 >= 0 && u0 < u1 && u1 <= width && v0 >= 0 && v0 < v1 && v1 <= height)
          || !(bytes instanceof Uint8Array) || bytes.length !== (u1 - u0) * (v1 - v0) || !Number.isInteger(effect)) return null;
        if (spatialDynamic && (!spatial || (spatialDynamic.illumination && spatialDynamic.illumination.length !== bytes.length))) return null;
        minU = Math.min(minU, u0); maxU = Math.max(maxU, u1); minV = Math.min(minV, v0); maxV = Math.max(maxV, v1);
      }
      const words = HEADER + LIGHT_WORDS * animated.length, n = base.length;
      const layout = { header: 0, base: words * 4 }, spatialAt = [];
      layout.texels = layout.base + ((n + 15) & ~15);
      let size = layout.texels + ((n + 15) & ~15);
      const paramsAt = [];
      for (const { spatial: bytes, spatialDynamic } of animated) {
        spatialAt.push(size); size += (bytes.length + 15) & ~15;
        // A spatially dynamic light's parameter record and illumination.
        if (spatialDynamic) {
          paramsAt.push(size);
          size += spatial.words * 4 + ((bytes.length + 15) & ~15) + (bytes.length <= CACHE_TEXELS ? bytes.length * 32 : 0);
        }
        else paramsAt.push(0);
      }
      const lend = previous && previous.bytes >= size, at = lend ? previous.at : take(size), capacity = lend ? previous.bytes : size;
      const unionBytes = (maxU - minU) * (maxV - minV) * 3;
      if (unionBytes > scratchBytes) { scratch = take(unionBytes); scratchBytes = unionBytes; }
      const effects = [...new Set(animated.map(({ effect }) => effect).filter(effect => effect >= 1 && effect <= 3))];
      if (effects.length && !modulation) modulation = take(3 * MOD_BYTES);
      const lights = animated.map(item => {
        let slot = slots.get(item.ref);
        if (!slot) slots.set(item.ref, slot = { at: take(768), constants: null });
        return { light: item, slot, token: item.spatialDynamic ? 4 : item.effect === 1 || item.effect === 2 ? 1 : item.effect === 3 ? 3 : 0 };
      });
      sync();
      const h = at >> 2;
      u32[h] = width; u32[h + 1] = minU; u32[h + 2] = maxU; u32[h + 3] = minV; u32[h + 4] = maxV;
      u32[h + 5] = animated.length; u32[h + 6] = at + layout.base; u32[h + 7] = at + layout.texels;
      animated.forEach(({ rect, spatial: bytes, effect, spatialDynamic }, i) => {
        const w = h + HEADER + i * LIGHT_WORDS;
        u32[w] = rect.minU; u32[w + 1] = rect.maxU; u32[w + 2] = rect.minV; u32[w + 3] = rect.maxV;
        u32[w + 4] = at + spatialAt[i]; u32[w + 5] = lights[i].slot.at;
        u32[w + 6] = effect >= 1 && effect <= 3 ? modulation + (effect - 1) * MOD_BYTES : 0;
        u32[w + 7] = 0;
        u8.set(bytes, at + spatialAt[i]);
        if (spatialDynamic) {
          const record = at + paramsAt[i], illumination = spatialDynamic.illumination ? record + spatial.words * 4 : 0;
          if (illumination) u8.set(spatialDynamic.illumination, illumination);
          // The bytes just copied hold `spatialDynamic.time`'s result.
          const words = spatial.record({ ...spatialDynamic, effect, rect }, illumination, at + spatialAt[i],
            new Uint32Array(buffer, record, spatial.words));
          timeFloat[0] = spatialDynamic.time ?? 0;
          words[25] = timeBits[0]; words[26] = spatialDynamic.computed ? 1 : 0;
          // The cache after the illumination bytes, prepared on first use.
          words[27] = bytes.length <= CACHE_TEXELS ? record + spatial.words * 4 + ((bytes.length + 15) & ~15) : 0;
          words[28] = 0;
          u32[w + 7] = record;
        }
      });
      u8.set(base, at + layout.base); u8.set(texels, at + layout.texels);
      const rowStart = (minV * width + minU) * 3, rowEnd = ((maxV - 1) * width + maxU) * 3;
      return { at, bytes: capacity, base, width, height, animated, lights, effects, union: { minU, maxU, minV, maxV },
        texelsAt: at + layout.texels, rowStart, rowEnd };
    },

    /** animateLightMap(handle's base, texels, width, animated, frame, options,
     * memo) on the kernel: the same texels and the same returned region. */
    animate(handle, texels, frame, options, memo = null) {
      if (disposed) throw new Error('The light animation kernel was disposed');
      const { lights } = handle, count = lights.length;
      if (memo) {
        let state = memo.kernel, same = state?.length === count * 4;
        if (!same) state = memo.kernel = new Float64Array(count * 4);
        for (let i = 0, k = 0; i < count; i++, k += 4) {
          const { light: item, token } = lights[i], { steps } = animatedLightConstants(frame, item, options);
          if (steps.length !== 3) throw new Error(`A light's colour has ${steps.length} steps`);
          const input = token === 1 ? frame.frameIndex : token === 3 ? frame.noise.version : token === 4 ? frame.timeSeconds : 0;
          same = same && equal(state[k], steps[0]) && equal(state[k + 1], steps[1]) && equal(state[k + 2], steps[2])
            && equal(state[k + 3], input);
          state[k] = steps[0]; state[k + 1] = steps[1]; state[k + 2] = steps[2]; state[k + 3] = input;
        }
        if (same) return null;
      }
      for (let i = 0; i < count; i++) {
        const { light: item, slot } = lights[i], constants = animatedLightConstants(frame, item, options);
        if (slot.constants !== constants) upload(slot, constants);
      }
      for (const effect of handle.effects) ensureModulation(frame, effect);
      timeFloat[0] = frame.timeSeconds;
      if (!light.merge(handle.at, scratch, timeBits[0])) return null;
      sync();
      texels.set(u8.subarray(handle.texelsAt + handle.rowStart, handle.texelsAt + handle.rowEnd), handle.rowStart);
      const { minU, maxU, minV, maxV } = handle.union;
      return { minU, maxU, minV, maxV };
    },

    /** A merged light map's texel rectangle (light-atlas.mjs `rectOf`: source columns and rows, -1 and the map's width or height being the
     * atlas' padding) as the RGBA words `LightAtlas.update` would write for it from the record's texels, rows and columns in order:
     * a view of the kernel's scratch, valid until the next call. The kernel's texels are the record's after `animate` (the union
     * rows are copied back to it, the rest never changes between registrations). */
    pack(handle, rect) {
      if (disposed) throw new Error('The light animation kernel was disposed');
      const count = (rect.right - rect.left + 1) * (rect.bottom - rect.top + 1);
      if (count > packCapacity) {
        if (packAt) light.free(packAt);
        packCapacity = Math.max(count, 4096); packAt = light.alloc(packCapacity * 4);
      }
      light.pack(handle.texelsAt, handle.width, handle.height, rect.left, rect.right, rect.top, rect.bottom, packAt);
      sync();
      if (packView?.buffer !== buffer || packView.length < count) packView = new Uint32Array(buffer, packAt, packCapacity);
      return packView.subarray(0, count);
    },

    /** Validation: the colour tables the kernel holds for `ref` with the
     * constants they came from, and effect 1-3's modulation table with the
     * frame and version it was built for. */
    tables(ref) {
      const slot = slots.get(ref);
      if (!slot?.constants) return null;
      sync();
      return { constants: slot.constants, bytes: u8.slice(slot.at, slot.at + 768) };
    },
    modulation(effect) {
      const state = built[effect];
      if (!state.frame) return null;
      sync();
      const block = modulation + (effect - 1) * MOD_BYTES;
      light.modulationFill(block);
      return { frame: state.frame, version: state.version, bytes: u8.slice(block + MOD_VALUE, block + MOD_VALUE + 65536) };
    },

    /** Return every block to the kernel's allocator. */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (packAt) light.free(packAt);
      packAt = 0; packView = null;
      for (const at of blocks) light.free(at);
      blocks.length = 0; slots.clear();
    },
  };
}
