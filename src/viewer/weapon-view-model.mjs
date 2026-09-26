import * as THREE from 'three';
import {refValue} from '../runtime/script-vm.mjs';
import {fromView} from '../unreal/geometry.mjs';
import {createActorMeshPreview} from './npc-mesh-preview.mjs';

/** Render.dll's ClearZ + viewing-actor RenderOverlays -> DeusExPlayer.RenderOverlays
 * (Weapon.RenderOverlays, then a non-Weapon inHand's Inventory.RenderOverlays)
 * -> CalcDrawOffset -> Canvas.DrawActor. The script owns placement and
 * animation; this adapter owns only the Canvas draw submission and decoded GPU
 * resources. No fire/state scheduler entry is made here. Evidence:
 * docs/script-weapon-rendering.md. */
/** `playerSource` is the player actor or a getter for it: Player start logs
 * a new player in, so the viewer passes a getter. */
export async function createWeaponViewModel(runtime,assets,playerSource,{kernel=null}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource;
  const engine=await assets.get('Engine');
  const canvasClass=await runtime.loadClass(engine,engine.exportsByPath.get('canvas'));
  // A typed external Canvas boundary, not a fabricated native UCanvas instance.
  const canvas={kind:'Canvas',key:'viewer.weapon.canvas',name:'WeaponCanvas'};
  runtime.attach(canvas,canvasClass);
  const read=(actor,name)=>runtime.readNamed(actor,name);
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
        if(disposed||runtime.isReleased(actor)||read(actor,'Mesh')!==mesh||read(actor,'bDeleteMe')){preview.dispose();return;}
        entries.set(actor,{mesh,preview});scene.add(preview.root);
      }).catch(cause=>{error=cause;}).finally(()=>pending.delete(actor));
    pending.set(actor,task);return null;
  };
  // Render.dll URender::DrawWorld 0x10b1ce49-0x10b1cec8, after the world:
  // Target is None for bBehindView (+0x318 bit 0), else ViewTarget (+0x60c) or
  // the viewport Actor. Outside the editor and with SHOW_Actors (ShowFlags
  // +0x5fc & 8) it sets GUglyHackFlags|=1, calls RenDev->ClearZ(Frame)
  // (URenderDevice vtable +0x90), then ProcessEvent(RenderOverlays, Canvas).
  // DeusExPlayer.RenderOverlays reaches Weapon.RenderOverlays through Super and
  // then a non-Weapon inHand's Inventory.RenderOverlays.
  const overlayTarget=()=>{
    const player=currentPlayer();
    if(read(player,'bBehindView'))return null;
    const target=read(player,'ViewTarget')??player;
    return read(player,'ShowFlags')&8?target:null;
  };
  const commands=target=>{
    const calls=[],previous=runtime.native,wasBoundary=runtime.boundaryNatives.has(467);
    runtime.boundaryNatives.add(467);
    runtime.native=call=>{
      if(call.index!==467)return previous(call);
      if(call.receiver!==canvas)throw new Error('Player overlay received an unrelated Canvas.DrawActor');
      const args=Array.from({length:call.argumentCount},(_,i)=>refValue(call.evaluateArgument(i)));
      if(!args[0])throw new Error('Player overlay Canvas.DrawActor received None');
      calls.push({actor:args[0],wireframe:Boolean(args[1]),clearZ:Boolean(args[2])});
    };
    try {
      runtime.processEvent(target,'RenderOverlays',[canvas]);
    } finally {
      runtime.native=previous;if(!wasBoundary)runtime.boundaryNatives.delete(467);
    }
    return calls;
  };
  return {scene,summary,
    // The asynchronous phase only decodes resources. It does not dispatch the
    // script event or advance an actor; render() is the sole draw event source.
    async ready(){
      for(const name of ['Weapon','inHand']){const actor=read(currentPlayer(),name);if(actor)prepare(actor);}
      await Promise.all(pending.values());if(error)throw error;
    },
    render(renderer,camera){
      if(disposed)return;
      if(error)throw error;
      for(const {preview} of entries.values())preview.root.visible=false;
      // A reload's collection releases the old generation's weapons.
      for(const [actor,entry] of entries)if(runtime.isReleased(actor)||read(actor,'bDeleteMe')||!runtime.levelFor(currentPlayer()).actors.includes(actor)){
        scene.remove(entry.preview.root);entry.preview.dispose();entries.delete(actor);
      }
      summary.draws=0;summary.actor=null;summary.mesh=null;
      const target=overlayTarget();
      if(target){
        renderer.clearDepth();
        for(const command of commands(target)){
          summary.actor??=command.actor.name;summary.mesh??=read(command.actor,'Mesh')?.key??null;
          const entry=prepare(command.actor);if(!entry)continue;
          for(const {preview} of entries.values())preview.root.visible=false;
          entry.preview.update(fromView(camera.position.toArray()));
          for(const mesh of entry.preview.root.children)mesh.material.wireframe=command.wireframe;
          // Canvas.DrawActor's optional ClearZ (default false, 0x10377f3c).
          if(command.clearZ)renderer.clearDepth();
          renderer.render(scene,camera);summary.draws++;
        }
      }
      summary.loading=pending.size>0;
    },
    dispose(){disposed=true;for(const {preview} of entries.values())preview.dispose();entries.clear();},
  };
}
