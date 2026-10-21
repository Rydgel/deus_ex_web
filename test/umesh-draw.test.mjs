import test from 'node:test';
import assert from 'node:assert/strict';
import {drawUMesh,environmentUV,unsafeNormal} from '../src/runtime/umesh-draw.mjs';
import {readUMeshSurfaces} from '../src/runtime/umesh-surfaces.mjs';

/** A classic mesh payload of one triangle: iVertex 0,1,2 (or reversed), UV bytes, PolyFlags and TextureIndex; every
 * vertex linked to it. Not an original asset: the shape umesh-draw reads (docs/umesh.md). */
function triangleMesh({reversed=false,flags=0}={}) {
  const tri=new DataView(new ArrayBuffer(20));
  [0,reversed?2:1,reversed?1:2].forEach((v,i)=>tri.setUint16(i*2,v,true));
  [[0,0],[255,0],[0,255]].forEach(([u,v],i)=>{tri.setUint8(6+i*2,u);tri.setUint8(7+i*2,v);});
  tri.setUint32(12,flags,true);tri.setInt32(16,0,true);
  const connects=new DataView(new ArrayBuffer(24)),links=new DataView(new ArrayBuffer(12));
  for(let i=0;i<3;i++){connects.setInt32(i*8,1,true);connects.setInt32(i*8+4,i,true);links.setInt32(i*4,0,true);}
  const array=(buffer,num)=>({load(){return this;},data:new Uint8Array(buffer.buffer),num});
  return {frameVertexCount:3,arrays:new Map([[0x78,array(tri,1)],[0x9c,array(connects,3)],[0xcc,array(links,3)]])};
}
const points=Float32Array.of(0,0,10, 1,0,10, 0,1,10);
const texture={uSize:256,vSize:256,uScale:1,vScale:1,flags:0};
const run=(mesh,over={})=>drawUMesh(mesh,points,{frame:{mirror:1,prj:null,uncoords:[[1,0,0],[0,1,0],[0,0,1]]},polyFlags:0x4000,unlit:[0.5,0.5,0.5],
  textureInfo:()=>texture,environment:texture,light:index=>[index/4,0.5,0.25,0],snapshots:true,...over});

test('a front-facing flat triangle is lit once per vertex and drawn with its corners in order',()=>{
  const result=run(triangleMesh());
  assert.deepEqual(result.visible,[0]);
  assert.deepEqual(result.lightCalls.map(call=>call.vertex),[0,1,2]);
  assert.equal(result.draws.length,1);
  assert.deepEqual(result.draws[0].vertices,[0,1,2]);
  assert.deepEqual(result.draws[0].pts.map(pt=>pt.light[0]),[0,0.25,0.5]);
  // The face normal points back at the viewer: -Z.
  assert.deepEqual(result.draws[0].pts[0].normal.slice(0,3).map(Math.round),[0,0,-1]);
});

test('a back-facing flat triangle is culled, a two-sided one is kept and a mirrored frame reverses the winding',()=>{
  assert.deepEqual(run(triangleMesh({reversed:true})).visible,[]);
  assert.deepEqual(run(triangleMesh({reversed:true,flags:0x100})).visible,[0]);
  assert.deepEqual(run(triangleMesh({reversed:true}),{frame:{mirror:-1,prj:null,uncoords:[[1,0,0],[0,1,0],[0,0,1]]}}).visible,[0]);
  assert.deepEqual(run(triangleMesh(),{frame:{mirror:-1,prj:null,uncoords:[[1,0,0],[0,1,0],[0,0,1]]}}).visible,[]);
});

test('PF_Unlit paints every corner with the unlit colour and PF_Environment takes the environment map',()=>{
  const unlit=run(triangleMesh(),{polyFlags:0x4000|0x400000});
  assert.deepEqual(unlit.draws[0].pts.map(pt=>pt.light),[[0.5,0.5,0.5,0],[0.5,0.5,0.5,0],[0.5,0.5,0.5,0]]);
  const env={...texture,uSize:64,vSize:128},environment=run(triangleMesh({flags:0x10}),{textureInfo:()=>texture,environment:env});
  assert.equal(environment.draws[0].environment,true);
  assert.equal(environment.draws[0].uFactor,Math.fround(64/256));
  assert.equal(environment.draws[0].vFactor,Math.fround(128/256));
  assert.ok(environment.draws[0].uv.flat().every(Number.isFinite));
});

test('a vertex outside a side plane for all three corners is not drawn; every corner outside skips the mesh',()=>{
  // z·PrjXM + x < 0 for every vertex: the left plane.
  assert.deepEqual(run(triangleMesh(),{frame:{mirror:1,prj:[-1,1,1,1],uncoords:[[1,0,0],[0,1,0],[0,0,1]]}}).visible,[]);
  assert.equal(run(triangleMesh(),{frame:{mirror:1,prj:[-1,1,1,1],uncoords:[[1,0,0],[0,1,0],[0,0,1]]}}).allOutside,true);
});

test('the reflection of a direction about its normal, in texel units, and UnsafeNormal at 24 bits',()=>{
  assert.deepEqual(unsafeNormal([0,0,5]),[0,0,1]);
  // Looking straight at a surface facing the viewer reflects the view straight back: x = y = 0, U = V = UFactor·128.
  const [u,v]=environmentUV([0,0,10],[0,0,-1],[[1,0,0],[0,1,0],[0,0,1]],1,1);
  assert.equal(u,128);assert.equal(v,128);
});

test('surfaces of a classic mesh are its triangles',()=>{
  const faces=readUMeshSurfaces(triangleMesh({flags:0x102}));
  assert.equal(faces.length,1);
  assert.deepEqual(faces[0].vertices,[0,1,2]);
  assert.equal(faces[0].flags,0x102);
  assert.deepEqual(faces[0].uv,[[0,0],[255,0],[0,255]]);
});
