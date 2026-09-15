/** Focused original comparison for Window.GetParent -> XWindow::GetParent. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_ORDER_OFFSETS} from '../src/runtime/script-window-order.mjs';
import {WINDOW_PARENT_NATIVE, WINDOW_PARENT_OFFSETS, getParentWindowNative} from '../src/runtime/script-window-parent.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.getparent');
assert.equal(index,WINDOW_PARENT_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_PARENT_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_PARENT_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_PARENT_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter=>parameter.name),['ReturnValue']);
assert.equal(WINDOW_PARENT_OFFSETS.parent,WINDOW_ORDER_OFFSETS.parent);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_PARENT_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_PARENT_NATIVE.execBody,WINDOW_PARENT_NATIVE.execEnd,WINDOW_PARENT_NATIVE.execSha256],
  [WINDOW_PARENT_NATIVE.getParentBody,WINDOW_PARENT_NATIVE.getParentEnd,WINDOW_PARENT_NATIVE.getParentSha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-parent-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_PARENT_NATIVE.dllSha256);
assert.equal(original.addresses.getParent,0x1204c550);

const parent={name:'parent'};
const initials={nullParent:null,liveParent:parent};
const expectedEax={nullParent:0,liveParent:original.addresses.parentWindow};

for(const [name,reference] of Object.entries(original.cases)){
  const object={values:new Map([
    [WINDOW_PARENT_OFFSETS.parent,initials[name]],
    [0x13c,0x11111111],
  ])};
  const accesses=[];
  const result=getParentWindowNative(object,{
    read:(target,offset)=>{
      const value=target.values.get(offset);
      const bits=value===parent?original.addresses.parentWindow:(value===null||value===undefined?0:value>>>0);
      accesses.push({op:'read',offset,bits});
      return value;
    },
  });
  assert.deepEqual(accesses,reference.accesses,name+' access order/bits');
  assert.equal(result,initials[name],name+' returned parent');
  assert.equal(reference.eax,expectedEax[name],name+' native eax');
  assert.equal(reference.finalParent,expectedEax[name],name+' parent slot unchanged');
  assert.equal(reference.finalFirstChild,0x11111111,name+' first-child slot untouched');
}
console.log('Window.GetParent matches the unchanged Extension.dll body: a single +0x138 pointer read with no writes.');
