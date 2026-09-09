import test from 'node:test';
import assert from 'node:assert/strict';
import {setBasedPawnSize,resetBasedPawnSize,defaultPawnCollisionHeight} from '../src/runtime/stance.mjs';
function fixture(){
 const events=[],pawn={netMode:0,radius:20,height:43,position:[0,0,100],prePivot:[0,0,0],baseEyeHeight:40,eyeHeight:40,defaultCollisionRadius:20,defaultCollisionHeight:47.5,defaultBaseEyeHeight:40};
 pawn.setCollisionSize=(r,h)=>{events.push(['size',r,h]);pawn.radius=r;pawn.height=h;};
 pawn.move=delta=>{events.push(['move',...delta,pawn.radius,pawn.height]);pawn.position=pawn.position.map((v,i)=>Math.fround(v+delta[i]));return true;};
 return {pawn,events};
}
test('embedded source shrink resizes before moving and applies all visual deltas',()=>{
 const {pawn,events}=fixture();assert.equal(setBasedPawnSize(pawn,20,16),true);
 assert.deepEqual(events,[['size',20,16],['move',-0,-0,-27,20,16]]);
 assert.deepEqual(pawn.position,[0,0,73]);assert.deepEqual(pawn.prePivot,[0,0,27]);assert.equal(pawn.baseEyeHeight,13);assert.equal(pawn.eyeHeight,67);
});
test('source failed shrink restores size, retaining a partial failed movement',()=>{
 const {pawn,events}=fixture();pawn.move=()=>{events.push(['move',pawn.height]);pawn.position[2]-=2;return false;};
 assert.equal(setBasedPawnSize(pawn,20,16),false);assert.deepEqual(events,[['size',20,16],['move',16],['size',20,43]]);
 assert.equal(pawn.position[2],98);assert.equal(pawn.eyeHeight,40);assert.deepEqual(pawn.prePivot,[0,0,0]);
});
test('source growth moves with old cylinder and accepts native partial success',()=>{
 const {pawn,events}=fixture();setBasedPawnSize(pawn,20,16);events.length=0;
 pawn.move=delta=>{events.push(['move',pawn.radius,pawn.height,delta[2]]);pawn.position[2]+=2;return true;};
 assert.equal(resetBasedPawnSize(pawn),true);assert.deepEqual(events,[['move',20,16,27],['size',20,43]]);
 assert.equal(pawn.position[2],75);assert.equal(pawn.eyeHeight,40);assert.deepEqual(pawn.prePivot,[0,0,0]);
});
test('source failed growth leaves dimensions and visual fields unchanged',()=>{
 const {pawn,events}=fixture();pawn.move=()=>false;
 assert.equal(setBasedPawnSize(pawn,21,44),false);assert.deepEqual(events,[]);assert.equal(pawn.height,43);assert.equal(pawn.baseEyeHeight,40);
});
test('radius-only growth uses zero Move without any target-volume fit',()=>{
 const {pawn,events}=fixture();assert.equal(setBasedPawnSize(pawn,21,43),true);
 assert.deepEqual(events,[['move',0,0,0,20,43],['size',21,43]]);
});
test('source clamps negative dimensions and unchanged-size early return has no effects',()=>{
 const {pawn,events}=fixture();pawn.eyeHeight=123;assert.equal(setBasedPawnSize(pawn,20,43),true);assert.deepEqual(events,[]);assert.equal(pawn.eyeHeight,123);
 assert.equal(defaultPawnCollisionHeight(47.5),43);setBasedPawnSize(pawn,-1,-2);assert.equal(pawn.radius,0);assert.equal(pawn.height,0);
});
test('unsupported branches and hit objects do not silently become successful stances',()=>{
 const {pawn}=fixture();pawn.netMode=1;assert.throws(()=>setBasedPawnSize(pawn,20,16),/multiplayer/);pawn.netMode=0;pawn.carriedDecoration={};assert.throws(()=>setBasedPawnSize(pawn,20,16),/carried-decoration/);
 pawn.carriedDecoration=null;pawn.move=()=>({time:0});assert.throws(()=>setBasedPawnSize(pawn,20,16),/boolean/);
});
