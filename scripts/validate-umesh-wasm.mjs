/** The Rust kernel's classic-UMesh DrawMesh (native/lodmesh-kernel/src/umesh.rs, docs/umesh.md "In Play") against the JavaScript
 * translation (umesh-draw.mjs drawUMesh with packUMeshDraw), word for word.
 *
 * The JavaScript translation equals the unchanged original in the Unicorn oracle (validate-umesh-draw: every Light call and every
 * polygon the device is handed); this runs the same 22 oracle cases, with the light manager's real Light and a set of lights in
 * place of the oracle's stub, through both, then 600 seeded random calls on the five meshes (cameras, mirror, outcode planes,
 * PF_Unlit / PF_Modulated / PF_Environment / two-sided flags, SetupForActor flag bits, Fatness, texture sizes and scales, missing
 * textures, no environment map). Compared: the colours per triangle corner, the environment UVs, the points (Fatness moves them),
 * each vertex's normal plane and final Light, and the counts of kept and drawn triangles; a call the reference throws on must make
 * the kernel report the same error. Precision control 24 throughout (docs/render-pass-precision.md). */
import {loadLodMeshKernel} from '../src/runtime/lodmesh-wasm.mjs';
import {drawUMesh,packUMeshDraw,umeshTopology} from '../src/runtime/umesh-draw.mjs';
import {lightVertex,unlitColor} from '../src/runtime/mesh-lighting.mjs';
import {UMESH_STATUS} from '../src/runtime/umesh-wasm.mjs';
import {cases,meshes,f,bitsOf,look,texture,uncoordsOf,framePoints} from './umesh-draw-cases.mjs';

const kernel=await loadLodMeshKernel();
if(!kernel.umesh)throw new Error('The kernel has no umesh_draw (npm run build:wasm)');
let checks=0,failures=[];
const coverage={calls:0,errors:0,outside:0,drawn:0,drawnTriangles:0,environmentDraws:0,unlitCalls:0,modulatedCalls:0,fatCalls:0,mirrorCalls:0,lightedVertices:0};
const fail=message=>{if(failures.length<12)failures.push(message);};
const sameWords=(label,a,b)=>{
  if(!a||!b){checks++;if(a!==b)fail(`${label}: ${a} vs ${b}`);return;}
  checks+=a.length;
  if(a.length!==b.length){fail(`${label}: length ${a.length} vs ${b.length}`);return;}
  for(let i=0;i<a.length;i++)if(bitsOf(a[i])!==bitsOf(b[i])){fail(`${label}: word ${i} kernel ${a[i]} reference ${b[i]}`);return;}
};
const same=(label,a,b)=>{checks++;if(a!==b)fail(`${label}: kernel ${a} reference ${b}`);};

let seed=0x9e3779b9;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const between=(low,high)=>low+(high-low)*random();
const pick=list=>list[Math.floor(random()*list.length)];

/** SetupForActor's result for the call: ambient, ScaleGlow, the flag bits and `count` lights placed around the points (camera space). */
function makeSetup(points,count,flags) {
  const centre=[0,0,0],vertices=points.length/3;
  for(let i=0;i<vertices;i++)for(let k=0;k<3;k++)centre[k]+=points[i*3+k]/vertices;
  const lights=Array.from({length:count},()=>({location:centre.map(c=>f(c+between(-600,600))),rradius:f(1/between(250,2500)),
    color:[f(between(0,1)),f(between(0,1)),f(between(0,1))]}));
  return {flags,ambient:[f(between(0,0.4)),f(between(0,0.4)),f(between(0,0.4))],scaleGlow:f(pick([1,1,0.75,2,0.1,1.375])),lights};
}

/** One call through both, compared. */
function compare(label,mesh,points,{frame,polyFlags,setup,fatness=0x80,unlit,textures,environment,snapshots=false}) {
  const topology=umeshTopology(mesh),hasEnvironment=topology.triangles.some(tri=>tri.flags&0x10);
  const light=(index,point,plane,flags)=>[...lightVertex(setup,point,plane,flags),0];
  let reference=null,referenceError=null;
  try {
    const result=drawUMesh(mesh,points,{frame,polyFlags,setup,fatness,unlit,textureInfo:index=>textures[index]??null,environment,light,snapshots:true});
    reference={result,...packUMeshDraw(result,topology.triangles,hasEnvironment)};
  } catch(error) {referenceError=error.message;}
  const out=kernel.umesh.draw(mesh,points,{frame,polyFlags,setupFlags:setup.flags,fatness,unlit,ambient:setup.ambient,scaleGlow:setup.scaleGlow,
    lights:setup.lights,textures,environment,envOutput:hasEnvironment,diagnostics:true});
  coverage.calls++;
  if(referenceError!==null) {
    coverage.errors++;
    same(`${label} error`,out.status,UMESH_STATUS.noEnvironment);
    same(`${label} error text`,referenceError,'DrawMesh has no environment map to draw with');
    return;
  }
  same(`${label} status`,out.status,UMESH_STATUS.ok);
  if(out.status!==UMESH_STATUS.ok)return;
  const {result}=reference;
  same(`${label} allOutside`,out.allOutside,result.allOutside);
  if(result.allOutside){coverage.outside++;return;}
  same(`${label} kept`,out.kept,result.visible.length);
  same(`${label} drawn`,out.drawn,result.draws.length);
  if(result.draws.length){coverage.drawn++;coverage.drawnTriangles+=result.draws.length;}
  coverage.environmentDraws+=result.draws.filter(draw=>draw.flags&0x10).length;
  if(polyFlags&0x400000||result.draws.some(draw=>draw.flags&0x400000))coverage.unlitCalls++;
  if(result.draws.some(draw=>draw.flags&0x40))coverage.modulatedCalls++;
  if(fatness!==0x80)coverage.fatCalls++;
  if(frame.mirror===-1)coverage.mirrorCalls++;
  coverage.lightedVertices+=result.vertexLight.filter(Boolean).length;
  sameWords(`${label} colors`,out.colors,reference.colors);
  sameWords(`${label} envUv`,out.envUv,reference.envUv);
  sameWords(`${label} points`,out.points,result.points);
  // The planes Light was called with, and the final Light of every vertex that was lit.
  const planes=new Float32Array(points.length/3*4);
  for(const call of result.lightCalls)planes.set(call.plane,call.vertex*4);
  sameWords(`${label} planes`,out.planes,planes);
  const lit=new Float32Array(points.length);
  result.vertexLight.forEach((value,vertex)=>{if(value)lit.set(value.slice(0,3),vertex*3);});
  sameWords(`${label} vertex light`,out.vertexLight,lit);
}

// 1. The oracle cases.
let calls=0;
for(const c of cases) {
  const info=spec=>spec?{uSize:spec.uSize,vSize:spec.vSize,uScale:spec.uScale,vScale:spec.vScale,flags:spec.polyFlags}:null;
  const sprite=info(c.sprite),environment=sprite??info(c.environment),topology=umeshTopology(c.mesh);
  const textures=Array.from({length:topology.textureCount},(_,index)=>sprite??info(c.textureList[index]));
  const points=Float32Array.from(c.spec.points.flat());
  for(const lightCount of [0,3,8]) {
    const setup=makeSetup(points,lightCount,c.setupFlags);
    setup.scaleGlow=f(c.scaleGlow);
    compare(`${c.name} lights ${lightCount}`,c.mesh,points,{frame:{mirror:c.mirror,prj:c.prj,uncoords:uncoordsOf(c.coords)},
      polyFlags:(c.polyFlags|0x4000)>>>0,setup,fatness:c.fatness,unlit:unlitColor(c.ambientGlow,c.scaleGlow),textures,environment});
    calls++;
  }
}

// 2. Seeded random calls.
const names=Object.keys(meshes);
for(let n=0;n<600;n++) {
  const name=n<5*40?names[n%5]:pick(names),mesh=meshes[name],topology=umeshTopology(mesh);
  // One call in five is tiny (the faces' squared normals fall to the size of DrawMesh's 0.001, which is a double: a float epsilon would differ).
  const tiny=random()<0.2,distance=tiny?between(0.5,40):between(120,4000),yaw=between(-3.1,3.1),pitch=between(-0.4,0.4);
  const eye=[Math.cos(yaw)*distance,Math.sin(yaw)*distance,between(-200,200)];
  const aim=Math.atan2(-eye[1],-eye[0])+between(-0.25,0.25),camera=look(eye,aim,pitch+between(-0.15,0.15));
  const pose={Location:[0,0,0],Rotation:[0,Math.floor(between(0,65536)),0],DrawScale:f(tiny?between(0.002,0.03):between(2,16))};
  const points=framePoints(name,camera,pose);
  const mirror=random()<0.25?-1:1;
  let polyFlags=0x4000;
  if(random()<0.3)polyFlags|=0x10;
  if(random()<0.2)polyFlags|=0x400000;
  if(random()<0.1)polyFlags|=0x40;
  if(random()<0.1)polyFlags|=0x100;
  if(random()<0.1)polyFlags|=0x2;
  const setupFlags=random()<0.2?0x40000000:0;
  const setup=makeSetup(points,Math.floor(between(0,10)),setupFlags);
  const info=()=>random()<0.15?null:{uSize:pick([32,64,128,256,512]),vSize:pick([32,64,128,256,512]),uScale:pick([0.25,0.5,1,1,2]),vScale:pick([0.25,0.5,1,1,2]),
    flags:random()<0.15?2:0};
  const textures=Array.from({length:topology.textureCount},info);
  const environment=random()<0.92?info()??texture():null;
  const prj=random()<0.8?[f(between(0.4,1.6)),f(between(0.4,1.6)),f(between(0.4,1.6)),f(between(0.4,1.6))]:null;
  compare(`random ${n} ${name}`,mesh,points,{frame:{mirror,prj,uncoords:uncoordsOf(camera)},polyFlags,setup,fatness:random()<0.25?Math.floor(between(0,256)):0x80,
    unlit:unlitColor(Math.floor(between(0,256)),f(between(0,2))),textures,environment});
  calls++;
}

if(failures.length) {
  console.error(`FAIL ${failures.length}+ of ${checks} checks:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(JSON.stringify(coverage));
console.log(`PASS ${calls} DrawMesh calls (22 oracle cases at 0, 3 and 8 lights and 600 seeded random ones) through the Rust kernel and the JavaScript reference: ${checks} word comparisons (colours, environment UVs, points, normal planes, Light, kept and drawn counts) equal.`);
