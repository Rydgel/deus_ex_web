/** Compose independently recovered NewChild, Init, child links and script
 * events and constructors. Allocated/default-initialized objects and native
 * allocation/rendering services are explicit fixtures; this does not claim UI bootstrap. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {initWindowNative} from '../src/runtime/script-window-init.mjs';
import {addWindowChildNative} from '../src/runtime/script-window-hierarchy.mjs';
import {WINDOW_RECONFIGURE_GLOBALS}
  from '../src/runtime/script-window-reconfigure.mjs';
import {constructWindowNative,constructWindowGcNative,setWindowGcFontsNative,WINDOW_CONSTRUCTION_NATIVE}
  from '../src/runtime/script-window-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const assets=new AssetStore((await readdir(path.join(root,'System'))).map(name=>({
  path:'System/'+name,read:()=>readFile(path.join(root,'System',name)),
})));
const addresses=new Map(),objects=new Map(),memory=new Map();
function allocated(label,size=0x200){
  const object={label},address=0x21010000+addresses.size*0x1000;
  addresses.set(object,address);objects.set(address,object);
  memory.set(object,new DataView(new ArrayBuffer(size)));
  return object;
}
function read(object,offset,kind){
  const view=memory.get(object);
  if(kind==='u8')return view.getUint8(offset);
  if(kind==='f32')return view.getFloat32(offset,true);
  const value=view.getUint32(offset,true);
  if(kind==='ptr'){
    if(value===0)return null;
    assert.ok(objects.has(value),'fixture pointer must resolve');return objects.get(value);
  }
  return kind==='i32'?view.getInt32(offset,true):value;
}
function write(object,offset,kind,value){
  const view=memory.get(object);
  if(kind==='u8')view.setUint8(offset,value);
  else if(kind==='f32')view.setFloat32(offset,value,true);
  else view.setUint32(offset,kind==='ptr'?(value?addresses.get(value):0):value,true);
}
const parent=allocated('parent'),child=allocated('child');
const font=allocated('font',4),graphics=[];
write(parent,0xd4,'f32',23);write(parent,0xd8,'f32',47);
write(parent,0x54,'ptr',font);
const events=[];
const reconfigureGlobals=new Map(Object.values(WINDOW_RECONFIGURE_GLOBALS).map(name=>[name,0]));
// Core UObject's default constructor is a single vtable store, separately
// recovered in docs/script-construction.md. Allocation/header/default copying
// are explicit initial fixtures here, not simulated by this callback.
const coreObjectConstructor=({object})=>write(object,0,'u32',0x10179dfc);
const runtime=new ScriptRuntime(assets);
const extension=await assets.get('Extension');
const classRecord=await runtime.objects.resolve(extension,extension.exportsByPath.get('window'));
const windowClass=await runtime.loadClass(extension,classRecord.index);
runtime.attach(parent,windowClass);runtime.attach(child,windowClass);
for(const name of ['initwindow','childadded','descendantadded'])
  await runtime.prepareFunction(extension,extension.exportsByPath.get('window.'+name));
const newChild=await runtime.prepareFunction(extension,extension.exportsByPath.get('window.newchild'));
const initServices={
  read,write,pointerWord:({object})=>addresses.get(object),fNameNone:()=>0,
  xgcOperatorNew:request=>{
    assert.equal(request.outer,child);assert.equal(request.size,0xb8);
    assert.equal(request.name,0);assert.equal(request.flags,0);
    const gc=allocated('gc'+graphics.length,0xb8);graphics.push(gc);
    events.push('allocateGC');return gc;
  },
  xgcConstructor:({object})=>{
    events.push('GC constructor');
    constructWindowGcNative(object,{read,write,coreObjectConstructor,nativeAddress:addresses.get(object)});
  },
  addChild:({parent,child,flag})=>{
    events.push('AddChild');
    addWindowChildNative(parent,child,flag,{
      read:(object,offset)=>read(object,offset,'ptr'),
      write:(object,offset,value)=>write(object,offset,'ptr',value),
    });
  },
  childAdded:({parent,child})=>{
    events.push('ChildAdded');runtime.processEvent(parent,'ChildAdded',[child]);
  },
  descendantAdded:({parent,child})=>{
    events.push('DescendantAdded');runtime.processEvent(parent,'DescendantAdded',[child]);
  },
  setFonts:({graphicsContext,normalFont,boldFont})=>{
    assert.equal(graphicsContext,graphics[0]);assert.equal(normalFont,font);assert.equal(boldFont,null);
    setWindowGcFontsNative({graphicsContext,normalFont,boldFont},{write});
    events.push('SetFonts');
  },
};
runtime.windowLifecycle={
  errorDevice:{},isScriptable:()=>true,
  staticConstructObject:request=>{
    assert.equal(request.classObject,classRecord);assert.equal(request.outer,parent);
    events.push('StaticConstructObject allocation boundary');
    constructWindowNative(child,{read,write,coreObjectConstructor});return child;
  },
  initVtable:request=>{
    assert.equal(request.virtualSlot,0x54);assert.equal(request.object,child);
    initWindowNative({window:request.object,parent:request.parent},initServices);
  },
  read:(object,key)=>read(object,key==='lockCount'?0x34:0x30,key==='lockCount'?'i32':'u32'),
  write:(object,key,value)=>write(object,key==='lockCount'?0x34:0x30,'u32',value),
  setVisibility:({visible})=>{assert.equal(visible,true);events.push('visibility boundary');},
  reconfiguration:{read,
    write:(object,offset,kind,value)=>{
      if(offset===0xb8)events.push('AskParentForReconfigure');
      write(object,offset,kind,value);
    },
    readGlobal:name=>{assert.ok(reconfigureGlobals.has(name));return reconfigureGlobals.get(name);},
    writeGlobal:(name,_kind,value)=>reconfigureGlobals.set(name,value),
  },
};
const processScript=runtime.processWindowScript.bind(runtime);
runtime.processWindowScript=request=>{
  assert.equal(read(child,0x34,'i32'),1,'InitWindow runs while locked');
  events.push('InitWindow');return processScript(request);
};
assert.equal(runtime.callFunction(newChild,parent,1,()=>classRecord),child);
assert.deepEqual(events,['StaticConstructObject allocation boundary','allocateGC','GC constructor',
  'allocateGC','GC constructor','AddChild','ChildAdded','DescendantAdded','SetFonts',
  'InitWindow','visibility boundary','AskParentForReconfigure']);
assert.equal(read(child,0x138,'ptr'),parent);
assert.equal(read(parent,0x13c,'ptr'),child);assert.equal(read(parent,0x140,'ptr'),child);
assert.equal(read(child,0x130,'ptr'),graphics[0]);assert.equal(read(child,0x134,'ptr'),graphics[1]);
assert.equal(read(graphics[0],0x7c,'ptr'),font);assert.equal(read(graphics[0],0x80,'ptr'),null);
assert.equal(read(child,0,'u32'),WINDOW_CONSTRUCTION_NATIVE.classes.window.vtable);
for(const gc of graphics){
  assert.equal(read(gc,0,'u32'),WINDOW_CONSTRUCTION_NATIVE.classes.gc.vtable);
  assert.equal(read(gc,0x54,'u32'),0x21ffffff);
  assert.equal(read(gc,0x68,'u32'),0x2100ff00);
}
assert.equal(read(child,0xd4,'f32'),23);assert.equal(read(child,0xd8,'f32'),47);
assert.equal(read(child,0x54,'ptr'),font);assert.equal(read(child,0x34,'i32'),0);
assert.equal(read(child,0xb8,'u8')&3,3,'hidden child still receives original reconfiguration flags');
assert.equal(read(child,0x60,'u32'),0x21ffffff,'preserve the actual supplied parent pointer high byte');
const askParent=await runtime.prepareFunction(extension,extension.exportsByPath.get('window.askparentforreconfigure'));
write(child,0xb8,'u8',0x80);
runtime.callFunction(askParent,child,0,()=>{throw new Error('no arguments');});
assert.equal(read(child,0xb8,'u8'),0x83,'shared native1460 reaches original reconfiguration body');
console.log('Window lifecycle integration passed: shared NewChild -> recovered Window/GC constructors, Init/AddChild and original Window events; '+
  'canonical links, GC pointers, original SetFonts, hidden-window reconfiguration, inherited font/origin and lock lifetime. Allocation/visibility remain explicit boundaries.');
