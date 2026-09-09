import test from 'node:test';
import assert from 'node:assert/strict';
import {pointCheck} from '../src/runtime/point-check.mjs';

// Controlled compiled hull captured using original UModel.PointCheck103f1570.
// Contains no original map assets; expected booleans are native observations.
function boxModel() {
  const planes=[[-1,0,0,10],[1,0,0,10],[0,-1,0,10],[0,1,0,10],[0,0,-1,10],[0,0,1,10]];
  const view=new DataView(new ArrayBuffer(4));
  const bits=v=>{view.setFloat32(0,v,true);return view.getInt32(0,true);};
  return {rootOutside:1,leafHulls:[0,1,2,3,4,5,-1,...[-10,-10,-10,10,10,10].map(bits)],
    nodes:planes.map((plane,i)=>({plane,back:i===5?-1:i+1,front:-1,collisionBound:0,vertexCount:4,flags:0}))};
}
test('native stationary extent overlap and strict supplemental bound contact',()=>{
  const model=boxModel(),extent=[20,20,43];
  const cases=[[[0,0,0],false],[[30,0,0],true],[[29.9,0,0],true],[[29.89999,0,0],false],
    [[-30,0,0],true],[[-29.999,0,0],false],[[0,0,53],true],[[0,0,52.999],false]];
  for(const [position,expected] of cases)assert.equal(pointCheck(model,position,extent),expected,JSON.stringify(position));
});
test('native zero extent chooses back on plane, front strictly beyond it',()=>{
  const model=boxModel();
  assert.equal(pointCheck(model,[0,0,0]),false);
  assert.equal(pointCheck(model,[10,0,0]),false);
  assert.equal(pointCheck(model,[10.00001,0,0]),true);
});
test('invalid extents and cyclic BSP fail explicitly',()=>{
  const model=boxModel();
  assert.throws(()=>pointCheck(model,[0,0,0],[-1,1,1]),/Negative/);
  model.nodes[0].back=0;
  assert.throws(()=>pointCheck(model,[0,0,0]),/cyclic/);
});
