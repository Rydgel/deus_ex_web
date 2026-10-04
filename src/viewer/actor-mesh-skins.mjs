import {POLY} from '../unreal/geometry.mjs';

/** A mesh face group's skin (docs/actor-mesh-texture-sharing.md): the texture
 * decoded with the group's masking, the texture's own poly flags added
 * (bMasked, bTranslucent, bTwoSided, bNoSmooth, bModulated) and the masked
 * decode taken when those make the group masked. A FireTexture or WetTexture
 * skin is live (procedural-textures.mjs); other animated or procedural skins
 * are unsupported and throw, which drops the group. The simulation side
 * (actor-mesh-sim.mjs) and the page (actor-mesh-draw.mjs) both run this on
 * the same texture, so they keep the same groups. */
export async function resolveMeshSkin(textures,asset,index,groupFlags) {
  let flags=groupFlags;
  let data=await textures.get(asset,index,Boolean(flags&POLY.Masked));
  if(data.procedural!=='FireTexture'&&data.procedural!=='WetTexture'&&(data.procedural||data.values.AnimNext))
    throw new Error('Animated/procedural mesh skin is unsupported');
  for(const [name,flag] of Object.entries({bMasked:POLY.Masked,bTranslucent:POLY.Translucent,
    bTwoSided:POLY.TwoSided,bNoSmooth:POLY.NoSmooth,bModulated:POLY.Modulated}))
    if(data.values[name])flags|=flag;
  if(flags&POLY.Masked&&!data.masked&&!data.fire)data=await textures.get(asset,index,true);
  return {data,flags};
}

/** The mesh's drawn faces in face groups, keyed by skin and face flags, in
 * first-use order (DrawLodMesh's face list; PF_Invisible faces are not
 * drawn). `skin(face)` is the face's texture reference. */
export function meshFaceGroups(faces,skin) {
  const groups=new Map();
  for(const [faceIndex,face] of faces.entries()) {
    if(face.flags&POLY.Invisible)continue;
    const reference=skin(face);
    if(!reference)return {error:`skin slot ${face.texture} is empty`};
    const key=`${reference.key}:${face.flags}`;
    if(!groups.has(key))groups.set(key,{key,reference,flags:face.flags,faces:[]});
    groups.get(key).faces.push(faceIndex);
  }
  return {groups};
}

/** A group's corner arrays, as the draw order needs them: vertex indices,
 * UVs and corner ids for each face's corners 0, 2, 1. */
export function groupCorners(faces,group) {
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
