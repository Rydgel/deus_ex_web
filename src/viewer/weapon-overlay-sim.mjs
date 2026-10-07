import {refValue} from '../runtime/script-vm.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {createMeshBinding} from './actor-mesh-sim.mjs';

/** The simulation side of the player's view model (docs/sim-worker.md step
 * 6; evidence: docs/script-weapon-rendering.md). Render.dll's ClearZ +
 * viewing-actor RenderOverlays -> DeusExPlayer.RenderOverlays
 * (Weapon.RenderOverlays, then a non-Weapon inHand's
 * Inventory.RenderOverlays) -> CalcDrawOffset -> Canvas.DrawActor. The
 * script owns placement and animation; this side collects the Canvas draw
 * submissions and runs each drawn actor's mesh binding (actor-mesh-sim.mjs:
 * GetFrame planning or the CPU GetFrame, SetupForActor and lighting); the
 * page (weapon-overlay-draw.mjs) draws the records. No fire/state scheduler
 * entry is made here.
 *
 * `playerSource` is the player actor or a getter for it: Player start logs a
 * new player in. `layout` is this side's copy of the page's weapon GPU mesh
 * layout (gpu-mesh-layout.mjs; null: the CPU path). `onCreate(creation)` and
 * `onRelease(id)` hand the page each binding's creation and retirement. */
export async function createWeaponOverlaySim(runtime,assets,playerSource,{kernel=null,lighting=null,layout=null,
  onCreate=()=>{},onRelease=()=>{}}={}) {
  const currentPlayer=typeof playerSource==='function'?playerSource:()=>playerSource;
  const engine=await assets.get('Engine');
  const canvasClass=await runtime.loadClass(engine,engine.exportsByPath.get('canvas'));
  // A typed external Canvas boundary, not a fabricated native UCanvas instance.
  const canvas={kind:'Canvas',key:'viewer.weapon.canvas',name:'WeaponCanvas'};
  runtime.attach(canvas,canvasClass);
  const read=(actor,name)=>runtime.readNamed(actor,name);
  const textures=new TextureStore(assets),entries=new Map(),pending=new Map();
  const summary={actor:null,mesh:null,loading:false,draws:0,shading:lighting?'original mesh lighting':'texture-only inspection'};
  let disposed=false,error=null,index=0x50000000,nextId=1;
  const retire=(actor,entry)=>{entry.binding.dispose();entries.delete(actor);onRelease(entry.binding.id);};
  const prepare=actor=>{
    const mesh=read(actor,'Mesh');
    const entry=entries.get(actor);
    if(entry?.mesh===mesh)return entry;
    if(entry)retire(actor,entry);
    if(pending.has(actor))return null;
    const task=createMeshBinding(runtime,actor,{id:nextId++,originalObjectIndex:index++,kernel,drawActor:true,lighting,layout,textures})
      .then(binding=>{
        if(disposed||runtime.isReleased(actor)||read(actor,'Mesh')!==mesh||read(actor,'bDeleteMe')){binding.dispose();return;}
        entries.set(actor,{mesh,binding});onCreate(binding.creation);
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
  return {summary,
    // The asynchronous phase only prepares bindings. It does not dispatch
    // the script event or advance an actor; frame() is the sole draw event
    // source.
    async ready(){
      for(const name of ['Weapon','inHand']){const actor=read(currentPlayer(),name);if(actor)prepare(actor);}
      await Promise.all(pending.values());if(error)throw error;
    },
    /** One frame's overlay pass after the world, with the main camera's
     * `frustum` and the frame's `pack` (mesh-frame-pack.mjs): whether
     * Render.dll's gates select a target (the page then clears Z), each
     * DrawActor submission with its binding's frame record and main-frustum
     * decision, the lighting frame's coordinates for the GPU passes, and the
     * actors the frame draws (render feedback). A submission whose binding is
     * still being prepared is skipped. */
    frame({frustum,pack=null,lodFrame=null}){
      if(disposed)return null;
      if(error)throw error;
      // A reload's collection releases the old generation's weapons.
      for(const [actor,entry] of entries)if(runtime.isReleased(actor)||read(actor,'bDeleteMe')||!runtime.levelFor(currentPlayer()).actors.includes(actor))
        retire(actor,entry);
      summary.draws=0;summary.actor=null;summary.mesh=null;
      const target=overlayTarget(),draws=[],drawn=[];
      if(target){
        for(const command of commands(target)){
          summary.actor??=command.actor.name;summary.mesh??=read(command.actor,'Mesh')?.key??null;
          const entry=prepare(command.actor);if(!entry)continue;
          const {binding}=entry;
          // Canvas.DrawActor -> URender::DrawActor lights the weapon as its
          // own light sink in the main frame (docs/mesh-lighting.md); its
          // DrawActorSprite passes Frame->Coords to DrawMesh (0x10b25615), so
          // DrawLodMesh selects it from the main frame's LOD inputs
          // (`lodFrame`, actor-mesh-lod.mjs; docs/script-lodmesh-lod.md).
          const record=binding.update({lit:true,...(pack?{pack}:{}),...(lodFrame?{lodFrame}:{})});
          // three.js's frustum test on the drawn groups (the CPU path's
          // posed bounds; the GPU path's group decisions).
          const decision=binding.passVisibility(frustum);
          draws.push({id:binding.id,wireframe:command.wireframe,clearZ:command.clearZ,record,decision});
          if(binding.drawnIn(frustum,decision))drawn.push(command.actor);
          summary.draws++;
        }
      }
      summary.loading=pending.size>0;
      const lit=lighting?.frame;
      const camera=lit?{origin:[...lit.origin],axes:lit.axes.map(axis=>[...axis])}:null;
      // The page runs the weapon's GPU passes once per frame record.
      layout?.endFrame();
      return {target:Boolean(target),draws,camera,drawn};
    },
    /** The view model's bindings (validation: lod-probe.mjs). */
    all:()=>[...entries.values()].map(entry=>entry.binding),
    dispose(){disposed=true;for(const entry of entries.values())entry.binding.dispose();entries.clear();},
  };
}
