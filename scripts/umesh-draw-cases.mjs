/** The DrawMesh cases of docs/umesh.md (validate-umesh-draw against the original in the Unicorn oracle, validate-umesh-wasm against the Rust
 * kernel): the five classic meshes in front of cameras with mirror, PF_Unlit, volumetric flags, Fatness, other texture sizes and scales, a
 * missing texture, a viewer Sprite and outcode planes. Each case carries the oracle's `spec` and the inputs of the translation. */
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {createUMeshFrameCache,getUMeshFrame} from '../src/runtime/umesh-frame.mjs';
import {gameDirectory} from './game-directory.mjs';
import {classicMeshCase} from './umesh-fixture.mjs';

export const root=gameDirectory(),f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
export const bitsOf=value=>{bits.setFloat32(0,value,true);return bits.getUint32(0,true);};
export const lightOf=index=>[(index%97)/128,((index*3)%89)/128,((index*7)%83)/128,index/1024];
export const fogOf=index=>[((index*5)%79)/128,((index*11)%73)/128,((index*13)%71)/128,((index*2)%61)/128];
/** A camera: Frame->Coords for a position and yaw/pitch (X right, Y down, Z forward in camera space). */
export const look=(origin,yaw,pitch)=>{
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [...origin,-sy,cy,0,sp*cy,sp*sy,-cp,cp*cy,cp*sy,sp].map(f);
};
export const uncoordsOf=coords=>[0,1,2].map(j=>[coords[3+j],coords[6+j],coords[9+j]]);
export const texture=(extra={})=>({polyFlags:0,uScale:1,vScale:1,uSize:256,vSize:256,...extra});

export const meshes={};
for(const [pack,index,name] of [['DeusExDeco',397,'EidosLogo'],['DeusExDeco',407,'IonStormLogo'],['DeusExDeco',408,'DXText'],
  ['DeusExDeco',415,'DXLogo'],['DeusExCharacters',723,'Fly']]) {
  const row=await classicMeshCase(root,pack,index),payload=decodeLodMeshPayload(row.pkg,row.bytes,row.index);
  for(const array of payload.lazyArrays.values())array.load();
  meshes[name]=payload;
}
export const actorState=(over={})=>({id:'actor',index:1001,AnimSequence:'All',AnimFrame:0,DrawScale:1,Location:[0,0,0],PrePivot:[0,0,0],
  Rotation:[0,0,0],bAnimByOwner:false,bParticles:false,Owner:null,BlendAnimSequence:['None','None','None','None'],
  BlendAnimFrame:[0,0,0,0],...over});
export const cases=[];
/** The camera-space points GetFrame (validated separately) gives a mesh posed in front of a camera, as FrameVerts x,y,z floats. */
export function framePoints(meshName,camera,pose={}) {
  const mesh=meshes[meshName];
  const {output}=getUMeshFrame(mesh,actorState(pose),camera,{cache:createUMeshFrameCache(),read:(a,n)=>a[n],objectIndex:a=>a.index});
  return new Float32Array(output.buffer,0,mesh.frameVertexCount*3).slice();
}
/** One DrawMesh call: the points GetFrame (validated separately) gives, the frame and the actor state. */
function addCase(name,meshName,{pose={},camera,mirror=1,prj=[1,1,1,1],polyFlags=0x4000,setupFlags=0,fatness=0x80,scaleGlow=1,ambientGlow=0,
  textures,environment=texture(),sprite=null,ownedByViewer=false,time=12.5}={}) {
  const mesh=meshes[meshName],actor=actorState(pose);
  const {output}=getUMeshFrame(mesh,actor,camera,{cache:createUMeshFrameCache(),read:(a,n)=>a[n],objectIndex:a=>a.index});
  const points=Array.from({length:mesh.frameVertexCount},(_,i)=>Array.from(new Float32Array(output.buffer,i*12,3)));
  const tris=mesh.arrays.get(0x78),connects=mesh.arrays.get(0x9c),links=mesh.arrays.get(0xcc);
  const textureList=textures??Array.from({length:mesh.objectReferences.length},()=>texture());
  const coords=[...camera];
  cases.push({name,mesh,spec:{name,frameVerts:mesh.frameVertexCount,points,
    tris:Buffer.from(tris.data).toString('base64'),connects:Buffer.from(connects.data).toString('base64'),links:Buffer.from(links.data).toString('base64'),
    textureCount:mesh.objectReferences.length,textures:textureList,environment,sprite,ownedByViewer,time,
    actor:{scaleGlow,ambientGlow,fatness},polyFlags,setupFlags,
    frame:{mirror,coords,uncoords:[0,0,0,...uncoordsOf(coords).flat()],prj}},
    textureList,environment,sprite,fatness,polyFlags,setupFlags,mirror,prj,coords,scaleGlow,ambientGlow});
}
// Cameras looking at the origin from the -X side: x forward is the world's... the camera Z axis is `forward`.
const camera=look([-900,0,0],0,0),farCamera=look([-3000,40,25],0.02,0.01),nearCamera=look([-160,10,-6],0.1,0.05);
const placed={Location:[0,0,0],Rotation:[0,16384,0],DrawScale:1};
addCase('dxtext','DXText',{camera,pose:{...placed,DrawScale:8}});
addCase('dxtext-mirror','DXText',{camera,pose:{...placed,DrawScale:8},mirror:-1});
addCase('dxtext-unlit','DXText',{camera,pose:{...placed,DrawScale:8},polyFlags:0x4000|0x400000,ambientGlow:90,scaleGlow:0.75});
addCase('dxtext-volumetric','DXText',{camera,pose:{...placed,DrawScale:8},setupFlags:0x40000000});
addCase('dxtext-fat','DXText',{camera,pose:{...placed,DrawScale:8},fatness:200});
addCase('dxtext-masked-texture','DXText',{camera,pose:{...placed,DrawScale:8},textures:[texture({polyFlags:2,uSize:128,vSize:64,uScale:0.5,vScale:2})]});
addCase('dxtext-no-texture','DXText',{camera,pose:{...placed,DrawScale:8},textures:[null],environment:texture({uSize:64,vSize:64})});
addCase('dxtext-sprite','DXText',{camera,pose:{...placed,DrawScale:8},sprite:texture({uSize:32,vSize:32})});
addCase('dxtext-clipped-planes','DXText',{camera:nearCamera,pose:{...placed,DrawScale:8}});
addCase('eidos-logo-env','EidosLogo',{camera:farCamera,pose:{...placed,DrawScale:12},polyFlags:0x4000|0x10});
addCase('eidos-logo','EidosLogo',{camera:farCamera,pose:{...placed,DrawScale:12}});
addCase('eidos-logo-mirror-unlit','EidosLogo',{camera:farCamera,pose:{...placed,DrawScale:12},mirror:-1,polyFlags:0x4000|0x400000|0x10,ambientGlow:40,scaleGlow:0.5});
addCase('eidos-logo-near','EidosLogo',{camera:nearCamera,pose:{...placed,DrawScale:3}});
addCase('ionstorm-logo','IonStormLogo',{camera:farCamera,pose:{...placed,DrawScale:12},textures:[texture(),texture({polyFlags:2,uSize:128}),texture({uScale:2,vScale:0.5}),texture({uSize:512,vSize:512})]});
addCase('ionstorm-logo-missing-texture','IonStormLogo',{camera:farCamera,pose:{...placed,DrawScale:12},textures:[texture(),null,texture(),texture()]});
addCase('dxlogo-env','DXLogo',{camera:farCamera,pose:{...placed,DrawScale:12}});
addCase('dxlogo-fat-unlit','DXLogo',{camera:farCamera,pose:{...placed,DrawScale:12},fatness:60,polyFlags:0x4000|0x400000});
addCase('fly','Fly',{camera:nearCamera,pose:{Location:[0,0,0],Rotation:[0,32768,0],DrawScale:6}});
addCase('fly-mirror','Fly',{camera:nearCamera,pose:{Location:[0,0,0],Rotation:[0,32768,0],DrawScale:6},mirror:-1});
addCase('fly-behind','Fly',{camera:look([300,0,0],0,0),pose:{Location:[0,0,0],Rotation:[0,32768,0],DrawScale:6}});
addCase('fly-unlit','Fly',{camera:nearCamera,pose:{Location:[0,0,0],Rotation:[0,5000,0],DrawScale:6},polyFlags:0x4000|0x400000,ambientGlow:200,scaleGlow:2});
addCase('fly-no-outcodes','Fly',{camera:nearCamera,pose:{Location:[0,0,0],Rotation:[0,5000,0],DrawScale:6},prj:[1e9,1e9,1e9,1e9]});

