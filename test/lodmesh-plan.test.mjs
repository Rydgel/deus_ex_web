/** planLodMeshFrame / materializeLodMeshFrame against getLodMeshFrame
 * (docs/gpu-mesh.md, "CPU shadow"). Translation checks, not original-game
 * evidence: the plan must leave every cache scalar exactly as the full
 * evaluation does, and the replayed output and cache pose must be bit-equal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {getLodMeshFrame,planLodMeshFrame,materializeLodMeshFrame,createLodMeshFrameCache} from '../src/runtime/lodmesh-frame.mjs';

const kernel=await loadLodMeshKernel();
const coords=[31.13,-17.7,0.005,0.37,-0.95,0.01,-0.21,0.73,0.875,0.015,-0.375,0.91];
function fixture(count) {
  const data=new Uint8Array(count*4*8),view=new DataView(data.buffer);
  let seed=987;
  for(let i=0;i<count*4;i++)for(let axis=0;axis<3;axis++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    view.setInt16(i*8+axis*2,seed>>>16,true);
  }
  const mesh={frameVertexCount:count,scalarBits:new Map([[0x184,0]]),
    arrays:new Map([[0x60,{load:()=>({data})}]]),
    sequences:[{name:'Move',startFrame:0,numFrames:3},{name:'Other',startFrame:1,numFrames:3}],
    scale:[0.0137,-0.00983,0.00735],origin:[37.1,-12.89,0.003],rotation:[4917,23471,-6193]};
  const actor={bAnimByOwner:false,Owner:null,bParticles:false,DrawScale:1.237,
    Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],Rotation:[1951,-7583,197],
    AnimSequence:'Move',AnimFrame:0.4137,BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]};
  return {mesh,actor};
}
const scalars=cache=>[...cache.entries].map(([key,e])=>[key,e.frame,e.sequence,e.valid,e.completion,e.locks,e.mesh]);
const vertices=cache=>[...cache.entries].map(([key,e])=>[key,[...e.vertices]]);

// Frames mixing keyframes, tweens (negative AnimFrame), sequence changes,
// blend slots appearing/disappearing and a reduced count that forces the
// tween fill branch.
const script=[
  {frame:0.4137},{frame:0.99999},{frame:-0.25,sequence:'Other'},{frame:-0.12345},{frame:-0.00001},
  {frame:0.71,blend:['Move','None','Other','None']},{frame:-0.4,blend:['Move','Other','Other','None'],blendFrame:-0.3},
  {frame:-0.2,blendFrame:-0.1},{frame:-0.05,count:1},{frame:-0.01},{frame:0.2,blend:['None','None','None','None']},
  {frame:-0.5,sequence:'Move'},{frame:-0.3},{frame:0.9},
];
for(const backend of ['javascript','wasm'])for(const count of [3,96])
test(`plan + replay equals GetFrame (${backend}, ${count} vertices)`,()=>{
  const {mesh,actor}=fixture(count);
  const reference=createLodMeshFrameCache(),planned=createLodMeshFrameCache();
  const services=cache=>({cache,kernel:backend==='wasm'?kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001});
  const referenceOut=new Uint8Array(count*12),plannedOut=new Uint8Array(count*12);
  for(const [step,entry] of script.entries()) {
    actor.AnimFrame=entry.frame;
    if(entry.sequence)actor.AnimSequence=entry.sequence;
    if(entry.blend)actor.BlendAnimSequence=entry.blend;
    actor.BlendAnimFrame=Array(4).fill(entry.blendFrame??entry.frame);
    const options=output=>({output,vertexCount:entry.count??count});
    const expected=getLodMeshFrame(mesh,actor,coords,services(reference),options(referenceOut));
    // Materialize on some frames only; switch to the full CPU path on one.
    if(step===9){
      const got=getLodMeshFrame(mesh,actor,coords,services(planned),options(plannedOut));
      assert.equal(got.vertexCount,expected.vertexCount);
      const published=(got.vertexCount+0)*12;
      assert.deepEqual(plannedOut.subarray(0,published),referenceOut.subarray(0,published),`step ${step}: CPU path after plans`);
    } else {
      const plan=planLodMeshFrame(mesh,actor,coords,services(planned),options(plannedOut));
      assert.equal(plan.vertexCount,expected.vertexCount,`step ${step}: vertexCount`);
      assert.deepEqual(scalars(planned),scalars(reference),`step ${step}: cache scalars`);
      if(step%3===2||step===script.length-1){
        materializeLodMeshFrame(plan);
        // Vertices past the published count keep caller-owned bytes from
        // earlier calls; Play always publishes the full count.
        const published=(plan.vertexCount+plan.special)*12;
        assert.deepEqual(plannedOut.subarray(0,published),referenceOut.subarray(0,published),`step ${step}: replayed output`);
        assert.deepEqual(vertices(planned),vertices(reference),`step ${step}: replayed cache pose`);
      }
    }
    assert.deepEqual(scalars(planned),scalars(reference),`step ${step}: cache scalars`);
  }
});

test('a stale plan cannot be materialized after a newer one',()=>{
  const {mesh,actor}=fixture(3),cache=createLodMeshFrameCache();
  const services={cache,kernel:null,read:(a,n)=>a[n],objectIndex:()=>7};
  const old=planLodMeshFrame(mesh,actor,coords,services);
  actor.AnimFrame=-0.2;planLodMeshFrame(mesh,actor,coords,services);
  assert.throws(()=>materializeLodMeshFrame(old),/no longer current/);
});
