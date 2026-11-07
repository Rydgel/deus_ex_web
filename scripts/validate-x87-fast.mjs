// The x87 model's limb arithmetic (native/script-vm/src/x87.rs: add, multiply, divide, square root, normalization on u64 words) against
// the u128 bodies it replaced (x87_ref.rs, the shipped module's arithmetic until 2026-11-06, which scripts/validate-script-vm-x87.mjs and
// the native operator validators were checked against), over generated 64-bit-significand operands: random, all ones, one bit, halfway
// patterns, runs, zero, infinities and NaNs of both signs, exponents close together (cancellation) and far apart, at precision
// control 64 and 24. Every field of the result (significand, exponent, sign, special word) must be equal.
// It builds the module with the selftest feature (not shipped) into .cache/wasm-selftest, then:
//   node scripts/validate-x87-fast.mjs [--rounds 4000000] [--seeds 3] [--wasm PATH] [--bench]
// --bench also times add, multiply, divide, square root and a multiply-add chain on both bodies (ns an operation, in this process).
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const rounds = Number(option('rounds', 4000000)), seeds = Number(option('seeds', 3));
const path = option('wasm', '.cache/wasm-selftest/wasm32-unknown-unknown/release/script_vm.wasm');
if (!args.includes('--wasm')) execFileSync('cargo', ['build', '--manifest-path', 'native/script-vm/Cargo.toml', '--locked', '--release', '--features', 'selftest',
  '--target', 'wasm32-unknown-unknown', '--target-dir', '.cache/wasm-selftest'], {stdio: 'inherit'});
const module = new WebAssembly.Module(readFileSync(path));
const memory = new WebAssembly.Memory({initial: 40}), imports = {env: {memory}};
for (const {module: m, name, kind} of WebAssembly.Module.imports(module)) if (kind === 'function') imports[m][name] = () => 0;
const x = new WebAssembly.Instance(module, imports).exports;
if (typeof x.x87_fast_selftest !== 'function') throw new Error('The module lacks x87_fast_selftest: build it with --features selftest');
const OPS = {1: 'add', 2: 'mul', 3: 'div', 4: 'sqrt', 5: 'normalized', 6: 'store', 7: 'store_double'};
let failed = false;
for (const precision of [64, 24]) for (let seed = 1; seed <= seeds; seed++) {
  const bad = x.x87_fast_selftest(seed, rounds, precision) >>> 0;
  const io = new Uint32Array(memory.buffer, x.x87_selftest_io_ptr() >>> 0, 48);
  console.log(`precision ${precision} seed ${seed}: ${io[0]} comparisons, ${bad} mismatches` + (bad ? ` (${Object.entries(OPS).map(([k, v]) => v + " " + io[40 + Number(k)]).join(", ")})` : ""));
  if (bad) {
    failed = true;
    const show = at => `sig 0x${((BigInt(io[at + 1]) << 32n) | BigInt(io[at])).toString(16)} exp ${io[at + 2] | 0} sign ${io[at + 3] >>> 0 ? '-' : '+'} special 0x${io[at + 4].toString(16)}`;
    console.log(`first mismatch (${OPS[io[2]]}):\n  a ${show(3)}\n  b ${show(8)}\n  got ${show(13)}\n  want ${show(18)}`);
  }
}
if (args.includes('--bench')) {
  const kinds = ['add', 'mul', 'div', 'sqrt', 'mul-add chain'], n = 4000000;
  for (let kind = 0; kind < kinds.length; kind++) {
    const times = [0, 1].map(reference => {
      x.x87_fast_bench(kind, reference, 200000);
      const best = [];
      for (let i = 0; i < 5; i++) { const t = process.hrtime.bigint(); x.x87_fast_bench(kind, reference, n); best.push(Number(process.hrtime.bigint() - t) / n); }
      return Math.min(...best);
    });
    console.log(`${kinds[kind].padEnd(14)} limbs ${times[0].toFixed(1)} ns, u128 reference ${times[1].toFixed(1)} ns (${(times[1] / times[0]).toFixed(2)}x)`);
  }
}
process.exit(failed ? 1 : 0);
