/** UMesh::GetFrame (Engine 0x103a7780) against the original: the classic mesh pose, docs/umesh.md.
 *
 * Complete calls of the unchanged original body (native-lodmesh-frame-oracle.py with `classic`
 * cases) on the game's classic meshes (EidosLogo, DXText, the Fly) and on a synthetic eight-frame
 * mesh built from the Fly's payload (umesh-fixture.mjs) that reaches what the real ones, which have a
 * single frame, cannot: sequence wrap and interpolation, tweens, a mesh change and four additive
 * blends. Every output byte (including strided padding), every cache byte, lock and
 * Create/Flush request must match. ORACLE_CW=0x007f is the render pass's precision control.
 *
 * `--wasm` runs the same calls through the Rust pose kernel (services.kernel, native/lodmesh-kernel). */
import {execFileSync} from 'node:child_process';
import {auditAssert,auditControlWord} from './precision-audit.mjs';
const assert=auditAssert(),controlWord=auditControlWord();
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {createUMeshFrameCache,getUMeshFrame} from '../src/runtime/umesh-frame.mjs';
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {gameDirectory} from './game-directory.mjs';
import {classicMeshCase,syntheticMeshCase,nameTable} from './umesh-fixture.mjs';

const root=gameDirectory(),rows=[],kernel=process.argv.includes('--wasm')?await loadLodMeshKernel():null;
const stepper=()=>{
  const steps=[],add=(name,actors={},extra={})=>steps.push({name,actors,...extra});
  const pose=(sequence,frame,fields={})=>({actor:{AnimSequence:sequence,AnimFrame:frame,...fields}});
  return {steps,add,pose};
};
const look=(origin,yaw,pitch)=>{
  const f=Math.fround,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [...origin,-sy,cy,0,sp*cy,sp*sy,-cp,cp*cy,cp*sy,sp].map(f);
};
const reflect=(coords,[nx,ny,nz,w])=>{
  const f=Math.fround,n=[nx,ny,nz],point=p=>{const d=2*(nx*p[0]+ny*p[1]+nz*p[2]-w);return p.map((c,i)=>f(c-d*n[i]));};
  const vector=v=>{const d=2*(nx*v[0]+ny*v[1]+nz*v[2]);return v.map((c,i)=>f(c-d*n[i]));};
  return [...point(coords.slice(0,3)),...vector(coords.slice(3,6)),...vector(coords.slice(6,9)),...vector(coords.slice(9,12))];
};
const standing={Location:[2310.5,-140.25,-27.75],PrePivot:[0,0,0],Rotation:[0,23000,0],DrawScale:1};
const cameraA=look([-1210.5,880.25,64.75],0.35,-0.02),cameraB=look([2310.125,-1914.5,310.5],-2.4,0.4);
const transformed=[{coords:[-91.125,65.7,81.32,0.75,0.25,-0.5,-0.125,0.875,0.3,0.5,-0.75,0.25],
  meshFloats:{0x100:-0.01273,0x104:0.00735,0x108:0.00983,0x10c:37.1,0x110:-12.89}}];

// The real classic meshes: one frame, sequences All and Still.
for(const [pack,index] of [['DeusExDeco',397],['DeusExDeco',408],['DeusExCharacters',723]]) {
  const row=await classicMeshCase(root,pack,index),names={...nameTable(row.pkg),UnknownSequence:0xffffff},{steps,add,pose}=stepper();
  add('cold-sequence',pose('All',0));
  add('still',pose('Still',0.5));
  add('missing-sequence',pose('UnknownSequence',0));
  add('negative-frame-new-cache',pose('All',-0.25),{invalidate:true});
  add('tween-single-frame',pose('All',-0.25));
  add('tween-progress',pose('All',-0.1));
  add('tween-other-sequence',pose('Still',-0.05));
  add('tween-near-end',pose('Still',-0.0001));
  add('finished-tween',pose('Still',0));
  add('camera-keyframe',pose('All',0,standing),{coords:cameraA});
  add('camera-reflected',pose('All',0,standing),{coords:reflect(cameraB,[0.6,0.8,0,120])});
  add('transformed',pose('All',0.4137,{Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],Rotation:[4917,23471,-6193],DrawScale:1.237}),transformed[0]);
  add('zero-scale-factor',pose('All',0,{DrawScale:0.5}),{coords:cameraA});
  add('owner-animation-particles',{actor:{bAnimByOwner:true,Owner:'owner',DrawScale:2.3},owner:{AnimSequence:'Still',AnimFrame:0.31,bParticles:true}});
  add('null-owner-falls-back',{actor:{Owner:null}});
  row.sample={name:row.spec.name,names,steps,mesh:row.spec};rows.push(row);
}
// The synthetic eight-frame mesh.
{
  const row=await syntheticMeshCase(root,{frames:8,sequences:[{name:'All',start:0,frames:8},{name:'Walk',start:0,frames:3},
    {name:'Run',start:3,frames:4},{name:'Land',start:7,frames:1},{name:'MouthA',start:1,frames:2},{name:'MouthE',start:4,frames:3},
    {name:'Blink',start:0,frames:1},{name:'HeadLeft',start:6,frames:2}]});
  const names={...row.names,UnknownSequence:0xffffff},{steps,add,pose}=stepper();
  add('missing-sequence-cold',pose('UnknownSequence',0));
  add('sequence-first',pose('Walk',0));
  add('sequence-half',pose('Run',0.375));
  add('sequence-wrap',pose('Run',0.9999));
  add('sequence-one',pose('Walk',1));
  add('sequence-after-one',pose('All',1.3217));
  add('sequence-quarter-steps',pose('All',0.0625));
  add('tween-new-sequence',pose('Land',-0.25));
  add('tween-progress',pose('Land',-0.12345));
  add('tween-regressed-frame',pose('Land',-0.234));
  add('tween-near-end',pose('Land',-0.0001));
  add('finished-tween',pose('Land',0));
  add('tween-start-offset',pose('Run',-0.25));
  add('tween-continues',pose('Run',-0.05));
  add('changed-mesh-invalidates',pose('Walk',-0.25),{invalidate:true});
  add('transformed',pose('Run',0.4137,{Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],Rotation:[4917,23471,-6193],DrawScale:1.237}),transformed[0]);
  add('camera-keyframe',pose('Run',0.4137,standing),{coords:cameraA});
  add('camera-reflected',pose('Run',0.4137,standing),{coords:reflect(cameraA,[0.6,0.8,0,120])});
  add('camera-tween',pose('Land',-0.25,standing),{coords:cameraB});
  add('camera-tween-progress',pose('Land',-0.1,standing),{coords:cameraA});
  add('camera-tween-reflected',pose('Land',-0.05,standing),{coords:reflect(cameraB,[0,0.8,0.6,-40])});
  add('owner-animation-particles',{actor:{bAnimByOwner:true,Owner:'owner',DrawScale:2.3},owner:{AnimSequence:'Land',AnimFrame:0.31,bParticles:true}});
  add('null-owner-falls-back',{actor:{Owner:null}});
  add('four-additive-blends',pose('Walk',0.234,{BlendAnimSequence:['MouthA','Blink','HeadLeft','MouthE'],BlendAnimFrame:[0,0.371,0,0.6]}));
  add('blend-tween-start',pose('Walk',0.3,{BlendAnimSequence:['MouthE','Blink','HeadLeft','MouthA'],BlendAnimFrame:[-0.5,-0.25,-0.3,-0.4]}));
  add('blend-tween-progress',pose('Walk',0.35,{BlendAnimFrame:[-0.21,-0.13,-0.12,-0.1]}));
  add('blend-tween-near-end',pose('Walk',0.39,{BlendAnimFrame:[-0.0001,-0.0001,-0.0001,-0.0001]}));
  add('blend-completion',pose('Walk',0.413,{BlendAnimFrame:[0,0,0,0]}));
  add('camera-four-additive-blends',pose('Walk',0.234,{...standing,BlendAnimSequence:['MouthA','Blink','HeadLeft','MouthE'],BlendAnimFrame:[0,0.371,0,0.6]}),{coords:cameraB});
  add('camera-blend-tweens',pose('Walk',0.26,{BlendAnimSequence:['MouthE','Blink','HeadLeft','MouthA'],BlendAnimFrame:[-0.5,-0.25,-0.3,-0.4]}),{coords:cameraA});
  add('camera-blend-tween-progress',pose('Walk',0.3,{BlendAnimFrame:[-0.21,-0.13,-0.12,-0.1]}),{coords:reflect(cameraA,[0.6,0.8,0,120])});
  add('owner-blend-cache-key',{actor:{Owner:'owner'},owner:{BlendAnimSequence:['MouthA','None','None','None'],BlendAnimFrame:[0,0,0,0]}});
  add('blend-missing-sequence',{owner:{BlendAnimSequence:['UnknownSequence','None','None','None'],BlendAnimFrame:[0.13,0,0,0]}});
  add('wide-stride-invalidation',{}, {invalidate:true,stride:28});
  row.sample={name:row.spec.name,names,steps,mesh:row.spec};rows.push(row);
}

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-lodmesh-frame-oracle.py',root,...(controlWord?[controlWord]:[])],{input:JSON.stringify(rows.map(r=>r.sample)),encoding:'utf8',maxBuffer:64*1024*1024}));
const bytesEqual=(actual,expected,label)=>{
  const a=Buffer.from(actual.buffer,actual.byteOffset,actual.byteLength),b=Buffer.from(expected,'base64');
  assert.equal(a.length,b.length,label);
  const at=a.findIndex((v,i)=>v!==b[i]);
  if(at>=0){
    const aligned=at&~3;
    if(assert.enabled){let n=0,ulps=0;for(let i=0;i+4<=a.length;i+=4)if(a.readUInt32LE(i)!==b.readUInt32LE(i)){n++;ulps=Math.max(ulps,Math.abs(a.readInt32LE(i)-b.readInt32LE(i)));}assert.ok(false,label);assert.tally(label.replace(/^\S+ \S+/,'step'),n,a.length/4,ulps);return;}
    assert.fail(`${label} byte ${at}: ${a.readFloatLE(aligned)} vs ${b.readFloatLE(aligned)} (${a.subarray(aligned,aligned+4).toString('hex')} / ${b.subarray(aligned,aligned+4).toString('hex')})`);
  }
};
let calls=0;
for(const [rowIndex,row] of rows.entries()) {
  const mesh=decodeLodMeshPayload(row.pkg,row.bytes,row.index),referenceRow=reference.cases[rowIndex];
  const actors=Object.fromEntries(['actor','owner'].map((id,i)=>[id,{id,index:1001+i,AnimSequence:'None',AnimFrame:0,DrawScale:1,
    Location:[0,0,0],PrePivot:[0,0,0],Rotation:[0,0,0],bAnimByOwner:false,bParticles:false,Owner:null,
    BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]}]));
  const cache=createUMeshFrameCache(),events=[],create=cache.create,flush=cache.flush;
  cache.create=(key,count)=>{events.push({op:'create',key,size:12*count+12});return create(key,count);};
  cache.flush=key=>{events.push({op:'flush',key});return flush(key);};
  for(const [stepIndex,step] of row.sample.steps.entries()) {
    const original=referenceRow.steps[stepIndex],label=`${row.spec.name} ${step.name}`;
    for(const [id,fields] of Object.entries(step.actors))for(const [name,value] of Object.entries(fields))
      actors[id][name]=name==='Owner'?actors[value]??null:Array.isArray(value)?value.map(v=>typeof v==='number'?Math.fround(v):v):typeof value==='number'?Math.fround(value):value;
    if(step.invalidate)for(const entry of cache.entries.values())entry.mesh=null;
    for(const [offset,value] of Object.entries(step.meshFloats??{})) {
      const at=Number(offset);(at<0x10c?mesh.scale:mesh.origin)[(at-(at<0x10c?0x100:0x10c))/4]=Math.fround(value);
    }
    const stride=step.stride??20,output=new Uint8Array(mesh.frameVertexCount*stride).fill(0x55);
    events.length=0;
    const result=getUMeshFrame(mesh,actors.actor,step.coords??[0,0,0,1,0,0,0,1,0,0,0,1],
      {cache,kernel,read:(a,n)=>a[n],objectIndex:a=>a.index},{stride,output});
    calls++;
    bytesEqual(result.output,original.output,label);
    // The original's cache items are keyed by 64-bit ids; here they are strings. The calls and sizes must match in order.
    assert.deepEqual(events.map(e=>[e.op,e.size??0]),original.events.map(e=>[e.op,e.size??0]),`${label} cache calls`);
    assert.equal(cache.entries.size,Object.keys(original.cache).length,`${label} cache items`);
    const originals=Object.values(original.cache);
    const mine=[...cache.entries.values()];
    // Same items, matched by their header and payload (the order of the maps differs).
    for(const entry of mine) {
      const bytes=Buffer.alloc(12+mesh.frameVertexCount*12);
      bytes.writeFloatLE(entry.frame,4);bytes.writeUInt32LE(row.sample.names[entry.sequence]??0,8);
      Buffer.from(entry.vertices.buffer,entry.vertices.byteOffset,entry.vertices.byteLength).copy(bytes,12);
      const match=originals.find(o=>Buffer.from(o.data,'base64').equals(bytes));
      assert.ok(match,`${label} cache item ${entry.frame}/${entry.sequence} has no equal original item`);
      if(match){assert.equal(entry.mesh===mesh,match.sameMesh,label);assert.equal(entry.locks,match.locks,label);}
    }
    assert.equal(mesh.archivePosition,original.archivePosition,label);
  }
}
if(assert.enabled)assert.report(kernel?'validate-umesh-frame --wasm':'validate-umesh-frame');
else console.log(`PASS${kernel?' (Rust kernel)':''} ${calls} complete original UMesh::GetFrame calls: the classic meshes (EidosLogo, DXText, Fly) and an eight-frame synthetic one: output/padding, all cache bytes, sequence wrap/interpolation, tweens, owner/particles, camera-space Frame->Coords (large offsets, mirror-reflected) and four additive blends.`);
