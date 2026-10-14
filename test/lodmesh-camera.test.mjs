/** GetFrame called with a frame's own Coords (camera space) against the same
 * cache poses published again through that frame's matrix
 * (publishLodMeshOps): DrawLodMesh calls GetFrame once for every frame that
 * draws an actor, so Play keeps one cache and publishes it once for each
 * frame (docs/script-lodmesh-lod.md "Camera space"). A translation check, not
 * original-game evidence (the original's GetFrame with camera Coords is the
 * validate-lodmesh-frame oracle's). JavaScript and Wasm, keyframes, tweens,
 * blend slots, count changes and reflected (mirror) Coords. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {getLodMeshFrame,lodMeshCameraMatrix,planLodMeshFrame,materializeLodMeshFrame,publishLodMeshOps,
  createLodMeshFrameCache} from '../src/runtime/lodmesh-frame.mjs';

const kernel=await loadLodMeshKernel();
const COUNT=96;
const IDENTITY=[0,0,0,1,0,0,0,1,0,0,0,1];
// A camera looking along a yaw/pitch like Frame->Coords (X right, Y down, Z
// forward), and the same reflected across a plane (Mirror -1, determinant < 0).
const camera=(origin,yaw,pitch)=>{
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [...origin,-sy,cy,0,sp*cy,sp*sy,-cp,cp*cy,cp*sy,sp].map(Math.fround);
};
const reflect=(coords,plane)=>{
  const [nx,ny,nz,w]=plane,n=[nx,ny,nz];
  const point=p=>{const d=2*(nx*p[0]+ny*p[1]+nz*p[2]-w);return p.map((c,i)=>Math.fround(c-d*n[i]));};
  const vector=v=>{const d=2*(nx*v[0]+ny*v[1]+nz*v[2]);return v.map((c,i)=>Math.fround(c-d*n[i]));};
  return [...point(coords.slice(0,3)),...vector(coords.slice(3,6)),...vector(coords.slice(6,9)),...vector(coords.slice(9,12))];
};
const cameras=[camera([-1210.5,880.25,64.75],0.35,-0.02),camera([2310.125,-14.5,-310.5],-2.4,0.4),
  reflect(camera([-1210.5,880.25,64.75],0.35,-0.02),[0.6,0.8,0,120]),IDENTITY];

function fixture(count) {
  const data=new Uint8Array(count*4*8),view=new DataView(data.buffer);
  let seed=777;
  for(let i=0;i<count*4;i++)for(let axis=0;axis<3;axis++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    view.setInt16(i*8+axis*2,seed>>>16,true);
  }
  const mesh={frameVertexCount:count,scalarBits:new Map([[0x184,3]]),
    arrays:new Map([[0x60,{load:()=>({data})}]]),
    sequences:[{name:'Move',startFrame:0,numFrames:3},{name:'Other',startFrame:1,numFrames:3}],
    scale:[0.0137,-0.00983,0.00735],origin:[37.1,-12.89,0.003],rotation:[4917,23471,-6193]};
  const actor={bAnimByOwner:false,Owner:null,bParticles:false,DrawScale:1.237,
    Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],Rotation:[1951,-7583,197],
    AnimSequence:'Move',AnimFrame:0.4137,BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]};
  return {mesh,actor};
}
const script=[
  {frame:0.4137},
  {frame:0.99999,count:60},
  {frame:0.71,blend:['Move','None','Other','None'],blendFrame:0.3},
  {frame:-0.25,sequence:'Other',blend:['Move','Other','Other','None'],blendFrame:-0.4},
  {frame:-0.12345,blendFrame:-0.2,count:70},
  {frame:-0.00001,blendFrame:-0.0001},
  {frame:0.2,blend:['None','None','None','None']},
];

for(const backend of ['javascript','wasm'])
test(`publishing the cache through a frame's matrix equals GetFrame with its Coords (${backend})`,()=>{
  const {mesh,actor}=fixture(COUNT);
  const services=cache=>({cache,kernel:backend==='wasm'?kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001});
  const world=createLodMeshFrameCache(),direct=cameras.map(()=>createLodMeshFrameCache());
  let published=0,blends=0,tweens=0;
  for(const entry of script) {
    actor.AnimFrame=entry.frame;
    if(entry.sequence)actor.AnimSequence=entry.sequence;
    if(entry.blend)actor.BlendAnimSequence=entry.blend;
    actor.BlendAnimFrame=Array(4).fill(entry.blendFrame??entry.frame);
    const vertexCount=entry.count??COUNT-3;
    const first=getLodMeshFrame(mesh,actor,IDENTITY,services(world),{vertexCount});
    blends+=first.ops.filter(op=>op.blend).length;tweens+=first.ops.filter(op=>op.tween).length;
    cameras.forEach((coords,k)=>{
      // The original's way: one GetFrame call per frame with its own Coords
      // (the caches evolve alike, being called with the same state).
      const expected=getLodMeshFrame(mesh,actor,coords,services(direct[k]),{vertexCount});
      const matrix=lodMeshCameraMatrix(mesh,actor,coords,services(world));
      const output=new Uint8Array(COUNT*12);
      publishLodMeshOps(mesh,first.ops,matrix,{output,stride:12,kernel:services(world).kernel});
      const count=first.vertexCount+3;
      assert.equal(first.vertexCount,expected.vertexCount);
      for(let i=0;i<count*3;i++) {
        const a=new DataView(output.buffer).getUint32(i*4,true),b=new DataView(expected.output.buffer,expected.output.byteOffset).getUint32(i*4,true);
        assert.equal(a,b,`${backend} step ${published} camera ${k} word ${i}`);
      }
    });
    published++;
  }
  assert.ok(blends>=4&&tweens>=4,`covered ${blends} blend and ${tweens} tween operations`);
  // The republished cache poses are untouched.
  for(const [key,entry] of world.entries)assert.deepEqual([...entry.vertices],[...direct[0].entries.get(key).vertices],`cache ${key}`);
});

test('a plan\'s channels publish the camera frame once its cache is materialized',()=>{
  const {mesh,actor}=fixture(COUNT);
  const services=cache=>({cache,kernel,read:(a,n)=>a[n],objectIndex:()=>1001});
  const cache=createLodMeshFrameCache(),reference=createLodMeshFrameCache();
  actor.AnimFrame=0.62;actor.BlendAnimSequence=['Move','None','None','None'];actor.BlendAnimFrame=[0.31,0,0,0];
  const plan=planLodMeshFrame(mesh,actor,IDENTITY,services(cache),{vertexCount:COUNT-3});
  materializeLodMeshFrame(plan);
  const coords=cameras[0],matrix=lodMeshCameraMatrix(mesh,actor,coords,services(cache));
  const output=new Uint8Array(COUNT*12);
  publishLodMeshOps(mesh,plan.channels,matrix,{output,stride:12,kernel});
  const expected=getLodMeshFrame(mesh,actor,coords,services(reference),{vertexCount:COUNT-3});
  assert.deepEqual(Buffer.from(output),Buffer.from(expected.output));
});
