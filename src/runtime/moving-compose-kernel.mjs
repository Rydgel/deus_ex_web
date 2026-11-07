/** The moving (class 2) lights' composition and the light atlas conversion in the Rust core (native/script-vm/src/moving.rs,
 * docs/firefox-60fps-plan.md "Moving lights (2026-11-07)"), driven by src/viewer/moving-lights.mjs.
 *
 * moving-lights.mjs `addDirect` and light-atlas.mjs `update` stay the references (`?movingCompose=js`, MOVING_COMPOSE=js in Node);
 * `verify` runs both and compares every float and byte. What this file does:
 * - keeps, for a light map with moving lights, a block of the kernel's memory holding its contributions' rectangles and spatial
 *   bytes, made again when the list of contributions (their entries) differs from the one it holds;
 * - for a frame, a batch: the colours of the lights that reach the batch's light maps (their steps, from which moving.rs makes the
 *   amounts), the modulation tables of the effects it uses (filled entry by entry when a texel first asks, cleared when the frame's
 *   noise changes), and one job for each light map: its static band (rows of the dirty region), the contributions and the atlas
 *   rectangle; `run` is one call;
 * - after it, the jobs' bands (the composed float texels) and packed RGBA texels (the atlas bytes) are read from the kernel's memory.
 *
 * Views over the kernel's memory are made again after every call that may allocate (the memory grows). */

const JOB_WORDS = 16, CONTRIB_WORDS = 8;
const J_WIDTH = 0, J_HEIGHT = 1, J_BAND = 2, J_V0 = 3, J_V1 = 4, J_CONTRIBS = 5, J_COUNT = 6, J_LEFT = 7, J_RIGHT = 8, J_TOP = 9, J_BOTTOM = 10,
  J_PACKED = 11, J_WRITTEN = 12;
const C_MIN_U = 0, C_MAX_U = 1, C_MIN_V = 2, C_MAX_V = 3, C_SPATIAL = 4, C_COLOUR = 5, C_EFFECT = 6;
const MOD_FACTORS = 0, MOD_VALID = 2048, MOD_BYTES = 2048 + 2 * 65536;
const align16 = n => (n + 15) & ~15;
const INT32 = step => Number.isInteger(step) && step >= -0x80000000 && step <= 0x7fffffff;

export function createMovingComposeKernel(moving) {
  const memory = moving.memory;
  let buffer = null, u8 = null, u32 = null, i32 = null, f32 = null, f64 = null;
  const sync = () => {
    if (memory.buffer === buffer) return;
    buffer = memory.buffer;
    u8 = new Uint8Array(buffer); u32 = new Uint32Array(buffer); i32 = new Int32Array(buffer); f32 = new Float32Array(buffer); f64 = new Float64Array(buffer);
  };
  const blocks = new Set();
  let disposed = false;
  const take = bytes => {
    if (disposed) throw new Error('The moving-light kernel was disposed');
    const at = moving.alloc(bytes);
    blocks.add(at);
    return at;
  };
  const release = at => { if (at && blocks.delete(at)) moving.free(at); };

  // The three effects' modulation tables (moving.rs MOD_*), cleared when their noise input changes.
  let mods = 0;
  const built = { 1: { frame: null, token: null }, 2: { frame: null, token: null }, 3: { frame: null, token: null } };

  // Grow-only batch scratch: jobs, colour steps and amounts, bands, packed texels.
  const scratch = { jobs: [0, 0], steps: [0, 0], amounts: [0, 0], band: [0, 0], packed: [0, 0] };
  const reserve = (name, bytes) => {
    const entry = scratch[name];
    if (entry[1] < bytes) {
      release(entry[0]);
      entry[1] = align16(Math.max(bytes, entry[1] * 2, 4096)); entry[0] = take(entry[1]);
    }
    return entry[0];
  };
  let batch = 0, bandWords = 0, packedWords = 0, last = null, count = 0;
  const colourList = [], jobList = [];

  // Light maps whose contributions change from frame to frame (a turning spotlight) compose from the batch's scratch: chunks reused by
  // every batch, so nothing is allocated or freed for lists that live one frame.
  const chunks = [];
  let chunkIndex = 0, chunkNext = 0, chunkEnd = 0, bigBlocks = [];
  const CHUNK = 1 << 20;
  const transient = bytes => {
    bytes = align16(bytes);
    if (bytes > CHUNK) { const at = take(bytes); bigBlocks.push(at); return at; }
    if (chunkNext + bytes > chunkEnd) {
      if (chunkIndex === chunks.length) chunks.push(take(CHUNK));
      chunkNext = chunks[chunkIndex++]; chunkEnd = chunkNext + CHUNK;
    }
    const at = chunkNext;
    chunkNext += bytes;
    return at;
  };
  const sameEntries = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  /** A light map's block: the words and spatial bytes of the contributions with a nonzero spatial byte (`live`), kept while its entries
   * are the same objects in the same order. A contribution whose spatial bytes are all 0 writes no texel, in any frame: the reference's
   * loop skips each byte. `spatialOf(entry)` is the entry's spatial bytes. A list of entries seen for the first time is composed from
   * the batch's scratch (the block lives for this batch only); one seen in two frames running gets a block of its own. */
  function block(record, entries, spatialOf) {
    const kept = record.movingBlock;
    if (kept && sameEntries(kept.entries, entries)) return kept;
    release(kept?.at);
    record.movingBlock = null;
    const persistent = record.movingTrial !== undefined && sameEntries(record.movingTrial, entries);
    const live = [];
    for (const entry of entries) {
      const bytes = spatialOf(entry);
      if (entry.dead === undefined) {
        let dead = true;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) { dead = false; break; }
        entry.dead = dead;
      }
      if (!entry.dead) live.push(entry);
    }
    let bytes = live.length * CONTRIB_WORDS * 4;
    for (const entry of live) bytes += align16(entry.spatial.length);
    const at = persistent ? take(Math.max(16, bytes)) : transient(Math.max(16, bytes));
    sync();
    let spatialAt = at + live.length * CONTRIB_WORDS * 4;
    for (let i = 0; i < live.length; i++) {
      const entry = live[i], { rect } = entry, w = (at >> 2) + i * CONTRIB_WORDS;
      u32[w + C_MIN_U] = rect.minU; u32[w + C_MAX_U] = rect.maxU; u32[w + C_MIN_V] = rect.minV; u32[w + C_MAX_V] = rect.maxV;
      u32[w + C_SPATIAL] = spatialAt;
      u8.set(entry.spatial, spatialAt);
      spatialAt += align16(entry.spatial.length);
    }
    // The union of every contribution's rectangle (the reference's `region`), dead ones included.
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const { rect } of entries) {
      if (rect.minU < minU) minU = rect.minU; if (rect.maxU > maxU) maxU = rect.maxU;
      if (rect.minV < minV) minV = rect.minV; if (rect.maxV > maxV) maxV = rect.maxV;
    }
    const made = { at, entries, live, region: { minU, maxU, minV, maxV } };
    if (persistent) { made.entries = entries.slice(); record.movingTrial = undefined; return record.movingBlock = made; }
    record.movingTrial = entries.slice();
    return made;
  }

  /** The colour's index in this batch, or -1 when a step is not an int32 (the reference then composes the light map). */
  function colourSlot(colour) {
    if (colour.kbatch === batch) return colour.kslot;
    const { steps } = colour;
    colour.kbatch = batch;
    if (steps.length !== 3 || !INT32(steps[0]) || !INT32(steps[1]) || !INT32(steps[2])) return colour.kslot = -1;
    colourList.push(steps);
    return colour.kslot = colourList.length - 1;
  }

  return {
    /** A new batch. */
    begin() {
      batch++; bandWords = 0; packedWords = 0; colourList.length = 0; count = 0;
      chunkIndex = 0; chunkNext = chunkEnd = 0;
      for (const at of bigBlocks) release(at);
      bigBlocks = [];
    },
    colourSlot,
    /** The effect's modulation table for `frame`/`token`: entries are valid for one noise input (moving-lights.mjs modulator). */
    modulation(effect, frame, token) {
      const state = built[effect];
      if (state.frame === frame && state.token === token) return;
      if (!mods) mods = take(3 * MOD_BYTES);
      sync();
      const at = mods + (effect - 1) * MOD_BYTES;
      f64.set(frame.factors[effect], (at + MOD_FACTORS) >> 3);
      u8.fill(0, at + MOD_VALID, at + MOD_VALID + 65536);
      state.frame = frame; state.token = token;
    },
    /** Whether every colour of the block's live contributions can be composed here: the amounts are made from int32 steps. */
    eligible(kept) {
      for (const entry of kept.live) if (colourSlot(entry.item.colour) < 0) return false;
      return true;
    },
    /** The record's block for `entries` (its contributions, in light order): `region` is their union, `live` the ones that can write. */
    prepare: block,
    /** Add a job: `record` composed from the contributions of `kept` (`prepare`'s block; the colours of this frame in
     * `entry.item.colour`) onto its static band, rows `dirty.minV..dirty.maxV`; `rect` {left, right, top, bottom} is the atlas
     * rectangle. `previous` is the caller's, handed back with the job. Returns the job's index. */
    add(record, kept, dirty, rect, previous) {
      const rows = dirty.maxV - dirty.minV, index = count++;
      const job = jobList[index] ??= { record: null, kept: null, dirty: null, rect: null, previous: null, band: 0, packed: 0, rows: 0, packedWidth: 0, packedRows: 0 };
      job.record = record; job.kept = kept; job.dirty = dirty; job.rect = rect; job.previous = previous;
      job.band = bandWords; job.packed = packedWords; job.rows = rows;
      job.packedWidth = rect.right - rect.left + 1; job.packedRows = rect.bottom - rect.top + 1;
      bandWords += rows * record.width * 3;
      packedWords += job.packedWidth * job.packedRows;
      return index;
    },
    get jobs() { return count; },
    /** The batch's size: texels in the jobs' bands and in their packed atlas rectangles. */
    get texels() { return { band: bandWords / 3, packed: packedWords }; },
    job: i => jobList[i],
    /** Run the batch: the jobs' words and static bands, the colours' amounts, one call. */
    run() {
      if (!count) return;
      const jobsAt = reserve('jobs', count * JOB_WORDS * 4), bandAt = reserve('band', bandWords * 4), packedAt = reserve('packed', Math.max(1, packedWords) * 4);
      sync();
      for (let i = 0; i < count; i++) {
        const job = jobList[i], { record, kept, dirty, rect } = job, w = (jobsAt >> 2) + i * JOB_WORDS, width = record.width;
        u32[w + J_WIDTH] = width; u32[w + J_HEIGHT] = record.height;
        u32[w + J_BAND] = bandAt + job.band * 4; u32[w + J_V0] = dirty.minV; u32[w + J_V1] = dirty.maxV;
        u32[w + J_CONTRIBS] = kept.at; u32[w + J_COUNT] = kept.live.length;
        i32[w + J_LEFT] = rect.left; i32[w + J_RIGHT] = rect.right; i32[w + J_TOP] = rect.top; i32[w + J_BOTTOM] = rect.bottom;
        u32[w + J_PACKED] = packedAt + job.packed * 4;
        // This frame's colour and modulation for each contribution.
        const c = kept.at >> 2;
        for (let k = 0; k < kept.live.length; k++) {
          const colour = kept.live[k].item.colour;
          u32[c + k * CONTRIB_WORDS + C_COLOUR] = colourSlot(colour);
          u32[c + k * CONTRIB_WORDS + C_EFFECT] = colour.modulate ? kept.live[k].item.effect : 0;
        }
        // The static band.
        const statics = record.staticPixels, from = dirty.minV * width * 3;
        f32.set(job.rows === record.height ? statics : statics.subarray(from, from + job.rows * width * 3), (bandAt >> 2) + job.band);
      }
      const stepsAt = reserve('steps', Math.max(1, colourList.length) * 12), amountsAt = reserve('amounts', Math.max(1, colourList.length) * 768 * 8);
      sync();
      const si = stepsAt >> 2;
      colourList.forEach((steps, i) => { i32[si + i * 3] = steps[0]; i32[si + i * 3 + 1] = steps[1]; i32[si + i * 3 + 2] = steps[2]; });
      if (colourList.length) moving.colours(amountsAt, stepsAt, colourList.length);
      moving.compose(jobsAt, count, amountsAt, mods, colourList.length);
      last = { jobsAt, bandAt, packedAt };
    },
    /** After `run` (and before anything allocates in the kernel's memory): the texels job `i` wrote. */
    written(i) { sync(); return u32[(last.jobsAt >> 2) + i * JOB_WORDS + J_WRITTEN]; },
    /** The rows of job `i`'s composed band into its light map's `pixels`. */
    copyBand(i) {
      sync();
      const job = jobList[i], { record } = job, at = (last.bandAt >> 2) + job.band;
      record.pixels.set(f32.subarray(at, at + job.rows * record.width * 3), job.dirty.minV * record.width * 3);
    },
    /** Changes whenever a batch begins: the packed texels of the last one are valid until then (and until the memory grows). */
    get generation() { return batch; },
    /** The kernel's memory as 32-bit words, and where job `i`'s packed texels start in them. */
    words() { sync(); return u32; },
    packedAt: i => (last.packedAt >> 2) + jobList[i].packed,
    /** Validation: job `i`'s composed band (a view valid until the memory grows). */
    band(i) {
      sync();
      const job = jobList[i], at = (last.bandAt >> 2) + job.band;
      return f32.subarray(at, at + job.rows * job.record.width * 3);
    },
    /** Free a record's block (its light map has no moving light now). */
    drop(record) { if (record.movingBlock) { release(record.movingBlock.at); record.movingBlock = null; } record.movingTrial = undefined; },
    /** Validation: the conversion of float32 bit patterns to bytes. */
    convert(bits) {
      const inAt = take(bits.length * 4 + 16), outAt = take(bits.length + 16);
      sync(); u32.set(bits, inAt >> 2);
      moving.convert(inAt, bits.length, outAt);
      const out = u8.slice(outAt, outAt + bits.length);
      release(inAt); release(outAt);
      return out;
    },
    dispose() { disposed = true; for (const at of blocks) moving.free(at); blocks.clear(); },
  };
}
