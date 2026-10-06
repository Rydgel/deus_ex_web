/** Full original GetFrame reference and translation boundary. */
import {execFileSync} from 'node:child_process';
import {auditAssert,auditControlWord} from './precision-audit.mjs';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs).
const assert=auditAssert(),controlWord=auditControlWord();
import {readFile,writeFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),rows=[];
for(const [pack,index] of [['DeusExDeco',606],['DeusExCharacters',669]]) {
  const bytes=await readFile(`${root}/System/${pack}.u`),pkg=parsePackage(bytes),entry=pkg.exports[index-1];
  const names=Object.fromEntries(pkg.names.map((n,i)=>[n.name,i]));names.UnknownSequence=0xffffff;
  const steps=[],add=(name,actors={},extra={})=>steps.push({name,actors,...extra});
  const pose=(sequence,frame,fields={})=>({actor:{AnimSequence:sequence,AnimFrame:frame,...fields}});
  const move=index===669?'Walk':'All',other=index===669?'HitTorso':'On';
  add('missing-sequence-cold',pose('UnknownSequence',0));
  add('sequence-first',pose(move,0));
  add('sequence-half',pose(move,0.375));
  add('sequence-wrap',pose(move,0.9999));
  add('sequence-one',pose(move,1));
  add('sequence-after-one',pose(move,1.3217));
  add('tween-new-sequence',pose(other,-0.25));
  add('tween-progress',pose(other,-0.12345));
  add('tween-regressed-frame',pose(other,-0.234));
  add('tween-near-end',pose(other,-0.0001));
  add('finished-tween',pose(other,0));
  add('changed-mesh-invalidates',pose(move,-0.25),{invalidate:true});
  add('reduced-count',pose(move,0.4),{count:7});
  add('tween-count-limited',pose(other,-0.25),{count:15});
  add('tween-count-progress',pose(other,-0.02),{count:15});
  add('tween-count-expands',pose(other,-0.00001),{count:15});
  add('transformed',pose(move,0.4137,{Location:[137.35,-95.75,40.13],PrePivot:[2.35,-7.875,3.375],
    Rotation:[4917,23471,-6193],DrawScale:1.237}),{coords:[-91.125,65.7,81.32,0.75,0.25,-0.5,-0.125,0.875,0.3,0.5,-0.75,0.25],
    meshFloats:{0x100:-0.01273,0x104:0.00735,0x108:0.00983,0x10c:37.1,0x110:-12.89}});
  add('owner-animation-particles',{actor:{bAnimByOwner:true,Owner:'owner',DrawScale:2.3},
    owner:{AnimSequence:other,AnimFrame:0.31,bParticles:true}});
  add('null-owner-falls-back',{actor:{Owner:null}});
  if(index===669) {
    add('four-additive-blends',pose('BreatheLight',0.234,{BlendAnimSequence:['MouthA','Blink','HeadLeft','HeadUp'],BlendAnimFrame:[0,0.371,0,0]}));
    add('blend-tween-start',pose('BreatheLight',0.3,{BlendAnimSequence:['MouthE','Blink','HeadLeft','HeadUp'],BlendAnimFrame:[-0.5,-0.25,-0.3,-0.4]}));
    add('blend-tween-progress',pose('BreatheLight',0.35,{BlendAnimFrame:[-0.21,-0.13,-0.12,-0.1]}));
    add('blend-tween-near-end',pose('BreatheLight',0.39,{BlendAnimFrame:[-0.0001,-0.0001,-0.0001,-0.0001]}));
    add('blend-completion',pose('BreatheLight',0.413,{BlendAnimFrame:[0,0,0,0]}));
    add('owner-blend-cache-key',{actor:{Owner:'owner'},owner:{BlendAnimSequence:['MouthA','None','None','None'],BlendAnimFrame:[0,0,0,0]}});
    add('blend-missing-sequence',{owner:{BlendAnimSequence:['UnknownSequence','None','None','None'],BlendAnimFrame:[0.13,0,0,0]}});
    add('blend-cache-invalidation',{}, {invalidate:true,stride:28});
  }
  rows.push({pkg,bytes,index,spec:{name:entry.name,names,steps,mesh:{name:entry.name,version:68,start:entry.serialOffset,
    prefixSize:readObject(pkg,bytes,index).reader.offset,payload:bytes.subarray(entry.serialOffset,entry.serialOffset+entry.serialSize).toString('base64'),lazy:1}}});
}
let reference;
if(process.argv.includes('--captured')) {
  const saved=JSON.parse(await readFile('.cache/research/lodmesh-frame-original.json','utf8'));
  assert.deepEqual(saved.specs,rows.map(r=>r.spec),'original capture inputs must match this run');reference=saved.reference;
}else reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-lodmesh-frame-oracle.py',root,...(controlWord?[controlWord]:[])],{input:JSON.stringify(rows.map(r=>r.spec)),encoding:'utf8',maxBuffer:24*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/lodmesh-frame-original.json',JSON.stringify({specs:rows.map(r=>r.spec),reference}));
  for(const row of reference.cases)for(const step of row.steps)console.log(row.name,step.name,step.count,step.events);
  process.exit(0);
}
const {getLodMeshFrame,createLodMeshFrameCache}=await import('../src/runtime/lodmesh-frame.mjs');
const kernel=process.argv.includes('--wasm')?await (await import('../src/runtime/lodmesh-wasm.mjs')).loadLodMeshKernel():null;
const bytesEqual=(actual,expected,label)=>{
  const a=Buffer.from(actual.buffer,actual.byteOffset,actual.byteLength),b=Buffer.from(expected,'base64');
  assert.equal(a.length,b.length,label);
  const at=a.findIndex((v,i)=>v!==b[i]);
  if(at>=0){const aligned=at&~3;if(assert.enabled){let n=0,ulps=0;for(let i=0;i+4<=a.length;i+=4)if(a.readUInt32LE(i)!==b.readUInt32LE(i)){n++;ulps=Math.max(ulps,Math.abs(a.readInt32LE(i)-b.readInt32LE(i)));}assert.ok(false,label.replace(/ cache .*/,' cache'));assert.tally(label.replace(/ cache .*/,' cache').replace(/^\S+ \S+/,'step'),n,a.length/4,ulps);return;}assert.fail(`${label} byte ${at}: ${a.readFloatLE(aligned)} vs ${b.readFloatLE(aligned)} (${a.subarray(aligned,aligned+4).toString('hex')} / ${b.subarray(aligned,aligned+4).toString('hex')})`);}
};
for(const [rowIndex,row] of rows.entries()) {
  const mesh=decodeLodMeshPayload(row.pkg,row.bytes,row.index),referenceRow=reference.cases[rowIndex];
  const actors=Object.fromEntries(['actor','owner'].map((id,i)=>[id,{id,index:1001+i,AnimSequence:'None',AnimFrame:0,DrawScale:1,
    Location:[0,0,0],PrePivot:[0,0,0],Rotation:[0,0,0],bAnimByOwner:false,bParticles:false,Owner:null,
    BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]}]));
  const cache=createLodMeshFrameCache({allocate:size=>new Uint8Array(size).fill(0x33)});
  const events=[],create=cache.create,flush=cache.flush;
  cache.create=(key,size)=>{events.push({op:'create',key:String(key),size});return create(key,size);};
  cache.flush=key=>{events.push({op:'flush',key:String(key)});return flush(key);};
  for(const [stepIndex,step] of row.spec.steps.entries()) {
    const original=referenceRow.steps[stepIndex],label=`${row.spec.name} ${step.name}`;
    for(const [id,fields] of Object.entries(step.actors))for(const [name,value] of Object.entries(fields))
      actors[id][name]=name==='Owner'?actors[value]??null:Array.isArray(value)?value.map(v=>typeof v==='number'?Math.fround(v):v):typeof value==='number'?Math.fround(value):value;
    if(step.invalidate)for(const entry of cache.entries.values())entry.mesh=null;
    for(const [offset,value] of Object.entries(step.meshFloats??{})) {
      const at=Number(offset);(at<0x10c?mesh.scale:mesh.origin)[(at-(at<0x10c?0x100:0x10c))/4]=Math.fround(value);
    }
    if(step.special!==undefined)mesh.scalarBits.set(0x184,step.special);
    const stride=step.stride??20,output=new Uint8Array(mesh.frameVertexCount*stride).fill(0x55);
    events.length=0;
    const result=getLodMeshFrame(mesh,actors.actor,step.coords??[0,0,0,1,0,0,0,1,0,0,0,1],
      {cache,kernel,read:(a,n)=>a[n],objectIndex:a=>a.index},{vertexCount:step.count??mesh.frameVertexCount,stride,output});
    assert.equal(result.vertexCount,original.count,label);bytesEqual(result.output,original.output,label);
    assert.deepEqual(events,original.events,`${label} cache calls`);
    assert.deepEqual([...cache.entries.keys()].map(String).sort(),Object.keys(original.cache).sort(),`${label} cache keys`);
    for(const [key,entry] of cache.entries) {
      const originalCache=original.cache[String(key)],bytes=Buffer.alloc(20+mesh.frameVertexCount*12);
      bytes.writeFloatLE(entry.frame,4);bytes.writeUInt32LE(row.spec.names[entry.sequence],8);
      bytes.writeInt32LE(entry.valid,12);bytes.writeFloatLE(entry.completion,16);
      Buffer.from(entry.vertices.buffer,entry.vertices.byteOffset,entry.vertices.byteLength).copy(bytes,20);
      bytesEqual(bytes,originalCache.data,`${label} cache ${key}`);
      assert.equal(entry.mesh===mesh,originalCache.sameMesh,label);assert.equal(entry.locks,originalCache.locks,label);
    }
    assert.equal(mesh.archivePosition,original.archivePosition,label);
    assert.equal(mesh.arrays.get(0x60).savedPosition,original.lazyPosition,label);
  }
}
if(assert.enabled)assert.report('validate-lodmesh-frame');else console.log(`PASS ${rows.reduce((n,r)=>n+r.spec.steps.length,0)} complete original GetFrame calls: LightSwitch and GM_Trench output/padding, all cache bytes, frame wrap/tween, owner/transforms, reduced counts and four additive blends.`);
