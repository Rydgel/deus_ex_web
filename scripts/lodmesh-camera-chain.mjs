/** DrawLodMesh's order of work on real meshes, with the original GetFrame in
 * the loop (docs/script-lodmesh-lod.md "Camera space"): GetFrame is called
 * with the Frame->Coords of the frame that draws the actor, so its output
 * buffer is in that frame's camera space, and the LOD's morph then runs on it.
 *
 * For each LOD mesh (lodmesh-lod-cases.mjs LOD_MESHES) the original GetFrame
 * (scripts/native-lodmesh-frame-oracle.py, control word 0x007f) runs a
 * sequence of poses in the cameras of `cameras()`: keyframes, tweens and, for
 * a character, additive blends, the cache evolving from one pose to the next;
 * each pose's FTransTexture buffer (stride 88, over a pattern standing for
 * DrawLodMesh's uninitialized block) is what the LOD oracle
 * (scripts/native-lodmesh-lod-oracle.py) then morphs. The samples
 * carry that buffer as their input, in the shape buildLodMeshSamples gives,
 * so validate-lodmesh-lod.mjs --camera-chain compares the translation's
 * morph, faces and scratch with the original's on the original's buffers.
 * The translation's own GetFrame (getLodMeshFrame, JavaScript and Wasm)
 * must produce those buffers byte for byte before that. */
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {createLodMeshFrameCache,getLodMeshFrame} from '../src/runtime/lodmesh-frame.mjs';
import {lodMeshTopology} from '../src/runtime/lodmesh-lod.mjs';
import {LOD_MESHES,meshCases,meshOracleSpec,oracleCase,pattern} from './lodmesh-lod-cases.mjs';

const f=Math.fround;
/** A camera's Frame->Coords (origin, X right, Y down, Z forward) looking along yaw/pitch. */
export function cameraLook(origin,yaw,pitch) {
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [...origin,-sy,cy,0,sp*cy,sp*sy,-cp,cp*cy,cp*sy,sp].map(f);
}
/** OccludeFrame's mirror frame: Origin and the three axes reflected across the plane [nx, ny, nz, w]. */
export function cameraReflect(coords,[nx,ny,nz,w]) {
  const n=[nx,ny,nz],point=p=>{const d=2*(nx*p[0]+ny*p[1]+nz*p[2]-w);return p.map((c,i)=>f(c-d*n[i]));};
  const vector=v=>{const d=2*(nx*v[0]+ny*v[1]+nz*v[2]);return v.map((c,i)=>f(c-d*n[i]));};
  return [...point(coords.slice(0,3)),...vector(coords.slice(3,6)),...vector(coords.slice(6,9)),...vector(coords.slice(9,12))];
}
export const cameras=()=>{
  const a=cameraLook([-1210.5,880.25,64.75],0.35,-0.02),b=cameraLook([2310.125,-1914.5,310.5],-2.4,0.4);
  return {a,b,reflected:cameraReflect(a,[0.6,0.8,0,120])};
};
// The LOD cases that morph (and a floor): the morph's regimes, as in
// validate-lodmesh-lod.mjs, run on each pose's buffer.
const CASES=['morph-edge','morph-full-count','reduced-morph','reduced-far','min-verts','rotated-coords','returned-1.7'];

/** The poses of one mesh, as frame-oracle steps. */
function poses(mesh) {
  const names=mesh.sequences.map(sequence=>sequence.name),{a,b,reflected}=cameras();
  const standing={Location:[2310.5,-140.25,-27.75],PrePivot:[0,0,0],Rotation:[0,23000,0],DrawScale:1};
  const steps=[{name:'keyframe',coords:a,actor:{AnimSequence:names[0]??'None',AnimFrame:0.4137,...standing}},
    {name:'keyframe-reflected',coords:reflected,actor:{AnimFrame:0.71}}];
  if(names.length>1)steps.push({name:'tween',coords:b,actor:{AnimSequence:names[1],AnimFrame:-0.25}},
    {name:'tween-progress',coords:a,actor:{AnimFrame:-0.1}});
  if(names.length>3)steps.push({name:'blend',coords:b,actor:{AnimSequence:names[0],AnimFrame:0.234,
    BlendAnimSequence:[names[1],names[2],names[3],'None'],BlendAnimFrame:[0.2,0.371,0,0]}},
  {name:'blend-tween',coords:reflected,actor:{AnimFrame:0.3,BlendAnimFrame:[-0.3,-0.2,-0.1,0]}});
  return steps;
}

const fields=actor=>Object.fromEntries(Object.entries(actor).map(([key,value])=>
  [key,Array.isArray(value)?value.map(v=>typeof v==='number'?f(v):v):typeof value==='number'?f(value):value]));

/** The camera-chain samples (buildLodMeshSamples's shape), after asserting the
 * translation's GetFrame equals the original's on every pose. */
export async function buildCameraChainSamples(root,{assert,kernel=null,python}) {
  const packages=new Map(),rows=[],samples=[];
  for(const [pack,name] of LOD_MESHES) {
    let entry=packages.get(pack);
    if(!entry){const bytes=await readFile(`${root}/System/${pack}.u`);entry={bytes,pkg:parsePackage(bytes)};packages.set(pack,entry);}
    const {bytes,pkg}=entry,index=pkg.exports.findIndex(e=>e.name===name&&e.className==='LodMesh')+1;
    if(!index)throw new Error(`${pack}.${name} is not an installed LodMesh`);
    const mesh=decodeLodMeshPayload(pkg,bytes,index),steps=poses(mesh),frameVerts=mesh.frameVertexCount;
    const names=Object.fromEntries(pkg.names.map((n,i)=>[n.name,i]));
    const exported=pkg.exports[index-1];
    const seeded=steps.map((step,k)=>({...step,stride:88,pattern:Buffer.from(pattern(frameVerts*88,0x5eed2000+rows.length*16+k)).toString('base64'),
      actors:{actor:fields(step.actor)}}));
    rows.push({pack,name,index,pkg,bytes,mesh,steps:seeded,spec:{name:`${pack}.${name}`,names,steps:seeded.map(({name:stepName,coords,stride,pattern:bytes,actors})=>
      ({name:stepName,coords,stride,pattern:bytes,actors})),
      mesh:{name:exported.name,version:68,start:exported.serialOffset,prefixSize:readObject(pkg,bytes,index).reader.offset,
        payload:bytes.subarray(exported.serialOffset,exported.serialOffset+exported.serialSize).toString('base64'),lazy:1}}});
  }
  const reference=JSON.parse(execFileSync(python,['scripts/native-lodmesh-frame-oracle.py',root],
    {input:JSON.stringify(rows.map(row=>row.spec)),encoding:'utf8',maxBuffer:256<<20}));
  for(const [rowIndex,row] of rows.entries()) {
    const original=reference.cases[rowIndex],mesh=row.mesh;
    // The translation's GetFrame on the same poses, one cache, the actor's fields accumulating as the oracle's do.
    const actor={id:'actor',index:1001,AnimSequence:'None',AnimFrame:0,DrawScale:1,Location:[0,0,0],PrePivot:[0,0,0],Rotation:[0,0,0],
      bAnimByOwner:false,bParticles:false,Owner:null,BlendAnimSequence:['None','None','None','None'],BlendAnimFrame:[0,0,0,0]};
    const cache=createLodMeshFrameCache({allocate:size=>new Uint8Array(size).fill(0x33)});
    const services={cache,kernel,read:(a,n)=>a[n],objectIndex:a=>a.index};
    const base=await meshOracleSpec(root,row.pack,row.index,[]),topology=lodMeshTopology(mesh);
    const cases=meshCases(topology).filter(c=>CASES.includes(c.name));
    for(const [k,step] of row.steps.entries()) {
      Object.assign(actor,step.actors.actor);
      const label=`${row.pack}.${row.name} ${step.name}`;
      const output=Uint8Array.from(Buffer.from(step.pattern,'base64'));
      const result=getLodMeshFrame(mesh,actor,step.coords,services,{stride:88,output});
      const native=Buffer.from(original.steps[k].output,'base64');
      assert.equal(result.vertexCount,original.steps[k].count,`${label}: returned count`);
      assert.ok(Buffer.from(output).equals(native),`${label}: GetFrame buffer (camera space)`);
      // The morph oracle's sample on that buffer.
      samples.push({name:label,mesh,topology,vertices:Uint8Array.from(native),cases,
        spec:{...base.spec,name:label,vertices:native.toString('base64'),cases:cases.map(oracleCase)}});
    }
  }
  return samples;
}
