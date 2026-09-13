/** Focused original comparison for Window.SetSize -> XWindow::Resize. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_SIZE_NATIVE, WINDOW_SIZE_OFFSETS, resizeWindowNative} from '../src/runtime/script-window-size.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.setsize');
assert.equal(index,WINDOW_SIZE_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_SIZE_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_SIZE_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_SIZE_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter=>parameter.name),['newWidth','NewHeight']);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_SIZE_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_SIZE_NATIVE.execBody,WINDOW_SIZE_NATIVE.execEnd,WINDOW_SIZE_NATIVE.execSha256],
  [WINDOW_SIZE_NATIVE.setSizeBody,WINDOW_SIZE_NATIVE.setSizeEnd,WINDOW_SIZE_NATIVE.setSizeSha256],
  [WINDOW_SIZE_NATIVE.resizeBody,WINDOW_SIZE_NATIVE.resizeEnd,WINDOW_SIZE_NATIVE.resizeSha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-size-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_SIZE_NATIVE.dllSha256);

const fromBits=bits=>{const b=new ArrayBuffer(4),v=new DataView(b);v.setUint32(0,bits,true);return v.getFloat32(0,true);};
const toBits=value=>{const b=new ArrayBuffer(4),v=new DataView(b);v.setFloat32(0,value,true);return v.getUint32(0,true);};
const requests={changed:[431,114],unchanged:[431,114],clamped:[-5,fromBits(0x7fc12345)],
  negativeZero:[-0,-0],storedNaN:[5,4]};
const initials={changed:[3,4],unchanged:[431,114],clamped:[3,4],negativeZero:[3,4],
  storedNaN:[fromBits(0x7fc12345),4]};

for(const [name,reference] of Object.entries(original.cases)){
  const object={values:new Map([
    [WINDOW_SIZE_OFFSETS.width,initials[name][0]],
    [WINDOW_SIZE_OFFSETS.height,initials[name][1]],
  ])};
  const accesses=[],events=[];
  resizeWindowNative(object,...requests[name],{
    read:(target,offset)=>{const value=target.values.get(offset);accesses.push({op:'read',offset,bits:toBits(value)});return value;},
    write:(target,offset,_kind,value)=>{target.values.set(offset,value);accesses.push({op:'write',offset,bits:toBits(value)});},
    askParentForReconfigure:()=>events.push({op:'AskParentForReconfigure'}),
  });
  assert.deepEqual(accesses,reference.accesses,name+' access order/bits');
  assert.deepEqual(events,reference.events,name+' callback order');
  assert.deepEqual([toBits(object.values.get(WINDOW_SIZE_OFFSETS.width)),toBits(object.values.get(WINDOW_SIZE_OFFSETS.height))],reference.final,name+' final bits');
}
console.log('Window.SetSize/Resize matches the unchanged Extension.dll body: clamp, x87 C3 comparison, exact stores and reconfiguration order.');
