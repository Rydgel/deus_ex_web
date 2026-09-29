// Source-derived UModel nonzero-extent branch. See docs/extent-trace.md.
import {traceKernel,TRACE_DIFFERENTIAL,checkTraceKernel} from './trace-kernel.mjs';
const f=Math.fround;
const dot=(a,b)=>a[2]*b[2]+a[1]*b[1]+a[0]*b[0];
const xyz=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[f(a[1]*b[2]-a[2]*b[1]),f(a[2]*b[0]-a[0]*b[2]),f(a[0]*b[1]-a[1]*b[0])];
const normalized=v=>{const inverse=1/Math.sqrt(xyz(v,v));return v.map(n=>f(n*inverse));};
const support=(p,e)=>Math.abs(p[2]*e[2])+Math.abs(p[1]*e[1])+Math.abs(p[0]*e[0]);
const view=new DataView(new ArrayBuffer(4));
// Support103f6590 sums Z/Y then X with a 64-bit x87 significand.
// Only a double exactly at a float32 midpoint can lose the deciding low bits.
export function storedSupport(p,e){
 const value=support(p,e),stored=f(value);
 if(value===stored||Math.abs(value-stored)!==2**(Math.floor(Math.log2(value))-24))return stored;
 const binary=v=>{view.setFloat32(0,Math.abs(v),true);const w=view.getUint32(0,true),ex=(w>>>23)&255;return {n:BigInt((w&0x7fffff)|(ex?0x800000:0)),e:ex?ex-150:-149};};
 const round=(a,bits)=>{const shift=a.n.toString(2).length-bits;if(shift<=0)return a;const k=BigInt(shift),unit=1n<<k,half=unit>>1n;let n=a.n>>k;const r=a.n&(unit-1n);if(r>half||(r===half&&(n&1n)))n++;return {n,e:a.e+shift};};
 const add=(a,b)=>{const ex=Math.min(a.e,b.e);return round({n:(a.n<<BigInt(a.e-ex))+(b.n<<BigInt(b.e-ex)),e:ex},64);};
 const products=p.slice(0,3).map((v,i)=>{const a=binary(v),b=binary(e[i]);return {n:a.n*b.n,e:a.e+b.e};});
 const result=round(add(add(products[2],products[1]),products[0]),24);
 return f(Number(result.n)*2**result.e);
}
function asFloat(v){view.setInt32(0,v,true);return view.getFloat32(0,true);}
function vector(v,label){if(!v||v.length!==3||!v.every(Number.isFinite))throw Error(`Invalid ${label}`);return v.map(f);}
function intersect(a,b){
 const direction=cross(a,b),square=xyz(direction,direction);
 if(square<1e-6)return {point:[0,0,0],direction:[0,0,0]};
 const first=cross(direction,a),second=cross(b,direction),inverse=f(1/square);
 const point=first.map((v,i)=>f((i===2?v*b[3]+second[i]*a[3]:f(f(v*b[3])+f(second[i]*a[3])))*inverse));
 return {point,direction:normalized(direction)};
}

/** Returns native hit order/rounding for nonzero upright box extents.
 * Optional coordinates are original ABrush.ToWorld's12 floats, not ToLocal.
 * Once the Rust trace kernel is loaded (trace-kernel.mjs) it answers;
 * traceExtentJs answers before that and every case the kernel hands back.
 * TRACE_DIFFERENTIAL=1 checks each kernel answer against traceExtentJs. */
export function traceExtent(model,start,end,extent,ownerCoords=null){
 const result=traceKernel===null?undefined:traceKernel.extent(model,start,end,extent,ownerCoords);
 if(result===undefined)return traceExtentJs(model,start,end,extent,ownerCoords);
 if(TRACE_DIFFERENTIAL)checkTraceKernel('traceExtent',result,()=>traceExtentJs(model,start,end,extent,ownerCoords),{start,end,extent,ownerCoords});
 return result;
}

/** The JavaScript reference the Rust kernel transcribes. */
export function traceExtentJs(model,start,end,extent,ownerCoords=null){
 start=vector(start,'start');end=vector(end,'end');extent=vector(extent,'extent');
 if(extent.every(v=>v===0))throw Error('Zero extent requires the original traceRay branch');
 if(extent.some(v=>v<0))throw Error('Negative extents are unsupported');
 if(model.rootOutside===undefined)throw Error('Extent traversal requires compiled BSP root');
 const nodes=model.nodes;if(!nodes.length){if(model.rootOutside)return null;throw Error('Empty solid model has no evidenced hit geometry');}
 const rows=ownerCoords&&[ownerCoords.slice(3,6),ownerCoords.slice(6,9),ownerCoords.slice(9,12)];
 const origin=rows&&rows.map(row=>f(xyz(ownerCoords,row)));
 const traversalPlanes=new Map(),hullPlanes=new Map();
 function transformed(index,hull){
  const cache=hull?hullPlanes:traversalPlanes;if(cache.has(index))return cache.get(index);
  const p=nodes[index].plane;
  if(!rows)return p;
  // Traversal dot uses Z/Y/X; TransformPlaneByOrtho uses Y/Z/X stores.
  const n=rows.map(row=>f(hull?row[1]*p[1]+row[2]*p[2]+row[0]*p[0]:dot(row,p)));
  const result=[...n,f(p[3]-(hull?origin[1]*n[1]+origin[2]*n[2]+origin[0]*n[0]:dot(origin,n)))];
  cache.set(index,result);return result;
 }
 let hit=null,visits=0;
 function leaf(index){
  const bound=nodes[index].collisionBound;if(bound===-1)return;
  const words=model.leafHulls,planes=[];let cursor=bound;
  if(!Number.isInteger(cursor)||cursor<0||cursor>=words.length)throw Error('Invalid collision hull offset');
  while(words[cursor]!==-1&&planes.length<64){const ref=words[cursor++],node=ref&~0x40000000;if(!nodes[node])throw Error('Invalid hull node');let p=transformed(node,true);if(ref&0x40000000)p=p.map(v=>-v);planes.push(p);}
  if(words[cursor]!==-1)throw Error('Hull exceeds native64-plane capacity');
  const bounds=words.slice(cursor+1,cursor+7).map(asFloat);if(bounds.length!==6||!bounds.every(Number.isFinite))throw Error('Invalid hull bounds');
  let enter=-1,leave=hit?.rawTime??2,normal=[0,0,0];
  function clip(p){
   const push=storedSupport(p,extent),a=f(dot(start,p)-p[3]),b=f(dot(end,p)-p[3]);
   let numerator=a-push;if(a>b&&numerator>=-push&&numerator<0)numerator=0;
   const denominator=f(a-b),time=numerator/denominator;
   if(denominator< -1e-5){if(time<leave)leave=f(time);}
   else if(denominator>1e-5){if(time>enter){enter=f(time);normal=p.slice(0,3);}}
   else if(a>push&&b>push)return false;
   return enter<leave;
  }
  for(const p of planes)if(!clip(p))return;
  if(!rows){const [x,y,z,X,Y,Z]=bounds;
   for(const p of [[0,0,-1,f(.1-z)],[0,0,1,f(Z+.1)],[-1,0,0,f(.1-x)],[1,0,0,f(X-.1)],[0,-1,0,f(.1-y)],[0,1,0,f(Y-.1)]])if(!clip(p))return;
  }
  for(let i=0;i<planes.length;i++)for(let j=0;j<i;j++)for(let axis=0;axis<3;axis++){
   const a=planes[i],b=planes[j];if(!(a[axis]<0&&b[axis]>0||a[axis]>0&&b[axis]<0))continue;
   const unit=[0,0,0];unit[axis]=1;
   if(!(dot(cross(unit,a),cross(unit,b))>.001))continue;
   const intersection=intersect(a,b);let n=normalized(cross(unit,intersection.direction));
   if(dot(a,n)<0)n=n.map(v=>f(v*-1));
   const p=[...n,f(intersection.point[1]*n[1]+intersection.point[2]*n[2]+intersection.point[0]*n[0])];
   if(!clip(p))return;
  }
  if(enter>-1&&enter<leave&&leave>0)hit={rawTime:enter,normal,node:index};
 }
 const stack=[{index:0,parent:0,outside:Boolean(model.rootOutside)}];
 while(stack.length){let {index,parent,outside}=stack.pop();
  if(index===-1){if(!outside)leaf(parent);continue;}
  if(++visits>nodes.length*8+8)throw Error('Invalid cyclic extent BSP');
  const node=nodes[index];if(!node)throw Error('Invalid extent BSP node');
  const p=transformed(index,false),a=dot(start,p)-p[3],b=xyz(end,p)-p[3];
  const pad=support(p,[extent[0]*f(1.1),f(extent[1]*f(1.1)),f(extent[2]*f(1.1))]);
  const visit=[a<=pad||b<=pad,a>=-pad||b>=-pad],near=a>=b?1:0;
  const solid=node.vertexCount>0&&!(node.flags&0x21);
  const branches=[{index:node.back,parent:index,outside:outside&&!solid},{index:node.front,parent:index,outside:outside||solid}];
  if(visit[1-near])stack.push(branches[1-near]);if(visit[near])stack.push(branches[near]);
 }
 if(!hit)return null;
 const delta=end.map((v,i)=>f(v-start[i])),size=f(Math.sqrt(xyz(delta,delta)));
 const time=f(Math.max(0,Math.min(1,hit.rawTime-Math.max(f(.1),f(.1)/size))));
 if(time===1)return null;
 return {time,normal:hit.normal,location:start.map((v,i)=>f(v+f(delta[i]*time))),node:hit.node,penetrating:hit.rawTime<=0};
}
