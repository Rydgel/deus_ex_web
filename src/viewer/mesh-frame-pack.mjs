/** One frame's GetFrame plans and SetupForActor results for the GPU mesh
 * passes, packed into 32-bit words (docs/sim-worker.md step 8). A frame
 * record then carries an offset instead of nested objects, and the frame
 * crosses to the page as one buffer. Every value lands in the GPU mesh
 * path's Float32Array and Uint32Array parameters (gpu-mesh.mjs setPose and
 * setLighting), so packing it as float32 and uint32 changes nothing.
 *
 * Plan at `at`: matrix (4 rows of 3 floats), origin (3 floats), the channel
 * op count n, then n ops of 8 words: state (the channel + 1, the base
 * channel being -1), tween, first, second, blend, alpha (float), count,
 * fill.
 * Lighting at `at`: flags, ambient (3 floats), ScaleGlow (float), unlit (3
 * floats), the light count n, then n lights of 7 floats: location, rradius,
 * colour. */
export const PLAN_HEAD = 16, PLAN_OP = 8, LIGHTING_HEAD = 9, LIGHTING_LIGHT = 7;

export function createMeshFramePack(capacity = 8192) {
  let buffer = new ArrayBuffer(capacity * 4), u32 = new Uint32Array(buffer), f32 = new Float32Array(buffer), used = 0;
  const reserve = count => {
    if (used + count > u32.length) {
      const next = new ArrayBuffer(Math.max(u32.length * 2, used + count) * 4);
      new Uint32Array(next).set(u32.subarray(0, used));
      buffer = next; u32 = new Uint32Array(buffer); f32 = new Float32Array(buffer);
    }
    const at = used; used += count; return at;
  };
  return {
    /** A planLodMeshFrame plan; returns its offset. */
    plan(plan) {
      const ops = plan.channels, at = reserve(PLAN_HEAD + PLAN_OP * ops.length);
      for (let row = 0; row < 4; row++) for (let i = 0; i < 3; i++) f32[at + row * 3 + i] = plan.matrix[row][i];
      for (let i = 0; i < 3; i++) f32[at + 12 + i] = plan.origin[i];
      u32[at + 15] = ops.length;
      ops.forEach((op, k) => {
        const base = at + PLAN_HEAD + PLAN_OP * k;
        u32[base] = op.channel + 1; u32[base + 1] = op.tween ? 1 : 0; u32[base + 2] = op.first; u32[base + 3] = op.second;
        u32[base + 4] = op.blend ? 1 : 0; f32[base + 5] = op.alpha; u32[base + 6] = op.count; u32[base + 7] = op.fill ? 1 : 0;
      });
      return at;
    },
    /** A mesh-lighting-view setupMesh result; returns its offset. */
    lighting(prepared) {
      const { setup } = prepared, lights = setup.lights, at = reserve(LIGHTING_HEAD + LIGHTING_LIGHT * lights.length);
      u32[at] = prepared.flags >>> 0;
      for (let i = 0; i < 3; i++) { f32[at + 1 + i] = setup.ambient[i]; f32[at + 5 + i] = prepared.unlit[i]; }
      f32[at + 4] = setup.scaleGlow; u32[at + 8] = lights.length;
      lights.forEach((light, k) => {
        const base = at + LIGHTING_HEAD + LIGHTING_LIGHT * k;
        for (let i = 0; i < 3; i++) { f32[base + i] = light.location[i]; f32[base + 4 + i] = light.color[i]; }
        f32[base + 3] = light.rradius;
      });
      return at;
    },
    /** The frame's words (a view of this pack's own buffer). */
    words: () => u32.subarray(0, used),
  };
}

/** The page's view of a frame's words. */
export const packViews = words => words ? { u32: words, f32: new Float32Array(words.buffer, words.byteOffset, words.length) } : null;
