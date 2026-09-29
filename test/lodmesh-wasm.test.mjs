/** Translation/ABI regression checks, not additional original-game evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLodMeshKernel,loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {getLodMeshFrame,createLodMeshFrameCache} from '../src/runtime/lodmesh-frame.mjs';
import {x87load,x87store,x87add,x87neg,x87mul,f32bits,f32num} from '../src/runtime/script-vm.mjs';
import {PF,accumulateFaceNormal,vertexNormalPlane,lightVertex,unlitColor,d3dDiffuse} from '../src/runtime/mesh-lighting.mjs';

const kernel=await loadLodMeshKernel();
const coords=[31.13,-17.7,0.005,0.37,-0.95,0.01,-0.21,0.73,0.875,0.015,-0.375,0.91];
function fixture(count) {
  const data=new Uint8Array(count*3*8),view=new DataView(data.buffer);
  let seed=12345;
  for(let i=0;i<count*3;i++)for(let axis=0;axis<3;axis++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    view.setInt16(i*8+axis*2,seed>>>16,true);
  }
  const mesh={frameVertexCount:count,scalarBits:new Map([[0x184,0]]),
    arrays:new Map([[0x60,{load:()=>({data})}]]),
    sequences:[{name:'Move',startFrame:0,numFrames:3},{name:'Other',startFrame:1,numFrames:2}],
    scale:[0.0137,-0.00983,0.00735],origin:[37.1,-12.89,0.003],rotation:[4917,23471,-6193]};
  const actor={bAnimByOwner:false,Owner:null,bParticles:false,DrawScale:1.237,
    Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],Rotation:[1951,-7583,197],
    AnimSequence:'Move',AnimFrame:0.4137,BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]};
  return {mesh,actor};
}

test('Wasm preserves complete JS frame/cache state across normal, tween, blend and buffer growth',async()=>{
  const {instance}=await WebAssembly.instantiate(await readFile(new URL('../src/runtime/lodmesh-kernel.wasm',import.meta.url)));
  const kernel=createLodMeshKernel(instance),initialMemorySize=instance.exports.memory.buffer.byteLength;
  // Small -> large -> small exercises scratch reallocation and stale views.
  for(const count of [0,1,2049,3]) {
    const {mesh,actor}=fixture(count);
    const caches=[createLodMeshFrameCache(),createLodMeshFrameCache()];
    for(const [step,frame] of [0.4137,0.99999,-0.25,-0.12345,-0.00001,0.71].entries()) {
      actor.AnimFrame=frame;
      if(step===2)actor.AnimSequence='Other';
      actor.BlendAnimSequence=['Move','Other','Move','Other'];
      actor.BlendAnimFrame=[frame,frame,frame,frame];
      const outputs=caches.map((cache,i)=>{
        const backing=new Uint8Array(count*28+16).fill(0x55),output=backing.subarray(8,-8);
        const result=getLodMeshFrame(mesh,actor,coords,{cache,kernel:i?kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001},
          {output,stride:28,vertexCount:step===1?1:count});
        return {backing,count:result.vertexCount};
      });
      assert.deepEqual(outputs[1],outputs[0],`count ${count}, step ${step}: output and guards`);
      assert.deepEqual(caches[1].entries,caches[0].entries,`count ${count}, step ${step}: persistent cache`);
    }
  }
  assert.ok(instance.exports.memory.buffer.byteLength>initialMemorySize,'exercise actual Wasm memory growth');
});

test('Wasm tween arithmetic retains extended precision, signed zeros and subnormals',()=>{
  const {mesh,actor}=fixture(96),caches=[createLodMeshFrameCache(),createLodMeshFrameCache()];
  const services=i=>({cache:caches[i],kernel:i?kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001});
  for(let i=0;i<2;i++)getLodMeshFrame(mesh,actor,coords,services(i));
  const bits=[0,0x80000000,1,0x80000001,0x7fffff,0x800000,0x3f800001,0xbf800001,
    0x7f7fffff,0xff7fffff,
    0x33800000,0x5f800001,0xdf800001,0x00800001];
  for(const cache of caches) {
    const entry=[...cache.entries.values()][0];entry.frame=-1;entry.sequence='Move';entry.completion=0;
    const words=new Uint32Array(entry.vertices.buffer,entry.vertices.byteOffset,entry.vertices.length);
    words.set(Array.from(words,(_,i)=>bits[i%bits.length]));
  }
  actor.AnimFrame=-0.3333333432674408;
  const outputs=caches.map((_,i)=>getLodMeshFrame(mesh,actor,coords,services(i)).output);
  assert.deepEqual(outputs[1],outputs[0]);
  for(let i=0;i<2;i++) {
    const entry=[...caches[i].entries.values()][0];
    caches[i]=new Uint8Array(entry.vertices.buffer,entry.vertices.byteOffset,entry.vertices.byteLength);
  }
  assert.deepEqual(caches[1],caches[0]);
});

test('raw Wasm cache stores preserve the scalar x87 NaN payload and infinity rules',()=>{
  // Array.from in the JS presentation path can canonicalize NaNs. Compare
  // the integer ABI against the existing scalar x87 model directly instead.
  for(const input of [[0x7fc00001,0xffc00002,0x7fc00003],[0x7f800000,0xff800000,0xffc00000]]) {
    const vertices=new Float32Array(3),words=new Uint32Array(vertices.buffer);
    words.set(input);
    const source=new DataView(new ArrayBuffer(8)),alpha=Math.fround(0.3);
    const expected=[...words].map((bits,axis)=>{
      const a=x87load(f32num(bits));
      let delta=x87add(x87load(0),x87neg(a));if(axis)delta=x87load(x87store(delta));
      let product=x87mul(delta,x87load(alpha));if(axis)product=x87load(x87store(product));
      return f32bits(x87store(x87add(product,a)));
    });
    kernel.run({source,frameVertexCount:1,count:1,alpha,tween:true,entry:{vertices},
      output:new Uint8Array(12),stride:12,matrix:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],origin:[0,0,0]});
    assert.deepEqual([...words],expected);
  }
});

test('Wasm bulk mesh lighting preserves the JavaScript face and diffuse-byte path',()=>{
  const nested=[[-14,3,8],[9,-7,11],[5,16,-2],[-3,4,19],[12,1,-6],[2,-11,7]].map(p=>p.map(Math.fround));
  const points=Float32Array.from(nested.flat()),faces=[
    {vertices:[0,1,2],flags:PF.TwoSided},{vertices:[2,1,3],flags:PF.TwoSided|PF.Unlit},
    {vertices:[0,0,4],flags:PF.TwoSided},{vertices:[1,4,5],flags:PF.Invisible??1},
    {vertices:[3,4,5],flags:PF.TwoSided|PF.Modulated},
  ];
  // Invisible is deliberately the raw DrawLodMesh bit; it is not part of the
  // public PF subset used by actor materials.
  faces[3].flags=1;
  const faceWords=new Uint32Array(faces.length*4);faces.forEach((face,i)=>faceWords.set([...face.vertices,face.flags],i*4));
  const origin=[1.25,-2.5,.75].map(Math.fround),axes=[[.8,.2,-.1],[-.3,.9,.15],[.05,-.2,.95]].map(a=>a.map(Math.fround));
  const setup={ambient:[.04,.08,.12].map(Math.fround),scaleGlow:Math.fround(.85),lights:[
    {location:[20,-12,35].map(Math.fround),rradius:Math.fround(1/80),color:[.7,.4,.2].map(Math.fround)},
    {location:[-30,25,10].map(Math.fround),rradius:Math.fround(1/120),color:[.1,.3,.8].map(Math.fround)},
  ]};
  const flags=PF.Flat,camera=nested.map(point=>axes.map(axis=>Math.fround(
    (point[0]-origin[0])*axis[0]+(point[1]-origin[1])*axis[1]+(point[2]-origin[2])*axis[2])));
  const normals=camera.map(()=>[0,0,0]),drawn=new Uint8Array(faces.length),lit=new Uint8Array(camera.length);
  faces.forEach((face,i)=>{
    const [a,b,c]=face.vertices,unit=accumulateFaceNormal(camera[a],camera[b],camera[c],normals[a],normals[b],normals[c]);
    const p=camera[a];if(!(face.flags&1)&&(face.flags&PF.TwoSided||unit[0]*p[0]+unit[1]*p[1]+unit[2]*p[2]<0)){
      drawn[i]=1;lit[a]=lit[b]=lit[c]=1;
    }
  });
  const light=camera.map((point,i)=>lit[i]?lightVertex(setup,point,vertexNormalPlane(point,normals[i]),flags):null);
  const unlit=unlitColor(17,setup.scaleGlow),expected=new Float32Array(faces.length*9);
  faces.forEach((face,i)=>{
    const faceFlags=face.flags|flags;if(drawn[i]&&faceFlags&PF.Unlit)for(const v of face.vertices)light[v]=unlit;
    face.vertices.forEach((v,corner)=>{
      const at=i*9+corner*3;if(faceFlags&PF.Modulated||!light[v])expected.fill(1,at,at+3);
      else{const packed=d3dDiffuse(light[v]);expected[at]=((packed>>>16)&255)/255;
        expected[at+1]=((packed>>>8)&255)/255;expected[at+2]=(packed&255)/255;}
    });
  });
  const input={points,faces:faceWords,origin,axes,ambient:setup.ambient,scaleGlow:setup.scaleGlow,
    unlit,lights:setup.lights,flags};
  const actual=kernel.light(input);
  assert.deepEqual(new Uint32Array(actual.buffer,actual.byteOffset,actual.length),new Uint32Array(expected.buffer));
});
