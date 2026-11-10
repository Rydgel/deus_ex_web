/** The page side of Play's actor mesh layer (docs/sim-worker.md step 4): the
 * three.js objects and GPU mesh slots of the bindings actor-mesh-sim.mjs
 * admits, built from their creation records and updated from their frame
 * records. Nothing here reads the runtime or decides what is drawn: the mesh
 * payloads decode from the page's own asset store, and visibility, poses,
 * lighting and material state come in the records.
 *
 * A binding's GPU slot is allocated and given its first plan when its
 * creation record arrives (synchronously when the mesh's package is
 * loaded), so the GPU passes see every plan the simulation side made; its
 * textures, materials and meshes follow asynchronously, and it draws once
 * they exist, with the latest record's state. */
import * as THREE from 'three';
import {REENCODE_GLSL} from './original-sampling.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {ActorMeshTextures} from './actor-mesh-textures.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {decodeLodMeshPayload} from '../runtime/lodmesh-payload.mjs';
import {meshFaces} from '../runtime/mesh-faces.mjs';
import {displayRampGlsl} from './light-atlas.mjs';
import {actorPassRenderOrder} from './render-layers.mjs';
import {meshVertexNormalsInto,writeMeshEnvironmentUV} from '../runtime/mesh-environment.mjs';
import {copyMeshLightColors} from './mesh-light-colors.mjs';
import {DRAW_VERTEX_DECLARATIONS} from './gpu-mesh.mjs';
import {frameProjection,FRAME_PROJECTION_KEY} from './frame-projection.mjs';
import {createActorBatches,BATCH_VERTEX_DECLARATIONS,BATCH_VERTEX_TAIL} from './actor-batches.mjs';
import {groupCorners,resolveMeshSkin} from './actor-mesh-skins.mjs';
import {easterSkins} from './easter-skins.mjs';
import {copyPositions,lodCornerIndices,setMeshBounds} from './actor-mesh-sim.mjs';

/** The face vertices of every face in order, as the environment mapping's normals read them (the faces' words, three of four). */
function environmentFaceIndices(faces) {
  const out=new Uint32Array(faces.count*3),{words}=faces;
  for(let i=0;i<faces.count;i++){out[i*3]=words[i*4];out[i*3+1]=words[i*4+1];out[i*3+2]=words[i*4+2];}
  return out;
}

/** The decoded mesh of a creation record, shared by its bindings. */
function meshSource(assets,cache,mesh) {
  let entry=cache.get(mesh.key);
  if(entry)return entry;
  const build=asset=>{
    const payload=decodeLodMeshPayload(asset.pkg,asset.bytes,mesh.index);
    // The mesh's faces as typed blocks (a classic UMesh, docs/umesh.md, has its triangles for surfaces).
    const faces=meshFaces(payload);
    return {payload,faces,faceWords:faces.words,asset};
  };
  const loaded=assets.loaded?.(mesh.package);
  entry=loaded?{ready:build(loaded)}:{pending:assets.get(mesh.package).then(asset=>(entry.ready=build(asset)))};
  cache.set(mesh.key,entry);
  return entry;
}
/** One simulation binding's page side (createMeshDraw makes it): its three.js root, groups and materials and its GPU slot. The state is
 * fields and the helpers are methods of the class every binding shares, where a scope of closures made for each binding held about
 * forty closures and their contexts a binding (docs/firefox-60fps-plan.md "The collector's window"). */
class MeshDraw {
  constructor() {
    this.assets=undefined;
    this.creation=undefined;
    this.gpu=undefined;
    this.texturePool=undefined;
    this.batches=undefined;
    this.displayGamma=undefined;
    this.rendered=undefined;
    this.onError=undefined;
    this.id=undefined;
    this.actorName=undefined;
    this.groupRecords=undefined;
    this.root=undefined;
    this.materials=undefined;
    this.textureLeases=undefined;
    this._groups=undefined;
    this.mode=undefined;
    this._gpuHandle=undefined;
    this.bases=undefined;
    this._source=undefined;
    this._ready=undefined;
    this.disposed=undefined;
    this.points=undefined;
    this.normals=undefined;
    this.faceIndices=undefined;
    this.lastStyle=undefined;
    this.lastGlow=undefined;
    this.materialStateApplied=undefined;
    this.gpuUniform=undefined;
    this.cameraOn=undefined;
    this.cameraFor=undefined;
    this.latest=undefined;
    this.pendingPlans=undefined;
    this.pendingLod=undefined;
    this.mainLighting=undefined;
    this.variantLit=undefined;
    this.flipSide=undefined;
    this.mainLodParams=undefined;
    this.appliedLodKey=undefined;
    this.shown=undefined;
    this.variantCpu=undefined;
    this.sourceEntry=undefined;
    this.materialOwner=undefined;
    this.built=undefined;
  }
  lodKey(params){return `${params.count}:${params.start}:${params.active}:${params.morph}:${params.inverse}`;}
  fullLodParams(){return {count:this._gpuHandle.mesh.lod.modelVerts,start:0,active:false,morph:false,inverse:0};}
  core(){
    if(this.disposed)return;
    const {payload,faces,faceWords}=this._source;
    if(this.creation.environment&&!this.creation.classic)this.faceIndices=environmentFaceIndices(faces);
    if(this.mode==='gpu'){
      this._gpuHandle=this.gpu.allocate(payload,faceWords,{environment:this.creation.environment,key:this.creation.mesh.key});
      this.bases={vbase:this._gpuHandle.vbase,cbase:this._gpuHandle.cbase};
      if(this.creation.plan)this.gpu.setPose(this._gpuHandle,this.creation.plan);
      for(const plan of this.pendingPlans.splice(0))this.gpu.setPose(this._gpuHandle,plan);
      if(this.pendingLod){this.gpu.setLod(this._gpuHandle,this.pendingLod);this.mainLodParams=this.pendingLod;this.pendingLod=null;}
    }
  }
  updateNormals(state=this.latest){
    if(!state.posed)return;
    this.points=state.posed;this.normals??=new Float32Array(this.points.length);
    // The LOD's admitted faces with their resolved corners.
    const resolved=state.lod?.resolved;
    meshVertexNormalsInto(this.points,resolved?Uint32Array.from(resolved.filter((v,i)=>resolved[i-i%3]>=0)):this.faceIndices,this.normals);
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    this.root.traverse(object=>object.geometry?.dispose());
    for(const material of this.materials)material.dispose();
    for(const lease of this.textureLeases)lease.release();
    for(const group of this._groups)if(group.batchEntry){this.batches.remove(group.batchEntry);group.batchEntry=null;}
    if(this._gpuHandle)this.gpu.release(this._gpuHandle);
    this.root.removeFromParent();
  }
  /** A group's visibility for the coming pass; a split two-sided group
   * draws its twin (front faces) with it. */
  showGroup(group,visible){
    if(group.batchEntry){this.batches.set(group.batchEntry,visible);group.mesh.visible=false;return;}
    group.mesh.visible=visible;
    if(group.twin)group.twin.visible=visible&&group.split;
  }
  /** Batch membership follows the group's material state: an opaque
   * GPU-path group joins the batch of its texture, side, alpha test and
   * environment flag; a transparent one draws its own mesh. */
  rebatch(group){
    // (a pawn's weapon draws alone: the side of its faces flips with the pass, applyPass)
    const material=group.material,want=this.batches&&this.mode==='gpu'&&!this.creation.attached&&!material.transparent
      ?`${group.texture.uuid}:${material.side}:${material.alphaTest>0?1:0}:${group.environment?1:0}`:null;
    if(group.batchEntry&&group.batchEntry.key===want)return;
    if(group.batchEntry){this.batches.remove(group.batchEntry);group.batchEntry=null;}
    if(want){group.batchEntry={key:want,group,rendered:this.rendered,visible:false};this.batches.add(want,group.material,group.batchEntry);
      group.mesh.visible=false;}
  }
  hideBatched(){for(const group of this._groups)if(group.batchEntry)this.batches.set(group.batchEntry,false);}
  /** Everything a hidden record can change on this binding, as one string (ACTOR_PLUMBING=verify: a plain hidden record that
   * follows one must leave it as it is, actor-mesh-sim.mjs hiddenRun; validate-sim-split.mjs --draw-state compares it per frame). */
  hiddenState(){return JSON.stringify([this.root.visible,this.latest.visible,this.latest.childOnly,this.latest.cameraPoints===null,this.appliedLodKey,
    this.mainLighting===null,this.variantLit,this.variantCpu,this.flipSide,this.mode,this._gpuHandle!==null,
    this._groups.map(group=>[group.mesh.visible,group.twin?.visible??null,group.batchEntry?group.batchEntry.visible:null])]);}
  applyQuiet(draw,record,cameraPosition,words){
    const before=this.hiddenState(),changed=draw.apply({id:record.id,visible:record.visible,childOnly:record.childOnly},cameraPosition,words);
    if(this.hiddenState()!==before)throw new Error(`ACTOR_PLUMBING=verify: a hidden record after a hidden record changed ${this.actorName}`);
    return changed;
  }
  setSpheres(words){
    if(!words)return;
    this._groups.forEach((group,i)=>{const at=i*4;group.geometry.boundingSphere.center.set(words[at],words[at+1],words[at+2]);
      group.geometry.boundingSphere.radius=words[at+3];});
  }
  // The drawn corners: GetFrame's (or the LOD's morphed) positions at each
  // corner's vertex, the LOD's resolved one (actor-mesh-sim.mjs
  // lodCornerIndices); a group the LOD empties is not drawn.
  cpuPositions(state=this.latest){
    const resolved=state.lod?.resolved??null;
    this.shown=state;
    for(const group of this._groups){
      const positions=group.geometry.getAttribute('position');
      const indices=resolved?lodCornerIndices(group.faces,group.indices,resolved,group):group.indices;
      if(!resolved)group.lodEmpty=false;
      group.cornerIndices=indices;
      copyPositions(state.posed,positions.array,indices);positions.needsUpdate=true;
      setMeshBounds(group.geometry,positions.array);
      if(this.mode==='cpu'){group.mesh.visible=!group.lodEmpty;if(group.twin)group.twin.visible=!group.lodEmpty&&group.split;}
    }
    this.cameraOn.value=this.cameraFor===this.shown?1:0;
    if(this.creation.environment&&!this.creation.classic)this.updateNormals(state);
  }
  // The corners' U and V bytes: the LOD's packed wedge dwords, or the faces'.
  lodUVs(state=this.latest){
    const scratch=state.lod?.scratch??null,{faces}=this._source;
    for(const group of this._groups){
      if(group.environment)continue;
      const uv=group.geometry.getAttribute('uv');
      let at=0;
      for(const faceIndex of group.faces){
        for(const corner of [0,2,1]){
          if(scratch){const word=scratch[faces.wedges[faceIndex*3+corner]];uv.array[at]=((word>>>16)&255)/256;uv.array[at+1]=(word>>>24)/256;}
          else{uv.array[at]=faces.uv[faceIndex*6+corner*2]/256;uv.array[at+1]=faces.uv[faceIndex*6+corner*2+1]/256;}
          at+=2;
        }
      }
      uv.needsUpdate=true;
    }
  }
  /** A classic mesh's environment-mapped corners' U and V (actor-umesh-sim.mjs): the original face helper's
   * values for each face's corners, in the group's reflected corner order (0,2,1). */
  applyEnvUv(envUv){
    if(!envUv)return;
    for(const group of this._groups){
      if(!group.environment)continue;
      const uv=group.geometry.getAttribute('uv'),array=uv.array;
      let at=0;
      for(const faceIndex of group.faces){
        const s=faceIndex*6;
        array[at]=envUv[s];array[at+1]=envUv[s+1];
        array[at+2]=envUv[s+4];array[at+3]=envUv[s+5];
        array[at+4]=envUv[s+2];array[at+5]=envUv[s+3];
        at+=6;
      }
      uv.needsUpdate=true;
    }
  }
  applyColors(colors){
    const words=new Uint32Array(colors.buffer,colors.byteOffset,colors.length);
    for(const group of this._groups)if(copyMeshLightColors(group.lightWords,words,group.faces))
      group.geometry.getAttribute('deusLight').needsUpdate=true;
  }
  /** CPU path: the camera-space points the original projects (docs/frame-projection.md "Meshes"). `cameraPoints`
   * is GetFrame's buffer for the frame whose colours were just applied, after that frame's LOD morph
   * (actor-mesh-sim.mjs relight): its corners go to the groups' `deusCameraPoint` attribute, in the order of
   * the state shown. Null (the frame did not light the actor): the world pose projects instead. */
  applyCamera(cameraPoints){
    if(this.mode!=='cpu')return;
    this.cameraFor=null;
    if(cameraPoints){
      for(const group of this._groups){
        const indices=group.cornerIndices;
        if(!indices)continue;
        let attribute=group.geometry.getAttribute('deusCameraPoint');
        if(!attribute){
          attribute=new THREE.BufferAttribute(new Float32Array(indices.length*3),3).setUsage(THREE.DynamicDrawUsage);
          group.geometry.setAttribute('deusCameraPoint',attribute);
        }
        const target=attribute.array;
        for(let corner=0;corner<indices.length;corner++){
          const from=indices[corner]*3,at=corner*3;
          target[at]=cameraPoints[from];target[at+1]=cameraPoints[from+1];target[at+2]=cameraPoints[from+2];
        }
        attribute.needsUpdate=true;
      }
      this.cameraFor=this.shown;
    }
    this.cameraOn.value=this.cameraFor===this.shown?1:0;
  }
  applyMaterial({glow,style}){
    if(this.materialStateApplied&&Object.is(glow,this.lastGlow)&&Object.is(style,this.lastStyle))return;
    for(const material of this.materials)applyMaterialStyle(material,glow,style);
    for(const group of this._groups){
      // A transparent group draws in DrawFrame's sprite pass for the actor's Style (render-layers.mjs ACTOR_PASS_RENDER_ORDER);
      // an opaque one keeps the opaque list's order.
      group.mesh.renderOrder=group.material.transparent?actorPassRenderOrder(style):0;
      if(group.twin)group.twin.renderOrder=group.mesh.renderOrder;
      this.rebatch(group);
      if(!group.sided)continue;
      group.split=group.sided.double.transparent;
      group.mesh.material=group.split?group.sided.back:group.sided.double;
      if(!group.batchEntry)this.showGroup(group,group.mesh.visible);
    }
    this.lastGlow=glow;this.lastStyle=style;this.materialStateApplied=true;
  }
  /** Leave the GPU path for good: the posed vertices from the record and
   * the CPU path's attributes. */
  toCpu(){
    if(this.mode!=='gpu')return;
    this.mode='cpu';this.gpuUniform.value=0;
    if(this._ready){
      this.cpuPositions();
      for(const group of this._groups){
        if(group.batchEntry){this.batches.remove(group.batchEntry);group.batchEntry=null;}
        group.mesh.frustumCulled=true;if(group.twin)group.twin.frustumCulled=true;this.showGroup(group,true);
      }
    }
    if(this._gpuHandle){this.gpu.release(this._gpuHandle);this._gpuHandle=null;}
  }
  updateView(cameraPosition){
    // A classic mesh's environment UVs come in its records (applyEnvUv), from DrawMesh's own camera-space reflection.
    if(this.disposed||!this._ready||!this.root.visible||!this.creation.environment||this.creation.classic||!cameraPosition||this.mode!=='cpu'||!this.points)return false;
    const relative=[0,0,0],normal=[0,0,0];
    for(const group of this._groups)if(group.flags&POLY.Environment){
      const uv=group.geometry.getAttribute('uv'),indices=this.shown.lod?.resolved&&group.lodIndices?group.lodIndices:group.indices;
      for(let i=0;i<indices.length;i++){
        const at=indices[i]*3;
        relative[0]=Math.fround(this.points[at]-cameraPosition[0]);relative[1]=Math.fround(this.points[at+1]-cameraPosition[1]);
        relative[2]=Math.fround(this.points[at+2]-cameraPosition[2]);
        normal[0]=this.normals[at];normal[1]=this.normals[at+1];normal[2]=this.normals[at+2];
        writeMeshEnvironmentUV(uv.array,i*2,relative,normal);
      }
      uv.needsUpdate=true;
    }
    return true;
  }
  /** The meshes and materials (the creation's skins decode here). */
  async build(){
    const {asset,faces}=this._source;
    const textures=new TextureStore(this.assets);
    for(const record of this.groupRecords){
      const {indices,uvs,corners}=groupCorners(faces,record);
      const reference=record.texture,skinAsset=reference.package===asset.name?asset:await this.assets.get(reference.package);
      // ?easter=1 (easter-skins.mjs): the two mod actors' recoloured skins; no-op while no skins are registered.
      const resolved=await resolveMeshSkin(textures,skinAsset,reference.index,record.flags);
      const {data,flags}=easterSkins.current?await easterSkins.current({actorName:this.actorName,record,faces,assets:this.assets,textures,...resolved}):resolved;
      // Keep the original private decoder/await sequence: only the GPU
      // resource is shared, synchronously, at its former allocation point.
      const textureLease=this.texturePool.acquire(data,flags);this.textureLeases.push(textureLease);
      const texture=textureLease.texture,first=data.mips[0],key=record.key;
      // (groupMaterial: the display-encoded sampling and lighting, and Style's modulated ramp)
      const modulatedUniform={value:!(flags&POLY.Translucent)&&flags&POLY.Modulated?1:0};
      const environmentGroup=Boolean(record.flags&POLY.Environment),gpuSlot=this.creation.path==='gpu';
      const makeMaterial=side=>{
        // (the binding's owner object, made at its first group: the materials' shared shader hook reads it)
        const owner=this.materialOwner??={gpuSlot,gpu:this.gpu,displayGamma:this.displayGamma,cameraOn:this.cameraOn,gpuUniform:this.gpuUniform};
        const material=groupMaterial(owner,{texture,side,flags,environmentGroup,modulatedUniform});
        this.materials.push(material);
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
      const positions=new Float32Array(indices.length*3);
      if(this.creation.path==='cpu')copyPositions(this.latest.posed,positions,indices);
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      const lightColors=new Float32Array(indices.length*3).fill(1);
      const group={key,flags:record.flags,indices,faces:record.faces,lightWords:new Uint32Array(lightColors.buffer),
        environment:environmentGroup,batchEntry:null,split:false};
      geometry.setAttribute('deusLight',new THREE.BufferAttribute(lightColors,3).setUsage(THREE.DynamicDrawUsage));
      if(gpuSlot){
        // The slot's first ordinary vertex texel: each corner adds its
        // resolved wedge's vertex (gpuBeginVertex).
        const ordinaryTexel=this.bases.vbase+(this._source.payload.scalarBits.get(0x184)|0);
        geometry.setAttribute('deusVertexTexel',new THREE.BufferAttribute(new Float32Array(indices.length).fill(ordinaryTexel),1));
        geometry.setAttribute('deusCornerTexel',new THREE.BufferAttribute(
          Float32Array.from(corners,corner=>this.bases.cbase+corner),1));
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      group.geometry=geometry;
      const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;
      mesh.onAfterRender=this.rendered;
      // A pawn's weapon (creation.attached) draws camera-space points the hand's Coords place; its world-space
      // pose, which the bounds come from, is not where it is drawn, and the simulation side decides what is drawn.
      if(gpuSlot||this.creation.attached)mesh.frustumCulled=false;
      Object.assign(group,{mesh,sided,material,texture});
      mesh.userData={actor:`${this.actorName} (mesh inspection)`,faces:record.faces};this.root.add(mesh);
      if(sided){
        // Created right after its mesh: the adjacent id keeps the pair
        // consecutive in three.js's transparent sort (equal depth).
        const twin=new THREE.Mesh(geometry,sided.front);twin.matrixAutoUpdate=false;
        twin.onAfterRender=this.rendered;twin.frustumCulled=mesh.frustumCulled;twin.visible=false;
        twin.userData={...mesh.userData,twinOf:mesh};group.twin=twin;this.root.add(twin);
      }
      this._groups.push(group);
    }
    if(this.disposed){this.dispose();return;}
    this.setSpheres(this.latest.spheres);
    if(this.mode==='cpu'){
      if(this.creation.environment&&!this.creation.classic)this.updateNormals();
      if(this.creation.path==='gpu')this.toCpuApplied();
    }
    this._ready=true;
    this.applyLatest();
  }
  // A binding that left the GPU path before its meshes existed.
  toCpuApplied(){
    this.cpuPositions();
    for(const group of this._groups){group.mesh.frustumCulled=true;if(group.twin)group.twin.frustumCulled=true;this.showGroup(group,true);}
  }
  applyLatest(){
    this.root.visible=this.latest.visible;
    if(!this.latest.visible){this.hideBatched();return;}
    if(this.latest.material)this.applyMaterial(this.latest.material);
    if(this.latest.lod)this.lodUVs();
    if(this.mode==='cpu'&&this.latest.posed)this.cpuPositions();
    if(this.mode==='gpu'&&this.latest.groups)this._groups.forEach((group,i)=>this.showGroup(group,Boolean(this.latest.groups[i])));
    if(this.latest.colors)this.applyColors(this.latest.colors);
    this.applyEnvUv(this.latest.envUv);
    this.applyCamera(this.latest.cameraPoints);
    if(this.latest.childOnly){this.root.visible=false;this.hideBatched();}
  }
  /** The simulation side's conversion after a context loss (actor-mesh-sim.mjs leaveGpu): the posed vertices and LOD
   * state of the current pose, then the CPU path. The next frame's record shows it again. */
  leaveGpu(record){
    if(this.disposed)return;
    this.latest.posed=record.posed;
    if(record.lod!==undefined)this.latest.lod=record.lod.resolved?record.lod:null;
    this.toCpu();
    if(this._ready&&record.lod!==undefined)this.lodUVs();
  }
  get ready(){return this._ready;}
  get path(){return this.mode;}
  drawState(...args){return this.hiddenState(...args);}
  get viewDependent(){return this.creation.environment&&this.mode==='cpu'&&!this.creation.classic;}
  /** Validation access (main.mjs meshLod): the faces this binding's
   * geometry draws under the LOD and their distinct vertices, the groups
   * the LOD empties and whether the root is shown. */
  lodStats(){
    if(this.mode==='gpu'&&this._gpuHandle&&this._source){
      // The GPU path: the corner pass's resolved dwords for this slot.
      const words=this.gpu.read('cornerWedges',this._gpuHandle.cbase,this._gpuHandle.mesh.F*3);
      let faces=0,dropped=0;const vertices=new Set();
      for(let i=0;i<words.length;i+=3){
        if(words[i]>=0xfffffffe){dropped++;continue;}
        faces++;for(let k=0;k<3;k++)vertices.add(words[i+k]&0xffff);
      }
      return {id:this.id,path:this.mode,ready:this._ready,visible:this.root.visible,lod:dropped?{faces,vertices:vertices.size,
        emptyGroups:null}:null,gpuFaces:faces,gpuVertices:vertices.size,faces:this._source.faces.count};
    }
    const resolved=this.shown.lod?.resolved??null;
    let faces=0;const vertices=new Set();
    if(resolved)for(let i=0;i<resolved.length;i+=3){if(resolved[i]<0)continue;faces++;vertices.add(resolved[i]).add(resolved[i+1]).add(resolved[i+2]);}
    // `cameraPoints`: the geometry holds the camera-space points of the state shown (applyCamera).
    return {id:this.id,path:this.mode,ready:this._ready,visible:this.root.visible,lod:resolved?{count:this.shown.lod.count,faces,vertices:vertices.size,
      emptyGroups:this._groups.filter(group=>group.lodEmpty).length}:null,
      faces:this._source?.faces.count??null,cameraPoints:this.cameraFor===this.shown};
  }
  /** Validation access: the GPU slot and the decoded faces. */
  get gpuHandle(){return this._gpuHandle;}
  get groups(){return this._groups;}
  get source(){return this._source;}
  /** One main-frame record (actor-mesh-sim.mjs update); `words` is the
   * frame's packed plans and lighting ({u32, f32}, mesh-frame-pack.mjs)
   * when the record holds offsets into them. */
  apply(record,cameraPosition,words=null){
    if(this.disposed)return false;
    if(record.quiet===true)return this.applyQuiet(this,record,cameraPosition,words);
    const plan=typeof record.plan==='number'?{...words,at:record.plan}:record.plan;
    const lighting=typeof record.lighting==='number'?{...words,at:record.lighting}:record.lighting;
    this.latest.visible=record.visible;this.latest.childOnly=record.childOnly;
    if(record.material)this.latest.material=record.material;
    if(record.posed)this.latest.posed=record.posed;
    if(record.groups)this.latest.groups=record.groups;
    if(record.spheres)this.latest.spheres=record.spheres;
    if(record.colors)this.latest.colors=record.colors;
    this.latest.cameraPoints=record.cameraPoints??null;
    if(record.envUv)this.latest.envUv=record.envUv;
    const lodChanged=record.lod!==undefined;
    if(lodChanged)this.latest.lod=record.lod.resolved?record.lod:null;
    if(plan&&this.mode==='gpu'&&!record.toCpu){if(this._gpuHandle)this.gpu.setPose(this._gpuHandle,plan);else if(!this._source)this.pendingPlans.push(plan);}
    if(record.lodParams&&this.mode==='gpu'&&!record.toCpu){
      this.mainLodParams=record.lodParams;
      if(this._gpuHandle)this.gpu.setLod(this._gpuHandle,record.lodParams);else if(!this._source)this.pendingLod=record.lodParams;
    }else if(this.appliedLodKey!==null&&this.mode==='gpu'&&this._gpuHandle){
      // A child frame's LOD state is still on the slot (its restoring pass
      // did not run): the main frame's again, redone by this frame's run.
      this.gpu.setLod(this._gpuHandle,this.mainLodParams??this.fullLodParams());
    }
    this.appliedLodKey=null;
    if(record.toCpu)this.toCpu();
    if(lighting&&this._gpuHandle&&!this.gpu.setLighting(this._gpuHandle,lighting))
      throw new Error(`${this.actorName}: the GPU mesh lights differ from the simulation side's layout`);
    this.mainLighting=lighting??null;this.variantLit=false;
    if(!this._ready)return false;
    this.root.visible=record.visible;
    if(!record.visible){this.hideBatched();return false;}
    if(record.material)this.applyMaterial(record.material);
    if(lodChanged)this.lodUVs();
    if(record.posed&&this.mode==='cpu')this.cpuPositions();
    else if(this.variantCpu&&this.mode==='cpu'&&this.latest.posed){this.cpuPositions();this.lodUVs();}
    this.variantCpu=false;
    if(record.spheres)this.setSpheres(record.spheres);
    if(this.mode==='gpu'&&this.latest.groups)this._groups.forEach((group,i)=>this.showGroup(group,Boolean(this.latest.groups[i])));
    const environmentUpload=this.updateView(cameraPosition);
    if(record.colors)this.applyColors(record.colors);
    this.applyEnvUv(record.envUv);
    this.applyCamera(this.latest.cameraPoints);
    // Hidden from the main pass until a child pass shows it.
    if(record.childOnly){this.root.visible=false;this.hideBatched();}
    return Boolean(record.changed)||environmentUpload;
  }
  /** A pass's decision (actor-mesh-sim.mjs passVisibility, framePass).
   * A child frame's decision (`frame`) carries the lighting that frame's
   * DrawFrame gave the actor (Coords, Mirror, LeafLights): the GPU path
   * queues it for the pass's lighting run (returns true), the CPU path
   * takes its corner colours now. The main frame's decision after it
   * restores the actor's own lighting. */
  applyPass(decision){
    if(!this._ready||!decision)return false;
    this.root.visible=decision.root;
    // A pawn's weapon in a mirror's frame (decision.flipSide): its faces are kept with Mirror 1.0, so the pass's
    // reversed winding shows the other side of them.
    if(this.creation.attached&&Boolean(decision.flipSide)!==this.flipSide){
      this.flipSide=Boolean(decision.flipSide);
      for(const group of this._groups)if(!group.sided)group.mesh.material.side=this.flipSide?THREE.BackSide:THREE.FrontSide;
    }
    if(!decision.root){this.hideBatched();return false;}
    if(decision.spheres)this.setSpheres(decision.spheres);
    if(decision.groups)this._groups.forEach((group,i)=>this.showGroup(group,Boolean(decision.groups[i])));
    let queued=false;
    // The LOD state of this pass: the child frame's own when it differs
    // from the base's (`lodParams` on the GPU path, `cpuState` on the CPU
    // path), else the main frame's.
    let lodChanged=false;
    if(this.mode==='gpu'&&this._gpuHandle){
      const want=decision.lodParams??null,key=want?this.lodKey(want):null;
      if(key!==this.appliedLodKey){this.gpu.setLod(this._gpuHandle,want??this.mainLodParams??this.fullLodParams());this.appliedLodKey=key;lodChanged=queued=true;}
    }else if(this.mode==='cpu'&&this.latest.posed){
      if(decision.cpuState){this.cpuPositions(decision.cpuState);this.lodUVs(decision.cpuState);this.variantCpu=true;}
      else if(this.variantCpu){this.cpuPositions();this.lodUVs();this.variantCpu=false;}
    }
    if(decision.frame!==undefined&&(decision.lighting||decision.colors)){
      if(decision.lighting&&this.mode==='gpu'&&this._gpuHandle){
        if(!this.gpu.setLighting(this._gpuHandle,decision.lighting))
          throw new Error(`${this.actorName}: the GPU mesh lights differ from the simulation side's layout`);
        queued=this.variantLit=true;
      }else if(decision.colors){this.applyColors(decision.colors);this.applyCamera(decision.cameraPoints??null);this.variantLit=true;}
    }else if(this.variantLit||lodChanged){
      // The main frame's lighting again, also under a LOD state that changed.
      if(this.mode==='gpu'&&this.mainLighting&&this._gpuHandle){
        if(!this.gpu.setLighting(this._gpuHandle,this.mainLighting))throw new Error(`${this.actorName}: the GPU mesh lights differ from the simulation side's layout`);
        queued=true;
      }else if(this.latest.colors){this.applyColors(this.latest.colors);this.applyCamera(this.latest.cameraPoints);}
      this.variantLit=false;
    }
    return queued;
  }
}


/** One binding's three.js objects and GPU slot. `rendered(renderer)` is its
 * actor's render feedback. */
export function createMeshDraw(assets,creation,{gpu=null,texturePool,batches=null,displayGamma={value:1},rendered,
  meshes,onError=()=>{}}) {
  const inst=new MeshDraw();
  inst.assets=assets; inst.creation=creation; inst.gpu=gpu; inst.texturePool=texturePool; inst.batches=batches; inst.displayGamma=displayGamma; inst.rendered=rendered; inst.onError=onError;
  const {id,actorName,groups:groupRecords}=inst.creation; inst.id=id; inst.actorName=actorName; inst.groupRecords=groupRecords;
  inst.root=new THREE.Group(); inst.materials=[]; inst.textureLeases=[]; inst._groups=[];inst.root.matrixAutoUpdate=false;
  inst.root.name=`${inst.actorName} authored mesh inspection`;inst.root.visible=false;
  inst.mode=inst.creation.path; inst._gpuHandle=null; inst.bases=null; inst._source=null; inst._ready=false; inst.disposed=false; inst.points=null; inst.normals=null; inst.faceIndices=null;
  inst.materialStateApplied=false;
  inst.gpuUniform={value:inst.mode==='gpu'?1:0};
  // CPU path: 1 while the geometry's `deusCameraPoint` attribute holds the camera-space points of the state
  // shown (applyCamera).
  inst.cameraOn={value:0};inst.cameraFor=null;
  // The latest record's state, applied when the meshes exist.
  inst.latest={visible:Boolean(inst.creation.visible),childOnly:false,material:null,posed:inst.creation.posed,colors:null,cameraPoints:null,groups:null,
    spheres:inst.creation.spheres,lod:null};
  inst.pendingPlans=[];inst.pendingLod=null;
  // The main frame's lighting this frame (its packed words or plain record), kept
  // to give the actor its main lighting back after a child frame's pass
  // lit it with that frame's Coords and Mirror (applyPass).
  inst.mainLighting=null; inst.variantLit=false; inst.flipSide=false;
  // The LOD state of the main frame (the GPU record's parameters, null at
  // full detail) and which child frame's state is on the slot or geometry
  // (docs/script-lodmesh-lod.md "Child frames"): the key of its GPU
  // parameters, or the CPU state shown.
  inst.mainLodParams=null; inst.appliedLodKey=null; inst.shown=inst.latest; inst.variantCpu=false;
  inst.sourceEntry=meshSource(inst.assets,meshes,inst.creation.mesh);
  if(inst.sourceEntry.ready){inst._source=inst.sourceEntry.ready;inst.core();}
  inst.built=(inst.sourceEntry.ready?Promise.resolve():inst.sourceEntry.pending.then(asset=>{inst._source=inst.sourceEntry.ready;inst.core();}))
    .then(()=>inst.build()).catch(error=>{inst.onError({actor:`${inst.actorName}`,message:error.message});inst.dispose();});
   return inst;
}

/** The level's actor mesh layer on the page: one createMeshDraw per
 * simulation binding. `feedback(handle)` is a binding actor's render
 * feedback (actor-render-feedback.mjs). */
export function createActorMeshDraw(assets,{gpu=null,lit=false,displayGamma,feedback}) {
  const root=new THREE.Group(),textures=new ActorMeshTextures();root.visible=false;root.matrixAutoUpdate=false;
  // Every object under this root keeps the identity matrix: GetFrame's
  // vertices are world-space, and no binding root, group, twin or batch
  // mesh moves or updates its own matrix. The renderer's non-forced
  // Scene.updateMatrixWorld (twice a frame) therefore need not walk these
  // thousands of objects; a forced cascade still does, and
  // validate-scene-matrices compares the two on every update.
  root.updateMatrixWorld=function(force){if(force)THREE.Object3D.prototype.updateMatrixWorld.call(this,force);};
  // Opaque GPU-path groups that share a material state draw as one batch
  // (actor-batches.mjs); only with original lighting, where every actor's
  // material colour is the same.
  const batches=gpu&&lit?createActorBatches(root,{makeMaterial:(template,members)=>
    batchMaterial(template,members,gpu,displayGamma)}):null;
  const bindings=new Map(),meshes=new Map(),errors=[];
  // (one function for every binding: made in create it was a closure and a context for each)
  const onError=error=>errors.push(error);
  let mainCamera=null,passProbe=null,passCount=0;
  return {root,bindings,errors,batches,textures,
    /** Validation only: with `on`, every pass records what each binding it
     * draws has on the slot or geometry once the pass's lighting run is done
     * (lodStats), tagged with the pass's number and the decision's frame;
     * `takePassProbe` returns and clears the records. */
    setPassProbe(on){passProbe=on?[]:null;},
    /** Validation only: every binding's drawn state (actor-mesh-draw.mjs createMeshDraw hiddenState), one line each. */
    drawState(){let out='';for(const [id,draw] of bindings)out+=`${id}:${draw.drawState()}\n`;return out;},
    takePassProbe(){const records=passProbe;if(passProbe)passProbe=[];return records;},
    /** A binding's creation record: its GPU slot now, its meshes when built. */
    create(creation){
      const draw=createMeshDraw(assets,creation,{gpu,texturePool:textures,batches,displayGamma,
        rendered:feedback(creation.handle),meshes,onError});
      bindings.set(creation.id,draw);
      draw.built.then(()=>{if(bindings.get(creation.id)===draw&&draw.ready)root.add(draw.root);});
      return draw;
    },
    release(id){bindings.get(id)?.dispose();bindings.delete(id);},
    /** The conversions of a context restore (actor-mesh-sim.mjs leaveGpu), in their order. */
    leaveGpu(records){for(const record of records)bindings.get(record.id)?.leaveGpu(record);},
    /** One main frame (actor-mesh-sim.mjs update): the records in order,
     * then the GPU passes with the lighting frame's coordinates. */
    apply({records,camera},cameraPosition,words=null){
      if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
      // A pass that stopped on an error leaves no lighting run open.
      gpu?.cancelLightRun();
      let changed=false;
      for(const record of records)changed=bindings.get(record.id)?.apply(record,cameraPosition,words)||changed;
      if(gpu){if(camera){mainCamera={origin:camera.origin,axes:camera.axes,mirror:1};gpu.setCamera(camera.origin,camera.axes,1);}gpu.run();}
      batches?.flush();
      return changed;
    },
    /** A pass (the mirror and sky frames, then the main frame again): each
     * binding's decision, the lighting run of the actors it relights (a
     * child frame's, in `lightView` {origin, axes, mirror}; or the main
     * frame's once the passes are done), then the camera-relative
     * environment UVs of CPU-path bindings. */
    pass(decisions,cameraPosition,lightView=null){
      if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
      if(gpu)gpu.beginLightRun();
      let queued=false;
      for(const [id,draw] of bindings){
        queued=draw.applyPass(decisions.get(id))||queued;
        if(draw.viewDependent)draw.updateView(cameraPosition);
      }
      if(gpu){
        if(queued&&(lightView??mainCamera))gpu.lightRun(lightView??mainCamera);else gpu.cancelLightRun();
      }
      if(passProbe){
        passCount++;
        for(const [id,draw] of bindings){
          const decision=decisions.get(id);
          if(decision?.root&&draw.ready)passProbe.push({pass:passCount,frame:decision.frame??null,child:Boolean(lightView),...draw.lodStats()});
        }
      }
      batches?.flush();
    },
    async ready(){await Promise.all([...bindings.values()].map(draw=>draw.built));},
    batchStats:()=>batches?.stats()??null,
    proceduralTextures:()=>textures.procedural.records(),
    dispose(){for(const draw of bindings.values())draw.dispose();bindings.clear();batches?.dispose();textures.dispose();},
  };
}

// The programs' cache keys of a group's material, one function for each of the three (made for each material they were two closures
// and a context a group, with the shader hook below).
const gpuEnvironmentProgramKey=()=>`deus-ex-mesh-gpu-v3:1:${FRAME_PROJECTION_KEY}`;
const gpuProgramKey=()=>`deus-ex-mesh-gpu-v3:0:${FRAME_PROJECTION_KEY}`;
const displayProgramKey=()=>`deus-ex-mesh-display-color-v4:${FRAME_PROJECTION_KEY}`;
/** A group's shader hook (three.js calls it as `material.onBeforeCompile(shader, renderer)`): `this` is the material, which holds its
 * binding's `deusOwner` ({gpuSlot, gpu, displayGamma, cameraOn, gpuUniform}), the group's `deusEnvironment` and its `deusModulated`
 * uniform. */
function groupBeforeCompile(shader){
  const {gpuSlot,gpu,displayGamma,cameraOn,gpuUniform}=this.deusOwner,environmentGroup=this.deusEnvironment,modulatedUniform=this.deusModulated;
  shader.uniforms.deusDisplayGamma=displayGamma;shader.uniforms.deusModulated=modulatedUniform;
  shader.uniforms.deusCameraOn=cameraOn;
  if(gpuSlot){
    Object.assign(shader.uniforms,gpu.shared,{deusGpu:gpuUniform});
    shader.vertexShader=shader.vertexShader.replace('#include <common>',
      `#include <common>\nattribute vec3 deusLight;\nvarying vec3 vDeusLight;\n${CPU_CAMERA_DECLARATIONS}${DRAW_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>',gpuBeginVertex(environmentGroup,true));
  } else shader.vertexShader=shader.vertexShader.replace('#include <common>',
    `#include <common>\nattribute vec3 deusLight;\nvarying vec3 vDeusLight;\n${CPU_CAMERA_DECLARATIONS}`)
    .replace('#include <begin_vertex>',`#include <begin_vertex>\nvDeusLight = deusLight;\n${CPU_CAMERA_BEGIN}`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
    '#include <common>\nuniform float deusDisplayGamma;\nuniform float deusModulated;\nvarying vec3 vDeusLight;')
    .replace('#include <colorspace_fragment>',
      REENCODE_GLSL+'\ngl_FragColor.rgb *= vDeusLight;\n'+
      `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
      `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
  // The original's vertex projection (docs/frame-projection.md): both paths project the lighting
  // frame's camera-space buffer (a GPU slot's texture, or the CPU path's attribute once it left the slot).
  frameProjection.patch(shader,{floatFloat:!gpuSlot,camera:true});
}

/** A group's material (createMeshDraw's build), the shader warm-up's too (actorMeshWarmup). Texture sampling (the
 * skins are display-space 8-bit values, filtered as such: original-sampling.mjs) and recovered vertex lighting are in
 * the same display-encoded space for the main framebuffer and mirror target. D3D modulates the display-encoded texel
 * by the vertex diffuse (docs/mesh-lighting.md), before the display gamma ramp; the world shader treats light maps
 * the same way. Style can switch a material to PF_Modulated at run time, so the modulated display ramp
 * (displayRampGlsl) is a uniform branch. */
function groupMaterial(owner,{texture,side,flags,environmentGroup,modulatedUniform}){
  const material=new THREE.MeshBasicMaterial({map:texture,side,alphaTest:flags&POLY.Masked?.5:0});
  material.customProgramCacheKey=owner.gpuSlot?environmentGroup?gpuEnvironmentProgramKey:gpuProgramKey:displayProgramKey;
  material.onBeforeCompile=groupBeforeCompile;
  // What the shared functions above and below read (three.js calls both as methods of the material): the binding's, and the group's.
  material.deusOwner=owner;material.deusEnvironment=environmentGroup;material.deusModulated=modulatedUniform;
  if(flags&(POLY.Translucent|POLY.Modulated)) {
    material.transparent=true;material.depthWrite=false;material.blending=THREE.CustomBlending;
    material.blendSrc=flags&POLY.Translucent?THREE.OneFactor:THREE.DstColorFactor;
    material.blendDst=flags&POLY.Translucent?THREE.OneMinusSrcColorFactor:THREE.SrcColorFactor;
  }
  return material;
}

/** A record's material state on one of a binding's materials (applyMaterial): ScaleGlow, and Style over the
 * group's flags (translucent, modulated, masked). */
function applyMaterialStyle(material,glow,style){
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

/** The shader warm-up's objects for the actor mesh layer and the view model (shader-warmup.mjs): every program
 * a binding's groups can draw with, from groupMaterial, applyMaterialStyle and batchMaterial. A program's key
 * reads the material's side, alpha test and opacity (transparent or a blending other than normal), and the
 * custom key: the GPU slot's environment flag, or the CPU path, which a binding created without a GPU slot takes
 * beside a GPU instance too (two such programs were built at the player's death on Airfield). Per group:
 * one-sided, its material (FrontSide); two-sided, the DoubleSide material while opaque and the back- and
 * front-side pair while transparent (build's `sided`); Style 1 is opaque, 3 and 4 transparent, 2 or a masked
 * group alpha-tested. An opaque GPU-path group draws in its batch (batchMaterial) when `batched`, alone when it
 * is a pawn's weapon or the view model. With `mirrors`, a weapon's one-sided faces flip to BackSide in a
 * mirror's frame (applyPass). */
export function actorMeshWarmup({gpu=null,displayGamma,batched=false,mirrors=false,texture,geometry}){
  const objects=[],add=material=>objects.push(new THREE.Mesh(geometry,material));
  for(const gpuSlot of gpu?[true,false]:[false])for(const environmentGroup of gpuSlot?[false,true]:[false])
    for(const masked of [0,POLY.Masked])for(const twoSided of [0,POLY.TwoSided])for(const style of [1,3]){
      const flags=masked|twoSided,make=side=>{
        const modulatedUniform={value:0},material=groupMaterial({gpuSlot,gpu,displayGamma,cameraOn:{value:0},gpuUniform:{value:gpuSlot?1:0}},
          {texture,side,flags,environmentGroup,modulatedUniform});
        material.userData={flags,modulatedUniform};
        applyMaterialStyle(material,1,style);
        return material;
      };
      if(twoSided&&style===3){add(make(THREE.BackSide));add(make(THREE.FrontSide));continue;}
      const material=make(twoSided?THREE.DoubleSide:THREE.FrontSide);
      add(material);
      if(!twoSided&&mirrors)add(make(THREE.BackSide));
      if(gpuSlot&&batched&&style===1){
        material.userData.flags|=environmentGroup?POLY.Environment:0;
        add(batchMaterial(material,{value:null},gpu,displayGamma));
      }
    }
  return objects;
}

/** The CPU path's camera-space point of a corner (applyCamera), the same two names the GPU path's begin_vertex
 * (gpuBeginVertex) leaves for the projection patch. */
const CPU_CAMERA_DECLARATIONS='attribute vec3 deusCameraPoint;\nuniform float deusCameraOn;\n';
const CPU_CAMERA_BEGIN='vec3 deusCamera = deusCameraPoint;\nbool deusHasCamera = deusCameraOn > 0.5;';

/** The GPU draw path's begin_vertex (docs/gpu-mesh.md): the corner's
 * resolved wedge (the LOD's collapsed vertex and U/V bytes, or the corner's
 * own), its final-pose texel with the viewer reflection, its corner colour
 * and, for environment groups, the environment UV from the pass camera. A
 * face the LOD drops collapses to a point. `deusGpu` 0 keeps the CPU path's
 * attributes for an actor that fell back. */
function gpuBeginVertex(environment,fallback=false){
  return `vec3 transformed;
// The corner's point in the lighting frame's camera space (GetFrame's buffer), when its slot was lit in
// this pass's frame: what the original projects (frame-projection.mjs).
vec3 deusCamera = vec3( 0.0 );
bool deusHasCamera = false;
if (deusGpu > 0.5) {
  int deusC = int(deusCornerTexel);
  uint deusW = texelFetch(deusCornerWedges, ivec2(deusC & 1023, deusC >> 10), 0).x;
  bool deusDropped = deusW >= 0xfffffffeu;
  int deusV = int(deusVertexTexel) + (deusDropped ? 0 : int(deusW & 0xffffu));
  vec3 deusP = deusDropped ? vec3(0.0) : texelFetch(deusPose, ivec2(deusV & 1023, deusV >> 10), 0).xyz;
  transformed = vec3(deusP.y, deusP.z, -deusP.x);
  if (uFpOn > 0.5 && !deusDropped) {
    uvec2 deusMap = texelFetch(deusVertexMap, ivec2(deusV & 1023, deusV >> 10), 0).xy;
    if (deusMap.x != 0u) {
      uint deusStamp = texelFetch(deusParamsU, ivec2(2, int(deusMap.x - 1u)), 0).w;
      if (deusStamp == deusLitFrame || deusStamp > deusLitRuns) {
        deusCamera = texelFetch(deusCameraFinal, ivec2(deusV & 1023, deusV >> 10), 0).xyz;
        deusHasCamera = true;
      }
    }
  }
  uvec4 deusBytes = texelFetch(deusCorners, ivec2(deusC & 1023, deusC >> 10), 0);
  vDeusLight = vec3(texelFetch(deusByteColors, ivec2(int(deusBytes.x), 0), 0).x,
    texelFetch(deusByteColors, ivec2(int(deusBytes.y), 0), 0).x, texelFetch(deusByteColors, ivec2(int(deusBytes.z), 0), 0).x);
${environment?`  vec3 deusN = texelFetch(deusEnvironmentNormals, ivec2(deusV & 1023, deusV >> 10), 0).xyz;
  vMapUv = ( mapTransform * vec3( environmentUV(deusP, deusN, deusCameraHi, deusCameraLo), 1 ) ).xy;
`:`  vMapUv = ( mapTransform * vec3( float((deusW >> 16) & 255u) / 256.0, float(deusW >> 24) / 256.0, 1 ) ).xy;
`}} else {
  transformed = vec3( position );
  vDeusLight = deusLight;
${fallback?`  deusCamera = deusCameraPoint;
  deusHasCamera = deusCameraOn > 0.5;
`:''}}`;
}

/** A batch's material (actor-batches.mjs): the members' shared material state
 * with the GPU draw code, reading each vertex's member flag. */
function batchMaterial(template,members,gpu,displayGamma){
  const environment=Boolean(template.userData.flags&POLY.Environment);
  const material=new THREE.MeshBasicMaterial({map:template.map,side:template.side,alphaTest:template.alphaTest});
  material.color.copy(template.color);
  material.userData={...template.userData,members};
  material.customProgramCacheKey=()=>`deus-ex-mesh-gpu-batch-v2:${environment?1:0}:${FRAME_PROJECTION_KEY}`;
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
        REENCODE_GLSL+'\ngl_FragColor.rgb *= vDeusLight;\n'+
        `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
        `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
    frameProjection.patch(shader,{floatFloat:false,camera:true});
  };
  return material;
}
