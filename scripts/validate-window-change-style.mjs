/** Focused original comparison for Window.ChangeStyle. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_INIT_OFFSETS} from '../src/runtime/script-window-init.mjs';
import {WINDOW_PARENT_OFFSETS} from '../src/runtime/script-window-parent.mjs';
import {WINDOW_SENSITIVITY_OFFSETS} from '../src/runtime/script-window-sensitivity.mjs';
import {
  WINDOW_CHANGE_STYLE_NATIVE, WINDOW_CHANGE_STYLE_OFFSETS, WINDOW_CHANGE_STYLE_NATIVE_ADDRESSES,
  changeStyleWindowNative,
} from '../src/runtime/script-window-change-style.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.changestyle');
assert.equal(index,WINDOW_CHANGE_STYLE_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_CHANGE_STYLE_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_CHANGE_STYLE_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_CHANGE_STYLE_NATIVE.serialSize);
assert.equal(metadata.parameters.length,0);
assert.equal(WINDOW_CHANGE_STYLE_OFFSETS.parent,WINDOW_PARENT_OFFSETS.parent);
assert.equal(WINDOW_CHANGE_STYLE_OFFSETS.windowType,WINDOW_INIT_OFFSETS.byte28);
assert.equal(WINDOW_CHANGE_STYLE_OFFSETS.topChild,WINDOW_SENSITIVITY_OFFSETS.topChild);
assert.equal(WINDOW_CHANGE_STYLE_OFFSETS.lowerSibling,WINDOW_SENSITIVITY_OFFSETS.lowerSibling);
assert.notEqual(WINDOW_CHANGE_STYLE_OFFSETS.topChild,WINDOW_SENSITIVITY_OFFSETS.bottomChild);
assert.notEqual(WINDOW_CHANGE_STYLE_OFFSETS.lowerSibling,WINDOW_SENSITIVITY_OFFSETS.higherSibling);
assert.equal(WINDOW_CHANGE_STYLE_NATIVE_ADDRESSES.virtualStyleChanged,0xe4);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_CHANGE_STYLE_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_CHANGE_STYLE_NATIVE.execBody,WINDOW_CHANGE_STYLE_NATIVE.execEnd,WINDOW_CHANGE_STYLE_NATIVE.execSha256],
  [WINDOW_CHANGE_STYLE_NATIVE.changeStyleBody,WINDOW_CHANGE_STYLE_NATIVE.changeStyleEnd,WINDOW_CHANGE_STYLE_NATIVE.changeStyleSha256],
  [WINDOW_CHANGE_STYLE_NATIVE.walkBody,WINDOW_CHANGE_STYLE_NATIVE.walkEnd,WINDOW_CHANGE_STYLE_NATIVE.walkSha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-change-style-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_CHANGE_STYLE_NATIVE.dllSha256);
assert.equal(original.addresses.changeStyle,0x12050310);

const O=WINDOW_CHANGE_STYLE_OFFSETS;

function slimAccess(entry){
  const slim={op:entry.op,object:entry.object,offset:entry.offset,kind:entry.kind};
  if(entry.kind==='ptr')slim.label=entry.label??null;
  else slim.bits=entry.bits;
  return slim;
}

const setups={
  nonRoot:{this:{type:1}},
  emptyRoot:{root:{type:3}},
  singleChild:{
    root:{type:3,top:'child',first:'child'},
    child:{parent:'root',type:1},
  },
  siblings:{
    root:{type:3,top:'childB',first:'childA'},
    childB:{parent:'root',type:1,lower:'childA'},
    childA:{parent:'root',type:1,higher:'childB'},
  },
  nested:{
    root:{type:3,top:'mid'},
    mid:{parent:'root',type:1,top:'leaf'},
    leaf:{parent:'mid',type:1},
  },
  fromChild:{
    root:{type:3,top:'mid'},
    mid:{parent:'root',type:1,top:'leaf'},
    leaf:{parent:'mid',type:1},
  },
  twoLevel:{
    root:{type:3,top:'midB',first:'midA'},
    midB:{parent:'root',type:1,top:'leafB',lower:'midA'},
    midA:{parent:'root',type:1,top:'leafA',higher:'midB'},
    leafB:{parent:'midB',type:1},
    leafA:{parent:'midA',type:1},
  },
};
const receivers={nonRoot:'this',emptyRoot:'root',singleChild:'root',siblings:'root',
  nested:'root',fromChild:'leaf',twoLevel:'root'};

function makeGraph(setup){
  const objects=new Map();
  for(const name of Object.keys(setup))objects.set(name,{name});
  for(const [name,fields] of Object.entries(setup)){
    const object=objects.get(name);
    object.type=fields.type??1;
    object.parent=fields.parent?objects.get(fields.parent):null;
    object.top=fields.top?objects.get(fields.top):null;
    object.lower=fields.lower?objects.get(fields.lower):null;
    object.first=fields.first?objects.get(fields.first):null;
    object.higher=fields.higher?objects.get(fields.higher):null;
  }
  return objects;
}

function fieldOf(offset){
  return ({
    [O.windowType]:'type',[O.parent]:'parent',[O.topChild]:'top',[O.lowerSibling]:'lower',
  })[offset];
}

for(const [name,reference] of Object.entries(original.cases)){
  const objects=makeGraph(setups[name]);
  const accesses=[],events=[];
  changeStyleWindowNative(objects.get(receivers[name]),{
    read:(target,offset,kind)=>{
      const field=fieldOf(offset);
      const value=field==='type'?target.type:target[field];
      const bits=kind==='u8'?value:(value?1:0);
      accesses.push({
        op:'read',object:target.name,offset,kind,
        bits:kind==='u8'?value:bits,
        label:kind==='ptr'?(value?value.name:null):undefined,
      });
      return value??null;
    },
    dispatchVirtual:details=>events.push({
      op:'StyleChanged',object:details.object.name,slot:details.slot,
    }),
  });
  assert.deepEqual(accesses.map(slimAccess),reference.accesses.map(slimAccess),name+' access order');
  assert.deepEqual(events,reference.events,name+' StyleChanged order');
}
console.log('Window.ChangeStyle matches the unchanged Extension.dll body: GetRootWindow, vtable +0xe4 StyleChanged, GetTopChild/GetLowerSibling flag 0.');
