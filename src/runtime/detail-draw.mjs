/** D3DDrv's detail-texture pass in Play, the simulation side (docs/frame-projection.md "Detail textures"): the Rust core's
 * `detail_run` (native/script-vm/src/detail.rs, bit-exact against the original run under Unicorn) over each frame's OccludeBsp
 * stream, packed for the page.
 *
 * OccludeBsp runs with option OCCLUSION_DETAIL, so the stream carries the saved points only of the polygons of a surface that
 * has a detail texture (the model's detail table), whose PolyFlags lack the portal bit and that have a vertex inside the first
 * layer's distance, 380 (occlude.rs `detail_wanted`, `detail_near`). `frame(...)` turns the main frame's stream and each child
 * frame's (mirror and sky frames, each with its own Coords) into fans.
 *
 * The pack, u32 words: [frame count, then per frame: frame index (0 the main frame, else OccludeFrame's visit index), word
 * count, the words]. A frame's words are detail_run's output: per draw-list record [list, iNode, iSurf, fan count], then per
 * fan [layer, first vertex, vertex count, count x 7 words (X, Y, depth, RHW, colour, the two texture words)], D3DDrv's
 * vertices as DrawPrimitiveVB receives them. `first` counts only the polygons the filter kept (the original's counts all of the
 * record's, which only D3DDrv's light-map lookups use).
 *
 * The scratch buffers are reused between frames; the pack handed out is a copy sized to what it holds (its buffer is
 * transferred to the page, sim-worker.mjs). */
import { depthConstants, floatWord } from './frame-projection.mjs';

export function createDetailDraw(kernel, occlusion) {
  const table = occlusion.detail;
  if (!table || !kernel.detailRun) return null;
  const depth = depthConstants(32), zBias = floatWord(depth.zBias), zScale = floatWord(depth.zScale);
  const { alloc, free } = kernel;
  const fieldsAt = alloc(4 * 80);
  let outCap = 1 << 14, outAt = alloc(4 * outCap);
  let scratch = new Uint32Array(1 << 13), used = 0, frames = 0;
  const reset = () => { used = 1; frames = 0; };
  reset();
  /** The pass for one frame: `fields` the frame's ComputeRenderSize words (the master frame's `fields`, a child frame's),
   * `origin` [XB, YB] its rectangle's offset and `stream` {at, words} its OccludeBsp output in the kernel's memory. */
  function add(index, fields, origin, stream) {
    new Uint32Array(kernel.memory.buffer).set(fields, fieldsAt >>> 2);
    let written;
    for (;;) {
      written = kernel.detailRun(fieldsAt, origin[0], origin[1], zBias, zScale, table.table, table.surfaces, stream.at, stream.words, outAt, outCap);
      if (written !== 0xffffffff) break;
      free(outAt); outCap *= 2; outAt = alloc(4 * outCap);
    }
    if (!written) return;
    if (used + 2 + written > scratch.length) {
      const grown = new Uint32Array(Math.max(2 * scratch.length, used + 2 + written));
      grown.set(scratch.subarray(0, used)); scratch = grown;
    }
    scratch[used++] = index; scratch[used++] = written;
    scratch.set(new Uint32Array(kernel.memory.buffer, outAt, written), used);
    used += written; frames++;
  }
  return {
    /** The fans of one OccludeBsp run: the main frame (`master` the occlusion.master() result, `result` the run's result with
     * its `stream` and child `frames`). Null when no frame has any. */
    frames(master, origin, result) {
      reset();
      add(0, master.fields, origin, result.stream);
      for (const frame of result.frames ?? []) add(frame.index, frame.fields, origin, frame.stream);
      if (!frames) return null;
      scratch[0] = frames;
      return scratch.slice(0, used);
    },
    dispose() { free(fieldsAt); free(outAt); },
  };
}

/** The pack's frames: [{ index, words, offset }] with `words` a view of the pack (detail_run's output) at word `offset`. */
export function unpackDetail(pack) {
  const out = [];
  for (let at = 1, n = 0; n < pack[0]; n++) {
    const length = pack[at + 1];
    out.push({ index: pack[at], words: pack.subarray(at + 2, at + 2 + length), offset: at + 2 });
    at += 2 + length;
  }
  return out;
}

/** One frame's fans: calls `fan(list, iNode, iSurf, layer, count, words, at)` for each, `at` the index of the fan's first
 * vertex word in `words` (7 words a vertex). */
export function forEachFan(words, fan) {
  for (let at = 0; at < words.length;) {
    const list = words[at], node = words[at + 1] | 0, surf = words[at + 2], fans = words[at + 3];
    at += 4;
    for (let k = 0; k < fans; k++) {
      const layer = words[at], count = words[at + 2];
      fan(list, node, surf, layer, count, words, at + 3);
      at += 3 + 7 * count;
    }
  }
}
