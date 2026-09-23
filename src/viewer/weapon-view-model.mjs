import * as THREE from 'three';
import {refValue} from '../runtime/script-vm.mjs';
import {fromView} from '../unreal/geometry.mjs';
import {createActorMeshPreview} from './npc-mesh-preview.mjs';

/** Original Weapon.RenderOverlays -> DeusExWeapon.CalcDrawOffset ->
 * Canvas.DrawActor. The script owns placement and animation; this adapter owns
 * only the Canvas draw submission and decoded GPU resources. No fire/state
 * scheduler entry is made here. Evidence: docs/script-weapon-rendering.md. */
export async function createWeaponViewModel(runtime,assets,player,{kernel=null}={}) {
  const engine=await assets.get('Engine');
  const canvasClass=await runtime.loadClass(engine,engine.exportsByPath.get('canvas'));
  // A typed external Canvas boundary, not a fabricated native UCanvas instance.
  const canvas={kind:'Canvas',key:'viewer.weapon.canvas',name:'WeaponCanvas'};
  runtime.attach(canvas,canvasClass);
  const read=(actor,name)=>runtime.namedReference(actor,name).get();
  const scene=new THREE.Scene(),entries=new Map(),pending=new Map();
  const summary={actor:null,mesh:null,loading:false,draws:0,shading:'texture-only inspection'};
  let disposed=false,error=null,index=0x50000000;
  const prepare=actor=>{
    const mesh=read(actor,'Mesh');
    let entry=entries.get(actor);
    if(entry?.mesh===mesh)return entry;
    if(entry){scene.remove(entry.preview.root);entry.preview.dispose();entries.delete(actor);}
    if(pending.has(actor))return null;
    const task=createActorMeshPreview(runtime,assets,actor,{originalObjectIndex:index++,kernel,drawActor:true})
      .then(preview=>{
        if(disposed||read(actor,'Mesh')!==mesh||read(actor,'bDeleteMe')){preview.dispose();return;}
        entries.set(actor,{mesh,preview});scene.add(preview.root);
      }).catch(cause=>{error=cause;}).finally(()=>pending.delete(actor));
    pending.set(actor,task);return null;
  };
  const commands=()=>{
    const actor=read(player,'Weapon');
    summary.actor=actor?.name??null;summary.mesh=actor?read(actor,'Mesh')?.key??null:null;
    if(!actor||read(actor,'bDeleteMe'))return [];
    const calls=[],previous=runtime.native,wasBoundary=runtime.boundaryNatives.has(467);
    runtime.boundaryNatives.add(467);
    runtime.native=call=>{
      if(call.index!==467)return previous(call);
      if(call.receiver!==canvas)throw new Error('Weapon overlay received an unrelated Canvas.DrawActor');
      const args=Array.from({length:call.argumentCount},(_,i)=>refValue(call.evaluateArgument(i)));
      if(args[0]!==actor)throw new Error('Weapon overlay draws an actor other than its weapon');
      calls.push({actor:args[0],wireframe:Boolean(args[1]),clearZ:Boolean(args[2])});
    };
    try {
      const record=runtime.lookup(actor,'RenderOverlays');
      runtime.callFunction(record,actor,1,()=>canvas);
    } finally {
      runtime.native=previous;if(!wasBoundary)runtime.boundaryNatives.delete(467);
    }
    return calls;
  };
  return {scene,summary,
    // The asynchronous phase only decodes resources. It does not dispatch the
    // script event or advance an actor; render() is the sole draw event source.
    async ready(){
      const actor=read(player,'Weapon');if(actor)prepare(actor);
      await Promise.all(pending.values());if(error)throw error;
    },
    render(renderer,camera){
      if(disposed)return;
      if(error)throw error;
      for(const {preview} of entries.values())preview.root.visible=false;
      for(const [actor,entry] of entries)if(read(actor,'bDeleteMe')||!runtime.levelFor(player).actors.includes(actor)){
        scene.remove(entry.preview.root);entry.preview.dispose();entries.delete(actor);
      }
      summary.draws=0;
      for(const command of commands()){
        const entry=prepare(command.actor);if(!entry)continue;
        entry.preview.update(fromView(camera.position.toArray()));
        for(const mesh of entry.preview.root.children)mesh.material.wireframe=command.wireframe;
        // ClearZ is omitted by Weapon.RenderOverlays, whose default is false.
        if(command.clearZ)renderer.clearDepth();
        renderer.render(scene,camera);summary.draws++;
      }
      summary.loading=pending.size>0;
    },
    dispose(){disposed=true;for(const {preview} of entries.values())preview.dispose();entries.clear();},
  };
}
