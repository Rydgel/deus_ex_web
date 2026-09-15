/** Focused original comparison for Window.Lower -> XWindow::Lower. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_ORDER_OFFSETS} from '../src/runtime/script-window-order.mjs';
import {WINDOW_SENSITIVITY_OFFSETS} from '../src/runtime/script-window-sensitivity.mjs';
import {WINDOW_LOWER_NATIVE, WINDOW_LOWER_OFFSETS, lowerWindowNative} from '../src/runtime/script-window-lower.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.lower');
assert.equal(index,WINDOW_LOWER_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_LOWER_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_LOWER_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_LOWER_NATIVE.serialSize);
assert.equal(metadata.parameters.length,0);
assert.equal(WINDOW_LOWER_OFFSETS.parent,WINDOW_ORDER_OFFSETS.parent);
assert.equal(WINDOW_LOWER_OFFSETS.prevSibling,WINDOW_SENSITIVITY_OFFSETS.lowerSibling);
assert.notEqual(WINDOW_LOWER_OFFSETS.prevSibling,WINDOW_ORDER_OFFSETS.nextSibling);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_LOWER_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_LOWER_NATIVE.execBody,WINDOW_LOWER_NATIVE.execEnd,WINDOW_LOWER_NATIVE.execSha256],
  [WINDOW_LOWER_NATIVE.body,WINDOW_LOWER_NATIVE.end,WINDOW_LOWER_NATIVE.bodySha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-lower-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_LOWER_NATIVE.dllSha256);
assert.equal(original.addresses.lower,0x1204c2f0);

const parent={name:'parent'},prev={name:'prev'},next={name:'next'};
const cases={
  noParent:{parent:null,prev,next},
  noLower:{parent,prev:null,next},
  lowered:{parent,prev,next},
};
const pointerBits={parent:1,prev:2,next:3,null:0,undefined:0};

for(const [name,reference] of Object.entries(original.cases)){
  const setup=cases[name];
  const child={values:new Map([
    [WINDOW_LOWER_OFFSETS.parent,setup.parent],
    [WINDOW_LOWER_OFFSETS.prevSibling,setup.prev],
    [WINDOW_ORDER_OFFSETS.nextSibling,setup.next],
  ])};
  const accesses=[],events=[];
  const result=lowerWindowNative(child,{
    read:(target,offset)=>{
      const value=target.values.get(offset)??null;
      accesses.push({
        op:'read',offset,
        bits:value?pointerBits[value.name]:0,
        label:value?value.name:null,
      });
      return value;
    },
    addChild:details=>events.push({op:'AddChild',parent:details.parent.name,child:'child',flag:details.flag}),
    askParentForReconfigure:details=>events.push({op:'AskParentForReconfigure',object:'child'}),
    checkFocusWindow:details=>events.push({op:'CheckFocusWindow',object:'child'}),
  });
  assert.deepEqual(
    accesses.map(({op,offset,label})=>({op,offset,label})),
    reference.accesses.map(({op,offset,label})=>({op,offset,label})),
    name+' access order');
  assert.deepEqual(events,reference.events,name+' callback order');
  assert.equal(result,name==='lowered',name+' return');
}
console.log('Window.Lower matches the unchanged Extension.dll body: parent and +0x144 guards, AddChild(front=0), reconfigure, CheckFocusWindow.');
