/** Render.dll URender::DrawMesh for a classic UMesh (0x10b0d1a0, the body from
 * 0x10b0d235 that DrawLodMesh's dispatch at 0x10b0d1fc does not take), up to the
 * polygons it hands to the shared face helper 0x10b0bab0 (docs/umesh.md).
 *
 * The game's five classic meshes (the boot logos and the Fly) are the only
 * meshes drawn this way. The editor wire-frame modes, the particle branch
 * (Actor.bParticles), the pawn-attachment triangle (PF_Invisible faces) and
 * the software renderer's sort (RenDev->SpanBased, zero for D3DDrv) are not
 * translated.
 *
 * It runs in the render pass, at x87 precision control 24: every float
 * operation below is one binary32 operation `f(a op b)` in the original's
 * order; an operation with a double constant (the 0.001 added to a face
 * normal's squared length) is rounded once from the exact value (r24sum).
 *
 * Steps, in the original's order:
 *   1. every vertex: Light.X = -1 (the "not lit yet" mark) and its outcode
 *      from the frame's four side planes (PrjXM..PrjYP at Frame+0xec..0xf8);
 *      the mesh is skipped when every vertex shares an outcode bit;
 *   2. every triangle (kept or not): its face normal, the table-reciprocal
 *      unit cross product of (v2 - v0) and (v0 - v1);
 *   3. the kept triangles, in mesh order: outcodes not sharing a bit, and
 *      `(PolyFlags & 0x4101) != 0x4000` or `dot(N, v0)·Mirror < 0`;
 *   4. SetupForActor's flag bits join PolyFlags (the caller's setup), then
 *      for each vertex of each kept triangle, once: its normal is the sum of
 *      the face normals of the triangles that share it (Connects/VertLinks),
 *      normalized by the table reciprocal root, with the plane distance
 *      W = (P.y·n.y + P.z·n.z) + P.x·n.x; Fatness moves the point along it;
 *      then FLightManager::Light and ::Fog;
 *   5. each kept triangle, in order: the texture info (the mesh texture, or
 *      the environment map for PF_Environment and a missing texture), the
 *      corners' U and V (byte * USize·UScale/256, written into the shared
 *      vertex records), the reversal of the winding in a mirrored frame
 *      (Pts[0] and Pts[2] swap) and the face helper: PF_Environment sets
 *      each corner's U and V from the reflection of its direction about its
 *      normal, taken to world space through the frame's Uncoords, and
 *      PF_Unlit overwrites each corner's Light with the unlit colour. */
import {tableRsqrt,fatnessScale} from './mesh-lighting.mjs';
import {r24sum} from './x87-r24.mjs';
const f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
const signBit=value=>{bits.setFloat32(0,value,true);return bits.getUint32(0,true)>>>31;};
const F32_MINUS_ONE=0xbf800000;

/** The mesh's triangles and vertex links, decoded once. */
const topologies=new WeakMap();
export function umeshTopology(mesh) {
  let topology=topologies.get(mesh);
  if(topology)return topology;
  const tris=mesh.arrays.get(0x78).load(),connects=mesh.arrays.get(0x9c).load(),links=mesh.arrays.get(0xcc).load();
  const t=new DataView(tris.data.buffer,tris.data.byteOffset,tris.data.byteLength);
  const c=new DataView(connects.data.buffer,connects.data.byteOffset,connects.data.byteLength);
  const l=new DataView(links.data.buffer,links.data.byteOffset,links.data.byteLength);
  const triangles=Array.from({length:tris.num},(_,i)=>{
    const at=i*20;
    return {vertices:[t.getUint16(at,true),t.getUint16(at+2,true),t.getUint16(at+4,true)],
      uv:[[t.getUint8(at+6),t.getUint8(at+7)],[t.getUint8(at+8),t.getUint8(at+9)],[t.getUint8(at+10),t.getUint8(at+11)]],
      flags:t.getUint32(at+12,true),texture:t.getInt32(at+16,true)};
  });
  const vertexLinks=Array.from({length:connects.num},(_,i)=>{
    const count=c.getInt32(i*8,true),offset=c.getInt32(i*8+4,true);
    return Array.from({length:count},(_,k)=>l.getInt32((offset+k)*4,true));
  });
  topology={triangles,links:vertexLinks};
  topologies.set(mesh,topology);
  return topology;
}

// The frame's outcode planes (0x10b0d3c8..0x10b0d462): z·PrjXM + x, z·PrjYM + y, z·PrjYP - y and z·PrjXP - x, whose sign bits
// select 4, 0x10, 0x20 and 8.
function outcode(x,y,z,prj) {
  if(!prj)return 0;
  const a=f(f(z*prj[0])+x),b=f(f(z*prj[1])+y),c=f(f(z*prj[3])-y),d=f(f(z*prj[2])-x);
  return (signBit(a)?4:0)|(signBit(b)?0x10:0)|(signBit(c)?0x20:0)|(signBit(d)?8:0);
}

/** FVector::UnsafeNormal (Core 0x10117dd0): the squared length summed
 * `(x² + y²) + z²`, appSqrt (fsqrt), 1.0 over it, then each component times it. */
export function unsafeNormal(v) {
  const sum=f(f(f(v[0]*v[0])+f(v[1]*v[1]))+f(v[2]*v[2])),scale=f(1/f(Math.sqrt(sum)));
  return [f(scale*v[0]),f(scale*v[1]),f(scale*v[2])];
}
/** The face helper's PF_Environment corner (0x10b0bb09..0x10b0bbb7): the unit direction n of
 * the corner, `r = n - N·f(2·(n|N))`, taken to world space by the frame's Uncoords axes
 * (`uncoords`: rows of three), then U = f(f(f(r.x + 1)·UFactor)·128) and V likewise. */
export function environmentUV(point,normal,uncoords,uFactor,vFactor) {
  const n=unsafeNormal(point);
  const d=f(f(f(n[2]*normal[2])+f(n[1]*normal[1]))+f(n[0]*normal[0])),twice=f(2*d);
  const r=[0,1,2].map(i=>f(n[i]-f(twice*normal[i])));
  const world=[0,1,2].map(j=>f(f(f(r[0]*uncoords[j][0])+f(r[1]*uncoords[j][1]))+f(r[2]*uncoords[j][2])));
  return [f(f(f(world[0]+1)*uFactor)*128),f(f(f(world[1]+1)*vFactor)*128)];
}

/** DrawMesh's classic body for the camera-space `points` (GetFrame's output for this frame's
 * Coords, x,y,z per vertex). `frame`: {mirror, prj (PrjXM, PrjYM, PrjXP, PrjYP, or null: no
 * outcode culling), uncoords (the three Uncoords axes)}. `polyFlags`: the actor's flags with
 * PF_Flat (DrawMesh sets it); `setup`: {flags} (SetupForActor's result, joined after the cull);
 * `fatness`: Actor.Fatness; `unlit`: the unlit colour; `textureInfo(i)`: the mesh texture i's
 * {uSize, vSize, uScale, vScale, flags} or null; `environment`: the environment map's info;
 * `light(index, point, plane, flags)` and `fog(...)` stand for FLightManager::Light and Fog. */
export function drawUMesh(mesh,points,{frame,polyFlags,setup={flags:0},fatness=0x80,unlit=[0,0,0],textureInfo,environment,light,fog=null}) {
  const topology=umeshTopology(mesh),{triangles,links}=topology,count=mesh.frameVertexCount;
  if(points.length<count*3)throw new Error('DrawMesh needs one camera-space point per frame vertex');
  const point=Float32Array.from(points.subarray(0,count*3));
  const codes=new Uint8Array(count),plane=new Float32Array(count*4),lit=new Array(count).fill(null),foggy=new Array(count).fill(null);
  const u=new Float32Array(count),v=new Float32Array(count);
  const marked=new Uint8Array(count).fill(1); // Light.X = -1.0 (0x10b0d3bb)
  let all=0x3c;
  for(let i=0;i<count;i++) {
    codes[i]=outcode(point[i*3],point[i*3+1],point[i*3+2],frame.prj);
    all&=codes[i];
  }
  const result={visible:[],draws:[],lightCalls:[],allOutside:all!==0,vertexLight:lit,points:point};
  if(all)return result; // 0x10b0dad4
  // Face normals of every triangle (0x10b0db49..0x10b0dc6d).
  const normals=triangles.map(tri=>{
    const [a,b,c]=tri.vertices;
    const ax=f(point[c*3]-point[a*3]),ay=f(point[c*3+1]-point[a*3+1]),az=f(point[c*3+2]-point[a*3+2]);
    const bx=f(point[a*3]-point[b*3]),by=f(point[a*3+1]-point[b*3+1]),bz=f(point[a*3+2]-point[b*3+2]);
    const nx=f(f(by*az)-f(bz*ay)),ny=f(f(bz*ax)-f(az*bx)),nz=f(f(ay*bx)-f(by*ax));
    const sum=f(r24sum(f(f(f(nx*nx)+f(ny*ny))+f(nz*nz)),0.001)),scale=tableRsqrt(sum);
    return [f(scale*nx),f(scale*ny),f(scale*nz)];
  });
  // The kept triangles (0x10b0dc81..0x10b0dd8e), flags as the cull sees them: the triangle's with the caller's.
  triangles.forEach((tri,index)=>{
    const [a,b,c]=tri.vertices,flags=(tri.flags|polyFlags)>>>0;
    if(codes[a]&codes[b]&codes[c])return;
    if((flags&0x4101)===0x4000) {
      const n=normals[index],dot=f(f(f(n[2]*point[a*3+2])+f(n[1]*point[a*3+1]))+f(point[a*3]*n[0]));
      if(!(f(dot*frame.mirror)<0))return;
    }
    result.visible.push(index);
  });
  if(!result.visible.length)return result;
  // The final flags (SetupForActor's bits joined, 0x10b0dffc).
  const flags=(polyFlags|setup.flags)>>>0;
  // Per-vertex normal, Light and Fog (0x10b0e029..0x10b0e2ed), for the vertices of kept triangles, once each.
  const fat=fatness!==0x80?fatnessScale(fatness):null;
  for(const index of result.visible)for(const vertex of triangles[index].vertices) {
    if(!marked[vertex])continue;
    marked[vertex]=0;
    let sx=0,sy=0,sz=0;
    for(const t of links[vertex]) {sx=f(sx+normals[t][0]);sy=f(sy+normals[t][1]);sz=f(sz+normals[t][2]);}
    // The squared length `(z² + y²) + x²` has no epsilon here, unlike the face normal's.
    const scale=tableRsqrt(f(f(f(sz*sz)+f(sy*sy))+f(sx*sx)));
    const nz=f(sz*scale),ny=f(sy*scale),nx=f(sx*scale);
    const px=point[vertex*3],py=point[vertex*3+1],pz=point[vertex*3+2];
    const w=f(f(f(py*ny)+f(pz*nz))+f(px*nx));
    plane.set([nx,ny,nz,w],vertex*4);
    if(fat!==null) {
      point[vertex*3]=f(f(fat*nx)+px);point[vertex*3+1]=f(f(fat*ny)+py);point[vertex*3+2]=f(f(fat*nz)+pz);
      codes[vertex]=outcode(point[vertex*3],point[vertex*3+1],point[vertex*3+2],frame.prj);
    }
    const here=Array.from(point.subarray(vertex*3,vertex*3+3));
    result.lightCalls.push({vertex,point:here,plane:[nx,ny,nz,w],flags});
    lit[vertex]=Array.from(light(vertex,here,[nx,ny,nz,w],flags));
    foggy[vertex]=fog?Array.from(fog(vertex,here,[nx,ny,nz,w],flags)):[0,0,0,0];
  }
  // The draw loop (0x10b0e312..0x10b0e41f).
  const snapshot=index=>({index,point:Array.from(point.subarray(index*3,index*3+3)),outcode:codes[index],normal:Array.from(plane.subarray(index*4,index*4+4)),
    light:lit[index]?[...lit[index]]:null,fog:foggy[index]?[...foggy[index]]:null,u:u[index],v:v[index]});
  for(const index of result.visible) {
    const tri=triangles[index];
    let drawFlags=(tri.flags|flags)>>>0;
    const own=drawFlags&0x10?null:textureInfo(tri.texture);
    const info=own??environment;
    if(!info)throw new Error('DrawMesh has no environment map to draw with');
    drawFlags=(drawFlags|(info.flags&2))>>>0;
    const uFactor=f(f(info.uSize*info.uScale)/256),vFactor=f(f(info.vSize*info.vScale)/256);
    const pts=tri.vertices.slice();
    tri.vertices.forEach((vertex,k)=>{u[vertex]=f(tri.uv[k][0]*uFactor);v[vertex]=f(tri.uv[k][1]*vFactor);});
    if(Object.is(frame.mirror,-1)){const swap=pts[0];pts[0]=pts[2];pts[2]=swap;}
    // The face helper 0x10b0bab0's two preparations.
    if(drawFlags&0x10)for(const vertex of pts) {
      const uv=environmentUV(Array.from(point.subarray(vertex*3,vertex*3+3)),plane.subarray(vertex*4,vertex*4+3),frame.uncoords,uFactor,vFactor);
      u[vertex]=uv[0];v[vertex]=uv[1];
    }
    if(drawFlags&0x400000)for(const vertex of pts)lit[vertex]=[unlit[0],unlit[1],unlit[2],0];
    // The helper draws nothing when the corners share an outcode bit (0x10b0c52a), and puts a two-sided face
    // that faces away in front-facing order (0x10b0c52c..0x10b0c578): Pts[0] and Pts[2] swap unless
    // `(A·y0 + B·z0) + C·x0 > 0`, with A, B, C the cross terms of corners 2 and 1.
    if(codes[pts[0]]&codes[pts[1]]&codes[pts[2]])continue;
    if(drawFlags&0x100) {
      const [p0,p1,p2]=pts.map(vertex=>point.subarray(vertex*3,vertex*3+3));
      const A=f(f(p2[0]*p1[2])-f(p1[0]*p2[2])),B=f(f(p1[0]*p2[1])-f(p2[0]*p1[1])),C=f(f(p2[2]*p1[1])-f(p2[1]*p1[2]));
      const sum=f(f(f(A*p0[1])+f(B*p0[2]))+f(C*p0[0]));
      if(!(sum>0)){const swap=pts[0];pts[0]=pts[2];pts[2]=swap;}
    }
    result.draws.push({tri:index,flags:drawFlags,environment:info===environment,texture:own?tri.texture:null,uFactor,vFactor,pts:pts.map(snapshot)});
  }
  return result;
}
