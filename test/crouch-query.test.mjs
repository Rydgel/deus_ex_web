import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCrouch } from '../src/runtime/crouch-query.mjs';

function fixture() {
  const calls=[],pawn={position:[-1067,832,-80.19999694824219],radius:20,height:43,
    defaultCollisionRadius:20,defaultCollisionHeight:47.5,defaultBaseEyeHeight:40,
    prePivot:[0,0,0],baseEyeHeight:40,eyeHeight:40,
    setCollisionSize(radius,height){calls.push(['resize',radius,height]);this.radius=radius;this.height=height;},
    move(delta){calls.push(['move',delta]);this.position=this.position.map((v,i)=>Math.fround(v+delta[i]));return true;},
  };
  return {pawn,calls};
}

test('crouch stand-up trace uses post-shrink center and one-unit vertical extent',()=>{
  const {pawn,calls}=fixture();let query;
  const forced=updateCrouch(pawn,true,false,(end,start,extent)=>{query={end,start,extent};return {actor:{}};});
  assert.equal(forced,true);
  assert.deepEqual(calls,[['resize',20,16],['move',[-0,-0,-27]]]);
  assert.deepEqual(query,{start:[-1067,832,-107.19999694824219],end:[-1067,832,-37.19999694824219],extent:[20,20,1]});
});

test('clear ceiling releases forced duck before the following call restores height',()=>{
  const {pawn,calls}=fixture();
  updateCrouch(pawn,true,false,()=>({actor:{}}));calls.length=0;
  assert.equal(updateCrouch(pawn,false,true,()=>({actor:null})),false);
  assert.equal(pawn.height,16);assert.deepEqual(calls,[]);
  updateCrouch(pawn,false,false,()=>{throw Error('No ceiling query on standing branch');});
  assert.deepEqual(calls,[['move',[0,0,27]],['resize',20,43]]);
  assert.equal(pawn.height,43);
});
