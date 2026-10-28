import {refValue} from '../runtime/script-vm.mjs';
import {inRenderPass} from '../runtime/render-precision.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {createMeshBinding,createMeshBindingNow} from './actor-mesh-sim.mjs';
import {lodFrame} from './actor-mesh-lod.mjs';

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
 * `onRelease(id)` hand the page each binding's creation and retirement.
 * `lod` (false: `?meshLod=off`) gives the bindings DrawLodMesh's distance
 * LOD: Canvas.DrawActor draws in the world's master frame (UCanvas+0x7c, the
 * Frame UGameEngine::Draw gave Canvas->Update), so the weapon's selection
 * takes that frame's Coords and FX, the viewport actor's FovAngle and the
 * weapon's own Location, DrawScale and LODBias (docs/script-lodmesh-lod.md
 * "The first-person weapon"). */
export async function createWeaponOverlaySim(runtime,assets,playerSource,{kernel=null,lighting=null,layout=null,lod=true,
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
    const options={id:nextId++,originalObjectIndex:index++,kernel,drawActor:true,lighting,layout,textures,lod};
    // Canvas.DrawActor draws (and DrawActorSprite stamps, 0x10b25150) the item the player put in hand in the first render after that tick: the
    // binding is made in this frame when its mesh and skins are resident (createMeshBindingNow, as the actor mesh layer admits a spawned actor),
    // else they load first and the item is drawn from a later frame (the original's held Multitool0 is stamped from the render after its
    // ActivateBelt, Stage 5 capture hck1).
    let now=null;
    try{now=createMeshBindingNow(runtime,actor,options);}catch(cause){error=cause;return null;}
    if(now){const made={mesh,binding:now};entries.set(actor,made);onCreate(now.creation);return made;}
    const task=createMeshBinding(runtime,actor,options)
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
  // GC.DrawActor (docs/gc-draw-actor.md): the HUD paint draws actors through the same URender::DrawActor, in the master frame
  // (Extension XGC::DrawActor sets the actor's state, then calls Canvas->Render->DrawActor(Frame, Actor)). Each actor drawn
  // that way (the vision augmentation's heat sources, ActorDisplayWindow's tracked actors) has a binding of its own on the CPU
  // path, the reference: the view model's GPU instance has a few slots and the pawns of a map outnumber them. The
  // binding's face groups are resolved when it is made, so a different skin set (SetSkins' grid textures) makes a new one.
  const hudEntries=new Map(),hudPending=new Map();
  let hudIndex=0x58000000,hudClock=0;
  const skinKey=actor=>[read(actor,'Skin'),...read(actor,'MultiSkins')].map(ref=>ref?.key??ref?.name??'').join('|');
  const retireHud=(actor,entry)=>{entry.binding.dispose();hudEntries.delete(actor);onRelease(entry.binding.id);};
  const DT_MESH=2;
  const prepareHud=actor=>{
    // URender::DrawActor -> FDynamicSprite::Setup also draws sprites, brushes and the other DrawTypes: only meshes are built here.
    if(read(actor,'DrawType')!==DT_MESH)throw new Error(`GC.DrawActor of ${actor.name}: DrawType ${read(actor,'DrawType')} (not DT_Mesh) is unsupported`);
    const mesh=read(actor,'Mesh'),skins=skinKey(actor),entry=hudEntries.get(actor);
    if(entry?.mesh===mesh&&entry.skins===skins)return entry;
    if(entry)retireHud(actor,entry);
    if(hudPending.has(actor))return null;
    const options={id:nextId++,originalObjectIndex:hudIndex++,kernel,drawActor:true,lighting,layout:null,textures,lod};
    let now=null;
    try{now=createMeshBindingNow(runtime,actor,options);}catch(cause){error=cause;return null;}
    if(now){const made={mesh,skins,binding:now,used:hudClock};hudEntries.set(actor,made);onCreate(now.creation);return made;}
    const task=createMeshBinding(runtime,actor,options)
      .then(binding=>{
        if(disposed||runtime.isReleased(actor)||read(actor,'Mesh')!==mesh||read(actor,'bDeleteMe')){binding.dispose();return;}
        hudEntries.set(actor,{mesh,skins,binding,used:hudClock});onCreate(binding.creation);
      }).catch(cause=>{error=cause;}).finally(()=>hudPending.delete(actor));
    hudPending.set(actor,task);return null;
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
      // DrawWorld's RenderOverlays event runs inside the render pass, at
      // x87 precision control 24 (render-precision.mjs).
      inRenderPass(runtime,()=>runtime.processEvent(target,'RenderOverlays',[canvas]));
    } finally {
      runtime.native=previous;if(!wasBoundary)runtime.boundaryNatives.delete(467);
    }
    return calls;
  };
  return {summary,
    /** The bindings in use (validation access: lod-probe.mjs). */
    all:()=>[...entries.values()].map(entry=>entry.binding),
    /** The HUD actor bindings in use (validation access). */
    hudAll:()=>[...hudEntries.values()].map(entry=>entry.binding),
    /** A context loss took the GPU path's cache poses (docs/context-loss.md): the view model's bindings leave it, as the
     * actors' do (actor-mesh-sim.mjs leaveGpu). */
    leaveGpu:reason=>[...entries.values()].map(entry=>entry.binding.leaveGpu(reason)).filter(Boolean),
    /** One GC.DrawActor draw (docs/gc-draw-actor.md), called with the actor in the state XGC::DrawActor set and the main
     * camera's `frustum`, `lodInputs`, `settings` and `admit` as frame() takes them: the actor's binding updated in the
     * master frame (lit as its own light sink, as Canvas.DrawActor's) with the record the page draws, whether
     * FDynamicSprite::Setup admits it (render feedback, `admit`; absent: the groups three.js draws) and the pass decision.
     * Null while the binding is being prepared. An actor Setup rejects is not drawn. */
    drawHudActor(actor,{frustum,lodInputs=null,settings,admit=null}){
      if(disposed)return null;
      if(error)throw error;
      const entry=prepareHud(actor);
      if(!entry)return null;
      entry.used=hudClock;
      const {binding}=entry,frameLod=lod&&lodInputs?lodFrame(lodInputs,settings):null;
      const record=binding.update({lit:true,...(frameLod?{lodFrame:frameLod}:{})});
      const decision=binding.passVisibility(frustum);
      const drawn=admit?admit(binding):binding.drawnIn(frustum,decision);
      return drawn?{id:binding.id,record,decision,drawn:true}:{id:binding.id,record:null,decision:null,drawn:false};
    },
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
     * still being prepared is skipped. `admit(binding)`: whether the canvas
     * frame's FDynamicSprite::Setup accepts the submission (render feedback;
     * absent: the drawn groups decide). `lodInputs` {coords, fx, fov} is the
     * master frame's DrawLodMesh inputs (sim-session.mjs), with URender's
     * `settings`; without them the weapon draws at full detail. */
    frame({frustum,pack=null,lodInputs=null,settings,admit=null}){
      if(disposed)return null;
      if(error)throw error;
      // A reload's collection releases the old generation's weapons.
      for(const [actor,entry] of entries)if(runtime.isReleased(actor)||read(actor,'bDeleteMe')||!runtime.levelFor(currentPlayer()).actors.includes(actor))
        retire(actor,entry);
      // The HUD's actor draws likewise, and an actor not drawn for 300 frames gives its binding back.
      hudClock++;
      for(const [actor,entry] of hudEntries)if(runtime.isReleased(actor)||read(actor,'bDeleteMe')||hudClock-entry.used>300
        ||!runtime.levelFor(currentPlayer()).actors.includes(actor))retireHud(actor,entry);
      summary.draws=0;summary.actor=null;summary.mesh=null;
      const target=overlayTarget(),draws=[],drawn=[];
      const frameLod=lod&&lodInputs?lodFrame(lodInputs,settings):null;
      if(target){
        for(const command of commands(target)){
          summary.actor??=command.actor.name;summary.mesh??=read(command.actor,'Mesh')?.key??null;
          const entry=prepare(command.actor);if(!entry)continue;
          const {binding}=entry;
          // Canvas.DrawActor -> URender::DrawActor lights the weapon as its
          // own light sink in the main frame (docs/mesh-lighting.md).
          const record=binding.update({lit:true,...(pack?{pack}:{}),...(frameLod?{lodFrame:frameLod}:{})});
          // three.js's frustum test on the drawn groups (the CPU path's
          // posed bounds; the GPU path's group decisions).
          const decision=binding.passVisibility(frustum);
          draws.push({id:binding.id,wireframe:command.wireframe,clearZ:command.clearZ,record,decision});
          // Render feedback: Canvas.DrawActor -> URender::DrawActor (0x10b262c0) stamps through DrawActorSprite whatever
          // FDynamicSprite::Setup (0x10b23910) accepts in the canvas frame (the master frame): `admit` runs that Setup (the
          // caller's occlusion kernel, setup.rs), a whole-mesh bound, where the drawn groups' frustum test is tighter (a held
          // item rising into view from below the screen: the original's Multitool0 is stamped from its first frame, Stage 5
          // capture hck1). Without it, the groups three.js draws.
          if(admit?admit(binding):binding.drawnIn(frustum,decision))drawn.push(command.actor);
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
    dispose(){disposed=true;for(const entry of entries.values())entry.binding.dispose();entries.clear();
      for(const entry of hudEntries.values())entry.binding.dispose();hudEntries.clear();},
  };
}
