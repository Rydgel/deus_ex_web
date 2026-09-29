/** The Rust script core's x87 operator kernel (native/script-vm,
 * docs/rust-core.md step R2b). The JavaScript VM's operator bodies call it in
 * place of the BigInt x87 model once it is loaded; before that (and in hosts
 * that never load it) the BigInt bodies run. scripts/validate-script-vm-x87.mjs
 * proves the two equal.
 *
 * Operands cross as float32 bit patterns through the same f32bits/f32num the
 * BigInt model loads and stores with, so NaN payloads and signed zeros agree.
 * The kernel has its own memory for now; the VM proper will run in the
 * runtime's object arena. */
import {rotationSineTable} from './coords.mjs';

const f32io = new DataView(new ArrayBuffer(4));
const bits = v => (f32io.setFloat32(0, Math.fround(v), true), f32io.getUint32(0, true));
const num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));

export let scriptVmKernel = null;
let pending = null;

/** Load the kernel once; later calls return the same promise. */
export function loadScriptVmKernel() {
  return pending ??= load().then(kernel => (scriptVmKernel = kernel));
}

async function load() {
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
  const module = await WebAssembly.compile(bytes);
  // The module's shadow stack and statics end below 2 MiB (build.rs).
  const memory = new WebAssembly.Memory({initial: 32});
  const instance = await WebAssembly.instantiate(module, {env: {memory}});
  return createScriptVmKernel(instance, memory);
}

export function createScriptVmKernel(instance, memory) {
  const x = instance.exports;
  if (x.__heap_base.value > memory.buffer.byteLength) throw new Error('Script VM kernel statics exceed its memory');
  const words = () => new Uint32Array(memory.buffer);
  const sine = rotationSineTable(), table = words(), sineAt = x.sine_ptr() >>> 2;
  for (let i = 0; i < sine.length; i++) table[sineAt + i] = bits(sine[i]);
  const resultAt = x.result_ptr() >>> 2;
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
  });
}
