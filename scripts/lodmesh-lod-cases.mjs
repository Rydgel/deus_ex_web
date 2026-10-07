/** The DrawLodMesh LOD reference cases (docs/script-lodmesh-lod.md): real
 * mesh arrays from the installed packages, an original GetFrame output
 * buffer (FTransTexture stride 88) per mesh, and per case the renderer
 * settings, the actor, the caller's FCoords, the frame width, the viewport
 * actor's FovAngle and GetFrame's returned count. Shared by
 * scripts/validate-lodmesh-lod.mjs (and its --reference-only capture) and
 * the Play probe checks. Inputs are float32 bit patterns so the oracle and
 * the translation read the same values. */
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {createLodMeshFrameCache,getLodMeshFrame} from '../src/runtime/lodmesh-frame.mjs';
import {floatBits,lodMeshTanArgument,lodMeshTanFactor,lodMeshTopology,selectLodMesh,RENDER_LOD_SETTINGS} from '../src/runtime/lodmesh-lod.mjs';

export const LOD_MESHES=[
  ['DeusExCharacters','GM_Trench'],['DeusExCharacters','GFM_Trench'],['DeusExCharacters','GM_Jumpsuit'],
  ['DeusExDeco','Chair1'],['DeusExDeco','Barrel1'],['DeusExItems','SoyFood'],
];
const f=Math.fround;
const doubleHex=value=>{const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,value,true);return v.getBigUint64(0,true).toString(16).padStart(16,'0');};
/** A camera FCoords looking along `forward` (unit floats) from `origin`, with
 * X = right and Y = down as Frame->Coords has them. */
function cameraCoords(origin,yaw,pitch=0) {
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const forward=[cp*cy,cp*sy,sp],right=[-sy,cy,0],down=[sp*cy,sp*sy,-cp];
  return [...origin,...right,...down,...forward].map(f);
}
/** Deterministic bytes standing for DrawLodMesh's uninitialized GMem block. */
function pattern(size,seed) {
  const bytes=new Uint8Array(size);let x=seed>>>0;
  for(let i=0;i<size;i++){x=(Math.imul(x,1664525)+1013904223)>>>0;bytes[i]=x>>>24;}
  return bytes;
}

/** One mesh's original GetFrame output at stride 88 over pattern bytes: the
 * first sequence's frame 0.37 in a camera's coords at about 2,300 units. */
function frameBuffer(mesh,seed) {
  const output=pattern(mesh.frameVertexCount*88,seed);
  const sequence=mesh.sequences[0]?.name??'None';
  const actor={AnimSequence:sequence,AnimFrame:f(0.37),DrawScale:1,Location:[f(2310.5),f(-140.25),f(-27.75)],PrePivot:[0,0,0],
    Rotation:[0,23000,0],bAnimByOwner:false,bParticles:false,Owner:null,BlendAnimSequence:['None','None','None','None'],
    BlendAnimFrame:[0,0,0,0]};
  getLodMeshFrame(mesh,actor,cameraCoords([0,0,48],0.035,-0.02),{cache:createLodMeshFrameCache(),kernel:null,
    read:(a,n)=>a[n],objectIndex:()=>4242},{stride:88,output});
  return output;
}

/** The cases of one mesh. Depths are chosen from the selection (the
 * translation picks inputs; the oracle decides outputs) to land in each
 * regime: full detail without morph, morph at full count, reduced count with
 * morph, the LODMinVerts floor and the behind-camera clamp. */
function meshCases(topology) {
  const cases=[],N=topology.modelVerts;
  const base={settings:{...RENDER_LOD_SETTINGS},lodBias:1,drawScale:1,fov:75,fx:1440,coords:[0,0,0,0,1,0,0,0,1,1,0,0],
    location:[0,0,0]};
  const add=(name,options)=>{
    const c={...base,...options,settings:{...base.settings,...options.settings}};
    const tanFactor=lodMeshTanFactor(c.fov);
    c.tanBits={[doubleHex(lodMeshTanArgument(c.fov))]:floatBits(tanFactor)};
    c.selection=selectLodMesh({...topology,...(c.noCollapse?{collapseCount:0}:{}),...(c.meshOverride??{})},c.settings,
      {location:c.location,drawScale:c.drawScale,lodBias:c.lodBias},c.coords,{fx:c.fx,tanFactor});
    cases.push({name,...c});
  };
  // Depth k·K gives ratio 1/k: K is where the request first drops below N.
  const probe=selectLodMesh(topology,base.settings,{location:[1,0,0],drawScale:1,lodBias:1},base.coords,{fx:1440,tanFactor:lodMeshTanFactor(75)});
  const K=probe.detail/N;
  const at=(scale,extra={})=>({location:[f(K*scale),f(K*scale*0.031),f(-K*scale*0.017)],...extra});
  // Morphing starts once (1 - LODMorph)·detail drops below the count, the
  // count once the ratio drops below 1.
  for(const [name,scale] of [['near',0.05],['full-no-morph',0.5],['morph-edge',0.7],['morph-full-count',0.85],
    ['reduced-edge',1.0],['reduced-morph',1.7],['reduced-far',3.1],['reduced-very-far',9.5],['min-verts',400]])add(name,at(scale));
  add('behind-camera',{location:[f(-K*0.8),f(37.5),f(12.25)]});
  add('fov-90',at(1.6,{fov:90}));add('fov-60',at(1.6,{fov:60}));add('fov-120',at(1.6,{fov:120}));
  add('fov-fraction',at(1.6,{fov:f(74.99874)}));
  for(const fx of [640,800,1024,1920])add(`width-${fx}`,at(1.6,{fx}));
  add('lodbias-half',at(1.6,{lodBias:0.5}));add('lodbias-double',at(1.6,{lodBias:2}));
  add('drawscale-small',at(1.6,{drawScale:f(0.75)}));add('drawscale-large',at(1.6,{drawScale:f(1.3)}));
  add('zdisplace',at(1.6,{meshBits:{0x198:floatBits(f(K*0.4))},meshOverride:{lodZDisplace:f(K*0.4)}}));
  add('no-collapse',at(2.2,{noCollapse:true}));
  add('strength-zero',at(2.2,{meshBits:{0x18c:0},meshOverride:{lodStrengthBits:0,lodStrength:0}}));
  add('strength-negative-zero',at(2.2,{meshBits:{0x18c:0x80000000},meshOverride:{lodStrengthBits:0x80000000,lodStrength:-0}}));
  add('morph-zero',at(2.2,{meshBits:{0x194:0},meshOverride:{lodMorph:0}}));
  add('min-verts-above-count',at(1.3,{meshBits:{0x190:N+50},meshOverride:{lodMinVerts:N+50}}));
  add('mode-fixed',at(2.2,{settings:{mode:0,fix:f(0.37)}}));add('mode-fixed-zero',at(2.2,{settings:{mode:0,fix:0}}));
  add('mode-no-morph',at(2.2,{settings:{mode:2}}));add('mode-no-fov',at(2.2,{settings:{mode:3}}));
  add('mlod-half',at(2.2,{settings:{shapeLOD:0.5}}));
  add('rotated-coords',{coords:cameraCoords([f(-310.25),f(1720.5),f(96.75)],-1.1,0.08),
    location:[f(-310.25+K*1.9*Math.cos(-1.1)),f(1720.5+K*1.9*Math.sin(-1.1)),f(40)]});
  // GetFrame's tween can return fewer vertices than requested.
  for(const scale of [0.85,1.7,3.1]){
    const c=at(scale),s=selectLodMesh(topology,base.settings,{location:c.location,drawScale:1,lodBias:1},base.coords,{fx:1440,tanFactor:lodMeshTanFactor(75)});
    add(`returned-${scale}`,{...c,returnedCount:Math.max(1,s.requested-7)});
  }
  {
    const c=at(1.7),s=selectLodMesh(topology,base.settings,{location:c.location,drawScale:1,lodBias:1},base.coords,{fx:1440,tanFactor:lodMeshTanFactor(75)});
    // Below the morph start: morphing stops, the reduced faces remain.
    const start=Math.round((1-topology.lodMorph)*s.detail);
    add('returned-below-start',{...c,returnedCount:Math.max(1,Math.min(s.requested,start-2))});
  }
  return cases;
}

/** One mesh's oracle input for cases given as bit patterns (the Play
 * probe's: settings, lodBiasBits, drawScaleBits, locationBits, fovBits,
 * fxBits, coordsBits, tanBits, returnedCount). */
export async function meshOracleSpec(root,pack,exportIndex,cases,{seed=0x5eed1000}={}) {
  // A package in System, or a map's own (myLevel) meshes.
  const file=[`${root}/System/${pack}.u`,`${root}/Maps/${pack}.dx`].find(path=>existsSync(path));
  if(!file)throw new Error(`No package ${pack}`);
  const bytes=await readFile(file),pkg=parsePackage(bytes);
  const mesh=decodeLodMeshPayload(pkg,bytes,exportIndex),topology=lodMeshTopology(mesh);
  const arrays={};
  for(const offset of [0x12c,0x138,0x144,0x150,0x15c,0x168]){
    const array=mesh.arrays.get(offset);
    arrays[offset]={num:array.num,data:Buffer.from(array.data).toString('base64')};
  }
  const scalars={};
  for(let offset=0x180;offset<=0x19c;offset+=4)scalars[offset]=mesh.scalarBits.get(offset)>>>0;
  return {mesh,topology,spec:{name:`${pack}.${pkg.exports[exportIndex-1].name}`,arrays,scalars,frameVerts:mesh.frameVertexCount,
    vertices:Buffer.from(frameBuffer(mesh,seed)).toString('base64'),cases}};
}

/** The validator's samples: per mesh the oracle's input (`spec`) and the
 * translation's inputs (`topology`, `vertices`, `cases`). */
export async function buildLodMeshSamples(root) {
  const packages=new Map(),samples=[];
  for(const [[pack,name],index] of LOD_MESHES.map((entry,i)=>[entry,i])){
    let entry=packages.get(pack);
    if(!entry){const bytes=await readFile(`${root}/System/${pack}.u`);entry={bytes,pkg:parsePackage(bytes)};packages.set(pack,entry);}
    const exportIndex=entry.pkg.exports.findIndex(e=>e.name===name&&e.className==='LodMesh')+1;
    if(!exportIndex)throw new Error(`${pack}.${name} is not an installed LodMesh`);
    const mesh=decodeLodMeshPayload(entry.pkg,entry.bytes,exportIndex),topology=lodMeshTopology(mesh);
    const vertices=frameBuffer(mesh,0x5eed0000+index);
    const arrays={};
    for(const offset of [0x12c,0x138,0x144,0x150,0x15c,0x168]){
      const array=mesh.arrays.get(offset);
      arrays[offset]={num:array.num,data:Buffer.from(array.data).toString('base64')};
    }
    const scalars={};
    for(let offset=0x180;offset<=0x19c;offset+=4)scalars[offset]=mesh.scalarBits.get(offset)>>>0;
    const cases=meshCases(topology);
    const spec={name:`${pack}.${name}`,arrays,scalars,frameVerts:mesh.frameVertexCount,
      vertices:Buffer.from(vertices).toString('base64'),
      cases:cases.map(c=>({name:c.name,settings:c.settings,lodBiasBits:floatBits(c.lodBias),drawScaleBits:floatBits(c.drawScale),
        locationBits:c.location.map(floatBits),fovBits:floatBits(c.fov),fxBits:floatBits(c.fx),coordsBits:c.coords.map(floatBits),
        tanBits:c.tanBits,...(c.returnedCount?{returnedCount:c.returnedCount}:{}),...(c.noCollapse?{noCollapse:true}:{}),
        ...(c.meshBits?{meshBits:c.meshBits}:{})}))};
    samples.push({name:spec.name,mesh,topology,vertices,cases,spec});
  }
  return samples;
}
