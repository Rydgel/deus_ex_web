/** Builds src/runtime/script-vm-eq-ref.wasm: the script core with core's `==` on word arrays (feature eq_ref: a memcmp call) where interp.rs words_eq and
 * ints_eq compare the words in line, the A/B arm of `?wordEq=ref` / `WORD_EQ=ref` (docs/firefox-60fps-plan.md "Firefox wasm gap"). Not part of
 * `npm run build:wasm`; the file is git-ignored. */
import {execFileSync} from 'node:child_process';
import {copyFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
execFileSync('cargo', ['build', '--manifest-path', 'native/script-vm/Cargo.toml', '--locked', '--release', '--features', 'eq_ref',
  '--target', 'wasm32-unknown-unknown', '--target-dir', '.cache/wasm-eq-ref'], {cwd: root, stdio: 'inherit'});
await copyFile(new URL('.cache/wasm-eq-ref/wasm32-unknown-unknown/release/script_vm.wasm', root), new URL('src/runtime/script-vm-eq-ref.wasm', root));
