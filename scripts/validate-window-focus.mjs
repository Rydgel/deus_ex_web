/** Focused original comparison for Window.SetFocusWindow. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_INIT_OFFSETS} from '../src/runtime/script-window-init.mjs';
import {WINDOW_PARENT_OFFSETS} from '../src/runtime/script-window-parent.mjs';
import {
  WINDOW_FOCUS_NATIVE, WINDOW_FOCUS_OFFSETS, WINDOW_FOCUS_BITS, setFocusWindowNative,
} from '../src/runtime/script-window-focus.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.setfocuswindow');
assert.equal(index,WINDOW_FOCUS_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_FOCUS_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_FOCUS_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_FOCUS_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter=>parameter.name),['NewFocusWindow','ReturnValue']);
assert.equal(WINDOW_FOCUS_OFFSETS.parent,WINDOW_PARENT_OFFSETS.parent);
assert.equal(WINDOW_FOCUS_OFFSETS.windowType,WINDOW_INIT_OFFSETS.byte28);
assert.equal(WINDOW_FOCUS_OFFSETS.float80,WINDOW_INIT_OFFSETS.float80);
assert.equal(WINDOW_FOCUS_OFFSETS.dword104,WINDOW_INIT_OFFSETS.dword104);
assert.equal(WINDOW_FOCUS_BITS.selectable,0x04);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_FOCUS_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_FOCUS_NATIVE.execBody,WINDOW_FOCUS_NATIVE.execEnd,WINDOW_FOCUS_NATIVE.execSha256],
  [WINDOW_FOCUS_NATIVE.setFocusBody,WINDOW_FOCUS_NATIVE.setFocusEnd,WINDOW_FOCUS_NATIVE.setFocusSha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-focus-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_FOCUS_NATIVE.dllSha256);
assert.equal(original.addresses.setFocusWindow,0x1204f0e0);

const O=WINDOW_FOCUS_OFFSETS;
const selectable=WINDOW_FOCUS_BITS.selectable;

function slimAccess(entry){
  const slim={op:entry.op,object:entry.object,offset:entry.offset,kind:entry.kind};
  if(entry.kind==='ptr')slim.label=entry.label??null;
  else slim.bits=entry.bits;
  return slim;
}

function makeGraph(setup){
  const objects=new Map();
  for(const name of Object.keys(setup))objects.set(name,{name});
  for(const [name,fields] of Object.entries(setup)){
    const object=objects.get(name);
    object.type=fields.type_byte??1;
    object.flags=fields.flags??0;
    object.parent=fields.parent?objects.get(fields.parent):null;
    object.rootFocus=fields.focus?objects.get(fields.focus):null;
    object.type2Focus=null;
    object.float80=fields.float80??0;
    object.float84=fields.float84??0;
    object.dword104=fields.dword104??0;
    object.dword108=fields.dword108??0;
  }
  return objects;
}

function fieldOf(offset){
  return ({
    [O.windowType]:'type',[O.flags]:'flags',[O.parent]:'parent',[O.rootFocus]:'rootFocus',
    [O.type2Focus]:'type2Focus',[O.float80]:'float80',[O.float84]:'float84',
    [O.dword104]:'dword104',[O.dword108]:'dword108',
  })[offset];
}

function servicesFor(objects,accesses,events,focusable){
  const nameOf=value=>value&&typeof value==='object'?value.name:null;
  return {
    read:(target,offset,kind)=>{
      const field=fieldOf(offset);
      const value=target[field];
      const bits=kind==='ptr'?(value?1:0):value;
      accesses.push(slimAccess({
        op:'read',object:target.name,offset,kind,
        bits,label:kind==='ptr'?nameOf(value):null,
      }));
      return value;
    },
    write:(target,offset,kind,value)=>{
      const field=fieldOf(offset);
      target[field]=value;
      accesses.push(slimAccess({
        op:'write',object:target.name,offset,kind,
        bits:kind==='ptr'?(value?1:0):value,
        label:kind==='ptr'?nameOf(value):null,
      }));
    },
    checkFocusable:details=>{
      events.push({op:'checkFocusable',object:details.object.name,flag:details.flag});
      return focusable;
    },
    dispatchVirtual:details=>{
      events.push({
        op:'virtual',slot:details.slot,object:details.object.name,
        argument:details.argument?details.argument.name:null,
      });
    },
    focusGeometry:details=>{
      events.push({op:'focusGeometry',object:details.object.name,
        args:[details.arg0,details.arg1,details.arg2,details.arg3]});
    },
    focusTween:details=>{
      events.push({op:'focusTween',object:details.object.name,
        args:[details.argument,details.lo,details.hi]});
    },
  };
}

const setups={
  nonRoot:{this:{type_byte:1,flags:0}},
  alreadyFocused:{
    root:{type_byte:3,flags:selectable,focus:'new'},
    new:{parent:'root',type_byte:2,flags:selectable},
  },
  rejected:{
    root:{type_byte:3,flags:selectable,focus:'old'},
    old:{parent:'root',type_byte:1,flags:selectable},
    new:{parent:'root',type_byte:2,flags:selectable},
  },
  switch:{
    root:{type_byte:3,flags:selectable,focus:'old'},
    old:{parent:'root',type_byte:1,flags:selectable,dword108:0x11111111,float80:0x40000000,float84:0x40800000},
    new:{parent:'root',type_byte:2,flags:selectable,float80:0x41000000,float84:0x41800000,dword104:0x22222222},
  },
  clearFocus:{
    root:{type_byte:3,flags:selectable,focus:'old'},
    old:{parent:'root',type_byte:1,flags:selectable,dword108:0x33333333},
  },
  selectableAncestor:{
    root:{type_byte:3,flags:selectable,focus:'old'},
    old:{parent:'root',type_byte:1,flags:selectable,dword108:0x10},
    mid:{parent:'root',type_byte:2,flags:selectable,float80:1,float84:2,dword104:3},
    new:{parent:'mid',type_byte:1,flags:0},
  },
};
const receivers={nonRoot:'this',alreadyFocused:'root',rejected:'root',switch:'root',clearFocus:'root',selectableAncestor:'root'};
const news={nonRoot:null,alreadyFocused:'new',rejected:'new',switch:'new',clearFocus:null,selectableAncestor:'new'};
const focusable={nonRoot:1,alreadyFocused:1,rejected:0,switch:1,clearFocus:1,selectableAncestor:1};

for(const [name,reference] of Object.entries(original.cases)){
  const objects=makeGraph(setups[name]);
  const accesses=[],events=[];
  const eax=setFocusWindowNative(
    objects.get(receivers[name]),
    news[name]?objects.get(news[name]):null,
    servicesFor(objects,accesses,events,focusable[name]),
  );
  assert.equal(eax,reference.eax,name+' eax');
  assert.deepEqual(accesses,reference.accesses.map(slimAccess),name+' access order');
  assert.deepEqual(events,reference.events,name+' callback order');
  for(const [objectName,final] of Object.entries(reference.finals)){
    const object=objects.get(objectName);
    assert.equal(object.rootFocus?object.rootFocus.name:null,final.rootFocus,name+' '+objectName+' rootFocus');
    assert.equal(object.type2Focus?object.type2Focus.name:null,final.type2Focus,name+' '+objectName+' type2Focus');
  }
}
console.log('Window.SetFocusWindow matches the unchanged Extension.dll body: GetRootWindow, selectable +0x30 bit 0x04 walk, RootWindow+0x5c8, type>=2 +0x178, and the original virtual/geometry/tween leaf order.');
