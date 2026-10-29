import test from 'node:test';
import assert from 'node:assert/strict';
import {modelPointCheck} from '../src/runtime/point-check.mjs';
import {createCollisionHash} from '../src/runtime/collision-hash.mjs';
import {createLevelPoints} from '../src/runtime/level-points.mjs';
import {primitiveCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import { modelFromObjects } from '../src/unreal/bsp-model.mjs';
// Synthetic compiled geometry, captured through original full-level point chain.
function model(){
 const planes=[[-1,0,0,10],[1,0,0,10],[0,-1,0,10],[0,1,0,10],[0,0,-1,10],[0,0,1,10]],v=new DataView(new ArrayBuffer(4));
 const bits=x=>{v.setFloat32(0,x,true);return v.getInt32(0,true);};
 return modelFromObjects({rootOutside:1,leafHulls:[0,1,2,3,4,5,-1,...[-10,-10,-10,10,10,10].map(bits)],nodes:planes.map((plane,i)=>({plane,back:i===5?-1:i+1,front:-1,collisionBound:0,vertexCount:4,flags:0}))});
}
test('native recovery remains written even when a later hull plane reports clear',()=>{
 const h=modelPointCheck(model(),[29.9,0,0],[20,20,43]);
 assert.equal(h.outside,true);assert.deepEqual(h.location,[30.00200080871582,0,0]);
 assert.deepEqual(h.normal,[1,0,0]);assert.equal(h.item,1);assert.equal(h.time,0);
 const inside=modelPointCheck(model(),[20,0,0],[20,20,43]);
 assert.equal(inside.outside,false);assert.equal(inside.location[0],30.200000762939453);
});
test('native point list preserves registration order and closest ties keep first',()=>{
 const hash=createCollisionHash(),world={id:'$world'},actors=[100,104].map((x,i)=>({id:['a','b'][i],values:{Location:[x,0,0],CollisionRadius:10,CollisionHeight:10}}));
 for(const a of actors)hash.addActor(a,primitiveCollisionBounds(null,a.values),{location:a.values.Location});
 const q=createLevelPoints(model(),hash,world);
 const hits=q.multiPointCheck([102,0,0],[20,20,16],0xffffffff,null,1);
 assert.deepEqual(hits.map(h=>h.actor.id),['a','b']);
 assert.deepEqual(hits.map(h=>h.location),[[80,0,0],[124,0,0]]);
 assert.equal(q.singlePointCheck([102,0,0],[20,20,16]).hit.actor,actors[0]);
 hash.removeActor(actors[0]);hash.addActor(actors[0],primitiveCollisionBounds(null,actors[0].values),{location:actors[0].values.Location});
 assert.equal(q.singlePointCheck([102,0,0],[20,20,16]).hit.actor,actors[1]);
});
test('actor boolean word bDeleteMe skips registration with compatibility alias',()=>{
 const hash=createCollisionHash(),a={actorFlags:0x80};
 assert.equal(hash.addActor(a,{min:[0,0,0],max:[1,1,1]}),null);
});
