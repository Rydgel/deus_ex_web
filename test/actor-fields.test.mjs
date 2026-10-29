/** fieldReaders and FieldReader (actor-fields.mjs) against fieldAccessor/fieldAccessors, the closures they replace in the actor mesh
 * layer: the same calls on the runtime in the same order, for linked receivers, receivers with no instance link, released
 * objects and a first read that throws. Translation regression checks, not original-game evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldAccessor,fieldAccessors,fieldReaders,hasReader,FieldReader} from '../src/viewer/actor-fields.mjs';

/** A runtime double that logs every call it receives. `linked` receivers carry the instance symbol, as ScriptRuntime defines it. */
function runtimeDouble({linked=true,throwOnce=null}={}) {
  const log=[],instanceKey=Symbol('instance'),instances=new Map(),thrown=new Set();
  const runtime={instanceKey,
    readNamed(receiver,name){
      log.push(['readNamed',receiver.id,name]);
      if(throwOnce===name&&!thrown.has(name)){thrown.add(name);throw new Error(`first read of ${name}`);}
      return `${receiver.id}.${name}`;
    },
    instance(receiver){
      log.push(['instance',receiver.id]);
      let instance=instances.get(receiver);
      if(!instance){
        instance={id:receiver.id,nativeObject:{released:false}};instances.set(receiver,instance);
        if(linked)Object.defineProperty(receiver,instanceKey,{value:instance,enumerable:false,writable:false,configurable:false});
      }
      return instance;
    },
    namedHandle(instance,name){
      log.push(['namedHandle',instance.id,name]);
      return {field:`field:${name}`,codec:`codec:${name}`,cell:`cell:${name}`};
    },
    readInstanceField(instance,field,codec,cell){
      log.push(['readInstanceField',instance.id,field,codec,cell]);
      return `${instance.id}/${field}/${cell}`;
    }};
  return {runtime,log,instances};
}
const names=['bHidden','Location','Mesh','Style','Name'];

function sequence(make,{linked=true,throwOnce=null}={}) {
  const {runtime,log,instances}=runtimeDouble({linked,throwOnce}),receiver={id:'R1'},results=[];
  const read=make(runtime,receiver);
  const call=name=>{try{results.push(read(name));}catch(error){results.push(`throws ${error.message}`);}};
  for(const name of ['Mesh','Mesh','Location','Style','Mesh','Location','bHidden','Name','Name','Mesh']){
    call(name);
    // the object is released part way: later resolved reads throw, as the closures do
    if(name==='Style')instances.get(receiver)&&(instances.get(receiver).nativeObject.released=true);
  }
  return {log,results};
}

test('fieldReaders makes the calls fieldAccessors makes, in the same order',()=>{
  for(const options of [{},{linked:false},{throwOnce:'Mesh'},{throwOnce:'Location',linked:false}]) {
    const closures=sequence((runtime,receiver)=>{const own=fieldAccessors(runtime,receiver,names);return name=>own[name]();},options);
    const methods=sequence((runtime,receiver)=>{const own=fieldReaders(runtime,receiver,names);return name=>own[name]();},options);
    assert.deepEqual(methods.results,closures.results,JSON.stringify(options));
    assert.deepEqual(methods.log,closures.log,JSON.stringify(options));
  }
});

test('a FieldReader makes the calls fieldAccessor makes',()=>{
  for(const options of [{},{linked:false},{throwOnce:'Mesh'}]) {
    const closure=sequence((runtime,receiver)=>{const read=fieldAccessor(runtime,receiver,'Mesh');return ()=>read();},options);
    const object=sequence((runtime,receiver)=>{const reader=new FieldReader(receiver);return ()=>reader.read(runtime,'Mesh');},options);
    assert.deepEqual(object.results,closure.results,JSON.stringify(options));
    assert.deepEqual(object.log,closure.log,JSON.stringify(options));
  }
});

test('readers of two objects, and of two lists, keep their own state',()=>{
  const {runtime,log}=runtimeDouble(),a={id:'A'},b={id:'B'};
  const ownA=fieldReaders(runtime,a,names),ownB=fieldReaders(runtime,b,names),other=fieldReaders(runtime,a,['Mesh','Style']);
  assert.equal(ownA.Mesh(),'A.Mesh');assert.equal(ownB.Mesh(),'B.Mesh');assert.equal(other.Mesh(),'A.Mesh');
  assert.equal(ownA.Mesh(),'A/field:Mesh/cell:Mesh');assert.equal(ownB.Mesh(),'B/field:Mesh/cell:Mesh');
  assert.equal(other.Mesh(),'A/field:Mesh/cell:Mesh');
  assert.equal(ownA.Style(),'A.Style','a name other readers have read is still unread here');
  assert.equal(log.filter(entry=>entry[0]==='readNamed').length,4);
  assert.notEqual(ownA.constructor,other.constructor);
  assert.equal(ownA.constructor,ownB.constructor,'one class for a list of names');
});

test('hasReader tells a list\'s names and an assigned override, and not a name outside',()=>{
  const {runtime}=runtimeDouble(),own=fieldReaders(runtime,{id:'R'},names);
  assert.ok(hasReader(own,'Mesh'));assert.ok(!hasReader(own,'Rotation'));
  Object.assign(own,{Rotation:()=>[0,0,0],Mesh:()=>'override'});
  assert.ok(hasReader(own,'Rotation'));
  assert.deepEqual(own.Rotation(),[0,0,0]);assert.equal(own.Mesh(),'override');
  assert.ok(hasReader(fieldAccessors(runtime,{id:'R'},names),'Style'),'also over a fieldAccessors object');
  assert.ok(!hasReader(fieldAccessors(runtime,{id:'R'},names),'toString'));
  assert.ok(!hasReader(own,'toString'));
});
