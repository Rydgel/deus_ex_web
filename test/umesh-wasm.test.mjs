/** The Rust kernel's classic-UMesh DrawMesh against the JavaScript reference on synthetic meshes (ABI and control-flow regression, not
 * original-game evidence: validate-umesh-wasm runs the game's five meshes and the oracle cases). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {drawUMesh,packUMeshDraw,umeshTopology} from '../src/runtime/umesh-draw.mjs';
import {lightVertex} from '../src/runtime/mesh-lighting.mjs';
import {UMESH_STATUS} from '../src/runtime/umesh-wasm.mjs';

const kernel=await loadLodMeshKernel();
const f=Math.fround;
const bits=value=>{const v=new DataView(new ArrayBuffer(4));v.setFloat32(0,value,true);return v.getUint32(0,true);};
let seed=99;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};

/** A grid of `side`² vertices with two triangles a cell, in the payload shape umesh-draw reads (Tris, Connects, VertLinks). */
function gridMesh(side,{flags=0,texture=()=>0,breakLink=false}={}) {
  const vertices=side*side,triangles=[];
  for(let y=0;y<side-1;y++)for(let x=0;x<side-1;x++) {
    const a=y*side+x,b=a+1,c=a+side,d=c+1;
    triangles.push([a,c,b],[b,c,d]);
  }
  const tris=new DataView(new ArrayBuffer(triangles.length*20));
  triangles.forEach((tri,i)=>{
    tri.forEach((v,k)=>tris.setUint16(i*20+k*2,v,true));
    for(let k=0;k<3;k++){tris.setUint8(i*20+6+k*2,(i*7+k*50)&255);tris.setUint8(i*20+7+k*2,(i*11+k*30)&255);}
    tris.setUint32(i*20+12,typeof flags==='function'?flags(i):flags,true);tris.setInt32(i*20+16,texture(i),true);
  });
  const runs=Array.from({length:vertices},()=>[]);
  triangles.forEach((tri,i)=>tri.forEach(v=>runs[v].push(i)));
  const connects=new DataView(new ArrayBuffer(vertices*8)),flat=[];
  runs.forEach((run,v)=>{connects.setInt32(v*8,run.length,true);connects.setInt32(v*8+4,flat.length,true);flat.push(...run);});
  const links=new DataView(new ArrayBuffer(flat.length*4));
  flat.forEach((t,i)=>links.setInt32(i*4,breakLink&&i===3?triangles.length+5:t,true));
  const array=(view,num)=>({load(){return this;},data:new Uint8Array(view.buffer),num});
  return {frameVertexCount:vertices,arrays:new Map([[0x78,array(tris,triangles.length)],[0x9c,array(connects,vertices)],[0xcc,array(links,flat.length)]])};
}
const gridPoints=(side,scale=10)=>{
  const points=new Float32Array(side*side*3);
  for(let y=0;y<side;y++)for(let x=0;x<side;x++) {
    const at=(y*side+x)*3;
    points[at]=f((x-side/2)*scale+random());points[at+1]=f((y-side/2)*scale+random());points[at+2]=f(300+random()*40+x*y*0.3);
  }
  return points;
};
const setup=(flags=0)=>({flags,ambient:[0.1,0.05,0.2],scaleGlow:1.25,
  lights:[{location:[10,20,100],rradius:f(1/400),color:[0.9,0.7,0.5]},{location:[-80,30,250],rradius:f(1/600),color:[0.2,0.4,0.9]},{location:[0,0,10],rradius:f(1/50),color:[1,1,1]}]});
const texture=(extra={})=>({uSize:128,vSize:64,uScale:0.5,vScale:2,flags:0,...extra});
const frame={mirror:1,prj:[1,1,1,1],uncoords:[[1,0,0],[0,1,0],[0,0,1]]};

/** One call through the reference and the kernel; every output word equal. */
function both(mesh,points,{polyFlags=0x4000,flagBits=0,textures=[texture(),texture({uSize:512,flags:2})],environment=texture({uSize:64}),fatness=0x80,over={}}={}) {
  const topology=umeshTopology(mesh),hasEnvironment=topology.triangles.some(tri=>tri.flags&0x10);
  const lighting=setup(flagBits),unlit=[0.3,0.3,0.3];
  const options={frame,polyFlags,setup:lighting,fatness,unlit,textureInfo:index=>textures[index]??null,environment,
    light:(index,point,plane,flags)=>[...lightVertex(lighting,point,plane,flags),0],...over};
  let reference=null,error=null;
  try{const result=drawUMesh(mesh,points,options);reference={...packUMeshDraw(result,topology.triangles,hasEnvironment),points:result.points,result};}
  catch(e){error=e.message;}
  const out=kernel.umesh.draw(mesh,points,{frame:options.frame,polyFlags,setupFlags:flagBits,fatness,unlit,ambient:lighting.ambient,scaleGlow:lighting.scaleGlow,
    lights:lighting.lights,textures,environment:options.environment,envOutput:hasEnvironment});
  return {out,reference,error,hasEnvironment};
}
const assertSame=(a,b,label)=>{
  assert.equal(a?.length,b?.length,`${label} length`);
  if(a)for(let i=0;i<a.length;i++)if(bits(a[i])!==bits(b[i]))assert.fail(`${label} word ${i}: ${a[i]} vs ${b[i]}`);
};

test('the kernel draws a lit grid with the reference\'s colours, environment UVs and points',()=>{
  const side=12,mesh=gridMesh(side,{flags:i=>(i%5===0?0x10:0)|(i%7===0?0x100:0),texture:i=>i%2});
  assert.ok(kernel.umesh.accepts(mesh));
  const {out,reference,error}=both(mesh,gridPoints(side));
  assert.equal(error,null);
  assert.equal(out.status,UMESH_STATUS.ok);
  assert.ok(out.drawn>0&&out.drawn===reference.result.draws.length);
  assertSame(out.colors,reference.colors,'colors');assertSame(out.envUv,reference.envUv,'envUv');assertSame(out.points,reference.points,'points');
  assert.ok(out.envUv.some(v=>v!==0),'environment faces got UVs');
});

test('PF_Unlit, PF_Modulated, mirror, Fatness and outcode planes follow the reference',()=>{
  const side=9,mesh=gridMesh(side,{flags:i=>[0,0x40,0x400000,0x100][i%4]|(i%3===0?0x10:0)});
  for(const [label,options] of Object.entries({
    unlit:{polyFlags:0x4000|0x400000},volumetric:{flagBits:0x40000000},fat:{fatness:211},
    mirror:{over:{frame:{...frame,mirror:-1}}},planes:{over:{frame:{...frame,prj:[-1,1.5,0.5,1]}}},noPlanes:{over:{frame:{...frame,prj:null}}},
    environmentFlag:{polyFlags:0x4000|0x10},
  })) {
    const {out,reference,error}=both(mesh,gridPoints(side,25),options);
    assert.equal(error,null,label);
    assertSame(out.colors,reference.colors,`${label} colors`);assertSame(out.envUv,reference.envUv,`${label} envUv`);assertSame(out.points,reference.points,`${label} points`);
  }
});

test('a mesh whose vertices all lie outside a plane is not drawn and a missing environment map is the reference\'s error',()=>{
  const side=6,mesh=gridMesh(side,{flags:0x10|0x100});
  const outside=both(mesh,gridPoints(side),{over:{frame:{...frame,prj:[-1000,1,1,1]}}});
  assert.equal(outside.out.allOutside,true);assert.equal(outside.reference.result.allOutside,true);
  assert.ok(outside.out.colors.every(v=>v===1)&&outside.out.envUv.every(v=>v===0));
  const missing=both(mesh,gridPoints(side),{environment:null,over:{environment:null}});
  assert.equal(missing.error,'DrawMesh has no environment map to draw with');
  assert.equal(missing.out.status,UMESH_STATUS.noEnvironment);
});

test('a topology with a link out of range is refused (the reference keeps it) and memory growth keeps the views right',()=>{
  const bad=gridMesh(4,{breakLink:true});
  assert.equal(kernel.umesh.accepts(bad),false);
  // A small mesh, a large one (the scratch grows) and the small one again.
  for(const side of [5,70,5]) {
    const mesh=gridMesh(side,{flags:i=>i%3===0?0x10:0}),{out,reference}=both(mesh,gridPoints(side,4));
    assertSame(out.colors,reference.colors,`side ${side} colors`);assertSame(out.envUv,reference.envUv,`side ${side} envUv`);
  }
});

test('bindings share a mesh\'s upload: the last release frees it and a later use uploads again',()=>{
  const side=5,mesh=gridMesh(side,{flags:i=>i%2?0x10:0}),points=gridPoints(side,8);
  assert.equal(kernel.umesh.acquire(mesh),true);assert.equal(kernel.umesh.acquire(mesh),true);
  const handle=kernel.umesh.handleOf(mesh);
  kernel.umesh.release(mesh);
  assert.equal(kernel.umesh.handleOf(mesh),handle,'one binding is still using it');
  const first=both(mesh,points);
  kernel.umesh.release(mesh);
  const second=both(mesh,points);
  assert.equal(second.out.status,UMESH_STATUS.ok);
  assertSame(second.out.colors,first.out.colors,'colors after a re-upload');
  assertSame(second.out.envUv,first.out.envUv,'envUv after a re-upload');
});
