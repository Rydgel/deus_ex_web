import test from 'node:test';
import assert from 'node:assert/strict';
import {moveQuery} from '../src/runtime/move-query.mjs';
const world={},source={controlledPlayer:true,flags:15};
const base={source,worldActor:world,start:[0,0,0],delta:[10,0,0],extent:[17,17,42]};
const hit=(actor,time=.25)=>({actor,time,location:[2,3,4],normal:[-1,0,0]});

test('original componentwise tiny move gate avoids queries',()=>{
  for(const delta of [[0,0,0],[.00009,.00009,.00009],[.0001,0,0]]){
    const result=moveQuery({...base,delta,multiLineCheck(){throw new Error('unexpected query');}});
    assert.deepEqual(result.delta,[0,0,0]);assert.equal(result.time,1);
  }
  let queried=false;moveQuery({...base,delta:[.000101,0,0],multiLineCheck(){queried=true;return[];}});assert.ok(queried);
});

test('original query extension and displacement backoff use separate float stores',()=>{
  const result=moveQuery({...base,delta:[-13.67,24.987,-5.03],multiLineCheck(q){
    assert.deepEqual(q,{end:[-14.615280151367188,26.7148494720459,-5.377824306488037],start:[0,0,0],
      extent:[17,17,42],checkActors:true,worldActor:world,extra:0});return[hit(world)];}});
  assert.deepEqual(result.delta,[-2.708540201187134,4.950862884521484,-.9966318607330322]);
  assert.equal(result.time,.1981375366449356);
  assert.notDeepEqual(result.delta,[-13.67,24.987,-5.03].map(v=>Math.fround(Math.fround(v)*result.time)));
});

test('original first blocking result skips self/based actors without owner exclusion',()=>{
  const child={flags:15,base:source},owned={flags:15,owner:source};
  const result=moveQuery({...base,multiLineCheck:()=>[hit(source,.01),hit(child,.02),hit(owned,.25),hit(world,.5)]});
  assert.equal(result.hit.actor,owned);
});

test('bIgnoreBases skips the mover own base; without it the base blocks the move',()=>{
  const carrier={flags:15},rider={controlledPlayer:true,flags:15,base:carrier};
  const cfg={source:rider,worldActor:world,start:[0,0,0],delta:[10,0,0],extent:[17,17,42]};
  // Source->IsBasedOn(carrier) is only consulted when bIgnoreBases is set;
  // otherwise the carrier base is an ordinary blocker and clamps delta to 0.
  assert.deepEqual(moveQuery({...cfg,multiLineCheck:()=>[hit(carrier,.01)]}).delta,[0,0,0]);
  const moved=moveQuery({...cfg,ignoreBases:true,multiLineCheck:()=>[hit(carrier,.01)]});
  assert.deepEqual(moved.delta,[10,0,0]);assert.equal(moved.success,true);assert.equal(moved.hit,null);
});

test('source and target blocking categories are reciprocal; brush uses collide-world',()=>{
  const player={flags:8,controlledPlayer:true},actor={flags:8},brush={flags:8,movingBrush:true};
  assert.equal(moveQuery({...base,source:{controlledPlayer:true,flags:11},multiLineCheck:()=>[hit(actor),hit(player)]}).hit.actor,player);
  assert.equal(moveQuery({...base,source:{controlledPlayer:true,flags:3},multiLineCheck:()=>[hit(actor),hit(brush)]}).hit.actor,brush);
});

test('early collision clamps movement, time-one hit preserves original delta',()=>{
  assert.deepEqual(moveQuery({...base,multiLineCheck:()=>[hit(world,.01)]}).delta,[0,0,0]);
  const result=moveQuery({...base,multiLineCheck:()=>[hit(world,1)]});
  assert.deepEqual(result.delta,[10,0,0]);assert.equal(result.time,1);assert.equal(result.hit.actor,world);
});

test('original MoveActor success is positive adjusted time including partial travel',()=>{
 assert.equal(moveQuery({...base,multiLineCheck:()=>[hit(world,.01)]}).success,false);
 const partial=moveQuery({...base,multiLineCheck:()=>[hit(world,.4)]});
 assert.ok(partial.time>0&&partial.time<1);assert.equal(partial.success,true);
 assert.equal(moveQuery({...base,delta:[0,0,0],multiLineCheck(){throw Error('unexpected query');}}).success,true);
});
test('original static/nonmovable rejection precedes even a zero displacement',()=>{
 for(const traits of [{static:true},{movable:false}]){
  const r=moveQuery({...base,source:{...source,...traits},delta:[0,0,0],multiLineCheck(){throw Error('unexpected query');}});
  assert.equal(r.success,false);assert.equal(r.time,1);assert.deepEqual(r.position,base.start);
 }
});
