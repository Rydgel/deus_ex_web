/** Original native Decal construction, admission gates and the surface
 * attachment (docs/script-decal-startup.md, docs/decals.md). */
import {refValue} from './script-vm.mjs';
import {scriptVmKernel} from './script-vm-kernel.mjs';
import {uploadDecalModel,createDecalStore} from './decal-kernel.mjs';
import {handleOf,identityOfHandle} from './script-object-handles.mjs';
import {readTexture} from '../unreal/textures.mjs';

export class DecalBoundaryError extends Error {
  constructor(operation,message){
    super(message);this.name='DecalBoundaryError';this.code='DECAL_BOUNDARY';this.operation=operation;
  }
}

/** The level's FBspSurf.Decals: the Rust core's store over its model
 * (decal-kernel.mjs, native/script-vm/src/decal.rs, docs/decals.md),
 * created on the first AttachDecal. LoadMap loads the model fresh, so a
 * Player-start reload starts empty (script-doors drops it); a dropped level
 * frees its kernel blocks.
 *
 * With the moving brush tracker the level model holds the movers'
 * fragments where they were last rendered, and their surfaces' Actor is
 * the Mover. The host then sets `level.decalSource` (sim-host.mjs):
 * `model()` the tracked model (brush-tracker.mjs trackedModel),
 * `pointCapacity`, `generation()` (bumped by every Update that rebuilt a
 * mover) and `movers()`, each tracked mover's actor and surfaces. The
 * model is uploaded from it once (a store made before the tracker existed,
 * as the original's GNewBrushTracker runs after the actor start-up, grows
 * into the tracker's surfaces) and follows the tracker's arrays after. */
const releaseDecals = new FinalizationRegistry(dispose => dispose());
// The registry's held value: it must not reach the level, the tracker source
// or the runtime, or the level it waits for (and with it the runtime) is never
// collected. It holds only the kernel store and the current model.
function decalDisposer(parts) {
  let live = true;
  return () => { if (live) { live = false; parts.store.dispose(); parts.model.dispose(); } };
}
export function levelDecals(level) {
  const source = level.decalSource ?? null;
  if (level.decals && level.decals.source === source) return level.decals;
  const kernel = scriptVmKernel?.decals;
  if (!kernel) throw new DecalBoundaryError('AttachDecal.kernel', 'AttachDecal runs in the Rust core (npm run build:wasm)');
  if (!level.model?.nodes?.length || !level.model?.surfaces?.length)
    throw new DecalBoundaryError('AttachDecal.model','AttachDecal requires the original compiled BSP model');
  let model;
  if (source) {
    const tracked = source.model();
    model = uploadDecalModel(kernel, tracked, { pointCapacity: source.pointCapacity,
      isMover: s => (tracked.surfaces[s]?.dynamic ? true : null) });
  } else model = uploadDecalModel(kernel, level.model);
  if (level.decals) {
    const decals = level.decals, old = decals.model;
    decals.store.setModel(model);
    old.dispose();
    decals.model = decals.parts.model = model; decals.source = source; decals.generation = source?.generation() ?? 0;
    return decals;
  }
  const store = createDecalStore(kernel, model);
  const parts = { store, model };
  const decals = { model, store, source, generation: source?.generation() ?? 0, parts, dispose: decalDisposer(parts) };
  level.decals = decals;
  releaseDecals.register(level, decals.dispose, level.decals);
  return level.decals;
}

/** Bring a level's decal model to the tracker's present state: its arrays
 * after the last Update (decal.rs `decal_model_sync`, when the generation
 * moved) and every Mover surface's Actor Rotation, which AttachDecal's
 * Mover branch (MoverRotation) and ClipDecal (Rotation - MoverRotation)
 * read at their call. */
export function followDecalTracker(decals) {
  const source = decals?.source;
  if (!source) return;
  const generation = source.generation();
  if (generation !== decals.generation) {
    if (!decals.model.sync())
      throw new DecalBoundaryError('AttachDecal.tracker', 'the tracked level model no longer fits the decal model');
    decals.generation = generation;
  }
  const movers = source.movers();
  for (let i = 0; i < movers.length; i++) {
    const surfaces = movers[i].surfaces, r = movers[i].rotation();
    for (let k = 0; k < surfaces.length; k++) decals.model.setRotation(surfaces[k], r);
  }
}
/** Drop a level's decals (a reload: the original's UModel is loaded anew). */
export function resetLevelDecals(level) {
  if (!level.decals) return;
  releaseDecals.unregister(level.decals);
  level.decals.dispose();
  level.decals = null;
}

// Texture ids for the kernel: the original compares UTexture pointers, a
// resource reference's key names the same object.
const textureIds = new Map(), textureSizes = new Map();
const textureId = reference => {
  if (!reference) return 0;
  const key = reference.key ?? `${reference.asset?.name}:${reference.index}`;
  let id = textureIds.get(key);
  if (id === undefined) textureIds.set(key, id = textureIds.size + 1);
  return id;
};
/** Texture.USize (UBitmap +0x34), the int the quad radius reads. */
function textureUSize(reference) {
  const key = reference.key ?? `${reference.asset?.name}:${reference.index}`;
  if (!textureSizes.has(key)) {
    const size = reference.asset ? readTexture(reference.asset, reference.index).values.USize : undefined;
    if (!Number.isInteger(size)) throw new DecalBoundaryError('AttachDecal.texture', `Decal texture ${key} has no USize`);
    textureSizes.set(key, size);
  }
  return textureSizes.get(key);
}

/** ADecal::execAttachDecal's surface path after the gates (Engine.dll
 * 0x103e734b-0x103e898e), in the Rust core: the trace, the surface, the
 * FDecal quad, its Nodes and the MultiDecalLevel grid. SurfList gains the
 * attached surfaces; the result follows the original. `rand()` is the shared
 * stream's msvcrt rand() (appFrand's call).
 *
 * On a Mover's surface (the moving brush tracker's) the original calls
 * this->SetBase(Owner, 1) inside the native, after the FDecal entry and
 * before the quad (0x103e79d6..0x103e79fe); the port runs `setBase(actor, Owner)` when
 * the kernel returns. Its events (Detach/Attach on the bases, BaseChange)
 * then run after the FDecal lists are finished, which no script reads. */
export function attachDecalSurfaces(actor,distance,direction,{level,read,write,rand,setBase}){
  if(!level)throw new DecalBoundaryError('AttachDecal.level','AttachDecal requires the live level');
  if(typeof rand!=='function')throw new DecalBoundaryError('AttachDecal.rng','AttachDecal requires the original RNG stream');
  const decals=levelDecals(level),{store}=decals,texture=read(actor,'Texture'),surfList=read(actor,'SurfList');
  followDecalTracker(decals);
  const out=store.attach({actor:handleOf(actor),location:read(actor,'Location').map(Math.fround),rotation:read(actor,'Rotation'),
    traceDistance:Math.fround(distance),decalDir:direction.map(Math.fround),drawScale:Math.fround(read(actor,'DrawScale')),
    uSize:textureUSize(texture),level:read(actor,'MultiDecalLevel')|0,texture:textureId(texture),surfList},{
    rand,textureOf:id=>{const other=identityOfHandle(id);return other?textureId(read(other,'Texture')):0;},
  });
  if(out.appended.length)write(actor,'SurfList',[...surfList,...out.appended]);
  if(out.setBase){
    if(typeof setBase!=='function')throw new DecalBoundaryError('AttachDecal.setBase','The Mover branch requires AActor::SetBase');
    setBase(actor,read(actor,'Owner'));
  }
  return out.result!==0;
}

/** ADecal::execDetachDecal (0x103e9a30): from SurfList's last entry, the
 * first FDecal on that surface whose Actor is this one is removed, and the
 * entry popped. */
export function detachDecalSurfaces(actor,{level,read,write}){
  const surfList=read(actor,'SurfList');
  if(level?.decals)level.decals.store.detach({actor:handleOf(actor),surfList});
  write(actor,'SurfList',[]);
}

export function execAttachDecal(call,{read,write,clientFor,warning,attachSurfaces}){
  if(call.argumentCount<1||call.argumentCount>2)throw new Error('AttachDecal requires distance and optional direction');
  const distance=Math.fround(refValue(call.evaluateArgument(0)));
  const supplied=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
  const direction=supplied===undefined?[0,0,0]:supplied.map(Math.fround);
  if(direction.length!==3)throw new Error('AttachDecal requires a three-component direction');
  const client=clientFor(call.receiver);
  if(client===null)return false;
  if(!client||!Number.isInteger(client.decals)&&typeof client.decals!=='boolean')
    throw new DecalBoundaryError('Client.Decals','AttachDecal requires the original Client.Decals setting');
  if(!client.decals)return false;
  if(read(call.receiver,'Texture')===null){
    warning?.({type:'DecalMissingTexture',actor:call.receiver});return false;
  }
  const depth=read(call.receiver,'MultiDecalLevel')|0;
  write(call.receiver,'MultiDecalLevel',Math.min(depth,4));
  if(typeof attachSurfaces!=='function')
    throw new DecalBoundaryError('AttachDecal.surfaces','Original decal BSP surface attachment is not implemented');
  return attachSurfaces(call.receiver,distance,direction);
}

export function execDetachDecal(call,{read,detachSurfaces}){
  if(call.argumentCount!==0)throw new Error('DetachDecal accepts no arguments');
  if(read(call.receiver,'SurfList').length===0)return;
  if(typeof detachSurfaces!=='function')
    throw new DecalBoundaryError('DetachDecal.surfaces','Original decal BSP surface detachment is not implemented');
  return detachSurfaces(call.receiver);
}

/** Admit the actually researched Shadow lifecycle; other Decal subclasses
 * still require their own original event/dependency preparation. This does
 * not spawn anything or run NPC lifecycle on the already populated world. */
export async function prepareShadowStartup(runtime,assets,level){
  const dx=await assets.get('DeusEx'),engine=await assets.get('Engine');
  const cls=await runtime.loadClass(dx,dx.exportsByPath.get('shadow'));
  const chain=[];for(let current=cls;current;current=current.base)chain.push(current.record.key);
  if(chain.join('/')!=='deusex.shadow/engine.decal/engine.actor/core.object'||cls.metadata.classFlags!==0x32)
    throw new Error('Shadow native constructor inheritance differs from the original contract');
  for(const field of cls.propertyLink)await runtime.field(field);
  const surfaceField=runtime.lookupMember(cls,'fields','SurfList');
  if(surfaceField.key!=='engine.decal.surflist'||surfaceField.metadata.innerMetadata?.type!=='int')
    throw new Error('Decal.SurfList does not have the recovered integer-array layout');
  for(const name of ['Spawned','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState',
    'PostPostBeginPlay','EndState','Destroyed','GainedChild','LostChild']){
    const record=runtime.lookupMember(cls,'methods',name);
    if(record)await runtime.prepareFunction(record.asset,record.index);
  }
  for(const path of ['decal.attachdecal','decal.detachdecal','actor.destroyed'])
    await runtime.prepareFunction(engine,engine.exportsByPath.get(path));
  const lifecycle=runtime.actorLifecycle,construction=lifecycle?.construction;
  if(!construction)throw new Error('Decal startup requires the original world construction services');
  const isDecal=objectClass=>{for(let node=objectClass;node;node=node.base)if(node.record.key==='engine.decal')return true;return false;};
  lifecycle.construction={...construction,
    initNativeProperties:(object,template)=>{
      construction.initNativeProperties(object,template);
      // ADecal's constructor clears its native SurfList header (the one
      // member write in the Actor constructor family); every Decal-ancestry
      // product binds the reflected SurfList to that native list.
      if(!isDecal(object.objectClass))return;
      // ADecal inherits AActor's native Destroy slot (+0x24 = 10301f8c).
      // This is ConditionalDestroy, not the distinct C++ final destructor.
      object.destroy=receiver=>runtime.destroyActorBase(receiver);
      object.decalSurfaces=runtime.readNamed(object.identity,'SurfList');
      runtime.bindProperty(object.identity,surfaceField,{
        get:()=>object.decalSurfaces,set:value=>{object.decalSurfaces=value;},
      });
    },
  };
  return cls;
}
