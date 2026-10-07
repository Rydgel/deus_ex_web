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
import {createLodMeshFrameCache,getLodMeshFrame,planLodMeshFrame,materializeLodMeshFrame} from '../runtime/lodmesh-frame.mjs';
import {loadLodMeshKernel} from '../runtime/lodmesh-wasm.mjs';
import {actorsEpoch} from '../runtime/base-epoch.mjs';
import {RENDER_MESH,RENDER_SHIFT,renderScanMode} from '../runtime/script-vm-render.mjs';
import {handleOf,identityOfHandle} from '../runtime/script-object-handles.mjs';
import {fieldAccessor,fieldAccessors} from './actor-fields.mjs';
import {keyframeBoxes,advanceChannelBox,viewBox,certifyFrustum} from './gpu-mesh-bounds.mjs';
import {meshFaceGroups,resolveMeshSkin} from './actor-mesh-skins.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';
import {SETUP,setupSequence} from '../runtime/bsp-occlusion.mjs';
import {createMeshLod,lodFrame} from './actor-mesh-lod.mjs';
import {lodMorphScalars,RENDER_LOD_SETTINGS} from '../runtime/lodmesh-lod.mjs';

// A binding's block of render.rs mesh_reads words (u32 indices).
const MB={STATUS:0,MESH:1,STYLE:2,SCALEGLOW:3,LOCATION:4,PREPIVOT:7,DRAWSCALE:10,ANIMACTOR:11,POSE:12,LAST:29,LAST_VALID:46,
  ZONE:47,ILEAF:48,ZONENUMBER:49,AMBIENTGLOW:50,SETUP_FLAGS:51,DRAWTYPE:52,OWN_PARTICLES:53,OWN_ANIMFRAME:54};
const MB_WORDS=55,MS_OK=1,MS_DRAWN=2,MS_DRAWN_CHILD=4,MS_CHANGED=8,MS_SETUP=16;

/** A plain texture reference for the page's asset store. */
const plainRef=reference=>({key:reference.key,package:reference.asset?.name,index:reference.index});

/** BufferGeometry.computeBoundingBox + computeBoundingSphere (three.js
 * r186) for a plain position array without morph targets, in one pass: the
 * same Math.min/max expansion, empty-box centre, (min + max) * 0.5 centre and
 * largest dx*dx + dy*dy + dz*dz, so frustum culling sees identical bounds.
 * `target` holds boundingBox and boundingSphere, as a geometry does. */
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
/** SetupForActor's result as gpu-mesh.mjs setLighting reads it. */
const plainLighting=prepared=>({flags:prepared.flags,ambient:[...prepared.setup.ambient],scaleGlow:prepared.setup.scaleGlow,
  unlit:[...prepared.unlit],lights:prepared.setup.lights.map(light=>({location:[...light.location],rradius:light.rradius,
    color:[...light.color]}))});

/** One actor's mesh binding on the simulation side. `layout` is this side's
 * GPU mesh layout (null: the CPU path); `onRecord` is not used here, the
 * caller collects update()'s records. */
export async function createMeshBinding(runtime,actor,{id,originalObjectIndex,kernel=null,drawActor=false,visible=null,
  childVisible=null,lighting=null,layout=null,reads=false,textures,meshKey=null,lod=true}) {
  const own=fieldAccessors(runtime,actor,['bHidden','bDeleteMe','Location','PrePivot','DrawScale','Mesh','Style',
    'ScaleGlow','bAnimByOwner','Owner','bParticles','Rotation','AnimSequence','AnimFrame','BlendAnimSequence',
    'BlendAnimFrame','Name','bOnlyOwnerSee','bOwnerNoSee','DrawType','LODBias']);
  const read=(object,name)=>object===actor&&Object.hasOwn(own,name)?own[name]():runtime.readNamed(object,name);
  const actorName=read(actor,'Name');
  const meshReference=read(actor,'Mesh');
  const payload=await runtime.prepareMesh(actor);
  // GetFrame's tween cache must survive draw submissions; it owns only this
  // binding's identity (docs/npc-mesh-preview.md).
  const cache=createLodMeshFrameCache(),coords=[0,0,0,1,0,0,0,1,0,0,0,1];
  const services={cache,kernel,read,objectIndex:object=>{
    if(object!==actor)throw new Error('Owner-driven mesh inspection requires a captured owner identity');
    return originalObjectIndex;
  }};
  const faces=runtime.getActorMeshSurfaces(actor);
  const faceWords=new Uint32Array(faces.length*4);
  faces.forEach((face,i)=>faceWords.set([...face.vertices,face.flags>>>0],i*4));
  const hasEnvironment=faces.some(face=>face.flags&POLY.Environment);
  // DrawLodMesh's distance LOD (actor-mesh-lod.mjs); null without it.
  const meshLod=lod?createMeshLod(payload,faces,faceWords,{kernel}):null;
  const fullCount=payload.frameVertexCount-(payload.scalarBits.get(0x184)|0);
  // The last LOD inputs and results: the requested and returned counts, the
  // detail bits, and the drawn state (drawn positions, resolved corners).
  let lastRequested=fullCount,lastReturned=fullCount,lastDetail='off',lodDrawn=null,lastLod=null;
  // The GPU path's last LOD state: the selection, its post-frame scalars
  // while the LOD flag holds, and the parameters the page last received.
  let lastSelection=null,gpuLodScalars=null,lastLodKey='full';
  /** The LOD's post-frame state for GetFrame's last output (null: full
   * resolution and unmorphed). */
  function lodAfter(selection){
    lodDrawn=selection?meshLod.after(selection,lastReturned,frame.output):null;
    if(lodDrawn&&!lodDrawn.state.active&&!lodDrawn.state.morph)lodDrawn=null;
  }
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
  const frame=layout?planFirst():getLodMeshFrame(payload,actor,coords,services);
  function planFirst(){
    lastPlan=planLodMeshFrame(payload,actor,coords,services);
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
    for(let i=0;i<payload.objectReferences.length;i++)fallback=runtime.getActorMeshTexture(actor,i)??fallback;
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
  function relight(prepared){
    const points=drawnPoints(),topology=lodDrawn?.lighting??{faces,faceWords};
    const result=lighting.lightMesh(actor,points,topology.faces,topology.faceWords,prepared);
    if(!result)return null;
    return {colors:result.colors.slice(),summary:{lights:result.setup.lights.length,flags:result.flags}};
  }
  try {
    const partition=meshFaceGroups(faces,face=>face.flags&POLY.Environment?environmentTexture():runtime.getActorMeshTexture(actor,face.texture));
    if(partition.error)throw new Error(`${actorName} ${partition.error}`);
    for(const [groupKey,group] of partition.groups) {
      try {
        // The page decodes the same skin; a group whose skin it cannot draw
        // is dropped on both sides.
        const {flags}=await resolveMeshSkin(textures,group.reference.asset,group.reference.index,group.flags);
        const indices=[];
        for(const faceIndex of group.faces){const face=faces[faceIndex];for(const corner of [0,2,1])indices.push(face.vertices[corner]);}
        const entry={key:groupKey,reference:group.reference,flags:group.flags,drawFlags:flags,faces:group.faces,indices,
          environment:Boolean(group.flags&POLY.Environment),sphere:new THREE.Sphere(),positions:null,bounds:{}};
        groups.set(groupKey,entry);
      } catch(error) {
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
      entry.vertices=meshLod?meshLod.closure(entry.faces):[...new Set(entry.indices)].sort((a,b)=>a-b);
      entry.boxes=keyframeBoxes(payload,entry.vertices);
      entry.channelBoxes=Array.from({length:5},()=>new Float64Array(6).fill(NaN));
      entry.viewBox=new Float64Array(6).fill(NaN);
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
    function exactSpheres(){
      if(exactValid)return;
      if(materializedPlan!==lastPlan){materializeLodMeshFrame(lastPlan);materializedPlan=lastPlan;}
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
    function decideGroups(frustum,assign){
      const whole=certifyFrustum(frustum,unionBox);
      // A group the LOD empties draws nothing.
      for(const group of groups.values())assign(group,!group.lodEmpty&&(whole>=0?whole===1:groupVisible(group,frustum)));
    }
    function groupVisible(group,frustum){
      const certain=certifyFrustum(frustum,group.viewBox);
      if(certain>=0)return certain===1;
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
      lastPlan=null;
      if(meshLod)lodAfter(gpuLodScalars?lastSelection:null);
      cpuBounds();
      layout.release(gpuHandle);gpuHandle=null;
    }
    function planGpu(vertexCount=fullCount){
      // A slot's plans take effect when its GPU pass runs. Until the first
      // one has run, the actor has not been drawn and the GPU holds none of
      // its cache poses; a new plan would overwrite that first one, and a
      // tween in it would start from an empty state. The original's first
      // GetFrame happens when the actor is first drawn, so the cache
      // restarts: this plan is the first.
      if(layout.frame<firstPassFrame)for(const key of [...cache.entries.keys()])cache.flush(key);
      lastPlan=planLodMeshFrame(payload,actor,coords,services,{output:frame.output,vertexCount});
      lastReturned=lastPlan.vertexCount;
      exactValid=false;plannedFrame=layout.frame+1;
      try{layout.checkPose(gpuHandle,lastPlan);}
      catch(error){toCpu(error.message);return false;}
      for(const group of groups.values()){
        for(const op of lastPlan.channels)advanceChannelBox(group.channelBoxes[op.channel+1],op,group.boxes);
        viewBox(lastPlan,group.channelBoxes,group.viewBox);
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
          for(const op of lastPlan.channels)advanceChannelBox(group.channelBoxes[op.channel+1],op,group.boxes);
          viewBox(lastPlan,group.channelBoxes,group.viewBox);boxSphere(group);
        }
        updateUnion();
      }catch(error){toCpu(error.message);}
    }
    lastPose=pose();
    const sphereWords=()=>Float64Array.from([...groups.values()].flatMap(group=>[...group.sphere.center.toArray(),group.sphere.radius]));
    /** What the page needs to build this binding: the mesh to decode, its
     * face groups with their skins, the path and the first pose. */
    const creation={id,handle:handleOf(actor),actorName,mesh:{...plainRef(meshReference),key},
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
    }
    const groupBits=()=>[...groups.values()].map(group=>group.mainVisible?1:0);
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
    // GetAnimSeq's last answer (setupSequence) for Setup's candidate.
    let setupName,setupHit=null;
    /** FDynamicSprite::Setup's candidate words (bsp-occlusion.mjs SETUP) at
     * `at`: the actor's own fields from this frame's block, or read; for a
     * render-iterator item (`item`) its snapshot's Location, Rotation and
     * DrawScale, which DrawActorSprite would write into the actor. */
    function packSetup({u32,f32,i32},at,key,record,reads,item=null){
      u32[at+SETUP.KEY]=key>>>0;u32[at+SETUP.MESH]=record>>>0;u32[at+SETUP.TEXTURE]=0;u32[at+SETUP.USIZE]=0;u32[at+SETUP.VSIZE]=0;
      const b=item?-1:blockAt(reads);
      if(b>=0){
        const w=reads.views().u32;
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
      const name=own.AnimSequence();
      if(name!==setupName){setupName=name;setupHit=setupSequence(payload.sequences,name);}
      u32[at+SETUP.SEQ]=setupHit?1:0;i32[at+SETUP.SEQ_START]=setupHit?.startFrame??0;i32[at+SETUP.SEQ_FRAMES]=setupHit?.numFrames??0;
    }
    return {id,actor,creation,dispose,mesh:meshReference,payload,packSetup,admitted,get block(){return block;},
      get viewDependent(){return hasEnvironment&&mode==='cpu';},
      get path(){return mode;},
      readMesh(){try{return own.Mesh();}catch{return undefined;}},
      /** Whether Mesh is no longer this binding's: from this frame's block
       * when it holds the reads (compared with readMesh under
       * RENDER_SCAN=verify), else readMesh. */
      meshChanged(reads){
        const u32=reads&&block?reads.views().u32:null,at=u32&&u32[block>>2]&MS_OK?block>>2:-1;
        const readChanged=()=>{try{return own.Mesh()!==meshReference;}catch{return true;}};
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
        if(childOnly){if(frustum===null)return {root:false};}
        else if(!drawnMain)return null;
        if(mode!=='gpu')return childOnly?{root:true}:null;
        if(frustum===null)return {root:true,groups:groupBits()};
        const bits=[];decideGroups(frustum,(group,visible)=>bits.push(visible?1:0));
        const spheres=spheresChanged?sphereWords():null;spheresChanged=false;
        return {root:true,groups:bits,spheres};
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
        if(disposed)return false;
        const root=decision?decision.root:drawnMain;
        if(!root)return false;
        if(mode==='gpu'){
          const bits=decision?.groups??groupBits();
          return bits.some(Boolean);
        }
        for(const group of groups.values())if(!group.lodEmpty&&frustum.intersectsSphere(group.bounds.boundingSphere))return true;
        return false;
      },
      /** Validation access (scripts/validate-gpu-mesh.mjs): this frame's
       * plan, lighting setup and GPU slot; `exactOutput()` replays the CPU
       * shadow to the exact CPU pose. Never used by Play. */
      gpuState:()=>({handle:gpuHandle,plan:lastPlan,plannedFrame,updated:mainCamera!==null,setup:lastSetup,litFrame:lastLitFrame,faces,faceWords,groups,hasEnvironment,
        exactOutput:()=>{exactSpheres();return frame.output;},get exactValid(){return exactValid;},
        // The CPU LOD of the exact output (call exactOutput first): drawn
        // positions, resolved corners, wedge dwords and lighting faces, or
        // null at full detail; `wedges` the mesh's Wedges dwords.
        lodDrawn:()=>gpuLodScalars?meshLod.after(lastSelection,lastReturned,frame.output):null,
        lodParams:gpuLodScalars?{...gpuLodScalars}:null,wedges:meshLod?.topology.wedges??null}),
      get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
      /** Validation access (lod-probe.mjs): the last update's LOD inputs,
       * selection, returned count, final state and drawn faces. */
      lodState:()=>lastLod?{...lastLod,mesh:meshReference.key,meshPackage:meshReference.asset?.name??null,meshIndex:meshReference.index??null,
        actor:actorName,path:mode,drawn:drawnMain}:null,
      /** One main-frame update: the frame record for the page, or null when
       * the binding is disposed. With `view.pack` (mesh-frame-pack.mjs) the
       * record's plan and lighting are offsets into the frame's words. */
      update(view={}){
        if(disposed)return null;
        const record={id,visible:false,childOnly:false};drawnMain=false;
        if(lastLod)lastLod.updated=false;
        // This frame's mesh_reads words (MB), or -1.
        const {u32,f32}=view.reads&&block?view.reads.views():{},at=u32&&u32[block>>2]&MS_OK?block>>2:-1;
        const verify=at>=0&&view.reads.verify;
        let rootVisible=admitted(view.reads,at);
        if(verify)verifyReads(u32,f32,at);
        // `view.children`: mirror child frames will draw this frame.
        childOnly=!rootVisible&&Boolean(view.children&&(at>=0?childVisible&&u32[at+MB.STATUS]&MS_DRAWN_CHILD:childVisible?.(actor,own)));
        mainCamera=view.camera??null;
        // `view.main`: the ids in the main frame's Frame->Sprite (OccludeBsp,
        // docs/bsp-occlusion.md "Play"). An admitted actor outside it is not
        // drawn by the main frame; mirror child frames may still draw it.
        if(view.main&&rootVisible&&!childOnly&&!view.main.has(id)){if(!view.children)return record;childOnly=true;}
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
        record.visible=true;record.childOnly=childOnly;drawnMain=!childOnly;
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
        // DrawLodMesh's selection for the main frame (actor-mesh-lod.mjs):
        // its count joins the pose in deciding a new GetFrame, its detail
        // the morph (the CPU path runs it here, the GPU path in its passes).
        let selection=null,lodInputs=null;
        if(meshLod&&view.lodFrame){
          const location=at>=0?[f32[at+MB.LOCATION],f32[at+MB.LOCATION+1],f32[at+MB.LOCATION+2]]:own.Location();
          lodInputs={location,drawScale:at>=0?f32[at+MB.DRAWSCALE]:own.DrawScale(),lodBias:own.LODBias()};
          selection=meshLod.select(view.lodFrame,lodInputs.location,lodInputs.drawScale,lodInputs.lodBias);
          lastLod={frame:view.lodFrame,inputs:lodInputs,selection};
          if(!selection.active)selection=null;
        }
        const requested=selection?.requested??fullCount;
        // The detail matters only to a morph; the flags and the count to all.
        const detailKey=selection?`${selection.morph?bitsOf(selection.detail):0}`:'off';
        const lodChanged=requested!==lastRequested||detailKey!==lastDetail;
        lastDetail=detailKey;
        let posed=false;
        if((poseChanged||requested!==lastRequested)&&mode==='gpu'){
          if(planGpu(requested))record.plan=view.pack?view.pack.plan(lastPlan):plainPlan(lastPlan);posed=true;
        }
        // The GPU path's LOD parameters after GetFrame (the morph and corner
        // passes run them); the groups the reduced faces empty.
        if(mode==='gpu'&&meshLod&&(posed||lodChanged)){
          lastSelection=selection;
          const scalars=selection?lodMorphScalars(meshLod.topology,selection,lastReturned):null;
          gpuLodScalars=scalars?.active?scalars:null;
          const params=gpuLodScalars?{count:scalars.count,start:scalars.start,active:true,morph:scalars.morph,inverse:Math.fround(scalars.inverse)}
            :{count:meshLod.topology.modelVerts,start:0,active:false,morph:false,inverse:0};
          const key=`${params.count}:${params.start}:${params.morph}:${params.active}:${bitsOf(params.inverse)}`;
          if(key!==lastLodKey){
            record.lodParams=params;lastLodKey=key;exactValid=false;
            const level=meshLod.topology.faceLevel;
            for(const group of groups.values())group.lodEmpty=params.active&&group.faces.every(face=>level[face]>params.count);
          }
        }
        if((poseChanged||lodChanged)&&mode==='cpu'){
          // A plan evaluated for this frame before a fallback already posed it.
          if(!posed&&(poseChanged||requested!==lastRequested))
            lastReturned=getLodMeshFrame(payload,actor,coords,services,{output:frame.output,vertexCount:requested}).vertexCount;
          lodAfter(selection);
          cpuBounds();record.posed=posedCopy();
          if(meshLod)record.lod=lodRecord();
        }
        if(lastLod&&mode==='cpu')Object.assign(lastLod,{returned:lastReturned,state:lodDrawn?{...lodDrawn.state}:null,
          admitted:lodDrawn?.resolved?countAdmitted(lodDrawn.resolved):faces.length,
          vertices:lodDrawn?.resolved?countVertices(lodDrawn.resolved):null,updated:true});
        else if(lastLod)Object.assign(lastLod,{returned:lastReturned,
          state:gpuLodScalars?{active:true,morph:gpuLodScalars.morph,start:gpuLodScalars.start,count:gpuLodScalars.count}:null,
          admitted:gpuLodScalars?countLevel(meshLod.topology.faceLevel,gpuLodScalars.count):faces.length,vertices:null,updated:true});
        lastRequested=requested;
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
        // Mirror frames reuse the main frame's lighting; a child-only actor
        // is lit the same way.
        if(lighting&&view.lit&&lighting.frame&&(childOnly||!view.frustum||(mode==='gpu'?mainVisible:[...groups.values()].some(group=>
          !group.lodEmpty&&view.frustum.intersectsSphere(group.bounds.boundingSphere))))){
          if(mode==='gpu'){
            const prepared=lighting.setupMesh(actor,at>=0?setupFields(view.reads.views()):null);
            if(prepared){
              lastSetup=prepared;lastLitFrame=layout.frame+1;
              summary.lighting={lights:prepared.setup.lights.length,flags:prepared.flags};
              if(layout.reserveLights(prepared.setup.lights.length))
                record.lighting=view.pack?view.pack.lighting(prepared):plainLighting(prepared);
              else {
                toCpu(`more than ${prepared.setup.lights.length-1} selected lights`);
                record.posed=posedCopy();
                const lit=relight(prepared);
                if(lit){record.colors=lit.colors;summary.lighting=lit.summary;}
              }
            }
          } else {
            const lit=relight();
            if(lit){record.colors=lit.colors;summary.lighting=lit.summary;}
          }
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
      },summary};
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
  childFrames=false,lod=true,onCreate=()=>{},onRelease=()=>{}}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource??null;
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
  const bind=async(actor,options)=>{
    const binding=await createMeshBinding(runtime,actor,{id:nextId++,kernel,lighting,layout,textures,lod,...options});
    return binding;
  };
  const npcActors=[],propActors=[],errors=[];
  const actors=[],bindings=new Map();
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
        npcActors.push(binding);actors.push(binding);bindings.set(actor,binding);onCreate(binding.creation);
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
  let synthetic=0x40000000,disposed=false;
  const pending=new Map(),failed=new WeakMap();
  const summary={actors:[],errors,poseBackend:kernel?.name??'javascript',kernelError,gpu:Boolean(layout),
    npcs:npcActors.length,props:0,skipped:[],triangles:0,
    shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original'};
  const refreshSummary=()=>{
    summary.actors=actors.map(actor=>actor.summary);summary.props=propActors.length;summary.npcs=npcActors.length;
    summary.skipped=actors.flatMap(actor=>actor.summary.skipped.map(s=>({actor:actor.summary.actor,...s})));
    summary.triangles=actors.reduce((total,actor)=>total+actor.summary.triangles,0);
  };
  const retired=new WeakMap();
  const admit=(actor,readMesh=null)=>{
    if(disposed||!actor||bindings.has(actor)||pending.has(actor))return;
    let mesh;
    if(readMesh){try{mesh=readMesh();}catch{mesh=undefined;}}else mesh=read(actor,'Mesh');
    if(failed.get(actor)===mesh)return;
    if(!mesh||(mesh.kind!=='LodMesh'&&mesh.kind!=='Mesh')||!read(actor,'Location'))return;
    // A map with mirrors also admits actors only its child frames draw.
    if(!drawnInWorld(actor)&&!(childFrames&&drawnInWorld(actor,null,true)))return;
    const npc=retired.get(actor)??false;retired.delete(actor);
    const task=bind(actor,{originalObjectIndex:synthetic++,visible:drawnInWorld,
      childVisible:childFrames?(actor,own)=>drawnInWorld(actor,own,true):null,reads:true})
      .then(binding=>{
        if(disposed||!level.actors.includes(actor)||read(actor,'bDeleteMe')||read(actor,'Mesh')!==mesh){binding.dispose();return;}
        bindings.set(actor,binding);actors.push(binding);(npc?npcActors:propActors).push(binding);refreshSummary();
        // Shown from admission, before its first update (as the layer did).
        binding.creation.visible=drawnInWorld(actor);
        onCreate(binding.creation);
      }).catch(error=>{failed.set(actor,mesh);errors.push({actor:actor.name??'?',message:error.message});})
      .finally(()=>pending.delete(actor));
    pending.set(actor,task);
  };
  const retire=(actor,binding)=>{
    binding.dispose();bindings.delete(actor);onRelease(binding.id);
    for(const list of [actors,propActors,npcActors]){const at=list.indexOf(binding);if(at>=0)list.splice(at,1);}
    refreshSummary();
  };
  // Level.Actors membership only changes with actorsEpoch (base-epoch.mjs),
  // so the membership set is rebuilt only then. Every actor's Mesh is read
  // every update through an accessor (actor-fields.mjs) kept in Level.Actors
  // order.
  let live=null,liveEpoch=-1,liveList=[],meshReaders=[],levelIndex=new Map();
  const meshAccessors=new Map();
  const reconcile=(reads=null)=>{
    if(disposed||!level)return;
    const epoch=actorsEpoch();
    if(epoch!==liveEpoch||!live){
      live=new Set(level.actors);liveEpoch=epoch;liveList=[...live];
      levelIndex=new Map();level.actors.forEach((actor,i)=>{if(actor&&!levelIndex.has(actor))levelIndex.set(actor,i);});
      const next=new Map();
      meshReaders=liveList.map(actor=>{
        if(!actor)return null;
        const reader=meshAccessors.get(actor)??fieldAccessor(runtime,actor,'Mesh');
        next.set(actor,reader);return reader;
      });
      meshAccessors.clear();for(const [actor,reader] of next)meshAccessors.set(actor,reader);
    }
    for(const [actor,binding] of bindings){
      if(!live.has(actor))retire(actor,binding);
      // A script can change Mesh (Inventory.BecomeItem/BecomePickup). The new
      // mesh is admitted like a newly visible actor; its resources decode
      // asynchronously, so it appears once they are ready.
      else if(binding.meshChanged(reads)){retired.set(actor,npcActors.includes(binding));retire(actor,binding);}
    }
    // The render scan (script-vm-render.mjs) leaves the actors with a live
    // Mesh, and those it hands back; admit returns at once for the others.
    const entries=runtime.scriptVm?.render?.scan(level.actors,{kinds:RENDER_MESH})??null;
    if(entries)for(const entry of entries){const actor=level.actors[entry>>>RENDER_SHIFT];admit(actor,meshAccessors.get(actor));}
    else for(let i=0;i<liveList.length;i++)admit(liveList[i],meshReaders[i]);
  };
  // Render-iterator mesh items (docs/lasers.md): each FDynamicSprite of a
  // DT_Mesh item draws through DrawActorSprite (0x10b2556a-0x10b25655), which
  // writes the snapshot's ScaleGlow, DrawScale, Location and Rotation into
  // the actor, calls DrawMesh and restores them. One binding per item slot
  // of the actor, updated the same way; items draw whatever the actor's
  // bHidden (SetupDynamics admits the iterating actor, not its items).
  const itemPools=new Map(),SNAPSHOT=[['ScaleGlow','scaleGlow'],['DrawScale','drawScale'],['Location','location'],['Rotation','rotation']];
  const drawItems=(items,view,records)=>{
    const counts=new Map();
    for(const item of items){
      const slot=counts.get(item.actor)??0;counts.set(item.actor,slot+1);
      let pool=itemPools.get(item.actor);
      if(!pool)itemPools.set(item.actor,pool=[]);
      if(!pool[slot]){
        const entry=pool[slot]={binding:null};
        bind(item.actor,{originalObjectIndex:synthetic++,visible:()=>true})
          .then(binding=>{if(disposed||itemPools.get(item.actor)!==pool){binding.dispose();return;}
            entry.binding=binding;onCreate(binding.creation);})
          .catch(error=>{entry.failed=error.message;errors.push({actor:`${item.actor.name??'?'} item`,message:error.message});});
        continue;
      }
      const binding=pool[slot].binding;
      if(!binding)continue;
      const saved=SNAPSHOT.map(([name])=>runtime.readNamed(item.actor,name));
      try{
        for(const [name,key] of SNAPSHOT)runtime.writeNamed(item.actor,name,item[key]);
        records.push(binding.update(view));
      }finally{SNAPSHOT.forEach(([name],i)=>runtime.writeNamed(item.actor,name,saved[i]));}
    }
    for(const [actor,pool] of itemPools){
      const used=counts.get(actor)??0;
      if(!used&&(!live?.has(actor)||read(actor,'bDeleteMe'))){
        for(const entry of pool)if(entry.binding){entry.binding.dispose();onRelease(entry.binding.id);}
        itemPools.delete(actor);continue;
      }
      for(let i=used;i<pool.length;i++)if(pool[i].binding)records.push(pool[i].binding.hide());
    }
  };
  const itemBindings=()=>[...itemPools.values()].flatMap(pool=>pool.map(entry=>entry.binding).filter(Boolean));
  /** This frame's iterator items with the binding drawItems will update for
   * each (the same slots), where one exists. */
  const itemCandidates=items=>{
    const counts=new Map(),out=[];
    for(const item of items){
      const slot=counts.get(item.actor)??0;counts.set(item.actor,slot+1);
      const binding=itemPools.get(item.actor)?.[slot]?.binding;
      if(binding)out.push({item,binding});
    }
    return out;
  };
  // The bindings' per-frame reads in one Rust pass (render.rs mesh_reads)
  // before their updates, which write none of the fields it reads: each
  // binding's block, or null when the pass cannot run (the script VM has no
  // render host, ?renderScan=js). Item bindings read the snapshot their item
  // writes, so they keep their own reads.
  let pairs=0,pairsCapacity=0;
  const meshReads=()=>{
    const render=runtime.scriptVm?.render;
    if(!render||!actors.length)return null;
    const arena=runtime.scriptVm.arena;
    if(8*actors.length>pairsCapacity){
      if(pairs)arena.release(pairs,pairsCapacity);
      pairsCapacity=Math.max(4096,16*actors.length);pairs=arena.alloc(pairsCapacity);
    }
    let count=0;
    for(const binding of actors){
      if(!binding.block)continue;
      arena.view.setUint32(pairs+8*count,handleOf(binding.actor),true);
      arena.view.setUint32(pairs+8*count+4,binding.block,true);count++;
    }
    const {player,behind,viewTarget}=viewer();
    if(!render.meshReads(pairs,count,{player,behind,viewTarget}))return null;
    // Typed views of the arena's current buffer: a memory growth during an
    // update (the GPU plan, the light selection) replaces it.
    let buffer=null,u32=null,f32=null;
    const views=()=>{
      if(arena.memory.buffer!==buffer){buffer=arena.memory.buffer;u32=new Uint32Array(buffer);f32=new Float32Array(buffer);}
      return {u32,f32};
    };
    return {views,verify:renderScanMode()==='verify'};
  };
  reconcile();await Promise.all(pending.values());refreshSummary();
  if(!actors.length&&!npcActors.length)throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; ')||'No mesh actors resolved');
  const all=()=>[...actors,...itemBindings()];
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
      const records=[];
      frameViewer=null;frameViewer=viewer();
      try{
        const reads=meshReads();
        reconcile(reads);
        if(view.occlude){
          const occluded=view.occlude({bindings:actors,items:itemCandidates(view.items??[]),reads,levelIndex});
          view={...view,main:occluded.main,children:occluded.children,cull:!occluded.children,lod:occluded.lod??view.lod};
        }
        // The main frame's LOD inputs (Frame->Coords, FX, FovAngle), when the
        // frame has them; mirror frames reuse the main frame's selection.
        if(lod&&view.lod)view={...view,lodFrame:lodFrame(view.lod,lodSettings)};
        for(const binding of actors)records.push(binding.update(reads?{...view,reads}:view));
        drawItems(view.items??[],view,records);
      }finally{frameViewer=null;}
      const frame=lighting?.frame;
      const camera=frame?{origin:[...frame.origin],axes:frame.axes.map(axis=>[...axis])}:null;
      // The page's GPU passes run once per main frame (gpu-mesh.mjs run).
      layout?.endFrame();
      return {records:records.filter(Boolean),camera};
    },
    /** A mirror child pass's decisions, per binding id (`frustum`: the
     * pass camera's). */
    passVisibility(frustum){
      const decisions=new Map();
      for(const binding of all()){const decision=binding.passVisibility(frustum);if(decision)decisions.set(binding.id,decision);}
      return decisions;
    },
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
    /** Iterator item bindings in use (validation access). */
    itemSlots:()=>[...itemPools].map(([actor,pool])=>({actor:actor.name,ids:pool.map(entry=>entry.binding?.id??null)})),
    async ready(){await Promise.all(pending.values());},
    dispose(){disposed=true;for(const binding of all())binding.dispose();itemPools.clear();},
  };
}
