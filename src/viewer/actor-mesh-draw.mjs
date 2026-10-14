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
import {TextureStore} from '../unreal/textures.mjs';
import {ActorMeshTextures} from './actor-mesh-textures.mjs';
import {POLY} from '../unreal/geometry.mjs';
import {decodeLodMeshPayload} from '../runtime/lodmesh-payload.mjs';
import {readLodMeshSurfaces} from '../runtime/lodmesh-materials.mjs';
import {displayRampGlsl} from './light-atlas.mjs';
import {meshVertexNormalsInto,writeMeshEnvironmentUV} from '../runtime/mesh-environment.mjs';
import {copyMeshLightColors} from './mesh-light-colors.mjs';
import {DRAW_VERTEX_DECLARATIONS} from './gpu-mesh.mjs';
import {frameProjection,FRAME_PROJECTION_KEY} from './frame-projection.mjs';
import {createActorBatches,BATCH_VERTEX_DECLARATIONS,BATCH_VERTEX_TAIL} from './actor-batches.mjs';
import {groupCorners,resolveMeshSkin} from './actor-mesh-skins.mjs';
import {copyPositions,lodCornerIndices,setMeshBounds} from './actor-mesh-sim.mjs';

/** The decoded mesh of a creation record, shared by its bindings. */
function meshSource(assets,cache,mesh) {
  let entry=cache.get(mesh.key);
  if(entry)return entry;
  const build=asset=>{
    const payload=decodeLodMeshPayload(asset.pkg,asset.bytes,mesh.index);
    const faces=readLodMeshSurfaces(payload),faceWords=new Uint32Array(faces.length*4);
    faces.forEach((face,i)=>faceWords.set([...face.vertices,face.flags>>>0],i*4));
    return {payload,faces,faceWords,asset};
  };
  const loaded=assets.loaded?.(mesh.package);
  entry=loaded?{ready:build(loaded)}:{pending:assets.get(mesh.package).then(asset=>(entry.ready=build(asset)))};
  cache.set(mesh.key,entry);
  return entry;
}

/** One binding's three.js objects and GPU slot. `rendered(renderer)` is its
 * actor's render feedback. */
export function createMeshDraw(assets,creation,{gpu=null,texturePool,batches=null,displayGamma={value:1},rendered,
  meshes,onError=()=>{}}) {
  const {id,actorName,groups:groupRecords}=creation;
  const root=new THREE.Group(),materials=[],textureLeases=[],groups=[];root.matrixAutoUpdate=false;
  root.name=`${actorName} authored mesh inspection`;root.visible=false;
  let mode=creation.path,gpuHandle=null,bases=null,source=null,ready=false,disposed=false,points=null,normals=null,faceIndices=null;
  let lastStyle,lastGlow,materialStateApplied=false;
  const gpuUniform={value:mode==='gpu'?1:0};
  // CPU path: 1 while the geometry's `deusCameraPoint` attribute holds the camera-space points of the state
  // shown (applyCamera).
  const cameraOn={value:0};let cameraFor=null;
  // The latest record's state, applied when the meshes exist.
  const latest={visible:Boolean(creation.visible),childOnly:false,material:null,posed:creation.posed,colors:null,cameraPoints:null,groups:null,
    spheres:creation.spheres,lod:null};
  const pendingPlans=[];let pendingLod=null;
  // The main frame's lighting this frame (its packed words or plain record), kept
  // to give the actor its main lighting back after a child frame's pass
  // lit it with that frame's Coords and Mirror (applyPass).
  let mainLighting=null,variantLit=false;
  // The LOD state of the main frame (the GPU record's parameters, null at
  // full detail) and which child frame's state is on the slot or geometry
  // (docs/script-lodmesh-lod.md "Child frames"): the key of its GPU
  // parameters, or the CPU state shown.
  let mainLodParams=null,appliedLodKey=null,shown=latest,variantCpu=false;
  const lodKey=params=>`${params.count}:${params.start}:${params.active}:${params.morph}:${params.inverse}`;
  const fullLodParams=()=>({count:gpuHandle.mesh.lod.modelVerts,start:0,active:false,morph:false,inverse:0});
  function core(){
    if(disposed)return;
    const {payload,faces,faceWords}=source;
    if(creation.environment)faceIndices=Uint32Array.from(faces.flatMap(face=>face.vertices));
    if(mode==='gpu'){
      gpuHandle=gpu.allocate(payload,faceWords,{environment:creation.environment,key:creation.mesh.key});
      bases={vbase:gpuHandle.vbase,cbase:gpuHandle.cbase};
      if(creation.plan)gpu.setPose(gpuHandle,creation.plan);
      for(const plan of pendingPlans.splice(0))gpu.setPose(gpuHandle,plan);
      if(pendingLod){gpu.setLod(gpuHandle,pendingLod);mainLodParams=pendingLod;pendingLod=null;}
    }
  }
  const sourceEntry=meshSource(assets,meshes,creation.mesh);
  if(sourceEntry.ready){source=sourceEntry.ready;core();}
  const updateNormals=(state=latest)=>{
    if(!state.posed)return;
    points=state.posed;normals??=new Float32Array(points.length);
    // The LOD's admitted faces with their resolved corners.
    const resolved=state.lod?.resolved;
    meshVertexNormalsInto(points,resolved?Uint32Array.from(resolved.filter((v,i)=>resolved[i-i%3]>=0)):faceIndices,normals);
  };
  const dispose=()=>{
    if(disposed)return;disposed=true;
    root.traverse(object=>object.geometry?.dispose());
    for(const material of materials)material.dispose();
    for(const lease of textureLeases)lease.release();
    for(const group of groups)if(group.batchEntry){batches.remove(group.batchEntry);group.batchEntry=null;}
    if(gpuHandle)gpu.release(gpuHandle);
    root.removeFromParent();
  };
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
    if(want){group.batchEntry={key:want,group,rendered,visible:false};batches.add(want,group.material,group.batchEntry);
      group.mesh.visible=false;}
  }
  function hideBatched(){for(const group of groups)if(group.batchEntry)batches.set(group.batchEntry,false);}
  const setSpheres=words=>{
    if(!words)return;
    groups.forEach((group,i)=>{const at=i*4;group.geometry.boundingSphere.center.set(words[at],words[at+1],words[at+2]);
      group.geometry.boundingSphere.radius=words[at+3];});
  };
  // The drawn corners: GetFrame's (or the LOD's morphed) positions at each
  // corner's vertex, the LOD's resolved one (actor-mesh-sim.mjs
  // lodCornerIndices); a group the LOD empties is not drawn.
  const cpuPositions=(state=latest)=>{
    const resolved=state.lod?.resolved??null;
    shown=state;
    for(const group of groups){
      const positions=group.geometry.getAttribute('position');
      const indices=resolved?lodCornerIndices(group.faces,group.indices,resolved,group):group.indices;
      if(!resolved)group.lodEmpty=false;
      group.cornerIndices=indices;
      copyPositions(state.posed,positions.array,indices);positions.needsUpdate=true;
      setMeshBounds(group.geometry,positions.array);
      if(mode==='cpu'){group.mesh.visible=!group.lodEmpty;if(group.twin)group.twin.visible=!group.lodEmpty&&group.split;}
    }
    cameraOn.value=cameraFor===shown?1:0;
    if(creation.environment)updateNormals(state);
  };
  // The corners' U and V bytes: the LOD's packed wedge dwords, or the faces'.
  const lodUVs=(state=latest)=>{
    const scratch=state.lod?.scratch??null,{faces}=source;
    for(const group of groups){
      if(group.environment)continue;
      const uv=group.geometry.getAttribute('uv');
      let at=0;
      for(const faceIndex of group.faces){
        const face=faces[faceIndex];
        for(const corner of [0,2,1]){
          if(scratch){const word=scratch[face.wedges[corner]];uv.array[at]=((word>>>16)&255)/256;uv.array[at+1]=(word>>>24)/256;}
          else{uv.array[at]=face.uv[corner][0]/256;uv.array[at+1]=face.uv[corner][1]/256;}
          at+=2;
        }
      }
      uv.needsUpdate=true;
    }
  };
  const applyColors=colors=>{
    const words=new Uint32Array(colors.buffer,colors.byteOffset,colors.length);
    for(const group of groups)if(copyMeshLightColors(group.lightWords,words,group.faces))
      group.geometry.getAttribute('deusLight').needsUpdate=true;
  };
  /** CPU path: the camera-space points the original projects (docs/frame-projection.md "Meshes"). `cameraPoints`
   * is GetFrame's buffer for the frame whose colours were just applied, after that frame's LOD morph
   * (actor-mesh-sim.mjs relight): its corners go to the groups' `deusCameraPoint` attribute, in the order of
   * the state shown. Null (the frame did not light the actor): the world pose projects instead. */
  const applyCamera=cameraPoints=>{
    if(mode!=='cpu')return;
    cameraFor=null;
    if(cameraPoints){
      for(const group of groups){
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
      cameraFor=shown;
    }
    cameraOn.value=cameraFor===shown?1:0;
  };
  const applyMaterial=({glow,style})=>{
    if(materialStateApplied&&Object.is(glow,lastGlow)&&Object.is(style,lastStyle))return;
    for(const material of materials){
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
    for(const group of groups){
      rebatch(group);
      if(!group.sided)continue;
      group.split=group.sided.double.transparent;
      group.mesh.material=group.split?group.sided.back:group.sided.double;
      if(!group.batchEntry)showGroup(group,group.mesh.visible);
    }
    lastGlow=glow;lastStyle=style;materialStateApplied=true;
  };
  /** Leave the GPU path for good: the posed vertices from the record and
   * the CPU path's attributes. */
  function toCpu(){
    if(mode!=='gpu')return;
    mode='cpu';gpuUniform.value=0;
    if(ready){
      cpuPositions();
      for(const group of groups){
        if(group.batchEntry){batches.remove(group.batchEntry);group.batchEntry=null;}
        group.mesh.frustumCulled=true;if(group.twin)group.twin.frustumCulled=true;showGroup(group,true);
      }
    }
    if(gpuHandle){gpu.release(gpuHandle);gpuHandle=null;}
  }
  const updateView=cameraPosition=>{
    if(disposed||!ready||!root.visible||!creation.environment||!cameraPosition||mode!=='cpu'||!points)return false;
    const relative=[0,0,0],normal=[0,0,0];
    for(const group of groups)if(group.flags&POLY.Environment){
      const uv=group.geometry.getAttribute('uv'),indices=shown.lod?.resolved&&group.lodIndices?group.lodIndices:group.indices;
      for(let i=0;i<indices.length;i++){
        const at=indices[i]*3;
        relative[0]=Math.fround(points[at]-cameraPosition[0]);relative[1]=Math.fround(points[at+1]-cameraPosition[1]);
        relative[2]=Math.fround(points[at+2]-cameraPosition[2]);
        normal[0]=normals[at];normal[1]=normals[at+1];normal[2]=normals[at+2];
        writeMeshEnvironmentUV(uv.array,i*2,relative,normal);
      }
      uv.needsUpdate=true;
    }
    return true;
  };
  /** The meshes and materials (the creation's skins decode here). */
  async function build(){
    const {asset,faces}=source;
    const textures=new TextureStore(assets);
    for(const record of groupRecords){
      const {indices,uvs,corners}=groupCorners(faces,record);
      const reference=record.texture,skinAsset=reference.package===asset.name?asset:await assets.get(reference.package);
      const {data,flags}=await resolveMeshSkin(textures,skinAsset,reference.index,record.flags);
      // Keep the original private decoder/await sequence: only the GPU
      // resource is shared, synchronously, at its former allocation point.
      const textureLease=texturePool.acquire(data,flags);textureLeases.push(textureLease);
      const texture=textureLease.texture,first=data.mips[0],key=record.key;
      // Keep texture sampling and recovered vertex lighting in the same
      // display-encoded space for the main framebuffer and mirror target.
      // D3D modulates the display-encoded texel by the vertex diffuse
      // (docs/mesh-lighting.md), before the display gamma ramp; the world
      // shader treats light maps the same way. Style can switch a material
      // to PF_Modulated at run time, so the modulated display ramp
      // (displayRampGlsl) is a uniform branch.
      const modulatedUniform={value:!(flags&POLY.Translucent)&&flags&POLY.Modulated?1:0};
      const environmentGroup=Boolean(record.flags&POLY.Environment),gpuSlot=creation.path==='gpu';
      const makeMaterial=side=>{
        const material=new THREE.MeshBasicMaterial({map:texture,side,alphaTest:flags&POLY.Masked?.5:0});
        material.customProgramCacheKey=gpuSlot?()=>`deus-ex-mesh-gpu-v3:${environmentGroup?1:0}:${FRAME_PROJECTION_KEY}`
          :()=>`deus-ex-mesh-display-color-v4:${FRAME_PROJECTION_KEY}`;
        material.onBeforeCompile=shader=>{
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
              'gl_FragColor = sRGBTransferOETF(gl_FragColor);\ngl_FragColor.rgb *= vDeusLight;\n'+
              `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
              `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
          // The original's vertex projection (docs/frame-projection.md): both paths project the lighting
          // frame's camera-space buffer (a GPU slot's texture, or the CPU path's attribute once it left the slot).
          frameProjection.patch(shader,{floatFloat:!gpuSlot,camera:true});
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
      const positions=new Float32Array(indices.length*3);
      if(creation.path==='cpu')copyPositions(latest.posed,positions,indices);
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      const lightColors=new Float32Array(indices.length*3).fill(1);
      const group={key,flags:record.flags,indices,faces:record.faces,lightWords:new Uint32Array(lightColors.buffer),
        environment:environmentGroup,batchEntry:null,split:false};
      geometry.setAttribute('deusLight',new THREE.BufferAttribute(lightColors,3).setUsage(THREE.DynamicDrawUsage));
      if(gpuSlot){
        // The slot's first ordinary vertex texel: each corner adds its
        // resolved wedge's vertex (gpuBeginVertex).
        const ordinaryTexel=bases.vbase+(source.payload.scalarBits.get(0x184)|0);
        geometry.setAttribute('deusVertexTexel',new THREE.BufferAttribute(new Float32Array(indices.length).fill(ordinaryTexel),1));
        geometry.setAttribute('deusCornerTexel',new THREE.BufferAttribute(
          Float32Array.from(corners,corner=>bases.cbase+corner),1));
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      group.geometry=geometry;
      const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;
      mesh.onAfterRender=rendered;
      if(gpuSlot)mesh.frustumCulled=false;
      Object.assign(group,{mesh,sided,material,texture});
      mesh.userData={actor:`${actorName} (mesh inspection)`,faces:record.faces};root.add(mesh);
      if(sided){
        // Created right after its mesh: the adjacent id keeps the pair
        // consecutive in three.js's transparent sort (equal depth).
        const twin=new THREE.Mesh(geometry,sided.front);twin.matrixAutoUpdate=false;
        twin.onAfterRender=rendered;twin.frustumCulled=mesh.frustumCulled;twin.visible=false;
        twin.userData={...mesh.userData,twinOf:mesh};group.twin=twin;root.add(twin);
      }
      groups.push(group);
    }
    if(disposed){dispose();return;}
    setSpheres(latest.spheres);
    if(mode==='cpu'){
      if(creation.environment)updateNormals();
      if(creation.path==='gpu')toCpuApplied();
    }
    ready=true;
    applyLatest();
  }
  // A binding that left the GPU path before its meshes existed.
  function toCpuApplied(){
    cpuPositions();
    for(const group of groups){group.mesh.frustumCulled=true;if(group.twin)group.twin.frustumCulled=true;showGroup(group,true);}
  }
  function applyLatest(){
    root.visible=latest.visible;
    if(!latest.visible){hideBatched();return;}
    if(latest.material)applyMaterial(latest.material);
    if(latest.lod)lodUVs();
    if(mode==='cpu'&&latest.posed)cpuPositions();
    if(mode==='gpu'&&latest.groups)groups.forEach((group,i)=>showGroup(group,Boolean(latest.groups[i])));
    if(latest.colors)applyColors(latest.colors);
    applyCamera(latest.cameraPoints);
    if(latest.childOnly){root.visible=false;hideBatched();}
  }
  const built=(sourceEntry.ready?Promise.resolve():sourceEntry.pending.then(asset=>{source=sourceEntry.ready;core();}))
    .then(build).catch(error=>{onError({actor:`${actorName}`,message:error.message});dispose();});
  return {id,root,built,get ready(){return ready;},get path(){return mode;},dispose,updateView,
    get viewDependent(){return creation.environment&&mode==='cpu';},
    /** Validation access (main.mjs meshLod): the faces this binding's
     * geometry draws under the LOD and their distinct vertices, the groups
     * the LOD empties and whether the root is shown. */
    lodStats(){
      if(mode==='gpu'&&gpuHandle&&source){
        // The GPU path: the corner pass's resolved dwords for this slot.
        const words=gpu.read('cornerWedges',gpuHandle.cbase,gpuHandle.mesh.F*3);
        let faces=0,dropped=0;const vertices=new Set();
        for(let i=0;i<words.length;i+=3){
          if(words[i]>=0xfffffffe){dropped++;continue;}
          faces++;for(let k=0;k<3;k++)vertices.add(words[i+k]&0xffff);
        }
        return {id,path:mode,ready,visible:root.visible,lod:dropped?{faces,vertices:vertices.size,
          emptyGroups:null}:null,gpuFaces:faces,gpuVertices:vertices.size,faces:source.faces.length};
      }
      const resolved=shown.lod?.resolved??null;
      let faces=0;const vertices=new Set();
      if(resolved)for(let i=0;i<resolved.length;i+=3){if(resolved[i]<0)continue;faces++;vertices.add(resolved[i]).add(resolved[i+1]).add(resolved[i+2]);}
      return {id,path:mode,ready,visible:root.visible,lod:resolved?{count:shown.lod.count,faces,vertices:vertices.size,
        emptyGroups:groups.filter(group=>group.lodEmpty).length}:null,
        faces:source?.faces.length??null};
    },
    /** Validation access: the GPU slot and the decoded faces. */
    get gpuHandle(){return gpuHandle;},get groups(){return groups;},get source(){return source;},
    /** One main-frame record (actor-mesh-sim.mjs update); `words` is the
     * frame's packed plans and lighting ({u32, f32}, mesh-frame-pack.mjs)
     * when the record holds offsets into them. */
    apply(record,cameraPosition,words=null){
      if(disposed)return false;
      const plan=typeof record.plan==='number'?{...words,at:record.plan}:record.plan;
      const lighting=typeof record.lighting==='number'?{...words,at:record.lighting}:record.lighting;
      latest.visible=record.visible;latest.childOnly=record.childOnly;
      if(record.material)latest.material=record.material;
      if(record.posed)latest.posed=record.posed;
      if(record.groups)latest.groups=record.groups;
      if(record.spheres)latest.spheres=record.spheres;
      if(record.colors)latest.colors=record.colors;
      latest.cameraPoints=record.cameraPoints??null;
      const lodChanged=record.lod!==undefined;
      if(lodChanged)latest.lod=record.lod.resolved?record.lod:null;
      if(plan&&mode==='gpu'&&!record.toCpu){if(gpuHandle)gpu.setPose(gpuHandle,plan);else if(!source)pendingPlans.push(plan);}
      if(record.lodParams&&mode==='gpu'&&!record.toCpu){
        mainLodParams=record.lodParams;
        if(gpuHandle)gpu.setLod(gpuHandle,record.lodParams);else if(!source)pendingLod=record.lodParams;
      }else if(appliedLodKey!==null&&mode==='gpu'&&gpuHandle){
        // A child frame's LOD state is still on the slot (its restoring pass
        // did not run): the main frame's again, redone by this frame's run.
        gpu.setLod(gpuHandle,mainLodParams??fullLodParams());
      }
      appliedLodKey=null;
      if(record.toCpu)toCpu();
      if(lighting&&gpuHandle&&!gpu.setLighting(gpuHandle,lighting))
        throw new Error(`${actorName}: the GPU mesh lights differ from the simulation side's layout`);
      mainLighting=lighting??null;variantLit=false;
      if(!ready)return false;
      root.visible=record.visible;
      if(!record.visible){hideBatched();return false;}
      if(record.material)applyMaterial(record.material);
      if(lodChanged)lodUVs();
      if(record.posed&&mode==='cpu')cpuPositions();
      else if(variantCpu&&mode==='cpu'&&latest.posed){cpuPositions();lodUVs();}
      variantCpu=false;
      if(record.spheres)setSpheres(record.spheres);
      if(mode==='gpu'&&latest.groups)groups.forEach((group,i)=>showGroup(group,Boolean(latest.groups[i])));
      const environmentUpload=updateView(cameraPosition);
      if(record.colors)applyColors(record.colors);
      applyCamera(latest.cameraPoints);
      // Hidden from the main pass until a child pass shows it.
      if(record.childOnly){root.visible=false;hideBatched();}
      return Boolean(record.changed)||environmentUpload;
    },
    /** A pass's decision (actor-mesh-sim.mjs passVisibility, framePass).
     * A child frame's decision (`frame`) carries the lighting that frame's
     * DrawFrame gave the actor (Coords, Mirror, LeafLights): the GPU path
     * queues it for the pass's lighting run (returns true), the CPU path
     * takes its corner colours now. The main frame's decision after it
     * restores the actor's own lighting. */
    applyPass(decision){
      if(!ready||!decision)return false;
      root.visible=decision.root;
      if(!decision.root){hideBatched();return false;}
      if(decision.spheres)setSpheres(decision.spheres);
      if(decision.groups)groups.forEach((group,i)=>showGroup(group,Boolean(decision.groups[i])));
      let queued=false;
      // The LOD state of this pass: the child frame's own when it differs
      // from the base's (`lodParams` on the GPU path, `cpuState` on the CPU
      // path), else the main frame's.
      let lodChanged=false;
      if(mode==='gpu'&&gpuHandle){
        const want=decision.lodParams??null,key=want?lodKey(want):null;
        if(key!==appliedLodKey){gpu.setLod(gpuHandle,want??mainLodParams??fullLodParams());appliedLodKey=key;lodChanged=queued=true;}
      }else if(mode==='cpu'&&latest.posed){
        if(decision.cpuState){cpuPositions(decision.cpuState);lodUVs(decision.cpuState);variantCpu=true;}
        else if(variantCpu){cpuPositions();lodUVs();variantCpu=false;}
      }
      if(decision.frame!==undefined&&(decision.lighting||decision.colors)){
        if(decision.lighting&&mode==='gpu'&&gpuHandle){
          if(!gpu.setLighting(gpuHandle,decision.lighting))
            throw new Error(`${actorName}: the GPU mesh lights differ from the simulation side's layout`);
          queued=variantLit=true;
        }else if(decision.colors){applyColors(decision.colors);applyCamera(decision.cameraPoints??null);variantLit=true;}
      }else if(variantLit||lodChanged){
        // The main frame's lighting again, also under a LOD state that changed.
        if(mode==='gpu'&&mainLighting&&gpuHandle){
          if(!gpu.setLighting(gpuHandle,mainLighting))throw new Error(`${actorName}: the GPU mesh lights differ from the simulation side's layout`);
          queued=true;
        }else if(latest.colors){applyColors(latest.colors);applyCamera(latest.cameraPoints);}
        variantLit=false;
      }
      return queued;
    }};
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
  let mainCamera=null,passProbe=null,passCount=0;
  return {root,bindings,errors,batches,textures,
    /** Validation only: with `on`, every pass records what each binding it
     * draws has on the slot or geometry once the pass's lighting run is done
     * (lodStats), tagged with the pass's number and the decision's frame;
     * `takePassProbe` returns and clears the records. */
    setPassProbe(on){passProbe=on?[]:null;},
    takePassProbe(){const records=passProbe;if(passProbe)passProbe=[];return records;},
    /** A binding's creation record: its GPU slot now, its meshes when built. */
    create(creation){
      const draw=createMeshDraw(assets,creation,{gpu,texturePool:textures,batches,displayGamma,
        rendered:feedback(creation.handle),meshes,onError:error=>errors.push(error)});
      bindings.set(creation.id,draw);
      draw.built.then(()=>{if(bindings.get(creation.id)===draw&&draw.ready)root.add(draw.root);});
      return draw;
    },
    release(id){bindings.get(id)?.dispose();bindings.delete(id);},
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
        'gl_FragColor = sRGBTransferOETF(gl_FragColor);\ngl_FragColor.rgb *= vDeusLight;\n'+
        `if (deusModulated > 0.5) { ${displayRampGlsl('deusDisplayGamma',true)} }\n`+
        `else { ${displayRampGlsl('deusDisplayGamma',false)} }`);
    frameProjection.patch(shader,{floatFloat:false,camera:true});
  };
  return material;
}
