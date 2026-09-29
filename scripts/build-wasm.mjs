/** Build our authored kernels only; no original data is embedded. */
import {execFileSync} from 'node:child_process';
import {copyFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const [crate,artifact,output] of [
  ['lodmesh-kernel','lodmesh_kernel.wasm','lodmesh-kernel.wasm'],
  ['script-vm','script_vm.wasm','script-vm.wasm'],
]){
  execFileSync('cargo',['build','--manifest-path',`native/${crate}/Cargo.toml`,
    '--locked','--release','--target','wasm32-unknown-unknown','--target-dir','.cache/wasm'],
    {cwd:root,stdio:'inherit'});
  await copyFile(new URL(`.cache/wasm/wasm32-unknown-unknown/release/${artifact}`,root),
    new URL(`src/runtime/${output}`,root));
}
