/** A classic UMesh's triangles as the surfaces the actor mesh layer groups by skin
 * (readLodMeshSurfaces' shape): the vertex indices, the three corners' U and V bytes
 * (FMeshUV), PolyFlags and TextureIndex, in mesh order (docs/umesh.md). A classic mesh
 * has no wedges, no material table and no special vertices, so the vertices address
 * GetFrame's buffer directly. The triangles are mesh-faces.mjs' typed block
 * (buildUMeshFaces) as objects; Play reads the block itself. */
import {buildUMeshFaces,faceObjects} from './mesh-faces.mjs';

export function readUMeshSurfaces(mesh) {
  return faceObjects(buildUMeshFaces(mesh));
}
