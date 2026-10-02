/** Fire.dll's procedural texture ticks in the Rust core
 * (native/script-vm/src/fire.rs, docs/fire-texture.md "Rust kernel").
 *
 * fire-texture.mjs stays the reference: its load functions build a texture's
 * state as plain objects, then `fire` or `wet` moves the state into a block
 * of the script-VM kernel's memory (`kernel.fire.alloc`). The returned state keeps
 * the reference's shape: the fields a tick changes read and write the
 * block's header, its buffers are views into the block (re-derived when the
 * memory grows), and the rest are plain values, so fire-texture.mjs's bodies
 * run on it unchanged. The module tables and the generator every texture
 * shares stay fireTables' JavaScript object; `globals` mirrors them for the
 * kernel around each kernel tick, so a texture the kernel does not admit
 * ticks in JavaScript on the same stream.
 *
 * validate-fire-texture-rust.mjs compares the two after every tick. */

// Globals block (fire.rs `Globals`): sine, clamped, signed, random, index.
const GLOBALS_BYTES = 1284, RANDOM = 768, INDEX = 1280;
// Wet header words (fire.rs W_*).
const W = {uBits: 0, vBits: 1, uSize: 2, vSize: 3, uMask: 4, vMask: 5, globalPhase: 6, waveParity: 7, numDrops: 8,
  hasSource: 9, globals: 10, drops: 11, fields: 12, renderTable: 13, waveTable: 14, pixels: 15, source: 16};
const WET_WORDS = 17;
// Fire header words (fire.rs F_*).
const F = {uBits: 0, vBits: 1, uSize: 2, vSize: 3, uMask: 4, vMask: 5, globalPhase: 6, auxPhase: 7, fxFrequency: 8,
  bRising: 9, sparksLimit: 10, activeSparkNum: 11, starStatus: 12, globals: 13, sparks: 14, sparksLength: 15,
  renderTable: 16, pixels: 17, scratch: 18};
const FIRE_WORDS = 19;

export function createFireKernel(kernel) {
  const fire = kernel.fire, memory = fire.memory;
  let buffer = null, u8 = null, i32 = null;
  const sync = () => {
    if (memory.buffer !== buffer) { buffer = memory.buffer; u8 = new Uint8Array(buffer); i32 = new Int32Array(buffer); }
  };
  /** A view of `length` bytes at `at`, re-derived after a memory growth. */
  const bytesAt = (at, length) => {
    let view = null, of = null;
    return () => (memory.buffer === of ? view : (of = memory.buffer, view = new Uint8Array(of, at, length)));
  };
  /** Lay out `sizes` (name -> bytes) 16-aligned in one block. */
  const block = sizes => {
    let total = 0;
    const offsets = {};
    for (const [name, size] of Object.entries(sizes)) { offsets[name] = total; total += (size + 15) & ~15; }
    const at = fire.alloc(total);
    for (const name in offsets) offsets[name] += at;
    return offsets;
  };
  /** Header-backed int32 fields and buffer views on `state`. */
  const define = (state, header, words, views) => {
    for (const [name, word] of Object.entries(words)) {
      const at = (header >> 2) + word;
      Object.defineProperty(state, name, {enumerable: true,
        get: () => (sync(), i32[at]), set: value => { sync(); i32[at] = value; }});
    }
    for (const [name, get] of Object.entries(views)) Object.defineProperty(state, name, {enumerable: true, get});
    return state;
  };
  /** The upload: P8 through the palette (copied when it changes, zero past
   * its end as the JavaScript loop reads it) into `out`. */
  const expander = (pixels, count, area) => {
    let palette = null;
    const rgba = bytesAt(area.rgba, count * 4);
    return (source, out) => {
      if (source !== palette) {
        sync(); u8.fill(0, area.palette, area.palette + 1024); u8.set(source.subarray(0, 1024), area.palette);
        palette = source;
      }
      fire.expand(pixels, count, area.palette, area.rgba);
      out.set(rgba());
    };
  };

  return {
    /** A Globals block for fireTables' result `tables`, which stays the
     * module state: `run(tick)` copies its generator (512 bytes and the
     * index) in, runs a kernel tick and copies it back, so kernel and
     * JavaScript ticks draw from one stream in order. */
    globals(tables) {
      const at = fire.alloc(GLOBALS_BYTES), random = new Uint8Array(tables.random.buffer, tables.random.byteOffset, 512);
      sync();
      u8.set(tables.sine, at); u8.set(tables.sineClamped, at + 256); u8.set(tables.sineSigned, at + 512);
      const mirror = bytesAt(at + RANDOM, 512);
      return {at, run(tick) {
        mirror().set(random); sync(); i32[(at + INDEX) >> 2] = tables.randomIndex;
        tick();
        random.set(mirror()); sync(); tables.randomIndex = i32[(at + INDEX) >> 2];
      }};
    },

    /** A loaded FireTexture state (firePostLoad) in a block, or null when
     * its tick would not run (under 8×8) or its arrays are not the sizes
     * fire.rs indexes (the spark array holding the active sparks and the
     * limit). Returns {state, tick, expand}. */
    fire(state, globals) {
      const {uBits, uSize, vSize, sparks} = state, n = uSize * vSize;
      if (!(uSize >= 8 && vSize >= 8)) return null;
      const words = [uBits, uSize, vSize, state.uMask, state.vMask, state.globalPhase, state.auxPhase, state.fxFrequency,
        state.bRising, state.sparksLimit, state.activeSparkNum, state.starStatus];
      if (!words.every(Number.isInteger) || uBits < 0 || uBits > 15 || uSize > 4096 || vSize > 4096
        || state.pixels.length !== n || state.renderTable.length !== 1028 || sparks.length % 8
        || state.activeSparkNum < 0 || state.sparksLimit < 0
        || Math.max(state.activeSparkNum, state.sparksLimit) * 8 > sparks.length) return null;
      const area = block({header: FIRE_WORDS * 4, sparks: sparks.length, renderTable: 1028, pixels: n, scratch: 2 * uSize,
        palette: 1024, rgba: n * 4});
      sync();
      u8.set(sparks, area.sparks); u8.set(state.renderTable, area.renderTable); u8.set(state.pixels, area.pixels);
      const h = area.header >> 2;
      for (const name of ['uBits', 'uSize', 'vSize', 'uMask', 'vMask', 'globalPhase', 'auxPhase', 'fxFrequency', 'bRising',
        'sparksLimit', 'activeSparkNum', 'starStatus']) i32[h + F[name]] = state[name];
      i32[h + F.vBits] = 0;
      i32[h + F.globals] = globals.at; i32[h + F.sparks] = area.sparks; i32[h + F.sparksLength] = sparks.length;
      i32[h + F.renderTable] = area.renderTable; i32[h + F.pixels] = area.pixels; i32[h + F.scratch] = area.scratch;
      const {globalPhase, auxPhase, activeSparkNum, starStatus, renderTable, pixels, ...rest} = state;
      const moved = define(rest, area.header,
        {globalPhase: F.globalPhase, auxPhase: F.auxPhase, activeSparkNum: F.activeSparkNum, starStatus: F.starStatus},
        {sparks: bytesAt(area.sparks, sparks.length), renderTable: bytesAt(area.renderTable, 1028), pixels: bytesAt(area.pixels, n)});
      const tick = () => fire.tick(area.header);
      return {state: moved, tick: () => globals.run(tick), expand: expander(area.pixels, n, area)};
    },

    /** A loaded WetTexture state (wetPostLoad) in a block, or null when its
     * tick would not run (no source, under 8×8) or its sizes are not the
     * power-of-two ones fire.rs indexes. Returns {state, tick, expand}. */
    wet(state, globals) {
      const {uBits, vBits, uSize, vSize} = state, n = uSize * vSize;
      if (!state.source || !(uSize >= 8 && vSize >= 8)) return null;
      const src = state.local ?? state.source.pixels;
      if (uSize !== 2 ** uBits || vSize !== 2 ** vBits || uBits > 12 || vBits > 12 || state.fields.length !== n / 2
        || state.pixels.length !== n || state.drops.length !== 2048 || state.renderTable.length !== 1028
        || state.waveTable.length !== 1536 || !(src.length >= n)) return null;
      const area = block({header: WET_WORDS * 4, drops: 2048, fields: n / 2, renderTable: 1028, waveTable: 1536,
        pixels: n, source: n, palette: 1024, rgba: n * 4});
      sync();
      u8.set(state.drops, area.drops); u8.set(state.fields, area.fields); u8.set(state.renderTable, area.renderTable);
      u8.set(state.waveTable, area.waveTable); u8.set(state.pixels, area.pixels); u8.set(src.subarray(0, n), area.source);
      const h = area.header >> 2;
      i32[h + W.uBits] = uBits; i32[h + W.vBits] = vBits; i32[h + W.uSize] = uSize; i32[h + W.vSize] = vSize;
      i32[h + W.uMask] = state.uMask; i32[h + W.vMask] = state.vMask; i32[h + W.globalPhase] = state.globalPhase;
      i32[h + W.waveParity] = state.waveParity; i32[h + W.numDrops] = state.numDrops; i32[h + W.hasSource] = 1;
      i32[h + W.globals] = globals.at; i32[h + W.drops] = area.drops; i32[h + W.fields] = area.fields;
      i32[h + W.renderTable] = area.renderTable; i32[h + W.waveTable] = area.waveTable; i32[h + W.pixels] = area.pixels;
      i32[h + W.source] = area.source;
      const {globalPhase, waveParity, drops, fields, renderTable, waveTable, pixels, ...rest} = state;
      const moved = define(rest, area.header, {globalPhase: W.globalPhase, waveParity: W.waveParity}, {
        drops: bytesAt(area.drops, 2048), fields: bytesAt(area.fields, n / 2), renderTable: bytesAt(area.renderTable, 1028),
        waveTable: bytesAt(area.waveTable, 1536), pixels: bytesAt(area.pixels, n)});
      const tick = () => fire.wetTick(area.header);
      return {state: moved, tick: () => globals.run(tick), expand: expander(area.pixels, n, area)};
    },
  };
}
