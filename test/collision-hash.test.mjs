import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionHash,collisionHashCell,collisionHashLineBounds} from '../src/runtime/collision-hash.mjs';
const point={min:[0,0,0],max:[256,256,256]}, query={start:[0,0,0],end:[0,0,0]};

test('native same-cell double reversal and same-cell re-registration changes ties',()=>{
  const hash=createCollisionHash(),a={id:'a'},b={id:'b'};
  hash.addActor(a,point);hash.addActor(b,point);
  const visited=[];
  assert.deepEqual(hash.actorLineCheck(query,actor=>{visited.push(actor.id);return actor.id;}),['a','b']);
  assert.deepEqual(visited,['b','a']);
  hash.removeActor(a,point);hash.addActor(a,point);
  assert.deepEqual(hash.actorLineCheck(query,a=>a.id),['b','a']);
  hash.removeActor(a,point);hash.addActor(a,{min:[512,512,512],max:[768,768,768]});
  assert.deepEqual(hash.actorLineCheck(query,a=>a.id),['b']);
});

test('native multicell misses are deduplicated and hash imposes no 64-hit cap',()=>{
  const hash=createCollisionHash();
  for(let i=0;i<80;i++)hash.addActor({id:i},point);
  let count=0;
  const hits=hash.actorLineCheck({start:[0,0,0],end:[256,256,256]},actor=>{count++;return actor.id===7?null:actor.id;});
  assert.equal(count,80);assert.equal(hits.length,79);
  assert.deepEqual(hits,Array.from({length:80},(_,i)=>i).filter(i=>i!==7));
});

test('native nearest-even and clamp cell captures',()=>{
  assert.deepEqual([-1000000,-32768,-32640,-32384,-128,0,128,384,4194176,5000000].map(collisionHashCell),[0,0,0,2,128,128,128,130,16383,16383]);
  assert.deepEqual(collisionHashLineBounds(query),{min:[128,128,128],max:[128,128,128]});
});

test('explicit seed-1 original tag/bucket alias preserves both actors',()=>{
  const position=c=>c.map(v=>(v-128)*256);
  const a=position([8,206,128]),b=position([264,205,128]);
  const independent=createCollisionHash();
  assert.throws(()=>independent.addActor({}, {min:b,max:b}),/outside proven/);
  assert.throws(()=>independent.actorLineCheck({start:b,end:b},()=>null),/outside proven/);
  const exact=createCollisionHash({seed:1});
  exact.addActor({id:'a'},{min:a,max:a});exact.addActor({id:'b'},{min:b,max:b});
  assert.deepEqual(exact.actorLineCheck({start:a,end:a},actor=>actor.id),['a','b']);
});

test('destroyed registrations and explicitly unsupported mutation inputs fail safely',()=>{
  const hash=createCollisionHash(),a={objectFlags:128};
  assert.equal(hash.addActor(a,point),null);
  a.objectFlags=0;hash.addActor(a,point);
  assert.throws(()=>hash.addActor(a,point),/already registered/);
  assert.throws(()=>hash.removeActor(a,{min:[512,512,512],max:[512,512,512]}),/before changing/);
  assert.throws(()=>hash.actorLineCheck(query,()=>hash.actorLineCheck(query,()=>null)),/Nested/);
  assert.throws(()=>hash.actorLineCheck(query,()=>hash.removeActor(a)),/mutation/);
  assert.deepEqual(hash.actorLineCheck(query,(_,args)=>args.extraNodeFlags),[0]);
  assert.deepEqual(hash.actorLineCheck({...query,extraNodeFlags:0x1234},(_,args)=>args.extraNodeFlags),[0x34]);
});

test('original x87 X expansion retains tiny perturbations of float32 midpoints',()=>{
  const start=[128.001953125,128.001953125,128.001953125];
  for(const e of [1e-12,1e-14])assert.deepEqual(collisionHashLineBounds({start,end:start,extent:[e,e,e]}),{min:[128,128,128],max:[129,128,128]});
  assert.deepEqual(collisionHashLineBounds({start,end:start,extent:[1e-16,1e-16,1e-16]}),{min:[128,128,128],max:[128,128,128]});
});
