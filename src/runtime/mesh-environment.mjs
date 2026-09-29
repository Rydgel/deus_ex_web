/** Selected Render.DrawLodMesh/DrawGouraudPolygon environment path.
 * Native evidence and numeric/rendering limits: script-instructor-conversation.md. */
const f=Math.fround,bits=new DataView(new ArrayBuffer(4));
const mantissa=Float32Array.from({length:1024},(_,i)=>Math.pow(1+i/1024,-.5));
const exponent=Float32Array.from({length:512},(_,i)=>{
  bits.setUint32(0,(i*0x800000)>>>0,true);
  const v=Math.pow(Math.abs(bits.getFloat32(0,true)),-.5);return Number.isNaN(v)?0:v;
});
export function meshNormal(v){
  const q=f(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]+f(.001));
  bits.setFloat32(0,q,true);const b=bits.getUint32(0,true);
  const r=f(mantissa[(b>>>13)&1023]*exponent[b>>>23]);
  return v.map(x=>f(x*r));
}
export function meshFaceNormal([a,b,c]){
  const u=c.map((v,i)=>v-a[i]),v=a.map((x,i)=>f(x-b[i]));
  return meshNormal([f(v[1]*u[2]-v[2]*u[1]),f(v[2]*u[0]-v[0]*u[2]),f(v[0]*u[1]-v[1]*u[0])]);
}
export function meshVertexNormals(points,faces){
  const out=points.map(()=>[0,0,0]);
  for(const face of faces){
    const n=meshFaceNormal(face.vertices.map(i=>points[i]));
    for(const i of face.vertices)for(let j=0;j<3;j++)out[i][j]=f(out[i][j]+n[j]);
  }
  return out.map(meshNormal);
}
const identityAxes=[1,0,0,0,1,0,0,0,1];
export function writeMeshEnvironmentUV(out,at,position,normal,axes=identityAxes){
  const reciprocal=f(1/Math.sqrt(position[0]*position[0]+position[1]*position[1]+position[2]*position[2]));
  const dx=f(position[0]*reciprocal),dy=f(position[1]*reciprocal),dz=f(position[2]*reciprocal);
  const twice=f(2*(dx*normal[0]+dy*normal[1]+dz*normal[2]));
  const rx=f(dx-f(normal[0]*twice)),ry=f(dy-f(normal[1]*twice)),rz=f(dz-f(normal[2]*twice));
  out[at]=f((1+f(rx*axes[0]+ry*axes[1]+rz*axes[2]))/2);
  out[at+1]=f((1+f(rx*axes[3]+ry*axes[4]+rz*axes[5]))/2);
  return out;
}
export function meshEnvironmentUV(position,normal,axes=identityAxes){
  return writeMeshEnvironmentUV([0,0],0,position,normal,axes);
}
/** meshVertexNormals over flat buffers: `points` holds x,y,z per vertex,
 * `indices` three vertex indices per face (face order), `out` receives the
 * normalized x,y,z per vertex. Same operations and rounding order: u=c-a
 * unrounded, v=f(a-b), f32 cross terms, meshNormal, f32 accumulation. */
export function meshVertexNormalsInto(points,indices,out){
  out.fill(0);
  for(let face=0;face<indices.length;face+=3){
    const ia=indices[face]*3,ib=indices[face+1]*3,ic=indices[face+2]*3;
    const ax=points[ia],ay=points[ia+1],az=points[ia+2];
    const ux=points[ic]-ax,uy=points[ic+1]-ay,uz=points[ic+2]-az;
    const vx=f(ax-points[ib]),vy=f(ay-points[ib+1]),vz=f(az-points[ib+2]);
    const cx=f(vy*uz-vz*uy),cy=f(vz*ux-vx*uz),cz=f(vx*uy-vy*ux);
    const q=f(cx*cx+cy*cy+cz*cz+f(.001));
    bits.setFloat32(0,q,true);const b=bits.getUint32(0,true);
    const r=f(mantissa[(b>>>13)&1023]*exponent[b>>>23]);
    const nx=f(cx*r),ny=f(cy*r),nz=f(cz*r);
    for(let k=0;k<3;k++){
      const at=indices[face+k]*3;
      out[at]=f(out[at]+nx);out[at+1]=f(out[at+1]+ny);out[at+2]=f(out[at+2]+nz);
    }
  }
  for(let at=0;at<out.length;at+=3){
    const x=out[at],y=out[at+1],z=out[at+2];
    const q=f(x*x+y*y+z*z+f(.001));
    bits.setFloat32(0,q,true);const b=bits.getUint32(0,true);
    const r=f(mantissa[(b>>>13)&1023]*exponent[b>>>23]);
    out[at]=f(x*r);out[at+1]=f(y*r);out[at+2]=f(z*r);
  }
  return out;
}
