/** URender::DrawMesh for a classic UMesh (Render 0x10b0d1a0) against the original: docs/umesh.md.
 *
 * The unchanged DrawMesh and face helper run in the Unicorn oracle (native-umesh-draw-oracle.py)
 * on the game's classic meshes with the camera-space points GetFrame gives for poses in front of
 * several cameras; the light manager's Light/Fog, GetFrame, GetTexture and the render device are
 * stubbed with recorders, so the comparison is of what DrawMesh asks of them and hands to the
 * device: every Light call's vertex, point, normal plane and flags, and every polygon's flags,
 * texture info and corner records (point, outcode, normal, Light, Fog, U, V), in order.
 * ORACLE_CW=0x007f is the render pass's precision control. */
import {execFileSync} from 'node:child_process';
import {auditAssert,auditControlWord} from './precision-audit.mjs';
const assert=auditAssert(),controlWord=auditControlWord();
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {createUMeshFrameCache,getUMeshFrame} from '../src/runtime/umesh-frame.mjs';
import {drawUMesh} from '../src/runtime/umesh-draw.mjs';
import {unlitColor} from '../src/runtime/mesh-lighting.mjs';
import {gameDirectory} from './game-directory.mjs';
import {classicMeshCase} from './umesh-fixture.mjs';

const root=gameDirectory(),f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
const bitsOf=value=>{bits.setFloat32(0,value,true);return bits.getUint32(0,true);};
const lightOf=index=>[(index%97)/128,((index*3)%89)/128,((index*7)%83)/128,index/1024];
const fogOf=index=>[((index*5)%79)/128,((index*11)%73)/128,((index*13)%71)/128,((index*2)%61)/128];
/** A camera: Frame->Coords for a position and yaw/pitch (X right, Y down, Z forward in camera space). */
const look=(origin,yaw,pitch)=>{
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [...origin,-sy,cy,0,sp*cy,sp*sy,-cp,cp*cy,cp*sy,sp].map(f);
};
const uncoordsOf=coords=>[0,1,2].map(j=>[coords[3+j],coords[6+j],coords[9+j]]);
const texture=(extra={})=>({polyFlags:0,uScale:1,vScale:1,uSize:256,vSize:256,...extra});

const meshes={};
for(const [pack,index,name] of [['DeusExDeco',397,'EidosLogo'],['DeusExDeco',407,'IonStormLogo'],['DeusExDeco',408,'DXText'],
  ['DeusExDeco',415,'DXLogo'],['DeusExCharacters',723,'Fly']]) {
  const row=await classicMeshCase(root,pack,index),payload=decodeLodMeshPayload(row.pkg,row.bytes,row.index);
  for(const array of payload.lazyArrays.values())array.load();
  meshes[name]=payload;
}
const actorState=(over={})=>({id:'actor',index:1001,AnimSequence:'All',AnimFrame:0,DrawScale:1,Location:[0,0,0],PrePivot:[0,0,0],
  Rotation:[0,0,0],bAnimByOwner:false,bParticles:false,Owner:null,BlendAnimSequence:['None','None','None','None'],
  BlendAnimFrame:[0,0,0,0],...over});
const cases=[];
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

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-umesh-draw-oracle.py',root,...(controlWord?[controlWord]:[])],{input:JSON.stringify(cases.map(c=>c.spec)),encoding:'utf8',maxBuffer:256*1024*1024}));

const words=values=>values.map(bitsOf);
let drawn=0,lights=0,clipped=0;
for(const [caseIndex,c] of cases.entries()) {
  const original=reference.cases[caseIndex],label=c.name;
  // The Player's Sprite replaces every mesh texture and the environment map (0x10b0de9f..0x10b0dfc0).
  const info=spec=>spec?{...spec,flags:spec.polyFlags}:null;
  const sprite=info(c.sprite),environment=sprite??info(c.environment);
  const uncoords=uncoordsOf(c.coords),unlit=unlitColor(c.ambientGlow,c.scaleGlow);
  assert.deepEqual(words(unlit),original.unlit,`${label} unlit colour`);
  const result=drawUMesh(c.mesh,Float32Array.from(c.spec.points.flat()),{frame:{mirror:c.mirror,prj:c.prj,uncoords},polyFlags:(c.polyFlags|0x4000)>>>0,
    setup:{flags:c.setupFlags},fatness:c.fatness,unlit,textureInfo:sprite?()=>sprite:index=>info(c.textureList[index]),environment,
    light:index=>lightOf(index).map(f),fog:index=>fogOf(index).map(f)});
  // Light calls: vertex, point, plane, flags.
  assert.equal(result.lightCalls.length,original.light.length,`${label} light call count`);
  result.lightCalls.forEach((call,i)=>{
    const want=original.light[i];lights++;
    assert.deepEqual([call.vertex,words(call.point),words(call.plane),call.flags],[want.index,want.point,want.normal,want.flags],`${label} light call ${i}`);
  });
  assert.equal(result.draws.length,original.draws.length,`${label} polygon count`);
  result.draws.forEach((draw,i)=>{
    const want=original.draws[i];drawn++;
    assert.deepEqual([draw.environment?['env']:['tex',draw.texture],draw.flags],[want.info,want.flags],`${label} polygon ${i} info/flags`);
    // The face helper clips a polygon that crosses a side plane (more than three corners, new vertices): the page's GPU
    // clips instead, so only its texture info and flags are compared.
    if(want.count!==3||want.pts.some(pt=>pt.index<0||pt.index>=c.spec.frameVerts)){clipped++;return;}
    draw.pts.forEach((pt,k)=>{
      const w=want.pts[k];
      assert.deepEqual([pt.index,words(pt.point),pt.outcode,words(pt.normal),words(pt.light??[0,0,0,0]),words(pt.fog??[0,0,0,0]),bitsOf(pt.u),bitsOf(pt.v)],
        [w.index,w.point,w.outcode,w.normal,w.light,w.fog,w.u,w.v],`${label} polygon ${i} corner ${k}`);
    });
  });
}
if(assert.enabled)assert.report('validate-umesh-draw');
else console.log(`PASS ${cases.length} complete original DrawMesh calls on the classic meshes: ${lights} Light calls and ${drawn} polygons (${clipped} of them clipped by the face helper, compared by texture and flags only), every other vertex record bit for bit (normals, outcodes, Light, Fog, U, V), polygon order, flags and texture info.`);
