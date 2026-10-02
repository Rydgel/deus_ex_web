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
 *   numbers kept in a Float64Array.
 * - Which light maps merge, and the float samples (lighting.mjs).
 *
 * Moved: the colour tables (built from the steps in light.rs when they are
 * int32 integers, else the reference's lazy `tables` are copied), the
 * modulation tables (rebuilt by the reference's rule: a new frame object, or
 * a new frameIndex for effects 1-2 or noise version for effect 3, from the
 * frame's factors at that first use), the union reset, the merge and the
 * comparison.
 *
 * Blocks come from a per-instance pool of 1 MiB chunks of `kernel.light`
 * memory, all freed by `dispose`. validate-light-animation-rust compares the
 * two every frame. */
import { animatedLightConstants } from './static-lighting.mjs';

const HEADER = 8, LIGHT_WORDS = 7, CHUNK = 1 << 20;
// Two numbers with the same String() (the reference's memo signature).
const equal = (a, b) => a === b || (a !== a && b !== b);
const INT32 = step => Number.isInteger(step) && step >= -0x80000000 && step <= 0x7fffffff;

export function createLightAnimationKernel(kernel) {
  const light = kernel.light, memory = light.memory;
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
  // Effects 1-3's modulation tables and the factors they are built from.
  let modulation = 0, factors = 0;
  const built = { 1: { frame: null, version: -1 }, 2: { frame: null, version: -1 }, 3: { frame: null, version: -1 } };
  let scratch = 0, scratchBytes = 0;

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
    f64.set(frame.factors[effect], factors >> 3);
    light.modulation(factors, modulation + (effect - 1) * 65536);
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
      for (const { rect, spatial, effect } of animated) {
        const { minU: u0, maxU: u1, minV: v0, maxV: v1 } = rect;
        if (![u0, u1, v0, v1].every(Number.isInteger) || !(u0 >= 0 && u0 < u1 && u1 <= width && v0 >= 0 && v0 < v1 && v1 <= height)
          || !(spatial instanceof Uint8Array) || spatial.length !== (u1 - u0) * (v1 - v0) || !Number.isInteger(effect)) return null;
        minU = Math.min(minU, u0); maxU = Math.max(maxU, u1); minV = Math.min(minV, v0); maxV = Math.max(maxV, v1);
      }
      const words = HEADER + LIGHT_WORDS * animated.length, n = base.length;
      const layout = { header: 0, base: words * 4 }, spatialAt = [];
      layout.texels = layout.base + ((n + 15) & ~15);
      let size = layout.texels + ((n + 15) & ~15);
      for (const { spatial } of animated) { spatialAt.push(size); size += (spatial.length + 15) & ~15; }
      const lend = previous && previous.bytes >= size, at = lend ? previous.at : take(size), capacity = lend ? previous.bytes : size;
      const unionBytes = (maxU - minU) * (maxV - minV) * 3;
      if (unionBytes > scratchBytes) { scratch = take(unionBytes); scratchBytes = unionBytes; }
      const effects = [...new Set(animated.map(({ effect }) => effect).filter(effect => effect >= 1 && effect <= 3))];
      if (effects.length && !modulation) { modulation = take(3 * 65536); factors = take(256 * 8); }
      const lights = animated.map(item => {
        let slot = slots.get(item.ref);
        if (!slot) slots.set(item.ref, slot = { at: take(768), constants: null });
        return { light: item, slot, token: item.effect === 1 || item.effect === 2 ? 1 : item.effect === 3 ? 3 : 0 };
      });
      sync();
      const h = at >> 2;
      u32[h] = width; u32[h + 1] = minU; u32[h + 2] = maxU; u32[h + 3] = minV; u32[h + 4] = maxV;
      u32[h + 5] = animated.length; u32[h + 6] = at + layout.base; u32[h + 7] = at + layout.texels;
      animated.forEach(({ rect, spatial, effect }, i) => {
        const w = h + HEADER + i * LIGHT_WORDS;
        u32[w] = rect.minU; u32[w + 1] = rect.maxU; u32[w + 2] = rect.minV; u32[w + 3] = rect.maxV;
        u32[w + 4] = at + spatialAt[i]; u32[w + 5] = lights[i].slot.at;
        u32[w + 6] = effect >= 1 && effect <= 3 ? modulation + (effect - 1) * 65536 : 0;
        u8.set(spatial, at + spatialAt[i]);
      });
      u8.set(base, at + layout.base); u8.set(texels, at + layout.texels);
      const rowStart = (minV * width + minU) * 3, rowEnd = ((maxV - 1) * width + maxU) * 3;
      return { at, bytes: capacity, base, width, animated, lights, effects, union: { minU, maxU, minV, maxV },
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
          const input = token === 1 ? frame.frameIndex : token === 3 ? frame.noise.version : 0;
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
      if (!light.merge(handle.at, scratch)) return null;
      sync();
      texels.set(u8.subarray(handle.texelsAt + handle.rowStart, handle.texelsAt + handle.rowEnd), handle.rowStart);
      const { minU, maxU, minV, maxV } = handle.union;
      return { minU, maxU, minV, maxV };
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
      return { frame: state.frame, version: state.version, bytes: u8.slice(modulation + (effect - 1) * 65536, modulation + effect * 65536) };
    },

    /** Return every block to the kernel's allocator. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const at of blocks) light.free(at);
      blocks.length = 0; slots.clear();
    },
  };
}
