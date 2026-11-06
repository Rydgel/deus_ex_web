// The decal fast paths' sign filters (native/script-vm/src/decal/fast.rs) against the x87 expressions of FindSurface and GatherNodes,
// over generated cases: random edges and points, points on the edge line, a few ulps off it, at the vertex, degenerate edges.
// It builds the module with the selftest feature (not shipped) into .cache/wasm-selftest, then:
//   node scripts/validate-decal-fast.mjs [--rounds 4000000] [--seeds 3] [--wasm PATH]
// The decal attach itself is compared by its `verify` mode (DECAL_FAST=verify, docs/decals.md "Fast surface finding").
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
if (typeof x.decal_fast_selftest !== 'function') throw new Error('The module lacks decal_fast_selftest: build it with --features selftest');
let failed = false;
for (let seed = 1; seed <= seeds; seed++) {
  const bad = x.decal_fast_selftest(seed, rounds) >>> 0;
  const io = new Uint32Array(memory.buffer, x.decal_io_ptr() >>> 0, 32);
  console.log(`seed ${seed}: ${io[0]} cases, ${bad} mismatches; the filter decided ${io[1]} vertex signs (${(100 * io[1] / io[0]).toFixed(1)}%) and ${io[2]} distance signs (${(100 * io[2] / io[0]).toFixed(1)}%)`);
  if (bad) { failed = true; console.log('first mismatch cur/prev/n/p bits:', [...io.slice(8, 20)].map(v => v.toString(16))); }
}
process.exit(failed ? 1 : 0);
