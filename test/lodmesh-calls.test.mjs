/** Several GetFrame calls on one actor in one tick (one per frame that draws
 * it: docs/script-lodmesh-lod.md "Child frames"): planned in order and merged
 * (mergeLodMeshPlans) they must leave every cache scalar, the cache poses and
 * the published output as the same calls run through getLodMeshFrame do; and
 * the buffer all of a tick's calls publish into must hold, for each call, the
 * output that call alone published. Translation checks, not original-game
 * evidence (the cache and call semantics are the validated GetFrame's). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {getLodMeshFrame,planLodMeshFrame,materializeLodMeshFrame,mergeLodMeshPlans,snapshotLodMeshCache,
  createLodMeshFrameCache} from '../src/runtime/lodmesh-frame.mjs';

const kernel=await loadLodMeshKernel();
const coords=[31.13,-17.7,0.005,0.37,-0.95,0.01,-0.21,0.73,0.875,0.015,-0.375,0.91];
function fixture(count) {
  const data=new Uint8Array(count*4*8),view=new DataView(data.buffer);
  let seed=4242;
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

// Ticks: the animation state and the requested counts of the frames that draw
// the actor, in DrawFrame's order (the main frame last). Keyframe and tween
// states, blend slots, sequence changes, counts above and below each other
// and the tween clamp.
const COUNT=96;
const script=[
  {frame:0.4137,calls:[COUNT]},
  {frame:0.99999,calls:[COUNT,40]},
  {frame:0.3,calls:[40,COUNT]},
  {frame:0.35,calls:[70,30,70]},
  {frame:-0.25,sequence:'Other',calls:[50,COUNT]},
  {frame:-0.12345,calls:[COUNT,60]},
  {frame:-0.1,calls:[60,60,COUNT]},
  {frame:-0.00001,calls:[COUNT,20]},
  {frame:0.71,blend:['Move','None','Other','None'],calls:[COUNT,50]},
  // (a blend slot's cache entry is created while tweening: the calls do not merge)
  {frame:-0.4,blend:['Move','Other','Other','None'],blendFrame:-0.3,calls:[80,COUNT],degrade:true},
  {frame:-0.2,blendFrame:-0.1,calls:[COUNT,45]},
  {frame:-0.05,calls:[1,COUNT]},
  {frame:-0.01,calls:[COUNT,COUNT]},
  {frame:0.2,blend:['None','None','None','None'],calls:[30,90]},
  {frame:-0.5,sequence:'Move',calls:[90,35]},
  {frame:-0.3,calls:[35,90]},
  {frame:0.9,calls:[COUNT,10]},
];
// A tick that creates a cache entry while tweening, with a sequence the entry
// already names (so its completion stays above .97 and the second call fills),
// cannot merge: a keyframe operation and a tween operation on one channel.
const first={frame:-0.25,calls:[50,COUNT]};

for(const backend of ['javascript','wasm'])
test(`merged calls equal the calls in order (${backend})`,()=>{
  const {mesh,actor}=fixture(COUNT);
  const reference=createLodMeshFrameCache(),planned=createLodMeshFrameCache(),alone=createLodMeshFrameCache();
  const services=cache=>({cache,kernel:backend==='wasm'?kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001});
  const union=new Uint8Array(COUNT*12),plannedOut=new Uint8Array(COUNT*12);
  let merged=0,single=0,degraded=0;
  for(const [step,entry] of script.entries()) {
    actor.AnimFrame=entry.frame;
    if(entry.sequence)actor.AnimSequence=entry.sequence;
    if(entry.blend)actor.BlendAnimSequence=entry.blend;
    actor.BlendAnimFrame=Array(4).fill(entry.blendFrame??entry.frame);
    // A tick that cannot merge runs its last call alone (actor-mesh-sim.mjs planGpu).
    const requests=(entry.degrade?entry.calls.slice(-1):entry.calls).filter((count,k,list)=>k===0||count!==list[k-1]);
    // Reference: the calls in order, into one buffer; and into a buffer each
    // (a second cache replays the same calls so each call's own output is
    // read at the moment it was published).
    const returned=[],own=[];
    for(const count of requests) {
      returned.push(getLodMeshFrame(mesh,actor,coords,services(reference),{output:union,vertexCount:count}).vertexCount);
      const out=new Uint8Array(COUNT*12);
      getLodMeshFrame(mesh,actor,coords,services(alone),{output:out,vertexCount:count});
      own.push(out);
    }
    // Each call's published vertices are in the union buffer: later calls
    // publish identical values over them.
    requests.forEach((count,k)=>{
      const published=returned[k]*12;
      // A blend channel's count can be lower than the main channel's (its own
      // valid count); both buffers add it identically where the last call
      // covering a vertex adds it, so compare the vertices the last call
      // covering them published: those below the smallest later count are
      // rewritten by it and equal by the test below.
      const later=Math.min(COUNT,...returned.slice(k+1));
      const fromOwn=own[k].subarray(0,published),fromUnion=union.subarray(0,published);
      assert.deepEqual(fromUnion.subarray(0,Math.min(published,later*12)),fromOwn.subarray(0,Math.min(published,later*12)),
        `step ${step} call ${k}: the buffer holds the call's output below the later calls' counts`);
      assert.deepEqual(fromUnion.subarray(later*12,published),fromOwn.subarray(later*12,published),
        `step ${step} call ${k}: the buffer holds the call's output above the later calls' counts`);
    });
    // Planned: in order, merged (a degraded tick: the calls fail to merge,
    // the cache is put back and the last call is planned alone).
    if(entry.degrade) {
      const restore=snapshotLodMeshCache(planned);
      const attempt=entry.calls.map(count=>planLodMeshFrame(mesh,actor,coords,services(planned),{output:plannedOut,vertexCount:count}));
      assert.equal(mergeLodMeshPlans(attempt),null,`step ${step}: the calls do not merge`);
      restore();degraded++;
    }
    const plans=requests.map(count=>planLodMeshFrame(mesh,actor,coords,services(planned),{output:plannedOut,vertexCount:count}));
    const plan=mergeLodMeshPlans(plans);
    assert.ok(plan,`step ${step}: the calls merge`);
    if(requests.length>1)merged++;else single++;
    assert.deepEqual(plans.map(p=>p.vertexCount),returned,`step ${step}: returned counts`);
    assert.deepEqual(scalars(planned),scalars(reference),`step ${step}: cache scalars`);
    // The merged plan's operations run once give the buffer and the cache.
    materializeLodMeshFrame(plan);
    const most=Math.max(...returned);
    assert.deepEqual(plannedOut.subarray(0,most*12),union.subarray(0,most*12),`step ${step}: merged output`);
    assert.deepEqual(vertices(planned).map(([key,v])=>[key,v.slice(0,most*3)]),vertices(reference).map(([key,v])=>[key,v.slice(0,most*3)]),
      `step ${step}: cache pose`);
  }
  assert.ok(merged>8&&single>=1&&degraded===1);
});

test('calls that create a cache entry while tweening do not merge, and restore the cache',()=>{
  const {mesh,actor}=fixture(COUNT),cache=createLodMeshFrameCache();
  const services={cache,kernel:null,read:(a,n)=>a[n],objectIndex:()=>1001};
  actor.AnimFrame=first.frame;actor.AnimSequence='None'; // no sequence: the entry's completion stays 1, the second call fills
  const restore=snapshotLodMeshCache(cache);
  const plans=first.calls.map(count=>planLodMeshFrame(mesh,actor,coords,services,{vertexCount:count}));
  assert.equal(mergeLodMeshPlans(plans),null);
  restore();
  assert.equal(cache.entries.size,0,'the entry created by the attempt is dropped');
  // One call alone is the same as on a fresh cache.
  const again=planLodMeshFrame(mesh,actor,coords,services,{vertexCount:COUNT});
  const fresh=createLodMeshFrameCache();
  const compare=planLodMeshFrame(mesh,actor,coords,{...services,cache:fresh},{vertexCount:COUNT});
  assert.equal(again.vertexCount,compare.vertexCount);
  assert.deepEqual(scalars(cache),scalars(fresh));
});
