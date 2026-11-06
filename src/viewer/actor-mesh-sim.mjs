/** The simulation side of Play's actor mesh layer (docs/sim-worker.md
 * step 4; docs/npc-mesh-preview.md, docs/gpu-mesh.md, docs/mesh-lighting.md).
 * Everything that reads the runtime or decides what is drawn runs here:
 * Render.dll's level-actor admission, the mesh_reads pass, GetFrame planning
 * (or the CPU GetFrame of an actor off the GPU path), the GPU path's group
 * bounds and frustum decisions, SetupForActor and the CPU lighting pass. Each
 * binding emits plain records: a creation record when it is admitted and a
 * frame record per update, which the page's actor-mesh-draw.mjs applies to
 * its three.js objects and the GPU mesh passes. The GPU mesh layout
 * (gpu-mesh-layout.mjs) is this side's copy of the page's texel allocation,
 * so both sides take the same path for every actor. */
import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {createLodMeshFrameCache,getLodMeshFrame,planLodMeshFrame,materializeLodMeshFrame,mergeLodMeshPlans,snapshotLodMeshCache,
  lodMeshCameraMatrix,publishLodMeshOps} from '../runtime/lodmesh-frame.mjs';
import {loadLodMeshKernel} from '../runtime/lodmesh-wasm.mjs';
import {actorsEpoch} from '../runtime/base-epoch.mjs';
import {receiverEpoch} from '../runtime/receiver-epoch.mjs';
import {RENDER_MESH,RENDER_SHIFT,renderScanMode,RS_ABSENT,RS_MESH,RS_NOT_OK,RS_STALE} from '../runtime/script-vm-render.mjs';
import {handleOf,identityOfHandle} from '../runtime/script-object-handles.mjs';
import {nameCellWord} from '../runtime/script-name-ids.mjs';
import {FieldReader,fieldReaders,hasReader} from './actor-fields.mjs';
import {keyframeBoxes,advanceChannelBox,viewBox,certifyFrustum,newGroupBoxes,VIEW_BOX_AT} from './gpu-mesh-bounds.mjs';
import {meshFaceGroups,resolveMeshSkin,resolveMeshSkinNow} from './actor-mesh-skins.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';
import {SETUP,setupSequence} from '../runtime/bsp-occlusion.mjs';
import {createMeshLod,lodFrame} from './actor-mesh-lod.mjs';
import {meshFaces} from '../runtime/mesh-faces.mjs';
import {createWeaponAttachments} from './actor-weapon-sim.mjs';
import {classicMeshBindingSteps} from './actor-umesh-sim.mjs';
import {lodMorphScalars,RENDER_LOD_SETTINGS} from '../runtime/lodmesh-lod.mjs';
import {registerAllocationSiteWarmer} from '../runtime/allocation-site-warmup.mjs';
import {actorPlumbing} from './actor-plumbing.mjs';

// A binding's block of render.rs mesh_reads words (u32 indices).
const MB={STATUS:0,MESH:1,STYLE:2,SCALEGLOW:3,LOCATION:4,PREPIVOT:7,DRAWSCALE:10,ANIMACTOR:11,POSE:12,LAST:29,LAST_VALID:46,
  ZONE:47,ILEAF:48,ZONENUMBER:49,AMBIENTGLOW:50,SETUP_FLAGS:51,DRAWTYPE:52,OWN_PARTICLES:53,OWN_ANIMFRAME:54,ANIMSEQ:55};
const MB_WORDS=56,MS_OK=1,MS_DRAWN=2,MS_DRAWN_CHILD=4,MS_CHANGED=8,MS_SETUP=16,MS_ANIMSEQ=32;

/** A plain texture reference for the page's asset store. */
const wordView=new DataView(new ArrayBuffer(4));
/** A float32's bits. */
const floatBits=value=>{wordView.setFloat32(0,value,true);return wordView.getUint32(0,true);};
const plainRef=reference=>({key:reference.key,package:reference.asset?.name,index:reference.index});

/** BufferGeometry.computeBoundingBox + computeBoundingSphere (three.js
 * r186) for a plain position array without morph targets, in one pass: the
 * same Math.min/max expansion, empty-box centre, (min + max) * 0.5 centre and
 * largest dx*dx + dy*dy + dz*dz, so frustum culling sees identical bounds.
 * `target` holds boundingBox and boundingSphere, as a geometry does. */
/** The record one binding's update returns for the page. The frame keeps every binding's record until its snapshot is posted, so
 * a scavenge inside the actors step finds them all alive, and V8 decides this literal "tenure" (and the records are then born in
 * old space, about 6 KB a worker frame on the Island) unless it is decided first: allocation-site-warmup.mjs. */
function newUpdateRecord(id){return {id,visible:false,childOnly:false};}
// The decision for a binding a pass does not draw: one frozen object for all of them (the page reads `root` and nothing else of it;
// a weapon's decision, which the sim marks flipSide, is a copy: framePassOf).
const NOT_IN_FRAME=Object.freeze({root:false});
// frameVariants of a binding with no child frame that differs from the base (nothing writes to it)
const NO_VARIANTS=new Map();
let warmRecord=null;
registerAllocationSiteWarmer(count=>{for(let i=0;i<count;i++)warmRecord=newUpdateRecord(i);warmRecord=null;});
export function setMeshBounds(target,array){
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for(let i=0;i<array.length;i+=3){
    const x=array[i],y=array[i+1],z=array[i+2];
    minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);
    maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);
  }
  target.boundingBox??=new THREE.Box3();
  target.boundingBox.min.set(minX,minY,minZ);target.boundingBox.max.set(maxX,maxY,maxZ);
  target.boundingSphere??=new THREE.Sphere();
  const center=target.boundingSphere.center;
  if(maxX<minX||maxY<minY||maxZ<minZ)center.set(0,0,0);
  else center.set((minX+maxX)*0.5,(minY+maxY)*0.5,(minZ+maxZ)*0.5);
  let maxRadiusSq=0;
  for(let i=0;i<array.length;i+=3){
    const dx=center.x-array[i],dy=center.y-array[i+1],dz=center.z-array[i+2];
    maxRadiusSq=Math.max(maxRadiusSq,dx*dx+dy*dy+dz*dz);
  }
  target.boundingSphere.radius=Math.sqrt(maxRadiusSq);
}

/** GetFrame's posed x,y,z floats (12-byte stride) at a group's corners,
 * with the viewer's reflection (toView), keeping the special-vertex prefix. */
export function copyPositions(output,positions,indices){
  const vertices=new DataView(output.buffer,output.byteOffset,output.byteLength);
  for(let corner=0;corner<indices.length;corner++){
    const offset=indices[corner]*12,at=corner*3;
    positions[at]=vertices.getFloat32(offset+4,true);
    positions[at+1]=vertices.getFloat32(offset+8,true);
    positions[at+2]=-vertices.getFloat32(offset,true);
  }
}

/** A draw group's corner vertices under the LOD (`resolved`: three vertices
 * per mesh face, -1 for a face above the count), in the group's corner order
 * (faces' corners 0, 2, 1). A face the LOD drops collapses to the group's
 * first admitted corner, so it draws nothing and leaves the bounds alone;
 * `group.lodEmpty` marks a group with no admitted face (it is not drawn).
 * The page (actor-mesh-draw.mjs) builds the same corners. */
export function lodCornerIndices(groupFaces,indices,resolved,group){
  const out=group.lodIndices??=new Int32Array(indices.length);
  let fill=-1;
  for(const face of groupFaces)if(resolved[face*3]>=0){fill=resolved[face*3];break;}
  group.lodEmpty=fill<0;
  if(fill<0)fill=indices[0];
  for(let n=0;n<groupFaces.length;n++){
    const face=groupFaces[n]*3;
    out[n*3]=resolved[face]>=0?resolved[face]:fill;
    out[n*3+1]=resolved[face]>=0?resolved[face+2]:fill;
    out[n*3+2]=resolved[face]>=0?resolved[face+1]:fill;
  }
  return out;
}

const countLevel=(level,count)=>{let n=0;for(const value of level)if(value<=count)n++;return n;};
const countAdmitted=resolved=>{let n=0;for(let i=0;i<resolved.length;i+=3)if(resolved[i]>=0)n++;return n;};
const countVertices=resolved=>{const seen=new Set();for(const v of resolved)if(v>=0)seen.add(v);return seen.size;};

/** The plan as the page's gpu-mesh.mjs setPose reads it. */
const plainPlan=plan=>({matrix:plan.matrix.map(row=>[...row]),origin:[...plan.origin],
  channels:plan.channels.map(op=>({channel:op.channel,tween:Boolean(op.tween),first:op.first,second:op.second,
    blend:Boolean(op.blend),alpha:op.alpha,count:op.count,fill:op.fill?[...op.fill]:null}))});
/** SetupForActor's result as gpu-mesh.mjs setLighting reads it, with the
 * frame's GetFrame matrix (`camera`, 4 rows of 3: lodMeshCameraMatrix) that
 * publishes the cache poses in that frame's camera space. `mirror`: the Frame->Mirror
 * the face pass takes instead of the run's (a pawn's weapon: 1.0, whatever the frame's). */
const plainLighting=(prepared,camera,mirror=0)=>({flags:prepared.flags,ambient:[...prepared.setup.ambient],scaleGlow:prepared.setup.scaleGlow,
  unlit:[...prepared.unlit],camera:camera.flat(),lights:prepared.setup.lights.map(light=>({location:[...light.location],rradius:light.rradius,
    color:[...light.color]})),...(mirror?{mirror}:{})});

/** One actor's mesh binding on the simulation side. `layout` is this side's
 * GPU mesh layout (null: the CPU path); `onRecord` is not used here, the
 * caller collects update()'s records. */
export async function createMeshBinding(runtime,actor,options) {
  const steps=meshBindingSteps(runtime,actor,options);
  for(let step=steps.next();;) {
    if(step.done)return step.value;
    let value,failed=false,failure;
    try {
      const {mesh,skin}=step.value;
      value=skin?await resolveMeshSkin(options.textures,skin.reference.asset,skin.reference.index,skin.flags)
        :await runtime.prepareMeshReference(mesh);
    } catch(error) {failed=true;failure=error;}
    step=failed?steps.throw(failure):steps.next(value);
  }
}

// A resource createMeshBindingNow needs is not resident: the binding is
// disposed and the caller takes the asynchronous path.
const NOT_RESIDENT=new Error('Mesh binding resource is not resident');

/** createMeshBinding in the caller's frame: the binding, or null when the
 * mesh's prepared resource (ScriptRuntime.meshResource) or a group's skin
 * (TextureStore.now) is not resident yet; nothing of it is kept then. */
export function createMeshBindingNow(runtime,actor,options) {
  const steps=meshBindingSteps(runtime,actor,options);
  try {
    for(let step=steps.next();;) {
      if(step.done)return step.value;
      let value,failed=false,failure;
      try{value=residentResource(runtime,options.textures,step.value);}catch(error){failed=true;failure=error;}
      step=failed?steps.throw(failure):value===undefined?steps.throw(NOT_RESIDENT):steps.next(value);
    }
  } catch(error) {if(error===NOT_RESIDENT)return null;throw error;}
}

/** A binding step's resource when it is resident, else undefined: the mesh's
 * prepared payload (prepareMeshReference's) or a group's skin. */
function residentResource(runtime,textures,{mesh,skin}) {
  if(skin)return resolveMeshSkinNow(textures,skin.reference.asset,skin.reference.index,skin.flags)??undefined;
  if(!mesh||!['LodMesh','Mesh'].includes(mesh.kind))return null;
  try{return runtime.meshResource(mesh).payload;}catch{return undefined;}
}

/** The binding's body: it yields {mesh} for the mesh's prepared payload and
 * {skin: group} for a face group's skin (resolveMeshSkin's result, or the
 * error that drops the group), which createMeshBinding awaits and
 * createMeshBindingNow takes only when resident. */
function* meshBindingSteps(runtime,actor,{id,originalObjectIndex,kernel=null,drawActor=false,visible=null,
  childVisible=null,lighting=null,layout=null,reads=false,textures,meshKey=null,lod=true,attach=null}) {
  const own=fieldReaders(runtime,actor,['bHidden','bDeleteMe','Location','PrePivot','DrawScale','Mesh','Style',
    'ScaleGlow','bAnimByOwner','Owner','bParticles','Rotation','AnimSequence','AnimFrame','BlendAnimSequence',
    'BlendAnimFrame','Name','bOnlyOwnerSee','bOwnerNoSee','DrawType','LODBias','Fatness']);
  // A pawn's third-person weapon (actor-weapon-sim.mjs, docs/weapon-attachment.md): DrawActorSprite draws the
  // weapon with its ThirdPersonMesh swapped into Mesh, ThirdPersonScale into DrawScale and the pawn's Style, and
  // DrawMesh gets the hand's Coords: `attach.overrides` replace those reads, `attach.coords(frame)` is the Coords
  // of every GetFrame and LOD call, and the lighting takes the pawn as its light sink.
  if(attach)Object.assign(own,attach.overrides);
  const read=(object,name)=>object===actor&&hasReader(own,name)?own[name]():runtime.readNamed(object,name);
  const actorName=read(actor,'Name');
  const meshReference=attach?attach.mesh():read(actor,'Mesh');
  const meshTexture=index=>attach?runtime.getMeshTextureOf(meshReference,actor,index):runtime.getActorMeshTexture(actor,index);
  const payload=yield {mesh:meshReference};
  // One of the game's five classic UMesh meshes: its own CPU binding (actor-umesh-sim.mjs, docs/umesh.md).
  if(payload.payloadStatus==='decoded-mesh')
    return yield* classicMeshBindingSteps(runtime,actor,payload,{id,originalObjectIndex,kernel,visible,childVisible,drawActor,lighting,meshKey,own,read,
      meshReference,meshTexture,actorName,helpers:{copyPositions,setMeshBounds,SETUP},notResident:NOT_RESIDENT});
  // GetFrame's tween cache must survive draw submissions; it owns only this
  // binding's identity (docs/npc-mesh-preview.md).
  const cache=createLodMeshFrameCache(),coords=[0,0,0,1,0,0,0,1,0,0,0,1];
  const services={cache,kernel,read,objectIndex:object=>{
    if(object!==actor)throw new Error('Owner-driven mesh inspection requires a captured owner identity');
    return originalObjectIndex;
  }};
  // The mesh's faces: one typed block shared by every binding of the mesh (mesh-faces.mjs).
  const faces=meshFaces(payload),faceWords=faces.words;
  const hasEnvironment=faces.anyFlags(POLY.Environment);
  // DrawLodMesh's distance LOD (actor-mesh-lod.mjs); null without it.
  const meshLod=lod?createMeshLod(payload,faceWords,{kernel}):null;
  const fullCount=payload.frameVertexCount-(payload.scalarBits.get(0x184)|0);
  // The last LOD inputs and results: the requested and returned counts, the
  // detail bits, and the drawn state (drawn positions, resolved corners).
  let lastCallsKey=String(fullCount),lastReturned=fullCount,lastDetail='off',lodDrawn=null,lastLod=null;
  // GetFrame's returned count of each call this frame (in call order), the
  // operations each call ran (the CPU path's, or the merged plan's channels)
  // and the call each frame (its index, null for the main frame) made.
  let callReturned=[fullCount],callOps=[[]],baseSelection=null;
  // (frame index -> the GetFrame call that served it, as two arrays kept between updates: a Map of one or two entries made each update)
  const frameCallIndex=[],frameCallValue=[];let frameCallCount=0;
  // The GPU path's last LOD state: the selection, its post-frame scalars
  // while the LOD flag holds, and the parameters the page last received.
  let lastSelection=null,gpuLodScalars=null,lastLodKey='full';
  /** The LOD's post-frame state for GetFrame's last output (null: full
   * resolution and unmorphed). */
  function lodAfter(selection){
    baseSelection=selection;
    lodDrawn=selection?meshLod.after(selection,lastReturned,frame.output):null;
    if(lodDrawn&&!lodDrawn.state.active&&!lodDrawn.state.morph)lodDrawn=null;
  }
  /** DrawLodMesh in each child frame that draws the binding
   * (docs/script-lodmesh-lod.md "Child frames"): the selection from that
   * frame's own Coords and FX, GetFrame's returned count for its call, and
   * the state those give (the GPU scalars; the CPU morph, corners and
   * lighting topology, on demand). `frameVariants` holds the frames whose
   * state differs from the base's (the last frame to draw it, the main
   * frame's unless only child frames do): each is drawn with its own. */
  let frameVariants=new Map();
  const stateKey=(selection,returned)=>{
    if(!selection)return 'full';
    const s=lodMorphScalars(meshLod.topology,selection,returned);
    return s.active?`${s.count}:${s.start}:${s.morph}:${s.morph?floatBits(Math.fround(s.inverse)):0}`:'full';
  };
  const fullParams=()=>({count:meshLod.topology.modelVerts,start:0,active:false,morph:false,inverse:0});
  /** The GPU record's LOD parameters of a selection after a GetFrame that
   * returned `returned` (lodMorphScalars). */
  const paramsOf=(selection,returned)=>{
    const s=selection?lodMorphScalars(meshLod.topology,selection,returned):null;
    return s?.active?{count:s.count,start:s.start,active:true,morph:s.morph,inverse:Math.fround(s.inverse)}:fullParams();
  };
  const emptyGroups=params=>{
    const level=meshLod.topology.faceLevel,empty=new Map();
    for(const group of groups.values())empty.set(group,params.active&&group.faces.every(face=>level[face]>params.count));
    return empty;
  };
  /** What the page needs to draw the LOD state: the resolved corners and
   * wedge dwords (null at full resolution). */
  const lodRecord=()=>({resolved:lodDrawn?.resolved?Int32Array.from(lodDrawn.resolved):null,
    scratch:lodDrawn?.scratch?Uint32Array.from(lodDrawn.scratch):null,count:lastReturned,
    state:lodDrawn?{...lodDrawn.state}:null});
  const key=meshKey??meshReference.key;
  // With a GPU layout the first GetFrame is planned now (the pose read at
  // admission) and the slot is allocated when the binding is complete, in
  // the order the page receives creation records; a plan the CPU path takes
  // instead is materialized, which gives getLodMeshFrame's output.
  let mode='cpu',gpuHandle=null,gpuFallback=null,lastPlan=null,exactValid=false,plannedFrame=-1,firstPassFrame=-1;
  // Whether a frame has drawn the binding. The original's only GetFrame call is DrawLodMesh's (Render 0x10b0ee0f), so its cache
  // item is made by the first frame that draws the actor. The call above, at admission, stands for that one only while the pose
  // is still the one it read: a drawn update after the pose changed empties the cache first (docs/script-lodmesh-frame.md
  // "The first GetFrame is the first draw's").
  let drawnBefore=false;
  const frame=layout?planFirst():getLodMeshFrame(payload,actor,coords,services);
  if(!layout)callOps=[frame.ops];
  function planFirst(){
    lastPlan=planLodMeshFrame(payload,actor,coords,services);
    callOps=[lastPlan.channels];
    return {output:lastPlan.context.output,vertexCount:lastPlan.vertexCount};
  }
  // Host culling bound, never drawn geometry: the farthest vertex of every
  // animation frame from the mesh origin, plus the origin offset, in mesh
  // units, scaled by the mesh Scale and DrawScale around Location+PrePivot.
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
  const environmentTexture=()=>{
    const direct=read(actor,'Texture');if(direct)return direct;
    const region=read(actor,'Region'),zone=region['engine.actor.pointregion.zone'];
    const fromZone=zone&&read(zone,'EnvironmentMap');if(fromZone)return fromZone;
    const fromLevel=read(read(actor,'Level'),'EnvironmentMap');if(fromLevel)return fromLevel;
    let fallback=null;
    for(let i=0;i<payload.objectReferences.length;i++)fallback=meshTexture(i)??fallback;
    return fallback;
  };
  let disposed=false,lastPose=null,lastStyle,lastGlow,materialStateApplied=false,lastNames=null;
  const arena=reads?runtime.scriptVm?.arena??null:null;
  let block=0;
  if(arena){block=arena.alloc(4*MB_WORDS);arena.bytes.fill(0,block,block+4*MB_WORDS);}
  const meshHandle=meshReference?handleOf(meshReference):0;
  const groups=new Map(),skipped=[];
  const dispose=()=>{
    if(disposed)return;disposed=true;
    if(gpuHandle)layout.release(gpuHandle);
    if(block){arena.release(block,4*MB_WORDS);block=0;}
    cache.entries.clear();
    meshLod?.dispose();
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
  const poseNames=animationActor=>animationActor===actor
    ?[own.AnimSequence(),...own.BlendAnimSequence()]
    :[read(animationActor,'AnimSequence'),...read(animationActor,'BlendAnimSequence')];
  const sameNames=(a,b)=>a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
  // CPU path: the posed output as plain floats for the page.
  // With the LOD the drawn positions may be a morphed copy of the output.
  const drawnPoints=()=>lodDrawn?.positions??new Float32Array(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength/4);
  const posedCopy=()=>drawnPoints().slice();
  let lastSetup=null,lastLitFrame=-1;
  // This frame's lighting in each child frame that draws the actor (frame
  // index -> {lighting} on the GPU path or {colors} on the CPU path; frames
  // that lit it before the toCpu fallback keep theirs): DrawFrame lights an
  // actor once in every frame whose Frame->Sprite holds it, with that
  // frame's Coords and Mirror (docs/mesh-lighting.md "One call per frame").
  const frameLights=new Map(),frameSetups=new Map(),frameCtxs=new Map();
  /** The GetFrame operations of the call frame `index` made (null: the main
   * frame's, the last). */
  const opsOfFrame=index=>{
    let call=callOps.length-1;
    for(let k=frameCallCount-1;k>=0;k--)if(frameCallIndex[k]===index){call=frameCallValue[k];break;}
    return callOps[Math.min(call,callOps.length-1)];
  };
  /** DrawLodMesh's buffer for one frame, which GetFrame fills in that
   * frame's camera space (called with its Coords): the cache poses published
   * through the frame's matrix, then the LOD's morph of the frame's state
   * (docs/script-lodmesh-lod.md "Camera space"). `ctx` is the frame's
   * lighting frame (null: the main viewport's). Returns the drawn state as
   * meshLod.after does (positions, resolved corners, lighting topology). */
  function cameraDrawn(ctx,selection,returned,ops,frameIndex=null){
    const at=ctx??lighting.frame,output=new Uint8Array(payload.frameVertexCount*12);
    const coords=attach?attach.coords(frameIndex):[...at.origin,...at.axes[0],...at.axes[1],...at.axes[2]];
    publishLodMeshOps(payload,ops,lodMeshCameraMatrix(payload,actor,coords,services),{output,stride:12,kernel});
    let drawn=selection?meshLod.after(selection,returned,output):null;
    if(drawn&&!drawn.state.active&&!drawn.state.morph)drawn=null;
    return drawn??{positions:new Float32Array(output.buffer),lighting:{faceWords}};
  }
  /** CPU lighting of one frame: the corner colours over that frame's
   * camera-space buffer and reduced faces. `points` is that buffer after the
   * frame's LOD morph, the points DrawLodMesh projects in that frame (the page
   * draws them: docs/frame-projection.md "Meshes"); it belongs to this call. */
  function relight(prepared,ctx=null,frameIndex=null){
    const variant=frameIndex===null?null:frameVariants.get(frameIndex);
    const drawn=cameraDrawn(ctx,variant?variant.selection:baseSelection,variant?variant.returned:lastReturned,opsOfFrame(frameIndex),frameIndex),
      topology=drawn.lighting;
    // The weapon is lit as DrawMesh does: the pawn is the light sink and the frame's Mirror is 1.0 (attach.lightFrame).
    if(attach){ctx=attach.lightFrame(ctx);prepared??=attach.takePrepared(frameIndex)??lighting.setupMesh(actor,null,ctx,attach.setup());}
    const result=lighting.lightMesh(actor,drawn.positions,topology.faceWords,null,prepared,ctx,true);
    if(!result)return null;
    return {colors:result.colors.slice(),points:drawn.positions,summary:{lights:result.setup.lights.length,flags:result.flags}};
  }
  try {
    const partition=meshFaceGroups(faces,(flags,texture)=>flags&POLY.Environment?environmentTexture():meshTexture(texture));
    if(partition.error)throw new Error(`${actorName} ${partition.error}`);
    for(const [groupKey,group] of partition.groups) {
      try {
        // The page decodes the same skin; a group whose skin it cannot draw
        // is dropped on both sides.
        const {flags}=yield {skin:group};
        const indices=[];
        for(const faceIndex of group.faces)for(const corner of [0,2,1])indices.push(faceWords[faceIndex*4+corner]);
        const entry={key:groupKey,reference:group.reference,flags:group.flags,drawFlags:flags,faces:group.faces,indices,
          environment:Boolean(group.flags&POLY.Environment),sphere:new THREE.Sphere(),positions:null,bounds:{}};
        groups.set(groupKey,entry);
      } catch(error) {
        if(error===NOT_RESIDENT)throw error;
        skipped.push({texture:group.reference.key,message:error.message});
      }
    }
    if(!groups.size)
      throw new Error(skipped.map(s=>`${s.texture}: ${s.message}`).join('; ')||`${actorName} has no renderable faces`);
    if(layout){
      try{gpuHandle=layout.allocate(key,payload,faceWords,{environment:hasEnvironment});mode='gpu';}
      catch(error){gpuFallback=error.message;materializeLodMeshFrame(lastPlan);lastPlan=null;}
    }
    if(gpuHandle)for(const entry of groups.values()){
      // With the LOD a corner may draw any vertex of its wedge collapse
      // chain, morphed toward its collapse target: the boxes cover them all.
      const vertices=meshLod?meshLod.closure(entry.faces):[...new Set(entry.indices)].sort((a,b)=>a-b);
      entry.boxes=keyframeBoxes(payload,vertices);
      // (the channels' local boxes and the view box in one array, the view box also a view of its own: gpu-mesh-bounds.mjs)
      entry.channelBoxes=newGroupBoxes();
      entry.viewBox=entry.channelBoxes.subarray(VIEW_BOX_AT);
      entry.exact={boundingBox:null,boundingSphere:null};
      entry.mainVisible=true;
    }
    // CPU path: positions and three.js bounds of each group's corners
    // (with the LOD, the resolved corners: lodCornerIndices).
    const cpuBounds=()=>{
      const points=drawnPoints(),bytes=new Uint8Array(points.buffer,points.byteOffset,points.byteLength);
      for(const group of groups.values()){
        group.positions??=new Float32Array(group.indices.length*3);
        const indices=lodDrawn?.resolved?lodCornerIndices(group.faces,group.indices,lodDrawn.resolved,group):group.indices;
        if(!lodDrawn?.resolved)group.lodEmpty=false;
        copyPositions(bytes,group.positions,indices);
        setMeshBounds(group.bounds,group.positions);
        group.sphere.copy(group.bounds.boundingSphere);
      }
    };
    if(mode==='cpu')cpuBounds();
    const summary={actor:actorName,mesh:meshReference.key,skipped,
        triangles:[...groups.values()].reduce((total,group)=>total+group.faces.length,0),
        textures:[...new Set([...groups.values()].map(group=>group.reference.key))],
        animation:read(actor,'AnimSequence'),frame:read(actor,'AnimFrame'),
        shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original',
        path:mode,gpuFallback};
    const scratchBounds=new Map();
    let spheresChanged=false;
    /** The exact CPU pose of the current plan and three.js's exact spheres. */
    // The plan whose CPU pose frame.output holds (materialized once; a LOD
    // change alone invalidates only the spheres).
    let materializedPlan=null;
    function materialize(){
      if(materializedPlan!==lastPlan){materializeLodMeshFrame(lastPlan);materializedPlan=lastPlan;}
    }
    function exactSpheres(){
      if(exactValid)return;
      materialize();
      // The LOD's drawn corners, as the CPU path draws them.
      const drawn=gpuLodScalars?meshLod.after(lastSelection,lastReturned,frame.output):null;
      const points=drawn?new Uint8Array(drawn.positions.buffer,drawn.positions.byteOffset,drawn.positions.byteLength):frame.output;
      for(const group of groups.values()){
        let positions=scratchBounds.get(group);
        if(!positions)scratchBounds.set(group,positions=new Float32Array(group.indices.length*3));
        copyPositions(points,positions,drawn?.resolved?lodCornerIndices(group.faces,group.indices,drawn.resolved,group):group.indices);
        setMeshBounds(group.exact,positions);
        // Transparent sorting uses the exact centre when it is known.
        group.sphere.copy(group.exact.boundingSphere);
      }
      exactValid=true;spheresChanged=true;
    }
    /** A child frame variant's CPU state (docs/script-lodmesh-lod.md "Child
     * frames"): the LOD of its selection and returned count over GetFrame's
     * output (which holds every vertex any call of the tick returned), the
     * drawn positions, the page's LOD record and each group's bounds. */
    function variantCpu(variant){
      if(variant.cpu)return variant.cpu;
      if(mode==='gpu')materialize();
      let drawn=variant.selection?meshLod.after(variant.selection,variant.returned,frame.output):null;
      if(drawn&&!drawn.state.active&&!drawn.state.morph)drawn=null;
      const points=drawn?Float32Array.from(drawn.positions):new Float32Array(frame.output.buffer,frame.output.byteOffset,frame.output.byteLength/4).slice();
      const cpu={drawn:drawn&&{...drawn,positions:points},points,
        record:{resolved:drawn?.resolved?Int32Array.from(drawn.resolved):null,scratch:drawn?.scratch?Uint32Array.from(drawn.scratch):null,
          count:variant.returned,state:drawn?{...drawn.state}:null},
        empty:new Map(),spheres:new Map()};
      const bytes=new Uint8Array(points.buffer,points.byteOffset,points.byteLength);
      for(const group of groups.values()){
        const positions=new Float32Array(group.indices.length*3),scratch={};
        const indices=drawn?.resolved?lodCornerIndices(group.faces,group.indices,drawn.resolved,scratch):group.indices;
        cpu.empty.set(group,Boolean(drawn?.resolved&&scratch.lodEmpty));
        copyPositions(bytes,positions,indices);
        const bounds={};setMeshBounds(bounds,positions);cpu.spheres.set(group,bounds.boundingSphere);
      }
      return variant.cpu=cpu;
    }
    const variantParams=variant=>variant.params??=paramsOf(variant.selection,variant.returned);
    const variantEmpty=variant=>variant.lodEmpty??=emptyGroups(variantParams(variant));
    /** A child frame's final LOD state (validation access): its variant's,
     * or the base's when it draws the same. */
    function frameStateOf(index){
      const variant=frameVariants.get(index);
      if(!variant)return {state:lastLod.state,admitted:lastLod.admitted,vertices:lastLod.vertices};
      if(mode==='gpu'){
        const params=variantParams(variant);
        return {state:params.active?{active:true,morph:params.morph,start:params.start,count:params.count}:null,
          admitted:params.active?countLevel(meshLod.topology.faceLevel,params.count):faces.count,vertices:null};
      }
      const drawn=variantCpu(variant).drawn;
      return {state:drawn?{...drawn.state}:null,admitted:drawn?.resolved?countAdmitted(drawn.resolved):faces.count,
        vertices:drawn?.resolved?countVertices(drawn.resolved):null};
    }
    function boxSphere(group){
      const box=group.viewBox,sphere=group.sphere;
      if(box.some(Number.isNaN))return;
      sphere.center.set((box[0]+box[3])/2,(box[1]+box[4])/2,(box[2]+box[5])/2);
      sphere.radius=Math.hypot(box[3]-box[0],box[4]-box[1],box[5]-box[2])/2;
      spheresChanged=true;
    }
    const unionBox=new Float64Array(6);
    function updateUnion(){
      unionBox[0]=unionBox[1]=unionBox[2]=Infinity;unionBox[3]=unionBox[4]=unionBox[5]=-Infinity;
      for(const group of groups.values())for(let k=0;k<3;k++){
        unionBox[k]=Math.min(unionBox[k],group.viewBox[k]);unionBox[3+k]=Math.max(unionBox[3+k],group.viewBox[3+k]);
      }
    }
    /** Each group's visibility in a pass; `variant`: a child frame whose
     * LOD state differs from the base's, with its own emptied groups and
     * (when the boxes cannot tell) its own exact spheres. */
    function decideGroups(frustum,assign,variant=null){
      // A pawn's weapon is drawn in camera space from the hand's Coords (attach.coords): the world-space bounds the frustum test
      // would read are not where it is drawn, and DrawMesh draws it whole (the CPU path's frustumCulled is off the same way).
      const whole=attach?1:certifyFrustum(frustum,unionBox),empty=variant?variantEmpty(variant):null;
      // A group the LOD empties draws nothing.
      for(const group of groups.values())
        assign(group,!(empty?empty.get(group):group.lodEmpty)&&(whole>=0?whole===1:groupVisible(group,frustum,variant)));
    }
    function groupVisible(group,frustum,variant=null){
      const certain=certifyFrustum(frustum,group.viewBox);
      if(certain>=0)return certain===1;
      if(variant)return frustum.intersectsSphere(variantCpu(variant).spheres.get(group));
      exactSpheres();
      return frustum.intersectsSphere(group.exact.boundingSphere);
    }
    let childOnly=false,toCpuReason=null,lastAppliedGroups=null;
    /** Leave the GPU path for good: the CPU cache is replayed to the current
     * pose and the page's geometry takes the CPU path's attributes again. */
    function toCpu(reason){
      if(mode!=='gpu')return;
      mode='cpu';gpuFallback=reason;summary.path=mode;summary.gpuFallback=reason;toCpuReason=reason;
      if(lastPlan&&materializedPlan!==lastPlan)materializeLodMeshFrame(lastPlan);
      if(lastPlan)callOps=[lastPlan.channels];
      lastPlan=null;
      if(meshLod)lodAfter(gpuLodScalars?lastSelection:null);
      cpuBounds();
      layout.release(gpuHandle);gpuHandle=null;
    }
    /** GetFrame planned for the GPU: one call per distinct count in
     * `requests` (the frames that draw the binding, DrawFrame's order), merged
     * into the one plan the pose pass runs (mergeLodMeshPlans); the
     * returned counts of the calls are `callReturned`. Calls that do not merge
     * (a cache entry created this tick while tweening) are replaced by the
     * base call alone and the child frames draw its state (`planDegraded`). */
    let planDegraded=false;
    function planGpu(requests=[fullCount],first=false){
      // A slot's plans take effect when its GPU pass runs. Until the first
      // one has run, the actor has not been drawn and the GPU holds none of
      // its cache poses; a new plan would overwrite that first one, and a
      // tween in it would start from an empty state. The original's first
      // GetFrame happens when the actor is first drawn, so the cache
      // restarts: this plan is the first. So it is for the first frame that
      // draws the binding (`first`).
      if(first||layout.frame<firstPassFrame)for(const key of [...cache.entries.keys()])cache.flush(key);
      const call=vertexCount=>planLodMeshFrame(payload,actor,coords,services,{output:frame.output,vertexCount});
      planDegraded=false;
      let merged=null,plans=null;
      if(requests.length>1){
        const restore=snapshotLodMeshCache(cache);
        plans=requests.map(call);
        merged=mergeLodMeshPlans(plans);
        if(!merged){restore();plans=null;planDegraded=true;}
      }
      if(!merged){merged=call(requests.at(-1));plans=requests.map(()=>merged);}
      lastPlan=merged;
      callOps=[merged.channels];
      callReturned=plans.map(plan=>plan.vertexCount);
      lastReturned=callReturned.at(-1);
      exactValid=false;plannedFrame=layout.frame+1;
      try{layout.checkPose(gpuHandle,lastPlan);}
      catch(error){toCpu(error.message);return false;}
      for(const group of groups.values()){
        for(const op of lastPlan.channels)advanceChannelBox(group,op);
        viewBox(lastPlan,group);
        boxSphere(group);
      }
      updateUnion();
      return true;
    }
    let firstPlan=null;
    if(mode==='gpu'){
      // The first plan (above) is this binding's first GetFrame call.
      try{plannedFrame=firstPassFrame=layout.frame+1;layout.checkPose(gpuHandle,lastPlan);firstPlan=plainPlan(lastPlan);
        for(const group of groups.values()){
          for(const op of lastPlan.channels)advanceChannelBox(group,op);
          viewBox(lastPlan,group);boxSphere(group);
        }
        updateUnion();
      }catch(error){toCpu(error.message);}
    }
    lastPose=pose();
    // Each group's bounding sphere as centre and radius (a flatMap over a spread of the groups, with an array for each, made
    // several arrays for each call)
    const sphereWords=()=>{
      const out=new Float64Array(4*groups.size);
      let at=0;
      for(const group of groups.values()){
        const center=group.sphere.center;
        out[at++]=center.x;out[at++]=center.y;out[at++]=center.z;out[at++]=group.sphere.radius;
      }
      return out;
    };
    /** What the page needs to build this binding: the mesh to decode, its
     * face groups with their skins, the path and the first pose. */
    const creation={id,handle:handleOf(actor),actorName,attached:Boolean(attach),mesh:{...plainRef(meshReference),key},
      path:mode,environment:hasEnvironment,
      groups:[...groups.values()].map(group=>({key:group.key,texture:plainRef(group.reference),flags:group.flags,faces:group.faces})),
      plan:mode==='gpu'?firstPlan:null,spheres:sphereWords(),posed:mode==='cpu'?posedCopy():null,
      toCpu:toCpuReason};
    toCpuReason=null;spheresChanged=false;
    /** setupMesh's reads from this frame's block (MS_SETUP), or null. */
    const setupFields=({u32,f32})=>{
      const at=block>>2;
      if(!(u32[at+MB.STATUS]&MS_SETUP))return null;
      const zone=u32[at+MB.ZONE],flags=u32[at+MB.SETUP_FLAGS];
      return {zone:zone?identityOfHandle(zone):null,zoneNumber:u32[at+MB.ZONENUMBER],iLeaf:u32[at+MB.ILEAF]|0,
        Style:u32[at+MB.STYLE],bNoSmooth:Boolean(flags&1),bMeshEnviroMap:Boolean(flags&2),bMeshCurvy:Boolean(flags&4),
        bUnlit:Boolean(flags&8),location:[f32[at+MB.LOCATION],f32[at+MB.LOCATION+1],f32[at+MB.LOCATION+2]],
        AmbientGlow:u32[at+MB.AMBIENTGLOW],ScaleGlow:f32[at+MB.SCALEGLOW],bSpecialLit:Boolean(flags&16)};
    };
    const blockLastValid=()=>new Uint32Array(arena.memory.buffer)[(block>>2)+MB.LAST_VALID]!==0;
    const blockLastPose=()=>{
      const buffer=arena.memory.buffer,at=(block>>2)+MB.LAST,w=new Uint32Array(buffer,4*at,17),x=new Float32Array(buffer,4*at,17);
      return [identityOfHandle(w[0]),Boolean(w[1]),x[2],x[3],x[4],x[5],w[6]|0,w[7]|0,w[8]|0,x[9],x[10],x[11],
        lastNames[0],x[12],...lastNames.slice(1),x[13],x[14],x[15],x[16]];
    };
    const bitsOf=value=>{const v=new DataView(new ArrayBuffer(4));v.setFloat32(0,value,true);return v.getUint32(0,true);};
    function verifyReads(u32,f32,at){
      const status=u32[at+MB.STATUS],fail=what=>{throw new Error(`RENDER_SCAN=verify: ${actorName} ${what} differs in mesh_reads`);};
      if(Boolean(status&MS_DRAWN)!==Boolean(visible(actor,own)))fail('drawnInWorld');
      if(childVisible&&Boolean(status&MS_DRAWN_CHILD)!==Boolean(childVisible(actor,own)))fail('drawnInWorld(child)');
      if(u32[at+MB.MESH]!==(own.Mesh()?handleOf(own.Mesh()):0))fail('Mesh');
      if(u32[at+MB.STYLE]!==own.Style())fail('Style');
      const floats=[[MB.SCALEGLOW,[own.ScaleGlow()]],[MB.LOCATION,own.Location()],[MB.PREPIVOT,own.PrePivot()],[MB.DRAWSCALE,[own.DrawScale()]]];
      for(const [word,values] of floats)values.forEach((value,i)=>{if(u32[at+word+i]!==bitsOf(value))fail(`word ${word+i}`);});
      const animationActor=own.bAnimByOwner()?(own.Owner()??actor):actor;
      if(u32[at+MB.ANIMACTOR]!==handleOf(animationActor))fail('animation actor');
      if(status&MS_ANIMSEQ&&u32[at+MB.ANIMSEQ]!==nameCellWord(own.AnimSequence()))fail('AnimSequence');
    }
    const groupBits=()=>{
      const bits=new Array(groups.size);
      let at=0;
      for(const group of groups.values())bits[at++]=group.mainVisible?1:0;
      return bits;
    };
    let mainCamera=null,drawnMain=false;
    /** This frame's block offset (mesh_reads words), or -1. */
    const blockAt=reads=>{
      if(!reads||!block)return -1;
      const {u32}=reads.views();
      return u32[block>>2]&MS_OK?block>>2:-1;
    };
    /** Whether the root frame admits the actor (SetupDynamics' scan:
     * docs/render-visibility.md), as update() decides it. */
    const admitted=(reads,at=blockAt(reads))=>at>=0?Boolean(reads.views().u32[at+MB.STATUS]&MS_DRAWN)
      :visible?visible(actor,own):(drawActor||!own.bHidden())&&!own.bDeleteMe();
    /** Whether a child frame admits it (no excluded actor, no ViewTarget
     * rule: the player in a mirror). */
    const childAdmitted=(reads,at=blockAt(reads))=>Boolean(childVisible)&&(at>=0?Boolean(reads.views().u32[at+MB.STATUS]&MS_DRAWN_CHILD)
      :childVisible(actor,own));
    // GetAnimSeq's last answer (setupSequence) for Setup's candidate, and the
    // name and the name word (this frame's block: its folded id) it was for.
    let setupName,setupWord=-1,setupHit=null;
    /** FDynamicSprite::Setup's candidate words (bsp-occlusion.mjs SETUP) at
     * `at`: the actor's own fields from this frame's block, or read; for a
     * render-iterator item (`item`) its snapshot's Location, Rotation and
     * DrawScale, which DrawActorSprite would write into the actor. */
    function packSetup({u32,f32,i32},at,key,record,reads,item=null){
      u32[at+SETUP.KEY]=key>>>0;u32[at+SETUP.MESH]=record>>>0;u32[at+SETUP.TEXTURE]=0;u32[at+SETUP.USIZE]=0;u32[at+SETUP.VSIZE]=0;
      const b=item?-1:blockAt(reads),w=b>=0?reads.views().u32:null;
      if(b>=0){
        u32[at+SETUP.DRAWTYPE]=w[b+MB.DRAWTYPE];
        for(let k=0;k<3;k++){
          u32[at+SETUP.LOCATION+k]=w[b+MB.LOCATION+k];u32[at+SETUP.ROTATION+k]=w[b+MB.POSE+6+k];
          u32[at+SETUP.PREPIVOT+k]=w[b+MB.PREPIVOT+k];
        }
        u32[at+SETUP.DRAWSCALE]=w[b+MB.DRAWSCALE];u32[at+SETUP.PARTICLES]=w[b+MB.OWN_PARTICLES];
        u32[at+SETUP.ANIMFRAME]=w[b+MB.OWN_ANIMFRAME];
      }else{
        const location=item?item.location:own.Location(),rotation=item?item.rotation:own.Rotation(),pivot=own.PrePivot();
        u32[at+SETUP.DRAWTYPE]=own.DrawType()&255;
        for(let k=0;k<3;k++){f32[at+SETUP.LOCATION+k]=location[k];i32[at+SETUP.ROTATION+k]=rotation[k];f32[at+SETUP.PREPIVOT+k]=pivot[k];}
        f32[at+SETUP.DRAWSCALE]=item?item.drawScale:own.DrawScale();u32[at+SETUP.PARTICLES]=own.bParticles()?1:0;
        f32[at+SETUP.ANIMFRAME]=own.AnimFrame();
      }
      // (an unchanged word is an unchanged name up to case, which setupSequence ignores: the name is read only when it changes)
      if(b>=0&&w[b+MB.STATUS]&MS_ANIMSEQ){
        const word=w[b+MB.ANIMSEQ];
        if(word!==setupWord){setupWord=word;setupName=own.AnimSequence();setupHit=setupSequence(payload.sequences,setupName);}
        else if(reads.verify&&setupHit!==setupSequence(payload.sequences,own.AnimSequence()))
          throw new Error(`RENDER_SCAN=verify: ${actorName} AnimSequence's sequence differs from its name word's`);
      }else{
        const name=own.AnimSequence();
        if(name!==setupName){setupName=name;setupHit=setupSequence(payload.sequences,name);}
        setupWord=-1;
      }
      u32[at+SETUP.SEQ]=setupHit?1:0;i32[at+SETUP.SEQ_START]=setupHit?.startFrame??0;i32[at+SETUP.SEQ_FRAMES]=setupHit?.numFrames??0;
    }
    // (made once per binding: inside meshChanged it made a context object at every call, for every binding of every frame)
    const readChanged=()=>{try{return own.Mesh()!==meshReference;}catch{return true;}};
    const binding={id,actor,creation,dispose,mesh:meshReference,payload,packSetup,admitted,childAdmitted,get block(){return block;},meshHandle,row:-1,
      get viewDependent(){return hasEnvironment&&mode==='cpu';},
      get path(){return mode;},
      /** This binding's special vertices (the invisible attachment triangle the LodMesh keeps ahead of its
       * ordinary vertices) in the camera space of the frame `frameIndex` (null: the main frame; `ctx` its
       * lighting frame, null for the main viewport's): the cached poses of that frame's GetFrame call
       * published through the frame's matrix, which is the buffer DrawLodMesh reads them from
       * (docs/weapon-attachment.md). Valid after this tick's update. */
      specialCamera(ctx,frameIndex=null){
        const special=payload.scalarBits.get(0x184)|0;
        if(!special||disposed||!lighting?.frame)return null;
        if(mode==='gpu')materialize();
        const at=ctx??lighting.frame,output=new Uint8Array(special*12);
        const ops=opsOfFrame(frameIndex).map(op=>({...op,count:Math.min(op.count,special)}));
        publishLodMeshOps(payload,ops,lodMeshCameraMatrix(payload,actor,[...at.origin,...at.axes[0],...at.axes[1],...at.axes[2]],services),
          {output,stride:12,kernel});
        const floats=new Float32Array(output.buffer);
        return Array.from({length:special},(_,i)=>Array.from(floats.subarray(i*3,i*3+3)));
      },
      /** Whether the last update drew this binding in the main frame, or only in child frames. */
      lastDraw:()=>({main:drawnMain,childOnly}),
      readMesh(){try{return own.Mesh();}catch{return undefined;}},
      /** Whether Mesh is no longer this binding's: from this frame's block
       * when it holds the reads (compared with readMesh under
       * RENDER_SCAN=verify), else readMesh. */
      meshChanged(reads){
        const u32=reads&&block?reads.views().u32:null,at=u32&&u32[block>>2]&MS_OK?block>>2:-1;
        if(at<0)return readChanged();
        const changed=u32[at+MB.MESH]!==meshHandle;
        if(reads.verify&&changed!==readChanged())throw new Error(`RENDER_SCAN=verify: ${actorName} Mesh change differs in mesh_reads`);
        return changed;
      },
      /** A mirror pass's decision (`frustum` null: the main camera again,
       * after the child passes): the root's visibility and, on the GPU path,
       * each group's; null when nothing changes. An actor only child frames
       * draw shows in child passes alone. */
      passVisibility(frustum){
        if(disposed)return null;
        if(childOnly){if(frustum===null)return NOT_IN_FRAME;}
        else if(!drawnMain)return null;
        if(mode!=='gpu')return childOnly?{root:true}:null;
        if(frustum===null)return {root:true,groups:groupBits()};
        const bits=[];decideGroups(frustum,(group,visible)=>bits.push(visible?1:0));
        const spheres=spheresChanged?sphereWords():null;spheresChanged=false;
        return {root:true,groups:bits,spheres};
      },
      /** A child frame's pass decision (`frustum` its camera's; null with
       * `inFrame` null: the main frame again): drawn when its Frame->Sprite
       * holds the binding, and then, on the GPU path, the groups the pass
       * frustum keeps. Null when the frame did not pose it. */
      framePass(frustum,inFrame,frameIndex){
        if(disposed||(!drawnMain&&!childOnly))return null;
        // The frame's own again (`frustum` null): drawn when this frame drew it and, for a
        // root frame other than the main one, when its Frame->Sprite holds it (`inFrame`).
        const root=frustum===null?drawnMain&&inFrame:inFrame;
        if(!root)return NOT_IN_FRAME;
        // The frame's own lighting rides with the decision (frameIndex): the
        // page applies it before the pass and restores the main frame's after.
        // So does its own DrawLodMesh state when it differs from the base's:
        // the GPU path's LOD parameters or the CPU path's positions and
        // corners (docs/script-lodmesh-lod.md "Child frames").
        const child=frustum!==null&&frameIndex!==undefined;
        const decision={root:true},light=child?frameLights.get(frameIndex):null,variant=child?frameVariants.get(frameIndex):null;
        if(light||variant)decision.frame=frameIndex;
        if(light)Object.assign(decision,light);
        if(variant){
          if(mode==='gpu')decision.lodParams=variantParams(variant);
          else{const cpu=variantCpu(variant);decision.cpuState={posed:cpu.points,lod:cpu.record.resolved?cpu.record:null};}
        }
        if(mode!=='gpu')return decision;
        if(frustum===null){decision.groups=groupBits();return decision;}
        const bits=[];decideGroups(frustum,(group,visible)=>bits.push(visible?1:0),variant);
        const spheres=spheresChanged?sphereWords():null;spheresChanged=false;
        decision.groups=bits;decision.spheres=spheres;
        return decision;
      },
      /** Not drawn this frame without an update (an iterator item slot
       * the frame does not use): the page hides its root. */
      hide(){drawnMain=false;childOnly=false;return {id,visible:false,childOnly:false};},
      /** Whether a pass draws this binding, for render feedback: the main
       * frame (`decision` null and no frustum change) or a mirror pass with
       * its passVisibility decision. A GPU-path binding draws the groups
       * the decision shows; a CPU-path one the groups three.js does not
       * cull with `frustum`. */
      drawnIn(frustum,decision){
        // A weapon is drawn inside its pawn's DrawActorSprite, which stamps the pawn only.
        if(disposed||attach)return false;
        const root=decision?decision.root:drawnMain;
        if(!root)return false;
        if(mode==='gpu'){
          const bits=decision?.groups??groupBits();
          return bits.some(Boolean);
        }
        const variant=decision?.frame!==undefined?frameVariants.get(decision.frame):null,cpu=variant?variantCpu(variant):null;
        for(const group of groups.values())
          if(!(cpu?cpu.empty.get(group):group.lodEmpty)&&frustum.intersectsSphere(cpu?cpu.spheres.get(group):group.bounds.boundingSphere))return true;
        return false;
      },
      /** Validation access (scripts/validate-gpu-mesh.mjs): this frame's
       * plan, lighting setup and GPU slot; `exactOutput()` replays the CPU
       * shadow to the exact CPU pose. Never used by Play. */
      gpuState:()=>({handle:gpuHandle,plan:lastPlan,plannedFrame,updated:mainCamera!==null,setup:lastSetup,litFrame:lastLitFrame,frameSetups:new Map(frameSetups),frameLights:new Map(frameLights),faces,faceWords,groups,hasEnvironment,
        exactOutput:()=>{exactSpheres();return frame.output;},get exactValid(){return exactValid;},
        // The CPU LOD of the exact output (call exactOutput first): drawn
        // positions, resolved corners, wedge dwords and lighting faces, or
        // null at full detail; `wedges` the mesh's Wedges dwords.
        lodDrawn:()=>gpuLodScalars?meshLod.after(lastSelection,lastReturned,frame.output):null,
        lodParams:gpuLodScalars?{...gpuLodScalars}:null,wedges:meshLod?.topology.wedges??null,
        // A child frame's LOD state (selection and returned count) on the
        // exact output (call exactOutput first): the GPU parameters and the
        // CPU drawn state, with its positions copied; the main frame's GPU
        // parameters; the mesh's LOD topology.
        lodVariant:(selection,returned)=>{
          let drawn=selection?meshLod.after(selection,returned,frame.output):null;
          if(drawn)drawn={...drawn,positions:Float32Array.from(drawn.positions)};
          return {params:paramsOf(selection,returned),drawn};
        },
        mainLodParams:()=>meshLod?paramsOf(gpuLodScalars?lastSelection:null,lastReturned):null,
        lodTopology:()=>meshLod?.topology??null,
        // The CPU twin of the GPU camera passes for a lighting frame `ctx`
        // ({origin, axes}; null: the main viewport's): the cache poses of
        // the current plan published through that frame's GetFrame matrix and
        // morphed by `selection`/`returned` (default: the main frame's); and
        // that matrix (4 rows of 3).
        cameraDrawn:(ctx=null,selection=gpuLodScalars?lastSelection:null,returned=lastReturned,frameIndex=null)=>{
          materialize();return cameraDrawn(ctx,selection,returned,lastPlan.channels,frameIndex);
        },
        cameraMatrix:(ctx=null,frameIndex=null)=>{
          const at=ctx??lighting.frame;
          return lodMeshCameraMatrix(payload,actor,attach?attach.coords(frameIndex):[...at.origin,...at.axes[0],...at.axes[1],...at.axes[2]],services);
        }}),
      get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
      /** Leave the GPU path after a context loss took the cache poses its
       * state textures held (docs/context-loss.md): the conversion record
       * for the page (gpu-mesh.mjs restore), or null on the CPU path. */
      leaveGpu(reason){
        if(disposed||mode!=='gpu')return null;
        toCpu(reason);toCpuReason=null;
        return {id,toCpu:reason,posed:posedCopy(),...(meshLod?{lod:lodRecord()}:{})};
      },
      /** Validation access (lod-probe.mjs): the last update's LOD inputs,
       * selection, returned count, final state and drawn faces. */
      lodState:()=>lastLod?{...lastLod,frames:(lastLod.frames??[]).map(entry=>({...entry,...frameStateOf(entry.index)})),mesh:meshReference.key,meshPackage:meshReference.asset?.name??null,meshIndex:meshReference.index??null,
        actor:actorName,path:mode,drawn:drawnMain}:null,
      /** One main-frame update: the frame record for the page, or null when
       * the binding is disposed. With `view.pack` (mesh-frame-pack.mjs) the
       * record's plan and lighting are offsets into the frame's words. */
      update(view={}){
        if(disposed)return null;
        const record=newUpdateRecord(id);drawnMain=false;
        if(lastLod){lastLod.updated=false;lastLod.frames=[];}
        // This frame's mesh_reads words (MB), or -1.
        const {u32,f32}=view.reads&&block?view.reads.views():{},at=u32&&u32[block>>2]&MS_OK?block>>2:-1;
        const verify=at>=0&&view.reads.verify;
        let rootVisible=admitted(view.reads,at);
        if(verify)verifyReads(u32,f32,at);
        // `view.children`: mirror child frames will draw this frame.
        // A Set: the ids OccludeFrame's child frames draw (sim-session.mjs).
        const childIds=view.children instanceof Set?view.children:null;
        childOnly=!rootVisible&&Boolean(view.children&&(childIds?childIds.has(id)
          :at>=0?childVisible&&u32[at+MB.STATUS]&MS_DRAWN_CHILD:childVisible?.(actor,own)));
        mainCamera=view.camera??null;
        // `view.main`: the ids in the main frame's Frame->Sprite (OccludeBsp,
        // docs/bsp-occlusion.md "Play"). An admitted actor outside it is not
        // drawn by the main frame; mirror child frames may still draw it.
        if(view.main&&rootVisible&&!childOnly&&!view.main.has(id)){if(!view.children||childIds&&!childIds.has(id))return record;childOnly=true;}
        if(childOnly)rootVisible=true;
        if(!rootVisible)return record;
        // Render.dll only draws, and so only calls GetFrame for, actors in
        // the view. Outside the frustum even a conservative bound of every
        // pose is culled here; three.js would cull each group anyway, so
        // render feedback is unchanged. Mirror frames disable this (view.cull).
        if(view.cull&&view.frustum&&!view.main){
          if(at>=0){
            const l=at+MB.LOCATION,p=at+MB.PREPIVOT;
            cullSphere.center.set(f32[l+1]+f32[p+1],f32[l+2]+f32[p+2],-(f32[l]+f32[p]));
            cullSphere.radius=cullRadius*Math.max(1,Math.abs(f32[at+MB.DRAWSCALE]))*1.01+1;
          }else{
            const location=own.Location(),pivot=own.PrePivot();
            cullSphere.center.set(location[1]+pivot[1],location[2]+pivot[2],-(location[0]+pivot[0]));
            cullSphere.radius=cullRadius*Math.max(1,Math.abs(own.DrawScale()))*1.01+1;
          }
          if(!view.frustum.intersectsSphere(cullSphere))return record;
        }
        if(at>=0?u32[at+MB.MESH]!==meshHandle:own.Mesh()!==meshReference)
          throw new Error(`${actorName} changed Mesh; rebuilding the inspection resource is unsupported`);
        return updateDrawn(view,record,at,u32,f32,verify);
      },
      summary};
    // The rest of a main-frame update, for a binding the frame draws. The closures below (the LOD choice, the lighting passes) make a
    // function that holds them allocate a context object whenever it is entered (scripts/closure-context-scan.mjs), and the
    // checks before this point turn most bindings away: they are in `update`, which makes none.
    function updateDrawn(view,record,at,u32,f32,verify){
        record.visible=true;record.childOnly=childOnly;drawnMain=!childOnly;
        const first=!drawnBefore;drawnBefore=true;
        // Actor.uc declares ScaleGlow as the lighting multiplier. With original
        // mesh lighting it is inside FLightManager::Light and the unlit colour;
        // the unlit inspection path applies it to the texture directly.
        const glow=lighting?1:Math.min(1,at>=0?f32[at+MB.SCALEGLOW]:own.ScaleGlow()),style=at>=0?u32[at+MB.STYLE]:own.Style();
        if(!materialStateApplied||!Object.is(glow,lastGlow)||!Object.is(style,lastStyle))record.material={glow,style};
        lastGlow=glow;lastStyle=style;materialStateApplied=true;
        // The pose changed: the block's numeric words against the last
        // update's (CHANGED) and the names, when the last update used the
        // block too; pose() against lastPose otherwise.
        let current=null,names=null,poseChanged;
        if(at>=0){
          const words=view.reads.views().u32;
          names=poseNames(identityOfHandle(words[at+MB.ANIMACTOR]));
          if(words[at+MB.LAST_VALID])poseChanged=Boolean(words[at+MB.STATUS]&MS_CHANGED)||!sameNames(names,lastNames);
        }
        if(poseChanged===undefined||verify){
          if(at<0&&block&&lastNames&&blockLastValid())lastPose=blockLastPose();
          current=pose();
          const changed=!current.every((value,index)=>Object.is(value,lastPose[index]));
          if(poseChanged!==undefined&&poseChanged!==changed)
            throw new Error(`RENDER_SCAN=verify: ${actorName} pose changed is ${poseChanged} from mesh_reads, ${changed} by pose()`);
          poseChanged=changed;
        }
        // DrawLodMesh in every frame that draws the binding (actor-mesh-lod.mjs),
        // in DrawFrame's order: the child frames first, the main frame last,
        // each with its own Coords and FX and one GetFrame call. The last one
        // is the base state of the record (the main frame's unless only child
        // frames draw the binding); the others that differ are drawn with
        // their own (frameVariants; docs/script-lodmesh-lod.md "Child frames").
        const lodFrames=[];let lodInputs=null;
        if(meshLod&&view.lodFrame){
          const location=at>=0?[f32[at+MB.LOCATION],f32[at+MB.LOCATION+1],f32[at+MB.LOCATION+2]]:own.Location();
          lodInputs={location,drawScale:at>=0?f32[at+MB.DRAWSCALE]:own.DrawScale(),lodBias:own.LODBias()};
          const choose=(inputs,index)=>{
            const chosen=meshLod.select(inputs,lodInputs.location,lodInputs.drawScale,lodInputs.lodBias);
            return {index,frame:inputs,chosen,selection:chosen.active?chosen:null,requested:chosen.active?chosen.requested:fullCount};
          };
          for(const entry of view.lodFrames??[])if(entry.ids.has(id))lodFrames.push(choose(entry.frame,entry.index));
          const main=choose(view.lodFrame,null);
          lastLod={frame:view.lodFrame,inputs:lodInputs,selection:main.chosen};
          if(!childOnly||!lodFrames.length)lodFrames.push(main);
        }
        const base=lodFrames.at(-1)??null,selection=base?.selection??null;
        // The GetFrame calls: consecutive frames asking for the same count
        // make the same call twice (a keyframe pose recomputed, a tween with
        // alpha 0), which the second need not run.
        const requests=[],callOf=[];
        for(const entry of lodFrames){
          if(!requests.length||requests.at(-1)!==entry.requested)requests.push(entry.requested);
          callOf.push(requests.length-1);
        }
        if(!requests.length)requests.push(fullCount);
        frameCallCount=lodFrames.length;
        for(let k=0;k<frameCallCount;k++){frameCallIndex[k]=lodFrames[k].index;frameCallValue[k]=callOf[k];}
        const callsKey=requests.join(',');
        // The detail matters only to a morph; the flags and the count to all.
        const detailKey=lodFrames.length?lodFrames.map(entry=>entry.selection?`${entry.selection.morph?bitsOf(entry.selection.detail):0}`:'off').join(','):'off';
        const callsChanged=callsKey!==lastCallsKey,lodChanged=callsChanged||detailKey!==lastDetail;
        lastDetail=detailKey;
        let posed=false;
        if((poseChanged||callsChanged)&&mode==='gpu'){
          if(planGpu(requests,first))record.plan=view.pack?view.pack.plan(lastPlan):plainPlan(lastPlan);
          posed=true;
        }
        // The GPU path's LOD parameters after GetFrame (the morph and corner
        // passes run them); the groups the reduced faces empty.
        if(mode==='gpu'&&meshLod&&(posed||lodChanged)){
          lastSelection=selection;
          const scalars=selection?lodMorphScalars(meshLod.topology,selection,lastReturned):null;
          gpuLodScalars=scalars?.active?scalars:null;
          const params=paramsOf(selection,lastReturned);
          const key=`${params.count}:${params.start}:${params.morph}:${params.active}:${bitsOf(params.inverse)}`;
          if(key!==lastLodKey){
            record.lodParams=params;lastLodKey=key;exactValid=false;
            const empty=emptyGroups(params);
            for(const group of groups.values())group.lodEmpty=empty.get(group);
          }
        }
        if((poseChanged||lodChanged)&&mode==='cpu'){
          // A plan evaluated for this frame before a fallback already posed it.
          if(!posed&&(poseChanged||callsChanged)){
            if(first)for(const key of [...cache.entries.keys()])cache.flush(key);
            const calls=requests.map(count=>getLodMeshFrame(payload,actor,coords,services,{output:frame.output,vertexCount:count}));
            callReturned=calls.map(call=>call.vertexCount);callOps=calls.map(call=>call.ops);
            lastReturned=callReturned.at(-1);
          }
          lodAfter(selection);
          cpuBounds();record.posed=posedCopy();
          if(meshLod)record.lod=lodRecord();
        }
        if(lastLod&&mode==='cpu')Object.assign(lastLod,{returned:lastReturned,state:lodDrawn?{...lodDrawn.state}:null,
          admitted:lodDrawn?.resolved?countAdmitted(lodDrawn.resolved):faces.count,
          vertices:lodDrawn?.resolved?countVertices(lodDrawn.resolved):null,updated:true});
        else if(lastLod)Object.assign(lastLod,{returned:lastReturned,
          state:gpuLodScalars?{active:true,morph:gpuLodScalars.morph,start:gpuLodScalars.start,count:gpuLodScalars.count}:null,
          admitted:gpuLodScalars?countLevel(meshLod.topology.faceLevel,gpuLodScalars.count):faces.count,vertices:null,updated:true});
        // The child frames whose state differs from the base's.
        frameVariants=NO_VARIANTS;
        if(meshLod&&lodFrames.length>1&&!planDegraded){
          frameVariants=new Map();
          const baseKey=stateKey(selection,callReturned[callOf.at(-1)]);
          lodFrames.forEach((entry,k)=>{
            if(entry===base)return;
            const returned=callReturned[callOf[k]],key=stateKey(entry.selection,returned);
            if(lastLod)(lastLod.frames??=[]).push({index:entry.index,frame:entry.frame,selection:entry.chosen,same:key===baseKey,
              main:baseKey,here:key,returned});
            if(key!==baseKey)frameVariants.set(entry.index,{index:entry.index,selection:entry.selection,returned,key,
              params:mode==='gpu'?paramsOf(entry.selection,returned):null,lodEmpty:null,exact:null,cpu:null});
          });
        }
        lastCallsKey=callsKey;
        let mainVisible;
        if(mode==='gpu'){
          mainVisible=false;
          const assign=(group,visible)=>{group.mainVisible=visible;mainVisible||=visible;};
          // A Frame->Sprite actor draws whole (DrawMesh); leaving out the
          // groups outside the frustum, which draw no pixels, is host culling.
          if(view.frustum)decideGroups(view.frustum,assign);else for(const group of groups.values())assign(group,true);
          const bits=groupBits();
          if(!lastAppliedGroups||bits.some((bit,i)=>bit!==lastAppliedGroups[i]))record.groups=bits;
          lastAppliedGroups=bits;
        }
        // One SetupForActor and Light pass per frame that draws the actor,
        // in DrawFrame's order: the child frames' sprites first (children
        // before their parent), the main frame's last. A child frame lights
        // with its own Coords, Mirror and LeafLights (view.lightFrames).
        frameLights.clear();frameSetups.clear();frameCtxs.clear();
        if(lighting&&view.lit&&lighting.frame){
          // `view.lightRoot`: the lighting frame of a root frame that is not the
          // main viewport's (a ViewportWindow's DrawWorld, updateFrame), for the
          // pass that is not a child frame's.
          const lightFrame=lf=>{
            const ctx=lf?lf.ctx:view.lightRoot??null,pool=lf?lf.index:0;
            if(mode==='gpu'){
              // A weapon takes the SetupForActor result its pawn's frame loop made right after the pawn's own (attach.takePrepared), with the pawn as sink.
              const prepared=attach?attach.takePrepared(lf?lf.index:null)??lighting.setupMesh(actor,null,attach.lightFrame(ctx),attach.setup())
                :lighting.setupMesh(actor,at>=0?setupFields(view.reads.views()):null,ctx);
              if(!prepared)return;
              if(lf){frameSetups.set(lf.index,prepared);frameCtxs.set(lf.index,ctx);}else{lastSetup=prepared;lastLitFrame=layout.frame+1;}
              if(!lf)summary.lighting={lights:prepared.setup.lights.length,flags:prepared.flags};
              if(layout.reserveLights(prepared.setup.lights.length,pool)){
                // The frame's GetFrame matrix: the page publishes the cached
                // poses in this frame's camera space for the lighting passes.
                // (a weapon's: the hand's Coords of the frame, GetFrame's Coords for DrawMesh, and the Mirror its lighting forces to 1.0)
                const here=ctx??lighting.frame,camera=lodMeshCameraMatrix(payload,actor,
                  attach?attach.coords(lf?lf.index:null):[...here.origin,...here.axes[0],...here.axes[1],...here.axes[2]],services);
                if(lf)frameLights.set(lf.index,{lighting:plainLighting(prepared,camera,attach?1:0)});
                else record.lighting=view.pack&&!attach?view.pack.lighting(prepared,camera):plainLighting(prepared,camera,attach?1:0);
              } else {
                toCpu(`more than ${prepared.setup.lights.length-1} selected lights`);
                record.posed=posedCopy();
                // The frames lit before the fallback now take the CPU path's colours.
                for(const [index,setup] of frameSetups)if(index!==lf?.index&&frameLights.get(index)?.lighting){
                  const earlier=relight(setup,frameCtxs.get(index),index);
                  if(earlier)frameLights.set(index,{colors:earlier.colors,cameraPoints:earlier.points});
                }
                const lit=relight(prepared,ctx,lf?lf.index:null);
                if(lit){if(lf)frameLights.set(lf.index,{colors:lit.colors,cameraPoints:lit.points});else{record.colors=lit.colors;record.cameraPoints=lit.points;summary.lighting=lit.summary;}}
              }
            } else {
              const lit=relight(undefined,ctx,lf?lf.index:null);
              if(lit){if(lf)frameLights.set(lf.index,{colors:lit.colors,cameraPoints:lit.points});else{record.colors=lit.colors;record.cameraPoints=lit.points;summary.lighting=lit.summary;}}
            }
          };
          // A pawn's weapon is lit right after its pawn in each frame (actor-weapon-sim.mjs afterLight): DrawActorSprite makes the
          // pawn's DrawMesh call and then the weapon's, which share the pawn's SetupForActor cache.
          const lightIn=lf=>{lightFrame(lf);view.afterLight?.(binding,lf?lf.index:null,lf?lf.ctx:view.lightRoot??null,lf);};
          for(const lf of view.lightFrames??[])if(lf.ids.has(id))lightIn(lf);
          // The main frame's pass: the actor in its Frame->Sprite (inside the
          // frustum: the host's culling); an actor only child frames draw
          // keeps the main lighting only without a child frame's.
          if(childOnly?frameLights.size===0&&!frameSetups.size
            :(!view.frustum||(mode==='gpu'?mainVisible:[...groups.values()].some(group=>
              !group.lodEmpty&&view.frustum.intersectsSphere(group.bounds.boundingSphere)))))lightIn(null);
        }
        if(toCpuReason){record.toCpu=toCpuReason;toCpuReason=null;record.posed??=posedCopy();}
        if(spheresChanged&&mode==='gpu'){record.spheres=sphereWords();spheresChanged=false;}
        if(at>=0){
          const words=view.reads.views().u32;
          words.copyWithin(at+MB.LAST,at+MB.POSE,at+MB.POSE+(MB.LAST-MB.POSE));words[at+MB.LAST_VALID]=1;lastNames=names;
          if(verify)lastPose=current;
        }else{lastPose=current??pose();if(block)new Uint32Array(arena.memory.buffer)[(block>>2)+MB.LAST_VALID]=0;}
        summary.animation=own.AnimSequence();summary.frame=own.AnimFrame();
        record.changed=poseChanged;
        return record;
    }
    return binding;
  } catch(error) {dispose();throw error;}
}

/** The level's actor mesh layer on the simulation side: the captured
 * Training NPC bindings plus every other visible LodMesh actor, admitted,
 * retired and updated in Render.dll's level-actor order. `onCreate(record)`
 * receives each binding's creation record when it is admitted; `onRelease(id)`
 * each retired binding. Props use a synthetic per-actor cache key, which
 * selects only tween/blend heap identity, never the drawn geometry; the
 * measured NPC identities keep their captured index. `player` is the player
 * actor or a getter for it (Player start logs a new player in). */
export async function createActorMeshSim(runtime,assets,asset,{kernel,player:playerSource,lighting=null,layout=null,
  childFrames=false,lod=true,weapons:drawWeapons=true,weaponMirrors=true,weaponOrder=null,weaponPath=null,onCreate=()=>{},onRelease=()=>{}}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource??null;
  const plumbing=actorPlumbing();
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  const textures=new TextureStore(assets);
  let nextId=1;
  // URender's LOD settings (lodmesh-lod.mjs RENDER_LOD_SETTINGS; the
  // console's MLOD, MLMODE and MLFIX change them in the original).
  let lodSettings=RENDER_LOD_SETTINGS;
  // A binding's creation record is a message: it goes to the page when the binding is admitted and nothing here reads it again, so the
  // binding does not keep it (about forty heap objects a binding: the record, its groups, plan and posed pose).
  const emitCreation=binding=>{const creation=binding.creation;binding.creation=null;onCreate(creation);};
  const bind=async(actor,options)=>{
    const binding=await createMeshBinding(runtime,actor,{id:nextId++,kernel,lighting,layout,textures,lod,...options});
    return binding;
  };
  const npcActors=[],propActors=[],errors=[];
  const actors=[],bindings=new Map();
  // Bumped whenever `actors` gains or loses a binding (the pair table of meshReads follows it).
  let actorsVersion=0;
  // The roster (render.rs roster_reads, docs/firefox-60fps-plan.md "Actors layer in bulk"): one row of four words in the arena for each
  // binding of `actors`, in its order (the actor's handle, the binding's block, the handle of the Mesh it was made for, its index in
  // Level.Actors), which the Rust pass reads the blocks, the membership and the Mesh change from for every binding at once. Rows are
  // kept with the list (rowAdd at a take, rowRemove at a retire) whatever the mode, so a frame the pass cannot run in
  // (RENDER_SCAN=js, an incomplete field table) takes the JavaScript path and the next one the pass. ACTOR_PLUMBING=no-roster keeps
  // that path always.
  const ROW_WORDS=4,NO_POS=0xffffffff;
  let rows=0,rowsCapacity=0,rowCount=0,rowsDirty=true,positionsEpoch=-1;
  const rowsArena=()=>runtime.scriptVm?.arena??null;
  const rowsView=()=>new Uint32Array(rowsArena().memory.buffer);
  const rowWrite=(k,binding)=>{
    const u32=rowsView(),at=(rows>>2)+ROW_WORDS*k;
    u32[at]=handleOf(binding.actor);u32[at+1]=binding.block||0;u32[at+2]=binding.meshHandle??0;u32[at+3]=NO_POS;
  };
  const rowAdd=binding=>{
    const arena=rowsArena();
    if(!arena)return;
    if(ROW_WORDS*4*(rowCount+1)>rowsCapacity){
      const grown=Math.max(4096,2*ROW_WORDS*4*(rowCount+1)),next=arena.alloc(grown);
      if(rows){new Uint32Array(arena.memory.buffer).copyWithin(next>>2,rows>>2,(rows>>2)+ROW_WORDS*rowCount);arena.release(rows,rowsCapacity);}
      rows=next;rowsCapacity=grown;
    }
    binding.row=rowCount;rowWrite(rowCount,binding);rowCount++;rowsDirty=true;
  };
  const rowRemove=binding=>{
    const k=binding.row;
    if(!rows||k<0||k>=rowCount||actors[k]===binding)return;   // (called after the list lost the binding: its place holds the next one)
    rowsView().copyWithin((rows>>2)+ROW_WORDS*k,(rows>>2)+ROW_WORDS*(k+1),(rows>>2)+ROW_WORDS*rowCount);
    rowCount--;binding.row=-1;
    for(let j=k;j<actors.length;j++)actors[j].row=j;
  };
  if(asset.name.toLowerCase()==='00_training') {
    // Measured GObjObjects identities from the same original Training
    // capture select fixtures and cache keys, never character-specific
    // drawing; no visibility admission for them.
    const npcErrors=[];
    for(const [name,originalObjectIndex] of Object.entries(TRAINING_NPC_IDENTITIES)) {
      try {
        const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()));
        if(runtime.readNamed(actor,'bHidden'))continue;
        const binding=await bind(actor,{originalObjectIndex});
        binding.creation.visible=true;
        npcActors.push(binding);actors.push(binding);rowAdd(binding);actorsVersion++;bindings.set(actor,binding);emitCreation(binding);
      } catch(error) {npcErrors.push({actor:name,message:error.message});}
    }
    if(npcActors.length)errors.push(...npcErrors);
    else errors.push({actor:'NPCs',message:npcErrors.map(e=>`${e.actor}: ${e.message}`).join('; ')});
  }
  const level=currentPlayer()?runtime.levelFor(currentPlayer()):null;
  const read=(actor,name)=>{try{return runtime.readNamed(actor,name);}catch{return undefined;}};
  // Render.dll's level-actor pass (0x10b22e27-0x10b22ef8), for the player's
  // main frame: skip the actor its caller excludes (0x10b1a161-0x10b1a18e:
  // none when bBehindView, +0x318 bit 0, else the ViewTarget, +0x60c, or the
  // view actor itself), the ViewTarget unless bBehindView, a hidden actor, a
  // bOnlyOwnerSee actor the view actor does not own (IsOwnedBy walks Owner
  // +0x3c) or sees from behind, and a bOwnerNoSee actor it owns in first
  // person. Both viewer rejections belong to the root frame only: a mirror's
  // child frame (`child`) draws the player in first person. The viewer's
  // fields are read once per update (no script runs while the actor layer
  // updates); asynchronous admission reads them afresh.
  let frameViewer=null;
  const viewer=()=>{
    if(frameViewer)return frameViewer;
    const player=currentPlayer();
    return player?{player,behind:Boolean(read(player,'bBehindView')),viewTarget:read(player,'ViewTarget')}:{player:null};
  };
  const drawnInWorld=(actor,own=null,child=false)=>{
    if(own?(own.bHidden()||own.bDeleteMe()):(read(actor,'bHidden')||read(actor,'bDeleteMe')))return false;
    const {player,behind,viewTarget}=viewer();
    if(!player)return true;
    if(!child&&!behind&&actor===(viewTarget??player))return false;
    if(!child&&!behind&&viewTarget===actor)return false;
    let owned=false;
    for(let owner=actor;owner;owner=own&&owner===actor?own.Owner():read(owner,'Owner'))if(owner===player){owned=true;break;}
    if((own?own.bOnlyOwnerSee():read(actor,'bOnlyOwnerSee'))&&(!owned||behind))return false;
    return !(owned&&(own?own.bOwnerNoSee():read(actor,'bOwnerNoSee'))&&!behind);
  };
  let synthetic=0x40000000,disposed=false,started=false;
  const pending=new Map(),failed=new WeakMap();
  // `late`: actors admitted after the layer started whose resources were not
  // resident (createMeshBindingNow), so not drawn in their first frame.
  const summary={actors:[],errors,poseBackend:kernel?.name??'javascript',kernelError,gpu:Boolean(layout),
    npcs:npcActors.length,props:0,skipped:[],triangles:0,late:[],
    // the frames' records sent to the page, and the plain hidden ones compactRecords did not send (cumulative; under verify, the ones it
    // sent marked as skippable)
    records:0,hiddenSkipped:0,
    shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original'};
  // `target` receives the lists and counts made from every binding.
  const makeSummary=target=>{
    target.actors=actors.map(actor=>actor.summary);
    target.skipped=actors.flatMap(actor=>actor.summary.skipped.map(s=>({actor:actor.summary.actor,...s})));
    target.triangles=actors.reduce((total,actor)=>total+actor.summary.triangles,0);
  };
  // A take or a retire is a change of the list, and the lists and counts above are made from every binding: at the Dockyard (the gas
  // puffs are admitted and retired within frames) that was 0.34 ms a frame in Firefox and 64 KB of garbage. With ACTOR_PLUMBING's
  // `summary` they are made when read (the status request, the page's status line), from the bindings as they are then; a binding's
  // own summary lists and triangles do not change after it is taken, so that is what the refresh at the change would have held
  // (`verify` makes both and compares). `no-summary` keeps the refresh at every change.
  let summaryDirty=false,expected=null;
  const held={actors:summary.actors,skipped:summary.skipped,triangles:summary.triangles};
  // (verify: what the refresh at the change would have made, kept to compare with what the read makes)
  const expectation=()=>{const made={};makeSummary(made);return {actors:made.actors,skipped:JSON.stringify(made.skipped),triangles:made.triangles};};
  if(plumbing.summary){
    for(const key of Object.keys(held))Object.defineProperty(summary,key,{enumerable:true,configurable:true,
      get(){
        if(summaryDirty){
          summaryDirty=false;makeSummary(held);
          if(expected){
            const want=expected;expected=null;
            if(want.actors.length!==held.actors.length||want.actors.some((entry,i)=>entry!==held.actors[i])||want.skipped!==JSON.stringify(held.skipped)
              ||want.triangles!==held.triangles)throw new Error('ACTOR_PLUMBING=verify: the summary made at the read differs from the refresh at the change');
          }
        }
        return held[key];
      },set(value){held[key]=value;}});
  }
  const refreshSummary=()=>{
    summary.props=propActors.length;summary.npcs=npcActors.length;
    if(plumbing.summary){summaryDirty=true;if(plumbing.verify)expected=expectation();}else makeSummary(summary);
  };
  const retired=new WeakMap();
  // The pawns' third-person weapons (actor-weapon-sim.mjs): bindings of their own, lit in the frames that draw the pawn right after
  // the pawn's own lighting there (weapons.interleave) and posed and drawn after the pawns (weapons.update).
  const weapons=createWeaponAttachments({runtime,bind:(actor,options)=>bind(actor,options),lighting,onCreate,onRelease,
    nextIndex:()=>synthetic++,errors,enabled:drawWeapons,mirrors:weaponMirrors,interleave:weaponOrder!=='late',
    // the weapons take the GPU path with the actors' layout unless ?weapons=cpu (the CPU path stays the reference and the fallback)
    layout:weaponPath==='cpu'?null:layout});
  const admit=(actor,readMesh=null)=>{
    if(disposed||!actor||bindings.has(actor)||pending.has(actor))return;
    let mesh;
    if(readMesh){try{mesh=readMesh.read(runtime,'Mesh');}catch{mesh=undefined;}}else mesh=read(actor,'Mesh');
    if(failed.get(actor)===mesh)return;
    if(!mesh||(mesh.kind!=='LodMesh'&&mesh.kind!=='Mesh')||!read(actor,'Location'))return;
    // A map with mirrors also admits actors only its child frames draw.
    if(!drawnInWorld(actor)&&!(childFrames&&drawnInWorld(actor,null,true)))return;
    admitNew(actor,mesh);
  };
  // admit's creation of the binding, apart from its checks: the closures below make a function that holds them allocate a context object
  // whenever it is entered (scripts/closure-context-scan.mjs), and admit turns back nearly every actor of every update.
  const admitNew=(actor,mesh)=>{
    const npc=retired.get(actor)??false;retired.delete(actor);
    const options={id:nextId++,kernel,lighting,layout,textures,lod,originalObjectIndex:synthetic++,visible:drawnInWorld,
      childVisible:childFrames?(actor,own)=>drawnInWorld(actor,own,true):null,reads:true};
    const take=binding=>{
      bindings.set(actor,binding);actors.push(binding);rowAdd(binding);actorsVersion++;(npc?npcActors:propActors).push(binding);refreshSummary();
      // Shown from admission, before its first update (as the layer did).
      binding.creation.visible=drawnInWorld(actor);
      emitCreation(binding);
    };
    const fail=error=>{failed.set(actor,mesh);errors.push({actor:actor.name??'?',message:error.message});};
    // The original's DrawActorSprite draws and stamps an actor spawned in a
    // tick in the frame after that tick (0x10b25150): its mesh and skins are
    // resident since the level loaded (the spawn closure prepares them,
    // script-doors.mjs). The binding is made in this frame, before its
    // SetupDynamics and stamps, when they are; else its resources load first
    // and it is made later (summary.late once the layer has started).
    let binding;
    try{binding=createMeshBindingNow(runtime,actor,options);}catch(error){fail(error);return;}
    if(binding){take(binding);return;}
    if(started&&summary.late.length<64)summary.late.push({actor:actor.name??'?',mesh:mesh.key});
    const task=createMeshBinding(runtime,actor,options)
      .then(binding=>{
        if(disposed||!level.actors.includes(actor)||read(actor,'bDeleteMe')||read(actor,'Mesh')!==mesh){binding.dispose();return;}
        take(binding);
      }).catch(fail)
      .finally(()=>pending.delete(actor));
    pending.set(actor,task);
  };
  const retire=(actor,binding)=>{
    weapons.drop(binding);
    binding.dispose();bindings.delete(actor);onRelease(binding.id);
    for(const list of [actors,propActors,npcActors]){const at=list.indexOf(binding);if(at>=0)list.splice(at,1);}
    rowRemove(binding);
    actorsVersion++;
    refreshSummary();
  };
  // Level.Actors membership only changes with actorsEpoch (base-epoch.mjs),
  // so the membership set is rebuilt only then. Every actor's Mesh is read
  // every update through an accessor (actor-fields.mjs) kept in Level.Actors
  // order.
  let live=null,liveEpoch=-1,liveList=[],meshReaders=[],levelIndex=new Map();
  const meshAccessors=new Map();
  // The slots `live` was made from: when the level's array is the same and its slots are the same up to that count, the actors that
  // joined came at its end (a spawn), and are added to what the rebuild would make (a rebuild of the set, the list, the index and
  // the accessor array from 2,400 slots, at each of the spawns' epochs).
  let liveMembers=[],liveActors=null;
  const extendLive=epoch=>{
    const actors=level.actors,length=liveMembers.length;
    if(actors!==liveActors||actors.length<length)return false;
    for(let i=0;i<length;i++)if(liveMembers[i]!==actors[i])return false;
    for(let i=length;i<actors.length;i++){
      const actor=actors[i];
      liveMembers.push(actor);
      if(live.has(actor))continue;
      live.add(actor);liveList.push(actor);
      if(actor&&!levelIndex.has(actor))levelIndex.set(actor,i);
      if(!actor){meshReaders.push(null);continue;}
      let reader=meshAccessors.get(actor);
      if(reader===undefined)meshAccessors.set(actor,reader=new FieldReader(actor));
      meshReaders.push(reader);
    }
    liveEpoch=epoch;
    return true;
  };
  const reconcileJs=(reads=null)=>{
    if(disposed||!level)return;
    syncLive();
    // (`actors` holds the bindings in the order `bindings` does, both appended together and removed together by retire; a retired
    // binding leaves the list, so the index stays where it is)
    for(let i=0;i<actors.length;){
      const binding=actors[i],actor=binding.actor;
      if(!live.has(actor)){retire(actor,binding);continue;}
      // A script can change Mesh (Inventory.BecomeItem/BecomePickup). The new
      // mesh is admitted like a newly visible actor (admit).
      if(binding.meshChanged(reads)){retired.set(actor,npcActors.includes(binding));retire(actor,binding);continue;}
      i++;
    }
    // The render scan (script-vm-render.mjs) leaves the actors with a live
    // Mesh, and those it hands back; admit returns at once for the others.
    const entries=runtime.scriptVm?.render?.scan(level.actors,{kinds:RENDER_MESH})??null;
    if(entries)for(const entry of entries){const actor=level.actors[entry>>>RENDER_SHIFT];admit(actor,meshAccessors.get(actor));}
    else for(let i=0;i<liveList.length;i++)admit(liveList[i],meshReaders[i]);
  };
  // The roster's reconcile: what the loop of reconcileJs decides for every binding, from the Rust pass's attention list (roster_reads),
  // and the admission scan without the entries admit would turn away without effect. The membership set, the index map and the
  // accessors of reconcileJs are not made (a frame the pass cannot run in makes them: `syncLive`).
  const rosterReady=reads=>rosterOn&&(reads?.attn!==undefined||rowCount===0);
  const rosterOn=plumbing.roster&&Boolean(rowsArena())&&Boolean(runtime.scriptVm?.render)&&renderScanMode()!=='js';
  const reconcileRoster=reads=>{
    if(disposed||!level)return;
    const render=runtime.scriptVm.render,attn=reads?.attn??null;
    if(attn&&attn.length){
      // (the retires shift the list, so the bindings are picked first)
      const picked=new Array(attn.length);
      for(let i=0;i<attn.length;i++)picked[i]=actors[attn[i]>>>4];
      for(let i=0;i<attn.length;i++){
        const binding=picked[i],reasons=attn[i]&15,actor=binding.actor;
        if(reasons&RS_STALE){rowWrite(binding.row,binding);rowsDirty=true;}
        if(reasons&RS_ABSENT){retire(actor,binding);continue;}
        if(reasons&RS_MESH){retired.set(actor,npcActors.includes(binding));retire(actor,binding);continue;}
        if(reasons&(RS_NOT_OK|RS_STALE)&&binding.meshChanged(reads)){retired.set(actor,npcActors.includes(binding));retire(actor,binding);}
      }
    }
    const {player,behind,viewTarget}=viewer();
    const kept=render.admitScan(level.actors,rows,rowCount,{player,behind,viewTarget,childFrames});
    if(!kept){
      // (the pass cannot run here: the scan of reconcileJs)
      const entries=render.scan(level.actors,{kinds:RENDER_MESH});
      if(entries){for(const entry of entries){const actor=level.actors[entry>>>RENDER_SHIFT];admit(actor,meshAccessors.get(actor));}}
      else{syncLive();for(let i=0;i<liveList.length;i++)admit(liveList[i],meshReaders[i]);}
      return;
    }
    if(plumbing.verify){const full=render.scan(level.actors,{kinds:RENDER_MESH});if(full)verifyAdmission(full,kept);}
    for(const entry of kept){const actor=level.actors[entry>>>RENDER_SHIFT];admit(actor,meshAccessors.get(actor));}
    // A binding made just now is a candidate of this frame's SetupDynamics (reconcileJs' index map held it): its row needs its place.
    if(rowsDirty&&rowCount>0)positionRows();
  };
  const positionRows=()=>{
    if(!runtime.scriptVm?.render?.rosterPositions(rows,rowCount,level.actors)){rowsDirty=true;return false;}
    rowsDirty=false;positionsEpoch=actorsEpoch();return true;
  };
  // ACTOR_PLUMBING=verify: the roster's rows, positions and attention list against what the JavaScript loop of reconcileJs decides from
  // the level's array and the bindings.
  const verifyRoster=(reads,withList)=>{
    const fail=message=>{throw new Error(`ACTOR_PLUMBING=verify: roster: ${message}`);};
    if(rowCount!==actors.length)fail(`${rowCount} rows for ${actors.length} bindings`);
    const u32=rowsView(),first=new Map(),member=new Set();
    for(let i=0;i<level.actors.length;i++){const actor=level.actors[i];if(actor){member.add(actor);if(!first.has(actor))first.set(actor,i);}}
    const reasonsOf=new Map();
    for(const entry of reads.attn)reasonsOf.set(entry>>>4,entry&15);
    for(let k=0;k<actors.length;k++){
      const binding=actors[k],at=(rows>>2)+ROW_WORDS*k,reasons=reasonsOf.get(k)??0;
      if(binding.row!==k)fail(`${binding.actor.name} has row ${binding.row}, not ${k}`);
      if(u32[at]!==handleOf(binding.actor)&&!(reasons&RS_STALE))fail(`${binding.actor.name} row ${k} holds handle ${u32[at]}, not ${handleOf(binding.actor)}`);
      if(u32[at+1]!==(binding.block||0))fail(`${binding.actor.name} row ${k} holds block ${u32[at+1]}, not ${binding.block}`);
      if(u32[at+2]!==(binding.meshHandle??0))fail(`${binding.actor.name} row ${k} holds mesh ${u32[at+2]}, not ${binding.meshHandle}`);
      if(withList){
        const want=first.has(binding.actor)?first.get(binding.actor):NO_POS;
        if(u32[at+3]!==want)fail(`${binding.actor.name} row ${k} is at position ${u32[at+3]}, the level has it at ${want}`);
        if((want===NO_POS)!==Boolean(reasons&RS_ABSENT))fail(`${binding.actor.name} row ${k}: absent is ${Boolean(reasons&RS_ABSENT)}, the level says ${want===NO_POS}`);
      }
      if(!reasons&&binding.meshChanged(reads))fail(`${binding.actor.name} row ${k} changed its Mesh and has no reason`);
      if((reasons&RS_MESH)&&!binding.meshChanged(reads))fail(`${binding.actor.name} row ${k} has the Mesh reason but its Mesh did not change`);
      // (no pass looked at the membership: the level's array has not changed since one did)
      if(!withList&&!member.has(binding.actor))fail(`${binding.actor.name} row ${k} is not in the level, and the epoch is the one the positions were made at`);
    }
  };
  // ACTOR_PLUMBING=verify: an entry of the admission scan that admit_filter dropped is for a bound actor or one drawnInWorld rejects.
  const verifyAdmission=(entries,kept)=>{
    const keptSet=new Set(kept);
    for(const entry of entries){
      if(keptSet.has(entry))continue;
      const actor=level.actors[entry>>>RENDER_SHIFT];
      if(bindings.has(actor))continue;
      if(drawnInWorld(actor)||(childFrames&&drawnInWorld(actor,null,true)))
        throw new Error(`ACTOR_PLUMBING=verify: roster: the admission filter dropped ${actor.name}, which is not bound and is drawn in the world`);
    }
  };
  // The JavaScript path's membership structures, made when this frame needs them.
  // (Level.Actors membership only changes with actorsEpoch (base-epoch.mjs), so they are made again only then; the accessors of the
  // actors still in the level are kept in place, and those of the others dropped: a second Map of all of them, and the first one filled
  // again, was about 600 KB each time the level's actors change. When Level.Actors only grew at its end, they are extended in place.)
  const syncLive=()=>{
    const epoch=actorsEpoch();
    if(epoch!==liveEpoch&&live&&extendLive(epoch))return;
    if(epoch===liveEpoch&&live)return;
    live=new Set(level.actors);liveEpoch=epoch;liveList=[...live];liveMembers=level.actors.slice();liveActors=level.actors;
    levelIndex=new Map();
    for(let i=0;i<level.actors.length;i++){const actor=level.actors[i];if(actor&&!levelIndex.has(actor))levelIndex.set(actor,i);}
    meshReaders=new Array(liveList.length);
    for(let i=0;i<liveList.length;i++){
      const actor=liveList[i];
      if(!actor){meshReaders[i]=null;continue;}
      let reader=meshAccessors.get(actor);
      if(reader===undefined)meshAccessors.set(actor,reader=new FieldReader(actor));
      meshReaders[i]=reader;
    }
    for(const actor of meshAccessors.keys())if(!live.has(actor))meshAccessors.delete(actor);
  };
  const reconcile=reads=>{
    rosterUsed=rosterReady(reads);
    if(rosterUsed)reconcileRoster(reads);
    else reconcileJs(reads);
  };
  // Render-iterator mesh items (docs/lasers.md): each FDynamicSprite of a
  // DT_Mesh item draws through DrawActorSprite (0x10b2556a-0x10b25655), which
  // writes the snapshot's ScaleGlow, DrawScale, Location and Rotation into
  // the actor, calls DrawMesh and restores them. One binding per item slot
  // of the actor, updated the same way; items draw whatever the actor's
  // bHidden (SetupDynamics admits the iterating actor, not its items).
  const itemPools=new Map(),SNAPSHOT=[['ScaleGlow','scaleGlow'],['DrawScale','drawScale'],['Location','location'],['Rotation','rotation']];
  // Each frame's SetupDynamics builds its own items (docs/bsp-occlusion.md
  // "Each child frame's own SetupDynamics"), and DrawFrame draws each frame's
  // sprites with DrawActorSprite, which writes that sprite's own snapshot into
  // the actor (0x10b2556a-0x10b25655) before DrawMesh poses, lights and draws
  // it in that frame. An item some frame holds that the root frame's items at
  // the same slot do not equal (a laser's saved last item, an electric arc's
  // random beam) is therefore a binding of its own: an "extra", drawn only in
  // the frames that hold it, as a sprite record of its own is. Items equal to a
  // root frame's item share that item's binding, drawn in every frame that
  // holds it with that frame's lighting and LOD.
  const itemExtras=new Map();
  const bits32=new Float32Array(1),words32=new Uint32Array(bits32.buffer);
  const wordOf=value=>{bits32[0]=value;return words32[0];};
  const itemKey=(item,slot)=>`${slot}:${item.location.map(wordOf).join()}:${item.rotation.join()}:${wordOf(item.drawScale)}:${wordOf(item.scaleGlow)}`;
  /** The items one planning of a root frame has bound: `known` (actor ->
   * item key -> binding), `itemOf` (binding -> its item) and the extras in use
   * (`used`, with a per-actor `cursor` into the actor's extras). */
  let scope=null;
  const newScope=baseItems=>{
    const made={known:new Map(),itemOf:new Map(),cursor:new Map(),used:new Set()},counts=new Map();
    for(const item of baseItems){
      const slot=counts.get(item.actor)??0;counts.set(item.actor,slot+1);
      const binding=itemPools.get(item.actor)?.[slot]?.binding;
      if(!binding)continue;
      if(!made.known.has(item.actor))made.known.set(item.actor,new Map());
      made.known.get(item.actor).set(itemKey(item,slot),binding);made.itemOf.set(binding,item);
    }
    return made;
  };
  const createItemBinding=(item,entry,alive)=>{
    bind(item.actor,{originalObjectIndex:synthetic++,visible:()=>true})
      .then(binding=>{if(disposed||!alive()){binding.dispose();return;}
        entry.binding=binding;emitCreation(binding);})
      .catch(error=>{entry.failed=error.message;errors.push({actor:`${item.actor.name??'?'} item`,message:error.message});});
  };
  /** One item's update with its snapshot written into the actor, and restored. */
  const lastItems=new Map();
  const withItem=(item,run,binding)=>{
    if(binding)lastItems.set(binding.id,item);
    const saved=SNAPSHOT.map(([name])=>runtime.readNamed(item.actor,name));
    try{
      for(const [name,key] of SNAPSHOT)runtime.writeNamed(item.actor,name,item[key]);
      return run();
    }finally{SNAPSHOT.forEach(([name],i)=>runtime.writeNamed(item.actor,name,saved[i]));}
  };
  // A level actor that an iterator moves is drawn from its sprite's copy of the fields, which the frame's SetupDynamics took after the
  // iterator last moved it (FDynamicSprite::Setup 0x10b23910, DrawActorSprite 0x10b2556a-0x10b25655: docs/lasers.md "The proxy's own
  // sprite"). A later SetupDynamics of the same tick (a child frame's, which runs the iterators again) leaves the actor elsewhere, so
  // the binding of the frame that took the copy updates with it written into the actor, and restored, as for an item.
  const sameSprite=item=>{
    const actor=item.actor,location=runtime.readNamed(actor,'Location'),rotation=runtime.readNamed(actor,'Rotation');
    return Object.is(Math.fround(location[0]),item.location[0])&&Object.is(Math.fround(location[1]),item.location[1])
      &&Object.is(Math.fround(location[2]),item.location[2])&&rotation[0]===item.rotation[0]&&rotation[1]===item.rotation[1]
      &&rotation[2]===item.rotation[2]&&Object.is(Math.fround(runtime.readNamed(actor,'DrawScale')),item.drawScale)
      &&Object.is(Math.fround(runtime.readNamed(actor,'ScaleGlow')),item.scaleGlow);
  };
  /** `binding`'s update in the frame whose SetupDynamics took `sprites` (sprite-scan.mjs `proxies`: actor -> copy). */
  // A binding's index in Level.Actors (the first slot holding its actor; undefined or NO_POS for none), from the map of the JavaScript
  // path or the roster's row; `levelPositions` is what packDynamics reads the same from.
  const levelIndexOf=binding=>{
    if(!rosterUsed)return levelIndex.get(binding.actor);
    return binding.row>=0?rowsView()[(rows>>2)+ROW_WORDS*binding.row+3]:undefined;
  };
  let rosterUsed=false;
  const levelPositions={bindings:actors,u32:()=>rowsView().subarray(rows>>2,(rows>>2)+ROW_WORDS*rowCount),NO_POS};
  // The index map packDynamics orders the bindings by: the roster's rows when this frame's reconcile used them, else the map.
  const positionsFor=()=>rosterUsed?levelPositions:levelIndex;
  const updateSprite=(sprites,binding,view)=>{
    const item=sprites.get(binding.actor);
    if(!item||sameSprite(item))return binding.update(view);
    // Only the order the shipped maps have is translated: the proxy follows its emitter in Level.Actors (spawned by it), so the
    // frame's SetupDynamics copies the fields after the run. A proxy before its emitter would be copied as the previous run left it.
    if(levelIndexOf(binding)<item.emitter){
      if(view.reads?.verify)throw new Error(`RENDER_SCAN=verify: ${binding.actor.name??'?'} precedes its emitter in Level.Actors (its sprite's fields are the previous run's: unsupported)`);
      return binding.update(view);
    }
    return withItem(item,()=>binding.update(view));
  };
  // Whether Level.Actors holds the actor now: the JavaScript path's set, or a set made when asked for at the level's epoch (a frame
  // the roster served makes none otherwise).
  let askedLive=null,askedEpoch=-1;
  const isLive=actor=>{
    if(!rosterUsed)return Boolean(live?.has(actor));
    const epoch=actorsEpoch();
    if(!askedLive||askedEpoch!==epoch){askedLive=new Set(level.actors);askedEpoch=epoch;}
    return askedLive.has(actor);
  };
  const drawItems=(items,view,records)=>{
    const counts=new Map();
    for(const item of items){
      const slot=counts.get(item.actor)??0;counts.set(item.actor,slot+1);
      let pool=itemPools.get(item.actor);
      if(!pool)itemPools.set(item.actor,pool=[]);
      if(!pool[slot]){
        const entry=pool[slot]={binding:null};
        createItemBinding(item,entry,()=>itemPools.get(item.actor)===pool);
        continue;
      }
      const binding=pool[slot].binding;
      if(!binding)continue;
      records.push(withItem(item,()=>binding.update(view),binding));
    }
    for(const [actor,pool] of itemPools){
      const used=counts.get(actor)??0;
      if(!used&&(!isLive(actor)||read(actor,'bDeleteMe'))){
        for(const entry of pool)if(entry.binding){entry.binding.dispose();onRelease(entry.binding.id);}
        itemPools.delete(actor);continue;
      }
      for(let i=used;i<pool.length;i++)if(pool[i].binding)records.push(pool[i].binding.hide());
    }
    for(const [actor,list] of itemExtras)
      if(!itemPools.has(actor)&&(!isLive(actor)||read(actor,'bDeleteMe'))){
        for(const entry of list)if(entry.binding){entry.binding.dispose();onRelease(entry.binding.id);}
        itemExtras.delete(actor);
      }
  };
  /** The extras the frames of this planning hold, updated with their own
   * items; the others are hidden. */
  const drawExtras=(view,records)=>{
    for(const binding of scope?.used??[])records.push(withItem(scope.itemOf.get(binding),()=>binding.update(view),binding));
    for(const list of itemExtras.values())
      for(const entry of list)if(entry.binding&&!scope?.used.has(entry.binding))records.push(entry.binding.hide());
  };
  const itemBindings=()=>[...itemPools.values(),...itemExtras.values()].flatMap(pool=>pool.map(entry=>entry.binding).filter(Boolean));
  /** This frame's iterator items with the binding drawItems will update for
   * each (the same slots), where one exists. A child frame's (or another
   * root frame's, `frame` its name) item equal to one already bound in this
   * planning (the base items', or an earlier frame's) shares that binding;
   * any other takes an extra of the actor's, made when it does not exist yet
   * (the item is not drawn until the binding exists, as for a new slot). */
  const itemCandidates=(items,frame)=>{
    const counts=new Map(),out=[];
    for(const item of items){
      const slot=counts.get(item.actor)??0;counts.set(item.actor,slot+1);
      if(frame===undefined||!scope){
        const binding=itemPools.get(item.actor)?.[slot]?.binding;
        if(binding)out.push({item,binding});
        continue;
      }
      if(!scope.known.has(item.actor))scope.known.set(item.actor,new Map());
      const keys=scope.known.get(item.actor),key=itemKey(item,slot);
      let binding=keys.get(key);
      // An item whose root slot has no binding yet (a new slot, still being made) has nothing to differ from.
      if(!binding&&!itemPools.get(item.actor)?.[slot]?.binding)continue;
      if(!binding){
        let list=itemExtras.get(item.actor);
        if(!list)itemExtras.set(item.actor,list=[]);
        const at=scope.cursor.get(item.actor)??0;scope.cursor.set(item.actor,at+1);
        if(!list[at])createItemBinding(item,list[at]={binding:null},()=>itemExtras.get(item.actor)===list);
        binding=list[at].binding;
        if(binding){keys.set(key,binding);scope.itemOf.set(binding,item);scope.used.add(binding);}
      }
      if(binding)out.push({item,binding});
    }
    return out;
  };
  // The bindings' per-frame reads in one Rust pass (render.rs mesh_reads)
  // before their updates, which write none of the fields it reads: each
  // binding's block, or null when the pass cannot run (the script VM has no
  // render host, ?renderScan=js). Item bindings read the snapshot their item
  // writes, so they keep their own reads.
  // The (handle, block) pairs follow the `actors` list (a binding's block is made with it and zeroed when it is retired, which
  // takes it out of the list) and each actor's handle. A destroyed actor's handle can be released before its binding is retired
  // at the next membership sync, and handleOf then gives it another: so the table is written again when the list changes
  // (`actorsVersion`), when Level.Actors changes (actorsEpoch: DestroyActor) or when a receiver is freed (receiverEpoch), and
  // kept between frames otherwise (the bunker's spawns and destroys made a kept handle stale, caught by verify, 2026-11-06).
  // ACTOR_PLUMBING=no-pairs rewrites it every frame, and `verify` checks the kept table against a rewrite.
  let pairs=0,pairsCapacity=0,pairsCount=0,pairsVersion=-1,pairsActors=-1,pairsReceivers=-1,pairsCheck=0;
  const writePairs=(arena,at)=>{
    let count=0;
    for(const binding of actors){
      if(!binding.block)continue;
      arena.view.setUint32(at+8*count,handleOf(binding.actor),true);
      arena.view.setUint32(at+8*count+4,binding.block,true);count++;
    }
    return count;
  };
  // Typed views of the arena's current buffer: a memory growth during an update (the GPU plan, the light selection) replaces it.
  // (one object, its arrays replaced with the buffer: callers read both at once and keep neither)
  const viewsOf=arena=>{
    let buffer=null;
    const current={u32:null,f32:null};
    return ()=>{
      if(arena.memory.buffer!==buffer){buffer=arena.memory.buffer;current.u32=new Uint32Array(buffer);current.f32=new Float32Array(buffer);}
      return current;
    };
  };
  // The roster's pass in place of meshReads' pair table (render.rs roster_reads): the same blocks, and the rows' positions in
  // Level.Actors when the level's array or the rows changed since they were last made, and the attention list.
  const rosterReads=render=>{
    if(rowCount!==actors.length)return null;
    const withList=rowsDirty||positionsEpoch!==actorsEpoch(),{player,behind,viewTarget}=viewer();
    const attn=render.rosterReads(rows,rowCount,{player,behind,viewTarget},withList?level.actors:null);
    if(!attn)return null;
    if(withList){rowsDirty=false;positionsEpoch=actorsEpoch();}
    const reads={views:viewsOf(runtime.scriptVm.arena),verify:renderScanMode()==='verify',attn};
    if(plumbing.verify)verifyRoster(reads,withList);
    return reads;
  };
  const meshReads=()=>{
    const render=runtime.scriptVm?.render;
    if(!render||!actors.length)return null;
    if(rosterOn){const reads=rosterReads(render);if(reads)return reads;}
    const arena=runtime.scriptVm.arena;
    if(8*actors.length>pairsCapacity){
      if(pairs)arena.release(pairs,pairsCapacity);
      if(pairsCheck)arena.release(pairsCheck,pairsCapacity);
      pairsCapacity=Math.max(4096,16*actors.length);pairs=arena.alloc(pairsCapacity);pairsCheck=0;pairsVersion=-1;
    }
    let count;
    if(plumbing.pairs&&pairsVersion===actorsVersion&&pairsActors===actorsEpoch()&&pairsReceivers===receiverEpoch()){
      count=pairsCount;
      if(plumbing.verify){
        // (the rewrite goes to a scratch of its own and is compared word by word)
        if(!pairsCheck)pairsCheck=arena.alloc(pairsCapacity);
        const expected=writePairs(arena,pairsCheck);
        if(expected!==count)throw new Error(`ACTOR_PLUMBING=verify: the kept pair table has ${count} pairs, a rewrite ${expected}`);
        for(let k=0;k<2*count;k++)
          if(arena.view.getUint32(pairsCheck+4*k,true)!==arena.view.getUint32(pairs+4*k,true))
            throw new Error(`ACTOR_PLUMBING=verify: the kept pair table differs from a rewrite at word ${k}`);
      }
    }else{count=writePairs(arena,pairs);pairsCount=count;pairsVersion=actorsVersion;pairsActors=actorsEpoch();pairsReceivers=receiverEpoch();}
    const {player,behind,viewTarget}=viewer();
    if(!render.meshReads(pairs,count,{player,behind,viewTarget}))return null;
    return {views:viewsOf(arena),verify:renderScanMode()==='verify'};
  };
  reconcile();await Promise.all(pending.values());refreshSummary();started=true;
  if(!actors.length&&!npcActors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; ')||'No mesh actors resolved');
  // Every binding: the actors', the iterator items' and the weapons', as one array of exact size (the spreads and the flatMap of the
  // item pools each made arrays of their own).
  const all=()=>{
    let count=actors.length;
    for(const pool of itemPools.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)count++;
    for(const pool of itemExtras.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)count++;
    const weaponList=weapons.bindings(),out=new Array(count+weaponList.length);
    let at=0;
    for(let i=0;i<actors.length;i++)out[at++]=actors[i];
    for(const pool of itemPools.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)out[at++]=pool[i].binding;
    for(const pool of itemExtras.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)out[at++]=pool[i].binding;
    for(let i=0;i<weaponList.length;i++)out[at++]=weaponList[i];
    return out;
  };
  // visit(binding, a, b, c, d) for each of them in all()'s order, without the array.
  const forBindings=(visit,a,b,c,d)=>{
    for(let i=0;i<actors.length;i++)visit(actors[i],a,b,c,d);
    for(const pool of itemPools.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)visit(pool[i].binding,a,b,c,d);
    for(const pool of itemExtras.values())for(let i=0;i<pool.length;i++)if(pool[i].binding)visit(pool[i].binding,a,b,c,d);
    const weaponList=weapons.bindings();
    for(let i=0;i<weaponList.length;i++)visit(weaponList[i],a,b,c,d);
  };
  // A plain hidden record ({id, visible: false, childOnly: false}: the only kind a binding the frame does not draw returns) sets the
  // page's binding to a state that depends on nothing but the record: its record state hidden, its root and its batch entries
  // hidden, the main frame's LOD and lighting state back (actor-mesh-draw.mjs apply). A second one finds that state and leaves it,
  // unless a pass drew the binding in between (applyPass shows the root, selects a child frame's LOD state and lighting; a
  // pass is made for a binding only when its last update drew it, in the main frame or in child frames alone: passVisibility,
  // framePass), or a context loss converted it (leaveGpu). `hiddenRun[id]` is 1 from the plain hidden record sent for a binding until
  // a record that is not one, a decision that draws it, or a context loss; compactRecords sends no plain hidden record while it
  // is 1. A decision that hides (the shared NOT_IN_FRAME, or {root: false} of a viewport pass) leaves a hidden binding as it is: the
  // page's applyPass sets the root and the batches hidden and returns before it reads anything else; a weapon's flipSide is the
  // exception and counts as drawing. ACTOR_PLUMBING=no-hidden sends every record; `verify` sends them marked (`quiet`) and the page
  // checks that each one changes nothing (actor-mesh-draw.mjs).
  let hiddenRun=new Uint8Array(1024);
  const setRun=(id,value)=>{
    if(id>=hiddenRun.length){
      if(!value)return;
      const grown=new Uint8Array(2*Math.max(hiddenRun.length,id+1));grown.set(hiddenRun);hiddenRun=grown;
    }
    hiddenRun[id]=value;
  };
  const touchedBy=(binding,decision)=>{if(decision.root||decision.flipSide)setRun(binding.id,0);};
  const passVisibilityOf=(binding,frustum,decisions)=>{const decision=binding.passVisibility(frustum);if(decision){decisions.set(binding.id,decision);touchedBy(binding,decision);}};
  const framePassOf=(binding,frustum,ids,frameIndex,decisions)=>{
    // A weapon is in the frame when its pawn is and had a hand there.
    const inFrame=!ids||(binding.attachedTo?weapons.inFrame(binding,ids,frameIndex):ids.has(binding.id));
    let decision=binding.framePass(frustum,inFrame,frameIndex);
    if(decision&&binding.attachedTo&&weapons.mirrored(binding,frameIndex)){
      if(decision===NOT_IN_FRAME)decision={root:false};
      decision.flipSide=true;
    }
    if(decision){decisions.set(binding.id,decision);touchedBy(binding,decision);}
  };
  // The records of a frame's update are gathered in these arrays (a push-grown array of a few hundred leaves its smaller stores
  // behind, and a filter made a second copy) and copied out once, exactly sized.
  // (a RecordList is written by index and emptied by its count: an array emptied with `length = 0` drops its store, which the next
  // frame's pushes grow again from nothing)
  class RecordList{
    constructor(){this.items=[];this.n=0;}
    push(record){this.items[this.n++]=record;return this.n;}
    get length(){return this.n;}
  }
  const updateRecords=new RecordList(),frameRecords=new RecordList();
  // The main frame's update of the bindings. A binding that is in neither the main frame's Frame->Sprite nor a child frame's returns a
  // plain hidden record (update: `!rootVisible && !childOnly`, or the `view.main` miss), with its state at rest: drawnMain and childOnly
  // false, its LOD record not updated. In a frame whose `main` is a Set (an occlusion result, which makes `cull` and the block's
  // childOnly test unreachable) that holds for every binding that is not in `main` and not in `children`; so one that did the same
  // in the previous such frame (`quietAt`), whose plain hidden record the page already holds (`hiddenRun`: nothing drew it since)
  // and that is not an iterator's moved actor (`spriteAt`: updateSprite writes its snapshot into the actor), finds the same state
  // and returns the same record, which compactRecords would drop: it is not updated (ACTOR_PLUMBING=no-skip updates it).
  // `serial` counts the calls, so a call that is not such a frame (no `main`, or a viewport window's updateFrame) ends every run.
  // `verify` updates them and checks that each returned the plain record with its state at rest.
  let serial=0,quietAt=new Uint32Array(1024),spriteAt=new Uint32Array(1024);
  const growTo=(array,id)=>{if(id<array.length)return array;const grown=new Uint32Array(2*Math.max(array.length,id+1));grown.set(array);return grown;};
  const updateBindings=(view,bindingView,sprites,records)=>{
    const now=++serial,main=view.main instanceof Set?view.main:null,children=view.children instanceof Set?view.children:null;
    const skipping=plumbing.skip&&main!==null&&(children!==null||!view.children);
    if(!skipping&&!main){for(let i=0;i<actors.length;i++)records.push(sprites?updateSprite(sprites,actors[i],bindingView):actors[i].update(bindingView));return;}
    if(sprites)for(const actor of sprites.keys()){const binding=bindings.get(actor);if(binding){spriteAt=growTo(spriteAt,binding.id);spriteAt[binding.id]=now;}}
    let skipped=0;
    for(let i=0;i<actors.length;i++){
      const binding=actors[i],id=binding.id;
      let known=false;
      if(skipping&&id<quietAt.length&&quietAt[id]===now-1&&id<hiddenRun.length&&hiddenRun[id]===1&&spriteAt[id]!==now
        &&!main.has(id)&&(children===null||!children.has(id))){
        if(!plumbing.verify){quietAt[id]=now;skipped++;continue;}
        known=true;
      }
      const record=sprites?updateSprite(sprites,binding,bindingView):binding.update(bindingView);
      records.push(record);
      if(main!==null&&record&&record.visible===false&&record.childOnly===false){
        quietAt=growTo(quietAt,id);quietAt[id]=now;
        if(known){
          const state=binding.lastDraw();
          if(state.main||state.childOnly||Object.keys(record).length!==3)
            throw new Error(`ACTOR_PLUMBING=verify: binding ${id} would be skipped, but its update returned ${JSON.stringify(record)} with ${JSON.stringify(state)}`);
        }
      }else if(known)throw new Error(`ACTOR_PLUMBING=verify: binding ${id} would be skipped, but its update returned ${JSON.stringify(record)}`);
    }
    summary.hiddenSkipped+=skipped;
  };
  const compactRecords=gathered=>{
    const items=gathered.items,total=gathered.n;
    let count=0;
    if(plumbing.hidden){
      for(let i=0;i<total;i++){
        const record=items[i];
        if(!record)continue;
        if(record.visible===false&&record.childOnly===false){
          if(record.id<hiddenRun.length&&hiddenRun[record.id]===1){
            if(plumbing.verify){
              if(Object.keys(record).length!==3)throw new Error(`ACTOR_PLUMBING=verify: the hidden record of binding ${record.id} carries more than id, visible and childOnly`);
              record.quiet=true;count++;summary.hiddenSkipped++;
            }
            else{items[i]=undefined;summary.hiddenSkipped++;}
            continue;
          }
          setRun(record.id,1);
        }else setRun(record.id,0);
        count++;
      }
    }else for(let i=0;i<total;i++)if(items[i])count++;
    const out=new Array(count);
    for(let i=0,k=0;i<total;i++){if(items[i])out[k++]=items[i];items[i]=undefined;}
    gathered.n=0;
    summary.records+=count;
    return out;
  };
  return {actors,npcActors,propActors,summary,kernel,bindings,
    /** One main frame: every binding's frame record in update order, then the
     * mesh lighting frame's coordinates for the GPU passes. `view.lit` marks
     * the main viewport frame, whose drawn actors get one SetupForActor/Light
     * pass each; mirror frames reuse those colours. `view.occlude`, when
     * given, runs the main frame's dynamics after this frame's reads: called
     * with the bindings, the iterator items' bindings and the reads, it
     * returns {main, children}, the binding ids in Frame->Sprite and whether
     * mirror child frames draw (sim-session.mjs). */
    update(view={}){
      const records=updateRecords;records.n=0;
      frameViewer=null;frameViewer=viewer();
      try{
        const reads=meshReads();
        reconcile(reads);
        scope=newScope(view.items??[]);
        if(view.occlude){
          const occluded=view.occlude({bindings:actors,items:itemCandidates(view.items??[]),reads,levelIndex:positionsFor(),itemCandidates});
          view={...view,main:occluded.main,children:occluded.children,cull:!occluded.children,lod:occluded.lod??view.lod,
            lightFrames:occluded.lightFrames??null,lodFrames:occluded.lodFrames??null};
        }
        // The main frame's LOD inputs (Frame->Coords, FX, FovAngle), when the
        // frame has them, and each child frame's own (DrawLodMesh selects in
        // every frame that draws an actor).
        if(lod&&view.lod)view={...view,lodFrame:lodFrame(view.lod,lodSettings),
          lodFrames:view.lodFrames?.map(entry=>({index:entry.index,ids:entry.ids,frame:lodFrame(entry.lod,lodSettings)}))??null};
        // The pawns' lighting makes the weapons' SetupForActor calls in the original's order (actor-weapon-sim.mjs interleave).
        view=weapons.interleave(view);
        // (one view for every binding: the bindings read it and change none of it)
        const bindingView=reads?{...view,reads}:view;
        const sprites=view.proxies?.size?view.proxies:null;
        updateBindings(view,bindingView,sprites,records);
        drawItems(view.items??[],view,records);
        drawExtras(view,records);
        weapons.update(actors,view,records);
      }finally{frameViewer=null;}
      const frame=lighting?.frame;
      const camera=frame?{origin:[...frame.origin],axes:frame.axes.map(axis=>[...axis])}:null;
      // The page's GPU passes run once per main frame (gpu-mesh.mjs run).
      layout?.endFrame();
      return {records:compactRecords(records),camera};
    },
    /** Another root frame's update (a ViewportWindow's DrawWorld, in the HUD
     * paint after the main frame's: docs/script-window-viewport.md "Camera
     * pass"): the bindings in `ids` (its Frame->Sprite, its child frames'
     * included), each updated as the main frame's update does with this
     * frame's inputs in `view` (`main`, `children`, `frustum`, `lod`,
     * `lodFrames`, `lightFrames`, `lightRoot`: this frame's own Coords for
     * the lighting, `pack`). The calls come after the main frame's, as the
     * original's second DrawWorld does: DrawLodMesh selects and calls
     * GetFrame in this frame again, SetupForActor lights with its Coords,
     * and the page applies the records and runs the passes once more
     * (apply). Iterator mesh items keep the main frame's pose. Returns the
     * records and the lighting frame's camera for the page's GPU passes, or
     * null when no binding is updated. */
    updateFrame(view={},ids){
      const records=frameRecords;records.n=0;
      serial+=2;   // (this frame updates bindings the main frame's skip rule assumes at rest)
      frameViewer=null;frameViewer=viewer();
      try{
        if(lod&&view.lod)view={...view,lodFrame:lodFrame(view.lod,lodSettings),
          lodFrames:view.lodFrames?.map(entry=>({index:entry.index,ids:entry.ids,frame:lodFrame(entry.lod,lodSettings)}))??null};
        view=weapons.interleave(view);
        const sprites=view.proxies?.size?view.proxies:null;
        for(const binding of actors)if(ids.has(binding.id))records.push(sprites?updateSprite(sprites,binding,view):binding.update(view));
        // The iterator items the frames draw (shared with the main frame's or this planning's extras),
        // each with its own item (beginFrameItems).
        for(const binding of itemBindings()){
          const item=ids.has(binding.id)?scope?.itemOf.get(binding):null;
          if(item)records.push(withItem(item,()=>binding.update(view),binding));
        }
        // The pawns' third-person weapons of this frame, after their pawns' (DrawActorSprite draws the weapon inside the pawn's draw in
        // every frame, a ViewportWindow's root frame included); the pawns this frame does not draw are left to the pass's decisions.
        weapons.update(actors.filter(binding=>ids.has(binding.id)),view,records,false);
      }finally{frameViewer=null;}
      if(!records.length)return null;
      const root=view.lightRoot??lighting?.frame;
      const camera=root?{origin:[...root.origin],axes:root.axes.map(axis=>[...axis])}:null;
      layout?.endFrame();
      return {records:compactRecords(records),camera};
    },
    /** Whether a weapon binding (attachedTo a pawn) is drawn in the root frame whose Frame->Sprite holds `ids` (a ViewportWindow's): its pawn is
     * in it and had a hand there. */
    weaponInRoot(binding,ids){return Boolean(binding.attachedTo)&&weapons.inFrame(binding,ids,null);},
    /** A mirror child pass's decisions, per binding id (`frustum`: the
     * pass camera's). */
    passVisibility(frustum){
      const decisions=new Map();
      forBindings(passVisibilityOf,frustum,decisions);
      return decisions;
    },
    /** A child frame's pass decisions (OccludeFrame, sim-session.mjs
     * stamps): every posed binding's, drawn when `ids` (its Frame->Sprite)
     * holds it; `frustum` null and `ids` null: the main frame's again. */
    framePasses(frustum,ids,frameIndex){
      const decisions=new Map();
      forBindings(framePassOf,frustum,ids,frameIndex,decisions);
      return decisions;
    },
    /** SetupDynamics' actor candidates for a frame of its own (a
     * ViewportWindow's DrawWorld), read live: the bindings, the iterator
     * items' bindings and the level order (packDynamics' arguments). */
    setupArgs(items=[]){
      // (a viewport window's SetupDynamics: the positions as of the last reconcile, made now for a binding taken since)
      if(rosterOn&&rowCount===actors.length&&(!rowsDirty||positionRows()))rosterUsed=true;
      else{rosterUsed=false;syncLive();}
      return {bindings:actors,items:itemCandidates(items),reads:null,levelIndex:positionsFor(),itemCandidates};
    },
    /** The planning of a root frame other than the main one (a ViewportWindow's, in the HUD paint) starts
     * from `baseItems`, the main frame's root items: its items equal to those share their
     * bindings, and the others take extras (itemCandidates' `frame` argument). */
    beginFrameItems(baseItems){scope=newScope(baseItems??[]);},
    /** Every binding, item bindings included. */
    all,
    /** URender::Exec's MLOD (+40, positive only), MLMODE (+48, non-negative)
     * and MLFIX (+4c, non-negative) for the next frames; validation uses it
     * to reach reduced counts. No console command calls it yet. */
    setLodSettings({shapeLOD,mode,fix}={}){
      lodSettings={...lodSettings,...(shapeLOD>0?{shapeLOD:Math.fround(shapeLOD)}:{}),...(mode>=0?{mode:mode|0}:{}),
        ...(fix>=0?{fix:Math.fround(fix)}:{})};
      return {...lodSettings};
    },
    resetLodSettings(){lodSettings=RENDER_LOD_SETTINGS;},
    /** Validation: the pawns' third-person weapons (actor-weapon-sim.mjs states). */
    weaponStates:colors=>weapons.states(colors),
    /** Validation (scripts/validate-weapon-order.mjs): 'on' starts keeping every SetupForActor call (actor, light sink, frame, result), 'take'
     * returns the calls since and clears them, 'off' returns them and stops. */
    setupLog:mode=>{
      if(!lighting)return null;
      const log=lighting.setupLog;
      if(mode==='on')lighting.setupLog=[];
      else if(mode==='take'&&log)lighting.setupLog=[];
      else if(mode==='off')lighting.setupLog=null;
      return mode==='on'?null:log??null;
    },
    /** Host timing of the weapon layer since the last reset (scripts/weapon-cost.mjs). */
    weaponStats:reset=>weapons.stats(reset),
    /** URender's current LOD settings (the weapon's selection uses them too). */
    lodSettings:()=>lodSettings,
    /** Iterator item bindings in use (validation access). */
    /** Validation: each iterator item binding (a root slot's or an extra) with the item it was last
     * updated with (Location, Rotation, DrawScale, ScaleGlow) and whether the last planning
     * drew it as an extra. */
    itemStates:()=>[...itemPools].flatMap(([actor,pool])=>pool.map(entry=>({entry,actor,extra:false})))
      .concat([...itemExtras].flatMap(([actor,list])=>list.map(entry=>({entry,actor,extra:true}))))
      .filter(({entry})=>entry.binding).map(({entry,actor,extra})=>({id:entry.binding.id,actor:actor.name,extra,item:lastItems.get(entry.binding.id)
        ?{location:[...lastItems.get(entry.binding.id).location],rotation:[...lastItems.get(entry.binding.id).rotation],
          drawScale:lastItems.get(entry.binding.id).drawScale,scaleGlow:lastItems.get(entry.binding.id).scaleGlow}:null,
        inScope:Boolean(scope?.used.has(entry.binding))})),
    /** The extras the last planning of a root frame took (a ViewportWindow's: planViewportPass). */
    itemScopeUsed:()=>scope?.used.size??0,
    itemSlots:()=>[...itemPools].map(([actor,pool])=>({actor:actor.name,ids:pool.map(entry=>entry.binding?.id??null),
      extras:(itemExtras.get(actor)??[]).map(entry=>entry.binding?.id??null)})),
    async ready(){await Promise.all(pending.values());},
    /** A context loss took the GPU mesh path's cache poses (docs/context-loss.md): every binding on that path leaves it.
     * The page applies the records in this order before any later frame's (actor-mesh-draw.mjs leaveGpu). */
    leaveGpu(reason){hiddenRun.fill(0);return all().map(binding=>binding.leaveGpu(reason)).filter(Boolean);},
    dispose(){
      disposed=true;weapons.dispose();for(const binding of all())binding.dispose();itemPools.clear();itemExtras.clear();
      if(rows){rowsArena()?.release(rows,rowsCapacity);rows=0;rowsCapacity=0;rowCount=0;}
    },
  };
}
