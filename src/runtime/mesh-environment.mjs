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
export function meshEnvironmentUV(position,normal,axes=[1,0,0,0,1,0,0,0,1]){
  const reciprocal=f(1/Math.sqrt(position.reduce((s,v)=>s+v*v,0)));
  const d=position.map(v=>f(v*reciprocal));
  const twice=f(2*(d[0]*normal[0]+d[1]*normal[1]+d[2]*normal[2]));
  const r=d.map((v,i)=>f(v-f(normal[i]*twice)));
  const world=[0,1].map(i=>f(r[0]*axes[i*3]+r[1]*axes[i*3+1]+r[2]*axes[i*3+2]));
  return world.map(v=>f((1+v)/2));
}
