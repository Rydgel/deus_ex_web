import test from 'node:test';
import assert from 'node:assert/strict';
import { traceExtent } from '../src/runtime/extent-trace.mjs';
import { brushToWorld } from '../src/runtime/coords.mjs';

// Controlled compiled hull, executed independently by native-extent-oracle.py.
// No original map assets are embedded in this regression fixture.
function boxModel() {
  const planes = [[-1,0,0,10],[1,0,0,10],[0,-1,0,10],[0,1,0,10],[0,0,-1,10],[0,0,1,10]];
  const view = new DataView(new ArrayBuffer(4));
  const bits = v => { view.setFloat32(0,v,true); return view.getInt32(0,true); };
  return {rootOutside:1,leafHulls:[0,1,2,3,4,5,-1,...[-10,-10,-10,10,10,10].map(bits)],
    nodes:planes.map((plane,i)=>({plane,back:i===5?-1:i+1,front:-1,collisionBound:0,vertexCount:4,flags:0}))};
}

test('original supplemental positive-X bound differs from owner path',()=>{
  const m=boxModel(),extent=[20,20,43];
  const world=traceExtent(m,[100,0,0],[0,0,0],extent);
  assert.equal(world.time,0.6009999513626099);
  assert.deepEqual(world.location,[39.90000534057617,0,0]);
  assert.deepEqual(world.normal,[1,0,0]);
  const owner=traceExtent(m,[100,0,0],[0,0,0],extent,brushToWorld({}));
  assert.equal(owner.time,0.5999999642372131);
  assert.deepEqual(owner.location,[40.000003814697266,0,0]);
});

test('native opposite-axis and floor backoff captures',()=>{
  const m=boxModel();
  const left=traceExtent(m,[-100,0,0],[0,0,0],[20,20,43]);
  assert.equal(left.time,0.5999999642372131);
  assert.deepEqual(left.normal,[-1,0,0]);
  const down=traceExtent(m,[0,0,100],[0,0,0],[20,20,43]);
  assert.equal(down.time,0.3700000047683716);
  assert.deepEqual(down.location,[0,0,63]);
});

test('native shallow-overlap escape, inward obstruction, and stationary miss',()=>{
  const m=boxModel(),extent=[20,20,43];
  assert.equal(traceExtent(m,[29,0,0],[40,0,0],extent),null);
  const inward=traceExtent(m,[29,0,0],[20,0,0],extent);
  assert.equal(inward.time,0);assert.deepEqual(inward.location,[29,0,0]);
  assert.equal(traceExtent(m,[0,0,0],[0,0,0],extent),null);
});

test('native oblique owner bevel gives axis normal including negative zero',()=>{
  const hit=traceExtent(boxModel(),[100,0,0],[0,0,0],[20,20,16],brushToWorld({Rotation:[0,8192,0]}));
  assert.equal(hit.time,0.558578610420227);
  assert.deepEqual(hit.normal,[1,-0,0]);
  assert.deepEqual(hit.location,[44.14213943481445,0,0]);
  assert.equal(hit.node,5);
});

test('unsupported zero extents and malformed BSP fail explicitly',()=>{
  assert.throws(()=>traceExtent(boxModel(),[0,0,0],[1,0,0],[0,0,0]),/traceRay/);
  const m=boxModel();m.nodes[0].back=0;
  assert.throws(()=>traceExtent(m,[-100,0,0],[0,0,0],[20,20,43]),/cyclic/);
});

test('native x87 support retains the component deciding a float32 midpoint',()=>{
  const view=new DataView(new ArrayBuffer(4));
  const bits=v=>{view.setFloat32(0,v,true);return view.getInt32(0,true);};
  const plane=[Math.fround(-3/Math.sqrt(13)),Math.fround(1e-16),Math.fround(-2/Math.sqrt(13)),-6080];
  const model={rootOutside:1,leafHulls:[0,-1,...[-10000,-10000,-10000,10000,10000,10000].map(bits)],
    nodes:[{plane,back:-1,front:-1,collisionBound:0,vertexCount:4,flags:0}]};
  // Captured with original UModel.LineCheck by native-extent-oracle.py.
  const hit=traceExtent(model,[7120,-1160,160],[7120,-1160,284],[20,20,16]);
  assert.equal(hit.time,0.5038346648216248);
  assert.deepEqual(hit.location,[7120,-1160,222.47549438476562]);
  assert.deepEqual(hit.normal,plane.slice(0,3));
});
