// Original UModel.PointCheck: world boolean plus world/owned recovery entry.
// Source and direct original comparisons: docs/point-check.md.
const f = Math.fround;
const dot = (a,b) => a[2]*b[2] + a[1]*b[1] + a[0]*b[0];
const xyz = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [f(a[1]*b[2]-a[2]*b[1]),f(a[2]*b[0]-a[0]*b[2]),f(a[0]*b[1]-a[1]*b[0])];
const normalize = v => { const inverse = 1/Math.sqrt(xyz(v,v)); return v.map(n=>f(n*inverse)); };
const support = (p,e) => Math.abs(p[2]*e[2])+Math.abs(p[1]*e[1])+Math.abs(p[0]*e[0]);
const view = new DataView(new ArrayBuffer(4));
const asFloat = v => { view.setInt32(0,v,true); return view.getFloat32(0,true); };
function binary(v){view.setFloat32(0,v,true);const w=view.getUint32(0,true),e=(w>>>23)&255;return {n:BigInt((w&0x7fffff)|(e?0x800000:0))*(w>>>31?-1n:1n),e:e?e-150:-149};}
function rounded(a,bits=64){
  const sign=a.n<0n?-1n:1n,n=a.n*sign,shift=Math.max(n.toString(2).length-bits,bits===24?-149-a.e:0);
  if(shift<=0)return a;
  const k=BigInt(shift),unit=1n<<k,half=unit>>1n;let kept=n>>k;const r=n&(unit-1n);
  if(r>half||(r===half&&(kept&1n)))kept++;
  return {n:kept*sign,e:a.e+shift};
}
function sum(a,b){const e=Math.min(a.e,b.e);return rounded({n:(a.n<<BigInt(a.e-e))+(b.n<<BigInt(b.e-e)),e});}
function planeDistance(position,p){
  // Core.PlaneDot10118520 retains its Z/Y/X sum and subtraction in x87.
  // Quarter-turn sine terms survive near cancellation, changing recovery choice.
  const terms=position.map((v,i)=>{const a=binary(v),b=binary(p[i]);return {n:a.n*b.n,e:a.e+b.e};});
  const w=binary(p[3]);w.n=-w.n;
  const value=sum(sum(sum(terms[2],terms[1]),terms[0]),w),stored=rounded(value,24);
  return {raw:Number(value.n)*2**value.e,stored:f(Number(stored.n)*2**stored.e)};
}
const wide=(a,b)=>({n:a.n*b.n,e:a.e+b.e});     // two float32 words multiply exactly (48 bits): fld/fmul keeps the product in the x87 stack
const negate=a=>({n:-a.n,e:a.e});
const store32=a=>{const s=rounded(a,24);return f(Number(s.n)*2**s.e);};  // fstp dword: the one rounding to float32
/** UModel.PointCheck's zero-extent descent for an OWNED model (Engine.dll 103f16c5-103f1794; docs/point-check-zero-extent.md). The owner's coordinates
 * (`ownerCoords` = the 12 floats origin, X, Y, Z axes, from the owner's vtable +0x88) carry each node plane before the point is tested:
 *   N' = (X.n, Y.n, Z.n)    each ((a.y*n.y + a.x*n.x) + a.z*n.z), stored as float32 (103f16f8-103f174f)
 *   T  = Origin.TransformVectorBy(coords), each ((o.x*a.x + o.y*a.y) + o.z*a.z), float32 (Core 10119e40)
 *   D  = T | N' = ((T.z*N'.z + T.y*N'.y) + T.x*N'.x) kept in x87 (Core 10117710 returns it in st0)
 *   the point is in front when ((N'.z*p.z + N'.y*p.y) + N'.x*p.x) - (plane.W - D) > 0, every sum rounded to the x87 mantissa (`sum` here).
 * Returns the front test for a node plane. The world model (no owner) carries the identity coordinates and keeps the double expression of checkPoint. */
function ownedZeroExtentPlanes(coords,position) {
  const origin=coords.slice(0,3).map(binary),axes=[coords.slice(3,6),coords.slice(6,9),coords.slice(9,12)].map(a=>a.map(binary));
  const location=position.map(binary);
  const T=axes.map(a=>store32(sum(sum(wide(origin[0],a[0]),wide(origin[1],a[1])),wide(origin[2],a[2])))).map(binary);
  return p=>{
    const n=p.slice(0,3).map(binary);
    const N=axes.map(a=>store32(sum(sum(wide(a[1],n[1]),wide(a[0],n[0])),wide(a[2],n[2])))).map(binary);
    const d=sum(sum(wide(T[2],N[2]),wide(T[1],N[1])),wide(T[0],N[0]));
    const w=sum(binary(p[3]),negate(d));
    const point=sum(sum(wide(N[2],location[2]),wide(N[1],location[1])),wide(N[0],location[0]));
    return sum(point,negate(w)).n>0n;
  };
}
function vector(v,label) {
  if (!v || v.length!==3 || !v.every(Number.isFinite)) throw Error(`Invalid ${label}`);
  const result=v.map(f);
  if (!result.every(Number.isFinite)) throw Error(`${label} exceeds float32`);
  return result;
}
// PointCheck and LineCheck call the same original103f6600 two-plane intersection.
function intersection(a,b) {
  const direction=cross(a,b),square=xyz(direction,direction);
  if (square<1e-6) return {point:[0,0,0],direction:[0,0,0]};
  const first=cross(direction,a),second=cross(b,direction),inverse=f(1/square);
  const point=first.map((v,i)=>f((i===2 ? v*b[3]+second[i]*a[3] : f(f(v*b[3])+f(second[i]*a[3])))*inverse));
  return {point,direction:normalize(direction)};
}

/** Return true when the original world PointCheck reports clear/outside.
 * Does not return or emulate original recovery location, normal or Item.
 * Owned brushes are a separate, explicitly unsupported input contract. */
export function pointCheck(model,position,extent=[0,0,0],extraNodeFlags=0) {
  return checkPoint(model,position,extent,extraNodeFlags,null,null);
}
export function modelPointCheck(model,position,extent=[0,0,0],ownerCoords=null,extraNodeFlags=0) {
  const result={outside:true,location:position.map(f),normal:[0,0,0],time:0,item:-1};
  result.outside=checkPoint(model,position,extent,extraNodeFlags,ownerCoords,result);
  return result;
}
function checkPoint(model,position,extent,extraNodeFlags,ownerCoords,result) {
  position=vector(position,'position'); extent=vector(extent,'extent');
  if (extent.some(v=>v<0)) throw Error('Negative point extents are unsupported');
  if (model.rootOutside===undefined) throw Error('PointCheck requires compiled BSP root');
  const nodes=model.nodes;
  if (!nodes.length) return Boolean(model.rootOutside);
  const rows=ownerCoords&&[ownerCoords.slice(3,6),ownerCoords.slice(6,9),ownerCoords.slice(9,12)];
  const origin=rows&&rows.map(row=>f(xyz(ownerCoords,row)));
  function transformed(index,hull=false) {
    const p=nodes[index].plane;if(!rows)return p;
    const n=rows.map(row=>f(hull?row[1]*p[1]+row[2]*p[2]+row[0]*p[0]:dot(row,p)));
    return [...n,f(p[3]-(hull?origin[1]*n[1]+origin[2]*n[2]+origin[0]*n[0]:dot(origin,n)))];
  }
  let nearest=100000;
  function face(p,item,bevel=false) {
    const exact=result?planeDistance(position,p):null,raw=exact?.raw??dot(position,p)-p[3],distance=bevel?raw:(exact?.stored??f(raw)),push=bevel?support(p,extent):f(support(p,extent));
    if(result&&raw>0&&distance<nearest&&distance<push){
      nearest=f(distance);const amount=f(push-distance),factor=f(1.02);
      result.location=position.map((v,i)=>f(v+(bevel&&i===0?p[i]*factor*amount:f(f(p[i]*factor)*amount))));
      result.normal=p.slice(0,3);result.item=item;
    }
    return distance<push;
  }
  let visits=0;
  function nodeAt(index) {
    if (++visits>nodes.length*8+8) throw Error('Invalid cyclic point BSP');
    const node=nodes[index];
    if (!node) throw Error('Invalid point BSP node');
    return node;
  }
  if (extent.every(v=>v===0)) {
    // 103f16c5: one descent. Owned, the plane is first carried by the owner's coordinates (below); the leaf the walk ends in is recorded as Item = 2*node+side.
    let index=0,outside=Boolean(model.rootOutside),last=0,side=0;
    const carried=rows&&ownedZeroExtentPlanes(ownerCoords,position);
    while (index!==-1) {
      const node=nodeAt(index),p=node.plane,solid=node.vertexCount>0&&!(node.flags&0x21);
      last=index;
      if (carried?carried(p):dot(position,p)-p[3]>0) {outside ||= solid;index=node.front;side=1;}
      else {outside &&= !solid;index=node.back;side=0;}
    }
    if(result)result.item=side+last*2;
    return outside;
  }
  function intersects(index) {
    const bound=nodes[index].collisionBound;
    if (bound===-1) return false;
    const words=model.leafHulls,planes=[],items=[];
    let cursor=bound;
    if (!Number.isInteger(cursor)||cursor<0||cursor>=words.length) throw Error('Invalid point hull offset');
    while (words[cursor]!==-1&&planes.length<64) {
      const ref=words[cursor++],node=nodes[ref&~0x40000000];
      if (!node) throw Error('Invalid point hull plane');
      const plane=transformed(ref&~0x40000000,true);
      planes.push(ref&0x40000000 ? plane.map(v=>-v) : plane);
      items.push(ref&~0x40000000);
    }
    if (words[cursor]!==-1) throw Error('Point hull exceeds native64-plane capacity');
    const bounds=words.slice(cursor+1,cursor+7).map(asFloat);
    if (bounds.length!==6||!bounds.every(Number.isFinite)) throw Error('Invalid point hull bounds');
    for (let i=0;i<planes.length;i++) if (!face(planes[i],items[i])) return false;
    const [x,y,z,X,Y,Z]=bounds;
    if(!rows)for (const p of [[0,0,-1,f(.1-z)],[0,0,1,f(Z+.1)],[-1,0,0,f(.1-x)],[1,0,0,f(X-.1)],[0,-1,0,f(.1-y)],[0,1,0,f(Y-.1)]]) {
      if (!face(p,-1)) return false;
    }
    for (let i=0;i<planes.length;i++) for (let j=0;j<i;j++) for (let axis=0;axis<3;axis++) {
      const a=planes[i],b=planes[j];
      if (!(a[axis]<0&&b[axis]>0 || a[axis]>0&&b[axis]<0)) continue;
      const unit=[0,0,0];unit[axis]=1;
      if (!(dot(cross(unit,a),cross(unit,b))>.001)) continue;
      const edge=intersection(a,b);
      let normal=normalize(cross(unit,edge.direction));
      if (dot(a,normal)<0) normal=normal.map(v=>f(v*-1));
      const p=[...normal,f(edge.point[1]*normal[1]+edge.point[2]*normal[2]+edge.point[0]*normal[0])];
      //103f3050 retains both expressions in x87 until comparison: no float store.
      if (!face(p,-1,true)) return false;
    }
    return true;
  }
  const padded=extent.map(v=>f(v*f(1.1))),mask=(extraNodeFlags|0x21)&255;
  const stack=[{index:0,parent:0,outside:Boolean(model.rootOutside)}];
  let clear=true;
  while (stack.length) {
    const {index,parent,outside}=stack.pop();
    if (index===-1) {if (!outside&&intersects(parent)){if(!result)return false;clear=false;}continue;}
    const node=nodeAt(index),p=transformed(index),solid=node.vertexCount>0&&!(node.flags&mask);
    const distance=f(p[1]*position[1]+p[0]*position[0]+p[2]*position[2]-p[3]);
    const push=f(support(p,padded));
    // Original front recursion precedes back tail traversal. Recovery does not
    // mutate the position used by either branch's boolean test.
    if (distance<=push) stack.push({index:node.back,parent:index,outside:outside&&!solid});
    if (distance> -push) stack.push({index:node.front,parent:index,outside:outside||solid});
  }
  return clear;
}
