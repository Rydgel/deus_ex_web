/** Play's actor mesh layer as one object per use: the simulation side
 * (actor-mesh-sim.mjs, every read and decision) and the page side
 * (actor-mesh-draw.mjs, the three.js objects and GPU slots) run one after the
 * other in this thread, joined by their plain records (docs/sim-worker.md
 * step 4). Contracts and captured cache identity: docs/npc-mesh-preview.md;
 * lighting: docs/mesh-lighting.md; GPU path: docs/gpu-mesh.md. */
import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {ActorMeshTextures} from './actor-mesh-textures.mjs';
import {loadLodMeshKernel} from '../runtime/lodmesh-wasm.mjs';
import {actorRenderFeedback} from './actor-render-feedback.mjs';
import {identityOfHandle} from '../runtime/script-object-handles.mjs';
import {createGpuMeshLayout} from './gpu-mesh-layout.mjs';
import {createActorMeshSim,createMeshBinding} from './actor-mesh-sim.mjs';
import {createActorMeshDraw,createMeshDraw} from './actor-mesh-draw.mjs';

export {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';
import {TRAINING_NPC_IDENTITIES} from '../runtime/training-npc-identities.mjs';

const hiddenRoot=new THREE.Group();hiddenRoot.visible=false;
/** One binding as the earlier previews showed it: its simulation-side
 * state and its page-side root and GPU slot. */
function bindingView(binding,drawOf,draw=null){
  return {
    get actor(){return binding.actor;},get summary(){return binding.summary;},get path(){return binding.path;},
    get mesh(){return binding.mesh;},get block(){return binding.block;},
    get root(){return drawOf(binding.id)?.root??hiddenRoot;},
    get location(){return binding.location;},get rotation(){return binding.rotation;},
    /** Validation access (scripts/validate-gpu-mesh.mjs): the simulation
     * side's plan, lighting and CPU shadow with the page's GPU slot. */
    gpuState(){return {...binding.gpuState(),handle:drawOf(binding.id)?.gpuHandle??null};},
    /** This binding alone for one frame (no GPU passes), as the earlier
     * per-actor update: true when a buffer was re-uploaded. */
    update(cameraPosition,view={}){
      const record=binding.update(view),target=draw??drawOf(binding.id);
      return record&&target?target.apply(record,cameraPosition):false;
    },
    dispose(){binding.dispose();drawOf(binding.id)?.dispose();},
  };
}

/** Live NPC mesh bindings for the captured Training identities: update()
 * resamples GetFrame whenever the shared runtime's pose fields change. */
export async function createTrainingNpcPreview(runtime,assets,asset,{kernel,lighting=null,displayGamma,gpu=null}={}) {
  if(asset.name.toLowerCase()!=='00_training')throw new Error('NPC preview requires Training');
  let kernelError=null;
  if(kernel===undefined) {
    try{kernel=await loadLodMeshKernel();}
    catch(error){kernel=null;kernelError=error.message;}
  }
  const draw=createActorMeshDraw(assets,{gpu,lit:Boolean(lighting),displayGamma,
    feedback:handle=>actorRenderFeedback(runtime,identityOfHandle(handle))});
  const layout=gpu?createGpuMeshLayout(gpu.capacities):null,textures=new TextureStore(assets);
  const bindings=[],errors=[];
  let id=1;
  for(const [name,originalObjectIndex] of Object.entries(TRAINING_NPC_IDENTITIES)) {
    try {
      const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(name.toLowerCase()));
      if(runtime.readNamed(actor,'bHidden'))continue;
      const binding=await createMeshBinding(runtime,actor,{id:id++,originalObjectIndex,kernel,lighting,layout,textures});
      draw.create(binding.creation);bindings.push(binding);
    } catch(error) {errors.push({actor:name,message:error.message});}
  }
  if(!bindings.length){draw.dispose();throw new Error(errors.map(e=>`${e.actor}: ${e.message}`).join('; '));}
  await draw.ready();
  for(const error of draw.errors)errors.push(error);
  const drawOf=id=>draw.bindings.get(id);
  for(const binding of bindings){const root=drawOf(binding.id)?.root;if(root)root.visible=true;}
  const actors=bindings.map(binding=>bindingView(binding,drawOf));
  return {root:draw.root,actors,update(cameraPosition,view={}){for(const actor of actors)actor.update(cameraPosition,view);},
    dispose(){for(const binding of bindings)binding.dispose();draw.dispose();},
    summary:{actors:bindings.map(binding=>binding.summary),errors,poseBackend:kernel?.name??'javascript',kernelError,
      triangles:bindings.reduce((total,binding)=>total+binding.summary.triangles,0),
      shading:lighting?'original mesh lighting':'texture-only inspection',startup:'original'}};
}

/** Whole-level actor mesh layer for Play: the captured NPC bindings plus
 * every other visible LodMesh actor (actor-mesh-sim.mjs createActorMeshSim)
 * drawn by actor-mesh-draw.mjs. `player` is the player actor or a getter for
 * it. With `gpu`, the simulation side keeps its own GPU mesh layout with the
 * page's capacities. Play builds the two halves itself (sim-host.mjs,
 * main.mjs); this wrapper keeps them in one object for the validators. */
export async function createActorMeshScene(runtime,assets,asset,{kernel,player,lighting=null,displayGamma,gpu=null,childFrames=false,
  feedback=handle=>actorRenderFeedback(runtime,identityOfHandle(handle))}={}) {
  const draw=createActorMeshDraw(assets,{gpu,lit:Boolean(lighting),displayGamma,feedback});
  const sim=await createActorMeshSim(runtime,assets,asset,{kernel,player,lighting,childFrames,
    layout:gpu?createGpuMeshLayout(gpu.capacities):null,
    onCreate:creation=>draw.create(creation),onRelease:id=>draw.release(id)});
  await draw.ready();
  const drawOf=id=>draw.bindings.get(id),views=new WeakMap();
  const view=binding=>{let value=views.get(binding);if(!value)views.set(binding,value=bindingView(binding,drawOf));return value;};
  let mainCamera=null;
  const passFrustum=new THREE.Frustum(),passMatrix=new THREE.Matrix4();
  return {root:draw.root,sim,draw,kernel:sim.kernel,summary:sim.summary,
    get actors(){return sim.actors.map(view);},get npcActors(){return sim.npcActors.map(view);},
    get propActors(){return sim.propActors.map(view);},
    /** `view.lit` marks the main viewport frame, whose drawn actors get one
     * SetupForActor/Light pass each; mirror frames reuse those colours. */
    update(cameraPosition,frameView={}){
      mainCamera=frameView.camera??null;
      return draw.apply(sim.update(frameView),cameraPosition);
    },
    /** A mirror child pass (`camera`, the pass camera; the main camera
     * again after the passes): each binding's decision, then the
     * camera-relative environment UVs. */
    updateView(cameraPosition,camera=null){
      let decisions=new Map();
      if(camera){
        let frustum=null;
        if(camera!==mainCamera){
          passFrustum.setFromProjectionMatrix(passMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),
            THREE.WebGLCoordinateSystem,camera.reversedDepth);
          frustum=passFrustum;
        }
        decisions=sim.passVisibility(frustum);
      }
      draw.pass(decisions,cameraPosition);
    },
    /** Iterator item bindings in use (validation access). */
    itemStats:()=>sim.itemSlots().map(({actor,ids})=>({actor,slots:ids.length,
      drawn:ids.filter(id=>id!==null&&drawOf(id)?.root.visible).length})),
    async ready(){await sim.ready();await draw.ready();},
    batchStats:()=>draw.batchStats(),
    proceduralTextures:()=>draw.proceduralTextures(),
    dispose(){sim.dispose();draw.dispose();},
  };
}

/** One actor's mesh, outside the level layer (the weapon view model,
 * validators): a single binding and its page side. */
export async function createActorMeshPreview(runtime,assets,actor,{originalObjectIndex,kernel=null,drawActor=false,visible=null,
  childVisible=null,lighting=null,displayGamma={value:1},texturePool=null,gpu=null,batches=null,reads=false}) {
  const binding=await createMeshBinding(runtime,actor,{id:1,originalObjectIndex,kernel,drawActor,visible,childVisible,lighting,
    layout:gpu?createGpuMeshLayout(gpu.capacities):null,reads,textures:new TextureStore(assets)});
  const pool=texturePool??new ActorMeshTextures();
  const draw=createMeshDraw(assets,binding.creation,{gpu,texturePool:pool,batches,displayGamma,
    rendered:actorRenderFeedback(runtime,actor),meshes:new Map(),onError:error=>{throw new Error(error.message);}});
  const fail=()=>{binding.dispose();draw.dispose();if(!texturePool)pool.dispose();};
  try{await draw.built;}catch(error){fail();throw error;}
  if(!draw.ready){fail();throw new Error(`${binding.summary.actor} has no renderable faces`);}
  const result=bindingView(binding,()=>draw,draw);
  Object.defineProperty(result,'viewDependent',{get:()=>draw.viewDependent});
  result.updateView=cameraPosition=>draw.updateView(cameraPosition);
  result.dispose=fail;
  return result;
}
