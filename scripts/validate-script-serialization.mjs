/** Original CameraPoint class/state metadata through the native Actor ->
 * UObject GC-mode serializer. The recording archive checks native call/storage
 * boundaries; complete class/resource GC graph traversal is separate. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {GC_ARCHIVE_WORDS,GC_FLAGS,createGarbageArchive} from '../src/runtime/script-gc.mjs';
import {createScriptGcBridge} from '../src/runtime/script-gc-bridge.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {serializeTaggedPropertiesGc} from '../src/runtime/script-tagged-properties.mjs';
import {serializeUField,serializeUState} from '../src/runtime/script-class-serialization.mjs';
import {serializeGcProperty,PROPERTY_SERIALIZER_VTABLES} from '../src/runtime/script-property-serialization.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),engine=await assets.get('Engine'),runtime=new ScriptRuntime(assets);
const cls=await runtime.loadClass(engine,engine.exportsByPath.get('camerapoint'));
const actor={name:'SerializedCameraPoint'},outer={identity:{name:'FixturePackage'},index:7};
runtime.attach(actor,cls);
const object={identity:actor,index:0,flags:1,name:actor.name,nameIndex:1,outer,
  linker:null,linkerIndex:-1,stateFrame:null,objectClass:cls,nativeVtable:0x10427178};
runtime.bindNativeObject(actor,object);runtime.initExecution(actor);
const idle=await runtime.prepareState(engine,engine.exportsByPath.get('camerapoint.idle'));
const beginState=runtime.lookup(actor,'BeginState');
await runtime.prepareFunction(beginState.asset,beginState.index);
assert.equal(runtime.gotoState(actor,'Auto','Begin'),true);
const state=runtime.instance(actor).state;
assert.equal(state.stateNode,idle);assert.equal(state.execution.cursor,0);
const target={name:'CameraPointTarget'};runtime.attach(target,cls);
runtime.namedReference(actor,'Target').set(target);
runtime.setRegion(actor,target,-9,4);

const calls=[],preloads=[],raw=[];
const archive={archiveState:{...GC_ARCHIVE_WORDS},
  objectReference:(reference,context)=>calls.push({kind:'object',key:context.key,value:reference.get()}),
  nameReference:(reference,context)=>calls.push({kind:'name',key:context.key,value:reference.get()}),
  preloadObject:value=>preloads.push(value),
  serializeRaw:(reference,size,context)=>raw.push({key:context.key,size,value:reference.get()}),
  countBytes:(used,allocated)=>{assert.equal(used,0x390);assert.equal(allocated,0x390);calls.push({kind:'count'});},
};
const result=runtime.serializeActorGc(actor,archive,{getPropertiesSize:()=>0x390});
assert.equal(object.flags>>>0,0x42000001);assert.equal(result.properties.called,true);
assert.deepEqual(calls.slice(0,6),[
  {kind:'name',key:'header.name',value:actor.name},
  {kind:'object',key:'header.outer',value:outer.identity},
  {kind:'object',key:'header.class',value:cls.record},
  {kind:'object',key:'header.linker',value:null},
  {kind:'object',key:'stateFrame.node',value:idle.record},
  {kind:'object',key:'stateFrame.state',value:idle.record},
]);
assert.deepEqual(preloads,[cls.record,idle.record]);
assert.deepEqual(raw.map(entry=>[entry.key,entry.size]),[
  ['stateFrame.probeMask',8],['stateFrame.latentAction',4],['stateFrame.codeOffset',4],
]);
assert.equal(raw[2].value,0);assert.equal(state.execution.cursor,0);assert.equal(state.latent,0);
assert(calls.some(entry=>entry.key==='engine.actor.target'&&entry.value===target));
assert(calls.some(entry=>entry.key==='engine.actor.pointregion.zone'&&entry.value===target));
assert.equal(calls.at(-1).kind,'count');

// Original Serialize owns disposal of an existing frame when its flag is clear.
object.flags&=~0x02000000;
let freed=null;
runtime.serializeActorGc(actor,archive,{getPropertiesSize:()=>0x390,
  freeStateFrame:frame=>{assert.equal(object.stateFrame,frame);freed=frame;},
});
assert.equal(freed,state);assert.equal(object.stateFrame,null);assert.equal(runtime.instance(actor).state,null);

// Metadata objects have their own native serializer chain. Resolve original
// Owner property links rather than substituting instance-value references.
const field=cls.propertyLink.find(field=>field.key==='engine.actor.owner');
assert(field);
const property=field.metadata;
const superField=await runtime.objects.resolve(field.asset,property.superFieldRef);
const nextField=await runtime.objects.resolve(field.asset,property.nextRef);
const propertyClass=await runtime.objects.resolve(field.asset,property.propertyClassRef);
const propertyObject={identity:field,nativeVtable:PROPERTY_SERIALIZER_VTABLES.ObjectProperty,
  baseField:superField,next:nextField};
const slots=new Map([[0x34,property.arrayDim],[0x3c,property.flags],[0x40,property.category],
  [0x44,property.repOffset],[0x5c,propertyClass]]);
const propertyCalls=[];
const propertyArchive={archiveState:{...GC_ARCHIVE_WORDS},
  objectReference:(reference,context)=>propertyCalls.push(['object',context.offset,reference.get()]),
  nameReference:(reference,context)=>propertyCalls.push(['name',context.offset,reference.get()]),
  serializeRaw:(reference,size,context)=>propertyCalls.push(['raw',context.offset,size,reference.get()]),
};
serializeGcProperty(propertyObject,propertyArchive,{
  serializeUField:(object,archive)=>serializeUField(object,archive,{
    // Native property-class registration is an explicit boundary here;
    // the Actor/UObject integration is exercised separately above.
    serializeUObject:()=>propertyCalls.push(['UObject']),
  }),
  slot:(_,offset)=>({get:()=>slots.get(offset),set:value=>slots.set(offset,value)}),
});
assert.deepEqual(propertyCalls,[['UObject'],['object',0x28,superField],['object',0x2c,nextField],
  ['raw',0x34,4,property.arrayDim],['raw',0x3c,4,property.flags],['name',0x40,property.category],
  ...(property.flags&0x20?[['raw',0x44,2,property.repOffset]]:[]),['object',0x5c,propertyClass]]);

// The state object also owns references inside its serialized bytecode.
// Archive the same operand slots used by live execution. This recording
// fixture does not register a complete native metadata/resource graph.
const script=idle.script,operands=[];
for(const node of idle.compiled.decoded.expressions.values()){
  const index=node.fieldIndex??node.functionIndex??node.objectIndex;
  if(index!==undefined)operands.push(runtime.objects.operand(script,node));
}
const stateObject={identity:idle.record,nativeVtable:0x101757d8,
  baseField:await runtime.objects.resolve(script.asset,script.baseRef),
  next:await runtime.objects.resolve(script.asset,script.nextRef),
  scriptText:await runtime.objects.resolve(script.asset,script.scriptTextRef),
  children:await runtime.objects.resolve(script.asset,script.childrenRef),
  friendlyName:script.name,line:script.line,textPosition:script.textPosition,
  scriptSize:script.scriptSize,probeMask:script.probeMask,ignoreMask:script.ignoreMask,
  labelTableOffset:script.labelTableOffset,stateFlags:script.stateFlags,
};
const stateCalls=[];
const stateArchive={archiveState:{...GC_ARCHIVE_WORDS},
  objectReference:(reference,context)=>stateCalls.push(['object',reference.get(),context]),
  nameReference:(reference,context)=>stateCalls.push(['name',reference.get(),context]),
};
const stateResult=serializeUState(stateObject,stateArchive,{
  serializeUObject:()=>stateCalls.push(['UObject']),
  serializeExpr:(_,offset,archive)=>runtime.objects.serializeExpression(script,offset.get(),archive),
});
assert.equal(stateResult.struct.script.end,script.scriptSize);
assert.deepEqual(stateCalls.slice(0,6).map(call=>call.slice(0,2)),[
  ['UObject'],['object',stateObject.baseField],['object',stateObject.next],
  ['object',stateObject.scriptText],['object',stateObject.children],['name',script.name],
]);
for(const operand of operands)assert(stateCalls.some(call=>call[0]==='object'&&call[1]===operand));
for(const label of idle.labels.keys())assert(stateCalls.some(call=>call[0]==='name'&&call[1].toLowerCase()===label));

// Class defaults have independent copied storage from existing instances.
// Visit the live typed default lvalue through SerializeBin's reference walker.
const targetField=cls.propertyLink.find(field=>field.name==='Target');
const beforeDefaults={name:'BeforeDefaultWrite'};runtime.attach(beforeDefaults,cls);
assert.equal(runtime.defaultValue(cls,targetField),null);
runtime.defaultReference(beforeDefaults,targetField).set(target);
const afterDefaults={name:'AfterDefaultWrite'};runtime.attach(afterDefaults,cls);
const defaultRefs=[];
runtime.serializeDefaultReferences(cls,{
  objectReference:reference=>{
    const value=reference.get();defaultRefs.push(value);
    if(value===target)reference.set(null);
  },
  nameReference:reference=>{assert.equal(typeof reference.get(),'string');},
});
assert(defaultRefs.includes(target));assert.equal(runtime.defaultValue(cls,targetField),null);
assert.equal(runtime.fieldReference(beforeDefaults,targetField).get(),null);
assert.equal(runtime.fieldReference(afterDefaults,targetField).get(),target);
// One original property through the actual measuring archive and collector.
// Owner is Actor+0x3c (Engine SetOwner10369b70); its four-byte UObject pointer
// uses GetID101655f0: low byte of Class.Name. Core hardcodes ObjectProperty
// at name index5 in1014bcc8-1014bcd8. The property walk is deliberately scoped
// to Owner and the comparison pointer is null, not a complete UClass graph.
runtime.classDefaultReference(cls,field).set(target);
const gcNames=createScriptNames({allocator:{free:()=>{throw new Error('No name purge in this case');}}});
const noneName=gcNames.intern('None',2);
const excludedTarget={identity:target,index:0,flags:GC_FLAGS.archiveExcluded};
const gcRegistry={objects:[excludedTarget],names:gcNames.names,rootSet:[]};
const collector=createGarbageArchive(gcRegistry);
const bridge=createScriptGcBridge(collector,{registry:gcRegistry,
  resolveObject:identity=>identity===target?excludedTarget:null,
  resolveName:name=>gcNames.getEntry(gcNames.find(name)),
});
const taggedResult=serializeTaggedPropertiesGc(cls.record,bridge,cls,null,{
  walkProperties:()=>[field],propertyOffset:()=>0x3c,elementSize:()=>4,
  getPropertyId:()=>5,valueReference:property=>runtime.classDefaultReference(cls,property),
  noneName:noneName.name,
});
assert.equal(taggedResult.properties.length,1);
assert.equal(taggedResult.properties[0].tag.size,4);
assert.equal(taggedResult.properties[0].tag.typeFlags,0x25);
assert.equal(collector.serializedCount,1); // MapObject during measurement never marks.
assert.equal(runtime.classDefaultReference(cls,field).get(),null);
assert.equal(noneName.entry.flags&GC_FLAGS.unreachable,0);
console.log('Original CameraPoint Actor/UObject, Owner/Idle metadata, live code operands, independent defaults and Owner through native measurement/GC passed.');
