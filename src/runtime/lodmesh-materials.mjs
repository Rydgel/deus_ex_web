/** Original surface layout and skin selection; docs/script-lodmesh-materials.md. */
import {LodMeshError} from './lodmesh.mjs';
import {refValue} from './script-vm.mjs';

function checkedIndex(index) {
  if(!Number.isInteger(index)||index< -0x80000000||index>0x7fffffff)
    throw new LodMeshError('Original texture index requires int32');
  return index;
}

/** AActor::GetSkin 10367eb0, also inherited by the native ScriptedPawn. */
export function getActorSkin(actor,index,read) {
  checkedIndex(index);
  return (index>>>0)<8?read(actor,'MultiSkins')[index]:null;
}

function textureAt(mesh,index,services) {
  if(index<0||index>=services.textureCount(mesh))
    throw new LodMeshError('UMesh::GetTexture reached an unsupported out-of-range array access');
  return services.textureAt(mesh,index);
}

/** UMesh::GetTexture 1031c0a0. The second virtual call is intentional. */
export function getMeshTexture(mesh,actor,index,services) {
  checkedIndex(index);
  if(actor&&services.getSkin(actor,index))return services.getSkin(actor,index);
  if(index!==0){const texture=textureAt(mesh,index,services);if(texture)return texture;}
  if(actor){const skin=services.read(actor,'Skin');if(skin)return skin;}
  return textureAt(mesh,index,services);
}

/** Native 1013 is a separate, bounds-checked wrapper (103e17c0). */
export function execGetMeshTexture(call,services) {
  if(call.argumentCount>1)throw new LodMeshError('GetMeshTexture accepts at most one argument');
  const index=checkedIndex(call.argumentCount?refValue(call.evaluateArgument(0))??0:0);
  const actor=call.receiver;
  if(!services.read(actor,'Mesh')){services.warning?.('GetMeshTexture: No mesh');return null;}
  if(services.getSkin(actor,index))return services.getSkin(actor,index);
  if(index>0){
    const mesh=services.read(actor,'Mesh');
    if(index<services.textureCount(mesh)){
      const texture=services.textureAt(mesh,index);if(texture)return texture;
    }
  }
  const skin=services.read(actor,'Skin');if(skin)return skin;
  if(index>=0){
    const mesh=services.read(actor,'Mesh');
    if(index<services.textureCount(mesh))return services.textureAt(mesh,index);
  }
  return null;
}

/** Full-resolution faces only: no reduced-LOD selection, morphing or culling.
 * Vertices address the complete GetFrame buffer, including its special prefix.
 * UVs remain the original byte coordinates; the draw adapter owns scaling. */
export function readLodMeshSurfaces(mesh,{polyFlags=0}={}) {
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
