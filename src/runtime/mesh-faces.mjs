/** A mesh's faces, held once per mesh as typed blocks (docs/live-heap.md "Step 4's results"). Every binding of a mesh reads the same
 * block; a binding used to read its own `{wedges, vertices, uv, material, flags, texture}` object for each face, about fifteen heap
 * objects a face, nothing shared. Host representation only: the values are readLodMeshSurfaces' (docs/script-lodmesh-materials.md)
 * and readUMeshSurfaces' (docs/umesh.md), word for word.
 *
 * Face i of a block:
 *   words[i*4 .. i*4+2]  the three corners' vertex indices (with the special-vertex prefix of GetFrame's buffer; a classic mesh's
 *                        triangle vertices as they are), words[i*4+3] its PolyFlags (the material's, plus the caller's);
 *                        the layout the lighting kernel, the GPU mesh layout and the LOD read;
 *   wedges[i*3 + corner] the corner's wedge (empty for a classic mesh, which has none);
 *   uv[i*6 + corner*2]   the corner's U byte, then its V byte (FMeshUV);
 *   material[i]          the face's index into the material table (0 for a classic mesh);
 *   texture[i]           the material's TextureIndex. */
import {LodMeshError} from './lodmesh.mjs';
import {umeshTopology} from './umesh-draw.mjs';

export class MeshFaces {
  constructor(count,{wedges=true}={}) {
    this.count=count;
    this.words=new Uint32Array(count*4);
    this.wedges=new Uint16Array(wedges?count*3:0);
    this.uv=new Uint8Array(count*6);
    this.material=new Uint16Array(count);
    this.texture=new Int32Array(count);
  }
  /** Whether any face has a bit of `mask` set in its flags. */
  anyFlags(mask) {
    for(let i=3;i<this.words.length;i+=4)if(this.words[i]&mask)return true;
    return false;
  }
}

/** The faces of a decoded LodMesh (`mesh` from decodeLodMeshPayload): readLodMeshSurfaces' reads and checks, in its order.
 * Full-resolution faces only: no reduced-LOD selection, morphing or culling. Vertices address the complete GetFrame buffer,
 * including its special prefix. UVs remain the original byte coordinates; the draw adapter owns scaling. */
export function buildLodMeshFaces(mesh,{polyFlags=0}={}) {
  const array=(offset,size)=>{
    const a=mesh.arrays.get(offset);
    if(!a||a.elementSize!==size||a.data.byteLength!==a.num*size)
      throw new LodMeshError(`Invalid original surface array at ${offset.toString(16)}`);
    return {count:a.num,view:new DataView(a.data.buffer,a.data.byteOffset,a.data.byteLength)};
  };
  const faces=array(0x144,8),wedges=array(0x15c,4),materials=array(0x168,8);
  const special=mesh.scalarBits.get(0x184)|0,block=new MeshFaces(faces.count);
  const {words,uv}=block;
  for(let i=0;i<faces.count;i++) {
    const at=i*8,material=faces.view.getUint16(at+6,true);
    if(material>=materials.count)throw new LodMeshError('Original face material is out of range');
    block.material[i]=material;
    words[i*4+3]=(materials.view.getUint32(material*8,true)|polyFlags)>>>0;
    block.texture[i]=materials.view.getInt32(material*8+4,true);
    for(let j=0;j<3;j++) {
      const wedge=faces.view.getUint16(at+j*2,true);
      if(wedge>=wedges.count)throw new LodMeshError('Original face wedge is out of range');
      const vertex=wedges.view.getUint16(wedge*4,true)+special;
      if(vertex>=mesh.frameVertexCount)throw new LodMeshError('Original wedge vertex is out of range');
      block.wedges[i*3+j]=wedge;words[i*4+j]=vertex;
      uv[i*6+j*2]=wedges.view.getUint8(wedge*4+2);uv[i*6+j*2+1]=wedges.view.getUint8(wedge*4+3);
    }
  }
  return block;
}

/** The faces of a classic UMesh (readUMeshSurfaces): its triangles' vertices as they are, with no wedges, no material table and
 * no special vertices. */
export function buildUMeshFaces(mesh) {
  const vertices=mesh.frameVertexCount,triangles=umeshTopology(mesh).triangles;
  const block=new MeshFaces(triangles.length,{wedges:false});
  triangles.forEach((tri,index)=>{
    for(let k=0;k<3;k++) {
      if(tri.vertices[k]>=vertices)throw new Error(`Original triangle ${index} vertex is out of range`);
      block.words[index*4+k]=tri.vertices[k];
    }
    block.words[index*4+3]=tri.flags>>>0;
    for(let k=0;k<3;k++){block.uv[index*6+k*2]=tri.uv[k][0];block.uv[index*6+k*2+1]=tri.uv[k][1];}
    block.texture[index]=tri.texture;
  });
  return block;
}

const blocks=new WeakMap();
/** The mesh's faces, built on first use and shared by every binding of the mesh. `mesh` is the prepared payload
 * (ScriptRuntime.meshResource(reference).payload, or the page's decode of the same package bytes). A build that throws is not
 * kept: the next call throws the same error again. */
export function meshFaces(mesh) {
  let block=blocks.get(mesh);
  if(!block){
    block=mesh.payloadStatus==='decoded-mesh'?buildUMeshFaces(mesh):buildLodMeshFaces(mesh);
    blocks.set(mesh,block);
  }
  return block;
}

/** The block's faces as the reference readers' objects (readLodMeshSurfaces, readUMeshSurfaces): for validators and tests. */
export function faceObjects(block) {
  const {words,wedges,uv}=block;
  return Array.from({length:block.count},(_,i)=>({
    wedges:wedges.length?[wedges[i*3],wedges[i*3+1],wedges[i*3+2]]:[],
    vertices:[words[i*4],words[i*4+1],words[i*4+2]],
    uv:[[uv[i*6],uv[i*6+1]],[uv[i*6+2],uv[i*6+3]],[uv[i*6+4],uv[i*6+5]]],
    material:block.material[i],flags:words[i*4+3],texture:block.texture[i]}));
}

/** Packed face words (four a face) as `{vertices, flags}` objects, the form the reference lighting path (mesh-lighting-view.mjs)
 * and the validators read. */
export function faceList(words) {
  return Array.from({length:words.length/4},(_,i)=>({vertices:[words[i*4],words[i*4+1],words[i*4+2]],flags:words[i*4+3]}));
}
