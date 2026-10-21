/** The simulation side of the actor mesh layer for a classic UMesh (docs/umesh.md): the
 * binding actor-mesh-sim.mjs makes when an actor's Mesh is one of the game's five classic
 * meshes (the boot logos and the Fly), in place of the LodMesh binding.
 *
 * It is the CPU path of the LodMesh one: UMesh::GetFrame's pose (umesh-frame.mjs) in world space
 * for the page's geometry and, through the lighting frame's Coords, in camera space for what
 * DrawMesh lights and projects; Render.dll's DrawMesh (umesh-draw.mjs) gives the corners'
 * Light and, for PF_Environment faces, their U and V. The records are the CPU path's
 * (`posed`, `colors`, `cameraPoints`) plus `envUv`, which the page applies in place of its own
 * camera-relative environment mapping. Not translated (stay as the LodMesh binding's CPU path
 * has them, or are unsupported): a pawn's weapon (no classic mesh is one), mirror child
 * frames' own lighting (a child frame draws with the main frame's), Fog, the Player's
 * viewport-actor override of the textures when its Sprite is set. */
import * as THREE from 'three';
import {POLY} from '../unreal/geometry.mjs';
import {handleOf} from '../runtime/script-object-handles.mjs';
import {createUMeshFrameCache,getUMeshFrame,publishUMeshOps,umeshCameraMatrix} from '../runtime/umesh-frame.mjs';
import {drawUMesh} from '../runtime/umesh-draw.mjs';
import {readUMeshSurfaces} from '../runtime/umesh-surfaces.mjs';
import {lightVertex,d3dDiffuse,PF} from '../runtime/mesh-lighting.mjs';
import {fieldAccessors} from './actor-fields.mjs';
import {meshFaceGroups} from './actor-mesh-skins.mjs';
import {setupSequence} from '../runtime/bsp-occlusion.mjs';

const IDENTITY=[0,0,0,1,0,0,0,1,0,0,0,1];
const plainRef=reference=>({key:reference.key,package:reference.asset?.name,index:reference.index});

/** The binding steps (see actor-mesh-sim.mjs meshBindingSteps): yields {skin: group} for each face
 * group's skin and returns the binding. `ctx` carries what the LodMesh steps had computed by then. */
export function* classicMeshBindingSteps(runtime,actor,payload,ctx) {
  const {id,visible,childVisible,drawActor,lighting,meshKey,own,read,meshReference,meshTexture,actorName,helpers,notResident}=ctx;
  const {copyPositions,setMeshBounds}=helpers;
  const key=meshKey??meshReference.key;
  const faces=readUMeshSurfaces(payload);
  const cache=createUMeshFrameCache(),services={cache,read,objectIndex:object=>{
    if(object!==actor)throw new Error('Owner-driven mesh inspection requires a captured owner identity');
    return ctx.originalObjectIndex;
  }};
  const hasEnvironment=faces.some(face=>face.flags&POLY.Environment);
  const environmentTexture=()=>{
    const direct=read(actor,'Texture');if(direct)return direct;
    const region=read(actor,'Region'),zone=region['engine.actor.pointregion.zone'];
    const fromZone=zone&&read(zone,'EnvironmentMap');if(fromZone)return fromZone;
    const fromLevel=read(read(actor,'Level'),'EnvironmentMap');if(fromLevel)return fromLevel;
    let fallback=null;
    for(let i=0;i<payload.objectReferences.length;i++)fallback=meshTexture(i)??fallback;
    return fallback;
  };
  const groups=new Map(),skipped=[],infos=new Map();
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;cache.entries.clear();};
  // The mesh's culling radius (host bound only): the farthest vertex of every frame, in mesh units, scaled.
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
  const partition=meshFaceGroups(faces,face=>face.flags&POLY.Environment?environmentTexture():meshTexture(face.texture));
  if(partition.error)throw new Error(`${actorName} ${partition.error}`);
  for(const [groupKey,group] of partition.groups) {
    try {
      const {data,flags}=yield {skin:group};
      const first=data.mips[0],scale=data.values.Scale??1;
      // FTextureInfo (UTexture::Lock): the base size, UScale/VScale, and the texture's PolyFlags whose Masked bit DrawMesh adds.
      infos.set(group.reference.key,{uSize:first.width,vSize:first.height,uScale:scale,vScale:scale,flags:flags&POLY.Masked});
      const indices=[];
      for(const faceIndex of group.faces){const face=faces[faceIndex];for(const corner of [0,2,1])indices.push(face.vertices[corner]);}
      groups.set(groupKey,{key:groupKey,reference:group.reference,flags:group.flags,drawFlags:flags,faces:group.faces,indices,
        environment:Boolean(group.flags&POLY.Environment),sphere:new THREE.Sphere(),positions:null,bounds:{}});
    } catch(error) {
      if(error===notResident)throw error;
      skipped.push({texture:group.reference.key,message:error.message});
    }
  }
  if(!groups.size)throw new Error(skipped.map(s=>`${s.texture}: ${s.message}`).join('; ')||`${actorName} has no renderable faces`);
  // The textures of the mesh by index, and the environment map, as DrawMesh's Lock gives them.
  const textureInfo=index=>{
    let reference=null;
    try{reference=meshTexture(index);}catch{reference=null;}
    return reference?infos.get(reference.key)??null:null;
  };
  const environmentInfo=()=>{const reference=hasEnvironment?environmentTexture():null;return reference?infos.get(reference.key)??null:null;};

  let frameOutput=new Uint8Array(payload.frameVertexCount*12),lastOps=[],lastPose=null,materialStateApplied=false,lastStyle,lastGlow,drawnMain=false,childOnly=false;
  const pose=()=>{
    const animationActor=own.bAnimByOwner()?(own.Owner()??actor):actor;
    const self=animationActor===actor;
    return [animationActor,self?own.bParticles():read(animationActor,'bParticles'),own.DrawScale(),
      ...own.Location(),...own.Rotation(),...own.PrePivot(),
      self?own.AnimSequence():read(animationActor,'AnimSequence'),self?own.AnimFrame():read(animationActor,'AnimFrame'),
      ...(self?own.BlendAnimSequence():read(animationActor,'BlendAnimSequence')),
      ...(self?own.BlendAnimFrame():read(animationActor,'BlendAnimFrame'))];
  };
  const posedCopy=()=>new Float32Array(frameOutput.buffer.slice(0,payload.frameVertexCount*12));
  /** The world-space pose (GetFrame with identity Coords) and the group bounds. */
  function poseWorld(){
    const result=getUMeshFrame(payload,actor,IDENTITY,services,{output:frameOutput});
    lastOps=result.ops;frameOutput=result.output;
    for(const group of groups.values()){
      group.positions??=new Float32Array(group.indices.length*3);
      copyPositions(frameOutput,group.positions,group.indices);
      setMeshBounds(group.bounds,group.positions);
      group.sphere.copy(group.bounds.boundingSphere);
    }
  }
  poseWorld();
  lastPose=pose();
  const creation={id,handle:handleOf(actor),actorName,attached:false,mesh:{...plainRef(meshReference),key},classic:true,
    path:'cpu',environment:hasEnvironment,groups:[...groups.values()].map(group=>({key:group.key,texture:plainRef(group.reference),flags:group.flags,faces:group.faces})),
    plan:null,spheres:null,posed:posedCopy(),toCpu:null};
  const summary={actor:actorName,mesh:meshReference.key,skipped,triangles:faces.length,textures:[...new Set([...groups.values()].map(g=>g.reference.key))],
    animation:read(actor,'AnimSequence'),frame:read(actor,'AnimFrame'),shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original',
    path:'cpu',gpuFallback:null,classic:true};
  /** DrawMesh in the lighting frame: the camera-space pose, the corners' Light and the environment UVs. */
  function relight(prepared,frame){
    const camera=[...frame.origin,...frame.axes[0],...frame.axes[1],...frame.axes[2]];
    const out=new Uint8Array(payload.frameVertexCount*12);
    publishUMeshOps(payload,lastOps,umeshCameraMatrix(payload,actor,camera,services),{output:out});
    const points=new Float32Array(out.buffer);
    const uncoords=[0,1,2].map(j=>[frame.axes[0][j],frame.axes[1][j],frame.axes[2][j]]);
    const environment=environmentInfo();
    const result=drawUMesh(payload,points,{frame:{mirror:frame.mirror,prj:frame.prj??null,uncoords},polyFlags:(prepared.polyFlags|PF.Flat)>>>0,
      setup:prepared.setup,fatness:own.Fatness(),unlit:prepared.unlit,textureInfo,environment,
      light:(index,point,plane,flags)=>[...lightVertex(prepared.setup,point,plane,flags),0]});
    const colors=new Float32Array(faces.length*9).fill(1),envUv=hasEnvironment?new Float32Array(faces.length*6):null;
    for(const draw of result.draws){
      const tri=faces[draw.tri];
      tri.vertices.forEach((vertex,corner)=>{
        const light=result.vertexLight[vertex];
        const at=draw.tri*9+corner*3;
        if(draw.flags&PF.Modulated||!light)return;
        const packed=d3dDiffuse(light);
        colors[at]=((packed>>>16)&255)/255;colors[at+1]=((packed>>>8)&255)/255;colors[at+2]=(packed&255)/255;
      });
      if(draw.flags&PF.Environment&&envUv) {
        const norm=draw.uFactor*256;
        for(const pt of draw.pts){
          const corner=tri.vertices.indexOf(pt.index);
          if(corner<0)continue;
          envUv[draw.tri*6+corner*2]=pt.u/norm;envUv[draw.tri*6+corner*2+1]=pt.v/(draw.vFactor*256);
        }
      }
    }
    return {colors,cameraPoints:points,envUv,summary:{lights:prepared.setup.lights.length,flags:prepared.flags}};
  }
  const meshHandle=meshReference?handleOf(meshReference):0;
  const binding={id,actor,creation,dispose,mesh:meshReference,payload,get block(){return 0;},path:'cpu',viewDependent:false,
    packSetup({u32,f32,i32},at,keyIndex,record,reads,item=null){
      const SETUP=helpers.SETUP;
      u32[at+SETUP.KEY]=keyIndex>>>0;u32[at+SETUP.MESH]=record>>>0;u32[at+SETUP.TEXTURE]=0;u32[at+SETUP.USIZE]=0;u32[at+SETUP.VSIZE]=0;
      const location=item?item.location:own.Location(),rotation=item?item.rotation:own.Rotation(),pivot=own.PrePivot();
      u32[at+SETUP.DRAWTYPE]=own.DrawType()&255;
      for(let k=0;k<3;k++){f32[at+SETUP.LOCATION+k]=location[k];i32[at+SETUP.ROTATION+k]=rotation[k];f32[at+SETUP.PREPIVOT+k]=pivot[k];}
      f32[at+SETUP.DRAWSCALE]=item?item.drawScale:own.DrawScale();u32[at+SETUP.PARTICLES]=own.bParticles()?1:0;
      f32[at+SETUP.ANIMFRAME]=own.AnimFrame();
      const hit=setupSequence(payload.sequences,own.AnimSequence());
      u32[at+SETUP.SEQ]=hit?1:0;i32[at+SETUP.SEQ_START]=hit?.startFrame??0;i32[at+SETUP.SEQ_FRAMES]=hit?.numFrames??0;
    },
    admitted:()=>visible?visible(actor,own):(drawActor||!own.bHidden())&&!own.bDeleteMe(),
    childAdmitted:()=>Boolean(childVisible)&&childVisible(actor,own),
    specialCamera:()=>null,
    lastDraw:()=>({main:drawnMain,childOnly}),
    readMesh(){try{return own.Mesh();}catch{return undefined;}},
    meshChanged(){try{return own.Mesh()!==meshReference;}catch{return true;}},
    passVisibility(){
      if(disposed)return null;
      if(childOnly)return {root:true};
      return null;
    },
    framePass(frustum,inFrame){
      if(disposed||(!drawnMain&&!childOnly))return null;
      const root=frustum===null?drawnMain&&inFrame:inFrame;
      return {root:Boolean(root)};
    },
    hide(){drawnMain=false;childOnly=false;return {id,visible:false,childOnly:false};},
    drawnIn(frustum,decision){
      if(disposed)return false;
      const root=decision?decision.root:drawnMain;
      if(!root)return false;
      for(const group of groups.values())if(frustum.intersectsSphere(group.bounds.boundingSphere))return true;
      return false;
    },
    gpuState:()=>null,
    get location(){return [...read(actor,'Location')];},get rotation(){return [...read(actor,'Rotation')];},
    lodState:()=>null,
    update(view={}){
      if(disposed)return null;
      const record={id,visible:false,childOnly:false};drawnMain=false;
      let rootVisible=binding.admitted();
      const childIds=view.children instanceof Set?view.children:null;
      childOnly=!rootVisible&&Boolean(view.children&&(childIds?childIds.has(id):childVisible?.(actor,own)));
      if(view.main&&rootVisible&&!childOnly&&!view.main.has(id)){if(!view.children||childIds&&!childIds.has(id))return record;childOnly=true;}
      if(childOnly)rootVisible=true;
      if(!rootVisible)return record;
      if(view.cull&&view.frustum&&!view.main){
        const location=own.Location(),pivot=own.PrePivot();
        cullSphere.center.set(location[1]+pivot[1],location[2]+pivot[2],-(location[0]+pivot[0]));
        cullSphere.radius=cullRadius*Math.max(1,Math.abs(own.DrawScale()))*1.01+1;
        if(!view.frustum.intersectsSphere(cullSphere))return record;
      }
      if(own.Mesh()!==meshReference)throw new Error(`${actorName} changed Mesh; rebuilding the inspection resource is unsupported`);
      record.visible=true;record.childOnly=childOnly;drawnMain=!childOnly;
      const glow=lighting?1:Math.min(1,own.ScaleGlow()),style=own.Style();
      if(!materialStateApplied||!Object.is(glow,lastGlow)||!Object.is(style,lastStyle))record.material={glow,style};
      lastGlow=glow;lastStyle=style;materialStateApplied=true;
      const current=pose();
      const changed=!current.every((value,index)=>Object.is(value,lastPose[index]));
      lastPose=current;
      if(changed){poseWorld();record.posed=posedCopy();}
      // One SetupForActor and DrawMesh pass in the main frame (the frame whose Frame->Sprite holds the actor).
      if(lighting&&view.lit&&lighting.frame&&!childOnly) {
        const inView=!view.frustum||[...groups.values()].some(group=>view.frustum.intersectsSphere(group.bounds.boundingSphere));
        if(inView) {
          const prepared=lighting.setupMesh(actor,null,null);
          if(prepared) {
            const lit=relight(prepared,lighting.frame);
            record.colors=lit.colors;record.cameraPoints=lit.cameraPoints;
            if(lit.envUv)record.envUv=lit.envUv;
            summary.lighting=lit.summary;
          }
        }
      }
      summary.animation=own.AnimSequence();summary.frame=own.AnimFrame();
      record.changed=changed;
      return record;
    },summary};
  return binding;
}
