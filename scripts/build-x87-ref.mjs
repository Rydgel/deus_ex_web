/** Builds src/runtime/script-vm-ref.wasm: the script core with every x87 operation on the u128 bodies of x87_ref.rs (feature x87_ref), the A/B arm of
 * `?x87=ref` / `X87=ref` (docs/firefox-60fps-plan.md "Combat tick"). Not part of `npm run build:wasm`; the file is git-ignored. */
import {execFileSync} from 'node:child_process';
import {copyFile} from 'node:fs/promises';
const root = new URL("../", import.meta.url);
execFileSync('cargo', ['build', '--manifest-path', 'native/script-vm/Cargo.toml', '--locked', '--release', '--features', 'x87_ref',
  '--target', 'wasm32-unknown-unknown', '--target-dir', '.cache/wasm-x87-ref'], {cwd: root, stdio: 'inherit'});
await copyFile(new URL('.cache/wasm-x87-ref/wasm32-unknown-unknown/release/script_vm.wasm', root), new URL('src/runtime/script-vm-ref.wasm', root));
