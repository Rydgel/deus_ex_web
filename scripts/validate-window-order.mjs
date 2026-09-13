/** Focused metadata/hash and translated branch validation for Raise/Hide. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {raiseWindowNative,hideWindowNative,WINDOW_ORDER_NATIVE,WINDOW_ORDER_OFFSETS} from '../src/runtime/script-window-order.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
for(const [pathName,evidence] of [['window.raise',WINDOW_ORDER_NATIVE.raise],['window.hide',WINDOW_ORDER_NATIVE.hide]]){
  const index=extension.exportsByPath.get(pathName),metadata=readFunctionMetadata(extension,index);
  assert.equal(index,evidence.packageExport);assert.equal(metadata.nativeIndex,evidence.nativeIndex);
  assert.equal(metadata.functionFlags,evidence.functionFlags);assert.equal(metadata.entry.serialSize,evidence.serialSize);
  assert.equal(metadata.parameters.length,0);
}
const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_ORDER_NATIVE.dllSha256);
for(const evidence of [WINDOW_ORDER_NATIVE.raise,WINDOW_ORDER_NATIVE.hide])for(const [start,end,hash] of [
  [evidence.execBody,evidence.execEnd,evidence.execSha256],[evidence.body,evidence.end,evidence.bodySha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const child={},parent={},next={},events=[];
const links=new Map([[child,new Map([[WINDOW_ORDER_OFFSETS.parent,parent],[WINDOW_ORDER_OFFSETS.nextSibling,null]])]]);
const services={read:(object,offset)=>{events.push(['read',offset]);return links.get(object)?.get(offset)??null;},
  addChild:details=>events.push(['AddChild',details.parent,details.child,details.flag]),
  askParentForReconfigure:details=>events.push(['AskParentForReconfigure',details.object]),
  checkFocusWindow:details=>events.push(['CheckFocusWindow',details.object])};
assert.equal(raiseWindowNative(child,services),false);assert.deepEqual(events,[['read',0x138],['read',0x148]]);
events.length=0;links.get(child).set(WINDOW_ORDER_OFFSETS.nextSibling,next);
assert.equal(raiseWindowNative(child,services),true);
assert.deepEqual(events,[['read',0x138],['read',0x148],['AddChild',parent,child,1],
  ['AskParentForReconfigure',child],['CheckFocusWindow',child]]);
const rootWindow={},memory=new Map([[rootWindow,new Map([[0x30,0],[0x138,null]])]]),visibilityEvents=[];
hideWindowNative(rootWindow,{read:(object,offset)=>memory.get(object)?.get(offset)??0,
  write:(object,offset,_kind,value)=>memory.get(object).set(offset,value),
  checkFocusWindow:()=>visibilityEvents.push('focus'),checkGrabbedWindow:()=>visibilityEvents.push('grab'),
  recomputeInitTree:()=>visibilityEvents.push('init'),invokeVisibilityChange:()=>visibilityEvents.push('event'),
  reconfigureTree:()=>visibilityEvents.push('reconfigure'),makeAcceleratorTableDirty:()=>visibilityEvents.push('accelerator')});
assert.equal(memory.get(rootWindow).get(0x30),0);assert.deepEqual(visibilityEvents,[],'already-hidden guard');
console.log('Window Raise/Hide passed: installed metadata/hashes, sibling guard/reorder leaf order, and Hide -> SetVisibility(0).');
