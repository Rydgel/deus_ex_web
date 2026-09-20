/** Build our authored kernel only; no original data is embedded. */
import {execFileSync} from 'node:child_process';
import {copyFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
execFileSync('cargo',['build','--manifest-path','native/lodmesh-kernel/Cargo.toml',
  '--locked','--release','--target','wasm32-unknown-unknown','--target-dir','.cache/wasm'],
  {cwd:root,stdio:'inherit'});
await copyFile(new URL('.cache/wasm/wasm32-unknown-unknown/release/lodmesh_kernel.wasm',root),
  new URL('src/runtime/lodmesh-kernel.wasm',root));
