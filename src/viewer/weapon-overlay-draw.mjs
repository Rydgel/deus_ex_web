import * as THREE from 'three';
import {ActorMeshTextures} from './actor-mesh-textures.mjs';
import {createMeshDraw} from './actor-mesh-draw.mjs';

/** The page side of the player's view model (docs/sim-worker.md step 6):
 * the three.js objects and GPU slots of the bindings weapon-overlay-sim.mjs
 * creates, and the overlay draw of each frame record: one depth clear when
 * the frame has a target (Render.dll's RenDev->ClearZ before
 * RenderOverlays), then each Canvas.DrawActor submission with the world
 * frame's camera, after its optional ClearZ. `gpu` is the view model's own
 * GPU mesh instance (gpu-mesh.mjs), whose passes run once per frame record;
 * `feedback(handle)` is a mesh's draw callback (?simVerify records). */
export function createWeaponOverlayDraw(assets,{gpu=null,displayGamma,feedback=()=>()=>{}}) {
  const scene=new THREE.Scene(),draws=new Map(),meshes=new Map(),texturePool=new ActorMeshTextures(),errors=[];
  // Each submission's visibility after its records and decision; each
  // binding's actor handle.
  const shown=new Map(),handles=new Map();
  return {scene,draws,errors,
    create(creation){
      const draw=createMeshDraw(assets,creation,{gpu,texturePool,displayGamma,rendered:feedback(creation.handle),meshes,
        onError:error=>errors.push(error)});
      draws.set(creation.id,draw);handles.set(creation.id,creation.handle);
      draw.built.then(()=>{if(draws.get(creation.id)===draw&&draw.ready)scene.add(draw.root);});
      return draw;
    },
    release(id){draws.get(id)?.dispose();draws.delete(id);handles.delete(id);},
    /** Whether a binding of this actor handle has its meshes (?simVerify). */
    built:handle=>[...handles].some(([id,value])=>value===handle&&draws.get(id)?.ready),
    /** A frame record's state before any draw: the records and decisions
     * in submission order, then the GPU passes. `cameraPosition` is the
     * render camera in original coordinates (environment UVs); `words` the
     * frame's packed plans and lighting (mesh-frame-pack.mjs). */
    prepare(frame,cameraPosition,words=null){
      if(errors.length)throw new Error(`${errors[0].actor}: ${errors[0].message}`);
      shown.clear();
      if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
      for(const {id,record,decision,wireframe} of frame.draws){
        const draw=draws.get(id);
        if(!draw)continue;
        draw.apply(record,cameraPosition,words);
        if(decision)draw.applyPass(decision);
        if(draw.ready)for(const mesh of draw.root.children)mesh.material.wireframe=wireframe;
        shown.set(id,draw.root.visible);
      }
      if(gpu){if(frame.camera)gpu.setCamera(frame.camera.origin,frame.camera.axes);gpu.run();}
    },
    /** The overlay draw (prepare first); returns the submissions drawn. */
    render(renderer,camera,frame){
      for(const draw of draws.values())draw.root.visible=false;
      if(!frame?.target)return 0;
      renderer.clearDepth();
      let count=0;
      for(const {id,clearZ} of frame.draws){
        const draw=draws.get(id);
        if(!draw?.ready)continue;
        for(const other of draws.values())other.root.visible=false;
        draw.root.visible=shown.get(id)??false;
        // Canvas.DrawActor's optional ClearZ (default false, 0x10377f3c).
        if(clearZ)renderer.clearDepth();
        renderer.render(scene,camera);count++;
      }
      return count;
    },
    /** One GC.DrawActor mesh draw from the HUD paint (docs/gc-draw-actor.md), in window order between the tile batches: the
     * submission's record and pass decision applied now (the actor's state is the one XGC::DrawActor set when the simulation
     * side planned it), then drawn in the master camera over the depth buffer the overlay pass left. Returns whether it drew. */
    hudActor(renderer,camera,plan,cameraPosition,words=null){
      const draw=plan?draws.get(plan.id):null;
      if(!draw?.ready||!plan.record)return 0;
      if(gpu&&cameraPosition)gpu.setViewCamera(cameraPosition);
      draw.apply(plan.record,cameraPosition,words);
      if(plan.decision)draw.applyPass(plan.decision);
      for(const other of draws.values())other.root.visible=false;
      draw.root.visible=plan.record.visible!==false;
      for(const mesh of draw.root.children)if(mesh.material)mesh.material.wireframe=false;
      renderer.render(scene,camera);
      draw.root.visible=false;
      return 1;
    },
    async ready(){await Promise.all([...draws.values()].map(draw=>draw.built));},
    dispose(){for(const draw of draws.values())draw.dispose();draws.clear();texturePool.dispose();},
  };
}
