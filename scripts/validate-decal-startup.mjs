import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {constructDecal} from '../src/runtime/script-object-construction.mjs';
import {execAttachDecal,execDetachDecal} from '../src/runtime/script-decal.mjs';

const samples=[
  {name:'no client',noClient:true,depth:9},
  {name:'decals disabled',decals:0,depth:9},
  {name:'missing texture',noTexture:true,depth:9},
  {name:'positive surface boundary',depth:9,args:[100.125,[1,2,3]]},
  {name:'negative depth retained; whole bool word',decals:2,depth:-3},
  {name:'empty detach',detach:true},
];
const python=process.env.NATIVE_PROBE_PYTHON??process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const original=JSON.parse(execFileSync(python,['scripts/native-decal-oracle.py',gameDirectory()],{
  input:JSON.stringify(samples),encoding:'utf8',
}));
const ctor=original.constructor;
assert.deepEqual(ctor.changedOffsets,[0,1,2,3,...Array.from({length:12},(_,i)=>0x320+i)]);
assert.deepEqual(ctor.templateWords,[0xa5a5a5a5,0xa5a5a5a5]);
assert.deepEqual(ctor.startupSlots,ctor.actorStartupSlots);
const actor={decalSurfaces:[7,9],MultiDecalLevel:0xa5a5a5a5,LastRenderedTime:0xa5a5a5a5};
constructDecal(actor);
assert.equal(actor.nativeVtable,ctor.vtable);
assert.deepEqual(actor.decalSurfaces,[]);
assert.deepEqual(ctor.surfaces,[0,0,0]);
assert.deepEqual([actor.MultiDecalLevel,actor.LastRenderedTime],ctor.templateWords);
for(let i=0;i<samples.length;i++){
  const sample=samples[i],expected=original.cases[i],events=[];
  const receiver={Texture:sample.noTexture?null:{key:'fixture.texture'},MultiDecalLevel:sample.depth??4,SurfList:[]};
  const args=sample.detach?[]:sample.args??[100];
  const call={receiver,argumentCount:args.length,evaluateArgument:index=>{
    events.push({op:'Step',index,provided:args[index]!==undefined});return args[index];
  }};
  const services={read:(actor,name)=>actor[name],write:(actor,name,value)=>{actor[name]=value;},
    clientFor:()=>sample.noClient?null:{decals:sample.decals??1},
    warning:event=>events.push({op:'Warning',type:event.type}),
  };
  if(sample.detach){
    const before=structuredClone(receiver);
    execDetachDecal(call,services);
    assert.deepEqual(receiver,before);
    assert.deepEqual(expected.changedOffsets,[]);
    assert.equal(expected.codeAdvance,1);
  }else{
    if(expected.boundary){
      assert.throws(()=>execAttachDecal(call,services),error=>error.code==='DECAL_BOUNDARY'&&error.operation===expected.boundary.operation);
      let parameters;
      execAttachDecal({...call,evaluateArgument:index=>args[index]},
        {...services,attachSurfaces:(_actor,distance,direction)=>{parameters={distance,direction};}});
      assert.deepEqual(parameters,{distance:expected.boundary.distance,direction:expected.boundary.direction});
    }else assert.equal(execAttachDecal(call,services),Boolean(expected.result));
    assert.equal(receiver.MultiDecalLevel,expected.depth,sample.name);
    assert.equal(expected.codeAdvance,3);
    // The native VM Steps EX_Nothing for the omitted optional vector; our
    // compiled call exposes supplied arguments only. Compare supplied Steps.
    assert.deepEqual(events.filter(e=>e.op==='Step'),expected.events.filter(e=>e.op==='Step'&&e.provided));
    const warnings=expected.events.filter(e=>e.op==='Warning');
    assert.equal(events.filter(e=>e.op==='Warning').length,warnings.length);
    if(warnings.length)assert.match(warnings[0].format,/texture/i);
  }
}
assert.throws(()=>execAttachDecal({receiver:actor,argumentCount:1,evaluateArgument:()=>100},{
  clientFor:()=>({}),
}),error=>error.code==='DECAL_BOUNDARY'&&error.operation==='Client.Decals');
assert.throws(()=>execDetachDecal({receiver:actor,argumentCount:0},{read:()=>[12]}),
  error=>error.code==='DECAL_BOUNDARY'&&error.operation==='DetachDecal.surfaces');
console.log('Original Decal ctor, AttachDecal gates/arguments/clamp and empty DetachDecal: 6 native comparisons passed.');
