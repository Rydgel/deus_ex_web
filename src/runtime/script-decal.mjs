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
 * frees its kernel blocks. Every level-BSP surface Actor of the shipped maps
 * is a Brush (docs/decals.md), so no surface takes the Mover branch. */
const releaseDecals = new FinalizationRegistry(dispose => dispose());
export function levelDecals(level) {
  if (level.decals) return level.decals;
  const kernel = scriptVmKernel?.decals;
  if (!kernel) throw new DecalBoundaryError('AttachDecal.kernel', 'AttachDecal runs in the Rust core (npm run build:wasm)');
  if (!level.model?.nodes?.length || !level.model?.surfaces?.length)
    throw new DecalBoundaryError('AttachDecal.model','AttachDecal requires the original compiled BSP model');
  const model = uploadDecalModel(kernel, level.model);
  const store = createDecalStore(kernel, model);
  let live = true;
  const dispose = () => { if (live) { live = false; store.dispose(); model.dispose(); } };
  level.decals = { model, store, dispose };
  releaseDecals.register(level, dispose, level.decals);
  return level.decals;
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
 * stream's msvcrt rand() (appFrand's call). */
export function attachDecalSurfaces(actor,distance,direction,{level,read,write,rand}){
  if(!level)throw new DecalBoundaryError('AttachDecal.level','AttachDecal requires the live level');
  if(typeof rand!=='function')throw new DecalBoundaryError('AttachDecal.rng','AttachDecal requires the original RNG stream');
  const {store}=levelDecals(level),texture=read(actor,'Texture'),surfList=read(actor,'SurfList');
  const out=store.attach({actor:handleOf(actor),location:read(actor,'Location').map(Math.fround),rotation:read(actor,'Rotation'),
    traceDistance:Math.fround(distance),decalDir:direction.map(Math.fround),drawScale:Math.fround(read(actor,'DrawScale')),
    uSize:textureUSize(texture),level:read(actor,'MultiDecalLevel')|0,texture:textureId(texture),surfList},{
    rand,textureOf:id=>{const other=identityOfHandle(id);return other?textureId(read(other,'Texture')):0;},
  });
  if(out.appended.length)write(actor,'SurfList',[...surfList,...out.appended]);
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
