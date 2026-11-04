/** The Rust script core's x87 operator kernel (native/script-vm,
 * docs/rust-core.md step R2b). The JavaScript VM's operator bodies call it in
 * place of the BigInt x87 model once it is loaded; before that (and in hosts
 * that never load it) the BigInt bodies run. scripts/validate-script-vm-x87.mjs
 * proves the two equal.
 *
 * Operands cross as float32 bit patterns through the same f32bits/f32num the
 * BigInt model loads and stores with, so NaN payloads and signed zeros agree.
 * The kernel instance has its own memory; the interpreter (interp.rs, step
 * R2b-2) runs in an instance on the runtime's object arena
 * (instantiateScriptVm). */
import {rotationSineTable} from './coords.mjs';
import {RESERVED} from './script-object-arena.mjs';
import {createGalaxyUpdateKernel} from './galaxy-update-kernel.mjs';
import {createComputerTickKernel} from './computer-tick-kernel.mjs';

const f32io = new DataView(new ArrayBuffer(4));
const bits = v => (f32io.setFloat32(0, Math.fround(v), true), f32io.getUint32(0, true));
const num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));

export let scriptVmKernel = null;
let pending = null;

/** Load the kernel once; later calls return the same promise. */
export function loadScriptVmKernel() {
  return pending ??= load().then(kernel => (scriptVmKernel = kernel));
}

let compiled = null;

/** The compiled module, fetched and compiled once for every instance (the
 * trace kernel, trace-kernel.mjs, instantiates it too). */
export function compileScriptVm() {
  return compiled ??= (async () => {
    const url = new URL('./script-vm.wasm', import.meta.url);
    let bytes;
    if (url.protocol === 'file:') {
      const module = 'node:fs/promises';
      bytes = await (await import(/* @vite-ignore */ module)).readFile(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Cannot load the script VM kernel: HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    }
    return WebAssembly.compile(bytes);
  })();
}

// The interpreter's imports (interp.rs), whatever the module declares. The
// kernel-only instance runs no script code, so reaching one of them there is
// a host fault.
const kernelOnlyImports = module => Object.fromEntries(WebAssembly.Module.imports(module)
  .filter(entry => entry.module === 'env' && entry.kind === 'function')
  .map(({name}) => [name, () => { throw new Error(`The script VM kernel instance does not run scripts (${name})`); }]));

async function load() {
  const module = await compileScriptVm();
  // The module's shadow stack and statics end below 2 MiB (build.rs).
  const memory = new WebAssembly.Memory({initial: 32});
  const instance = await WebAssembly.instantiate(module, {env: {memory, ...kernelOnlyImports(module), ...decalImports}});
  return createScriptVmKernel(instance, memory);
}

// AttachDecal's host services in the kernel instance (decal.rs, decal-kernel.mjs):
// the shared rand() stream and a decal actor's live Texture id, answered by
// the call in flight.
let decalHost = null;
export const setDecalHost = host => { decalHost = host; };
// OccludeFrame's SetupDynamics for each child frame (occlude.rs
// occ_frame_dynamics, bsp-occlusion.mjs): the host's hook for the run in flight.
let frameHook = null;
export const setFrameHook = hook => { frameHook = hook; };
const decalImports = {
  decal_rand: () => decalHost.rand(),
  decal_texture: actor => decalHost.texture(actor),
  occ_frame_dynamics: (index, kind, parent) => { frameHook?.(index, kind, parent); },
};

/** Core FGlobalMath's sine table into an instance's SINE static. */
function uploadSineTable(x, memory) {
  const sine = rotationSineTable(), table = new Uint32Array(memory.buffer), sineAt = x.sine_ptr() >>> 2;
  for (let i = 0; i < sine.length; i++) table[sineAt + i] = bits(sine[i]);
}

/** An interpreter instance on `memory` (a runtime's ObjectArena memory, whose
 * low RESERVED bytes hold the module's shadow stack and statics) with the
 * host's interpreter imports. Returns the raw exports; the x87 operator
 * exports work in it as in the kernel instance. */
export async function instantiateScriptVm(memory, imports) {
  const module = await compileScriptVm();
  // The level queries' imports (hash.rs) are the trace kernel instance's
  // (trace-kernel.mjs); an interpreter instance never runs them.
  const instance = await WebAssembly.instantiate(module, {env: {memory, ...kernelOnlyImports(module), ...imports}});
  const x = instance.exports;
  if (x.__heap_base.value > RESERVED) throw new Error('Script VM statics exceed the object arena\'s reserved region');
  uploadSineTable(x, memory);
  return x;
}

/** spatial.rs's parameter record length (PARAM_WORDS). */
export const SPATIAL_WORDS = 32;

export function createScriptVmKernel(instance, memory) {
  const x = instance.exports;
  if (x.__heap_base.value > memory.buffer.byteLength) throw new Error('Script VM kernel statics exceed its memory');
  const words = () => new Uint32Array(memory.buffer);
  uploadSineTable(x, memory);
  const resultAt = x.result_ptr() >>> 2;
  // Kernel blocks (Fire.dll textures, fire.rs; animated light maps,
  // light.rs; the BSP occlusion's and decals' tables) live above the
  // memory's initial size, past the statics and stack. Fire blocks stay for
  // the instance's life (a page's procedural textures do too); a world's
  // light-map blocks and a level's occlusion are freed with them. A freed
  // block joins an address-ordered free list, merged with its free
  // neighbours (and given back to the top when it ends there). A request
  // takes the smallest free block it fits, split when the rest is worth
  // keeping, or else the top; either way it starts zeroed, as fresh pages
  // do. (Until 2026-11-04 a freed block went whole to the first later
  // request it fitted, so after a map change a small table could take the
  // last level's 32 MB occlusion work block and the next work block grew
  // the memory: docs/long-session.md.) This allocator is the only thing that
  // grows this instance's memory; the other kernels here re-derive their
  // views on every call.
  let top = memory.buffer.byteLength;
  const sizes = new Map(), freeList = [];  // freeList: {at, bytes}, by address
  const MIN_SPLIT = 256;
  const alloc = bytes => {
    bytes = Math.max(16, (bytes + 15) & ~15);
    let best = -1;
    for (let i = 0; i < freeList.length; i++) {
      const size = freeList[i].bytes;
      if (size >= bytes && (best < 0 || size < freeList[best].bytes)) { best = i; if (size === bytes) break; }
    }
    if (best >= 0) {
      const block = freeList[best], at = block.at;
      if (block.bytes - bytes >= MIN_SPLIT) { block.at += bytes; block.bytes -= bytes; sizes.set(at, bytes); }
      else { freeList.splice(best, 1); sizes.set(at, block.bytes); }
      new Uint8Array(memory.buffer, at, sizes.get(at)).fill(0);
      return at;
    }
    const at = (top + 15) & ~15, end = at + bytes, before = memory.buffer.byteLength;
    if (end > before) memory.grow(Math.ceil((end - before) / 65536));
    // (below the old size the bytes may be a freed block's that the top took back; fresh pages are zero)
    if (at < before) new Uint8Array(memory.buffer, at, Math.min(end, before) - at).fill(0);
    top = end; sizes.set(at, bytes);
    return at;
  };
  const free = at => {
    const bytes = sizes.get(at);
    if (bytes === undefined) throw new Error(`Kernel block ${at} is not allocated`);
    sizes.delete(at);
    let lo = 0, hi = freeList.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (freeList[mid].at < at) lo = mid + 1; else hi = mid; }
    let index = lo, block;
    const before = freeList[lo - 1];
    if (before && before.at + before.bytes === at) { before.bytes += bytes; block = before; index = lo - 1; }
    else { block = { at, bytes }; freeList.splice(lo, 0, block); }
    const after = freeList[index + 1];
    if (after && block.at + block.bytes === after.at) { block.bytes += after.bytes; freeList.splice(index + 1, 1); }
    if (block.at + block.bytes === top) { top = block.at; freeList.splice(index, 1); }
  };
  const vector = () => { const w = words(); return [num(w[resultAt]), num(w[resultAt + 1]), num(w[resultAt + 2])]; };
  // Views of RESULT and FCOORDS that persist while the memory does (made again when it grows): the x87 tails of
  // callers.rs run every frame, and `vector()` makes a view per call.
  let viewBuffer = null, resultFloats = null, fcoordFloats = null;
  const views = () => {
    if (viewBuffer === memory.buffer) return;
    viewBuffer = memory.buffer;
    resultFloats = new Float32Array(viewBuffer, resultAt * 4, 3);
    fcoordFloats = x.fcoords_ptr ? new Float32Array(viewBuffer, x.fcoords_ptr(), 12) : null;
  };
  const result3 = () => { views(); return [resultFloats[0], resultFloats[1], resultFloats[2]]; };
  const ints = () => { const w = new Int32Array(memory.buffer); return [w[resultAt], w[resultAt + 1], w[resultAt + 2]]; };
  return Object.freeze({
    /** Measurement only (scripts/session-hour.mjs): the block allocator's state, bytes held by live blocks and by freed ones, the top
     * and the memory's size. */
    blockStats: () => {
      let used = 0, free = 0;
      for (const bytes of sizes.values()) used += bytes;
      for (const block of freeList) free += block.bytes;
      return { blocks: sizes.size, usedBytes: used, freed: freeList.length, freeBytes: free, top, memoryBytes: memory.buffer.byteLength };
    },
    /** The x87 precision control of this instance (render-precision.mjs). */
    setPrecision: value => x.set_x87_precision(value),
    vectorSize: v => num(x.op_vector_size(bits(v[0]), bits(v[1]), bits(v[2]))),
    divideEqualIntFloat: (a, b) => x.op_divide_equal_int_float(a | 0, bits(b)),
    percent: (a, b) => num(x.op_percent(bits(a), bits(b))),
    sqrt: a => num(x.op_sqrt(bits(a))),
    square: a => num(x.op_square(bits(a))),
    dot: (a, b) => num(x.op_dot(bits(a[0]), bits(a[1]), bits(a[2]), bits(b[0]), bits(b[1]), bits(b[2]))),
    multiplyEqualVectorFloat: (a, b) => (x.op_multiply_equal_vector_float(bits(a[0]), bits(a[1]), bits(a[2]), bits(b)), vector()),
    divideEqualVectorFloat: (a, b) => (x.op_divide_equal_vector_float(bits(a[0]), bits(a[1]), bits(a[2]), bits(b)), vector()),
    subtractEqualVectorVector: (a, b) => (x.op_subtract_equal_vector_vector(bits(a[0]), bits(a[1]), bits(a[2]), bits(b[0]), bits(b[1]), bits(b[2])), vector()),
    normal: a => (x.op_normal(bits(a[0]), bits(a[1]), bits(a[2])), vector()),
    smerp: (alpha, a, b) => num(x.op_smerp(bits(alpha), bits(a), bits(b))),
    rotate: (v, r) => (x.op_rotate(bits(v[0]), bits(v[1]), bits(v[2]), r[0] | 0, r[1] | 0, r[2] | 0), vector()),
    multiplyRotatorFloat: (r, s) => (x.op_multiply_rotator_float(r[0] | 0, r[1] | 0, r[2] | 0, bits(s)), ints()),
    multiplyVectorVector: (a, b) => (x.op_multiply_vector_vector(bits(a[0]), bits(a[1]), bits(a[2]), bits(b[0]), bits(b[1]), bits(b[2])), vector()),
    multiplyEqualVectorVector: (a, b) => (x.op_multiply_equal_vector_vector(bits(a[0]), bits(a[1]), bits(a[2]), bits(b[0]), bits(b[1]), bits(b[2])), vector()),
    mirrorVectorByNormal: (a, b) => (x.op_mirror_vector_by_normal(bits(a[0]), bits(a[1]), bits(a[2]), bits(b[0]), bits(b[1]), bits(b[2])), vector()),
    /** Validation only: the last vector operator's three result words, which
     * vector() hands out as numbers in an Array (where V8 may store a NaN
     * canonically; see script-vm.mjs x87OperatorWords). */
    resultWords: () => { const w = words(); return [w[resultAt], w[resultAt + 1], w[resultAt + 2]]; },
    // Pawn physics' x87 tails (docs/rust-core.md R3-b): script-pawn-physics.mjs
    // AvgPhysicsTime and falling.mjs refundTime.
    avgPhysicsTime: (avg, dt) => num(x.phys_avg_time(bits(avg), bits(dt))),
    refundTime: (remaining, time, step) => num(x.phys_refund_time(bits(remaining), bits(time), bits(step))),
    // The x87 tails of five JavaScript callers (callers.rs, docs/live-heap.md "Cut: x87 math in Rust"); each JavaScript function
    // stays as the reference and runs where this is absent. null when the loaded core predates them.
    // actor-physics.mjs interpolationVelocity.
    interpolationVelocity: typeof x.phys_interpolation_velocity !== 'function' ? null : (location, old, seconds) => (
      x.phys_interpolation_velocity(bits(location[0]), bits(location[1]), bits(location[2]), bits(old[0]), bits(old[1]), bits(old[2]),
        bits(seconds)), result3()),
    // script-pawn-locomotion.mjs fcoordsAxes: [Origin, XAxis, YAxis, ZAxis] of FCoords(FRotator(pitch, yaw, roll)).
    fcoordsAxes: typeof x.fcoords_axes_out !== 'function' ? null : rotation => {
      x.fcoords_axes_out(rotation[0] | 0, rotation[1] | 0, rotation[2] | 0);
      views();
      const f = fcoordFloats;
      return [[f[0], f[1], f[2]], [f[3], f[4], f[5]], [f[6], f[7], f[8]], [f[9], f[10], f[11]]];
    },
    // script-pawn-perception.mjs losWorker: st(magsq3(v)), the squared scaled visibility, the FOV path's Stimulus and distance.
    los: typeof x.los_magsq3 !== 'function' ? null : Object.freeze({
      magsq3: v => num(x.los_magsq3(bits(v[0]), bits(v[1]), bits(v[2]))),
      squareProduct: (a, b) => num(x.los_square_product(bits(a), bits(b))),
      stimulus: (delta, forward, peripheral) => num(x.los_stimulus(bits(delta[0]), bits(delta[1]), bits(delta[2]),
        bits(forward[0]), bits(forward[1]), bits(forward[2]), bits(peripheral))),
      scaled: (distSq, dzAbs, divisor, stimulus) => num(x.los_scaled(bits(distSq), bits(dzAbs), bits(divisor), bits(stimulus))),
    }),
    // move-riders.mjs moveActorRiders: a rider's RotMotion and delta.
    riders: typeof x.rider_rot_motion !== 'function' ? null : Object.freeze({
      rotMotion: (actor, other, reducedYaw) => (x.rider_rot_motion(bits(actor[0]), bits(actor[1]), bits(actor[2]),
        bits(other[0]), bits(other[1]), bits(other[2]), reducedYaw | 0), result3()),
      delta: (final, motion) => (x.rider_delta(bits(final[0]), bits(final[1]), bits(final[2]), bits(motion[0]), bits(motion[1]),
        bits(motion[2])), result3()),
    }),
    // Galaxy.dll's lip-sync analysis (lipsync.rs, docs/lip-sync.md): 1024
    // little-endian int16 samples at the mixer position, `available` of them
    // before the ring end, at `rate` Hz; returns the phoneme letter.
    lipsync: Object.freeze({
      analyze(samples, available, rate) {
        new Uint8Array(memory.buffer, x.lipsync_input_ptr(), 2048).set(samples.subarray(0, 2048));
        const code = x.lipsync_analyze(available >>> 0, rate | 0);
        if (!code) throw new Error(`Galaxy lip sync: rate ${rate} puts 300 Hz outside the 1024 bins`);
        return String.fromCharCode(code);
      },
      /** Validation only: the classifier over 1024 float32 bin bit patterns. */
      classify(bins, rate) {
        new Uint32Array(memory.buffer, x.lipsync_real_ptr(), 1024).set(bins);
        const code = x.lipsync_classify(rate | 0);
        return code ? String.fromCharCode(code) : null;
      },
      window: () => new Uint32Array(memory.buffer, x.lipsync_window_ptr(), 1024).slice(),
      real: () => new Uint32Array(memory.buffer, x.lipsync_real_ptr(), 1024).slice(),
      imag: () => new Uint32Array(memory.buffer, x.lipsync_imag_ptr(), 1024).slice(),
    }),
    // UGalaxyAudioSubsystem's PlaySound and Update arithmetic (galaxy.rs, docs/galaxy-audio.md "Update in Rust"), driven by
    // galaxy-audio.mjs; null when the loaded core predates it.
    galaxy: typeof x.galaxy_io_ptr !== 'function' ? null : createGalaxyUpdateKernel(x, memory),
    // XComputerWindow::Tick's blink and time arithmetic (computer.rs, computer-tick-kernel.mjs), driven by script-window-computer-playback.mjs.
    computer: typeof x.computer_io_ptr !== 'function' ? null : createComputerTickKernel(x, memory),
    // Render.dll's volumetric fog loop (fog.rs, docs/volumetric-fog.md):
    // volumetric-fog.mjs fogMapKernel writes the square-root table once, the
    // lights' words and colour tables and the camera-space grid, then reads
    // the BGRA texels. The early-out flag persists in the module.
    fog: Object.freeze({
      sqrt: table => new Uint32Array(memory.buffer, x.fog_sqrt_ptr(), 2048).set(table),
      lights: words => new Uint32Array(memory.buffer, x.fog_lights_ptr(), words.length).set(words),
      tables: bytes => new Uint8Array(memory.buffer, x.fog_tables_ptr(), bytes.length).set(bytes),
      grid: words => new Uint32Array(memory.buffer, x.fog_grid_ptr(), 9).set(words),
      map: (width, height, count) => x.fog_map(width >>> 0, height >>> 0, count >>> 0)
        ? new Uint8Array(memory.buffer, x.fog_out_ptr(), width * height * 4).slice() : null,
      miss: () => x.fog_miss(),
      setMiss: value => x.fog_set_miss(value >>> 0),
      // The render pass's precision control 24 (fog.rs): f32 registers
      // (`Single`), rerun on f64 ones (`Wide`) when a product or quotient
      // leaves binary32's normal range, and the Ext model rounded to 24 bits
      // (`Exact`) for non-finite inputs. `setExact(true)` runs every texel on
      // Exact; `fallbacks` counts the texels with a non-finite input. `check`
      // (validation only) runs the loop on Exact with Wide and Single
      // compared on every texel from the same incoming flag and returns the
      // texels where they differ.
      setExact: on => x.fog_set_exact(on ? 1 : 0),
      fallbacks: () => x.fog_fallbacks() >>> 0,
      // Texels the f32 registers handed to the f64 ones (fog.rs `Single`).
      reruns: () => (x.fog_reruns ? x.fog_reruns() : 0) >>> 0,
      resetFallbacks: () => x.fog_reset_fallbacks(),
      check: (width, height, count) => x.fog_check(width >>> 0, height >>> 0, count >>> 0) >>> 0,
      texels: (width, height) => new Uint8Array(memory.buffer, x.fog_out_ptr(), width * height * 4).slice(),
    }),
    // Fire.dll's procedural texture ticks (fire.rs, docs/fire-texture.md
    // "Rust kernel"), driven by fire-texture-kernel.mjs over blocks from
    // `alloc` (byte addresses in `memory`).
    fire: Object.freeze({
      memory,
      alloc,
      tick: header => x.fire_tick(header >>> 0),
      wetTick: header => x.fire_wet_tick(header >>> 0),
      expand: (pixels, count, palette, rgba) => x.fire_expand(pixels >>> 0, count >>> 0, palette >>> 0, rgba >>> 0),
    }),
    // The animated light-map merge (light.rs, docs/static-lighting.md "Rust
    // kernel"), driven by light-animation-kernel.mjs over blocks from
    // `alloc`, returned with `free` when the world goes.
    light: Object.freeze({
      memory,
      alloc,
      free,
      merge: (header, before, time = 0) => x.light_merge(header >>> 0, before >>> 0, time >>> 0),
      colourTables: (out, red, green, blue) => x.light_colour_tables(out >>> 0, red | 0, green | 0, blue | 0),
      modulation: (factors, out) => x.light_modulation(factors >>> 0, out >>> 0),
    }),
    // Render.dll's time-varying spatial light functions and Shell
    // (spatial.rs, docs/static-lighting.md "Spatially dynamic effects"):
    // `tables` uploads the light manager's square-root and normal tables
    // (dynamic-lighting.mjs) once; `run` computes one light's rectangle of
    // spatial bytes. The rest serves validation. null when the loaded core
    // predates it.
    spatial: typeof x.light_spatial !== 'function' ? null : (() => {
      let scratch = 0, scratchBytes = 0, tablesSet = false, pairBuffer = 0, pairCapacity = 0;
      const record = new Uint32Array(SPATIAL_WORDS);
      const api = {
        words: SPATIAL_WORDS,
        tables(sqrt, normal) {
          new Uint32Array(memory.buffer, x.spatial_sqrt_ptr(), 2048).set(sqrt);
          new Float32Array(memory.buffer, x.spatial_normal_ptr(), 4096).set(normal);
          tablesSet = true;
        },
        get ready() { return tablesSet; },
        /** Fill a parameter record (SPATIAL_WORDS u32) for `light`: effect,
         * rect, grid {start, stepU, stepV}, location, rradius, rr2,
         * incidence, time, period, phase; `illumination` and `out` are
         * addresses in this memory (0: 0x7f everywhere). */
        record(light, illumination, out, into = record) {
          const { rect, grid } = light, view = new Float32Array(into.buffer, into.byteOffset, SPATIAL_WORDS);
          into.fill(0);
          into[0] = light.effect; into[1] = rect.minU; into[2] = rect.maxU; into[3] = rect.minV; into[4] = rect.maxV;
          view.set(grid.start, 5); view.set(grid.stepU, 8); view.set(grid.stepV, 11); view.set(light.location, 14);
          view[17] = light.rradius; view[18] = light.rr2; view[19] = light.incidence; view[20] = light.time ?? 0;
          into[21] = light.period & 255; into[22] = light.phase & 255; into[23] = illumination >>> 0; into[24] = out >>> 0;
          return into;
        },
        /** One light's rectangle-relative spatial bytes (a copy). */
        run(light) {
          if (!tablesSet) throw new Error('spatial.rs tables are not uploaded');
          const { minU, maxU, minV, maxV } = light.rect, area = Math.max(0, maxU - minU) * Math.max(0, maxV - minV);
          const need = SPATIAL_WORDS * 4 + ((area + 15) & ~15) * 2;
          if (need > scratchBytes) { scratch = alloc(need); scratchBytes = need; }
          const illumination = light.illumination ? scratch + SPATIAL_WORDS * 4 : 0, out = scratch + SPATIAL_WORDS * 4 + ((area + 15) & ~15);
          if (light.illumination) new Uint8Array(memory.buffer, illumination, area).set(light.illumination.subarray(0, area));
          new Uint32Array(memory.buffer, scratch, SPATIAL_WORDS).set(api.record(light, illumination, out));
          if (!x.light_spatial(scratch)) throw new Error(`spatial.rs has no body for effect ${light.effect}`);
          return new Uint8Array(memory.buffer, out, area).slice();
        },
        /** Record the appAtan2 operand pairs of later runs (up to
         * `capacity`), or stop with 0. */
        /** The cached form (spatial.rs run_frame): `light`'s bytes at each
         * of `times`, its per-texel cache prepared at the first (validation:
         * light.rs merges this way). */
        runFrames(light, times) {
          if (!tablesSet) throw new Error('spatial.rs tables are not uploaded');
          const { minU, maxU, minV, maxV } = light.rect, area = Math.max(0, maxU - minU) * Math.max(0, maxV - minV);
          const padded = (area + 15) & ~15, need = SPATIAL_WORDS * 4 + padded * 2 + area * 32 + 16;
          const at = alloc(need), illumination = light.illumination ? at + SPATIAL_WORDS * 4 : 0, out = at + SPATIAL_WORDS * 4 + padded;
          if (light.illumination) new Uint8Array(memory.buffer, illumination, area).set(light.illumination.subarray(0, area));
          const words = api.record({ ...light, time: times[0] }, illumination, out);
          words[27] = at + SPATIAL_WORDS * 4 + padded * 2; words[28] = 0;
          new Uint32Array(memory.buffer, at, SPATIAL_WORDS).set(words);
          const results = times.map(time => {
            new Float32Array(memory.buffer, at + 20 * 4, 1)[0] = time;
            if (!x.light_spatial_frame(at)) throw new Error(`spatial.rs has no body for effect ${light.effect}`);
            return new Uint8Array(memory.buffer, out, area).slice();
          });
          free(at);
          return results;
        },
        collect(capacity) {
          if (!capacity) { x.spatial_collect(0, 0); return; }
          if (capacity > pairCapacity) { pairBuffer = alloc(capacity * 16); pairCapacity = capacity; }
          x.spatial_collect(pairBuffer, capacity);
        },
        /** The recorded pairs as [Y bits, X bits, ...] (BigUint64Array). */
        pairs() {
          const count = x.spatial_pair_count();
          if (count > pairCapacity) throw new Error(`spatial.rs recorded ${count} atan pairs past the capacity ${pairCapacity}`);
          return new BigUint64Array(memory.buffer, pairBuffer, count * 2).slice();
        },
        fallbacks: () => x.spatial_fallbacks() >>> 0,
        ambiguous: () => x.spatial_ambiguous() >>> 0,
        resetCounts: () => x.spatial_reset_counts(),
        slowOnly: on => x.spatial_set_slow_only(on ? 1 : 0),
        atanK: (y, xv, k) => x.spatial_atan_k(y, xv, k),
        atanDd: (y, xv) => { x.spatial_atan_dd(y, xv); return [...new Float64Array(memory.buffer, x.spatial_dd_ptr(), 2)]; },
      };
      return Object.freeze(api);
    })(),
    // URender::OccludeBsp (occlude.rs, docs/bsp-occlusion.md), driven by
    // bsp-occlusion.mjs over a model and a work block from `alloc`; null when
    // the loaded core predates it (src/runtime/script-vm.wasm is built
    // locally by `npm run build:wasm`, not tracked).
    occlusion: typeof x.occ_run !== 'function' || typeof x.occ_master_frame !== 'function' ? null : Object.freeze({
      memory,
      alloc,
      free,
      modelPtr: () => x.occ_model_ptr() >>> 0,
      framePtr: () => x.occ_frame_ptr() >>> 0,
      statusPtr: () => x.occ_status_ptr() >>> 0,
      run: (work, bytes) => x.occ_run(work >>> 0, bytes >>> 0),
      masterInPtr: () => x.occ_master_in_ptr() >>> 0,
      masterOutPtr: () => x.occ_master_out_ptr() >>> 0,
      masterFrame: () => x.occ_master_frame(),
      // CreateChildFrame's inputs and OccludeFrame's recursion switch (occlude.rs CHILD_IN).
      childInPtr: typeof x.occ_child_in_ptr !== 'function' ? null : () => x.occ_child_in_ptr() >>> 0,
      childDebugPtr: typeof x.occ_child_debug_ptr !== 'function' ? null : () => x.occ_child_debug_ptr() >>> 0,
      // The host's SetupDynamics for each child frame (occ_frame_dynamics).
      setFrameHook,
      // D3DDrv's detail-texture pass over one frame's occlusion stream (detail.rs, docs/frame-projection.md); null in a core
      // that predates it.
      detailRun: typeof x.detail_run !== 'function' ? null
        : (fields, xb, yb, zbias, zscale, table, surfs, stream, words, out, cap) =>
          x.detail_run(fields >>> 0, xb | 0, yb | 0, zbias >>> 0, zscale >>> 0, table >>> 0, surfs >>> 0, stream >>> 0, words >>> 0, out >>> 0, cap >>> 0) >>> 0,
      // FDynamicSprite::Setup (setup.rs) over packed candidates; null in a
      // core that predates it.
      setup: typeof x.occ_setup !== 'function' ? null
        : (candidates, count, out) => x.occ_setup(candidates >>> 0, count >>> 0, out >>> 0) >>> 0,
      // Engine's moving brush tracker on the same model (tracker.rs,
      // brush-tracker.mjs); null in a core that predates it.
      trackerHeaderPtr: typeof x.trk_header_ptr !== 'function' ? null : () => x.trk_header_ptr() >>> 0,
      trackerConstruct: pc64 => x.trk_construct(pc64 >>> 0) >>> 0,
      trackerUpdate: (actor, pc64) => x.trk_update(actor | 0, pc64 >>> 0) >>> 0,
      trackerFlush: actor => x.trk_flush(actor >>> 0),
      trackerSurfIsDynamic: surf => x.trk_surf_is_dynamic(surf | 0) >>> 0,
      trackerDestroy: () => x.trk_destroy(),
    }),
    // ADecal::execAttachDecal / execDetachDecal (decal.rs, docs/decals.md),
    // driven by decal-kernel.mjs; null when the loaded core predates them.
    decals: typeof x.decal_attach !== 'function' ? null : Object.freeze({
      memory,
      alloc,
      free,
      ioPtr: () => x.decal_io_ptr() >>> 0,
      attach: (model, store) => x.decal_attach(model >>> 0, store >>> 0),
      detach: store => x.decal_detach(store >>> 0),
      storeSize: (surfaces, capacity) => x.decal_store_size(surfaces >>> 0, capacity >>> 0) >>> 0,
      storeInit: (at, surfaces, capacity) => x.decal_store_init(at >>> 0, surfaces >>> 0, capacity >>> 0),
      storeGrow: (from, to, capacity) => x.decal_store_grow(from >>> 0, to >>> 0, capacity >>> 0),
      storeResize: (from, to, surfaces, capacity) => x.decal_store_resize(from >>> 0, to >>> 0, surfaces >>> 0, capacity >>> 0),
      modelSync: (model, pointCapacity) => x.decal_model_sync(model >>> 0, pointCapacity >>> 0) >>> 0,
      recordWords: () => x.decal_record_words(),
      clipFrame: (model, store, frame, stream, words, out, cap) =>
        x.decal_clip_frame(model >>> 0, store >>> 0, frame >>> 0, stream >>> 0, words >>> 0, out >>> 0, cap >>> 0) >>> 0,
      clipTest: (input, out) => x.decal_clip_test(input >>> 0, out >>> 0) >>> 0,
    }),
  });
}
