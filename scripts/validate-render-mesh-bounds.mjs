/** Complete original mesh bounds and null-span perspective rejection. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {meshRenderBoundingBox,perspectiveBoundVisible,buildBoundsSceneFrame} from '../src/runtime/render-mesh-bounds.mjs';
const io=new DataView(new ArrayBuffer(8)),bits=v=>(io.setFloat32(0,v,true),io.getUint32(0,true));
const box=(min,max)=>({min,max,valid:true});
const base={box:box([-7,-9,-11],[13,17,19]),boxes:[
  box([-1,-2,-3],[2,3,4]),box([-4,-5,-6],[7,8,9]),box([-10,-11,-12],[13,14,15]),box([-16,-17,-18],[19,20,21])],
  sequences:[{name:1,startFrame:1,numFrames:3}],scale:[1,1,1],origin:[0,0,0],rotation:[0,0,0],
  actor:{sequence:0,frame:0,drawScale:1,particles:false,location:[0,0,0],rotation:[0,0,0],prePivot:[0,0,0]}};
const meshBounds=[base,...[-.2,0,.125,1/3,.5,.75,1,2].map(frame=>({...base,actor:{...base.actor,sequence:1,frame}})),
  {...base,exact:true},
  {...base,actor:{...base.actor,drawScale:4,particles:true}},
  {...base,actor:{...base.actor,drawScale:-.25}},
  {...base,scale:[.17,2.3,-.8],origin:[11.25,-17.5,2.125],rotation:[500,9876,-12345],
    actor:{...base.actor,drawScale:1.7,location:[1000.125,-1024.5,57.3],rotation:[13579,-23645,32001],prePivot:[.25,-3.5,17]}},
  ...[[0,16384,0],[16384,0,0],[0,0,16384],[-2147483648,2147483647,-1]].map(rotation=>
    ({...base,actor:{...base.actor,location:[1e4,-2000,600],rotation,prePivot:[11,22,33]}})),
];
const sceneFrames=[{location:[0,0,0],rotation:[0,0,0],width:640,height:480,fov:90},
  {location:[1000.125,-1024.5,57.3],rotation:[13579,-23645,32001],width:1440,height:839,fov:75},
  {location:[-0,0,0],rotation:[0,0,0],width:1,height:1,fov:90}];
// Existing real-x87 qword captures: docs/script-window-scene-frame.md.
const tangents={'3fe921fb54442d18':'3fefffffffffffff','3fe4f1a6c638d03f':'3fe88df153d6a676'};
const frames=sceneFrames.map(buildBoundsSceneFrame),b=box;
const bounds=[
  b([-1,-2,-3],[4,5,6]),b([10,-2,-3],[20,5,6]),b([-20,-2,-3],[-10,5,6]),
  ...[[100,0,0],[100,-1000,0],[100,1000,0],[100,0,-1000],[100,0,1000],
    [100,-100,0],[100,100,0],[100,0,-75],[100,0,75],[1000,.5,.5],[10000,2,2],
    [0,5,5],[1e-20,0,0]].map(v=>b(v.map(n=>n-1),v.map(n=>n+1))),
  b([100,0,0],[100,0,0]),b([100,-.1,-.1],[100,.1,.1]),
];
const boundVisible=bounds.map(box=>({box,frame:frames[0]}));
for(const box of [b([1100,-1200,0],[1400,-900,500]),b([500,-1600,-500],[1500,-500,1000]),
  b([-2000,-1600,-500],[0,-500,1000])])boundVisible.push({box,frame:frames[1]});
boundVisible.push({box:b([10,-2,-3],[20,5,6]),frame:frames[2]});
// Rotated screen axes allow a box on the view plane through outcode AND.
// A later -0 must not replace the initial +0; retained tiny negative depth
// must replace it even though the point's float store also equals zero.
const diagonal=Math.fround(Math.SQRT1_2);
for(const tiny of [-0,-(2**-149)]) {
  const frame={...frames[0],coords:[0,0,0,0,diagonal,diagonal,0,diagonal,-diagonal,-1,-0,tiny]};
  frame.coordsBits=frame.coords.map(bits);
  boundVisible.push({box:b([0,.0625,-.25],[0,.125,.25]),frame});
}
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-render-visibility-oracle.py',gameDirectory()],
  {input:JSON.stringify({meshBounds,boundVisible,sceneFrames,tangents}),encoding:'utf8'}));
meshBounds.forEach((sample,i)=>{
  const result=meshRenderBoundingBox(sample,sample.actor);
  assert.deepEqual([...result.min,...result.max].map(bits),native.meshBounds[i].bits,`mesh bounds ${i}`);
  assert.equal(Number(result.valid),native.meshBounds[i].valid);
});
// Core's already recovered FName boundary interns these ASCII spellings as
// the same numeric id. Compare both string adapters to that original lookup.
for(const sequence of ['Move','move']) {
  const result=meshRenderBoundingBox({...base,sequences:[{...base.sequences[0],name:'Move'}]},
    {...base.actor,sequence,frame:0});
  assert.deepEqual([...result.min,...result.max].map(bits),native.meshBounds[2].bits,`FName ${sequence}`);
}
sceneFrames.forEach((sample,i)=>{
  assert.deepEqual(frames[i].coords.map(bits),native.sceneFrames[i].coordsBits,`frame coords ${i}`);
  assert.deepEqual(frames[i].clip.map(bits),native.sceneFrames[i].clipBits,`frame outcode coefficients ${i}`);
});
boundVisible.forEach((sample,i)=>{
  const result=perspectiveBoundVisible(sample.box,sample.frame),expected=native.boundVisible[i];
  assert.equal(result.visible,expected.visible,`bound visibility ${i}`);
  if(result.visible)assert.deepEqual(result.screen.map(bits),expected.bits,`screen rectangle ${i}`);
});
assert.throws(()=>perspectiveBoundVisible(b([NaN,0,0],[1,1,1]),frames[0]),/Nonfinite/);
console.log(`${meshBounds.length} original mesh boxes, ${boundVisible.length} perspective screen bounds and ${sceneFrames.length} frame producers match every returned float32 bit.`);
