import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {POLY,toView} from '../unreal/geometry.mjs';
import {createLodMeshFrameCache,getLodMeshFrame} from '../runtime/lodmesh-frame.mjs';

// Original Training capture, class/name identity checked by the integration validator.
export const TRAINING_NPC_IDENTITIES=Object.freeze({JaimeReyes0:34333,ScientistMale0:34368,
  WaltonSimons0:34539,mib1:34533,JaimeReyes1:34328,JaimeReyes2:34315,
  JosephManderley0:34396,ScientistFemale0:34393,Secretary0:34390,
  ScientistFemale1:34512,Doctor1:34508,Doctor0:34602,
  UNATCOTroop1:34401,MedicalBot0:34440,RepairBot0:34519,
  UNATCOTroop2:34601,UNATCOTroop0:34612,UNATCOTroop3:34668});

/** Bounded asset inspection, never a substitute for NPC startup/lighting.
 * Original contracts and the captured cache identity: docs/npc-mesh-preview.md. */
export async function createTrainingNpcPreview(runtime,assets,asset) {
  if(asset.name.toLowerCase()!=='00_training')throw new Error('NPC preview requires Training');
  // Measured GObjObjects identities from the same original Training capture.
  // These select fixtures and cache keys, never character-specific drawing.
  const root=new THREE.Group(),actors=[],errors=[];root.visible=false;
  for(const [name,originalObjectIndex] of Object.entries(TRAINING_NPC_IDENTITIES)) {
    try {
      const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()));
      if(runtime.namedReference(actor,'bHidden').get())continue;
      const preview=await createActorMeshPreview(runtime,assets,actor,{originalObjectIndex});
      preview.root.visible=true;root.add(preview.root);actors.push(preview);
    } catch(error) {errors.push({actor:name,message:error.message});}
  }
  if(!actors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; '));
  return {root,actors,dispose(){for(const actor of actors)actor.dispose();},
    summary:{actors:actors.map(actor=>actor.summary),errors,
      triangles:actors.reduce((total,actor)=>total+actor.summary.triangles,0),
      shading:'texture-only inspection',startup:false}};
}

export async function createActorMeshPreview(runtime,assets,actor,{originalObjectIndex}) {
  const read=(object,name)=>runtime.namedReference(object,name).get();
  const actorName=read(actor,'Name');
  const payload=await runtime.prepareMesh(actor);
  const frame=getLodMeshFrame(payload,actor,[0,0,0,1,0,0,0,1,0,0,0,1],{
    cache:createLodMeshFrameCache(),read,objectIndex:()=>originalObjectIndex,
  });
  const vertices=new DataView(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength);
  const faces=runtime.getActorMeshSurfaces(actor),textures=new TextureStore(assets);
  const root=new THREE.Group(),materials=[],gpuTextures=[],groups=new Map();
  root.name=`${actorName} authored mesh inspection`;root.visible=false;
  const dispose=()=>{
    root.traverse(object=>object.geometry?.dispose());
    for(const material of materials)material.dispose();
    for(const texture of gpuTextures)texture.dispose();
  };
  try {
    for(const [faceIndex,face] of faces.entries()) {
      if(face.flags&POLY.Invisible)continue;
      if(face.flags&POLY.Environment)throw new Error('Environment-mapped mesh preview is unsupported');
      const reference=runtime.getActorMeshTexture(actor,face.texture);
      if(!reference)throw new Error(`${actorName} skin slot ${face.texture} is empty`);
      const key=`${reference.key}:${face.flags}`;
      if(!groups.has(key))groups.set(key,{reference,flags:face.flags,positions:[],uvs:[],faces:[]});
      const group=groups.get(key);
      for(const corner of [0,2,1]) {
        const offset=face.vertices[corner]*12;
        group.positions.push(...toView([0,4,8].map(n=>vertices.getFloat32(offset+n,true))));
        group.uvs.push(...face.uv[corner].map(value=>value/256));
      }
      group.faces.push(faceIndex);
    }
    for(const [key,group] of groups) {
      let flags=group.flags;
      let data=await textures.get(group.reference.asset,group.reference.index,Boolean(flags&POLY.Masked));
      if(data.procedural||data.values.AnimNext)throw new Error('Animated/procedural mesh preview is unsupported');
      for(const [name,flag] of Object.entries({bMasked:POLY.Masked,bTranslucent:POLY.Translucent,
        bTwoSided:POLY.TwoSided,bNoSmooth:POLY.NoSmooth,bModulated:POLY.Modulated}))
        if(data.values[name])flags|=flag;
      if(flags&POLY.Masked&&!data.masked)data=await textures.get(group.reference.asset,group.reference.index,true);
      const first=data.mips[0],texture=new THREE.DataTexture(first.data,first.width,first.height,THREE.RGBAFormat);
      gpuTextures.push(texture);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;
      texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
      texture.magFilter=flags&POLY.NoSmooth?THREE.NearestFilter:THREE.LinearFilter;
      const last=data.mips.at(-1),complete=last.width===1&&last.height===1;
      if(complete&&data.mips.length>1)texture.mipmaps=data.mips;
      texture.generateMipmaps=!complete;
      texture.minFilter=flags&POLY.NoSmooth?THREE.NearestMipmapNearestFilter:THREE.LinearMipmapLinearFilter;
      texture.needsUpdate=true;
      const material=new THREE.MeshBasicMaterial({map:texture,
        side:flags&POLY.TwoSided?THREE.DoubleSide:THREE.FrontSide,alphaTest:flags&POLY.Masked?.5:0});
      materials.push(material);
      if(flags&(POLY.Translucent|POLY.Modulated)) {
        material.transparent=true;material.depthWrite=false;material.blending=THREE.CustomBlending;
        material.blendSrc=flags&POLY.Translucent?THREE.OneFactor:THREE.DstColorFactor;
        material.blendDst=flags&POLY.Translucent?THREE.OneMinusSrcColorFactor:THREE.SrcColorFactor;
      }
      material.userData={key,flags,width:first.width,height:first.height,mipCount:data.mips.length};
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(group.positions,3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(group.uvs,2));
      geometry.computeBoundingSphere();
      const mesh=new THREE.Mesh(geometry,material);
      mesh.userData={actor:`${actorName} (mesh inspection)`,faces:group.faces};root.add(mesh);
    }
    return {root,dispose,location:[...read(actor,'Location')],rotation:[...read(actor,'Rotation')],
      summary:{actor:actorName,mesh:read(actor,'Mesh').key,triangles:faces.length,
        textures:[...new Set([...groups.values()].map(group=>group.reference.key))],
        animation:read(actor,'AnimSequence'),frame:read(actor,'AnimFrame'),
        shading:'texture-only inspection',startup:false}};
  } catch(error) {dispose();throw error;}
}
