/** The readers mesh-faces.mjs replaced, verbatim as they stood at master 07de3088: readLodMeshSurfaces (lodmesh-materials.mjs) and
 * readUMeshSurfaces (umesh-surfaces.mjs), each building an object per face. The differential tests and
 * scripts/validate-mesh-faces.mjs compare the typed blocks with them, field for field. */
import {LodMeshError} from '../../src/runtime/lodmesh.mjs';
import {umeshTopology} from '../../src/runtime/umesh-draw.mjs';

export function referenceLodMeshSurfaces(mesh,{polyFlags=0}={}) {
  const array=(offset,size)=>{
    const a=mesh.arrays.get(offset);
    if(!a||a.elementSize!==size||a.data.byteLength!==a.num*size)
      throw new LodMeshError(`Invalid original surface array at ${offset.toString(16)}`);
    return {count:a.num,view:new DataView(a.data.buffer,a.data.byteOffset,a.data.byteLength)};
  };
  const faces=array(0x144,8),wedges=array(0x15c,4),materials=array(0x168,8);
  const special=mesh.scalarBits.get(0x184)|0,result=[];
  for(let i=0;i<faces.count;i++){
    const at=i*8,material=faces.view.getUint16(at+6,true);
    if(material>=materials.count)throw new LodMeshError('Original face material is out of range');
    const face={wedges:[],vertices:[],uv:[],material,
      flags:(materials.view.getUint32(material*8,true)|polyFlags)>>>0,
      texture:materials.view.getInt32(material*8+4,true)};
    for(let j=0;j<3;j++){
      const wedge=faces.view.getUint16(at+j*2,true);
      if(wedge>=wedges.count)throw new LodMeshError('Original face wedge is out of range');
      const vertex=wedges.view.getUint16(wedge*4,true)+special;
      if(vertex>=mesh.frameVertexCount)throw new LodMeshError('Original wedge vertex is out of range');
      face.wedges.push(wedge);face.vertices.push(vertex);
      face.uv.push([wedges.view.getUint8(wedge*4+2),wedges.view.getUint8(wedge*4+3)]);
    }
    result.push(face);
  }
  return result;
}

export function referenceUMeshSurfaces(mesh) {
  const vertices=mesh.frameVertexCount;
  return umeshTopology(mesh).triangles.map((tri,index)=>{
    for(const vertex of tri.vertices)
      if(vertex>=vertices)throw new Error(`Original triangle ${index} vertex is out of range`);
    return {wedges:[],vertices:[...tri.vertices],uv:tri.uv.map(corner=>[...corner]),material:0,flags:tri.flags>>>0,texture:tri.texture};
  });
}

/** The reference version of what Play built for each binding: the [v0, v1, v2, flags] words of the faces. */
export function referenceFaceWords(faces) {
  const words=new Uint32Array(faces.length*4);
  faces.forEach((face,i)=>words.set([...face.vertices,face.flags>>>0],i*4));
  return words;
}

/** The reference version of meshFaceGroups and groupCorners (actor-mesh-skins.mjs) over object faces. */
export function referenceFaceGroups(faces,skin,invisible) {
  const groups=new Map();
  for(const [faceIndex,face] of faces.entries()) {
    if(face.flags&invisible)continue;
    const reference=skin(face);
    if(!reference)return {error:`skin slot ${face.texture} is empty`};
    const key=`${reference.key}:${face.flags}`;
    if(!groups.has(key))groups.set(key,{key,reference,flags:face.flags,faces:[]});
    groups.get(key).faces.push(faceIndex);
  }
  return {groups};
}
export function referenceGroupCorners(faces,group) {
  const indices=[],uvs=[],corners=[];
  for(const faceIndex of group.faces) {
    const face=faces[faceIndex];
    for(const corner of [0,2,1]) {
      indices.push(face.vertices[corner]);
      uvs.push(...face.uv[corner].map(value=>value/256));
      corners.push(faceIndex*3+corner);
    }
  }
  return {indices,uvs,corners};
}
