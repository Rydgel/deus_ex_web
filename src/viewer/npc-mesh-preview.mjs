import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {createLodMeshFrameCache,getLodMeshFrame} from '../runtime/lodmesh-frame.mjs';
import {loadLodMeshKernel} from '../runtime/lodmesh-wasm.mjs';
import {actorRenderFeedback} from './actor-render-feedback.mjs';
import {meshVertexNormals,meshEnvironmentUV} from '../runtime/mesh-environment.mjs';

export {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';
import {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';

/** Live NPC mesh binding: update() resamples GetFrame whenever the shared
 * runtime's pose fields change, so original startup/animation is visible in
 * ordinary Play without preview controls. Original mesh lighting remains a
 * boundary. Contracts and captured cache identity: docs/npc-mesh-preview.md. */
export async function createTrainingNpcPreview(runtime,assets,asset,{kernel}={}) {
  if(asset.name.toLowerCase()!=='00_training')throw new Error('NPC preview requires Training');
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  // Measured GObjObjects identities from the same original Training capture.
  // These select fixtures and cache keys, never character-specific drawing.
  const root=new THREE.Group(),actors=[],errors=[];root.visible=false;
  for(const [name,originalObjectIndex] of Object.entries(TRAINING_NPC_IDENTITIES)) {
    try {
      const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()));
      if(runtime.namedReference(actor,'bHidden').get())continue;
      const preview=await createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel});
      preview.root.visible=true;root.add(preview.root);actors.push(preview);
    } catch(error) {errors.push({actor:name,message:error.message});}
  }
  if(!actors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; '));
  return {root,actors,update(cameraPosition){for(const actor of actors)actor.update(cameraPosition);},
    dispose(){for(const actor of actors)actor.dispose();},
    summary:{actors:actors.map(actor=>actor.summary),errors,poseBackend:kernel?.name??'javascript',kernelError,
      triangles:actors.reduce((total,actor)=>total+actor.summary.triangles,0),
      shading:'texture-only inspection',startup:'original'}};
}

/** Whole-level actor mesh layer for Play: the captured NPC bindings above plus
 * every other visible LodMesh actor (crates, plants, weapons/ammo pickups,
 * datacubes, keypads, cameras, lights) so the collidable props JC walks into
 * and frobs are no longer invisible. Props use a synthetic per-actor cache key:
 * `createActorMeshPreview` owns an isolated GetFrame cache per actor, and that
 * key selects only tween/blend heap identity, never the drawn geometry — these
 * props carry AnimSequence None, so a synthetic key is exact. The measured NPC
 * identities keep their captured index for animation-history fidelity. Shading
 * stays texture-only, as documented for the NPC layer. */
export async function createActorMeshScene(runtime,assets,asset,{kernel,player}={}) {
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  const root=new THREE.Group();root.visible=false;
  const npcActors=[],propActors=[],errors=[];
  let npc=null;
  if(asset.name.toLowerCase()==='00_training') {
    try {
      npc=await createTrainingNpcPreview(runtime,assets,asset,{kernel});
      root.add(npc.root);npc.root.visible=true;
      npcActors.push(...npc.actors);errors.push(...npc.summary.errors);
    } catch(error) {errors.push({actor:'NPCs',message:error.message});}
  }
  const level=player?runtime.levelFor(player):null;
  const read=(actor,name)=>{try{return runtime.namedReference(actor,name).get();}catch{return undefined;}};
  let synthetic=0x40000000;
  for(const actor of level?.actors??[]) {
    if(!actor||actor===player||actor.name in TRAINING_NPC_IDENTITIES)continue;
    const mesh=read(actor,'Mesh');
    if(!mesh||!['LodMesh','Mesh'].includes(mesh.kind))continue;
    if(read(actor,'bHidden')||read(actor,'bDeleteMe')||!read(actor,'Location'))continue;
    try {
      const preview=await createActorMeshPreview(runtime,assets,actor,{originalObjectIndex:synthetic++,kernel});
      preview.root.visible=true;root.add(preview.root);propActors.push(preview);
    } catch(error) {errors.push({actor:actor.name??'?',message:error.message});}
  }
  const actors=[...npcActors,...propActors];
  if(!actors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; ')||'No mesh actors resolved');
  return {root,actors,npcActors,propActors,
    update(cameraPosition){for(const actor of actors)actor.update(cameraPosition);},
    dispose(){for(const actor of actors)actor.dispose();},
    summary:{actors:actors.map(actor=>actor.summary),errors,poseBackend:kernel?.name??'javascript',kernelError,
      npcs:npcActors.length,props:propActors.length,
      triangles:actors.reduce((total,actor)=>total+actor.summary.triangles,0),
      shading:'texture-only inspection',startup:'original'}};
}

export async function createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel=null}) {
  const read=(object,name)=>runtime.namedReference(object,name).get();
  const rendered=actorRenderFeedback(runtime,actor);
  const actorName=read(actor,'Name');
  const meshReference=read(actor,'Mesh');
  const payload=await runtime.prepareMesh(actor);
  // GetFrame's tween cache must survive draw submissions. Recreating it each
  // frame jumps straight to the new sequence instead of blending from the
  // previous displayed pose. This cache owns only this inspection identity.
  const cache=createLodMeshFrameCache(),coords=[0,0,0,1,0,0,0,1,0,0,0,1];
  const services={cache,kernel,read,objectIndex:object=>{
    if(object!==actor)throw new Error('Owner-driven mesh inspection requires a captured owner identity');
    return originalObjectIndex;
  }};
  const frame=getLodMeshFrame(payload,actor,coords,services);
  const faces=runtime.getActorMeshSurfaces(actor),textures=new TextureStore(assets);
  const hasEnvironment=faces.some(face=>face.flags&POLY.Environment);
  let points=null,normals=null;
  function updateNormals(){
    const vertices=new DataView(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength);
    points=Array.from({length:frame.output.byteLength/12},(_,i)=>[0,4,8].map(o=>vertices.getFloat32(i*12+o,true)));
    normals=meshVertexNormals(points,faces);
  }
  if(hasEnvironment)updateNormals();
  const environmentTexture=()=>{
    const direct=read(actor,'Texture');if(direct)return direct;
    const region=read(actor,'Region'),zone=region['engine.actor.pointregion.zone'];
    const fromZone=zone&&read(zone,'EnvironmentMap');if(fromZone)return fromZone;
    const fromLevel=read(read(actor,'Level'),'EnvironmentMap');if(fromLevel)return fromLevel;
    let fallback=null;
    for(let i=0;i<payload.objectReferences.length;i++)fallback=runtime.getActorMeshTexture(actor,i)??fallback;
    return fallback;
  };
  const root=new THREE.Group(),materials=[],gpuTextures=[],groups=new Map();
  let disposed=false,lastPose=null;
  root.name=`${actorName} authored mesh inspection`;root.visible=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;
    root.traverse(object=>object.geometry?.dispose());
    for(const material of materials)material.dispose();
    for(const texture of gpuTextures)texture.dispose();
    // A failed pose may have left an internal lease outstanding; disposal
    // still releases this private cache and must not mask the original error.
    cache.entries.clear();
  };
  const pose=()=>{
    const animationActor=read(actor,'bAnimByOwner')?(read(actor,'Owner')??actor):actor;
    return [animationActor,read(animationActor,'bParticles'),read(actor,'DrawScale'),
      ...read(actor,'Location'),...read(actor,'Rotation'),...read(actor,'PrePivot'),
      read(animationActor,'AnimSequence'),read(animationActor,'AnimFrame'),
      ...read(animationActor,'BlendAnimSequence'),...read(animationActor,'BlendAnimFrame')];
  };
  const copyPositions=(positions,indices)=>{
    const vertices=new DataView(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength);
    for(let corner=0;corner<indices.length;corner++){
      const offset=indices[corner]*12,at=corner*3;
      // Same reflection as toView, retaining the original special-vertex prefix.
      positions[at]=vertices.getFloat32(offset+4,true);
      positions[at+1]=vertices.getFloat32(offset+8,true);
      positions[at+2]=-vertices.getFloat32(offset,true);
    }
  };
  try {
    for(const [faceIndex,face] of faces.entries()) {
      if(face.flags&POLY.Invisible)continue;
      const reference=face.flags&POLY.Environment?environmentTexture():runtime.getActorMeshTexture(actor,face.texture);
      if(!reference)throw new Error(`${actorName} skin slot ${face.texture} is empty`);
      const key=`${reference.key}:${face.flags}`;
      if(!groups.has(key))groups.set(key,{reference,flags:face.flags,indices:[],uvs:[],faces:[]});
      const group=groups.get(key);
      for(const corner of [0,2,1]) {
        group.indices.push(face.vertices[corner]);
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
      const positions=new Float32Array(group.indices.length*3);copyPositions(positions,group.indices);
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(group.uvs,2));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      group.geometry=geometry;
      const mesh=new THREE.Mesh(geometry,material);
      mesh.onAfterRender=rendered;
      mesh.userData={actor:`${actorName} (mesh inspection)`,faces:group.faces};root.add(mesh);
    }
    const summary={actor:actorName,mesh:meshReference.key,triangles:faces.length,
        textures:[...new Set([...groups.values()].map(group=>group.reference.key))],
        animation:read(actor,'AnimSequence'),frame:read(actor,'AnimFrame'),
        shading:'texture-only inspection',startup:'original'};
    lastPose=pose();
    return {root,dispose,
      get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
      update(cameraPosition){
        if(disposed)return false;
        root.visible=!read(actor,'bHidden')&&!read(actor,'bDeleteMe');
        if(!root.visible)return false;
        if(read(actor,'Mesh')!==meshReference)throw new Error(`${actorName} changed Mesh; rebuilding the inspection resource is unsupported`);
        const current=pose();
        const poseChanged=!current.every((value,index)=>Object.is(value,lastPose[index]));
        if(poseChanged){
          getLodMeshFrame(payload,actor,coords,services,{output:frame.output});
          if(hasEnvironment)updateNormals();
          for(const group of groups.values()){
            const positions=group.geometry.getAttribute('position');
            copyPositions(positions.array,group.indices);positions.needsUpdate=true;
            group.geometry.computeBoundingBox();group.geometry.computeBoundingSphere();
          }
        }
        if(hasEnvironment&&cameraPosition){
          for(const group of groups.values())if(group.flags&POLY.Environment){
            const uv=group.geometry.getAttribute('uv');
            for(let i=0;i<group.indices.length;i++){
              const index=group.indices[i];
              uv.array.set(meshEnvironmentUV(points[index].map((v,j)=>Math.fround(v-cameraPosition[j])),normals[index]),i*2);
            }
            uv.needsUpdate=true;
          }
        }
        lastPose=current;summary.animation=read(actor,'AnimSequence');summary.frame=read(actor,'AnimFrame');
        return poseChanged||hasEnvironment;
      },summary};
  } catch(error) {dispose();throw error;}
}
