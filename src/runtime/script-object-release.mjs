import {ScriptObjectRegistry} from './script-object-construction.mjs';

/** Core UObject::~UObject10150040. The two native process gates are explicit
 * inputs because their semantic names have not been established. Registry
 * slots are recycled without shortening the object array. See
 * docs/script-object-release.md for the class destructor and allocator boundary.
 */
export function destructScriptObject(object,services) {
  const {gates,registry,isValid,conditionalDestroy,freeStateFrame,warning}=services;
  if(!gates||!Object.hasOwn(gates,0x102a2644)||!Object.hasOwn(gates,0x101e5550))
    throw new Error('Final UObject destruction requires the original Core global gates');
  const index=object.index;
  object.nativeVtable=0x10179dfc;
  if(index===-1||!gates[0x102a2644]||gates[0x101e5550])return;
  if(!(registry instanceof ScriptObjectRegistry)||typeof isValid!=='function'
    ||typeof conditionalDestroy!=='function'||typeof freeStateFrame!=='function')
    throw new Error('Final UObject destruction requires registry and native lifecycle services');
  if(!isValid(object))warning?.({type:'InvalidDestructedObject',object:object.identity});
  conditionalDestroy(object);
  registry.unhash(object,object.linkerIndex,warning);
  registry.objects[index]=null;
  registry.freeIndices.push(index);
  // The original's GObjAvailable append, for an object the seeded model allocated.
  registry.original?.giveBack(object);
  // Native code frees the frame without clearing +0x0c or changing +0x04.
  if(object.stateFrame!==null)freeStateFrame(object.stateFrame);
}

/** Core ??3UObject1010aae0 ignores its size argument and frees the allocation.
 * The host owns allocation bookkeeping; this operation does not run Destroy.
 */
export function freeScriptObject(object,{freeObject}) {
  if(typeof freeObject!=='function')throw new Error('Final object release requires the native allocator boundary');
  freeObject(object);
}

/** CameraPoint's Empty(2,0)/zeroed Realloc(2), Remove(0,0,2), then
 * FArray::~FArray path. The first two spellings have identical native writes.
 * This owns raw FString storage; mapping offsets to reflected names is a
 * separate native layout binding. Realloc still runs for a null data pointer. */
export function destroyCameraPointString(member,{reallocate,freeAllocation}) {
  if(!member||!Object.hasOwn(member,'data')||!Number.isInteger(member.count)||!Number.isInteger(member.capacity))
    throw new Error('CameraPoint FString destructor requires explicit data/count/capacity storage');
  if(typeof reallocate!=='function'||typeof freeAllocation!=='function')
    throw new Error('CameraPoint FString destructor requires native allocator services');
  member.count=0;member.capacity=0;
  member.data=reallocate(member.data,0,0x101ab50c);
  if(member.data===undefined)throw new Error('Native realloc must return an allocation or null');
  // FArray::Remove101454f0 returns immediately for the now-zero count.
  if(member.count!==0)throw new Error('Native realloc unexpectedly changed FString count');
  if(member.data!==null)freeAllocation(member.data);
  member.data=null;member.capacity=0;member.count=0;
}

/** CameraPoint deleting destructor10310780, scalar branch. The inherited
 * native FString members are finalized in decreasing-offset order before
 * Core unregisters the UObject. A caller must bind their concrete storage. */
export function releaseScriptCameraPoint(object,flags,services) {
  if(object.nativeVtable!==0x10427178)
    throw new Error('Final release is only linked for the verified CameraPoint native class');
  if(!Number.isInteger(flags)||flags&2)
    throw new Error('CameraPoint array deleting destructor is not implemented');
  if(typeof services.conditionalDestroy!=='function'||typeof services.destroyActorString!=='function')
    throw new Error('CameraPoint final release requires native lifecycle and FString member bindings');
  for(const table of [0x10427178,0x10427020,0x104268dc]){
    object.nativeVtable=table;services.conditionalDestroy(object);
  }
  for(const offset of [0x2d0,0x2c4,0x2b8,0x2ac])services.destroyActorString(object,offset);
  destructScriptObject(object,services);
  if(flags&1)freeScriptObject(object,services);
  return object;
}
