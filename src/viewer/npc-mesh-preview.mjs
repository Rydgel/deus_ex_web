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
      if(runtime.readNamed(actor,'bHidden'))continue;
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
/** `player` is the player actor or a getter for it: Player start logs a new
 * player in, so the viewer passes a getter. */
export async function createActorMeshScene(runtime,assets,asset,{kernel,player:playerSource}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource??null;
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
  const level=currentPlayer()?runtime.levelFor(currentPlayer()):null;
  const read=(actor,name)=>{try{return runtime.readNamed(actor,name);}catch{return undefined;}};
  // Render.dll's level-actor pass (0x10b22e27-0x10b22ef8), for the player's
  // first-person frame: skip the view actor's ViewTarget (+0x60c) unless
  // bBehindView, a hidden actor, a bOnlyOwnerSee actor the view actor does not
  // own (IsOwnedBy walks Owner +0x3c) or sees from behind, and a bOwnerNoSee
  // actor it owns in first person. The view actor itself is never admitted.
  // SkilledTool's DownItem unhides the held tool, so it is drawn here too.
  const drawnInWorld=actor=>{
    if(read(actor,'bHidden')||read(actor,'bDeleteMe'))return false;
    const player=currentPlayer();
    if(!player)return true;
    const behind=Boolean(read(player,'bBehindView'));
    if(!behind&&read(player,'ViewTarget')===actor)return false;
    let owned=false;
    for(let owner=actor;owner;owner=read(owner,'Owner'))if(owner===player){owned=true;break;}
    if(read(actor,'bOnlyOwnerSee')&&(!owned||behind))return false;
    return !(owned&&read(actor,'bOwnerNoSee')&&!behind);
  };
  let synthetic=0x40000000,disposed=false;
  const actors=[...npcActors],bindings=new Map(npcActors.map(preview=>[preview.actor,preview]));
  const pending=new Map(),failed=new WeakMap();
  const summary={actors:[],errors,poseBackend:kernel?.name??'javascript',kernelError,
    npcs:npcActors.length,props:0,skipped:[],triangles:0,
    shading:'texture-only inspection',startup:'original'};
  const refreshSummary=()=>{
    summary.actors=actors.map(actor=>actor.summary);summary.props=propActors.length;summary.npcs=npcActors.length;
    summary.skipped=actors.flatMap(actor=>actor.summary.skipped.map(s=>({actor:actor.summary.actor,...s})));
    summary.triangles=actors.reduce((total,actor)=>total+actor.summary.triangles,0);
  };
  const admit=actor=>{
    const mesh=read(actor,'Mesh');
    if(disposed||!actor||actor===currentPlayer()||bindings.has(actor)||pending.has(actor)||failed.get(actor)===mesh)return;
    if(!mesh||!['LodMesh','Mesh'].includes(mesh.kind)||!drawnInWorld(actor)||!read(actor,'Location'))return;
    const npc=retired.get(actor)??false;retired.delete(actor);
    const task=createActorMeshPreview(runtime,assets,actor,{originalObjectIndex:synthetic++,kernel,visible:drawnInWorld})
      .then(preview=>{
        if(disposed||!level.actors.includes(actor)||read(actor,'bDeleteMe')||read(actor,'Mesh')!==mesh){preview.dispose();return;}
        preview.root.visible=drawnInWorld(actor);root.add(preview.root);
        bindings.set(actor,preview);actors.push(preview);(npc?npcActors:propActors).push(preview);refreshSummary();
      }).catch(error=>{failed.set(actor,mesh);errors.push({actor:actor.name??'?',message:error.message});})
      .finally(()=>pending.delete(actor));
    pending.set(actor,task);
  };
  const retired=new WeakMap();
  const retire=(actor,preview)=>{
    preview.root.removeFromParent();preview.dispose();bindings.delete(actor);
    for(const list of [actors,propActors,npcActors]){const at=list.indexOf(preview);if(at>=0)list.splice(at,1);}
    refreshSummary();
  };
  const reconcile=()=>{
    if(disposed||!level)return;
    const live=new Set(level.actors);
    for(const [actor,preview] of bindings){
      if(!live.has(actor))retire(actor,preview);
      // A script can change Mesh (Inventory.BecomeItem/BecomePickup). The new
      // mesh is admitted like a newly visible actor; its resources decode
      // asynchronously, so it appears once they are ready.
      else if(read(actor,'Mesh')!==preview.mesh){retired.set(actor,npcActors.includes(preview));retire(actor,preview);}
    }
    for(const actor of live)admit(actor);
  };
  reconcile();await Promise.all(pending.values());refreshSummary();
  if(!actors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; ')||'No mesh actors resolved');
  return {root,actors,npcActors,propActors,summary,
    update(cameraPosition){reconcile();for(const actor of actors)actor.update(cameraPosition);},
    // Asset decode is asynchronous; useful both for load and focused integration checks.
    async ready(){await Promise.all(pending.values());},
    dispose(){disposed=true;for(const actor of actors)actor.dispose();},
  };
}

export async function createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel=null,drawActor=false,visible=null}) {
  const read=(object,name)=>runtime.readNamed(object,name);
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
  const root=new THREE.Group(),materials=[],gpuTextures=[],groups=new Map(),skipped=[];
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
    const failed=[];
    for(const [key,group] of groups) {
      try {
        let flags=group.flags;
        let data=await textures.get(group.reference.asset,group.reference.index,Boolean(flags&POLY.Masked));
        if(data.procedural||data.values.AnimNext)throw new Error('Animated/procedural mesh skin is unsupported');
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
      } catch(error) {
        // Skip a single undecodable face group (e.g. a procedural FireTexture
        // effect face) and keep drawing the mesh's solid faces. Animated and
        // procedural mesh skins stay unsupported; the drawn faces are exact.
        failed.push(key);skipped.push({texture:group.reference.key,message:error.message});
      }
    }
    // Drop skipped groups so the live pose/UV updates only touch drawn geometry.
    for(const key of failed)groups.delete(key);
    if(!root.children.length)
      throw new Error(skipped.map(s=>`${s.texture}: ${s.message}`).join('; ')||`${actorName} has no renderable faces`);
    const summary={actor:actorName,mesh:meshReference.key,skipped,
        triangles:[...groups.values()].reduce((total,group)=>total+group.faces.length,0),
        textures:[...new Set([...groups.values()].map(group=>group.reference.key))],
        animation:read(actor,'AnimSequence'),frame:read(actor,'AnimFrame'),
        shading:'texture-only inspection',startup:'original'};
    lastPose=pose();
    return {actor,root,dispose,mesh:meshReference,
      get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
      update(cameraPosition){
        if(disposed)return false;
        root.visible=visible?visible(actor):(drawActor||!read(actor,'bHidden'))&&!read(actor,'bDeleteMe');
        if(!root.visible)return false;
        if(read(actor,'Mesh')!==meshReference)throw new Error(`${actorName} changed Mesh; rebuilding the inspection resource is unsupported`);
        // Actor.uc declares ScaleGlow as the lighting multiplier. This applies
        // it to this renderer's explicitly texture-only inspection lighting.
        const glow=Math.min(1,read(actor,'ScaleGlow')),style=read(actor,'Style');
        for(const material of materials){
          material.color.setRGB(glow,glow,glow);
          const flags=material.userData.flags;
          const translucent=style===3||Boolean(flags&POLY.Translucent);
          const modulated=!translucent&&(style===4||Boolean(flags&POLY.Modulated));
          material.transparent=translucent||modulated;material.depthWrite=!material.transparent;
          material.blending=material.transparent?THREE.CustomBlending:THREE.NormalBlending;
          material.blendSrc=translucent?THREE.OneFactor:THREE.DstColorFactor;
          material.blendDst=translucent?THREE.OneMinusSrcColorFactor:THREE.SrcColorFactor;
          material.alphaTest=(style===2||Boolean(flags&POLY.Masked)) ? 0.5 : 0;
        }
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
        const environmentUpload=Boolean(hasEnvironment&&cameraPosition);
        if(environmentUpload){
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
        // True when a buffer was re-uploaded: pose positions, or the
        // camera-relative environment UVs, which change with the viewer.
        return poseChanged||environmentUpload;
      },summary};
  } catch(error) {dispose();throw error;}
}
