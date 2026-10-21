/** A classic UMesh's triangles as the surfaces the actor mesh layer groups by skin
 * (readLodMeshSurfaces' shape): the vertex indices, the three corners' U and V bytes
 * (FMeshUV), PolyFlags and TextureIndex, in mesh order (docs/umesh.md). A classic mesh
 * has no wedges, no material table and no special vertices, so the vertices address
 * GetFrame's buffer directly. */
import {umeshTopology} from './umesh-draw.mjs';

export function readUMeshSurfaces(mesh) {
  const vertices=mesh.frameVertexCount;
  return umeshTopology(mesh).triangles.map((tri,index)=>{
    for(const vertex of tri.vertices)
      if(vertex>=vertices)throw new Error(`Original triangle ${index} vertex is out of range`);
    return {wedges:[],vertices:[...tri.vertices],uv:tri.uv.map(corner=>[...corner]),material:0,flags:tri.flags>>>0,texture:tri.texture};
  });
}
