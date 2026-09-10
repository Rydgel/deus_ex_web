import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry,makeUniqueScriptObjectName,constructFreshScriptObject,constructActorBase} from '../src/runtime/script-object-construction.mjs';

test('unique names strip digits, use the class counter across outers, and preserve native signed wrap/length',()=>{
  const cls={record:{name:'Plant7'},nameCounter:0},outer={},visited=[];
  const services={internName:name=>({name,index:visited.length}),findObject:(scope,name)=>{
    assert.equal(scope,outer);visited.push(name);return name==='Plant0'?{}:null;
  }};
  assert.equal(makeUniqueScriptObjectName(cls,outer,services).name,'Plant1');
  assert.deepEqual(visited,['Plant0','Plant1']);assert.equal(cls.nameCounter,2);
  assert.equal(makeUniqueScriptObjectName(cls,{}, {...services,findObject:()=>null}).name,'Plant2');
  cls.record.name='A'.repeat(70);cls.nameCounter=0x7fffffff;
  const before=makeUniqueScriptObjectName(cls,outer,{...services,findObject:()=>null}).name;
  const after=makeUniqueScriptObjectName(cls,outer,{...services,findObject:()=>null}).name;
  assert.equal(before.length,62);assert.equal(after.length,62);
  assert.ok(before.endsWith('2147483647'));assert.ok(after.endsWith('-2147483648'));
});

test('fresh defaults precede free-index registration and the class native constructor',()=>{
  const previous={index:0},registry=new ScriptObjectRegistry({objects:[previous,null,null],freeIndices:[1,2]});
  const cls={record:{name:'Fixture'},nameCounter:0,metadata:{classFlags:8}},outer={index:7},calls=[];
  const hash=(outer.index^23)&0xfff;registry.buckets[hash]=previous;
  const template={owned:['default']};
  const object=constructFreshScriptObject({cls,outer,template,flags:1},{
    validate:()=>true,findObject:()=>null,internName:name=>({name,index:23}),registry,
    initProperties:(object,source)=>{
      calls.push('properties');assert.equal(object.index,-1);assert.equal(object.stateFrame,null);
      assert.equal(object.flags,0x4001);object.owned=[...source.owned];
    },
    nativeConstructor:object=>{
      calls.push('constructor');assert.equal(registry.objects[2],object);
      assert.equal(object.hashNext,previous);assert.equal(registry.buckets[hash],object);
      constructActorBase(object);
    },
  });
  assert.deepEqual(calls,['properties','constructor']);assert.equal(object.nativeVtable,0x104268dc);
  assert.equal(object.name,'Fixture0');assert.equal(object.index,2);assert.equal(object.linkerIndex,-1);
  object.owned.push('instance');assert.deepEqual(template.owned,['default']);
  assert.deepEqual(registry.freeIndices,[1]);
});
