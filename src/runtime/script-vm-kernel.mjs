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
  const instance = await WebAssembly.instantiate(module, {env: {memory, ...kernelOnlyImports(module)}});
  return createScriptVmKernel(instance, memory);
}

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

export function createScriptVmKernel(instance, memory) {
  const x = instance.exports;
  if (x.__heap_base.value > memory.buffer.byteLength) throw new Error('Script VM kernel statics exceed its memory');
  const words = () => new Uint32Array(memory.buffer);
  uploadSineTable(x, memory);
  const resultAt = x.result_ptr() >>> 2;
  // Kernel blocks (Fire.dll textures, fire.rs; animated light maps,
  // light.rs) live above the memory's initial size, past the statics and
  // stack. Fire blocks stay for the instance's life (a page's procedural
  // textures do too); a world's light-map blocks are freed with it. A freed
  // block is handed whole to a later request it fits (first fit), so equal
  // requests reuse it exactly. This allocator is the only thing that grows
  // this instance's memory; the other kernels here re-derive their views on
  // every call.
  let top = memory.buffer.byteLength;
  const sizes = new Map(), freed = [];
  const alloc = bytes => {
    bytes = (bytes + 15) & ~15;
    const reuse = freed.findIndex(at => sizes.get(at) >= bytes);
    if (reuse >= 0) return freed.splice(reuse, 1)[0];
    const at = (top + 15) & ~15, end = at + bytes;
    if (end > memory.buffer.byteLength) memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    top = end; sizes.set(at, bytes);
    return at;
  };
  const free = at => {
    if (!sizes.has(at) || freed.includes(at)) throw new Error(`Kernel block ${at} is not allocated`);
    freed.push(at);
  };
  const vector = () => { const w = words(); return [num(w[resultAt]), num(w[resultAt + 1]), num(w[resultAt + 2])]; };
  const ints = () => { const w = new Int32Array(memory.buffer); return [w[resultAt], w[resultAt + 1], w[resultAt + 2]]; };
  return Object.freeze({
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
    // Pawn physics' x87 tails (docs/rust-core.md R3-b): script-pawn-physics.mjs
    // AvgPhysicsTime and falling.mjs refundTime.
    avgPhysicsTime: (avg, dt) => num(x.phys_avg_time(bits(avg), bits(dt))),
    refundTime: (remaining, time, step) => num(x.phys_refund_time(bits(remaining), bits(time), bits(step))),
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
      // The certain-rounding fast path (fog.rs texel_fast): `setExact(true)`
      // runs every texel on the Ext model; `fallbacks` counts the texels the
      // fast path left to Ext. `check` (validation only) runs the loop on Ext
      // with the fast path compared on every texel from the same incoming
      // flag and returns the texels where they differ.
      setExact: on => x.fog_set_exact(on ? 1 : 0),
      fallbacks: () => x.fog_fallbacks() >>> 0,
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
      merge: (header, before) => x.light_merge(header >>> 0, before >>> 0),
      colourTables: (out, red, green, blue) => x.light_colour_tables(out >>> 0, red | 0, green | 0, blue | 0),
      modulation: (factors, out) => x.light_modulation(factors >>> 0, out >>> 0),
    }),
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
      // FDynamicSprite::Setup (setup.rs) over packed candidates; null in a
      // core that predates it.
      setup: typeof x.occ_setup !== 'function' ? null
        : (candidates, count, out) => x.occ_setup(candidates >>> 0, count >>> 0, out >>> 0) >>> 0,
    }),
  });
}
