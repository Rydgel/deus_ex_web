import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {ActorMeshTextures} from './actor-mesh-textures.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {createLodMeshFrameCache,getLodMeshFrame,planLodMeshFrame,materializeLodMeshFrame} from '../runtime/lodmesh-frame.mjs';
import {loadLodMeshKernel} from '../runtime/lodmesh-wasm.mjs';
import {actorRenderFeedback} from './actor-render-feedback.mjs';
import {actorsEpoch} from '../runtime/base-epoch.mjs';
import {fieldAccessor,fieldAccessors} from './actor-fields.mjs';
import {displayRampGlsl} from './light-atlas.mjs';
import {meshVertexNormalsInto,writeMeshEnvironmentUV} from '../runtime/mesh-environment.mjs';
import {copyMeshLightColors} from './mesh-light-colors.mjs';
import {DRAW_VERTEX_DECLARATIONS} from './gpu-mesh.mjs';
import {createActorBatches,BATCH_VERTEX_DECLARATIONS,BATCH_VERTEX_TAIL} from './actor-batches.mjs';
import {keyframeBoxes,advanceChannelBox,viewBox,certifyFrustum} from './gpu-mesh-bounds.mjs';

export {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';
import {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';

/** Live NPC mesh binding: update() resamples GetFrame whenever the shared
 * runtime's pose fields change, so original startup/animation is visible in
 * ordinary Play without preview controls. Contracts and captured cache
 * identity: docs/npc-mesh-preview.md; lighting: docs/mesh-lighting.md. */
export async function createTrainingNpcPreview(runtime,assets,asset,{kernel,lighting=null,displayGamma,texturePool=null,gpu=null,batches=null}={}) {
  if(asset.name.toLowerCase()!=='00_training')throw new Error('NPC preview requires Training');
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  // Measured GObjObjects identities from the same original Training capture.
  // These select fixtures and cache keys, never character-specific drawing.
  const root=new THREE.Group(),actors=[],errors=[],textures=texturePool??new ActorMeshTextures();root.visible=false;
  for(const [name,originalObjectIndex] of Object.entries(TRAINING_NPC_IDENTITIES)) {
    try {
      const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()));
      if(runtime.readNamed(actor,'bHidden'))continue;
      const preview=await createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel,lighting,displayGamma,texturePool:textures,gpu,batches});
      preview.root.visible=true;root.add(preview.root);actors.push(preview);
    } catch(error) {errors.push({actor:name,message:error.message});}
  }
  if(!actors.length){if(!texturePool)textures.dispose();throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; '));}
  return {root,actors,update(cameraPosition,view={}){for(const actor of actors)actor.update(cameraPosition,view);},
    dispose(){for(const actor of actors)actor.dispose();if(!texturePool)textures.dispose();},
    summary:{actors:actors.map(actor=>actor.summary),errors,poseBackend:kernel?.name??'javascript',kernelError,
      triangles:actors.reduce((total,actor)=>total+actor.summary.triangles,0),
      shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original'}};
}

/** Whole-level actor mesh layer for Play: the captured NPC bindings above plus
 * every other visible LodMesh actor (crates, plants, weapons/ammo pickups,
 * datacubes, keypads, cameras, lights) so the collidable props JC walks into
 * and frobs are no longer invisible. Props use a synthetic per-actor cache key:
 * `createActorMeshPreview` owns an isolated GetFrame cache per actor, and that
 * key selects only tween/blend heap identity, never the drawn geometry — these
 * props carry AnimSequence None, so a synthetic key is exact. The measured NPC
 * identities keep their captured index for animation-history fidelity. */
/** `player` is the player actor or a getter for it: Player start logs a new
 * player in, so the viewer passes a getter. */
export async function createActorMeshScene(runtime,assets,asset,{kernel,player:playerSource,lighting=null,displayGamma,gpu=null}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource??null;
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  const root=new THREE.Group(),textures=new ActorMeshTextures();root.visible=false;root.matrixAutoUpdate=false;
  // Opaque GPU-path groups that share a material state draw as one batch
  // (actor-batches.mjs); only with original lighting, where every actor's
  // material colour is the same.
  const batches=gpu&&lighting?createActorBatches(root,{makeMaterial:(template,members)=>
    batchMaterial(template,members,gpu,displayGamma)}):null;
  const npcActors=[],propActors=[],errors=[];
  let npc=null;
  if(asset.name.toLowerCase()==='00_training') {
    try {
      npc=await createTrainingNpcPreview(runtime,assets,asset,{kernel,lighting,displayGamma,texturePool:textures,gpu,batches});
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
  // The viewer's fields, read once per update (no script runs while the
  // actor layer updates); asynchronous admission reads them afresh.
  let frameViewer=null;
  const viewer=()=>{
    if(frameViewer)return frameViewer;
    const player=currentPlayer();
    return player?{player,behind:Boolean(read(player,'bBehindView')),viewTarget:read(player,'ViewTarget')}:{player:null};
  };
  const drawnInWorld=(actor,own=null)=>{
    if(own?(own.bHidden()||own.bDeleteMe()):(read(actor,'bHidden')||read(actor,'bDeleteMe')))return false;
    const {player,behind,viewTarget}=viewer();
    if(!player)return true;
    if(!behind&&viewTarget===actor)return false;
    let owned=false;
    for(let owner=actor;owner;owner=own&&owner===actor?own.Owner():read(owner,'Owner'))if(owner===player){owned=true;break;}
    if((own?own.bOnlyOwnerSee():read(actor,'bOnlyOwnerSee'))&&(!owned||behind))return false;
    return !(owned&&(own?own.bOwnerNoSee():read(actor,'bOwnerNoSee'))&&!behind);
  };
  let synthetic=0x40000000,disposed=false;
  const actors=[...npcActors],bindings=new Map(npcActors.map(preview=>[preview.actor,preview]));
  const pending=new Map(),failed=new WeakMap();
  const summary={actors:[],errors,poseBackend:kernel?.name??'javascript',kernelError,gpu:Boolean(gpu),
    npcs:npcActors.length,props:0,skipped:[],triangles:0,
    shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original'};
  const refreshSummary=()=>{
    summary.actors=actors.map(actor=>actor.summary);summary.props=propActors.length;summary.npcs=npcActors.length;
    summary.skipped=actors.flatMap(actor=>actor.summary.skipped.map(s=>({actor:actor.summary.actor,...s})));
    summary.triangles=actors.reduce((total,actor)=>total+actor.summary.triangles,0);
  };
  const admit=(actor,readMesh=null)=>{
    if(disposed||!actor||actor===currentPlayer()||bindings.has(actor)||pending.has(actor))return;
    let mesh;
    if(readMesh){try{mesh=readMesh();}catch{mesh=undefined;}}else mesh=read(actor,'Mesh');
    if(failed.get(actor)===mesh)return;
    if(!mesh||!['LodMesh','Mesh'].includes(mesh.kind)||!drawnInWorld(actor)||!read(actor,'Location'))return;
    const npc=retired.get(actor)??false;retired.delete(actor);
    const task=createActorMeshPreview(runtime,assets,actor,{originalObjectIndex:synthetic++,kernel,visible:drawnInWorld,
      lighting,displayGamma,texturePool:textures,gpu,batches})
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
  // Level.Actors membership only changes with actorsEpoch (base-epoch.mjs),
  // so the membership set is rebuilt only then.
  // Every actor's Mesh is read every update through an accessor
  // (actor-fields.mjs) kept in Level.Actors order.
  let live=null,liveEpoch=-1,liveList=[],meshReaders=[];
  const meshAccessors=new Map();
  const reconcile=()=>{
    if(disposed||!level)return;
    const epoch=actorsEpoch();
    if(epoch!==liveEpoch||!live){
      live=new Set(level.actors);liveEpoch=epoch;liveList=[...live];
      const next=new Map();
      meshReaders=liveList.map(actor=>{
        if(!actor)return null;
        const reader=meshAccessors.get(actor)??fieldAccessor(runtime,actor,'Mesh');
        next.set(actor,reader);return reader;
      });
      meshAccessors.clear();for(const [actor,reader] of next)meshAccessors.set(actor,reader);
    }
    for(const [actor,preview] of bindings){
      if(!live.has(actor))retire(actor,preview);
      // A script can change Mesh (Inventory.BecomeItem/BecomePickup). The new
      // mesh is admitted like a newly visible actor; its resources decode
      // asynchronously, so it appears once they are ready.
      else if(preview.readMesh()!==preview.mesh){retired.set(actor,npcActors.includes(preview));retire(actor,preview);}
    }
    for(let i=0;i<liveList.length;i++)admit(liveList[i],meshReaders[i]);
  };
  reconcile();await Promise.all(pending.values());refreshSummary();
  if(!actors.length){textures.dispose();throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; ')||'No mesh actors resolved');}
  return {root,actors,npcActors,propActors,summary,kernel,
    /** `view.lit` marks the main viewport frame, whose drawn actors get one
     * SetupForActor/Light pass each; mirror frames reuse those colours. */
    update(cameraPosition,view={}){
      frameViewer=null;frameViewer=viewer();
      try{
        reconcile();
        if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
        for(const actor of actors)actor.update(cameraPosition,view);
      }finally{frameViewer=null;}
      // The GPU path's passes (docs/gpu-mesh.md) run once per main frame,
      // after every actor planned its pose and lighting.
      if(gpu){const frame=lighting?.frame;if(frame)gpu.setCamera(frame.origin,frame.axes);gpu.run();}
      batches?.flush();
    },
    /** Mirror child frames change only camera-relative environment UVs.  The
     * main-frame update immediately before them already reconciled actors,
     * sampled poses, applied styles and lit the geometry. GPU-path groups
     * also take this pass's frustum decision (`camera`, the pass camera). */
    updateView(cameraPosition,camera=null){
      if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
      for(const actor of actors){
        if(actor.viewDependent)actor.updateView(cameraPosition);
        if(camera)actor.passVisibility?.(camera);
      }
      batches?.flush();
    },
    // Asset decode is asynchronous; useful both for load and focused integration checks.
    async ready(){await Promise.all(pending.values());},
    batchStats:()=>batches?.stats()??null,
    dispose(){disposed=true;for(const actor of actors)actor.dispose();batches?.dispose();textures.dispose();},
  };
}

/** BufferGeometry.computeBoundingBox + computeBoundingSphere (three.js
 * r186) for a plain position array without morph targets, in one pass: the
 * same Math.min/max expansion, empty-box centre, (min + max) * 0.5 centre and
 * largest dx*dx + dy*dy + dz*dz, so frustum culling sees identical bounds. */
function setMeshBounds(geometry,array){
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for(let i=0;i<array.length;i+=3){
    const x=array[i],y=array[i+1],z=array[i+2];
    minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);
    maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);
  }
  geometry.boundingBox??=new THREE.Box3();
  geometry.boundingBox.min.set(minX,minY,minZ);geometry.boundingBox.max.set(maxX,maxY,maxZ);
  geometry.boundingSphere??=new THREE.Sphere();
  const center=geometry.boundingSphere.center;
  if(maxX<minX||maxY<minY||maxZ<minZ)center.set(0,0,0);
  else center.set((minX+maxX)*0.5,(minY+maxY)*0.5,(minZ+maxZ)*0.5);
  let maxRadiusSq=0;
  for(let i=0;i<array.length;i+=3){
    const dx=center.x-array[i],dy=center.y-array[i+1],dz=center.z-array[i+2];
    maxRadiusSq=Math.max(maxRadiusSq,dx*dx+dy*dy+dz*dz);
  }
  geometry.boundingSphere.radius=Math.sqrt(maxRadiusSq);
}

export async function createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel=null,drawActor=false,visible=null,
  lighting=null,displayGamma={value:1},texturePool=null,gpu=null,batches=null}) {
  // This actor's per-frame reads through pre-resolved accessors
  // (actor-fields.mjs); any other object or name reads through readNamed.
  const own=fieldAccessors(runtime,actor,['bHidden','bDeleteMe','Location','PrePivot','DrawScale','Mesh','Style',
    'ScaleGlow','bAnimByOwner','Owner','bParticles','Rotation','AnimSequence','AnimFrame','BlendAnimSequence',
    'BlendAnimFrame','Name','bOnlyOwnerSee','bOwnerNoSee']);
  const read=(object,name)=>object===actor&&Object.hasOwn(own,name)?own[name]():runtime.readNamed(object,name);
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
  const faces=runtime.getActorMeshSurfaces(actor),textures=new TextureStore(assets),gpuTextures=texturePool??new ActorMeshTextures();
  const faceWords=new Uint32Array(faces.length*4);
  faces.forEach((face,i)=>faceWords.set([...face.vertices,face.flags>>>0],i*4));
  const hasEnvironment=faces.some(face=>face.flags&POLY.Environment);
  // GPU path (docs/gpu-mesh.md): GetFrame is planned here and evaluated on
  // the GPU, which also lights the mesh. The CPU path below stays the
  // reference and the fallback; `gpuFallback` records why an actor left it.
  let mode='cpu',gpuHandle=null,gpuFallback=null,lastPlan=null,exactValid=false,plannedFrame=-1;
  if(gpu){
    try{gpuHandle=gpu.allocate(payload,faceWords,{environment:hasEnvironment});mode='gpu';}
    catch(error){gpuFallback=error.message;}
  }
  const frame=mode==='gpu'?planFirst():getLodMeshFrame(payload,actor,coords,services);
  function planFirst(){
    lastPlan=planLodMeshFrame(payload,actor,coords,services);
    return {output:lastPlan.context.output,vertexCount:lastPlan.vertexCount};
  }
  // Host culling bound, never drawn geometry: the farthest vertex of every
  // animation frame from the mesh origin, plus the origin offset, in mesh
  // units. update() scales it by the mesh Scale and DrawScale around
  // Location+PrePivot, so it contains any pose GetFrame can produce.
  const cullRadius=(()=>{
    const data=payload.arrays.get(0x60).load().data;
    const vertices=new DataView(data.buffer,data.byteOffset,data.byteLength);
    let farthest=0;
    for(let at=0;at+6<=vertices.byteLength;at+=8){
      const x=vertices.getInt16(at,true),y=vertices.getInt16(at+2,true),z=vertices.getInt16(at+4,true);
      farthest=Math.max(farthest,x*x+y*y+z*z);
    }
    const origin=payload.origin;
    return (Math.sqrt(farthest)+Math.hypot(origin[0],origin[1],origin[2]))*Math.max(...payload.scale.map(Math.abs));
  })();
  const cullSphere=new THREE.Sphere();
  // The posed x,y,z floats (GetFrame's 12-byte stride) and their
  // environment normals, recomputed whenever the pose changes.
  let points=null,normals=null;
  const faceIndices=hasEnvironment?Uint32Array.from(faces.flatMap(face=>face.vertices)):null;
  function updateNormals(){
    points??=new Float32Array(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength/4);
    normals??=new Float32Array(points.length);
    meshVertexNormalsInto(points,faceIndices,normals);
  }
  if(hasEnvironment&&mode==='cpu')updateNormals();
  const environmentTexture=()=>{
    const direct=read(actor,'Texture');if(direct)return direct;
    const region=read(actor,'Region'),zone=region['engine.actor.pointregion.zone'];
    const fromZone=zone&&read(zone,'EnvironmentMap');if(fromZone)return fromZone;
    const fromLevel=read(read(actor,'Level'),'EnvironmentMap');if(fromLevel)return fromLevel;
    let fallback=null;
    for(let i=0;i<payload.objectReferences.length;i++)fallback=runtime.getActorMeshTexture(actor,i)??fallback;
    return fallback;
  };
  // Actor meshes hold world-space positions: their transforms stay identity,
  // so three.js need not recompose their local matrices every traversal.
  const root=new THREE.Group(),materials=[],textureLeases=[],groups=new Map(),skipped=[];root.matrixAutoUpdate=false;
  let disposed=false,lastPose=null,lastStyle,lastGlow,materialStateApplied=false;
  const gpuUniform={value:mode==='gpu'?1:0};
  root.name=`${actorName} authored mesh inspection`;root.visible=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;
    root.traverse(object=>object.geometry?.dispose());
    for(const material of materials)material.dispose();
    for(const lease of textureLeases)lease.release();
    if(!texturePool)gpuTextures.dispose();
    kernel?.releaseLightingMesh?.(faceWords);
    for(const group of groups.values())if(group.batchEntry){batches.remove(group.batchEntry);group.batchEntry=null;}
    if(gpuHandle)gpu.release(gpuHandle);
    // A failed pose may have left an internal lease outstanding; disposal
    // still releases this private cache and must not mask the original error.
    cache.entries.clear();
  };
  const pose=()=>{
    const animationActor=own.bAnimByOwner()?(own.Owner()??actor):actor;
    const self=animationActor===actor;
    return [animationActor,self?own.bParticles():read(animationActor,'bParticles'),own.DrawScale(),
      ...own.Location(),...own.Rotation(),...own.PrePivot(),
      self?own.AnimSequence():read(animationActor,'AnimSequence'),self?own.AnimFrame():read(animationActor,'AnimFrame'),
      ...(self?own.BlendAnimSequence():read(animationActor,'BlendAnimSequence')),
      ...(self?own.BlendAnimFrame():read(animationActor,'BlendAnimFrame'))];
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
  // One DrawLodMesh lighting pass (docs/mesh-lighting.md) over every face in
  // draw order; each group's corners take their face's colours.
  let previousColors=null,colorWords=null,lastSetup=null,lastLitFrame=-1;
  function relight(prepared){
    const points=new Float32Array(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength/4);
    const result=lighting.lightMesh(actor,points,faces,faceWords,prepared);
    if(!result)return null;
    const colors=result.colors;
    if(colors!==previousColors){
      previousColors=colors;colorWords=new Uint32Array(colors.buffer,colors.byteOffset,colors.length);
    }
    for(const group of groups.values()){
      // The returned colors are FISTP-byte/255 Float32 values. Compare their
      // exact words before scattering; unchanged GPU data needs no upload.
      if(copyMeshLightColors(group.lightWords,colorWords,group.faces))
        group.geometry.getAttribute('deusLight').needsUpdate=true;
    }
    return {lights:result.setup.lights.length,flags:result.flags};
  }
  try {
    for(const [faceIndex,face] of faces.entries()) {
      if(face.flags&POLY.Invisible)continue;
      const reference=face.flags&POLY.Environment?environmentTexture():runtime.getActorMeshTexture(actor,face.texture);
      if(!reference)throw new Error(`${actorName} skin slot ${face.texture} is empty`);
      const key=`${reference.key}:${face.flags}`;
      if(!groups.has(key))groups.set(key,{reference,flags:face.flags,indices:[],uvs:[],faces:[],corners:[]});
      const group=groups.get(key);
      for(const corner of [0,2,1]) {
        group.indices.push(face.vertices[corner]);
        group.uvs.push(...face.uv[corner].map(value=>value/256));
        group.corners.push(faceIndex*3+corner);
      }
      group.faces.push(faceIndex);
    }
    const failed=[];
    for(const [key,group] of groups) {
      let textureLease;
      try {
        let flags=group.flags;
        let data=await textures.get(group.reference.asset,group.reference.index,Boolean(flags&POLY.Masked));
        if(data.procedural||data.values.AnimNext)throw new Error('Animated/procedural mesh skin is unsupported');
        for(const [name,flag] of Object.entries({bMasked:POLY.Masked,bTranslucent:POLY.Translucent,
          bTwoSided:POLY.TwoSided,bNoSmooth:POLY.NoSmooth,bModulated:POLY.Modulated}))
          if(data.values[name])flags|=flag;
        if(flags&POLY.Masked&&!data.masked)data=await textures.get(group.reference.asset,group.reference.index,true);
        // Keep the original private decoder/await sequence: only the GPU
        // resource is shared, synchronously, at its former allocation point.
        textureLease=gpuTextures.acquire(data,flags);textureLeases.push(textureLease);
        const texture=textureLease.texture,first=data.mips[0];
        // Keep texture sampling and recovered vertex lighting in the same
        // display-encoded space for the main framebuffer and mirror target.
        // D3D modulates the display-encoded texel by the vertex diffuse
        // (docs/mesh-lighting.md), before the display gamma ramp; the world
        // shader treats light maps the same way.
        // Style can switch a material to PF_Modulated at run time, so the
        // modulated display ramp (displayRampGlsl) is a uniform branch.
        const modulatedUniform={value:!(flags&POLY.Translucent)&&flags&POLY.Modulated?1:0};
        const environmentGroup=Boolean(group.flags&POLY.Environment);
        const makeMaterial=side=>{
          const material=new THREE.MeshBasicMaterial({map:texture,side,alphaTest:flags&POLY.Masked?.5:0});
          material.customProgramCacheKey=gpuHandle?()=>`deus-ex-mesh-gpu-v1:${environmentGroup?1:0}`
            :()=>'deus-ex-mesh-display-color-v3';
          material.onBeforeCompile=shader=>{
            shader.uniforms.deusDisplayGamma=displayGamma;shader.uniforms.deusModulated=modulatedUniform;
            if(gpuHandle){
              Object.assign(shader.uniforms,gpu.shared,{deusGpu:gpuUniform});
              shader.vertexShader=shader.vertexShader.replace('#include <common>',
                `#include <common>\nattribute vec3 deusLight;\nvarying vec3 vDeusLight;\n${DRAW_VERTEX_DECLARATIONS}`)
                .replace('#include <begin_vertex>',gpuBeginVertex(environmentGroup));
            } else shader.vertexShader=shader.vertexShader.replace('#include <common>',
              '#include <common>\nattribute vec3 deusLight;\nvarying vec3 vDeusLight;')
              .replace('#include <begin_vertex>','#include <begin_vertex>\nvDeusLight = deusLight;');
            shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
              '#include <common>\nuniform float deusDisplayGamma;\nuniform float deusModulated;\nvarying vec3 vDeusLight;')
              .replace('#include <colorspace_fragment>',
                'gl_FragColor = sRGBTransferOETF(gl_FragColor);\ngl_FragColor.rgb *= vDeusLight;\n'+
                `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
                `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
          };
          materials.push(material);
          if(flags&(POLY.Translucent|POLY.Modulated)) {
            material.transparent=true;material.depthWrite=false;material.blending=THREE.CustomBlending;
            material.blendSrc=flags&POLY.Translucent?THREE.OneFactor:THREE.DstColorFactor;
            material.blendDst=flags&POLY.Translucent?THREE.OneMinusSrcColorFactor:THREE.SrcColorFactor;
          }
          material.userData={key,flags,width:first.width,height:first.height,mipCount:data.mips.length,modulatedUniform};
          return material;
        };
        const material=makeMaterial(flags&POLY.TwoSided?THREE.DoubleSide:THREE.FrontSide);
        // A transparent double-sided material is drawn by three.js as a
        // back-face then a front-face draw of the same object, flipping its
        // side and marking it dirty twice per draw, which re-derives its
        // program every frame. Two-sided groups instead keep a back-side and
        // a front-side material and a twin mesh, used while the material is
        // transparent: the same two draws, back first, with no dirty material.
        const sided=flags&POLY.TwoSided?{double:material,back:makeMaterial(THREE.BackSide),
          front:makeMaterial(THREE.FrontSide)}:null;
        const geometry=new THREE.BufferGeometry();
        const positions=new Float32Array(group.indices.length*3);
        if(mode==='cpu')copyPositions(positions,group.indices);
        geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('uv',new THREE.Float32BufferAttribute(group.uvs,2));
        const lightColors=new Float32Array(group.indices.length*3).fill(1);
        group.lightWords=new Uint32Array(lightColors.buffer);
        geometry.setAttribute('deusLight',new THREE.BufferAttribute(lightColors,3)
          .setUsage(THREE.DynamicDrawUsage));
        if(gpuHandle){
          geometry.setAttribute('deusVertexTexel',new THREE.BufferAttribute(
            Float32Array.from(group.indices,index=>gpuHandle.vbase+index),1));
          geometry.setAttribute('deusCornerTexel',new THREE.BufferAttribute(
            Float32Array.from(group.corners,corner=>gpuHandle.cbase+corner),1));
          group.vertices=[...new Set(group.indices)].sort((a,b)=>a-b);
          group.boxes=keyframeBoxes(payload,group.vertices);
          group.channelBoxes=Array.from({length:5},()=>new Float64Array(6).fill(NaN));
          group.viewBox=new Float64Array(6).fill(NaN);
          group.exact={boundingBox:null,boundingSphere:null};
          group.mainVisible=true;
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        group.geometry=geometry;
        const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;
        mesh.onAfterRender=rendered;
        if(gpuHandle)mesh.frustumCulled=false;
        group.mesh=mesh;group.sided=sided;group.split=false;group.material=material;group.texture=texture;
        group.environment=environmentGroup;group.batchEntry=null;
        mesh.userData={actor:`${actorName} (mesh inspection)`,faces:group.faces};root.add(mesh);
        if(sided){
          // Created right after its mesh: the adjacent id keeps the pair
          // consecutive in three.js's transparent sort (equal depth).
          const twin=new THREE.Mesh(geometry,sided.front);twin.matrixAutoUpdate=false;
          twin.onAfterRender=rendered;twin.frustumCulled=mesh.frustumCulled;twin.visible=false;
          twin.userData={...mesh.userData,twinOf:mesh};group.twin=twin;root.add(twin);
        }
      } catch(error) {
        textureLease?.release();
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
        shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original',
        path:mode,gpuFallback};
    /** A group's visibility for the coming pass; a split two-sided group
     * draws its twin (front faces) with it. */
    function showGroup(group,visible){
      if(group.batchEntry){batches.set(group.batchEntry,visible);group.mesh.visible=false;return;}
      group.mesh.visible=visible;
      if(group.twin)group.twin.visible=visible&&group.split;
    }
    /** Batch membership follows the group's material state: an opaque
     * GPU-path group joins the batch of its texture, side, alpha test and
     * environment flag; a transparent one draws its own mesh. */
    function rebatch(group){
      const material=group.material,want=batches&&mode==='gpu'&&!material.transparent
        ?`${group.texture.uuid}:${material.side}:${material.alphaTest>0?1:0}:${group.environment?1:0}`:null;
      if(group.batchEntry&&group.batchEntry.key===want)return;
      if(group.batchEntry){batches.remove(group.batchEntry);group.batchEntry=null;}
      if(want){group.batchEntry={key:want,group,rendered,visible:false};batches.add(want,material,group.batchEntry);
        group.mesh.visible=false;}
    }
    /** An actor that is not drawn this frame: its batched groups too. */
    function hideBatched(){for(const group of groups.values())if(group.batchEntry)batches.set(group.batchEntry,false);}
    const updateView=cameraPosition=>{
      if(disposed||!root.visible||!hasEnvironment||!cameraPosition||mode!=='cpu')return false;
      const relative=[0,0,0],normal=[0,0,0];
      for(const group of groups.values())if(group.flags&POLY.Environment){
        const uv=group.geometry.getAttribute('uv');
        for(let i=0;i<group.indices.length;i++){
          const at=group.indices[i]*3;
          relative[0]=Math.fround(points[at]-cameraPosition[0]);relative[1]=Math.fround(points[at+1]-cameraPosition[1]);
          relative[2]=Math.fround(points[at+2]-cameraPosition[2]);
          normal[0]=normals[at];normal[1]=normals[at+1];normal[2]=normals[at+2];
          writeMeshEnvironmentUV(uv.array,i*2,relative,normal);
        }
        uv.needsUpdate=true;
      }
      return true;
    };

    // ---- GPU path: bounds, exact fallback and per-pass visibility.
    const scratchBounds=new Map();
    /** The exact CPU pose of the current plan and three.js's exact spheres. */
    function exactSpheres(){
      if(exactValid)return;
      materializeLodMeshFrame(lastPlan);
      for(const group of groups.values()){
        let positions=scratchBounds.get(group);
        if(!positions)scratchBounds.set(group,positions=new Float32Array(group.indices.length*3));
        copyPositions(positions,group.indices);
        setMeshBounds(group.exact,positions);
        // Transparent sorting uses the exact centre when it is known.
        group.geometry.boundingSphere.copy(group.exact.boundingSphere);
      }
      exactValid=true;
    }
    function boxSphere(group){
      const box=group.viewBox,sphere=group.geometry.boundingSphere;
      if(box.some(Number.isNaN))return;
      sphere.center.set((box[0]+box[3])/2,(box[1]+box[4])/2,(box[2]+box[5])/2);
      sphere.radius=Math.hypot(box[3]-box[0],box[4]-box[1],box[5]-box[2])/2;
    }
    // The union of the group boxes: a certain result for it holds for
    // every group (each group box lies inside it).
    const unionBox=new Float64Array(6);
    function updateUnion(){
      unionBox[0]=unionBox[1]=unionBox[2]=Infinity;unionBox[3]=unionBox[4]=unionBox[5]=-Infinity;
      for(const group of groups.values())for(let k=0;k<3;k++){
        unionBox[k]=Math.min(unionBox[k],group.viewBox[k]);unionBox[3+k]=Math.max(unionBox[3+k],group.viewBox[3+k]);
      }
    }
    function decideGroups(frustum,assign){
      const whole=certifyFrustum(frustum,unionBox);
      for(const group of groups.values())assign(group,whole>=0?whole===1:groupVisible(group,frustum));
    }
    function groupVisible(group,frustum){
      const certain=certifyFrustum(frustum,group.viewBox);
      if(certain>=0)return certain===1;
      exactSpheres();
      return frustum.intersectsSphere(group.exact.boundingSphere);
    }
    const passFrustum=new THREE.Frustum(),passMatrix=new THREE.Matrix4();
    let mainCamera=null;
    function passVisibility(camera){
      if(mode!=='gpu'||disposed||!root.visible)return;
      if(camera===mainCamera){for(const group of groups.values())showGroup(group,group.mainVisible);return;}
      passFrustum.setFromProjectionMatrix(passMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),
        THREE.WebGLCoordinateSystem,camera.reversedDepth);
      decideGroups(passFrustum,showGroup);
    }
    /** Leave the GPU path for good: the CPU cache is replayed to the current
     * pose and the geometry takes the CPU path's attributes again. */
    function toCpu(reason){
      if(mode!=='gpu')return;
      mode='cpu';gpuFallback=reason;summary.path=mode;summary.gpuFallback=reason;gpuUniform.value=0;
      if(lastPlan){materializeLodMeshFrame(lastPlan);lastPlan=null;}
      if(hasEnvironment)updateNormals();
      for(const group of groups.values()){
        const positions=group.geometry.getAttribute('position');
        copyPositions(positions.array,group.indices);positions.needsUpdate=true;
        setMeshBounds(group.geometry,positions.array);
        if(group.batchEntry){batches.remove(group.batchEntry);group.batchEntry=null;}
        group.mesh.frustumCulled=true;if(group.twin)group.twin.frustumCulled=true;showGroup(group,true);
      }
      gpu.release(gpuHandle);gpuHandle=null;
    }
    function planGpu(){
      lastPlan=planLodMeshFrame(payload,actor,coords,services,{output:frame.output});
      exactValid=false;plannedFrame=gpu.frame+1;
      try{gpu.setPose(gpuHandle,lastPlan);}
      catch(error){toCpu(error.message);return;}
      for(const group of groups.values()){
        for(const op of lastPlan.channels)advanceChannelBox(group.channelBoxes[op.channel+1],op,group.boxes);
        viewBox(lastPlan,group.channelBoxes,group.viewBox);
        boxSphere(group);
      }
      updateUnion();
    }
    if(mode==='gpu'){
      // The first plan (above) is this preview's first GetFrame call.
      try{plannedFrame=gpu.frame+1;gpu.setPose(gpuHandle,lastPlan);
        for(const group of groups.values()){
          for(const op of lastPlan.channels)advanceChannelBox(group.channelBoxes[op.channel+1],op,group.boxes);
          viewBox(lastPlan,group.channelBoxes,group.viewBox);boxSphere(group);
        }
        updateUnion();
      }catch(error){toCpu(error.message);}
    }
    lastPose=pose();
    return {actor,root,dispose,mesh:meshReference,get viewDependent(){return hasEnvironment&&mode==='cpu';},updateView,
      /** The actor's current Mesh (undefined where readNamed would throw). */
      readMesh(){try{return own.Mesh();}catch{return undefined;}},
      passVisibility,get path(){return mode;},
      /** Validation access (scripts/validate-gpu-mesh.mjs): this frame's
       * plan, lighting setup and GPU slot; `exactOutput()` replays the CPU
       * shadow to the exact CPU pose. Never used by Play. */
      gpuState:()=>({handle:gpuHandle,plan:lastPlan,plannedFrame,updated:mainCamera!==null,setup:lastSetup,litFrame:lastLitFrame,faces,faceWords,groups,hasEnvironment,
        exactOutput:()=>{exactSpheres();return frame.output;},get exactValid(){return exactValid;}}),
      get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
      update(cameraPosition,view={}){
        if(disposed)return false;
        root.visible=visible?visible(actor,own):(drawActor||!own.bHidden())&&!own.bDeleteMe();
        if(!root.visible){hideBatched();return false;}
        // Render.dll only draws, and so only calls GetFrame for, actors in
        // the view. Outside the frustum even a conservative bound of every
        // pose is culled here; three.js would cull each group anyway, so
        // render feedback is unchanged. Mirror frames disable this (view.cull).
        if(view.cull&&view.frustum){
          const location=own.Location(),pivot=own.PrePivot();
          cullSphere.center.set(location[1]+pivot[1],location[2]+pivot[2],-(location[0]+pivot[0]));
          cullSphere.radius=cullRadius*Math.max(1,Math.abs(own.DrawScale()))*1.01+1;
          if(!view.frustum.intersectsSphere(cullSphere)){root.visible=false;hideBatched();return false;}
        }
        if(own.Mesh()!==meshReference)throw new Error(`${actorName} changed Mesh; rebuilding the inspection resource is unsupported`);
        // Actor.uc declares ScaleGlow as the lighting multiplier. With original
        // mesh lighting it is inside FLightManager::Light and the unlit colour;
        // the unlit inspection path applies it to the texture directly.
        const glow=lighting?1:Math.min(1,own.ScaleGlow()),style=own.Style();
        if(!materialStateApplied||!Object.is(glow,lastGlow)||!Object.is(style,lastStyle))for(const material of materials){
          material.color.setRGB(glow,glow,glow);
          const flags=material.userData.flags;
          const translucent=style===3||Boolean(flags&POLY.Translucent);
          const modulated=!translucent&&(style===4||Boolean(flags&POLY.Modulated));
          material.transparent=translucent||modulated;material.depthWrite=!material.transparent;
          material.userData.modulatedUniform.value=modulated?1:0;
          material.blending=material.transparent?THREE.CustomBlending:THREE.NormalBlending;
          material.blendSrc=translucent?THREE.OneFactor:THREE.DstColorFactor;
          material.blendDst=translucent?THREE.OneMinusSrcColorFactor:THREE.SrcColorFactor;
          material.alphaTest=(style===2||Boolean(flags&POLY.Masked)) ? 0.5 : 0;
        }
        if(!materialStateApplied||!Object.is(glow,lastGlow)||!Object.is(style,lastStyle))for(const group of groups.values()){
          rebatch(group);
          if(!group.sided)continue;
          group.split=group.sided.double.transparent;
          group.mesh.material=group.split?group.sided.back:group.sided.double;
          if(!group.batchEntry)showGroup(group,group.mesh.visible);
        }
        lastGlow=glow;lastStyle=style;materialStateApplied=true;
        const current=pose();
        const poseChanged=!current.every((value,index)=>Object.is(value,lastPose[index]));
        let posed=false;
        if(poseChanged&&mode==='gpu'){planGpu();posed=true;}
        if(poseChanged&&mode==='cpu'){
          // A plan evaluated for this frame before a fallback already posed it.
          if(!posed)getLodMeshFrame(payload,actor,coords,services,{output:frame.output});
          if(hasEnvironment)updateNormals();
          for(const group of groups.values()){
            const positions=group.geometry.getAttribute('position');
            copyPositions(positions.array,group.indices);positions.needsUpdate=true;
            setMeshBounds(group.geometry,positions.array);
          }
        }
        let mainVisible;
        if(mode==='gpu'){
          mainCamera=view.camera??null;
          mainVisible=false;
          const assign=(group,visible)=>{group.mainVisible=visible;showGroup(group,visible);mainVisible||=visible;};
          if(view.frustum)decideGroups(view.frustum,assign);else for(const group of groups.values())assign(group,true);
        }
        const environmentUpload=updateView(cameraPosition);
        if(lighting&&view.lit&&lighting.frame&&(!view.frustum||(mode==='gpu'?mainVisible:[...groups.values()].some(group=>
          group.geometry.boundingSphere&&view.frustum.intersectsSphere(group.geometry.boundingSphere))))){
          if(mode==='gpu'){
            const prepared=lighting.setupMesh(actor);
            if(prepared){
              lastSetup=prepared;lastLitFrame=gpu.frame+1;
              summary.lighting={lights:prepared.setup.lights.length,flags:prepared.flags};
              if(!gpu.setLighting(gpuHandle,{flags:prepared.flags,ambient:prepared.setup.ambient,
                scaleGlow:prepared.setup.scaleGlow,unlit:prepared.unlit,lights:prepared.setup.lights})){
                toCpu(`more than ${prepared.setup.lights.length-1} selected lights`);
                summary.lighting=relight(prepared)??summary.lighting;
              }
            }
          } else summary.lighting=relight()??summary.lighting;
        }
        lastPose=current;summary.animation=own.AnimSequence();summary.frame=own.AnimFrame();
        // True when a buffer was re-uploaded: pose positions, or the
        // camera-relative environment UVs, which change with the viewer.
        return poseChanged||environmentUpload;
      },summary};
  } catch(error) {dispose();throw error;}
}

/** The GPU draw path's begin_vertex (docs/gpu-mesh.md): the corner's pose
 * texel with the viewer reflection, its corner colour and, for environment
 * groups, the environment UV from the pass camera. `deusGpu` 0 keeps the
 * CPU path's attributes for an actor that fell back. */
function gpuBeginVertex(environment){
  return `vec3 transformed;
if (deusGpu > 0.5) {
  int deusV = int(deusVertexTexel), deusC = int(deusCornerTexel);
  vec3 deusP = texelFetch(deusPose, ivec2(deusV & 1023, deusV >> 10), 0).xyz;
  transformed = vec3(deusP.y, deusP.z, -deusP.x);
  uvec4 deusBytes = texelFetch(deusCorners, ivec2(deusC & 1023, deusC >> 10), 0);
  vDeusLight = vec3(texelFetch(deusByteColors, ivec2(int(deusBytes.x), 0), 0).x,
    texelFetch(deusByteColors, ivec2(int(deusBytes.y), 0), 0).x, texelFetch(deusByteColors, ivec2(int(deusBytes.z), 0), 0).x);
${environment?`  vec3 deusN = texelFetch(deusEnvironmentNormals, ivec2(deusV & 1023, deusV >> 10), 0).xyz;
  vMapUv = ( mapTransform * vec3( environmentUV(deusP, deusN, deusCameraHi, deusCameraLo), 1 ) ).xy;
`:''}} else {
  transformed = vec3( position );
  vDeusLight = deusLight;
}`;
}

/** A batch's material (actor-batches.mjs): the members' shared material state
 * with the GPU draw code, reading each vertex's member flag. */
function batchMaterial(template,members,gpu,displayGamma){
  const environment=Boolean(template.userData.flags&POLY.Environment);
  const material=new THREE.MeshBasicMaterial({map:template.map,side:template.side,alphaTest:template.alphaTest});
  material.color.copy(template.color);
  material.userData={...template.userData,members};
  material.customProgramCacheKey=()=>`deus-ex-mesh-gpu-batch-v1:${environment?1:0}`;
  material.onBeforeCompile=shader=>{
    shader.uniforms.deusDisplayGamma=displayGamma;shader.uniforms.deusModulated={value:0};
    Object.assign(shader.uniforms,gpu.shared,{deusGpu:{value:1},deusMembers:members});
    shader.vertexShader=shader.vertexShader.replace('#include <common>',
      `#include <common>\nattribute vec3 deusLight;\nvarying vec3 vDeusLight;\n${DRAW_VERTEX_DECLARATIONS}${BATCH_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>',gpuBeginVertex(environment))
      .replace('#include <project_vertex>',`#include <project_vertex>\n${BATCH_VERTEX_TAIL}`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
      '#include <common>\nuniform float deusDisplayGamma;\nuniform float deusModulated;\nvarying vec3 vDeusLight;')
      .replace('#include <colorspace_fragment>',
        'gl_FragColor = sRGBTransferOETF(gl_FragColor);\ngl_FragColor.rgb *= vDeusLight;\n'+
        `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
        `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
  };
  return material;
}
