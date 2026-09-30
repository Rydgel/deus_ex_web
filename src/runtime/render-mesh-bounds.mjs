/** Original UMesh.GetRenderBoundingBox and perspective BoundVisible.
 * Evidence: docs/render-visibility.md. These standalone helpers do not
 * implement BSP visibility, render iterators or render-time feedback.
 */
import {rotatorSin} from './coords.mjs';
import {buildWindowSceneFrame} from './script-window-scene-frame.mjs';
import {x87load as X,x87store as S,x87add as A,x87neg as N,x87mul as M,
  x87div as D,x87int32 as I,x87cmp as C} from './script-vm.mjs';
import {exactSum,unambiguousF32,ulps53} from './x87-fast.mjs';
const f=Math.fround,B=(a,b)=>A(a,N(b)),identity=()=>[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const dot=(v,row)=>S(A(A(M(v[0],X(row[0])),M(v[1],X(row[1]))),M(v[2],X(row[2]))));
// Native GetAnimSeq compares interned FName ids. Raw authored strings use
// the recovered C-locale ASCII folding/terminator contract (script-names.md).
const nameKey=value=>typeof value==='string'?value.split('\0',1)[0].replace(/[a-z]/g,c=>c.toUpperCase()):value;

function nearestInteger(value) {
  if(!Number.isFinite(value)||value < -2147483648||value > 2147483647)return -2147483648;
  const low=Math.floor(value),part=value-low;
  return part<.5?low:part>.5?low+1:low%2===0?low:low+1;
}
function rotateInverse(coords,rotation) {
  const [pitch,yaw,roll]=rotation,s=rotatorSin,c=angle=>s((angle+0x4000)|0);
  for(const rows of [
    [[1,0,0],[0,c(roll),s(roll)],[0,-s(roll),c(roll)]],
    [[c(pitch),0,-s(pitch)],[0,1,0],[s(pitch),0,c(pitch)]],
    [[c(yaw),-s(yaw),0],[s(yaw),c(yaw),0],[0,0,1]],
  ])coords=coords.map(v=>rows.map(row=>dot(v.map(X),row)));
  return coords;
}

/** Mesh fields: box, boxes, sequences {name,startFrame,numFrames}, scale,
 * origin and rotation. Names accept canonical numeric ids or raw strings.
 * Actor fields use the normalized oracle vocabulary.
 * Exact is intentionally absent: the original body does not inspect it. */
export function meshRenderBoundingBox(mesh,actor) {
  const frame=f(actor.frame),key=nameKey(actor.sequence),sequence=mesh.sequences.find(s=>nameKey(s.name)===key);
  let box=mesh.box;
  if(sequence&&frame>=0) {
    const count=sequence.numFrames,phase=S(M(A(X(frame),X(1)),I(count)));
    const integer=nearestInteger(phase-.5);
    if(count<=0||integer<0)throw new Error('Original mesh bounds frame index is outside the supported domain');
    const first=mesh.boxes[sequence.startFrame+integer%count];
    const next=mesh.boxes[sequence.startFrame+((integer+1)|0)%count];
    if(!first||!next)throw new Error('Original mesh bounds access a missing stored frame box');
    box=!first.valid?next:!next.valid?first:{
      min:first.min.map((v,i)=>Math.min(v,next.min[i])),max:first.max.map((v,i)=>Math.max(v,next.max[i])),valid:true};
  }
  const factor=actor.particles?1.5:f(actor.drawScale),scale=mesh.scale.map(v=>S(M(X(v),X(factor))));
  const min=box.min.map((v,i)=>f(S(M(X(S(B(X(v),X(mesh.origin[i])))),X(scale[i])))-1));
  const max=box.max.map((v,i)=>f((i===2
    ? S(M(B(X(v),X(mesh.origin[i])),M(X(mesh.scale[i]),X(factor))))
    : S(M(X(S(B(X(v),X(mesh.origin[i])))),X(scale[i]))))+1));
  let coords=rotateInverse(rotateInverse(identity(),mesh.rotation),actor.rotation);
  coords[0]=actor.location.map((v,i)=>S(A(X(v),X(actor.prePivot[i]))));
  const axes=coords.slice(1),origin=axes.map(row=>-dot(coords[0].map(X),row));
  const rows=[0,1,2].map(i=>axes.map(row=>row[i]));
  const result={min:null,max:null,valid:true};
  for(let x=0;x<2;x++)for(let y=0;y<2;y++)for(let z=0;z<2;z++) {
    const point=[x?max[0]:min[0],y?max[1]:min[1],z?max[2]:min[2]];
    const local=point.map((v,i)=>B(X(v),X(origin[i]))),p=rows.map(row=>dot(local,row));
    if(!result.min){result.min=p;result.max=p.slice();}
    else for(let i=0;i<3;i++){if(p[i]<result.min[i])result.min[i]=p[i];if(p[i]>result.max[i])result.max[i]=p[i];}
  }
  return result;
}

/** Additional ComputeRenderSize fields consumed by BoundVisible. */
export function buildBoundsSceneFrame(input) {
  const frame=buildWindowSceneFrame(input),reciprocal=X(S(D(X(1),X(frame.projectionZ))));
  return {...frame,clip:[S(M(X(frame.center[0]),reciprocal)),S(M(X(frame.center[1]),reciprocal)),
    S(M(B(X(frame.width),X(frame.center[0])),reciprocal)),S(M(B(X(frame.height),X(frame.center[1])),reciprocal))]};
}

// Raw products of two f32 operands are exact doubles. Preserve their full
// value if a rare uncertain sum needs the exact x87 path.
const bits=new DataView(new ArrayBuffer(8));
function extended(value) {
  if(!Number.isFinite(value))return X(value);
  bits.setFloat64(0,value,true);const word=bits.getBigUint64(0,true),exponent=Number(word>>52n&2047n),fraction=word&((1n<<52n)-1n);
  return {neg:Number(word>>63n),sig:exponent?fraction|(1n<<52n):fraction,exp:exponent?exponent-1075:-1074};
}
const extendedSum=(a,b,c)=>c===undefined?A(extended(a),extended(b)):A(A(extended(a),extended(b)),extended(c));
function sum(a,b,c) {
  const first=a+b,value=c===undefined?first:first+c;
  if(exactSum(a,b,first)&&(c===undefined||exactSum(first,c,value)))return f(value);
  return unambiguousF32(value,(Math.abs(a)+Math.abs(b)+(c===undefined?0:Math.abs(c)))*ulps53(8))
    ?? S(extendedSum(a,b,c));
}

/** Exact original corner stores, including retained products in the x87
 * stack and the partial stores used for the last two corners. */
function corners(box,coords) {
  const lo=box.min.map((v,i)=>f(f(v)-coords[i])),hi=box.max.map((v,i)=>f(f(v)-coords[i]));
  const raw=[lo,hi].map(v=>[0,1,2].map(row=>v.map((n,i)=>n*coords[3+row*3+i])));
  const p=raw.map(v=>v.map(row=>row.map(f))),a=p[0],b=p[1],r=raw[0],s=raw[1];
  const depthTerms=[
    [r[2][0],a[2][1],a[2][2]],[b[2][0],a[2][1],a[2][2]],
    [s[2][1],r[2][0],a[2][2]],[b[2][0],s[2][1],a[2][2]],
    [s[2][2],r[2][0],a[2][1]],[b[2][0],s[2][2],a[2][1]],
    [r[2][0],sum(s[2][1],s[2][2])],[b[2][0],sum(s[2][1],s[2][2])],
  ];
  return {lo,hi,depthTerms,behind:[r[2][0],a[2][1],a[2][2],b[2][0],s[2][1],s[2][2]].every(v=>v<0),points:[
    [sum(a[0][0],r[0][1],a[0][2]),sum(a[1][0],a[1][1],a[1][2]),sum(r[2][0],a[2][1],a[2][2])],
    [sum(b[0][0],r[0][1],a[0][2]),sum(b[1][0],a[1][1],a[1][2]),sum(b[2][0],a[2][1],a[2][2])],
    [sum(b[0][1],a[0][0],a[0][2]),sum(b[1][1],a[1][0],a[1][2]),sum(s[2][1],r[2][0],a[2][2])],
    [sum(b[0][0],b[0][1],a[0][2]),sum(b[1][0],b[1][1],a[1][2]),sum(b[2][0],s[2][1],a[2][2])],
    [sum(b[0][2],a[0][0],r[0][1]),sum(b[1][2],a[1][0],a[1][1]),sum(s[2][2],r[2][0],a[2][1])],
    [sum(b[0][0],b[0][2],r[0][1]),sum(b[1][0],b[1][2],a[1][1]),sum(b[2][0],s[2][2],a[2][1])],
    [sum(a[0][0],sum(b[0][1],b[0][2])),sum(b[1][1],b[1][2],a[1][0]),sum(r[2][0],sum(s[2][1],s[2][2]))],
    [sum(b[0][0],sum(b[0][1],b[0][2])),sum(b[1][1],b[1][2],b[1][0]),sum(b[2][0],sum(s[2][1],s[2][2]))],
  ]};
}
function project(point,frame) {
  const [x,y,z]=point,q=frame.projectionZ/z;
  const retained=()=>D(X(frame.projectionZ),X(z));
  const scale=unambiguousF32(q,Math.abs(q)*ulps53(4))??S(retained());
  const value=q*x+frame.center[0];
  const sx=unambiguousF32(value,(Math.abs(q*x)+Math.abs(frame.center[0]))*ulps53(16))
    ??S(A(M(retained(),X(x)),X(frame.center[0])));
  const sy=sum(scale*y,frame.center[1]);
  return [nearestInteger(sx-.5),nearestInteger(sy-.5)];
}

/** Perspective BoundVisible with its original null SpanBuffer argument.
 * Passing this still requires Setup's Y1<Y2 check, then BSP/span filtering.
 * Finite, valid original map boxes and a measured perspective frame only. */
export function perspectiveBoundVisible(box,frame) {
  for(const values of [box.min,box.max,frame.coords,frame.clip,frame.center,[frame.width,frame.height,frame.projectionZ]])
    if(!values.every(Number.isFinite))throw new Error('Nonfinite perspective bounds are unsupported');
  const {lo,hi,behind,points,depthTerms}=corners(box,frame.coords);
  if(lo.every((v,i)=>v<=0&&hi[i]>=0))return {visible:true,screen:[0,0,frame.width,frame.height,0]};
  if(behind)return {visible:false};
  let and=15,or=0,minZ=points[0][2];
  for(let i=0;i<points.length;i++) {
    const [x,y,z]=points[i];
    if(!points[i].every(Number.isFinite))throw new Error('Nonfinite transformed bounds are unsupported');
    const code=(z*frame.clip[0]+x<0?1:0)|(z*frame.clip[2]-x<0?2:0)|
      (z*frame.clip[1]+y<0?4:0)|(z*frame.clip[3]-y<0?8:0);
    and&=code;or|=code;
    // Native FST keeps the unrounded depth for this comparison. Equal
    // nonzero stores cannot change bits; at zero, a tiny negative retained
    // value can replace +0 with -0, whereas a retained -0 itself cannot.
    if(z<minZ||(i>0&&z===0&&minZ===0&&C(extendedSum(...depthTerms[i]),X(minZ))==='lt'))minZ=z;
  }
  if(and)return {visible:false};
  const first=project(points[0],frame);
  let x1=or&1?0:first[0],x2=or&2?frame.width:first[0],y1=or&4?0:first[1],y2=or&8?frame.height:first[1];
  // Native ecx starts at corner0; seven loop iterations repeat corner0 and
  // end at corner6. Corner7 contributes outcodes/depth, not this rectangle.
  for(let i=0;i<7;i++) {
    const [x,y]=project(points[i],frame);
    if(x<x1)x1=x;else if(x>x2)x2=x;
    if(y<y1)y1=y;else if(y>y2)y2=y;
  }
  return {visible:true,screen:[Math.max(x1,0),Math.max(y1,0),Math.min(x2,frame.width),Math.min(y2,frame.height),minZ<0?0:minZ]};
}
